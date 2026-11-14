/**
 * Which permissions a spec change needs. Plan and apply take a whole spec, so a role that may
 * only manage content must not slip a settings change in alongside. Each part of the spec
 * belongs to one permission; a part that's left out or the same as now needs nothing.
 */
import type { ServerSpec } from '../../shared/spec'
import { SERVER_PERMISSIONS, type ServerPermission } from '../../shared/permissions'

type Section = Exclude<keyof ServerSpec, 'name'>

/** Who may change each part of a spec. A new spec field fails typechecking until it's here. */
export const SECTION_PERMISSIONS: Record<Section, ServerPermission> = {
  displayName: 'settings.edit',
  memory: 'settings.edit',
  port: 'settings.edit',
  hostname: 'settings.edit',
  properties: 'settings.edit',
  recovery: 'settings.edit',
  timezone: 'settings.edit',
  loader: 'content.manage',
  content: 'content.manage',
  schedules: 'schedules.manage',
  backups: 'backups.schedule',
  public: 'community.manage',
  stats: 'community.manage',
  map: 'community.manage',
  world: 'world.manage',
}

/** What a refusal calls each permission's part of the server. */
export const SECTION_NAMES: Partial<Record<ServerPermission, string>> = {
  'settings.edit': 'settings',
  'content.manage': 'content',
  'schedules.manage': 'schedules',
  'backups.schedule': 'backup settings',
  'community.manage': 'community features',
  'world.manage': 'world settings',
}

/** JSON with object keys sorted, so key order doesn't count as a change. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}

/**
 * The permissions needed to go from `current` to `next`, in catalogue order. Properties only
 * add or change keys (see makePlan), so only those that differ count. Asking for content
 * upgrades counts as changing content.
 */
export function specNeeds(
  current: ServerSpec,
  next: ServerSpec,
  upgrade?: true | readonly string[],
): ServerPermission[] {
  const needs = new Set<ServerPermission>()
  for (const [key, permission] of Object.entries(SECTION_PERMISSIONS) as [
    Section,
    ServerPermission,
  ][]) {
    const value = next[key]
    if (value === undefined) continue
    if (key === 'properties') {
      const now = current.properties
      const changed = Object.entries(next.properties).some(
        ([k, v]) => !(k in now) || String(now[k]) !== String(v),
      )
      if (changed) needs.add(permission)
      continue
    }
    // A null address and no address are the same.
    if (stable(value ?? null) !== stable(current[key] ?? null)) needs.add(permission)
  }
  if (upgrade === true || (Array.isArray(upgrade) && upgrade.length)) needs.add('content.manage')
  return SERVER_PERMISSIONS.filter((p) => needs.has(p))
}
