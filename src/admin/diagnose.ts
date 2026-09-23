import type { AccountStore } from '../accounts/store.js'
import type { AccountRecord } from '../accounts/types.js'
import { isTokenExpiringSoon, refreshAccountToken } from '../kiro/auth.js'
import type { ExitsStore } from '../exits/store.js'
import { probeExitIp } from '../exits/probe.js'
import { probeTlsFingerprint, type TlsProbeReport } from './tlsProbe.js'

export interface DiagnoseTokenCheck {
  ok: boolean
  hasAccessToken: boolean
  hasRefreshToken: boolean
  expiresAt?: number
  expiringSoon: boolean
  refreshed?: boolean
  refreshError?: string
  message: string
}

export interface DiagnoseExitCheck {
  ok: boolean
  poolId?: string
  exitId?: string
  proxyUrl?: string
  exitIp?: string
  error?: string
  message: string
}

export interface DiagnoseReport {
  accountId: string
  label: string
  startedAt: number
  finishedAt: number
  ok: boolean
  token: DiagnoseTokenCheck
  exit: DiagnoseExitCheck
  tls?: TlsProbeReport
  tlsError?: string
  text: string
}

export interface DiagnoseDeps {
  accounts: AccountStore
  exits?: ExitsStore
  /** Attempt a live token refresh when expiring / missing access token. */
  doRefresh?: boolean
  /** Include observe-only TLS sticky vs direct probe. */
  doTls?: boolean
  compareDirect?: boolean
  refreshBeforeSec?: number
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toISOString()
}

export async function diagnoseAccount(
  accountId: string,
  deps: DiagnoseDeps,
): Promise<DiagnoseReport> {
  const startedAt = Date.now()
  const acc = deps.accounts.get(accountId)
  if (!acc) {
    const finishedAt = Date.now()
    const text = `Diagnose failed: account not found (${accountId})`
    return {
      accountId,
      label: accountId,
      startedAt,
      finishedAt,
      ok: false,
      token: {
        ok: false,
        hasAccessToken: false,
        hasRefreshToken: false,
        expiringSoon: false,
        message: 'account not found',
      },
      exit: { ok: false, message: 'skipped' },
      text,
    }
  }

  const token = await checkToken(acc, deps)
  const exit = await checkExit(acc, deps)
  let tls: TlsProbeReport | undefined
  let tlsError: string | undefined
  if (deps.doTls !== false) {
    try {
      let proxyUrl = acc.outboundProxyUrl
      if (!proxyUrl && acc.outboundExitId && deps.exits) {
        proxyUrl = await deps.exits.ensureProxyUrl(acc.outboundExitId)
      }
      tls = await probeTlsFingerprint({
        proxyUrl,
        compareDirect: deps.compareDirect !== false,
      })
    } catch (err) {
      tlsError = err instanceof Error ? err.message : String(err)
    }
  }

  const finishedAt = Date.now()
  const ok = token.ok && exit.ok && !tlsError && (tls?.sticky?.ok !== false || !tls)
  const text = renderReport({
    acc,
    token,
    exit,
    tls,
    tlsError,
    startedAt,
    finishedAt,
    ok,
  })

  return {
    accountId: acc.id,
    label: acc.label || acc.email || acc.id,
    startedAt,
    finishedAt,
    ok,
    token,
    exit,
    tls,
    tlsError,
    text,
  }
}

async function checkToken(acc: AccountRecord, deps: DiagnoseDeps): Promise<DiagnoseTokenCheck> {
  const refreshBefore = deps.refreshBeforeSec ?? 300
  const hasAccessToken = Boolean(acc.accessToken)
  const hasRefreshToken = Boolean(acc.refreshToken)
  const expiringSoon = isTokenExpiringSoon(acc, refreshBefore)

  if (!hasAccessToken && !hasRefreshToken) {
    return {
      ok: false,
      hasAccessToken,
      hasRefreshToken,
      expiresAt: acc.expiresAt,
      expiringSoon,
      message: 'missing accessToken and refreshToken',
    }
  }

  if (deps.doRefresh === false) {
    return {
      ok: hasAccessToken && !expiringSoon,
      hasAccessToken,
      hasRefreshToken,
      expiresAt: acc.expiresAt,
      expiringSoon,
      message: hasAccessToken
        ? expiringSoon
          ? 'access token present but expiring soon (refresh skipped)'
          : 'access token present'
        : 'no access token (refresh skipped)',
    }
  }

  if (!hasRefreshToken) {
    return {
      ok: hasAccessToken,
      hasAccessToken,
      hasRefreshToken,
      expiresAt: acc.expiresAt,
      expiringSoon,
      message: hasAccessToken
        ? 'access token present; no refreshToken to renew'
        : 'no refreshToken',
    }
  }

  if (hasAccessToken && !expiringSoon) {
    return {
      ok: true,
      hasAccessToken,
      hasRefreshToken,
      expiresAt: acc.expiresAt,
      expiringSoon: false,
      message: 'access token valid; refresh not needed',
    }
  }

  const result = await refreshAccountToken(acc)
  if (!result.success || !result.accessToken) {
    return {
      ok: false,
      hasAccessToken,
      hasRefreshToken,
      expiresAt: acc.expiresAt,
      expiringSoon,
      refreshed: false,
      refreshError: result.error || 'refresh failed',
      message: `token refresh failed: ${result.error || 'unknown'}`,
    }
  }

  await deps.accounts.applyTokenRefresh(acc.id, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
  })
  deps.accounts.pool.updateAccount(acc.id, { isAvailable: true })

  return {
    ok: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    expiresAt: result.expiresAt ?? acc.expiresAt,
    expiringSoon: false,
    refreshed: true,
    message: 'token refreshed successfully',
  }
}

async function checkExit(acc: AccountRecord, deps: DiagnoseDeps): Promise<DiagnoseExitCheck> {
  const poolId = acc.outboundPoolId
  const exitId = acc.outboundExitId
  if (!poolId && !exitId && !acc.outboundProxyUrl) {
    return {
      ok: true,
      message: 'no sticky exit bound (direct / global proxy)',
    }
  }
  if (!deps.exits) {
    return {
      ok: false,
      poolId,
      exitId,
      proxyUrl: acc.outboundProxyUrl,
      message: 'exits store not available',
      error: 'exits store not initialized',
    }
  }
  try {
    let proxyUrl = acc.outboundProxyUrl
    if (exitId) proxyUrl = await deps.exits.ensureProxyUrl(exitId)
    if (!proxyUrl) {
      return {
        ok: false,
        poolId,
        exitId,
        message: 'no outboundProxyUrl for sticky exit',
        error: 'missing proxy url',
      }
    }
    const exit = exitId ? deps.exits.getEntry(exitId) : undefined
    const { ip } = await probeExitIp(
      { ...(exit || { id: exitId || 'adhoc' }), outboundProxyUrl: proxyUrl },
      { timeoutMs: 12_000 },
    )
    return {
      ok: true,
      poolId,
      exitId,
      proxyUrl,
      exitIp: ip,
      message: `sticky exit reachable · egress ${ip}`,
    }
  } catch (err) {
    return {
      ok: false,
      poolId,
      exitId,
      proxyUrl: acc.outboundProxyUrl,
      error: err instanceof Error ? err.message : String(err),
      message: 'sticky exit probe failed',
    }
  }
}

function renderReport(input: {
  acc: AccountRecord
  token: DiagnoseTokenCheck
  exit: DiagnoseExitCheck
  tls?: TlsProbeReport
  tlsError?: string
  startedAt: number
  finishedAt: number
  ok: boolean
}): string {
  const { acc, token, exit, tls, tlsError, startedAt, finishedAt, ok } = input
  const lines: string[] = []
  lines.push(`# kiro-acc diagnose · ${acc.label || acc.email || acc.id}`)
  lines.push(`accountId: ${acc.id}`)
  lines.push(`email: ${acc.email || '—'}`)
  lines.push(`result: ${ok ? 'OK' : 'FAILED'}`)
  lines.push(`started: ${fmtTime(startedAt)}`)
  lines.push(`finished: ${fmtTime(finishedAt)}`)
  lines.push('')
  lines.push('## Token')
  lines.push(`- ok: ${token.ok}`)
  lines.push(`- accessToken: ${token.hasAccessToken ? 'yes' : 'no'}`)
  lines.push(`- refreshToken: ${token.hasRefreshToken ? 'yes' : 'no'}`)
  lines.push(`- expiresAt: ${fmtTime(token.expiresAt)}`)
  lines.push(`- expiringSoon: ${token.expiringSoon}`)
  if (token.refreshed) lines.push(`- refreshed: yes`)
  if (token.refreshError) lines.push(`- refreshError: ${token.refreshError}`)
  lines.push(`- note: ${token.message}`)
  lines.push('')
  lines.push('## Sticky exit')
  lines.push(`- ok: ${exit.ok}`)
  lines.push(`- poolId: ${exit.poolId || '—'}`)
  lines.push(`- exitId: ${exit.exitId || '—'}`)
  lines.push(`- egress: ${exit.exitIp || '—'}`)
  if (exit.error) lines.push(`- error: ${exit.error}`)
  lines.push(`- note: ${exit.message}`)
  lines.push('')
  lines.push('## TLS / JA4 (observe-only)')
  if (tlsError) {
    lines.push(`- error: ${tlsError}`)
  } else if (!tls) {
    lines.push('- skipped')
  } else {
    lines.push(`- note: ${tls.note}`)
    lines.push(`- proxyKind: ${tls.proxyKind || '—'}`)
    const sticky = tls.sticky
    const direct = tls.direct
    lines.push(
      `- sticky: ok=${sticky?.ok ?? '—'} ja4=${sticky?.ja4 || '—'} egress=${sticky?.egressIp || sticky?.egress || '—'}`,
    )
    lines.push(
      `- direct: ok=${direct?.ok ?? '—'} ja4=${direct?.ja4 || '—'} egress=${direct?.egressIp || direct?.egress || '—'}`,
    )
    if (sticky?.ja4 && direct?.ja4) {
      lines.push(`- ja4Match: ${sticky.ja4 === direct.ja4 ? 'same' : 'different'}`)
    }
  }
  lines.push('')
  lines.push('No ClientHello/JA4 forge · no MITM · no machine-id.')
  return lines.join('\n')
}
