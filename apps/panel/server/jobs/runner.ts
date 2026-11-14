import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { isSecretProperty, type ServerSpec } from '../../shared/spec'
import { ServerName, type Params, type Result, type Verb } from '@flytower/protocol'
import {
  downloadVerified,
  LOADER_IDS,
  ProviderError,
  type Fetch,
  type LoaderId,
  type LoaderProvider,
} from '@flytower/providers'
import { schema, type Db } from '../db'
import { budgetProblem, machineMemoryMb, type MemoryUser } from '../memory'
import {
  CLONE_STEPS,
  CREATE_SERVER_STEPS,
  IMPORT_STEPS,
  type JobEvent,
} from '../../shared/utils/jobs'
import { moveBack, moveIn, type ImportSource } from '../imports/move'
import { parseProperties, setProperties, stringifyProperties, toRecord } from '../properties'
import { Bus } from './bus'
import { defaultProperties, EULA, randomPassword, randomSecret } from './properties'

export type AgentCall = <V extends Verb>(
  verb: V,
  params: Params<V>,
  opts?: { timeoutMs?: number },
) => Promise<Result<V>>

export const CreateServerInput = z.object({
  name: ServerName,
  displayName: z.string().trim().min(1).max(60),
  loader: z.enum(LOADER_IDS),
  mcVersion: z.string().min(1).max(40),
  loaderVersion: z.string().min(1).max(40).default('latest-stable'),
  memoryMb: z.number().int().min(1024).max(65536),
  port: z.number().int().min(1024).max(65535).optional(),
  acceptEula: z.literal(true, { error: 'You need to accept the Minecraft EULA.' }),
})
export type CreateServerInput = z.input<typeof CreateServerInput>

/** The parts of a spec the create form doesn't cover, for servers made from YAML. */
/** A source made while the job runs (a clone's copy), and thrown away after. */
export interface PreparedSource {
  prepare: () => Promise<ImportSource>
  discard: () => Promise<void>
}

export interface SpecExtras {
  properties?: Record<string, string>
  backups?: ServerSpec['backups']
  content?: ServerSpec['content']
  hostname?: string | null
  recovery?: ServerSpec['recovery']
  publicPage?: ServerSpec['public']
  stats?: ServerSpec['stats']
  map?: ServerSpec['map']
}

export interface RunnerDeps {
  db: Db
  agent: AgentCall
  loaders: Record<LoaderId, LoaderProvider>
  fetch: Fetch
  bus?: Bus
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for systemd to report the server active. */
  startTimeoutMs?: number
  /** The machine's memory, for the budget. */
  totalMemoryMb?: () => number
  /** The hostname router (#76): its port is never given to a server, and new servers join it. */
  routing?: { reservedPorts(): number[]; serverChanged(name: string): Promise<void> }
}

export const STEPS = CREATE_SERVER_STEPS
export type { JobEvent }

const GAME_PORT_BASE = 25565
const RCON_PORT_BASE = 25575

export class JobError extends Error {
  override name = 'JobError'
}

/** Picks the lowest port at or above `base` that nothing else uses. */
export function lowestFree(base: number, used: Set<number>): number {
  let p = base
  while (used.has(p)) p++
  if (p > 65535) throw new JobError('No free ports left.')
  return p
}

/**
 * Runs long operations as jobs: each step is written to the `jobs` table and published on
 * the bus as `job:<id>`, so a browser can follow live or reload and catch up.
 */
export class JobRunner {
  readonly bus: Bus
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  /** Names and ports held by jobs still running, so two wizards can't race for them. */
  private reservedNames = new Set<string>()
  private reservedPorts = new Set<number>()
  /** Heap promised to creates still running, by name. */
  private reservedMemory = new Map<string, number>()

  constructor(private deps: RunnerDeps) {
    this.bus = deps.bus ?? new Bus()
    this.now = deps.now ?? (() => new Date())
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms))
  }

  /** At boot nothing can be running, so anything left `queued` or `running` was cut off. */
  recover(): number {
    const cut = this.deps.db
      .update(schema.jobs)
      .set({
        state: 'failed',
        message: 'The panel restarted during this job. Check the server and try again.',
        finishedAt: this.now(),
      })
      .where(inArray(schema.jobs.state, ['queued', 'running']))
      .returning({ id: schema.jobs.id })
      .all()
    return cut.length
  }

  get(id: number): JobEvent | null {
    const row = this.deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get()
    return row ? toEvent(row) : null
  }

  /**
   * Validates synchronously enough to refuse obvious mistakes with a 400, then returns the
   * job id while the work carries on in the background. `done` resolves when it finishes.
   */
  createServer(
    raw: CreateServerInput,
    source?: ImportSource | PreparedSource,
    extras: SpecExtras = {},
  ): { jobId: number; done: Promise<JobEvent> } {
    const input = CreateServerInput.parse(raw)
    const { port, rconPort } = this.claim(input.name, input.port, input.memoryMb)
    if (extras.hostname) {
      const taken = this.deps.db
        .select({ name: schema.servers.name })
        .from(schema.servers)
        .where(eq(schema.servers.hostname, extras.hostname))
        .get()
      if (taken) {
        this.release(input.name, port, rconPort)
        throw new JobError(`${extras.hostname} is already ${taken.name}'s address.`)
      }
    }
    const job = this.deps.db
      .insert(schema.jobs)
      .values({
        kind: !source ? 'server.create' : 'prepare' in source ? 'server.clone' : 'server.import',
        server: input.name,
        state: 'queued',
      })
      .returning()
      .get()

    const done = this.execute(job.id, input, port, rconPort, source, extras).finally(() =>
      this.release(input.name, port, rconPort),
    )
    return { jobId: job.id, done }
  }

  private release(name: string, port: number, rconPort: number) {
    this.reservedNames.delete(name)
    this.reservedMemory.delete(name)
    this.reservedPorts.delete(port)
    this.reservedPorts.delete(rconPort)
  }

  /** Every server's memory, counting creates still running. */
  memoryUsers(): MemoryUser[] {
    const rows = this.deps.db
      .select({
        name: schema.servers.name,
        displayName: schema.servers.displayName,
        memoryMb: schema.servers.memoryMb,
      })
      .from(schema.servers)
      .all()
    const pending = [...this.reservedMemory].map(([name, memoryMb]) => ({
      name,
      displayName: name,
      memoryMb,
    }))
    return [...rows, ...pending]
  }

  /** The machine's memory in MB. */
  totalMemoryMb(): number {
    return (this.deps.totalMemoryMb ?? machineMemoryMb)()
  }

  private claim(name: string, requested: number | undefined, memoryMb: number) {
    const rows = this.deps.db
      .select({
        name: schema.servers.name,
        port: schema.servers.port,
        rcon: schema.servers.rconPort,
      })
      .from(schema.servers)
      .all()
    if (rows.some((r) => r.name === name) || this.reservedNames.has(name)) {
      throw new JobError(`There's already a server called ${name}.`)
    }
    const tooBig = budgetProblem(this.totalMemoryMb(), this.memoryUsers(), { name, memoryMb })
    if (tooBig) throw new JobError(tooBig)
    const used = new Set([
      ...this.reservedPorts,
      ...(this.deps.routing?.reservedPorts() ?? []),
      ...rows.flatMap((r) => [r.port, r.rcon]),
    ])
    if (requested !== undefined && used.has(requested)) {
      throw new JobError(`Port ${requested} is already used by another server.`)
    }
    const port = requested ?? lowestFree(GAME_PORT_BASE, used)
    used.add(port)
    const rconPort = lowestFree(RCON_PORT_BASE, used)
    this.reservedNames.add(name)
    this.reservedMemory.set(name, memoryMb)
    this.reservedPorts.add(port).add(rconPort)
    return { port, rconPort }
  }

  private update(id: number, patch: Partial<Omit<JobEvent, 'id'>>): JobEvent {
    const finished = patch.state === 'succeeded' || patch.state === 'failed'
    const row = this.deps.db
      .update(schema.jobs)
      .set({ ...patch, ...(finished ? { finishedAt: this.now() } : {}) })
      .where(eq(schema.jobs.id, id))
      .returning()
      .get()
    const event = toEvent(row!)
    this.bus.publish(`job:${id}`, event)
    // Every finished job, for things that follow up on any of them (like disk use).
    if (finished) {
      this.bus.publish('jobs:finished', { ...event, kind: row!.kind, server: row!.server })
    }
    return event
  }

  private stepper(id: number, steps: readonly string[]) {
    return (
      label: (typeof IMPORT_STEPS)[number] | (typeof CLONE_STEPS)[number],
      message: string | null = null,
    ) => {
      const index = steps.indexOf(label)
      this.update(id, {
        state: 'running',
        step: label,
        progress: Math.round((index / steps.length) * 100),
        message,
      })
    }
  }

  private async execute(
    id: number,
    input: z.output<typeof CreateServerInput>,
    port: number,
    rconPort: number,
    given?: ImportSource | PreparedSource,
    extras: SpecExtras = {},
  ): Promise<JobEvent> {
    const { agent, loaders, db } = this.deps
    const prepared = given && 'prepare' in given ? given : undefined
    let source = prepared ? undefined : (given as ImportSource | undefined)
    const step = this.stepper(id, prepared ? CLONE_STEPS : source ? IMPORT_STEPS : STEPS)
    let created = false
    let moved: string[] = []
    let dir = ''
    try {
      step('Checking the details')
      const loader = loaders[input.loader]

      if (prepared) {
        step('Copying the server')
        source = await prepared.prepare()
      }

      step('Finding the download', `${loader.name} ${input.mcVersion}`)
      const resolved = await loader.resolve(input.mcVersion, input.loaderVersion)

      step('Installing Java', `Java ${resolved.javaMajor}`)
      await agent(
        'runtime.install',
        { vendor: 'temurin', major: resolved.javaMajor },
        { timeoutMs: 10 * 60_000 },
      )

      step('Creating the server')
      const made = await agent('server.create', {
        name: input.name,
        port,
        memoryMb: input.memoryMb,
        javaMajor: resolved.javaMajor,
      })
      created = true
      dir = made.directory

      // The jar is always fresh from the trusted source; an uploaded jar is never run.
      step('Downloading Minecraft', resolved.url)
      const part = join(dir, 'server.jar.part')
      await downloadVerified(this.deps.fetch, resolved.url, part, resolved.hash)
      await rename(part, join(dir, 'server.jar'))

      if (source) {
        step('Moving files in')
        moved = await moveIn(source, dir)
        await agent('server.permissions', { name: input.name }, { timeoutMs: 120_000 })
      }

      step('Writing the config')
      const acceptedAt = this.now()
      const rconPassword = randomPassword()
      const managed = {
        'server-port': String(port),
        'enable-rcon': 'true',
        'rcon.port': String(rconPort),
        'rcon.password': rconPassword,
      }
      const existing = source
        ? await readFile(join(dir, 'server.properties'), 'utf8').catch(() => null)
        : null
      // A clone gets its own secrets (such as the management server's), never a copy of the
      // original's. An import keeps them, since it's the same server moving in.
      const doc = existing !== null ? parseProperties(existing) : null
      const fresh: Record<string, string> = {}
      if (doc && prepared) {
        for (const key of Object.keys(toRecord(doc))) {
          if (isSecretProperty(key) && !(key in managed)) fresh[key] = randomSecret()
        }
      }
      let properties = doc
        ? stringifyProperties(setProperties(doc, { ...managed, ...fresh }))
        : defaultProperties({ port, rconPort, rconPassword, motd: input.displayName })
      if (extras.properties && Object.keys(extras.properties).length) {
        properties = stringifyProperties(
          setProperties(parseProperties(properties), extras.properties),
        )
      }
      // Group-writable, whatever the panel's umask, so the server (same group) can edit them.
      const files: [string, string][] = [
        ['eula.txt', EULA(acceptedAt)],
        ['server.properties', properties],
      ]
      for (const [file, body] of files) {
        await writeFile(join(dir, file), body)
        await chmod(join(dir, file), 0o660)
      }
      db.insert(schema.servers)
        .values({
          name: input.name,
          displayName: input.displayName,
          loader: input.loader,
          mcVersion: input.mcVersion,
          loaderVersion: resolved.loaderVersion,
          javaMajor: resolved.javaMajor,
          memoryMb: input.memoryMb,
          port,
          rconPort,
          rconPassword,
          eulaAcceptedAt: acceptedAt,
          ...(extras.backups
            ? {
                backupSchedule: extras.backups.schedule,
                backupTz: extras.backups.timezone,
                keepLast: extras.backups.keep.last,
                keepDaily: extras.backups.keep.daily,
                keepWeekly: extras.backups.keep.weekly,
              }
            : {}),
          content: extras.content ?? [],
          hostname: extras.hostname ?? null,
          restartWhenUnresponsive: extras.recovery?.restartWhenUnresponsive ?? false,
          publicPage: extras.publicPage ?? null,
          stats: extras.stats ?? null,
          map: extras.map ?? null,
        })
        .run()
      // With routing on, a server with a hostname listens on 127.0.0.1 behind the router.
      await this.deps.routing?.serverChanged(input.name)

      step('Starting the server')
      await agent('service.start', { server: input.name })
      await this.waitActive(input.name)

      return this.update(id, {
        state: 'succeeded',
        step: 'Done',
        progress: 100,
        message: `${input.displayName} is running on port ${port}.`,
      })
    } catch (err) {
      const message = friendly(err)
      if (source && moved.length) {
        // Give the files back to the staging folder so the import can be tried again.
        await moveBack(source, dir, moved).catch((e) =>
          console.error('[flytower] moving imported files back failed', e),
        )
      }
      if (created) await this.rollback(input.name, message)
      return this.update(id, { state: 'failed', message })
    } finally {
      if (prepared) {
        await prepared
          .discard()
          .catch((e) => console.error('[flytower] removing the clone copy failed', e))
      }
    }
  }

  /**
   * A job run by something else (a backup, a restore): same table, same bus, so the same
   * progress UI and reload-and-catch-up work for it.
   */
  track(kind: string, server: string | null, steps: readonly string[]): JobTracker {
    const job = this.deps.db
      .insert(schema.jobs)
      .values({ kind, server, state: 'queued' })
      .returning()
      .get()
    return {
      id: job.id,
      step: (index, message = null) =>
        this.update(job.id, {
          state: 'running',
          step: steps[index]!,
          progress: Math.round((index / steps.length) * 100),
          message,
        }),
      succeed: (message) =>
        this.update(job.id, { state: 'succeeded', step: 'Done', progress: 100, message }),
      fail: (err) => this.update(job.id, { state: 'failed', message: friendly(err) }),
    }
  }

  /** Waits for a server's unit to be active, failing if it crashes or takes too long. */
  async waitActive(name: string) {
    const deadline = Date.now() + (this.deps.startTimeoutMs ?? 60_000)
    for (;;) {
      const { active } = await this.deps.agent('service.status', { server: name })
      if (active === 'active') return
      if (active === 'failed') throw new JobError('The server failed to start. Check its log.')
      if (Date.now() > deadline) throw new JobError('The server took too long to start.')
      await this.sleep(1000)
    }
  }

  /** Undoes a half-made server so the same name can be tried again. */
  private async rollback(name: string, reason: string) {
    this.deps.db.delete(schema.servers).where(eq(schema.servers.name, name)).run()
    try {
      await this.deps.agent('server.delete', { name })
    } catch (err) {
      console.error(`[flytower] rollback of ${name} after "${reason}" failed`, err)
    }
  }
}

export interface JobTracker {
  id: number
  step(index: number, message?: string | null): JobEvent
  succeed(message: string | null): JobEvent
  fail(err: unknown): JobEvent
}

export function friendly(err: unknown): string {
  if (err instanceof ProviderError || err instanceof JobError) return err.message
  if (err instanceof Error && err.name === 'AgentError')
    return `The system helper said: ${err.message}`
  console.error('[flytower] job failed', err)
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function toEvent(row: typeof schema.jobs.$inferSelect): JobEvent {
  return {
    id: row.id,
    state: row.state,
    step: row.step,
    progress: row.progress,
    message: row.message,
  }
}
