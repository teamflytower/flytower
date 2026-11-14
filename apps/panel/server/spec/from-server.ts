/** Builds a server's spec from what the panel knows: its database row and server.properties. */
import { isManagedProperty, type ServerSpec } from '../../shared/spec'
import { readPublicPage } from '../../shared/public-page'
import { isDefaultStats, readStatsSettings } from '../../shared/stats-settings'
import { isDefaultMap, readMapSettings } from '../../shared/map-settings'
import { isDefaultTrim, readTrimRules } from '../../shared/trim-rules'
import { ScheduleItem, toItem, type TaskSpec } from '../../shared/schedules'
import type { schema } from '../db'

type ServerRow = typeof schema.servers.$inferSelect

/**
 * Minecraft's own defaults (Java Edition 1.21 and later), plus the two Flytower sets on
 * creation. Properties with these values are left out so a spec shows only real choices.
 */
export const PROPERTY_DEFAULTS: Record<string, string> = {
  'accepts-transfers': 'false',
  'allow-flight': 'false',
  'allow-nether': 'true',
  'broadcast-console-to-ops': 'true',
  'broadcast-rcon-to-ops': 'false',
  'bug-report-link': '',
  difficulty: 'easy',
  'enable-command-block': 'false',
  'enable-jmx-monitoring': 'false',
  'enable-query': 'false',
  'enable-status': 'true',
  'enforce-secure-profile': 'true',
  'enforce-whitelist': 'false',
  'entity-broadcast-range-percentage': '100',
  'force-gamemode': 'false',
  'function-permission-level': '2',
  gamemode: 'survival',
  'generate-structures': 'true',
  'generator-settings': '{}',
  hardcore: 'false',
  'hide-online-players': 'false',
  'initial-disabled-packs': '',
  'initial-enabled-packs': 'vanilla',
  'level-name': 'world',
  'level-seed': '',
  'level-type': 'minecraft\\:normal',
  'log-ips': 'true',
  'max-chained-neighbor-updates': '1000000',
  'max-players': '20',
  'max-tick-time': '60000',
  'max-world-size': '29999984',
  motd: 'A Minecraft Server',
  'network-compression-threshold': '256',
  'online-mode': 'true',
  'op-permission-level': '4',
  'pause-when-empty-seconds': '60',
  'player-idle-timeout': '0',
  'prevent-proxy-connections': 'false',
  pvp: 'true',
  'query.port': '25565',
  'rate-limit': '0',
  'region-file-compression': 'deflate',
  'require-resource-pack': 'false',
  'resource-pack': '',
  'resource-pack-id': '',
  'resource-pack-prompt': '',
  'resource-pack-sha1': '',
  'server-ip': '',
  'simulation-distance': '10',
  'spawn-monsters': 'true',
  'spawn-protection': '16',
  'sync-chunk-writes': 'true',
  'text-filtering-config': '',
  'text-filtering-version': '0',
  'use-native-transport': 'true',
  'view-distance': '10',
  'white-list': 'false',
}

/** Values as YAML would write them: numbers and booleans unquoted where that's lossless. */
export function typedValue(value: string): string | number | boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(0|[1-9]\d{0,14})$/.test(value)) return Number(value)
  return value
}

export function specFromServer(
  row: ServerRow,
  props: Record<string, string>,
  /** Off-site storage names by id, to name the server's choice. */
  targets: { id: number; name: string }[] = [],
  /** The server's scheduled tasks, in order. */
  tasks: TaskSpec[] = [],
): ServerSpec {
  const properties: ServerSpec['properties'] = {}
  for (const [key, value] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
    // Managed keys belong to Flytower, and secrets must never reach a shared spec.
    if (isManagedProperty(key)) continue
    // `level-type` is stored escaped by some versions and not others.
    const def = PROPERTY_DEFAULTS[key]
    if (def !== undefined && (value === def || value === def.replace(/\\:/g, ':'))) continue
    properties[key] = typedValue(value)
  }
  return {
    name: row.name,
    displayName: row.displayName,
    loader: {
      type: row.loader,
      minecraft: row.mcVersion,
      ...(row.loaderVersion ? { version: row.loaderVersion } : {}),
    },
    memory: row.memoryMb,
    port: row.port,
    ...(row.hostname ? { hostname: row.hostname } : {}),
    properties,
    content: row.content ?? [],
    backups: {
      schedule: row.backupSchedule,
      timezone: row.backupTz,
      keep: { last: row.keepLast, daily: row.keepDaily, weekly: row.keepWeekly },
      ...(row.offsiteTarget && targets.some((t) => t.id === row.offsiteTarget)
        ? { offsite: targets.find((t) => t.id === row.offsiteTarget)!.name }
        : {}),
    },
    ...(row.restartWhenUnresponsive ? { recovery: { restartWhenUnresponsive: true } } : {}),
    timezone: row.timezone,
    ...(row.publicPage ? { public: readPublicPage(row.publicPage) } : {}),
    ...(!isDefaultStats(readStatsSettings(row.stats))
      ? { stats: readStatsSettings(row.stats) }
      : {}),
    ...(!isDefaultMap(readMapSettings(row.map)) ? { map: readMapSettings(row.map) } : {}),
    ...(!isDefaultTrim(readTrimRules(row.trim))
      ? { world: { trim: readTrimRules(row.trim) } }
      : {}),
    ...(tasks.length ? { schedules: tasks.map((t) => ScheduleItem.parse(toItem(t))) } : {}),
  }
}
