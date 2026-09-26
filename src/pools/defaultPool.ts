/**
 * Resolve a "default" proxy pool for auto-bind on account import.
 *
 * Preference:
 *  1. Enabled pool with id or name "default" (case-insensitive) and ≥1 exit
 *  2. The sole enabled pool that has ≥1 exit
 *  3. undefined (caller leaves account unbound)
 */
import type { ProxyPool, PoolsStore } from './store.js'

export function listEligiblePools(pools: PoolsStore): ProxyPool[] {
  return pools.list().filter((p) => !p.disabled && (p.exitIds?.length || 0) > 0)
}

export function resolveDefaultPool(pools: PoolsStore): ProxyPool | undefined {
  const eligible = listEligiblePools(pools)
  if (!eligible.length) return undefined
  const named = eligible.find((p) => {
    const id = (p.id || '').trim().toLowerCase()
    const name = (p.name || '').trim().toLowerCase()
    return id === 'default' || name === 'default'
  })
  if (named) return named
  if (eligible.length === 1) return eligible[0]
  return undefined
}
