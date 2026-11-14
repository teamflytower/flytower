/**
 * The lockfile: exactly which files a server's spec installed, by URL and hash. It lives in
 * the server folder as flytower.lock.json so it travels with backups and moves.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CONTENT_KINDS } from '@flytower/providers'
import { isSafeLevelName } from '../../shared/spec'
import { readNoFollow, replaceFile } from '../files'

export const LOCK_FILE = 'flytower.lock.json'

/** A file name Flytower will put in a content folder: one plain name, not hidden. */
export const isSafeContentFile = (name: string) =>
  name.length > 0 &&
  name.length <= 160 &&
  !name.startsWith('.') &&
  // eslint-disable-next-line no-control-regex
  !/[/\\\x00-\x1f\x7f]/.test(name)

/**
 * Whether a lockfile path is a file directly inside mods/, plugins/ or a world's datapacks/.
 * The lockfile sits in the server folder where the server can edit it, so its paths are
 * checked before anything is moved or deleted.
 */
export function isContentPath(path: string) {
  const slash = path.lastIndexOf('/')
  if (slash < 0 || !isSafeContentFile(path.slice(slash + 1))) return false
  const folder = path.slice(0, slash)
  if (folder === 'mods' || folder === 'plugins') return true
  const level = /^(.+)\/datapacks$/.exec(folder)?.[1]
  return level !== undefined && isSafeLevelName(level)
}

const LockedItem = z.object({
  source: z.enum(['modrinth', 'hangar', 'url', 'vanillatweaks']),
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  versionId: z.string(),
  versionNumber: z.string(),
  kind: z.enum(CONTENT_KINDS),
  /** Relative to the server folder, like "mods/lithium.jar" or "world/datapacks/x.zip". */
  path: z.string().refine(isContentPath),
  url: z.string(),
  sha256: z.string(),
  sha512: z.string().optional(),
  size: z.number().nullable(),
  requiredBy: z.array(z.string()),
})
export type LockedItem = z.infer<typeof LockedItem>

const Lock = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  content: z.array(LockedItem),
})
export type Lock = z.infer<typeof Lock>

export const emptyLock = (): Lock => ({
  version: 1,
  updatedAt: new Date(0).toISOString(),
  content: [],
})

export class LockError extends Error {
  override name = 'LockError'
}

export async function readLock(dir: string): Promise<Lock> {
  const text = await readNoFollow(join(dir, LOCK_FILE)).catch(() => {
    throw new LockError(`${LOCK_FILE} can't be read. Fix or delete it in the file manager.`)
  })
  if (text === null) return emptyLock()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LockError(`${LOCK_FILE} is damaged. Fix or delete it in the file manager.`)
  }
  const lock = Lock.safeParse(parsed)
  if (!lock.success) {
    throw new LockError(`${LOCK_FILE} isn't one Flytower understands. Fix or delete it.`)
  }
  return lock.data
}

export async function writeLock(dir: string, lock: Lock) {
  const body = `${JSON.stringify({ ...lock, content: [...lock.content].sort(byPath) }, null, 2)}\n`
  await replaceFile(join(dir, LOCK_FILE), body)
}

const byPath = (a: LockedItem, b: LockedItem) => a.path.localeCompare(b.path)

/** Where each kind of content goes inside the server folder. */
export function contentDir(kind: LockedItem['kind'], levelName: string) {
  return kind === 'mod' ? 'mods' : kind === 'plugin' ? 'plugins' : `${levelName}/datapacks`
}

/**
 * The hostname router's proxy mod, which the panel puts in Fabric servers itself while
 * routing is on (server/routing/files.ts). It isn't the server's content.
 */
const PANEL_FILES = new Set(['mods/flytower-proxy.jar'])

/**
 * Files in the content folders that the lockfile doesn't know about: put there by hand, so
 * they're shown and left alone.
 */
export async function unmanagedFiles(dir: string, lock: Lock, levelName: string) {
  const known = new Set(lock.content.map((c) => c.path))
  const out: { path: string; kind: LockedItem['kind'] }[] = []
  for (const kind of CONTENT_KINDS) {
    const sub = contentDir(kind, levelName)
    const names = await readdir(join(dir, sub)).catch(() => [] as string[])
    for (const name of names.sort()) {
      const path = `${sub}/${name}`
      const fits =
        kind === 'datapack' ? /\.zip$/i.test(name) || !name.includes('.') : /\.jar$/i.test(name)
      if (fits && !known.has(path) && !PANEL_FILES.has(path)) out.push({ path, kind })
    }
  }
  return out
}
