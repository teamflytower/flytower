/**
 * What a person can do in the panel. Every API route and live topic checks one of these
 * through `requirePermission`; roles are just named sets of them.
 */

/** Granted for one server, or for all servers. */
export const SERVER_PERMISSIONS = [
  'server.view',
  'server.power',
  'console.read',
  'console.command',
  'players.manage',
  'backups.create',
  'backups.download',
  'backups.restore',
  'backups.delete',
  'backups.schedule',
  'world.manage',
  'files.read',
  'files.write',
  'settings.edit',
  'content.manage',
  'schedules.manage',
  'community.manage',
  'spec.edit',
  'access.manage',
  'server.delete',
] as const

/** Only count when the role is granted for all servers. */
export const INSTALL_PERMISSIONS = [
  'servers.create',
  'people.invite',
  'people.manage',
  'roles.manage',
  'system.updates',
  'system.notifications',
  'system.integrations',
  'system.branding',
  'system.ssh',
  'system.network',
  'activity.all',
] as const

export type ServerPermission = (typeof SERVER_PERMISSIONS)[number]
export type InstallPermission = (typeof INSTALL_PERMISSIONS)[number]
export type Permission = ServerPermission | InstallPermission

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...SERVER_PERMISSIONS,
  ...INSTALL_PERMISSIONS,
]

export const isServerPermission = (p: Permission): p is ServerPermission =>
  (SERVER_PERMISSIONS as readonly string[]).includes(p)

export const isPermission = (p: string): p is Permission =>
  (ALL_PERMISSIONS as readonly string[]).includes(p)

/**
 * Permissions that bring others with them, because one is no use without the other. Every
 * server permission also brings `server.view` (see `expandPermissions`).
 */
export const IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  'console.command': ['console.read'],
  'files.write': ['files.read'],
  'spec.edit': [
    'settings.edit',
    'content.manage',
    'schedules.manage',
    'community.manage',
    'backups.schedule',
  ],
  'people.manage': ['people.invite'],
}

/**
 * Keys from before 1.4.0 that were split into finer ones. Migration 0022 rewrote stored roles;
 * this catches a row it missed, so nobody loses access. (`people.manage` kept its name, so it
 * can't be told apart here and relies on the migration alone.)
 */
const RETIRED: Record<string, readonly Permission[]> = {
  'server.configure': [
    'spec.edit',
    'settings.edit',
    'content.manage',
    'schedules.manage',
    'community.manage',
    'backups.schedule',
  ],
  'system.manage': [
    'system.updates',
    'system.notifications',
    'system.integrations',
    'system.branding',
    'system.ssh',
  ],
}

/**
 * A role's stored keys as what they really allow: retired keys swapped for their
 * replacements, unknown keys dropped, and seeing the server added to anything done on one.
 * In catalogue order. Implied permissions are added when a role is saved (`withImplied`),
 * not here, so a role saved before 1.4.0 can do exactly what it could then.
 */
export function expandPermissions(keys: readonly string[]): Permission[] {
  const out = new Set<Permission>()
  for (const k of keys) {
    if (isPermission(k)) out.add(k)
    else for (const p of RETIRED[k] ?? []) out.add(p)
  }
  if ([...out].some(isServerPermission)) out.add('server.view')
  return ALL_PERMISSIONS.filter((p) => out.has(p))
}

/** `keys` with everything they imply (see IMPLIES), as a role is saved. */
export function withImplied(keys: readonly string[]): Permission[] {
  const out = new Set<Permission>()
  const add = (p: Permission) => {
    if (out.has(p)) return
    out.add(p)
    for (const q of IMPLIES[p] ?? []) add(q)
  }
  for (const p of expandPermissions(keys)) add(p)
  return expandPermissions([...out])
}

/** How the role editor groups permissions. Every permission is in exactly one area. */
export const PERMISSION_AREAS: { label: string; install: boolean; permissions: Permission[] }[] = [
  { label: 'See', install: false, permissions: ['server.view'] },
  {
    label: 'Power and console',
    install: false,
    permissions: ['server.power', 'console.read', 'console.command'],
  },
  { label: 'Players', install: false, permissions: ['players.manage'] },
  {
    label: 'Backups',
    install: false,
    permissions: [
      'backups.create',
      'backups.download',
      'backups.restore',
      'backups.delete',
      'backups.schedule',
    ],
  },
  { label: 'World', install: false, permissions: ['world.manage'] },
  { label: 'Files', install: false, permissions: ['files.read', 'files.write'] },
  {
    label: 'Settings',
    install: false,
    permissions: [
      'settings.edit',
      'content.manage',
      'schedules.manage',
      'community.manage',
      'spec.edit',
      'server.delete',
    ],
  },
  { label: 'Access', install: false, permissions: ['access.manage'] },
  { label: 'Servers', install: true, permissions: ['servers.create', 'activity.all'] },
  {
    label: 'People',
    install: true,
    permissions: ['people.invite', 'people.manage', 'roles.manage'],
  },
  {
    label: 'Flytower',
    install: true,
    permissions: [
      'system.updates',
      'system.notifications',
      'system.integrations',
      'system.branding',
      'system.ssh',
      'system.network',
    ],
  },
]

/**
 * Permissions that amount to full control of a server or the machine, and why. The role
 * editor marks them, so nobody hands them out without knowing.
 */
export const POWERFUL: Partial<Record<Permission, string>> = {
  'console.command': 'Anything an operator can type, including making someone an operator.',
  'files.write': 'Can add a mod or plugin, which is code running on the machine.',
  'content.manage': 'Can add a mod or plugin, which is code running on the machine.',
  'spec.edit': 'Changes everything about the server at once, including its content.',
  'access.manage': 'Can bring people onto this server with any access they have on it.',
  'people.manage': 'Can give others any access they have themselves.',
  'roles.manage': 'Changing a role changes everyone who has it.',
  'system.updates': 'Can move Flytower to another version or channel.',
  'system.ssh': 'A shell on the machine Flytower runs on.',
  'system.network': "Changes the machine's firewall and how players reach every server.",
}

/**
 * For each permission that comes along with another in `keys`, the first one that brings
 * it: the editor ticks and locks those, saying why.
 */
export function impliedBy(keys: readonly Permission[]): Partial<Record<Permission, Permission>> {
  const out: Partial<Record<Permission, Permission>> = {}
  const walk = (from: Permission, p: Permission) => {
    for (const q of IMPLIES[p] ?? []) {
      if (out[q]) continue
      out[q] = from
      walk(from, q)
    }
  }
  for (const p of keys) walk(p, p)
  const onServer = keys.find((p) => p !== 'server.view' && isServerPermission(p))
  if (onServer && !out['server.view']) out['server.view'] = onServer
  return out
}

export type BuiltInRole = 'owner' | 'admin' | 'operator' | 'viewer'

/** The roles every install has. Their permissions live here, so an update can widen them. */
export const BUILT_IN_ROLES: Record<BuiltInRole, { name: string; permissions: Permission[] }> = {
  owner: { name: 'Owner', permissions: [...ALL_PERMISSIONS] },
  // Everything on their servers except bringing people in, which Admins never had.
  admin: {
    name: 'Admin',
    permissions: [...SERVER_PERMISSIONS.filter((p) => p !== 'access.manage'), 'servers.create'],
  },
  operator: {
    name: 'Operator',
    permissions: [
      'server.view',
      'server.power',
      'console.read',
      'console.command',
      'players.manage',
      'backups.create',
    ],
  },
  viewer: { name: 'Viewer', permissions: ['server.view'] },
}

export const isBuiltInRole = (id: string): id is BuiltInRole => id in BUILT_IN_ROLES

/** One grant: a role, for one server or (server null) for all of them. */
export interface Grant {
  /** Stored keys; retired and implied ones are sorted out by `expandPermissions`. */
  permissions: readonly string[]
  server: string | null
}

/**
 * Everything one person can do, folded from their grants. Sent to the browser as-is
 * (`/api/auth/state`) so the UI can hide what they can't use.
 */
export interface Access {
  /** From grants for all servers: install permissions, and server permissions everywhere. */
  all: Permission[]
  /** Server permissions from grants for single servers, by server name. */
  servers: Record<string, ServerPermission[]>
}

export function foldGrants(grants: readonly Grant[]): Access {
  const all = new Set<Permission>()
  const servers: Record<string, Set<ServerPermission>> = {}
  for (const g of grants) {
    for (const p of expandPermissions(g.permissions)) {
      if (g.server === null) all.add(p)
      else if (isServerPermission(p)) (servers[g.server] ??= new Set()).add(p)
    }
  }
  return {
    all: ALL_PERMISSIONS.filter((p) => all.has(p)),
    servers: Object.fromEntries(
      Object.entries(servers).map(([name, set]) => [
        name,
        SERVER_PERMISSIONS.filter((p) => set.has(p)),
      ]),
    ),
  }
}

/** Whether `access` allows `permission`, on `server` for server permissions. */
export function can(access: Access, permission: Permission, server?: string): boolean {
  if (access.all.includes(permission)) return true
  if (!server || !isServerPermission(permission)) return false
  return access.servers[server]?.includes(permission) ?? false
}

/** Whether `access` allows `permission` on at least one server. */
export function canAnywhere(access: Access, permission: ServerPermission): boolean {
  return (
    access.all.includes(permission) ||
    Object.values(access.servers).some((ps) => ps.includes(permission))
  )
}

export const NO_ACCESS: Access = { all: [], servers: {} }

/** What each permission lets someone do, for the role editor. */
export const PERMISSION_LABELS: Record<Permission, { label: string; help: string }> = {
  'server.view': { label: 'See the server', help: "Status, settings, who's online, backups list." },
  'server.power': { label: 'Start and stop', help: 'Start, stop and restart.' },
  'console.read': { label: 'Read the console and logs', help: "They show players' IP addresses." },
  'console.command': { label: 'Send console commands', help: 'Anything an operator can type.' },
  'players.manage': { label: 'Manage players', help: 'Whitelist, operators, bans and kicks.' },
  'backups.create': { label: 'Take backups', help: 'Back up now and send backups off-site.' },
  'backups.download': {
    label: 'Download worlds',
    help: 'Backups, exports and share links hold the whole world.',
  },
  'backups.restore': { label: 'Restore backups', help: 'Replaces the world.' },
  'backups.delete': { label: 'Delete backups', help: 'Backups, exports and past worlds.' },
  'backups.schedule': {
    label: 'Change backup settings',
    help: 'Backup schedule, how many to keep and off-site copies.',
  },
  'world.manage': { label: 'Manage the world', help: 'Reset, copy, pregenerate and export.' },
  'files.read': { label: 'Read files', help: 'The Files tab, read only.' },
  'files.write': { label: 'Change files', help: 'Upload, edit, rename and delete.' },
  'settings.edit': {
    label: 'Change settings',
    help: 'Properties, MOTD, icon, memory, recovery, address and time zone.',
  },
  'content.manage': {
    label: 'Manage content',
    help: 'Mods, plugins, datapacks and the game version.',
  },
  'schedules.manage': { label: 'Manage schedules', help: 'Scheduled tasks, and running them now.' },
  'community.manage': {
    label: 'Manage community features',
    help: 'Public page, stats, Discord chat and the web map.',
  },
  'spec.edit': { label: 'Edit the YAML', help: 'Change any part of the server in one go.' },
  'access.manage': {
    label: 'Manage who has access',
    help: 'Give and take roles on this server, and invite people to it.',
  },
  'server.delete': { label: 'Delete the server', help: 'Gone for good, after a passkey check.' },
  'servers.create': { label: 'Create servers', help: 'New, imported and cloned servers.' },
  'people.invite': { label: 'Invite people', help: 'Make and cancel invite links.' },
  'people.manage': { label: 'Manage people', help: "Change people's roles and remove them." },
  'roles.manage': {
    label: 'Manage roles',
    help: 'Make and change custom roles, and map Discord roles to them.',
  },
  'system.updates': { label: 'Update Flytower', help: 'Updates, the update channel and disk use.' },
  'system.notifications': { label: 'Manage notifications', help: 'Where alerts are sent.' },
  'system.integrations': {
    label: 'Manage integrations',
    help: 'The Discord app and off-site storage.',
  },
  'system.branding': { label: 'Change branding', help: 'Name, logo, colours and fonts.' },
  'system.ssh': { label: 'Open SSH', help: 'A shell on the machine Flytower runs on.' },
  'system.network': {
    label: 'Manage addresses',
    help: 'One address for every server, and the firewall that goes with it.',
  },
  'activity.all': { label: 'See all activity', help: 'Otherwise only for servers they can see.' },
}
