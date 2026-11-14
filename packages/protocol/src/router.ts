import { z } from 'zod'
import { ServerName } from './names.ts'

/**
 * The hostname router's control socket (flytower-router, #232). It speaks the same envelope as
 * the agent, one JSON message per line, but has its own short list of verbs. The router is
 * written in Go (go/router); the shared fixtures in protocol/fixtures/router.jsonl keep the two
 * in step.
 */

/**
 * A hostname players type, in lower case with no trailing dot. A leading `*.` matches exactly
 * one more label, as in TLS certificates: `*.mc.example.com` matches `survival.mc.example.com`.
 */
export const RouteHostname = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    'a lower-case hostname, optionally starting with *.',
  )

/** An address or range the router turns away at login, for servers that can't see real addresses. */
export const RouteBan = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])

/**
 * Text shown in the server list or on the disconnect screen. Minecraft's `§` formatting codes
 * work, `\n` starts a new line, and `{hostname}` becomes the address the player typed.
 */
const RouterText = z.string().max(512)

export const Route = z
  .object({
    /** The server this route reaches. */
    name: ServerName,
    hostnames: z.array(RouteHostname).min(1).max(16),
    /** The server's port on 127.0.0.1. */
    port: z.number().int().min(1).max(65535),
    /** Stopped and starting servers get a message instead of a refused connection. */
    state: z.enum(['running', 'starting', 'stopped']),
    /** Send a PROXY protocol v2 header first, so the server sees players' real addresses. */
    proxyProtocol: z.boolean(),
    bans: z.array(RouteBan).max(10_000),
  })
  .strict()
export type Route = z.infer<typeof Route>

export const RouterMessages = z
  .object({
    unknownMotd: RouterText,
    unknownDisconnect: RouterText,
    stoppedMotd: RouterText,
    stoppedDisconnect: RouterText,
    startingMotd: RouterText,
    startingDisconnect: RouterText,
    bannedDisconnect: RouterText,
  })
  .strict()
export type RouterMessages = z.infer<typeof RouterMessages>

/** The whole route table. The router keeps the last one on disk. */
export const RouteTable = z
  .object({
    routes: z.array(Route).max(256),
    messages: RouterMessages,
  })
  .strict()
  .refine((t) => {
    const all = t.routes.flatMap((r) => r.hostnames)
    return new Set(all).size === all.length
  }, 'a hostname can only belong to one route')
  .refine(
    (t) => new Set(t.routes.map((r) => r.name)).size === t.routes.length,
    'route names must be unique',
  )
export type RouteTable = z.infer<typeof RouteTable>

const Count = z.number().int().min(0)

export const routerVerbs = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ routerVersion: z.string(), protocol: z.number().int() }),
  },
  /** Replaces the whole table. Connections already forwarded carry on. */
  'routes.set': {
    params: RouteTable,
    result: z.object({ routes: Count }),
  },
  'routes.status': {
    params: z.object({}).strict(),
    result: z.object({
      /** When the router started, as an ISO time. */
      since: z.string(),
      routes: z.array(z.object({ name: ServerName, active: Count, total: Count })),
      /** Connections to a hostname with no route. */
      unknown: Count,
      /** Connections turned away by a limit, a ban or a bad handshake. */
      refused: Count,
      active: Count,
    }),
  },
} as const

export type RouterVerb = keyof typeof routerVerbs
export const routerVerbNames = Object.keys(routerVerbs) as RouterVerb[]
