/**
 * Measures server folders for real under the dev data folder, grouped the way the real agent
 * groups them (`crates/flytower-agent/src/handlers/disk.rs`, checked by
 * `protocol/fixtures/disk-groups.jsonl`). Everything outside the servers is made up.
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Result } from '@flytower/protocol'

type Groups = Result<'disk.usage'>['servers'][string]['groups']

/** Which group a top-level entry of a server folder counts towards. */
export function groupOf(entry: string, levelName: string | null): keyof Groups {
  const level = levelName?.split('/')[0]?.trim()
  if ((level && entry === level) || entry.startsWith('world')) return 'world'
  if (entry === 'logs' || entry === 'crash-reports') return 'logs'
  if (entry === 'mods' || entry === 'plugins' || entry === 'config') return 'content'
  return 'other'
}

async function levelName(dir: string): Promise<string | null> {
  const text = await readFile(join(dir, 'server.properties'), 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    const m = /^\s*level-name\s*[=:]\s*(.*)$/.exec(line)
    if (m) return m[1]!.trim() || null
  }
  return null
}

/** Bytes on disk under a path, never following links. */
async function size(path: string): Promise<number> {
  const s = await lstat(path).catch(() => null)
  if (!s) return 0
  if (!s.isDirectory()) return s.blocks * 512
  const names = await readdir(path).catch(() => [])
  let total = s.blocks * 512
  for (const n of names) total += await size(join(path, n))
  return total
}

/** Each server's folder, plus its backups, exports and map tiles under the data folder. */
export async function serverUsage(data: string, servers: string[]) {
  const out: Result<'disk.usage'>['servers'] = {}
  for (const server of servers) {
    const dir = join(data, 'servers', server)
    const groups: Groups = {
      world: 0,
      logs: 0,
      content: 0,
      map: 0,
      backups: 0,
      exports: 0,
      other: 0,
    }
    const level = await levelName(dir)
    for (const n of await readdir(dir).catch(() => [])) {
      groups[groupOf(n, level)] += await size(join(dir, n))
    }
    groups.backups += await size(join(data, 'backups', server))
    groups.exports += await size(join(data, 'exports', server))
    groups.map += await size(join(data, 'maps', 'servers', server))
    out[server] = { groups, unreadable: 0 }
  }
  return out
}
