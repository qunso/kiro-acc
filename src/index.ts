import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { AccountStore } from './accounts/store.js'
import { ExitsStore } from './exits/store.js'
import { PoolsStore } from './pools/store.js'
import { ApiKeyStore } from './apiKeys/store.js'
import { ModelMapStore } from './proxy/modelMapStore.js'
import { createServer } from './server.js'

async function main() {
  const config = loadConfig()
  const store = new AccountStore(config.dataDir, config)
  await store.init()

  const exits = new ExitsStore(config.dataDir)
  await exits.init()

  const pools = new PoolsStore(config.dataDir)
  await pools.init()

  const apiKeys = new ApiKeyStore(config.dataDir, config.apiKey)
  await apiKeys.init()

  const modelMap = new ModelMapStore(config.dataDir)
  await modelMap.init()

  const app = createServer(store, config, exits, pools, { apiKeys, modelMap })

  console.log(`[kiro-acc] dataDir=${config.dataDir}`)
  console.log(`[kiro-acc] strategy=${store.pool.getStrategy()} accounts=${store.pool.size}`)
  console.log(`[kiro-acc] exits=${exits.listIds().length} broker=${exits.get().brokerBase || '-'}`)
  console.log(`[kiro-acc] pools=${pools.list().length}`)
  console.log(`[kiro-acc] apiKeys=${apiKeys.listPublic().filter((k) => k.active).length} (+env=${apiKeys.hasEnvKey() ? 'yes' : 'no'})`)
  console.log(`[kiro-acc] modelMap=${Object.keys(modelMap.get()).length}`)
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
