/**
 * Turns "One address for every server" on and off, and keeps the hostname router's routes in
 * step with the panel (#76). The agent starts the router and changes the firewall; the panel
 * talks to the router itself over its control socket and sends it the whole table whenever
 * something changes, so the two can't drift apart.
 */
import { eq } from 'drizzle-orm'
import type { RouterParams, RouterResult } from '@flytower/protocol/client'
import type { RouterMessages, RouterVerb } from '@flytower/protocol'
import { schema, type Db } from '../db'
import { lowestFree, type AgentCall } from '../jobs/runner'
import type { StatusMap } from '../jobs/status'
import { getSetting, setSetting } from '../settings'
import { BanWatcher, prepareServer, readIpBans, readsProxyHeaders, type Loader } from './files'
import {
  defaultRouterSettings,
  isRouted,
  routeTable,
  type RouteExtras,
  type RouterSettings,
} from './table'

export type RouterCall = <V extends RouterVerb>(
  verb: V,
  params: RouterParams<V>,
) => Promise<RouterResult<V>>

export interface RoutingDeps {
  db: Db
  agent: AgentCall
  router: RouterCall
  writeProperties: (name: string, changes: Record<string, string>) => Promise<void>
  statuses: () => Promise<StatusMap>
  /** A server's folder. */
  serverDir: (name: string) => string
  /** When a server last started, or null if it isn't running. */
  since: (name: string) => Promise<Date | null>
  /** The release's flytower-proxy mod, or null if this install has none. */
  mod: () => Promise<Uint8Array | null>
  /** Gives the panel write access to a server's files again (the agent's server.permissions). */
  fixPermissions: (name: string) => Promise<void>
  /** The install's name, for the default messages. */
  brand: () => string
  /** How long to wait before sending the routes again after the router didn't answer. */
  retryMs?: number
}

export class RoutingError extends Error {}

/** A server moved off the router's port when routing was turned on. */
export interface MovedServer {
  name: string
  from: number
  to: number
}

const LOOPBACK = '127.0.0.1'

export class Routing {
  private pending: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private sending: Promise<void> | null = null
  private again = false
  private bans: BanWatcher

  constructor(private deps: RoutingDeps) {
    this.bans = new BanWatcher(() => this.sync())
  }

  settings(): RouterSettings {
    const saved = getSetting(this.deps.db, 'router')
    const defaults = defaultRouterSettings(this.deps.brand())
    return saved
      ? { ...defaults, ...saved, messages: { ...defaults.messages, ...saved.messages } }
      : defaults
  }

  /** Ports no server may take: the router's, while it's on. */
  reservedPorts(): number[] {
    const s = this.settings()
    return s.enabled ? [s.port] : []
  }

  private servers() {
    return this.deps.db
      .select({
        name: schema.servers.name,
        hostname: schema.servers.hostname,
        port: schema.servers.port,
        rconPort: schema.servers.rconPort,
        loader: schema.servers.loader,
      })
      .from(schema.servers)
      .all()
  }

  /**
   * Turns routing on: moves any server off the router's port, starts the router, closes the
   * public ports of servers with a hostname and binds them to 127.0.0.1 (from their next
   * restart), then sends the routes.
   */
  async enable(port: number, messages?: RouterMessages): Promise<{ moved: MovedServer[] }> {
    const servers = this.servers()
    if (servers.some((s) => s.rconPort === port)) {
      throw new RoutingError(`Port ${port} is a server's RCON port. Choose another.`)
    }
    const used = new Set([port, ...servers.flatMap((s) => [s.port, s.rconPort])])
    const moved: MovedServer[] = []
    for (const s of servers.filter((s) => s.port === port)) {
      const to = lowestFree(port + 1, used)
      used.add(to)
      await this.deps.agent('server.configure', { name: s.name, port: to })
      await this.deps.writeProperties(s.name, { 'server-port': String(to) })
      this.deps.db
        .update(schema.servers)
        .set({ port: to })
        .where(eq(schema.servers.name, s.name))
        .run()
      moved.push({ name: s.name, from: port, to })
    }
    await this.deps.agent('router.enable', { port }, { timeoutMs: 60_000 })
    const settings = { ...this.settings(), enabled: true, port, ...(messages ? { messages } : {}) }
    setSetting(this.deps.db, 'router', settings)
    for (const s of this.servers()) await this.apply(settings, s)
    await this.syncNow()
    return { moved }
  }

  /** Turns routing off: every server gets its own public port back, exactly as before. */
  async disable() {
    await this.deps.agent('router.disable', {}, { timeoutMs: 60_000 })
    const settings = { ...this.settings(), enabled: false }
    setSetting(this.deps.db, 'router', settings)
    this.bans.set([])
    for (const s of this.servers()) await this.apply(settings, s)
  }

  /** Saves the messages players see and sends them to the router if it's on. */
  async saveMessages(messages: RouterMessages) {
    setSetting(this.deps.db, 'router', { ...this.settings(), messages })
    if (this.settings().enabled) await this.syncNow()
  }

  /**
   * Brings one server in line after its hostname or port changed: routed servers listen on
   * 127.0.0.1 with no public port, others keep their own. Does nothing while routing is off,
   * so installs that never turn it on (or run the Bun agent) are untouched.
   */
  async serverChanged(name: string) {
    const settings = this.settings()
    if (!settings.enabled) return
    const s = this.servers().find((r) => r.name === name)
    if (s) await this.apply(settings, s)
    this.sync()
  }

  private async apply(
    settings: RouterSettings,
    s: { name: string; hostname: string | null; port: number; loader: Loader },
  ) {
    const routed = isRouted(settings, s)
    await this.deps.writeProperties(s.name, { 'server-ip': routed ? LOOPBACK : '' })
    await this.deps.agent('server.expose', { name: s.name, port: s.port, public: !routed })
    await this.prepare(s, routed)
  }

  /**
   * Puts the proxy mod or Paper's setting in place (or takes it out). A config file the server
   * wrote itself may not be the panel's to change until the agent fixes its permissions.
   */
  private async prepare(s: { name: string; loader: Loader }, routed: boolean) {
    const dir = this.deps.serverDir(s.name)
    const mod = s.loader === 'fabric' ? await this.deps.mod() : null
    try {
      await prepareServer(dir, s.loader, routed, mod)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES') throw err
      await this.deps.fixPermissions(s.name)
      await prepareServer(dir, s.loader, routed, mod)
    }
  }

  /** Sends the routes soon, folding changes that arrive together into one send. */
  sync() {
    if (!this.settings().enabled || this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      void this.syncNow().catch(() => {})
    }, 50)
  }

  /** Sends the whole table now. If the router doesn't answer, tries again later by itself. */
  async syncNow(): Promise<void> {
    if (this.sending) {
      this.again = true
      return this.sending
    }
    this.sending = this.send().finally(() => {
      this.sending = null
      if (this.again) {
        this.again = false
        this.sync()
      }
    })
    return this.sending
  }

  private async send() {
    const settings = this.settings()
    if (!settings.enabled) return
    const servers = this.servers()
    const routed = servers.filter((s) => isRouted(settings, s))
    const statuses = await this.deps.statuses()
    const extras: Record<string, RouteExtras> = {}
    for (const s of routed) {
      const dir = this.deps.serverDir(s.name)
      // Paper writes its config on first start, so a new server gets the setting on the send
      // after that; it then reads real addresses from its next restart.
      await this.prepare(s, true).catch((err: Error) => {
        console.error(`[flytower] preparing ${s.name} for real addresses failed: ${err.message}`)
      })
      const since =
        statuses[s.name] === 'active' ? await this.deps.since(s.name).catch(() => null) : null
      extras[s.name] = {
        proxyProtocol: await readsProxyHeaders(dir, s.loader, since),
        bans: await readIpBans(dir),
      }
    }
    this.bans.set(routed.map((s) => this.deps.serverDir(s.name)))
    const table = routeTable(servers, statuses, settings.messages, extras)
    try {
      await this.deps.router('routes.set', table)
      if (this.retry) clearTimeout(this.retry)
      this.retry = null
    } catch (err) {
      console.error(`[flytower] sending the routes failed: ${(err as Error).message}`)
      this.retry ??= setTimeout(() => {
        this.retry = null
        void this.syncNow().catch(() => {})
      }, this.deps.retryMs ?? 10_000)
      throw err
    }
  }

  /** The router's connection counts, or null if it isn't on or didn't answer. */
  async status(): Promise<RouterResult<'routes.status'> | null> {
    if (!this.settings().enabled) return null
    return this.deps.router('routes.status', {}).catch(() => null)
  }

  /** The servers that read real addresses now, and those that will after a restart. */
  async addresses(): Promise<{ name: string; real: boolean; afterRestart: boolean }[]> {
    const settings = this.settings()
    if (!settings.enabled) return []
    const statuses = await this.deps.statuses()
    const out = []
    for (const s of this.servers().filter((s) => isRouted(settings, s))) {
      const dir = this.deps.serverDir(s.name)
      const since =
        statuses[s.name] === 'active' ? await this.deps.since(s.name).catch(() => null) : null
      const real = await readsProxyHeaders(dir, s.loader, since)
      const afterRestart = real || (await readsProxyHeaders(dir, s.loader, new Date()))
      out.push({ name: s.name, real, afterRestart })
    }
    return out
  }

  /** Stops timers and watchers, for tests and shutdown. */
  close() {
    this.bans.close()
    if (this.pending) clearTimeout(this.pending)
    if (this.retry) clearTimeout(this.retry)
  }
}
