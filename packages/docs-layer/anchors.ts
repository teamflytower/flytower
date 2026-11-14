/**
 * Named places in the panel that the docs can point at (#270).
 *
 * A control the docs talk about carries `data-doc="<id>"` in the panel, and its id is listed
 * here once. The docs then name it with `:ui{anchor="<id>"}`: the website shows a chip that
 * looks like the control, and the panel's Help shows the same chip as a button that goes to
 * the control and lights it up ("Show me").
 *
 * Pure TypeScript with no Nuxt imports, so `bun test` can check that the docs, this list and
 * the panel agree.
 */

export type DocAnchorKind = 'button' | 'field' | 'section' | 'card'

export interface DocAnchor {
  /** What the control is called in the panel, word for word, e.g. "Back up now". */
  label: string
  /**
   * The panel page that shows it. `:name` is filled with a server; `#<id>` opens a World or
   * Settings section.
   */
  route: string
  kind: DocAnchorKind
  /** The control's icon, so the chip looks like it. */
  icon?: string
  /**
   * The permission needed to see or use it, for a clearer message when it isn't there.
   * A name from the panel's permissions list, e.g. "backups.create".
   */
  need?: string
  /** When it only shows some of the time: "it shows once …", e.g. "there's a task". */
  shownWhen?: string
  /**
   * Help may press it for you: `:ui{anchor="…" do}`. Only for safe controls whose own
   * confirm, passkey check and permissions then take over, so Help can do nothing the
   * control wouldn't. Keep this list short.
   */
  action?: true
}

export const docAnchors = {
  // Your first server
  'servers.new': {
    label: 'New server',
    route: '/',
    kind: 'button',
    icon: 'i-lucide-plus',
    need: 'servers.create',
  },
  'new-server.name': {
    label: 'Name',
    route: '/servers/new',
    kind: 'field',
    need: 'servers.create',
  },
  'new-server.loader': {
    label: 'Loader',
    route: '/servers/new',
    kind: 'field',
    need: 'servers.create',
  },
  'new-server.memory': {
    label: 'Memory',
    route: '/servers/new',
    kind: 'field',
    need: 'servers.create',
  },
  'new-server.port': {
    label: 'Port',
    route: '/servers/new',
    kind: 'field',
    need: 'servers.create',
  },
  'new-server.create': {
    label: 'Create server',
    route: '/servers/new',
    kind: 'button',
    need: 'servers.create',
  },

  // Backups
  'world.backups': {
    label: 'Backups',
    route: '/servers/:name/world#backups',
    kind: 'section',
    icon: 'i-lucide-archive',
  },
  'backups.back-up-now': {
    label: 'Back up now',
    route: '/servers/:name/world#backups',
    kind: 'button',
    icon: 'i-lucide-archive',
    need: 'backups.create',
    action: true,
  },
  'backups.schedule': {
    label: 'Schedule',
    route: '/servers/:name/world#backups',
    kind: 'card',
    icon: 'i-lucide-calendar-clock',
    need: 'backups.schedule',
  },
  'backups.keep': {
    label: 'Keep',
    route: '/servers/:name/world#backups',
    kind: 'field',
    need: 'backups.schedule',
    shownWhen: 'Back up is set to a schedule',
  },

  // Scheduled tasks
  'settings.schedules': {
    label: 'Schedules',
    route: '/servers/:name/settings#schedules',
    kind: 'section',
    icon: 'i-lucide-calendar-clock',
  },
  'schedules.add-task': {
    label: 'Add task',
    route: '/servers/:name/settings#schedules',
    kind: 'button',
    icon: 'i-lucide-plus',
    need: 'schedules.manage',
  },
  'schedules.run-now': {
    label: 'Run now',
    route: '/servers/:name/settings#schedules',
    kind: 'button',
    icon: 'i-lucide-play',
    need: 'schedules.manage',
    shownWhen: 'there is a task on the list',
  },

  // People and roles
  'access.invite': {
    label: 'Invite someone',
    route: '/access',
    kind: 'button',
    icon: 'i-lucide-user-plus',
    need: 'people.invite',
  },
  'access.new-role': {
    label: 'New role',
    route: '/access/roles',
    kind: 'button',
    icon: 'i-lucide-plus',
    need: 'roles.manage',
  },

  // A server's header, on every tab
  'server.start': {
    label: 'Start',
    route: '/servers/:name',
    kind: 'button',
    icon: 'i-lucide-play',
    need: 'server.power',
    shownWhen: 'the server is stopped',
    action: true,
  },
  'server.restart': {
    label: 'Restart',
    route: '/servers/:name',
    kind: 'button',
    icon: 'i-lucide-rotate-cw',
    need: 'server.power',
    shownWhen: 'the server is running',
    action: true,
  },
  'server.stop': {
    label: 'Stop',
    route: '/servers/:name',
    kind: 'button',
    icon: 'i-lucide-square',
    need: 'server.power',
    shownWhen: 'the server is running',
    action: true,
  },
  'server.copy-address': {
    label: 'Copy address',
    route: '/servers/:name',
    kind: 'button',
    icon: 'i-lucide-copy',
    action: true,
  },

  // Your account
  'account.passkeys': {
    label: 'Your passkeys',
    route: '/account',
    kind: 'card',
    icon: 'i-lucide-key-round',
  },
  'account.add-passkey': {
    label: 'Add a passkey',
    route: '/account',
    kind: 'button',
    icon: 'i-lucide-plus',
  },
  'account.recovery-codes': {
    label: 'Make new codes',
    route: '/account',
    kind: 'button',
  },

  // Mods, plugins and datapacks
  'content.add': {
    label: 'Add content',
    route: '/servers/:name/content',
    kind: 'button',
    icon: 'i-lucide-plus',
    need: 'content.manage',
  },
  'content.vanilla-tweaks': {
    label: 'Vanilla Tweaks',
    route: '/servers/:name/content',
    kind: 'button',
    icon: 'i-lucide-sparkles',
    need: 'content.manage',
  },

  // Web map
  'world.map': {
    label: 'Web map',
    route: '/servers/:name/world#map',
    kind: 'card',
    icon: 'i-lucide-map',
  },
  'map.enable': {
    label: 'Draw a web map',
    route: '/servers/:name/world#map',
    kind: 'field',
    need: 'world.manage',
  },

  // Trim rules, in the World tab's Tools
  'world.trim': {
    label: 'Trim unused chunks',
    route: '/servers/:name/world#tools',
    kind: 'card',
    icon: 'i-lucide-scissors',
  },
  'world.trim-rules': {
    label: 'What trimming keeps',
    route: '/servers/:name/world#tools',
    kind: 'section',
    icon: 'i-lucide-scissors',
    need: 'world.manage',
  },
  'trim.open': {
    label: 'Preview and trim',
    route: '/servers/:name/world#tools',
    kind: 'button',
    icon: 'i-lucide-scissors',
    need: 'world.manage',
    action: true,
  },

  // Public page and Discord chat, in a server's Settings, Community
  'community.public-page': {
    label: 'Public page',
    route: '/servers/:name/settings#community',
    kind: 'card',
    icon: 'i-lucide-globe',
  },
  'public-page.enable': {
    label: 'Show a public page for this server',
    route: '/servers/:name/settings#community',
    kind: 'field',
    need: 'community.manage',
  },
  'community.discord-chat': {
    label: 'Discord chat',
    route: '/servers/:name/settings#community',
    kind: 'card',
    icon: 'i-lucide-message-square',
  },
  'discord-chat.webhook': {
    label: 'Channel webhook URL',
    route: '/servers/:name/settings#community',
    kind: 'field',
    need: 'community.manage',
  },

  // System
  'system.discord': {
    label: 'Discord app',
    route: '/system/integrations',
    kind: 'card',
    icon: 'i-lucide-message-square-code',
    need: 'system.integrations',
  },
  'discord.token': {
    label: 'Bot token',
    route: '/system/integrations',
    kind: 'field',
    need: 'system.integrations',
  },
  'system.notifications': {
    label: 'Notifications',
    route: '/system/notifications',
    kind: 'card',
    icon: 'i-lucide-bell',
    need: 'system.notifications',
  },
  'notifications.add': {
    label: 'Add channel',
    route: '/system/notifications',
    kind: 'button',
    icon: 'i-lucide-plus',
    need: 'system.notifications',
  },
  'branding.form': {
    label: 'Name, colour and font',
    route: '/system/branding',
    kind: 'card',
    icon: 'i-lucide-palette',
    need: 'system.branding',
  },
  'branding.name': {
    label: 'Name',
    route: '/system/branding',
    kind: 'field',
    need: 'system.branding',
  },
  'branding.colour': {
    label: 'Accent colour',
    route: '/system/branding',
    kind: 'field',
    need: 'system.branding',
  },
  'system.disk': {
    label: 'Disk',
    route: '/system',
    kind: 'card',
    icon: 'i-lucide-hard-drive',
  },
  'disk.measure-now': {
    label: 'Measure now',
    route: '/system',
    kind: 'button',
    icon: 'i-lucide-refresh-cw',
    need: 'system.updates',
  },
} as const satisfies Record<string, DocAnchor>

export type DocAnchorId = keyof typeof docAnchors

/** The anchor with this id, or null if there's no such anchor. */
export function docAnchor(id: string): DocAnchor | null {
  return Object.hasOwn(docAnchors, id) ? docAnchors[id as DocAnchorId] : null
}

/** Whether the anchor's page belongs to one server, so Show me needs to know which. */
export function needsServer(anchor: DocAnchor): boolean {
  return anchor.route.split('#')[0]!.split('/').includes(':name')
}

/**
 * The route to open for an anchor: `:name` becomes the server (encoded), and the `#section`
 * stays so World and Settings open it.
 */
export function anchorRoute(anchor: DocAnchor, server?: string): string {
  return anchor.route.replace(/:name\b/g, () => {
    if (!server) throw new Error(`"${anchor.label}" is on a server's page; say which server`)
    return encodeURIComponent(server)
  })
}

/** The CSS selector for an anchor's element in the panel. */
export function anchorSelector(id: string): string {
  return `[data-doc="${id.replace(/["\\]/g, '\\$&')}"]`
}

/** Whether Help may press this control for you (`do`). */
export function canDo(id: string): boolean {
  return docAnchor(id)?.action === true
}

/** Every `:ui` on a docs page that asks Help to press its control (`do`). */
export function actionsInMarkdown(markdown: string): string[] {
  const found: string[] = []
  for (const [, attrs] of markdown.matchAll(/:ui(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    if (!/(?:^|\s)do(?:\s|=|$)/.test(attrs!)) continue
    const id = /\banchor="([^"]*)"/.exec(attrs!)?.[1]
    if (id) found.push(id)
  }
  return found
}

/** Every anchor a docs page names, in `:ui{anchor="…"}` (and later blocks) order. */
export function anchorsInMarkdown(markdown: string): string[] {
  const found: string[] = []
  for (const [, attrs] of markdown.matchAll(/:{1,2}[a-z][\w-]*\{([^}]*)\}/g)) {
    for (const [, value] of attrs!.matchAll(/\banchor="([^"]*)"/g)) found.push(value!)
  }
  return found
}
