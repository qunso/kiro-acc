#!/usr/bin/env node
/**
 * Generate data/ss-exits.json (+ meta) for iqun SS_PASS_SELECT index mode (kiro-acc native SS).
 *
 * Usage:
 *   SS_PASS=secret SS_METHOD=aes-256-gcm SS_PORT=60123 \
 *     node scripts/gen-ss-exits.mjs --host ss1.example.com --ip-count 245 --id-prefix ss1
 *
 *   node scripts/gen-ss-exits.mjs --hosts ./hosts.json
 *
 * hosts.json shape:
 *   [{ "id": "ss1", "host": "1.2.3.4", "port": 60123, "ipCount": 245 }]
 *   optional: "exitIps": ["x.x.x.x", ...] (length should match ipCount; index i → exitIps[i])
 *
 * Or CLI multi-host:
 *   --host H --ip-count N [--id-prefix P] [--port PORT]  (repeatable via --hosts file preferred)
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function env(name, fallback = '') {
  return process.env[name]?.trim() || fallback
}

function parseArgs(argv) {
  const out = {
    hostsFile: null,
    host: null,
    ipCount: null,
    idPrefix: null,
    port: null,
    out: path.join(root, 'data', 'ss-exits.json'),
    metaOut: path.join(root, 'data', 'ss-exits.meta.json'),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Missing value after ${a}`)
      return v
    }
    if (a === '--hosts') out.hostsFile = next()
    else if (a === '--host') out.host = next()
    else if (a === '--ip-count') out.ipCount = Number(next())
    else if (a === '--id-prefix') out.idPrefix = next()
    else if (a === '--port') out.port = Number(next())
    else if (a === '--out') out.out = path.resolve(next())
    else if (a === '--meta-out') out.metaOut = path.resolve(next())
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`Unknown arg: ${a}`)
  }
  return out
}

function usage() {
  console.log(`Usage:
  SS_PASS=... [SS_METHOD=aes-256-gcm] [SS_PORT=60123] \\
    node scripts/gen-ss-exits.mjs --host HOST --ip-count N [--id-prefix PREFIX] [--port PORT]

  SS_PASS=... node scripts/gen-ss-exits.mjs --hosts ./hosts.json

Output: data/ss-exits.json + data/ss-exits.meta.json
Each exit password is \`\${SS_PASS}#\${index}\` (iqun SS_PASS_SELECT=1).`)
}

async function loadHosts(args) {
  if (args.hostsFile) {
    const raw = JSON.parse(await fs.readFile(path.resolve(args.hostsFile), 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.hosts
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('hosts file must be a non-empty array (or { hosts: [...] })')
    }
    return list.map((h, i) => ({
      id: String(h.id || h.idPrefix || `host${i}`),
      host: String(h.host || h.server),
      port: Number(h.port || env('SS_PORT', '60123')),
      ipCount: Number(h.ipCount ?? h.ip_count),
      exitIps: Array.isArray(h.exitIps) ? h.exitIps : Array.isArray(h.exit_ips) ? h.exit_ips : undefined,
    }))
  }
  if (args.host && args.ipCount) {
    return [
      {
        id: args.idPrefix || 'ss',
        host: args.host,
        port: args.port || Number(env('SS_PORT', '60123')),
        ipCount: args.ipCount,
      },
    ]
  }
  throw new Error('Provide --hosts FILE or --host + --ip-count')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  const ssPass = env('SS_PASS')
  if (!ssPass) {
    console.error('SS_PASS env is required')
    process.exit(1)
  }
  const method = env('SS_METHOD', 'aes-256-gcm')
  const defaultPort = Number(env('SS_PORT', '60123'))

  const hosts = await loadHosts(args)
  const exits = []
  const hostCounts = []

  for (const h of hosts) {
    if (!h.host) throw new Error(`host missing for id=${h.id}`)
    if (!Number.isFinite(h.ipCount) || h.ipCount < 1) {
      throw new Error(`ipCount must be >= 1 for id=${h.id}`)
    }
    const port = Number.isFinite(h.port) && h.port > 0 ? h.port : defaultPort
    const prefix = h.id
    for (let index = 0; index < h.ipCount; index++) {
      const id = `${prefix}-${index}`
      const entry = {
        id,
        server: h.host,
        port,
        method,
        password: `${ssPass}#${index}`,
        index,
      }
      const exitIp = h.exitIps?.[index]
      if (exitIp) entry.exitIp = String(exitIp)
      exits.push(entry)
    }
    hostCounts.push({ id: prefix, host: h.host, port, ipCount: h.ipCount })
  }

  await fs.mkdir(path.dirname(args.out), { recursive: true })
  await fs.writeFile(args.out, JSON.stringify(exits, null, 2) + '\n', 'utf8')

  const meta = {
    generatedAt: new Date().toISOString(),
    method,
    defaultPort,
    totalExits: exits.length,
    hosts: hostCounts,
    note: 'Passwords are in ss-exits.json only; SS_PASS itself is not stored here.',
  }
  await fs.writeFile(args.metaOut, JSON.stringify(meta, null, 2) + '\n', 'utf8')

  console.log(`Wrote ${exits.length} exits → ${args.out}`)
  console.log(`Meta → ${args.metaOut}`)
  console.log(JSON.stringify(hostCounts, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
