/**
 * Notifications: what Flytower can tell you about, and where it can send it. Shared by the
 * browser (the channel form) and the panel's API, so it holds only the catalogue.
 */

export const CHANNEL_KINDS = {
  discord: 'Discord',
  ntfy: 'ntfy',
  webhook: 'JSON webhook',
} as const
export type ChannelKind = keyof typeof CHANNEL_KINDS

export const EVENT_GROUPS = {
  problems: 'Problems',
  updates: 'Updates',
  activity: 'Activity',
} as const
export type EventGroup = keyof typeof EVENT_GROUPS

export const EVENT_KINDS = {
  'backup.failed': { group: 'problems', label: 'A backup failed', perServer: true },
  'offsite.failed': {
    group: 'problems',
    label: 'Copying a backup off-site failed',
    perServer: true,
  },
  'server.crashed': {
    group: 'problems',
    label: 'A server crashed (and when it is back up)',
    perServer: true,
  },
  'server.crash_loop': {
    group: 'problems',
    label: 'A server kept crashing and was left stopped',
    perServer: true,
  },
  'server.unresponsive': {
    group: 'problems',
    label: 'A server stopped responding',
    perServer: true,
  },
  'schedule.failed': {
    group: 'problems',
    label: 'A scheduled restart, command or announcement failed',
    perServer: true,
  },
  'disk.full': { group: 'problems', label: 'The disk is nearly full (85% and 95%)' },
  'update.flytower': { group: 'updates', label: 'A new version of Flytower is out' },
  'update.content': {
    group: 'updates',
    label: 'Updates for installed mods, plugins or datapacks',
    perServer: true,
  },
  'server.started': { group: 'activity', label: 'A server started', perServer: true },
  'server.stopped': { group: 'activity', label: 'A server stopped', perServer: true },
  'server.restarted': {
    group: 'activity',
    label: 'A server restarted from the panel',
    perServer: true,
  },
  'player.joined': { group: 'activity', label: 'A player joined', perServer: true },
  'player.left': { group: 'activity', label: 'A player left', perServer: true },
  'world.trimmed': {
    group: 'activity',
    label: 'Unused chunks were trimmed from a world',
    perServer: true,
  },
} as const satisfies Record<string, { group: EventGroup; label: string; perServer?: boolean }>
export type EventKind = keyof typeof EVENT_KINDS

/** What a new channel starts with ticked: the problems and updates, not the chatter. */
export const DEFAULT_EVENTS: EventKind[] = (Object.keys(EVENT_KINDS) as EventKind[]).filter(
  (k) => EVENT_KINDS[k].group !== 'activity',
)

export function isEventKind(k: string): k is EventKind {
  return Object.hasOwn(EVENT_KINDS, k)
}

/** How bad it is. `ok` is the "back to normal" message after a problem clears. */
export type Severity = 'critical' | 'warning' | 'info' | 'ok'

/** A channel as the browser sees it: never the URL's secret parts or the token. */
export interface ChannelView {
  id: number
  name: string
  kind: ChannelKind
  /** The URL with its secret parts masked, so you can tell channels apart. */
  target: string
  hasSecret: boolean
  events: EventKind[]
  servers: string[]
  enabled: boolean
  lastSentAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}
