/**
 * A stand-in agent for working on the panel without root or systemd. It answers every verb
 * from memory: services take two seconds to start or stop, Java "installs" instantly, and
 * server folders are made under the dev data directory. Started servers write a log and
 * answer RCON (see minecraft.ts). Never shipped: boxes run the Rust agent in
 * `crates/flytower-agent`.
 *
 *   bun run --filter @flytower/dev-agent dev
 */
import type { Result } from '@flytower/protocol'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { unitName, userName } from '@flytower/protocol'
import { protocolInfo, type AgentContext, type Handlers } from './dispatch.ts'
import { serverUsage } from './disk.ts'
import { UnitEvents } from './events.ts'
import { startFakeMinecraft } from './minecraft.ts'
import { listen } from './socket.ts'

type State = 'active' | 'inactive' | 'activating' | 'deactivating' | 'failed'

const root = resolve(process.env.FLYTOWER_DEV_DIR ?? '../../apps/panel/.data')
const socketPath = process.env.FLYTOWER_AGENT_SOCKET ?? join(root, 'agent.sock')
const serversDir = join(root, 'servers')
const states = new Map<string, State>()
const TRANSITION_MS = 2000

// What journalctl would say: a line per change, so service.wait works as it does for real.
let journal: (line: string) => void = () => {}
const unitEvents = new UnitEvents((onLine) => {
  journal = onLine
  return { stop: () => {}, exited: new Promise(() => {}) }
})
unitEvents.start()
function setState(server: string, state: State) {
  states.set(server, state)
  journal(JSON.stringify({ UNIT: `flytower-mc@${server}.service` }))
}

const fakeCpu = new Map<string, number>()

/** How each server's last run ended and its start history, as systemd would keep them. */
interface Run {
  result: string
  restarts: number
  exitKind: 'exited' | 'killed' | null
  exitStatus: number | null
  starts: number[]
}
const runs = new Map<string, Run>()
const RESTART_MS = 15_000
const run = (server: string): Run => {
  let r = runs.get(server)
  if (!r) {
    r = { result: 'success', restarts: 0, exitKind: null, exitStatus: null, starts: [] }
    runs.set(server, r)
  }
  return r
}
/** An explicit start: like reset-failed then start, it clears the counters. */
const freshStart = (server: string) =>
  runs.set(server, {
    result: 'success',
    restarts: 0,
    exitKind: null,
    exitStatus: null,
    starts: [Date.now()],
  })

/** Restart=on-failure, RestartSec=15, StartLimitBurst=3 in StartLimitIntervalSec=600. */
function crashed(server: string, oom: boolean) {
  void halt(server)
  const r = run(server)
  Object.assign(
    r,
    oom
      ? { result: 'oom-kill', exitKind: 'killed', exitStatus: 9 }
      : { result: 'exit-code', exitKind: 'exited', exitStatus: 1 },
  )
  setState(server, 'activating')
  setTimeout(() => {
    if (states.get(server) !== 'activating') return
    const now = Date.now()
    r.starts = r.starts.filter((t) => now - t < 600_000)
    if (r.starts.length >= 3) {
      r.result = 'start-limit-hit'
      setState(server, 'failed')
      return
    }
    r.starts.push(now)
    r.restarts++
    r.result = 'success'
    setState(server, 'active')
    void boot(server)
  }, RESTART_MS)
}
const running = new Map<string, Awaited<ReturnType<typeof startFakeMinecraft>>>()

function move(server: string, via: State, to: State) {
  setState(server, via)
  setTimeout(() => setState(server, to), TRANSITION_MS)
}

async function boot(server: string) {
  await running.get(server)?.stop()
  running.set(
    server,
    await startFakeMinecraft(join(serversDir, server), {
      onCrash: (oom) => crashed(server, oom),
    }),
  )
}

async function halt(server: string) {
  await running.get(server)?.stop()
  running.delete(server)
}

// Pretend SSH firewall state.
const ssh: { open: boolean; closesAt: Date | null; timer?: ReturnType<typeof setTimeout> } = {
  open: true,
  closesAt: null,
}
const sshState = () => ({
  open: ssh.open,
  ports: [22],
  closesAt: ssh.closesAt?.toISOString() ?? null,
  firewall: true,
})

// Pretend releases: installing "succeeds" after a moment without changing anything.
let lastUpdate: Result<'update.status'>['last'] = null
const fakeUpdate = (to: string, manual: boolean) => {
  const at = new Date().toISOString()
  lastUpdate = { state: 'running', from: '0.0.0-dev', to, reason: null, at, manual }
  setTimeout(() => {
    lastUpdate = { ...lastUpdate!, state: 'rolled-back', reason: 'the dev agent only pretends' }
  }, 3000)
  return { started: true as const }
}

// Pretend system folders, so System, Disk has something to split up and clean.
const MB = 1024 * 1024
const fakeSystem = { java: 190 * MB, flytower: 240 * MB, logs: 610 * MB, temp: 85 * MB }
const fakeFree = { journal: 520 * MB, aptCache: 70 * MB, oldReleases: 110 * MB }

const handlers: Handlers = {
  ping: async (_p, ctx) => protocolInfo(ctx.version),
  'agent.hello': async (_p, ctx) => ({
    kind: 'bun',
    version: ctx.version,
    protocols: [1],
    subscriptions: [],
  }),
  'update.status': async () => ({
    current: '0.0.0-dev',
    releases: ['0.0.0-dev'],
    last: lastUpdate,
  }),
  'update.install': async ({ version }) => fakeUpdate(version, false),
  'update.rollback': async ({ version }) => fakeUpdate(version, true),
  'service.status': async ({ server }) => {
    const r = run(server)
    return {
      active: states.get(server) ?? 'inactive',
      since: null,
      result: r.result,
      restarts: r.restarts,
      exitKind: r.exitKind,
      exitStatus: r.exitStatus,
    }
  },
  'service.wait': async ({ servers, after, timeoutMs }) =>
    unitEvents.wait(servers, after, timeoutMs),
  'service.usage': async ({ servers }) => {
    const usage: Result<'service.usage'>['usage'] = {}
    for (const server of servers) {
      const active = states.get(server) === 'active'
      // Somewhere between a tenth of a core and a core and a half, and 1.5 to 3 GB.
      const cpu = (fakeCpu.get(server) ?? 0) + (0.1 + Math.random() * 1.4) * 60e9
      if (active) fakeCpu.set(server, cpu)
      usage[server] = {
        active,
        cpuNs: active ? cpu : null,
        memoryBytes: active ? Math.round((1.5 + Math.random() * 1.5) * 2 ** 30) : null,
      }
    }
    return { usage }
  },
  // The router and firewall do nothing here; the panel talks to a real router if one runs.
  'server.expose': async () => ({}),
  'router.enable': async () => ({}),
  'router.disable': async () => ({}),
  'service.start': async ({ server }) => {
    freshStart(server)
    move(server, 'activating', 'active')
    void boot(server)
    return {}
  },
  'service.stop': async ({ server }) => {
    move(server, 'deactivating', 'inactive')
    void halt(server)
    return {}
  },
  'service.restart': async ({ server }) => {
    freshStart(server)
    move(server, 'activating', 'active')
    void halt(server).then(() => boot(server))
    return {}
  },
  'runtime.install': async ({ major }) => ({
    javaHome: `/opt/flytower/runtimes/temurin-${major}`,
    version: `${major}.0.0`,
    alreadyInstalled: true,
  }),
  'server.create': async ({ name }) => {
    const directory = join(serversDir, name)
    await mkdir(directory, { recursive: true })
    setState(name, 'inactive')
    return { directory, user: userName(name), unit: unitName(name) }
  },
  'server.configure': async () => ({}),
  'server.permissions': async () => ({}),
  'ssh.status': async () => sshState(),
  'ssh.set': async (p: { open: boolean; minutes?: number }) => {
    clearTimeout(ssh.timer)
    ssh.open = p.open
    ssh.closesAt = p.open && p.minutes ? new Date(Date.now() + p.minutes * 60_000) : null
    if (ssh.closesAt) {
      ssh.timer = setTimeout(() => ((ssh.open = false), (ssh.closesAt = null)), p.minutes! * 60_000)
    }
    return sshState()
  },
  // Server folders are measured for real under the dev data folder; the rest is pretend.
  'disk.usage': async (p) => {
    const servers = await serverUsage(root, p.servers)
    if (!p.system) return { servers, shared: null, system: null }
    return {
      servers,
      shared: { imports: 0, archive: 0, unreadable: 0 },
      system: { ...fakeSystem, unreadable: 0, ...fakeFree },
    }
  },
  'disk.vacuum-journal': async ({ maxMb }) => {
    const freed = Math.max(0, fakeFree.journal - maxMb * MB)
    fakeFree.journal -= freed
    fakeSystem.logs -= freed
    return { freedBytes: freed }
  },
  'disk.clean-apt': async () => {
    const freed = fakeFree.aptCache
    fakeFree.aptCache = 0
    fakeSystem.temp -= freed
    return { freedBytes: freed }
  },
  'disk.prune-flytower': async () => {
    const freed = fakeFree.oldReleases
    fakeFree.oldReleases = 0
    fakeSystem.flytower -= freed
    return { freedBytes: freed, removed: freed ? ['0.0.0-dev-old'] : [] }
  },
  'server.delete': async ({ name }) => {
    await rm(join(serversDir, name), { recursive: true, force: true })
    states.delete(name)
    return { archivedTo: null }
  },
}

const ctx: AgentContext = {
  version: '0.0.0-dev-fake',
  log: (e) => console.log(JSON.stringify(e)),
}

await mkdir(root, { recursive: true })
listen(socketPath, handlers, ctx)
console.log(`fake agent listening on ${socketPath}`)
