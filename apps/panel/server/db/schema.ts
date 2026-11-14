import type { ContentItem } from '../../shared/spec'
import type { PublicPage } from '../../shared/public-page'
import type { StatsSettings } from '../../shared/stats-settings'
import type { MapSettings } from '../../shared/map-settings'
import type { TrimRules } from '../../shared/trim-rules'
import type { StoredRelay } from '../../shared/discord-relay'
import type { Permission } from '../../shared/permissions'
import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch() * 1000)`
const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now)

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Bumped by "Sign out everywhere": sessions made under an older number stop working. */
  sessionVersion: integer('session_version').notNull().default(0),
  /** Light, dark or follow the device, remembered for the person rather than the browser. */
  theme: text('theme', { enum: ['system', 'light', 'dark'] })
    .notNull()
    .default('system'),
  createdAt: createdAt(),
})

/** One row per registered passkey. */
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(), // WebAuthn credential id, base64url
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
  aaguid: text('aaguid'),
  nickname: text('nickname').notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
})

/**
 * One-time recovery codes, stored only as Bun.password hashes. `lookup` is the code's first
 * group, so signing in checks one hash rather than every code in the install. It gives away
 * 20 of the 60 bits; the other 40 are still behind Argon2. Codes made before it was added
 * have none and are checked the slow way until they're replaced.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    lookup: text('lookup'),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('recovery_codes_lookup').on(t.lookup)],
)

/** The installer's setup token. At most one row (id = 1). */
export const setupToken = sqliteTable('setup_token', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
})

export const servers = sqliteTable(
  'servers',
  {
    name: text('name').primaryKey(),
    displayName: text('display_name').notNull(),
    loader: text('loader', { enum: ['vanilla', 'fabric', 'paper'] }).notNull(),
    mcVersion: text('mc_version').notNull(),
    loaderVersion: text('loader_version'),
    javaMajor: integer('java_major').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    port: integer('port').notNull(),
    rconPort: integer('rcon_port').notNull(),
    rconPassword: text('rcon_password').notNull(),
    /** The address players use, like survival.example.com; lower case. */
    hostname: text('hostname'),
    eulaAcceptedAt: integer('eula_accepted_at', { mode: 'timestamp_ms' }).notNull(),
    /** 5-field cron expression for scheduled backups; null means off. */
    backupSchedule: text('backup_schedule'),
    /** IANA time zone the schedule is read in, e.g. Europe/London. */
    backupTz: text('backup_tz').notNull().default('UTC'),
    keepLast: integer('keep_last').notNull().default(6),
    keepDaily: integer('keep_daily').notNull().default(7),
    keepWeekly: integer('keep_weekly').notNull().default(4),
    /** Where backups are copied off the machine; null keeps them local only. */
    offsiteTarget: integer('offsite_target'),
    /** The spec's content list as written; the lockfile in the server folder pins it. */
    content: text('content', { mode: 'json' }).$type<ContentItem[]>().notNull().default([]),
    /** Restart once, automatically, when the console stops answering for five minutes. */
    restartWhenUnresponsive: integer('restart_when_unresponsive', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** IANA time zone the server's scheduled tasks are read in. */
    timezone: text('timezone').notNull().default('UTC'),
    /** The public status page's settings; null until it's first set. */
    publicPage: text('public_page', { mode: 'json' }).$type<PublicPage>(),
    /** Whether player stats are kept and who is left out; null until it's first set (on). */
    stats: text('stats', { mode: 'json' }).$type<StatsSettings>(),
    /** The web map's settings; null until it's first set. */
    map: text('map', { mode: 'json' }).$type<MapSettings>(),
    /** What "Trim unused chunks" keeps (spec `world.trim`); null until it's first set. */
    trim: text('trim', { mode: 'json' }).$type<TrimRules>(),
    /** Game chat to a Discord channel's webhook (URL sealed); null when it's off. */
    discordRelay: text('discord_relay', { mode: 'json' }).$type<StoredRelay>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('servers_port').on(t.port),
    uniqueIndex('servers_rcon_port').on(t.rconPort),
    uniqueIndex('servers_hostname').on(t.hostname),
  ],
)

export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server: text('server').notNull(),
    /** File name inside the server's backup folder. */
    file: text('file').notNull(),
    bytes: integer('bytes').notNull(),
    kind: text('kind', { enum: ['manual', 'scheduled', 'safety'] }).notNull(),
    note: text('note'),
    /** Kept forever: pruning never deletes it, e.g. the last backup before a world reset. */
    kept: integer('kept', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    /** The off-site copy: null when the server has no target. */
    offsiteState: text('offsite_state', { enum: ['pending', 'uploading', 'done', 'failed'] }),
    offsiteTarget: integer('offsite_target'),
    offsiteKey: text('offsite_key'),
    offsiteError: text('offsite_error'),
    offsiteAttempts: integer('offsite_attempts').notNull().default(0),
    offsiteAt: integer('offsite_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('backups_file').on(t.server, t.file)],
)

export const exports = sqliteTable('exports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  server: text('server').notNull(),
  file: text('file').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: createdAt(),
  /** Ignored for past worlds, which never expire. */
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  /** Set for a past world: the old world kept when the world was reset. */
  name: text('name'),
})

export const shares = sqliteTable(
  'shares',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    exportId: integer('export_id')
      .notNull()
      .references(() => exports.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token, hex. The token itself is only ever shown once. */
    tokenHash: text('token_hash').notNull(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    downloads: integer('downloads').notNull().default(0),
  },
  (t) => [uniqueIndex('shares_token').on(t.tokenHash)],
)

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  server: text('server'),
  state: text('state', { enum: ['queued', 'running', 'succeeded', 'failed'] })
    .notNull()
    .default('queued'),
  step: text('step'),
  progress: integer('progress').notNull().default(0), // 0..100
  message: text('message'),
  createdAt: createdAt(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
})

export const audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at', { mode: 'timestamp_ms' }).notNull().default(now),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  target: text('target'),
  detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
})

/**
 * One sample a minute per running server, and for the machine as a whole (server "*").
 * A server with no row for a minute was stopped then, so the charts show a gap.
 */
export const metrics = sqliteTable(
  'metrics',
  {
    server: text('server').notNull(),
    at: integer('at').notNull(), // unix seconds, on the minute
    cpu: real('cpu'), // percent of the whole machine
    memMb: integer('mem_mb'),
    players: integer('players'),
    mspt: real('mspt'), // milliseconds per tick
    diskMb: integer('disk_mb'), // machine only: used on the servers' disk
  },
  (t) => [primaryKey({ columns: [t.server, t.at] })],
)

/** S3-compatible storage that backups are copied to. The secret is encrypted at rest. */
export const backupTargets = sqliteTable(
  'backup_targets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    endpoint: text('endpoint').notNull(),
    region: text('region').notNull().default('auto'),
    bucket: text('bucket').notNull(),
    prefix: text('prefix').notNull().default('flytower'),
    accessKeyId: text('access_key_id').notNull(),
    secretSealed: text('secret_sealed').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('backup_targets_name').on(t.name)],
)

/** Panel-wide settings, one row per key, with JSON values. See server/settings.ts. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
})

/**
 * Where notifications go: a Discord webhook, an ntfy topic or a JSON webhook. The URL (which
 * holds the Discord token) and the ntfy token or webhook signing secret are sealed at rest.
 */
export const notifyChannels = sqliteTable(
  'notify_channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['discord', 'ntfy', 'webhook'] }).notNull(),
    urlSealed: text('url_sealed').notNull(),
    /** ntfy access token, or the webhook's signing secret. */
    secretSealed: text('secret_sealed'),
    /** The URL with its secret parts masked, for telling channels apart. */
    target: text('target').notNull(),
    events: text('events', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Server names; empty means every server. */
    servers: text('servers', { mode: 'json' }).$type<string[]>().notNull().default([]),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastSentAt: integer('last_sent_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('notify_channels_name').on(t.name)],
)

/**
 * What has been sent, so the same alert isn't repeated within its quiet period and a "back to
 * normal" message follows a problem. Keyed by kind and server, e.g. `backup.failed:survival`.
 */
export const notifyState = sqliteTable('notify_state', {
  key: text('key').primaryKey(),
  sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
  /** A problem that hasn't cleared yet. */
  open: integer('open', { mode: 'boolean' }).notNull().default(false),
  /** Kind-specific memory, like the disk level last warned about or the versions offered. */
  value: text('value'),
})

/**
 * Crashes and other trouble Flytower noticed, per server, kept for 30 days. A crash keeps
 * the crash report's file name (in the server's crash-reports folder) and the last lines
 * of the log, since the log is rotated when the server starts again.
 */
export const serverEvents = sqliteTable(
  'server_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server: text('server').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull().default(now),
    kind: text('kind', {
      enum: ['crash', 'oom', 'crash-loop', 'unresponsive', 'recovered'],
    }).notNull(),
    /** A sentence on the cause, like "Exited with code 1" or the crash report's description. */
    cause: text('cause'),
    /** systemd's Result for the run that ended, like `exit-code` or `oom-kill`. */
    result: text('result'),
    exitStatus: integer('exit_status'),
    /** The crash report's file name, if Minecraft wrote one. */
    crashReport: text('crash_report'),
    logTail: text('log_tail', { mode: 'json' }).$type<string[]>(),
    /** When someone closed its banner. */
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('server_events_server_at').on(t.server, t.at)],
)

/**
 * What the background update check last found, per thing checked: `('flytower', '*')`,
 * `('content', <server>)`, `('minecraft', <server>)` or `('java', <major>)`. A failed check
 * sets only the error, so the last good result (and its badge) stays.
 */
export const updateStatus = sqliteTable(
  'update_status',
  {
    scope: text('scope', { enum: ['flytower', 'content', 'minecraft', 'java'] }).notNull(),
    subject: text('subject').notNull(),
    /** The last good result; its shape depends on the scope. */
    summary: text('summary', { mode: 'json' }).$type<unknown>(),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    errorAt: integer('error_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.scope, t.subject] })],
)

/**
 * Restarts, console commands and announcements a server runs on a schedule, in its own time
 * zone (servers.timezone). The spec's `schedules` list, in order, plus each task's last run.
 */
export const schedules = sqliteTable(
  'schedules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server: text('server').notNull(),
    position: integer('position').notNull().default(0),
    kind: text('kind', { enum: ['restart', 'command', 'announce'] }).notNull(),
    cron: text('cron').notNull(),
    /** The command or announcement; null for a restart. */
    text: text('text'),
    /** Seconds before a restart to warn players, longest first. */
    warn: text('warn', { mode: 'json' }).$type<number[]>().notNull().default([]),
    skipWhenEmpty: integer('skip_when_empty', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    lastOk: integer('last_ok', { mode: 'boolean' }),
    /** What happened, like "Restarted in 41s" or "Skipped: the server wasn't running". */
    lastResult: text('last_result'),
    /** A command's reply. */
    lastReply: text('last_reply'),
    createdAt: createdAt(),
  },
  (t) => [index('schedules_server').on(t.server, t.position)],
)

/**
 * Named sets of permissions. Built-in roles (owner, admin, operator, viewer) take their
 * permissions from shared/permissions.ts, so the column only matters for custom roles.
 */
export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
  permissions: text('permissions', { mode: 'json' }).$type<Permission[]>().notNull().default([]),
  createdAt: createdAt(),
})

/** A person holds a role for one server, or for all servers when `server` is null. */
export const grants = sqliteTable(
  'grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    server: text('server').references(() => servers.name, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('grants_user').on(t.userId)],
)

/**
 * One-time invite links. Only a SHA-256 of the token is kept (the token is 32 random bytes,
 * so a slow hash adds nothing). A link is gone once used, revoked or past `expiresAt`.
 */
export const invites = sqliteTable('invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  roleId: text('role_id')
    .notNull()
    .references(() => roles.id, { onDelete: 'cascade' }),
  server: text('server').references(() => servers.name, { onDelete: 'cascade' }),
  /** Who it's for, as the inviter wrote it; the person picks their own name when joining. */
  note: text('note'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
})

/**
 * Time players spent on each server, one row per visit, from the "joined the game" and "left
 * the game" lines in the log. `leftAt` is null while they're on. A visit whose end wasn't
 * seen (the panel was down, or the server crashed) ends at the last minute the metrics saw
 * anyone on, and says how it ended in `endedBy`.
 */
export const playerSessions = sqliteTable(
  'player_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server: text('server').notNull(),
    uuid: text('uuid').notNull(),
    /** The name they joined with. */
    name: text('name').notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull(),
    leftAt: integer('left_at', { mode: 'timestamp_ms' }),
    endedBy: text('ended_by', { enum: ['left', 'stopped', 'crashed', 'lost', 'rejoined', 'off'] }),
  },
  (t) => [
    index('player_sessions_player').on(t.server, t.uuid, t.joinedAt),
    index('player_sessions_open').on(t.server, t.leftAt),
  ],
)

/** Each player's newest name per server, from the log and usercache.json. */
export const playerNames = sqliteTable(
  'player_names',
  {
    server: text('server').notNull(),
    uuid: text('uuid').notNull(),
    name: text('name').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.server, t.uuid] })],
)

/**
 * A short list of each player's vanilla stats (from the world's stats files), once a day and
 * only when they changed. Week and month figures are the difference between two rows. Rows
 * older than 90 days are thinned to the last one in each week.
 */
export const playerStats = sqliteTable(
  'player_stats',
  {
    server: text('server').notNull(),
    uuid: text('uuid').notNull(),
    /** The day in the server's time zone, as YYYY-MM-DD. */
    day: text('day').notNull(),
    /** When the stats file was read. */
    takenAt: integer('taken_at', { mode: 'timestamp_ms' }).notNull(),
    stats: text('stats', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.server, t.uuid, t.day] })],
)
