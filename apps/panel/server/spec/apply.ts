/**
 * Plans and applies specs. A plan is kept for a while under an id with a fingerprint of
 * what it was based on, so apply does exactly what was shown or refuses.
 */
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  ACCEPTS,
  type ContentKind,
  downloadVerified,
  ProviderError,
  requestDownload,
  type ContentProvider,
  type Fetch,
  type LoaderId,
  type LoaderProvider,
  type VanillaTweaksProvider,
} from '@flytower/providers'
import { listZip, unzip } from '../unzip'
import { resolveInside } from '../files'
import { SPEC_STEPS, type JobEvent } from '../../shared/utils/jobs'
import { isSafeLevelName, type ServerSpec } from '../../shared/spec'
import type { TaskSpec } from '../../shared/schedules'
import { schema, type Db } from '../db'
import { JobError, type AgentCall, type JobTracker } from '../jobs/runner'
import type { BackupService } from '../backups/service'
import { specFromServer } from './from-server'
import { readLock, unmanagedFiles, writeLock, type Lock, type LockedItem } from './lock'
import { makePlan, type Plan } from './plan'
import { specNeeds } from './sections'
import type { ServerPermission } from '../../shared/permissions'
import { budgetProblem, type MemoryUser } from '../memory'

export const PLAN_TTL_MS = 15 * 60_000
const STAGING = '.flytower-staging'

export class SpecError extends JobError {}

export interface SpecDeps {
  db: Db
  serverDir: (name: string) => string
  agent: AgentCall
  jobs: {
    track(kind: string, server: string | null, steps: readonly string[]): JobTracker
    waitActive(name: string): Promise<void>
    memoryUsers?(): MemoryUser[]
    totalMemoryMb?(): number
  }
  backups: Pick<BackupService, 'lock' | 'snapshot'>
  modrinth: ContentProvider
  vanillatweaks?: VanillaTweaksProvider
  hangar?: ContentProvider
  /** For Minecraft version and loader changes. */
  loaders?: Record<LoaderId, LoaderProvider>
  fetch: Fetch
  readProperties: (name: string) => Promise<Record<string, string>>
  writeProperties: (name: string, changes: Record<string, string>) => Promise<void>
  /** Called after backup settings change. */
  schedulesChanged?: () => void
  /** Called after a server's hostname or port changed, for the hostname router (#76). */
  addressChanged?: (name: string) => Promise<void>
  /** Called after player stats settings change, to stop recording or forget players. */
  statsChanged?: (name: string, before: unknown) => void
  /** Called after settings are saved, so the map service starts or stops drawing. */
  mapChanged?: (name: string) => Promise<void>
  /** Scheduled tasks: read for plans and specs, replaced by apply. */
  tasks?: {
    tasks(name: string): TaskSpec[]
    replace(name: string, tasks: TaskSpec[], timezone?: string): void
  }
  /** Off-site storage, for specs that name it. */
  offsiteTargets?: () => { id: number; name: string }[]
  /** Called after a server's off-site storage changes, to copy its existing backups. */
  offsiteChanged?: (name: string) => void
  /** Called once a server has stopped, to drop cached connections. */
  stopped?: (name: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface StoredPlan {
  plan: Plan
  fingerprint: string
  at: number
  /** The permissions the change needs, checked again when it's applied. */
  needs: ServerPermission[]
}

export type PublicPlan = Omit<Plan, 'work'> & { id: string }

export interface ContentListing {
  accepts: ContentKind[]
  items: (Pick<
    LockedItem,
    'source' | 'projectId' | 'slug' | 'title' | 'versionNumber' | 'kind' | 'path' | 'requiredBy'
  > & { asked: boolean })[]
  pending: ServerSpec['content']
  unmanaged: { path: string; kind: ContentKind }[]
}

export function publicPlan(id: string, plan: Plan): PublicPlan {
  const out: Partial<Plan> = { ...plan }
  delete out.work
  return { id, ...(out as Omit<Plan, 'work'>) }
}

/** The world folder's name, refusing anything that would leave the server folder. */
export function levelNameOf(props: Record<string, string>) {
  const level = props['level-name'] || 'world'
  if (!isSafeLevelName(level)) {
    throw new SpecError(`The world folder "${level}" has an unusual name; rename it first.`)
  }
  return level
}

/** Whether a lockfile entry is the one a spec item asked for. */
export function askedFor(a: ServerSpec['content'][number], l: LockedItem) {
  if ('modrinth' in a) {
    return l.source === 'modrinth' && (a.modrinth === l.slug || a.modrinth === l.projectId)
  }
  if ('hangar' in a) {
    const slug = a.hangar.slice(a.hangar.lastIndexOf('/') + 1).toLowerCase()
    return l.source === 'hangar' && l.slug.toLowerCase() === slug
  }
  if ('vanillatweaks' in a) {
    return (
      l.source === 'vanillatweaks' &&
      l.projectId.toLowerCase() === `${a.tweak ?? 'datapack'}:${a.vanillatweaks}`.toLowerCase()
    )
  }
  return l.source === 'url' && a.url === l.url
}

/**
 * Replaces a zip that holds one zip (as Vanilla Tweaks sends datapacks) with the zip inside.
 * Returns the SHA-256 of what is kept.
 */
async function unwrap(file: string, work: string): Promise<string> {
  const inner = (await listZip(file)).filter((i) => !i.dir && /\.zip$/i.test(i.name))
  if (inner.length !== 1) {
    throw new ProviderError(
      `Expected one datapack inside the download, found ${inner.length}. Upload the pack in Files instead.`,
    )
  }
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  await unzip(file, work, { maxBytes: 512 * 1024 * 1024 })
  const files = (await readdir(work, { recursive: true, withFileTypes: true })).filter(
    (e) => e.isFile() && /\.zip$/i.test(e.name),
  )
  if (files.length !== 1)
    throw new ProviderError('The Vanilla Tweaks download was not as expected.')
  const found = join(files[0]!.parentPath, files[0]!.name)
  await rename(found, file)
  await rm(work, { recursive: true, force: true })
  return new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex')
}

export class SpecService {
  private plans = new Map<string, StoredPlan>()
  private now: () => number
  private sleep: (ms: number) => Promise<void>

  constructor(private deps: SpecDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms))
  }

  private row(name: string) {
    const row = this.deps.db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.name, name))
      .get()
    if (!row) throw new SpecError(`No server called ${name}.`)
    return row
  }

  /** Everything a plan depends on, so a stale plan can be spotted. */
  private async fingerprint(name: string) {
    const row = this.row(name)
    const props = await this.deps.readProperties(name)
    const lock = await readLock(this.deps.serverDir(name))
    return new Bun.CryptoHasher('sha256')
      .update(
        JSON.stringify({
          row: { ...row, createdAt: null },
          props,
          lock: lock.content,
          tasks: this.deps.tasks?.tasks(name) ?? [],
        }),
      )
      .digest('hex')
  }

  /** The server's spec as it stands now. */
  async currentSpec(name: string): Promise<ServerSpec> {
    return specFromServer(
      this.row(name),
      await this.deps.readProperties(name),
      this.deps.offsiteTargets?.(),
      this.deps.tasks?.tasks(name),
    )
  }

  /** What's installed, what was asked for, and what was added by hand. */
  async content(name: string): Promise<ContentListing> {
    const row = this.row(name)
    const dir = this.deps.serverDir(name)
    const props = await this.deps.readProperties(name)
    const lock = await readLock(dir)
    const asked = row.content ?? []
    const isAsked = (l: LockedItem) => asked.some((a) => askedFor(a, l))
    return {
      accepts: [...ACCEPTS[row.loader]],
      items: lock.content.map((l) => ({
        source: l.source,
        projectId: l.projectId,
        slug: l.slug,
        title: l.title,
        versionNumber: l.versionNumber,
        kind: l.kind,
        path: l.path,
        asked: isAsked(l),
        requiredBy: l.requiredBy,
      })),
      // Asked for, but not installed yet (say, a spec pasted in that hasn't been applied).
      pending: asked.filter((a) => !lock.content.some((l) => askedFor(a, l))),
      unmanaged: await unmanagedFiles(dir, lock, levelNameOf(props)),
    }
  }

  /** The permissions changing `name` to `spec` needs (see sections.ts). */
  async needs(name: string, spec: ServerSpec, upgrade?: true | string[]) {
    return specNeeds(await this.currentSpec(name), spec, upgrade)
  }

  /** What a plan made earlier needs, or null when it has expired. */
  planNeeds(name: string, planId: string): ServerPermission[] | null {
    this.sweep()
    const stored = this.plans.get(planId)
    return stored && stored.plan.server === name ? stored.needs : null
  }

  async plan(name: string, spec: ServerSpec, upgrade?: true | string[]): Promise<PublicPlan> {
    const { db } = this.deps
    const needs = await this.needs(name, spec, upgrade)
    const row = this.row(name)
    const dir = this.deps.serverDir(name)
    const props = await this.deps.readProperties(name)
    const lock = await readLock(dir)
    const levelName = levelNameOf(props)
    const plan = await makePlan({
      row,
      props,
      lock,
      spec,
      levelName,
      exists: async (p) => (await lstat(join(dir, p)).catch(() => null))?.isFile() ?? false,
      unmanaged: (await unmanagedFiles(dir, lock, levelName)).map((u) => u.path),
      otherPorts: db
        .select({
          name: schema.servers.name,
          port: schema.servers.port,
          rconPort: schema.servers.rconPort,
          hostname: schema.servers.hostname,
        })
        .from(schema.servers)
        .all(),
      upgrade,
      modrinth: this.deps.modrinth,
      vanillatweaks: this.deps.vanillatweaks,
      hangar: this.deps.hangar,
      loaders: this.deps.loaders,
      offsiteTargets: this.deps.offsiteTargets?.(),
      tasks: this.deps.tasks?.tasks(name),
      memoryProblem: (memoryMb) => {
        const { jobs } = this.deps
        if (!jobs.memoryUsers || !jobs.totalMemoryMb) return null
        return budgetProblem(jobs.totalMemoryMb(), jobs.memoryUsers(), { name, memoryMb })
      },
      now: () => new Date(this.now()),
    })
    this.sweep()
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex')
    this.plans.set(id, {
      plan,
      fingerprint: await this.fingerprint(name),
      at: this.now(),
      needs,
    })
    return publicPlan(id, plan)
  }

  private sweep() {
    for (const [id, p] of this.plans) if (this.now() - p.at > PLAN_TTL_MS) this.plans.delete(id)
  }

  /** Starts applying a plan made earlier. */
  async apply(name: string, planId: string): Promise<{ jobId: number; done: Promise<JobEvent> }> {
    this.sweep()
    const stored = this.plans.get(planId)
    if (!stored || stored.plan.server !== name) {
      throw new SpecError('That plan has expired. Make a new one.')
    }
    const { plan } = stored
    if (plan.problems.length) throw new SpecError(plan.problems[0]!)
    if ((await this.fingerprint(name)) !== stored.fingerprint) {
      this.plans.delete(planId)
      throw new SpecError('The server changed since this plan was made. Make a new one.')
    }
    this.plans.delete(planId)
    const release = this.deps.backups.lock(name)
    const job = this.deps.jobs.track('server.apply', name, SPEC_STEPS)
    const done = this.run(name, plan, job)
      .then(() => job.succeed(plan.changes.length ? 'Applied.' : 'Nothing needed changing.'))
      .catch((err) => job.fail(err))
      .finally(release)
    return { jobId: job.id, done }
  }

  private async isRunning(name: string) {
    const { active } = await this.deps.agent('service.status', { server: name })
    return active === 'active' || active === 'activating'
  }

  private async stop(name: string) {
    await this.deps.agent('service.stop', { server: name }, { timeoutMs: 180_000 })
    for (let i = 0; i < 180; i++) {
      const { active } = await this.deps.agent('service.status', { server: name })
      if (active === 'inactive' || active === 'failed') {
        this.deps.stopped?.(name)
        return
      }
      await this.sleep(1000)
    }
    throw new SpecError('The server took too long to stop.')
  }

  private async run(name: string, plan: Plan, job: JobTracker) {
    const { work } = plan
    const dir = this.deps.serverDir(name)
    const staging = join(dir, STAGING)
    const wasRunning = await this.isRunning(name)

    job.step(0, `${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`)
    if (plan.backup) {
      job.step(1, 'A safety copy, in case you want to go back')
      await this.deps.backups.snapshot(name, 'Before applying spec changes')
    }

    // Download everything first, so a bad link changes nothing.
    await rm(staging, { recursive: true, force: true })
    // Not recursive, so this fails if anything appeared at the staging path in between.
    await mkdir(staging)
    await mkdir(join(staging, 'new'), { recursive: true })
    await mkdir(join(staging, 'old'), { recursive: true })
    const lock: Lock = structuredClone(work.lock)
    try {
      if (work.server) {
        const s = work.server
        job.step(2, `Java ${s.javaMajor}`)
        await this.deps.agent(
          'runtime.install',
          { vendor: 'temurin', major: s.javaMajor },
          { timeoutMs: 10 * 60_000 },
        )
        job.step(2, `Minecraft ${s.minecraft}`)
        await downloadVerified(this.deps.fetch, s.url, join(staging, 'new', 'server.jar'), s.hash)
      }
      for (const [i, d] of work.downloads.entries()) {
        job.step(2, `${d.title} (${i + 1} of ${work.downloads.length})`)
        const dest = join(staging, 'new', String(i))
        const url = d.request ? await requestDownload(this.deps.fetch, d.request) : d.url
        let { sha256 } = await downloadVerified(this.deps.fetch, url, dest, d.hash)
        if (d.wrapped) sha256 = await unwrap(dest, join(staging, 'unwrap', String(i)))
        const entry = lock.content.find((l) => l.path === d.path)
        if (entry) entry.sha256 = sha256
      }
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      throw err
    }

    const restart = plan.restart && wasRunning
    if (restart) {
      job.step(3)
      await this.stop(name)
    }

    job.step(4)
    const moved: { from: string; to: string }[] = []
    const move = async (from: string, to: string) => {
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
      moved.push({ from, to })
    }
    try {
      await this.deps.agent('server.permissions', { name }, { timeoutMs: 120_000 })
      for (const [i, p] of work.removals.entries()) {
        // resolveInside refuses paths that leave the folder or pass through a link.
        const from = await resolveInside(dir, p)
        if (await lstat(from).catch(() => null)) {
          await move(from, join(staging, 'old', String(i)))
        }
      }
      for (const [i, d] of work.downloads.entries()) {
        await move(join(staging, 'new', String(i)), await resolveInside(dir, d.path))
      }
      if (work.server) {
        await move(join(dir, 'server.jar'), join(staging, 'old', 'server.jar'))
        await move(join(staging, 'new', 'server.jar'), join(dir, 'server.jar'))
      }
      await writeLock(dir, lock)

      job.step(5)
      await this.saveSettings(name, plan)
    } catch (err) {
      // Put every file back where it was, newest move first.
      for (const m of moved.reverse()) await rename(m.to, m.from).catch(() => {})
      await rm(staging, { recursive: true, force: true })
      if (restart) await this.deps.agent('service.start', { server: name }).catch(() => {})
      throw err
    }
    await rm(staging, { recursive: true, force: true })

    if (restart) {
      job.step(6)
      await this.deps.agent('service.start', { server: name })
      await this.deps.jobs.waitActive(name)
    }
  }

  private async saveSettings(name: string, plan: Plan) {
    const { db, agent } = this.deps
    const s = plan.work.settings
    const game = plan.work.server
    const row = this.row(name)
    const javaMajor = game && game.javaMajor !== row.javaMajor ? game.javaMajor : undefined
    if (s.memoryMb !== undefined || s.port !== undefined || javaMajor !== undefined) {
      await agent('server.configure', { name, memoryMb: s.memoryMb, port: s.port, javaMajor })
    }
    const props = { ...s.properties }
    if (s.port !== undefined) props['server-port'] = String(s.port)
    if (Object.keys(props).length) await this.deps.writeProperties(name, props)
    db.update(schema.servers)
      .set({
        ...(s.displayName !== undefined ? { displayName: s.displayName } : {}),
        ...(s.hostname !== undefined ? { hostname: s.hostname } : {}),
        ...(game
          ? {
              loader: game.loader,
              mcVersion: game.minecraft,
              loaderVersion: game.loaderVersion,
              javaMajor: game.javaMajor,
            }
          : {}),
        ...(s.memoryMb !== undefined ? { memoryMb: s.memoryMb } : {}),
        ...(s.port !== undefined ? { port: s.port } : {}),
        ...(s.backups
          ? {
              backupSchedule: s.backups.schedule,
              backupTz: s.backups.timezone,
              keepLast: s.backups.keep.last,
              keepDaily: s.backups.keep.daily,
              keepWeekly: s.backups.keep.weekly,
            }
          : {}),
        ...(s.offsiteTarget !== undefined ? { offsiteTarget: s.offsiteTarget } : {}),
        ...(s.restartWhenUnresponsive !== undefined
          ? { restartWhenUnresponsive: s.restartWhenUnresponsive }
          : {}),
        ...(s.publicPage ? { publicPage: s.publicPage } : {}),
        ...(s.stats ? { stats: s.stats } : {}),
        ...(s.map ? { map: s.map } : {}),
        content: s.content,
      })
      .where(eq(schema.servers.name, name))
      .run()
    if (s.backups) this.deps.schedulesChanged?.()
    if (s.stats) this.deps.statsChanged?.(name, row.stats)
    await this.deps.mapChanged?.(name)
    if (s.schedules || s.timezone !== undefined) {
      const tasks = this.deps.tasks
      tasks?.replace(name, s.schedules ?? tasks.tasks(name), s.timezone)
    }
    if (s.offsiteTarget) this.deps.offsiteChanged?.(name)
    if (s.hostname !== undefined || s.port !== undefined) await this.deps.addressChanged?.(name)
  }
}
