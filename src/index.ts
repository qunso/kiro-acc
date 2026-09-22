import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { AccountStore } from './accounts/store.js'
import { ExitsStore } from './exits/store.js'
import { PoolsStore } from './pools/store.js'
import { createServer } from './server.js'

async function main() {
  const config = loadConfig()
  const store = new AccountStore(config.dataDir, config)
  await store.init()

  const exits = new ExitsStore(config.dataDir)
  await exits.init()

  const pools = new PoolsStore(config.dataDir)
  await pools.init()

  const app = createServer(store, config, exits, pools)

  console.log(`[kiro-acc] dataDir=${config.dataDir}`)
  console.log(`[kiro-acc] strategy=${store.pool.getStrategy()} accounts=${store.pool.size}`)
  console.log(`[kiro-acc] exits=${exits.listIds().length} broker=${exits.get().brokerBase || '-'}`)
  console.log(`[kiro-acc] pools=${pools.list().length}`)
  console.log(`[kiro-acc] listening on http://${config.host}:${config.port}`)

  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
