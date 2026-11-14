import { z } from 'zod'
import { ServerName } from './names.ts'

const Port = z.number().int().min(1024).max(65535)

/**
 * Every operation the agent will perform. The agent refuses anything not listed here,
 * so this list is the whole of the panel's root access.
 */
const SshState = z.object({
  /** True if any firewall rule lets SSH in. */
  open: z.boolean(),
  ports: z.array(z.number().int()),
  /** When a temporary opening ends, as an ISO time. */
  closesAt: z.string().nullable(),
  /** False if ufw is inactive, in which case nothing can be closed. */
  firewall: z.boolean(),
})

const Version = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 'not a release version')

export const UpdateRecord = z.object({
  state: z.enum(['running', 'succeeded', 'rolled-back', 'failed']),
  from: z.string(),
  to: z.string(),
  /** Why it rolled back or failed. */
  reason: z.string().nullable(),
  at: z.string(),
  manual: z.boolean(),
})

/** Bytes in each part of a server's space, matching the panel's groups. */
const ServerDiskGroups = z.object({
  world: z.number().int().min(0),
  logs: z.number().int().min(0),
  content: z.number().int().min(0),
  map: z.number().int().min(0),
  backups: z.number().int().min(0),
  exports: z.number().int().min(0),
  other: z.number().int().min(0),
})

const Bytes = z.number().int().min(0)

/** A server's state, as `service.status` gives it and `service.events` sends it. */
const ServiceStatus = z.object({
  active: z.enum(['active', 'inactive', 'activating', 'deactivating', 'failed', 'unknown']),
  since: z.string().nullable(),
  /**
   * How the last run ended, as systemd's `Result`: `success`, `exit-code`, `signal`,
   * `core-dump`, `oom-kill`, `timeout`, `watchdog` or `start-limit-hit`. Optional because
   * agents before 1.1 don't send it, nor the fields below.
   */
  result: z.string().nullable().optional(),
  /** Automatic restarts since the last explicit start (`NRestarts`). */
  restarts: z.number().int().nullable().optional(),
  /** How the main process last ended: by exiting, by a signal, or by a signal with a core dump. */
  exitKind: z.enum(['exited', 'killed', 'dumped']).nullable().optional(),
  /** The exit code, or the signal number when it was killed. */
  exitStatus: z.number().int().nullable().optional(),
})

export const verbs = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ agentVersion: z.string(), protocol: z.number().int() }),
  },
  /**
   * Which agent is running and what it can do. The panel asks once per connection to the
   * agent; an agent that doesn't know this verb speaks protocol 1 only.
   */
  'agent.hello': {
    params: z.object({}).strict(),
    result: z.object({
      kind: z.enum(['rust', 'bun']),
      version: z.string(),
      protocols: z.array(z.number().int()),
      /** The subscription verbs this agent will start. */
      subscriptions: z.array(z.string()),
    }),
  },
  'service.status': {
    params: z.object({ server: ServerName }).strict(),
    result: ServiceStatus,
  },
  /** CPU time and memory systemd has counted for each server, for the metrics history. */
  'service.usage': {
    params: z.object({ servers: z.array(ServerName).max(100) }).strict(),
    result: z.object({
      usage: z.record(
        z.string(),
        z.object({
          active: z.boolean(),
          /** Total CPU time used since the server started, in nanoseconds. */
          cpuNs: z.number().nullable(),
          memoryBytes: z.number().nullable(),
        }),
      ),
    }),
  },
  /**
   * Waits until a server changes state (systemd's journal says so), or `timeoutMs` passes, so
   * the panel hears about crashes without polling. Pass back `cursor` as `after`. `servers`
   * is what comes back as changed when the agent can't tell, such as on the first call.
   * `following` is false when the agent can't follow the journal; then poll instead.
   */
  'service.wait': {
    params: z
      .object({
        servers: z.array(ServerName).max(100),
        after: z.string().max(64).nullable(),
        timeoutMs: z.number().int().min(1000).max(300_000),
      })
      .strict(),
    result: z.object({
      cursor: z.string(),
      changed: z.array(z.string()),
      following: z.boolean(),
    }),
  },
  'service.start': { params: z.object({ server: ServerName }).strict(), result: z.object({}) },
  'service.stop': { params: z.object({ server: ServerName }).strict(), result: z.object({}) },
  'service.restart': { params: z.object({ server: ServerName }).strict(), result: z.object({}) },
  'runtime.install': {
    params: z
      .object({ vendor: z.literal('temurin'), major: z.number().int().min(8).max(99) })
      .strict(),
    result: z.object({ javaHome: z.string(), version: z.string(), alreadyInstalled: z.boolean() }),
  },
  'server.create': {
    params: z
      .object({
        name: ServerName,
        port: Port,
        memoryMb: z.number().int().min(512).max(262144),
        javaMajor: z.number().int().min(8).max(99),
      })
      .strict(),
    result: z.object({ directory: z.string(), user: z.string(), unit: z.string() }),
  },
  'server.configure': {
    params: z
      .object({
        name: ServerName,
        memoryMb: z.number().int().min(512).max(262144).optional(),
        port: Port.optional(),
        /** Switches the server to another installed Java (runtime.install first). */
        javaMajor: z.number().int().min(8).max(99).optional(),
      })
      .strict()
      .refine(
        (p) => p.memoryMb !== undefined || p.port !== undefined || p.javaMajor !== undefined,
        'nothing to change',
      ),
    result: z.object({}),
  },
  /**
   * Gives the panel's group read and write on everything in a server folder. Minecraft
   * writes some files (level.dat) through 0600 temporary files, which the panel then can't
   * back up or edit.
   */
  'server.permissions': {
    params: z.object({ name: ServerName }).strict(),
    result: z.object({}),
  },
  'ssh.status': { params: z.object({}).strict(), result: SshState },
  /**
   * Opens or closes SSH in the firewall. `minutes` opens it for that long; the agent closes
   * it again itself, even across restarts.
   */
  'ssh.set': {
    params: z
      .object({ open: z.boolean(), minutes: z.number().int().min(1).max(1440).optional() })
      .strict()
      .refine((p) => p.open || p.minutes === undefined, 'minutes only applies when opening'),
    result: SshState,
  },
  /** Installed Flytower releases and the last update. */
  'update.status': {
    params: z.object({}).strict(),
    result: z.object({
      current: z.string(),
      releases: z.array(z.string()),
      last: UpdateRecord.nullable(),
    }),
  },
  /**
   * Downloads a release from Flytower's own GitHub releases (never another address), checks
   * its signature and hash, and hands over to the updater, which restarts the panel and
   * agent and rolls back by itself if the new version isn't healthy.
   */
  'update.install': {
    params: z.object({ version: Version }).strict(),
    result: z.object({ started: z.literal(true) }),
  },
  /** Switches back to another release already installed, through the same updater. */
  'update.rollback': {
    params: z.object({ version: Version }).strict(),
    result: z.object({ started: z.literal(true) }),
  },
  'server.delete': {
    params: z.object({ name: ServerName }).strict(),
    result: z.object({ archivedTo: z.string().nullable() }),
  },
  /**
   * Where the disk has gone, measured as root from a fixed list of places: each server named
   * (its folder by group, its backups, exports and web map) and, with `system`, the shared
   * imports and archive and the rest of the machine. Never takes a path. Only places on the
   * same filesystem as the servers count.
   */
  'disk.usage': {
    params: z.object({ servers: z.array(ServerName).max(100), system: z.boolean() }).strict(),
    result: z.object({
      servers: z.record(z.string(), z.object({ groups: ServerDiskGroups, unreadable: Bytes })),
      shared: z.object({ imports: Bytes, archive: Bytes, unreadable: Bytes }).nullable(),
      system: z
        .object({
          /** Java runtimes Flytower installed. */
          java: Bytes,
          /** Flytower's releases, config and data, other than what belongs to servers. */
          flytower: Bytes,
          /** The systemd journal and /var/log. */
          logs: Bytes,
          /** The apt cache, /tmp and /var/tmp. */
          temp: Bytes,
          unreadable: Bytes,
          /** What the clean-up verbs could free: the journal, apt's cache, old releases. */
          journal: Bytes,
          aptCache: Bytes,
          oldReleases: Bytes,
        })
        .nullable(),
    }),
  },
  /** Shrinks the systemd journal to at most `maxMb`. */
  'disk.vacuum-journal': {
    params: z.object({ maxMb: z.number().int().min(16).max(100_000) }).strict(),
    result: z.object({ freedBytes: Bytes }),
  },
  /** Empties apt's download cache (`apt-get clean`). */
  'disk.clean-apt': {
    params: z.object({}).strict(),
    result: z.object({ freedBytes: Bytes }),
  },
  /**
   * Removes Flytower releases other than the running one and the one to go back to, with
   * their leftover downloads and database copies.
   */
  'disk.prune-flytower': {
    params: z.object({}).strict(),
    result: z.object({ freedBytes: Bytes, removed: z.array(z.string()) }),
  },
  /**
   * Opens or closes a server's own port in the firewall. A server reached through the
   * hostname router has no public port of its own.
   */
  'server.expose': {
    params: z.object({ name: ServerName, port: Port, public: z.boolean() }).strict(),
    result: z.object({}),
  },
  /**
   * Starts the hostname router (flytower-router) from the current release, listening on
   * `port`, and opens that port in the firewall. Rust agent only.
   */
  'router.enable': {
    params: z.object({ port: Port }).strict(),
    result: z.object({}),
  },
  /** Stops the hostname router and closes its port. Its kept routes stay on disk. */
  'router.disable': {
    params: z.object({}).strict(),
    result: z.object({}),
  },
} as const

export type Verb = keyof typeof verbs
export type Params<V extends Verb> = z.infer<(typeof verbs)[V]['params']>
export type Result<V extends Verb> = z.infer<(typeof verbs)[V]['result']>
export const verbNames = Object.keys(verbs) as Verb[]

/**
 * Every subscription the agent offers (protocol 2): `params` opens one, `result` is the answer
 * to the subscribe, and each `event` frame carries an `event`. Like `verbs`, this list is the
 * whole of what the panel can follow. `agent.hello` says which ones a running agent offers.
 */
const LogLines = z.array(z.string()).min(1)

export const subscriptions = {
  /**
   * A server's `logs/latest.log`, line by line, through inotify. First the last `seedBytes`
   * of it as `seed` events (whole lines only), then each new batch of lines as a `lines`
   * event. Follows Minecraft rotating the log and a server that hasn't made one yet. A line
   * over 64 KB is cut. With `crashes`, each new file in `crash-reports/` comes as a `crash`
   * event with its path in the server's folder. Ends (`finished`) if the server is deleted.
   */
  'log.follow': {
    params: z
      .object({
        server: ServerName,
        seedBytes: z.number().int().min(0).max(1_048_576),
        crashes: z.boolean().optional(),
      })
      .strict(),
    result: z.object({}),
    event: z.union([
      z.object({ seed: LogLines }).strict(),
      z.object({ lines: LogLines }).strict(),
      z.object({ crash: z.string() }).strict(),
    ]),
  },
  /**
   * Each server's state, then `{server, status}` whenever one changes, from systemd's
   * journal (no polling). A burst of changes settles for a moment and each server is sent
   * once, only if its state really changed. To change which servers, cancel and subscribe
   * again. Offered only when the agent can follow the journal; otherwise use `service.wait`.
   */
  'service.events': {
    params: z.object({ servers: z.array(ServerName).max(100) }).strict(),
    result: z.object({ states: z.record(z.string(), ServiceStatus) }),
    event: z.object({ server: ServerName, status: ServiceStatus }),
  },
  /** Counts from 1 to `count`. Only test builds of the Rust agent offer it. */
  'testing.ticks': {
    params: z
      .object({
        count: z.number().int().min(1).max(100_000),
        intervalMs: z.number().int().min(0).max(60_000),
      })
      .strict(),
    result: z.object({}),
    event: z.object({ n: z.number().int().min(1) }),
  },
} as const

export type Subscription = keyof typeof subscriptions
export type SubParams<S extends Subscription> = z.infer<(typeof subscriptions)[S]['params']>
export type SubResult<S extends Subscription> = z.infer<(typeof subscriptions)[S]['result']>
export type SubEvent<S extends Subscription> = z.infer<(typeof subscriptions)[S]['event']>
export const subscriptionNames = Object.keys(subscriptions) as Subscription[]
