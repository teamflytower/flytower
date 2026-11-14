import type { PublicPage } from '#shared/public-page'
import type { StatsSettings } from '#shared/stats-settings'
import type { MapSettings } from '#shared/map-settings'
import type { TrimRules } from '#shared/trim-rules'
import type { RelayView } from '#shared/discord-relay'

export type ServiceState =
  'active' | 'inactive' | 'activating' | 'deactivating' | 'failed' | 'unknown'

export type LoaderId = 'vanilla' | 'fabric' | 'paper'

/** Trouble Flytower has noticed: crashed, stopped after crashing repeatedly, or stuck. */
export type Condition = 'crashed' | 'crash-loop' | 'unresponsive' | null
export type ServerEventKind = 'crash' | 'oom' | 'crash-loop' | 'unresponsive' | 'recovered'

export interface CrashSummary {
  id: number
  at: string
  kind: ServerEventKind
  cause: string | null
  /** Relative to the server folder, like crash-reports/crash-….txt. */
  crashReport: string | null
}

export interface Health {
  condition: Condition
  crash: CrashSummary | null
}

/** A link that opens a crash report in the Files tab. */
export function crashReportLink(server: string, report: string) {
  const i = report.lastIndexOf('/')
  const dir = i < 0 ? '/' : `/${report.slice(0, i)}`
  return {
    path: `/servers/${server}/files`,
    query: { ...(dir === '/' ? {} : { path: dir }), open: report.slice(i + 1) },
  }
}

/** How each loader is named and described in the UI. */
export const LOADERS: Record<
  LoaderId,
  { label: string; description: string; versionLabel: string | null }
> = {
  fabric: { label: 'Fabric', description: 'Runs Fabric mods', versionLabel: 'Fabric loader' },
  paper: {
    label: 'Paper',
    description: 'Faster vanilla, runs plugins',
    versionLabel: 'Paper build',
  },
  vanilla: { label: 'Vanilla', description: 'Plain Minecraft', versionLabel: null },
}
export const loaderItems = (Object.keys(LOADERS) as LoaderId[]).map((value) => ({
  value,
  label: LOADERS[value].label,
  description: LOADERS[value].description,
}))

export interface Server {
  name: string
  displayName: string
  loader: LoaderId
  mcVersion: string
  loaderVersion: string | null
  javaMajor: number
  memoryMb: number
  port: number
  hostname: string | null
  createdAt: string
  restartWhenUnresponsive: boolean
  publicPage: PublicPage
  stats: StatsSettings
  map: MapSettings
  /** What "Trim unused chunks" keeps. */
  trim: TrimRules
  /** Game chat to Discord; never the webhook URL. */
  discordRelay: RelayView
  status: ServiceState
  health: Health
  /** The server's icon, if it has one; the URL changes when the icon does. */
  icon: string | null
}

/** Live systemd states for every server, kept current over the shared socket. */
export function useLiveStatuses() {
  const statuses = ref<Record<string, ServiceState>>({})
  useTopic<Record<string, ServiceState>>('servers', (m) => (statuses.value = m))
  return statuses
}

/** Live crash health for every server, kept current over the shared socket. */
export function useLiveHealth() {
  const health = ref<Record<string, Health>>({})
  useTopic<Record<string, Health>>('health', (m) => (health.value = m))
  return health
}

/** Each server's last hour of figures and its memory limit, updated after every sample. */
export type LiveMetrics = Record<
  string,
  { limitMb: number; points: import('#shared/vitals').VitalsPoint[] }
>

/** Live figures for the servers overview, kept current over the shared socket. */
export function useLiveMetrics() {
  const metrics = ref<LiveMetrics>({})
  useTopic<LiveMetrics>('metrics', (m) => (metrics.value = m))
  return metrics
}

export const loaderLabel = (s: Pick<Server, 'loader' | 'mcVersion'>) =>
  `${LOADERS[s.loader]?.label ?? s.loader} ${s.mcVersion}`

export const formatMemory = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`

/** What players type to connect: the hostname, or this machine's address and the port. */
export function connectAddress(s: Pick<Server, 'hostname' | 'port'>, machine: string): string {
  if (s.hostname) return s.hostname
  return s.port === 25565 ? machine : `${machine}:${s.port}`
}
