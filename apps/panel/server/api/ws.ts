import type { Peer } from 'crossws'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '../db'
import { ON_OPEN_AFTER_MS } from '../update-checks'
import { loadAccess } from '../auth/access'
import { can, NO_ACCESS, type Access, type Permission } from '../../shared/permissions'

const Topic = z
  .string()
  .regex(
    /^(job:\d+|servers|health|metrics|updates|branding|(console|schedules|map|trim):[a-z][a-z0-9-]{1,30})$/,
  )
const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topic: Topic }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string().max(64) }),
])

const subscriptions = new Map<string, Map<string, () => void>>()

const send = (peer: Peer, topic: string, data: unknown) => {
  peer.send(JSON.stringify({ topic, data }))
}

/** Keeps only the entries of a per-server map that this person can see. */
function visibleOnly(data: unknown, access: Access): unknown {
  if (!data || typeof data !== 'object') return data
  return Object.fromEntries(
    Object.entries(data).filter(([name]) => can(access, 'server.view', name)),
  )
}

/** The server-scoped permission a topic needs, if any. */
function topicNeeds(topic: string): { permission: Permission; server: string } | null {
  if (topic.startsWith('console:')) {
    return { permission: 'console.read', server: topic.slice('console:'.length) }
  }
  if (topic.startsWith('schedules:')) {
    return { permission: 'server.view', server: topic.slice('schedules:'.length) }
  }
  if (topic.startsWith('map:')) {
    return { permission: 'server.view', server: topic.slice('map:'.length) }
  }
  if (topic.startsWith('trim:')) {
    return { permission: 'world.manage', server: topic.slice('trim:'.length) }
  }
  return null
}

/**
 * Wires a topic to its source. Each source sends its current state first, so a late or
 * reconnecting subscriber never misses where things are. `access` is read again for every
 * message, so a person who loses access stops hearing about the server at once.
 */
function attach(topic: string, emit: (data: unknown) => void, access: () => Access): () => void {
  if (topic === 'servers') return useStatus().watch((data) => emit(visibleOnly(data, access())))
  if (topic === 'health') {
    return useCrashes().watch(
      (data) => emit(visibleOnly(data, access())),
      () =>
        useDb()
          .select({ name: schema.servers.name })
          .from(schema.servers)
          .all()
          .map((r) => r.name)
          .filter((name) => can(access(), 'server.view', name)),
    )
  }
  if (topic === 'metrics') {
    const off = useJobs().bus.subscribe(topic, (data) => emit(visibleOnly(data, access())))
    emit(visibleOnly(liveMetrics(), access()))
    return off
  }
  if (topic === 'updates') {
    // Opening the panel checks again if the last check is over an hour old.
    const off = useUpdates().watch((data) => emit(visibleUpdates(data, access())))
    useUpdates().maybeCheck(ON_OPEN_AFTER_MS)
    return off
  }
  if (topic === 'branding') {
    const off = useJobs().bus.subscribe(topic, emit)
    emit(useBranding().public())
    return off
  }
  if (topic.startsWith('console:')) {
    const name = topic.slice('console:'.length)
    const exists = useDb()
      .select({ name: schema.servers.name })
      .from(schema.servers)
      .where(eq(schema.servers.name, name))
      .get()
    if (!exists) return () => {}
    return useConsole().watch(name, emit)
  }
  if (topic.startsWith('schedules:')) {
    const name = topic.slice('schedules:'.length)
    const off = useJobs().bus.subscribe(topic, emit)
    emit(useSchedules().view(name))
    return off
  }
  if (topic.startsWith('map:')) {
    const name = topic.slice('map:'.length)
    const off = useJobs().bus.subscribe(topic, emit)
    void useMap()
      .status(name)
      .then(emit)
      .catch(() => {})
    return off
  }
  if (topic.startsWith('trim:')) {
    const off = useJobs().bus.subscribe(topic, emit)
    emit(useWorld().trimPreviewState(topic.slice('trim:'.length)))
    return off
  }
  const off = useJobs().bus.subscribe(topic, emit)
  emit(useJobs().get(Number(topic.slice('job:'.length))))
  return off
}

/**
 * One authenticated socket per tab. The browser subscribes to topics (`job:<id>`,
 * `servers`, `health`, `metrics`, `updates`, `branding`, `console:<name>`, `schedules:<name>`, `map:<name>`, `trim:<name>`) and gets `{ topic, data }`
 * messages back.
 */
export default defineWebSocketHandler({
  async upgrade(request) {
    // Only the panel's own pages may open a socket, as for changes in middleware/auth.ts.
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    if (fromAnotherSite(request.headers.get('origin'), host)) {
      return new Response('That request came from another site.', { status: 403 })
    }
    const session = await getUserSession(request)
    if (!session.user || session.mustEnrolPasskey) {
      return new Response('Sign in first.', { status: 401 })
    }
  },
  open(peer) {
    subscriptions.set(peer.id, new Map())
  },
  async message(peer, message) {
    const parsed = ClientMessage.safeParse(safeJson(message.text()))
    if (!parsed.success) return send(peer, 'error', 'Unknown message.')
    const subs = subscriptions.get(peer.id)
    if (!subs) return
    const { type, topic } = parsed.data
    if (type === 'unsubscribe') {
      subs.get(topic)?.()
      subs.delete(topic)
      return
    }
    if (subs.has(topic)) return
    const session = await getUserSession(peer)
    const userId = session.user?.id
    const version = session.sessionVersion
    const access = () => (userId === undefined ? null : loadAccess(useDb(), userId, version))
    const now = access()
    if (!now) return send(peer, 'error', 'Sign in first.')
    const needs = topicNeeds(topic)
    const jobId = topic.startsWith('job:') ? Number(topic.slice('job:'.length)) : null
    if (
      (needs && !can(now, needs.permission, needs.server)) ||
      (jobId !== null && !canSeeJob(now, jobId))
    ) {
      return send(peer, 'error', "You don't have permission to see that.")
    }
    // A second subscribe may have landed while the session was read.
    if (subs.has(topic)) return
    subs.set(
      topic,
      attach(
        topic,
        (data) => {
          const current = access() ?? NO_ACCESS
          if (needs && !can(current, needs.permission, needs.server)) return
          if (jobId !== null && !canSeeJob(current, jobId)) return
          send(peer, topic, data)
        },
        () => access() ?? NO_ACCESS,
      ),
    )
  },
  close(peer) {
    for (const off of subscriptions.get(peer.id)?.values() ?? []) off()
    subscriptions.delete(peer.id)
  },
})

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
