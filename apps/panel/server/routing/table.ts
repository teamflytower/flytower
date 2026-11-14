/**
 * "One address for every server" (#76): the hostname router's route table, built from the
 * panel's own records. Pure, so it can be tested without a router.
 */
import type { RouteTable, RouterMessages } from '@flytower/protocol'
import type { StatusMap } from '../jobs/status'

export interface RouterSettings {
  enabled: boolean
  /** The one port players connect to. */
  port: number
  messages: RouterMessages
}

export const DEFAULT_ROUTER_PORT = 25565

/** The texts players see, with the install's name in the server list. */
export function defaultMessages(brand: string): RouterMessages {
  return {
    unknownMotd: `${brand}\n§7No server at this address`,
    unknownDisconnect: "There's no server at {hostname}.",
    stoppedMotd: `${brand}\n§7This server is stopped`,
    stoppedDisconnect: 'This server is stopped.',
    startingMotd: `${brand}\n§eStarting up, try again in a moment`,
    startingDisconnect: 'The server is starting.\nTry again in a moment.',
    bannedDisconnect: "You can't join this server.",
  }
}

export function defaultRouterSettings(brand: string): RouterSettings {
  return { enabled: false, port: DEFAULT_ROUTER_PORT, messages: defaultMessages(brand) }
}

export interface RoutedServer {
  name: string
  hostname: string | null
  port: number
}

/** True when players reach this server through the router rather than its own port. */
export function isRouted(
  settings: Pick<RouterSettings, 'enabled'>,
  s: Pick<RoutedServer, 'hostname'>,
) {
  return settings.enabled && !!s.hostname
}

/**
 * What the router should say about a server in this systemd state. A server that's coming up
 * says so; anything we can't tell is treated as running, and the router answers "starting"
 * by itself if nothing accepts the connection.
 */
export function routeState(
  active: StatusMap[string] | undefined,
): 'running' | 'starting' | 'stopped' {
  switch (active) {
    case 'activating':
      return 'starting'
    case 'inactive':
    case 'failed':
    case 'deactivating':
      return 'stopped'
    default:
      return 'running'
  }
}

/** What the panel knows about a server's real addresses: see routing/files.ts. */
export interface RouteExtras {
  /** The server reads PROXY headers, so the router sends one. */
  proxyProtocol: boolean
  /** IP addresses the router turns away before they reach the server. */
  bans: string[]
}

/** The whole table: one route per server with a hostname. */
export function routeTable(
  servers: RoutedServer[],
  statuses: StatusMap,
  messages: RouterMessages,
  extras: Record<string, RouteExtras> = {},
): RouteTable {
  return {
    routes: servers
      .filter((s): s is RoutedServer & { hostname: string } => !!s.hostname)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        hostnames: [s.hostname.toLowerCase()],
        port: s.port,
        state: routeState(statuses[s.name]),
        proxyProtocol: extras[s.name]?.proxyProtocol ?? false,
        bans: extras[s.name]?.bans ?? [],
      })),
    messages,
  }
}
