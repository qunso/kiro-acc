/** FNV-1a 32-bit — same algorithm as ss-exit sticky assign. */
export function hashAccountId(accountId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export type ExitAssignStrategy = 'sticky' | 'round-robin'

export function pickExitId(
  accountId: string,
  exitIds: readonly string[],
  strategy: ExitAssignStrategy,
  rrCounter = 0,
): string {
  if (exitIds.length === 0) throw new Error('No exits available')
  if (strategy === 'sticky') {
    return exitIds[hashAccountId(accountId) % exitIds.length]!
  }
  const idx = ((rrCounter % exitIds.length) + exitIds.length) % exitIds.length
  return exitIds[idx]!
}
