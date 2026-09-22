import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidates = [
  join(here, '../../public/admin.html'),
  join(process.cwd(), 'public/admin.html'),
]

export function loadAdminUiHtml(): string {
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      /* try next */
    }
  }
  return '<!doctype html><meta charset=utf-8><title>admin ui missing</title><p>public/admin.html not found</p>'
}
