/** Turning audit rows into sentences, and grouping their actions for filtering. */
import { humanBytes } from './format'
import { isPermission, PERMISSION_LABELS, type Permission } from '../permissions'

export const AUDIT_KINDS = {
  servers: 'Servers',
  content: 'Changes and content',
  backups: 'Backups',
  world: 'Worlds',
  players: 'Players',
  files: 'Files',
  access: 'Sign-ins and access',
  system: 'Flytower, notifications, branding and Discord',
} as const
export type AuditKind = keyof typeof AUDIT_KINDS

export function auditKind(action: string): AuditKind {
  if (action.startsWith('backup.')) return 'backups'
  if (action.startsWith('world.')) return 'world'
  if (action.startsWith('players.')) return 'players'
  if (action.startsWith('files.')) return 'files'
  if (action === 'server.apply' || action === 'server.properties' || action === 'server.icon') {
    return 'content'
  }
  if (/^(auth|passkey|recovery|setup|ssh|people|account)\./.test(action)) return 'access'
  if (/^(update|notify|branding|discord|disk)\./.test(action)) return 'system'
  return 'servers'
}

/** Things Flytower records by itself, with nobody signed in behind them. */
const BY_FLYTOWER = [
  'people.permissions_split',
  'server.crashed',
  'server.crash_loop',
  'server.unresponsive',
  'schedule.run',
]

/**
 * Who to show for an entry: the person; "Name via Discord" for a slash command; Flytower for
 * its own; otherwise null, for a person who has since been removed.
 */
export function auditActor(
  action: string,
  user: string | null,
  detail: Record<string, unknown> | null = null,
): string | null {
  if (user) return user
  if (detail?.via === 'discord') {
    const name = typeof detail.discordName === 'string' && detail.discordName
    return `${name || 'Someone'} via Discord`
  }
  return BY_FLYTOWER.includes(action) ? 'Flytower' : null
}

/** Detail keys that never leave the server. */
const SECRET = /pass|token|secret|key/i

export function safeDetail(detail: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (SECRET.test(k)) continue
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v
  }
  return out
}

const ROLE_NAMES: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
}

/** "Operator on survival", "Admin on all servers". */
function roleText(d: Record<string, unknown>): string {
  const role = d.roleName ? String(d.roleName) : (ROLE_NAMES[String(d.role)] ?? 'a role')
  return `${role} on ${d.server ? String(d.server) : 'all servers'}`
}

/** "Operator on Survival and Viewer on all servers", from a grant change's detail. */
function grantList(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return ''
  return listText(
    v.map((g: { role?: unknown; server?: unknown }) =>
      roleText({ roleName: g.role, server: g.server ?? null }),
    ),
  )
}

/** "Read files and Change files", from a role change's detail. */
function permissionList(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return ''
  return listText(
    v.map((p) => (isPermission(String(p)) ? PERMISSION_LABELS[p as Permission].label : String(p))),
  )
}

function listText(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))

/** A short sentence, without the person (shown alongside). */
export function describeAudit(
  action: string,
  target: string | null,
  detail: Record<string, unknown> | null,
): string {
  const d = safeDetail(detail)
  const t = target ?? ''
  switch (action) {
    case 'auth.login':
      return 'Signed in with a passkey'
    case 'auth.recovery_code':
      return 'Signed in with a recovery code'
    case 'account.renamed':
      return `Changed their name from ${str(d.from)} to ${str(d.to)}`
    case 'auth.signed_out_everywhere':
      return 'Signed out everywhere else'
    case 'setup.completed':
      return 'Set up Flytower'
    case 'people.invited':
      return `Made an invite link${d.person ? ` for ${str(d.person)}` : ''} (${roleText(d)})`
    case 'people.invite_revoked':
      return `Cancelled an invite link${d.person ? ` for ${str(d.person)}` : ''}`
    case 'people.joined':
      return `Joined as ${roleText(d)}`
    case 'people.changed': {
      const gave = grantList(d.added)
      const took = grantList(d.removed)
      if (!gave && !took) return `Changed what ${str(d.person)} can do`
      if (!gave) return `Took ${took} away from ${str(d.person)}`
      return `Gave ${str(d.person)} ${gave}${took ? `, and took away ${took}` : ''}`
    }
    case 'people.removed':
      return `Removed ${str(d.person)}`
    case 'people.role_saved': {
      const base = `${d.created ? 'Made' : 'Changed'} the ${str(d.name)} role`
      if (d.created) return base
      const added = permissionList(d.added)
      const removed = permissionList(d.removed)
      const parts = [added && `added ${added}`, removed && `removed ${removed}`].filter(Boolean)
      return parts.length ? `${base}: ${parts.join('; ')}` : base
    }
    case 'people.permissions_split':
      return 'Split permissions into finer ones; custom roles kept everything they could do'
    case 'people.role_deleted':
      return `Deleted the ${str(d.name)} role`
    case 'passkey.added':
      return `Added a passkey${d.nickname ? ` (${str(d.nickname)})` : ''}`
    case 'passkey.removed':
      return `Removed a passkey${d.nickname ? ` (${str(d.nickname)})` : ''}`
    case 'recovery.reissued':
      return 'Made new recovery codes'
    case 'ssh.open':
      return `Opened SSH${d.minutes ? ` for ${str(d.minutes)} minutes` : ''}`
    case 'ssh.close':
      return 'Closed SSH'
    case 'router.enable':
      return `Turned on one address for every server, on port ${str(d.port)}`
    case 'router.disable':
      return 'Turned off one address for every server; each server has its own port again'
    case 'router.messages':
      return 'Changed what players see for addresses with no server'
    case 'disk.clean': {
      const n = typeof d.freedBytes === 'number' ? d.freedBytes : null
      const freed = n === null ? '' : n > 0 ? `, freeing ${humanBytes(n)}` : ', which freed nothing'
      if (d.action === 'journal') return `Shrank the system journal to ${str(d.maxMb)} MB${freed}`
      if (d.action === 'apt') return `Cleared the package cache${freed}`
      return `Removed old Flytower versions${freed}`
    }
    case 'update.install':
      return `Updated Flytower to ${str(d.version)}`
    case 'update.rollback':
      return `Went back to Flytower ${str(d.version)}`
    case 'update.channel':
      return d.channel === 'beta'
        ? 'Chose to be offered beta releases'
        : d.channel === 'native'
          ? 'Chose to be offered native builds'
          : 'Chose stable releases only'
    case 'branding.update':
      return `Changed the branding${d.name ? ` (${str(d.name)}, ${str(d.accent)})` : ''}`
    case 'branding.reset':
      return "Reset the branding to Flytower's own"
    case 'branding.logo':
      return 'Uploaded a new logo'
    case 'branding.favicon':
      return 'Uploaded a new favicon'
    case 'branding.logo.remove':
      return 'Removed the logo'
    case 'branding.favicon.remove':
      return 'Removed the favicon'
    case 'server.create':
      return `Created ${t}${d.from === 'spec' ? ' from YAML' : ''}`
    case 'server.import':
      return `Imported ${t}${d.label ? ` from ${str(d.label)}` : ''}`
    case 'server.import.unpack':
      return 'Unpacked an upload to import'
    case 'server.clone':
      return `Cloned ${str(d.from)} as ${t}${d.withWorld === false ? ', without its world' : ''}`
    case 'server.delete':
      return `Deleted ${t}`
    case 'server.start':
      return `Started ${t}`
    case 'server.crashed':
      return `${t} crashed${d.cause ? `. ${str(d.cause)}` : ''}`
    case 'server.crash_loop':
      return `${t} kept crashing, so it was left stopped`
    case 'server.unresponsive':
      return `${t} stopped responding${d.restarted ? ', so it was restarted' : ''}`
    case 'server.recovery':
      return d.restartWhenUnresponsive
        ? `Set ${t} to restart when it stops responding`
        : `Set ${t} not to restart when it stops responding`
    case 'server.map': {
      const was = (d.was ?? {}) as { enabled?: boolean; public?: boolean; players?: boolean }
      if (d.enabled !== was.enabled) {
        return d.enabled ? `Turned on ${t}'s web map` : `Turned off ${t}'s web map`
      }
      if (d.public !== was.public) {
        return d.public ? `Made ${t}'s map public` : `Made ${t}'s map private`
      }
      return d.players ? `Turned on players on ${t}'s map` : `Turned off players on ${t}'s map`
    }
    case 'server.stats':
      if (d.enabled === false && d.was !== false) return `Turned off player stats on ${t}`
      if (d.enabled === true && d.was === false) return `Turned on player stats on ${t}`
      return `Changed who is left out of player stats on ${t}`
    case 'server.discord_relay':
      if (d.on === false) return `Stopped posting ${t}'s chat to Discord`
      if (d.fromDiscord === true && d.wasFromDiscord === false) {
        return `Started showing Discord chat in ${t}`
      }
      if (d.fromDiscord === false && d.wasFromDiscord === true) {
        return `Stopped showing Discord chat in ${t}`
      }
      return d.was
        ? `Changed how ${t}'s chat is posted to Discord`
        : `Started posting ${t}'s chat to Discord`
    case 'server.public_page':
      if (d.enabled === false) return `Turned off ${t}'s public page`
      return d.was === false ? `Turned on ${t}'s public page` : `Changed ${t}'s public page`
    case 'server.stop':
      return `Stopped ${t}`
    case 'server.restart':
      return `Restarted ${t}`
    case 'server.say':
      return `Said “${str(d.message)}” on ${t}`
    case 'server.command':
      return `Ran /${str(d.command).replace(/^\//, '')} on ${t}`
    case 'server.properties':
      return `Changed ${t}'s settings${Array.isArray(d.keys) ? ` (${d.keys.join(', ')})` : ''}`
    case 'server.icon':
      return d.removed ? `Removed ${t}'s icon` : `Changed ${t}'s icon`
    case 'server.resources': {
      const bits = [
        d.memoryMb ? `memory ${Number(d.memoryMb) / 1024} GB` : '',
        d.port ? `port ${str(d.port)}` : '',
        d.hostname === undefined
          ? ''
          : d.hostname
            ? `address ${str(d.hostname)}`
            : 'address removed',
      ].filter(Boolean)
      return bits.length ? `Changed ${t}: ${bits.join(', ')}` : `Changed ${t}'s resources`
    }
    case 'server.apply':
      return `Applied a plan to ${t}`
    case 'backup.create':
      return `Backed up ${t}${d.note ? ` (${str(d.note)})` : ''}`
    case 'backup.delete':
      return `Deleted a backup of ${t}`
    case 'backup.restore':
      return `Restored a backup of ${t}`
    case 'backup.schedule':
      return `Changed ${t}'s backup schedule`
    case 'schedule.update':
      return `Changed ${t}'s scheduled tasks`
    case 'schedule.cancel':
      return `Called off a scheduled restart of ${t}`
    case 'schedule.run':
      return `${t}: ${str(d.task)}. ${str(d.result)}`
    case 'backup.offsite':
      return d.target
        ? `Started copying ${t}'s backups to ${str(d.target)}`
        : `Stopped copying ${t}'s backups off-site`
    case 'backup.target.add':
      return `Added the off-site backup target ${str(d.name)}`
    case 'backup.target.remove':
      return `Removed the off-site backup target ${str(d.name)}`
    case 'notify.channel.add':
      return `Added the notification channel ${str(d.name)}`
    case 'notify.channel.edit':
      return `Changed the notification channel ${str(d.name)}`
    case 'notify.channel.remove':
      return `Removed the notification channel ${str(d.name)}`
    case 'discord.connect':
      return `Connected the Discord app ${str(d.name)}`
    case 'discord.disconnect':
      return `Disconnected the Discord app ${str(d.name)}`
    case 'discord.roles':
      return Array.isArray(d.mappings) && d.mappings.length
        ? `Changed which Discord roles get Flytower roles (${d.mappings.join('; ')})`
        : 'Took away access from all Discord roles'
    case 'discord.chat':
      return d.on ? 'Turned on chat from Discord' : 'Turned off chat from Discord'
    case 'discord.refused':
      return `Tried /${str(d.command)}${t ? ` on ${t}` : ''} without access`
    case 'world.export':
      return `Exported ${t}'s world`
    case 'world.export.delete':
      return `Deleted an export of ${t}'s world`
    case 'world.share':
      return `Shared an export of ${t}'s world by link`
    case 'world.share.revoke':
      return `Revoked a share link for ${t}'s world`
    case 'world.reset':
      return `Reset ${t}'s world${d.seed ? ` with seed ${str(d.seed)}` : d.random ? ' with a new seed' : ''}`
    case 'world.copy':
      return `Copied ${str(d.from)}'s world into ${t}`
  }
  if (action.startsWith('world.pregen.')) {
    const what = action.slice(13)
    return what === 'start'
      ? `Started pre-generating ${t}${d.radius ? `, radius ${str(d.radius)}` : ''}`
      : `${what === 'continue' ? 'Continued' : what === 'pause' ? 'Paused' : 'Cancelled'} pre-generation on ${t}`
  }
  if (action.startsWith('players.')) {
    const verbs: Record<string, string> = {
      'whitelist-add': 'Whitelisted',
      'whitelist-remove': 'Took off the whitelist:',
      op: 'Made operator:',
      deop: 'Removed operator:',
      ban: 'Banned',
      pardon: 'Unbanned',
      kick: 'Kicked',
    }
    const verb = verbs[action.slice(8)] ?? action.slice(8)
    return `${verb} ${str(d.player)} on ${t}${d.reason ? ` (${str(d.reason)})` : ''}`
  }
  if (action.startsWith('files.')) {
    const what = action.slice(6)
    if (what === 'rename') return `Renamed ${str(d.from)} to ${str(d.to)} on ${t}`
    const verb =
      { upload: 'Uploaded', delete: 'Deleted', mkdir: 'Made folder', write: 'Edited' }[what] ?? what
    return `${verb} ${str(d.path ?? d.file)} on ${t}`
  }
  return `${action}${t ? ` on ${t}` : ''}`
}
