import type { Result } from '@flytower/protocol'
import type { AgentCall } from './runner'

export type ServiceStatus = Result<'service.status'>
export type ServiceState = ServiceStatus['active']
export type StatusMap = Record<string, ServiceState>
type Listener = (statuses: StatusMap) => void
/** Every poll's full answers; null where the agent didn't answer. */
type PollHook = (statuses: Record<string, ServiceStatus | null>) => void | Promise<void>

export interface StatusEventHandlers {
  /** Every server's state, when the subscription starts (`again` after a reconnect). */
  start(states: Record<string, ServiceStatus>, again: boolean): void
  change(server: string, status: ServiceStatus): void
  /** It ended for good: the agent refused it or stopped it. */
  end(): void
}

/**
 * Subscribes to the agent's `service.events` for these servers. Resolves to null if the
 * agent doesn't offer it, so the watcher waits with `service.wait` instead.
 */
export type StatusEvents = (
  servers: string[],
  h: StatusEventHandlers,
) => Promise<{ close(): void } | null>

/**
 * Keeps an eye on every server's systemd state. With `follow`, it waits on the agent, which
 * answers when systemd says a server changed (and every five minutes regardless,
 * as a safety net), so nothing is polled. If the agent can't follow systemd, it falls
 * back to asking every ten seconds. Without `follow` (in tests), it polls every few seconds
 * while someone is watching. Listeners get the full map on subscribe and on any change.
 */
export class StatusWatcher {
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private last: StatusMap = {}
  private polling: Promise<void> | null = null
  private following = false
  /** The live `service.events` subscription and the servers it covers. */
  private events: { close(): void; servers: string } | null = null
  private opening: Promise<boolean> | null = null
  private openEvents: StatusEvents | undefined
  private waitMs = 300_000
  private fallbackMs = 10_000

  constructor(
    private agent: AgentCall,
    private names: () => string[],
    private intervalMs = 3000,
    private onPoll?: PollHook,
  ) {}

  /**
   * Follows systemd through the agent until `unfollow`. With `events`, the agent sends each
   * change as it happens (`service.events`); if it doesn't offer that, or stops, the watcher
   * waits with `service.wait` instead.
   */
  follow(opts: { waitMs?: number; fallbackMs?: number; events?: StatusEvents } = {}) {
    if (this.following) return
    this.following = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.openEvents = opts.events
    this.waitMs = opts.waitMs ?? 300_000
    this.fallbackMs = opts.fallbackMs ?? 10_000
    void this.subscribe().then((ok) => {
      if (!ok) void this.followLoop()
    })
  }

  unfollow() {
    this.following = false
    this.openEvents = undefined
    this.events?.close()
    this.events = null
  }

  /** Whether changes are arriving through `service.events`. */
  get streaming() {
    return this.events !== null
  }

  /**
   * Subscribes to `service.events` for the current servers, replacing the subscription for
   * an older list. False if events can't be had, so the caller waits instead.
   */
  private subscribe(): Promise<boolean> {
    const open = this.openEvents
    if (!open || !this.following) return Promise.resolve(false)
    // One at a time; the list may have changed while one was opening, so check again after.
    if (this.opening) return this.opening.then(() => this.subscribe())
    this.opening = this.subscribeNow(open).finally(() => (this.opening = null))
    return this.opening
  }

  private async subscribeNow(open: StatusEvents): Promise<boolean> {
    const names = [...this.names()]
    const key = serversKey(names)
    if (this.events?.servers === key) return true
    let sub: { close(): void } | null = null
    let ended = false
    const entry = { close: () => sub?.close(), servers: key }
    try {
      sub = await open(names, {
        start: (states) => {
          const next = Object.fromEntries(names.map((n) => [n, states[n]?.active ?? 'unknown']))
          this.update(next)
          void this.afterPoll(Object.fromEntries(names.map((n) => [n, states[n] ?? null])))
        },
        change: (server, status) => {
          if (!(server in this.last)) return
          this.update({ ...this.last, [server]: status.active })
          void this.afterPoll({ [server]: status })
        },
        end: () => {
          ended = true
          if (this.events !== entry) return
          this.events = null
          // The agent stopped sending (or refused): wait on it the old way from now on.
          this.openEvents = undefined
          if (this.following) void this.followLoop()
        },
      })
    } catch {
      sub = null
    }
    if (!sub || ended || !this.following) {
      sub?.close()
      return false
    }
    this.events?.close()
    this.events = entry
    return true
  }

  private async followLoop() {
    const { waitMs, fallbackMs } = this
    let cursor: string | null = null
    while (this.following && !this.events) {
      try {
        const r: Result<'service.wait'> = await this.agent(
          'service.wait',
          { servers: this.names(), after: cursor, timeoutMs: waitMs },
          { timeoutMs: waitMs + 15_000 },
        )
        cursor = r.cursor
        await this.poke()
        if (!r.following) await Bun.sleep(fallbackMs)
      } catch {
        // The agent is down or restarting (an older one doesn't know service.wait).
        cursor = null
        await Bun.sleep(fallbackMs)
        await this.poke()
      }
    }
  }

  /** The latest known states, or a fresh poll if nothing is watching yet. */
  async current(): Promise<StatusMap> {
    if (this.events) await this.subscribe()
    if (!this.timer && !(this.following && Object.keys(this.last).length)) await this.poke()
    return this.last
  }

  watch(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.events && Object.keys(this.last).length) {
      void this.subscribe().then(() => listener(this.last))
    } else if (this.following) {
      void this.poke().then(() => listener(this.last))
    } else if (!this.timer) {
      this.timer = setInterval(() => void this.poke(), this.intervalMs)
      void this.poke().then(() => listener(this.last))
    } else {
      listener(this.last)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** Polls now (sharing a poll already in flight) and tells watchers if anything moved. */
  async poke(): Promise<StatusMap> {
    // A server added or deleted: follow the new list.
    if (this.events) void this.subscribe()
    this.polling ??= this.poll().finally(() => (this.polling = null))
    await this.polling
    return this.last
  }

  private async poll() {
    const names = this.names()
    const full = await Promise.all(
      names.map((server) =>
        this.agent('service.status', { server }, { timeoutMs: 5000 }).catch(() => null),
      ),
    )
    this.update(Object.fromEntries(names.map((n, i) => [n, full[i]?.active ?? 'unknown'])))
    await this.afterPoll(Object.fromEntries(names.map((n, i) => [n, full[i] ?? null])))
  }

  /** Takes a new map and tells watchers if anything moved. */
  private update(next: StatusMap) {
    const names = Object.keys(next)
    const changed =
      names.length !== Object.keys(this.last).length || names.some((n) => next[n] !== this.last[n])
    this.last = next
    if (changed) for (const l of this.listeners) l(next)
  }

  private async afterPoll(statuses: Record<string, ServiceStatus | null>) {
    if (!this.onPoll) return
    try {
      await this.onPoll(statuses)
    } catch (err) {
      console.error('[flytower] after-poll hook failed', err)
    }
  }
}

function serversKey(names: string[]) {
  return [...names].sort().join('\n')
}
