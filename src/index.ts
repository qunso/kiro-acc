import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { AccountStore } from './accounts/store.js'
import { createServer } from './server.js'

async function main() {
  const config = loadConfig()
  const store = new AccountStore(config.dataDir, config)
  await store.init()

  const app = createServer(store, config)

  console.log(`[kiro-acc] dataDir=${config.dataDir}`)
  console.log(`[kiro-acc] strategy=${store.pool.getStrategy()} accounts=${store.pool.size}`)
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
