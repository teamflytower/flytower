/**
 * Works out what applying a spec would change, without changing anything. The result is
 * shown to the person first and then handed to apply unchanged.
 */
import {
  ACCEPTS,
  resolveAll,
  type ContentProvider,
  type LoaderId,
  type LoaderProvider,
  type ResolvedServer,
  type VanillaTweaksProvider,
  type ResolvedContent,
  type WantedContent,
} from '@flytower/providers'
import { mbToMemory, type ServerSpec } from '../../shared/spec'
import {
  describePublicPage,
  readPublicPage,
  samePublicPage,
  type PublicPage,
} from '../../shared/public-page'
import {
  describeStats,
  readStatsSettings,
  sameStatsSettings,
  type StatsSettings,
} from '../../shared/stats-settings'
import {
  describeMap,
  readMapSettings,
  sameMapSettings,
  type MapSettings,
} from '../../shared/map-settings'
import { describeTrim, readTrimRules, sameTrimRules, type TrimRules } from '../../shared/trim-rules'
import { describeTask, sameTask, toTask, type TaskSpec } from '../../shared/schedules'
import type { schema } from '../db'
import { formatBytes } from '../backups/service'
import { contentDir, isContentPath, type Lock, type LockedItem } from './lock'

type ServerRow = typeof schema.servers.$inferSelect

export interface Change {
  area: 'content' | 'settings' | 'properties' | 'backups' | 'schedules'
  action: 'add' | 'update' | 'remove' | 'reinstall' | 'set'
  label: string
  from?: string
  to?: string
  /** Why a dependency is coming along. */
  note?: string
}

export interface Download extends ResolvedContent {
  path: string
  requiredBy: string[]
}

export interface SettingsChange {
  displayName?: string
  /** null clears it. */
  hostname?: string | null
  memoryMb?: number
  port?: number
  properties: Record<string, string>
  backups?: {
    schedule: string | null
    timezone: string
    keep: { last: number; daily: number; weekly: number }
  }
  /** Off-site storage to copy backups to; null for none. */
  offsiteTarget?: number | null
  restartWhenUnresponsive?: boolean
  /** The whole list of scheduled tasks, in order, when it changes. */
  schedules?: TaskSpec[]
  /** The time zone schedules are read in. */
  timezone?: string
  /** The public status page. */
  publicPage?: PublicPage
  /** Player stats settings. */
  stats?: StatsSettings
  /** Web map settings. */
  map?: MapSettings
  /** What "Trim unused chunks" keeps. Never needs a restart. */
  trim?: TrimRules
  content: ServerSpec['content']
}

/** A new server jar (and maybe Java) to install. */
export interface ServerChange extends ResolvedServer {
  loader: LoaderId
  minecraft: string
}

export interface Plan {
  server: string
  changes: Change[]
  /** Anything here stops apply. */
  problems: string[]
  /** Worth knowing before applying, but doesn't stop it. */
  warnings: string[]
  restart: boolean
  backup: boolean
  downloadBytes: number
  unmanaged: string[]
  /** What apply does; not shown as-is. */
  work: {
    downloads: Download[]
    /** Paths to take away (removed, or replaced by an update). */
    removals: string[]
    /** The lockfile once applied; new items get their SHA-256 when downloaded. */
    lock: Lock
    settings: SettingsChange
    /** Set when the Minecraft version or loader changes. */
    server?: ServerChange
  }
}

export interface PlanInput {
  row: ServerRow
  props: Record<string, string>
  lock: Lock
  spec: ServerSpec
  levelName: string
  /** Which locked paths are really on disk. */
  exists: (path: string) => Promise<boolean>
  unmanaged: string[]
  /** Ports other servers use, for the clash check. */
  otherPorts: { name: string; port: number; rconPort: number; hostname?: string | null }[]
  /** Projects (ids or slugs) allowed to move to a newer version, or true for all. */
  upgrade?: true | string[]
  modrinth: ContentProvider
  vanillatweaks?: VanillaTweaksProvider
  hangar?: ContentProvider
  /** The server's scheduled tasks as they stand. */
  tasks?: TaskSpec[]
  /** Off-site storage that backups can be copied to. */
  offsiteTargets?: { id: number; name: string }[]
  /** Why this server can't have that much memory, if it can't. */
  memoryProblem?: (memoryMb: number) => string | null
  /** Needed to change the Minecraft version or loader. */
  loaders?: Record<LoaderId, LoaderProvider>
  now?: () => Date
}

const lockedKey = (l: Pick<LockedItem, 'source' | 'projectId'>) => `${l.source}:${l.projectId}`

function toWanted(item: ServerSpec['content'][number]): WantedContent {
  if ('modrinth' in item) return { modrinth: item.modrinth, version: item.version, kind: item.kind }
  if ('hangar' in item) return { hangar: item.hangar, version: item.version }
  if ('vanillatweaks' in item) return { vanillatweaks: item.vanillatweaks, tweak: item.tweak }
  return { url: item.url, sha256: item.sha256, kind: item.kind, filename: item.filename }
}

export async function makePlan(input: PlanInput): Promise<Plan> {
  const { row, props, lock, spec } = input
  const changes: Change[] = []
  const problems: string[] = []

  if (spec.name !== row.name) {
    problems.push(`This spec is for "${spec.name}", not "${row.name}". Names can't change.`)
  }
  const server = await planServer(input, changes, problems)
  const target = { loader: spec.loader.type, minecraft: spec.loader.minecraft }
  const newGame = target.loader !== row.loader || target.minecraft !== row.mcVersion

  // Settings.
  const settings: SettingsChange = { properties: {}, content: spec.content }
  if (spec.displayName !== undefined && spec.displayName !== row.displayName) {
    settings.displayName = spec.displayName
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Display name',
      from: row.displayName,
      to: spec.displayName,
    })
  }
  if (spec.memory !== undefined && spec.memory !== row.memoryMb) {
    const tooBig = input.memoryProblem?.(spec.memory)
    if (tooBig) problems.push(tooBig)
    settings.memoryMb = spec.memory
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Memory',
      from: mbToMemory(row.memoryMb),
      to: mbToMemory(spec.memory),
    })
  }
  if (spec.port !== undefined && spec.port !== row.port) {
    const clash = input.otherPorts.find(
      (o) => o.name !== row.name && (o.port === spec.port || o.rconPort === spec.port),
    )
    if (clash || spec.port === row.rconPort) {
      problems.push(
        `Port ${spec.port} is already used${clash ? ` by ${clash.name}` : ' for RCON'}.`,
      )
    } else {
      settings.port = spec.port
      changes.push({
        area: 'settings',
        action: 'set',
        label: 'Port',
        from: String(row.port),
        to: String(spec.port),
      })
    }
  }
  if (spec.hostname !== undefined && spec.hostname !== row.hostname) {
    const clash = spec.hostname
      ? input.otherPorts.find((o) => o.name !== row.name && o.hostname === spec.hostname)
      : undefined
    if (clash) {
      problems.push(`${spec.hostname} is already ${clash.name}'s address.`)
    } else {
      settings.hostname = spec.hostname
      changes.push({
        area: 'settings',
        action: row.hostname ? (spec.hostname ? 'set' : 'remove') : 'add',
        label: 'Address',
        from: row.hostname ?? undefined,
        to: spec.hostname ?? undefined,
      })
    }
  }
  for (const [key, raw] of Object.entries(spec.properties)) {
    const value = String(raw)
    if (props[key] === value) continue
    settings.properties[key] = value
    changes.push({
      area: 'properties',
      action: props[key] === undefined ? 'add' : 'set',
      label: key,
      from: props[key],
      to: value,
    })
  }
  if (spec.recovery && spec.recovery.restartWhenUnresponsive !== row.restartWhenUnresponsive) {
    settings.restartWhenUnresponsive = spec.recovery.restartWhenUnresponsive
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Restart when not responding',
      from: row.restartWhenUnresponsive ? 'On' : 'Off',
      to: spec.recovery.restartWhenUnresponsive ? 'On' : 'Off',
    })
  }
  if (spec.backups) {
    const b = spec.backups
    const same =
      b.schedule === row.backupSchedule &&
      b.timezone === row.backupTz &&
      b.keep.last === row.keepLast &&
      b.keep.daily === row.keepDaily &&
      b.keep.weekly === row.keepWeekly
    if (!same) {
      settings.backups = b
      changes.push({
        area: 'backups',
        action: 'set',
        label: 'Backups',
        from: describeBackups(row.backupSchedule, row.backupTz, [
          row.keepLast,
          row.keepDaily,
          row.keepWeekly,
        ]),
        to: describeBackups(b.schedule, b.timezone, [b.keep.last, b.keep.daily, b.keep.weekly]),
      })
    }
    if (b.offsite !== undefined) {
      const targets = input.offsiteTargets ?? []
      const nameOf = (id: number | null) => targets.find((t) => t.id === id)?.name ?? 'None'
      const wanted =
        b.offsite === null
          ? null
          : (targets.find((t) => t.name.toLowerCase() === b.offsite!.toLowerCase())?.id ??
            undefined)
      if (wanted === undefined) {
        problems.push(
          targets.length
            ? `There's no off-site storage called "${b.offsite}". Use one of: ${targets.map((t) => t.name).join(', ')}.`
            : `There's no off-site storage called "${b.offsite}". Add it on the System page first.`,
        )
      } else if (wanted !== row.offsiteTarget) {
        settings.offsiteTarget = wanted
        changes.push({
          area: 'backups',
          action: 'set',
          label: 'Off-site copies',
          from: nameOf(row.offsiteTarget),
          to: nameOf(wanted),
        })
      }
    }
  }

  if (spec.public) {
    const was = readPublicPage(row.publicPage)
    if (!samePublicPage(was, spec.public)) {
      settings.publicPage = spec.public
      const from = describePublicPage(was)
      const to = describePublicPage(spec.public)
      changes.push({
        area: 'settings',
        action: 'set',
        label: 'Public page',
        from,
        // The summary can read the same when only the description changed.
        to: to === from ? `${to}, updated` : to,
      })
    }
  }

  if (spec.stats) {
    const was = readStatsSettings(row.stats)
    if (!sameStatsSettings(was, spec.stats)) {
      settings.stats = spec.stats
      changes.push({
        area: 'settings',
        action: 'set',
        label: 'Player stats',
        from: describeStats(was),
        to: describeStats(spec.stats),
      })
    }
  }

  if (spec.map) {
    const was = readMapSettings(row.map)
    if (!sameMapSettings(was, spec.map)) {
      settings.map = spec.map
      changes.push({
        area: 'settings',
        action: 'set',
        label: 'Web map',
        from: describeMap(was),
        to: describeMap(spec.map),
      })
    }
  }

  if (spec.world?.trim) {
    const was = readTrimRules(row.trim)
    if (!sameTrimRules(was, spec.world.trim)) {
      settings.trim = spec.world.trim
      const from = describeTrim(was)
      const to = describeTrim(spec.world.trim)
      changes.push({
        area: 'settings',
        action: 'set',
        label: 'Trim rules',
        from,
        // The summary can read the same when only a value changed.
        to: to === from ? `${to}, updated` : to,
      })
    }
  }

  planSchedules(input, settings, changes)

  // Content.
  const accepts: readonly string[] = ACCEPTS[target.loader]
  for (const item of spec.content) {
    const kind = item.kind
    if (kind && !accepts.includes(kind)) {
      problems.push(`A ${target.loader} server can't run ${kind}s.`)
    }
  }
  // A new Minecraft version or loader needs every item's build for it, not the locked one.
  const upgrading = (l: LockedItem) =>
    newGame ||
    input.upgrade === true ||
    (input.upgrade ?? []).some((u) => u === l.projectId || u === l.slug)
  const pinnedBy = new Map<string, string>()
  for (const l of lock.content) {
    if (l.source === 'url' || upgrading(l)) continue
    pinnedBy.set(l.projectId, l.versionId)
    pinnedBy.set(l.slug, l.versionId)
  }
  const resolved = await resolveAll(spec.content.map(toWanted), target, input.modrinth, {
    pinned: (p) => pinnedBy.get(p),
    vanillatweaks: input.vanillatweaks,
    hangar: input.hangar,
  })
  problems.push(...resolved.problems)
  const warnings = resolved.warnings
  for (const item of resolved.items) {
    if (!accepts.includes(item.kind)) {
      problems.push(`${item.title} is a ${item.kind}, which a ${target.loader} server can't run.`)
    }
  }

  const before = new Map(lock.content.map((l) => [lockedKey(l), l]))
  const downloads: Download[] = []
  const removals: string[] = []
  const nextLock: LockedItem[] = []
  for (const item of resolved.items) {
    const path = `${contentDir(item.kind, input.levelName)}/${item.filename}`
    if (!isContentPath(path)) {
      problems.push(
        `${item.title} has an unusual file name ("${item.filename}"), so it can't be installed.`,
      )
      continue
    }
    const old = before.get(lockedKey(item))
    before.delete(lockedKey(item))
    const note = item.requiredBy.length ? `Needed by ${item.requiredBy.join(', ')}` : undefined
    const locked: LockedItem = {
      source: item.source,
      projectId: item.projectId,
      slug: item.slug,
      title: item.title,
      versionId: item.versionId,
      versionNumber: item.versionNumber,
      kind: item.kind,
      path,
      url: item.url,
      sha256: item.hash?.algorithm === 'sha256' ? item.hash.value : '',
      ...(item.hash?.algorithm === 'sha512' ? { sha512: item.hash.value } : {}),
      size: item.size,
      requiredBy: item.requiredBy,
    }
    if (old && old.versionId === item.versionId && old.path === path) {
      if (await input.exists(path)) {
        nextLock.push({ ...old, requiredBy: item.requiredBy })
        continue
      }
      changes.push({
        area: 'content',
        action: 'reinstall',
        label: item.title,
        to: item.versionNumber,
        note: 'The file is missing',
      })
    } else if (old) {
      removals.push(old.path)
      changes.push({
        area: 'content',
        action: 'update',
        label: item.title,
        from: old.versionNumber,
        to: item.versionNumber,
        note,
      })
    } else {
      changes.push({
        area: 'content',
        action: 'add',
        label: item.title,
        to: item.versionNumber,
        note,
      })
    }
    if (input.unmanaged.includes(path)) {
      problems.push(
        `${path} is already there, added by hand. Remove it first, or leave ${item.title} out.`,
      )
    }
    downloads.push({ ...item, path, requiredBy: item.requiredBy })
    nextLock.push(locked)
  }
  for (const old of before.values()) {
    removals.push(old.path)
    changes.push({ area: 'content', action: 'remove', label: old.title, from: old.versionNumber })
  }

  const contentChanged = downloads.length > 0 || removals.length > 0
  const restart =
    contentChanged ||
    server !== undefined ||
    settings.memoryMb !== undefined ||
    settings.port !== undefined ||
    Object.keys(settings.properties).length > 0
  return {
    server: row.name,
    changes,
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
    restart,
    backup: contentChanged || server !== undefined,
    downloadBytes: downloads.reduce((n, d) => n + (d.size ?? 0), 0),
    unmanaged: input.unmanaged,
    work: {
      downloads,
      removals: [...new Set(removals)],
      lock: {
        version: 1,
        updatedAt: (input.now?.() ?? new Date()).toISOString(),
        content: nextLock,
      },
      settings,
      ...(server ? { server } : {}),
    },
  }
}

const LOADER_NAMES: Record<LoaderId, string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  paper: 'Paper',
}
/** What a loader calls its own version, for plan lines. */
const LOADER_VERSION_LABEL: Partial<Record<LoaderId, string>> = {
  fabric: 'Fabric loader',
  paper: 'Paper build',
}

/**
 * Works out a Minecraft version or loader change: the jar to install, the Java it needs,
 * and whether it's allowed (worlds only go forwards).
 */
async function planServer(
  input: PlanInput,
  changes: Change[],
  problems: string[],
): Promise<ServerChange | undefined> {
  const { row, spec } = input
  const want = spec.loader
  const mcChanged = want.minecraft !== row.mcVersion
  const loaderChanged = want.type !== row.loader
  // Left as it was while Minecraft moves on, the loader version follows to the newest.
  const keptLoaderVersion = !want.version || want.version === row.loaderVersion
  const versioned = want.type !== 'vanilla'
  const loaderVersionChanged = versioned && !keptLoaderVersion
  if (!mcChanged && !loaderChanged && !loaderVersionChanged) return undefined

  const provider = input.loaders?.[want.type]
  if (!provider) {
    problems.push("Changing the Minecraft version or loader isn't available here.")
    return undefined
  }
  const name = LOADER_NAMES[want.type]

  if (mcChanged) {
    const versions = (await provider.minecraftVersions({ includeSnapshots: true })).map((v) => v.id)
    const to = versions.indexOf(want.minecraft)
    const from = versions.indexOf(row.mcVersion)
    if (to < 0) {
      problems.push(`${name} doesn't have Minecraft ${want.minecraft}.`)
      return undefined
    }
    // Newest first, so a bigger index is older.
    if (from >= 0 && to > from) {
      problems.push(
        `Minecraft ${want.minecraft} is older than ${row.mcVersion}, and worlds can't safely go back. ` +
          'To go back, restore a backup made before the upgrade.',
      )
      return undefined
    }
  }

  const askVersion = versioned && !keptLoaderVersion ? want.version : undefined
  const resolved = await provider.resolve(want.minecraft, askVersion)

  if (mcChanged) {
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Minecraft',
      from: row.mcVersion,
      to: want.minecraft,
      note: 'The world is upgraded when the server starts',
    })
  }
  if (loaderChanged) {
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Loader',
      from: LOADER_NAMES[row.loader as LoaderId] ?? row.loader,
      to: name,
    })
  }
  if (resolved.loaderVersion && resolved.loaderVersion !== row.loaderVersion) {
    changes.push({
      area: 'settings',
      action: row.loaderVersion ? 'set' : 'add',
      label: LOADER_VERSION_LABEL[want.type] ?? 'Loader version',
      from: row.loaderVersion ?? undefined,
      to: resolved.loaderVersion,
    })
  }
  if (resolved.javaMajor !== row.javaMajor) {
    changes.push({
      area: 'settings',
      action: 'set',
      label: 'Java',
      from: String(row.javaMajor),
      to: String(resolved.javaMajor),
    })
  }
  if (!mcChanged && !loaderChanged && resolved.loaderVersion === row.loaderVersion) {
    return undefined
  }
  return { ...resolved, loader: want.type, minecraft: want.minecraft }
}

/** Lines for added and removed tasks, and the time zone. */
function planSchedules(input: PlanInput, settings: SettingsChange, changes: Change[]) {
  const { row, spec } = input
  if (spec.timezone !== undefined && spec.timezone !== row.timezone) {
    settings.timezone = spec.timezone
    changes.push({
      area: 'schedules',
      action: 'set',
      label: 'Time zone',
      from: row.timezone,
      to: spec.timezone,
    })
  }
  if (!spec.schedules) return
  const before = input.tasks ?? []
  const after = spec.schedules.map(toTask)
  const same = before.length === after.length && before.every((t, i) => sameTask(t, after[i]!))
  if (same) return
  settings.schedules = after
  const left = [...before]
  let listed = 0
  for (const t of after) {
    const i = left.findIndex((o) => sameTask(o, t))
    if (i >= 0) {
      left.splice(i, 1)
      continue
    }
    changes.push({ area: 'schedules', action: 'add', label: describeTask(t) })
    listed++
  }
  for (const t of left) {
    changes.push({ area: 'schedules', action: 'remove', label: describeTask(t) })
    listed++
  }
  if (!listed) changes.push({ area: 'schedules', action: 'set', label: 'Order of tasks' })
}

function describeBackups(schedule: string | null, tz: string, keep: number[]) {
  return `${schedule ? `${schedule} (${tz})` : 'off'}, keep ${keep.join('/')}`
}

/** One line for a person, like "Add Lithium 0.18.0 (12 MB to download)". */
export function summarise(plan: Plan): string {
  if (!plan.changes.length) return 'Nothing to change.'
  const n = plan.changes.length
  const dl = plan.downloadBytes ? `, ${formatBytes(plan.downloadBytes)} to download` : ''
  return `${n} change${n === 1 ? '' : 's'}${dl}${plan.restart ? ', then a restart' : ''}.`
}
