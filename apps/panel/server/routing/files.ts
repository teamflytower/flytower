/**
 * The server-side half of real player addresses (#76): putting our flytower-proxy mod in a
 * Fabric server, turning on Paper's own PROXY protocol setting, telling whether a running
 * server has picked either up, and reading vanilla's IP bans for the router to enforce.
 */
import { watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { readNoFollow, replaceFile } from '../files'

export type Loader = 'vanilla' | 'fabric' | 'paper'

/** Where the mod goes in a Fabric server, and the name it has in the release. */
export const MOD_FILE = 'flytower-proxy.jar'
const modPath = (dir: string) => join(dir, 'mods', MOD_FILE)
const paperGlobal = (dir: string) => join(dir, 'config', 'paper-global.yml')
/**
 * Paper rewrites paper-global.yml every time it starts, so its age says nothing. The panel
 * touches this file whenever it changes the setting instead.
 */
const paperMarker = (dir: string) => join(dir, 'config', '.flytower-proxy-protocol')
/** The router refuses a table with more bans than this for one server. */
export const MAX_BANS = 10_000

/**
 * Sets `proxies.proxy-protocol` in paper-global.yml's text, keeping the rest of the file (and
 * its comments) as it was. Returns null when it's already set that way.
 */
export function setPaperProxyProtocol(text: string, on: boolean): string | null {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^proxies:\s*(#.*)?$/.test(l))
  const value = `  proxy-protocol: ${on}`
  if (start === -1) {
    if (!on) return null
    return `${text.replace(/\n*$/, '\n')}proxies:\n${value}\n`
  }
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]!))) end++
  const at = lines.slice(start + 1, end).findIndex((l) => /^ {2}proxy-protocol:/.test(l))
  if (at === -1) {
    if (!on) return null
    lines.splice(start + 1, 0, value)
    return lines.join('\n')
  }
  const current = /^ {2}proxy-protocol:\s*(true|false)\s*(#.*)?$/.exec(lines[start + 1 + at]!)
  if (current?.[1] === String(on)) return null
  lines[start + 1 + at] = value
  return lines.join('\n')
}

/**
 * Gets a server ready to read real addresses, or undoes that when it's no longer routed. Fabric
 * servers get the mod (or lose it); Paper servers get the setting, once Paper has written its
 * config on first start. Changes take effect at the server's next restart. `mod` is the
 * release's copy of the jar, or null if this install doesn't have one.
 */
export async function prepareServer(
  dir: string,
  loader: Loader,
  routed: boolean,
  mod: Uint8Array | null,
): Promise<void> {
  if (loader === 'fabric') {
    const dest = modPath(dir)
    if (!routed || !mod) {
      if (await lstat(dest).catch(() => null)) await rm(dest, { force: true })
      return
    }
    const have = await Bun.file(dest)
      .bytes()
      .catch(() => null)
    if (have && Buffer.compare(have, mod) === 0) return
    await mkdir(join(dir, 'mods'), { recursive: true })
    await replaceFile(dest, mod)
  } else if (loader === 'paper') {
    const path = paperGlobal(dir)
    const text = await readNoFollow(path)
    if (text === null) return
    const changed = setPaperProxyProtocol(text, routed)
    if (changed !== null) {
      await replaceFile(path, changed)
      await replaceFile(paperMarker(dir), `${routed}\n`)
    }
  }
}

/**
 * Reads systemd's timestamps, like "Tue 2026-11-10 15:00:00 UTC". The zone is an abbreviation
 * that JavaScript can't always read (BST), but systemd writes the box's own local time, which
 * is this process's too. Null if it isn't one.
 */
export function parseSystemdTime(text: string): Date | null {
  const m = /^(?:\w{3} )?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (\S+))?$/.exec(text.trim())
  if (!m) return null
  const utc = m[3] === 'UTC' || m[3] === 'GMT'
  const d = new Date(`${m[1]}T${m[2]}${utc ? 'Z' : ''}`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** systemd's timestamps are to the second, so a file written just before a start can look later. */
const SLACK_MS = 1000

/**
 * True when a running server reads PROXY headers: the mod or setting was in place before the
 * server last started (`since`). The router mustn't send headers to a server that doesn't
 * expect them, because the player couldn't join at all.
 */
export async function readsProxyHeaders(
  dir: string,
  loader: Loader,
  since: Date | null,
): Promise<boolean> {
  if (!since || loader === 'vanilla') return false
  const startedAfter = async (path: string) => {
    const st = await lstat(path).catch(() => null)
    return st?.isFile() ? st.mtimeMs < since.getTime() + SLACK_MS : null
  }
  if (loader === 'fabric') return (await startedAfter(modPath(dir))) === true
  // Paper: the setting is on, and the panel didn't turn it on since the server started. If the
  // panel never changed it, someone set it by hand and Paper has been reading it all along.
  const text = await readNoFollow(paperGlobal(dir)).catch(() => null)
  if (text === null || setPaperProxyProtocol(text, true) !== null) return false
  return (await startedAfter(paperMarker(dir))) !== false
}

/** The server's current IP bans from banned-ips.json, for the router. Expired ones are left out. */
export async function readIpBans(dir: string, now = new Date()): Promise<string[]> {
  const text = await readNoFollow(join(dir, 'banned-ips.json')).catch(() => null)
  if (!text) return []
  let entries: unknown
  try {
    entries = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  const bans = new Set<string>()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const { ip, expires } = e as { ip?: unknown; expires?: unknown }
    if (typeof ip !== 'string' || !isIP(ip)) continue
    if (typeof expires === 'string' && expires !== 'forever') {
      // Minecraft writes "2026-11-14 01:00:00 +0000".
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(expires)
      const at = m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : null
      if (at && at.getTime() <= now.getTime()) continue
    }
    bans.add(ip)
    if (bans.size === MAX_BANS) break
  }
  return [...bans].sort()
}

/**
 * Watches routed servers' folders for banned-ips.json changing (an operator's /ban-ip), and
 * calls back so the router gets the new list straight away.
 */
export class BanWatcher {
  private watchers = new Map<string, FSWatcher>()

  constructor(private changed: () => void) {}

  /** Watches exactly these folders from now on. */
  set(dirs: string[]) {
    const wanted = new Set(dirs)
    for (const [dir, w] of this.watchers) {
      if (!wanted.has(dir)) {
        w.close()
        this.watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue
      try {
        const w = watch(dir, (_event, file) => {
          if (file === 'banned-ips.json') this.changed()
        })
        w.on('error', () => {
          w.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, w)
      } catch {
        // The folder isn't there yet; the next sync tries again.
      }
    }
  }

  close() {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}
