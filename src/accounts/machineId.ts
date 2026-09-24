/**
 * Per-account Machine ID (机器码) helpers.
 *
 * Research (chaogei / hj kiro-account-manager):
 * - Account field `machineId` is shown as 「机器码」 (zh) / 「Machine ID」 (en) —
 *   one field, two labels. Sent as the KiroIDE User-Agent suffix on upstream calls.
 * - 「系统机器码」 (OS MachineGuid /etc/machine-id) is local IDE switcher only;
 *   headless kiro-acc does not write OS/IDE files.
 * - Do NOT rotate per request (ban-evasion). Stable per account; generate once.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { AccountRecord } from './types.js'

/** UUID v4 lowercase — matches hj normalize_accounts / IDE machineid file shape. */
export function generateMachineId(): string {
  return randomUUID().toLowerCase()
}

/**
 * Deterministic fallback when an old account has no stored id yet
 * (same idea as chaogei generateStableMachineId). Prefer persisted UUID.
 */
export function stableMachineIdForAccountId(accountId: string): string {
  return createHash('sha256').update(`kiro-device-${accountId}`).digest('hex')
}

/** Prefer machineId; fall back to legacy deviceId alias from PR #9. */
export function pickStoredMachineId(
  account: Pick<AccountRecord, 'machineId' | 'deviceId'>,
): string | undefined {
  const mid = account.machineId?.trim()
  if (mid) return mid
  const did = account.deviceId?.trim()
  if (did) return did
  return undefined
}

/**
 * Resolve the id that should go on User-Agent for this account.
 * Never returns empty; never invents a new random value per call.
 */
export function resolveMachineIdForRequest(
  account: Pick<AccountRecord, 'id' | 'machineId' | 'deviceId'>,
): string {
  return pickStoredMachineId(account) || stableMachineIdForAccountId(account.id)
}

export function buildKiroUserAgent(opts: {
  kiroVersion: string
  awsSdkVersion: string
  machineId?: string
  platform?: string
  osRelease?: string
  nodeVersion?: string
}): string {
  const platform =
    opts.platform ||
    (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'macos' : 'linux')
  const osRelease = opts.osRelease || process.version
  const nodeVersion = opts.nodeVersion || process.versions.node
  const suffix = opts.machineId
    ? `KiroIDE-${opts.kiroVersion}-${opts.machineId}`
    : `KiroIDE-${opts.kiroVersion}`
  return `aws-sdk-js/${opts.awsSdkVersion} ua/2.1 os/${platform}#${osRelease} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#${opts.awsSdkVersion} m/E ${suffix}`
}

export function buildKiroAmzUserAgent(opts: {
  kiroVersion: string
  awsSdkVersion: string
  machineId?: string
}): string {
  const suffix = opts.machineId
    ? `KiroIDE-${opts.kiroVersion}-${opts.machineId}`
    : `KiroIDE-${opts.kiroVersion}`
  return `aws-sdk-js/${opts.awsSdkVersion} ${suffix}`
}
