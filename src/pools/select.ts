import { hashAccountId } from '../exits/assign.js'
import type { ExitEntry } from '../exits/store.js'

export interface PickExitOpts {
  now?: number
  /** Exit ids to skip (e.g. currently banned exit) */
  excludeIds?: ReadonlySet<string> | readonly string[]
}

function hasOutbound(e: ExitEntry): boolean {
  if (e.outboundProxyUrl?.trim()) return true
  return !!(e.server && e.port && e.method && e.password)
}

function excludeSet(opts?: PickExitOpts): Set<string> {
  if (!opts?.excludeIds) return new Set()
  if (opts.excludeIds instanceof Set) return opts.excludeIds
  return new Set(opts.excludeIds)
}

export function isExitEligible(e: ExitEntry, now = Date.now(), exclude?: Set<string>): boolean {
  if (exclude?.has(e.id)) return false
  if (e.disabled) return false
  if (typeof e.cooldownUntil === 'number' && e.cooldownUntil > now) return false
  if (!hasOutbound(e)) return false
  return true
}

/** Sort key helpers — lower is better. */
export function exitSortKey(
  accountId: string,
  e: ExitEntry,
): [number, number, number] {
  const useCount = e.useCount ?? 0
  const banCount = e.banCount ?? 0
  const sticky = hashAccountId(`${accountId}\0${e.id}`)
  return [useCount, banCount, sticky]
}

export function rankExits(
  accountId: string,
  exits: readonly ExitEntry[],
  opts?: PickExitOpts,
): ExitEntry[] {
  const now = opts?.now ?? Date.now()
  const exclude = excludeSet(opts)
  const eligible = exits.filter((e) => isExitEligible(e, now, exclude))
  return [...eligible].sort((a, b) => {
    const ka = exitSortKey(accountId, a)
    const kb = exitSortKey(accountId, b)
    for (let i = 0; i < 3; i++) {
      if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function pickExitFromPool(
  accountId: string,
  exits: readonly ExitEntry[],
  opts?: PickExitOpts,
): ExitEntry {
  const ranked = rankExits(accountId, exits, opts)
  if (ranked.length === 0) {
    throw new Error('No eligible exits in pool')
  }
  return ranked[0]!
}
