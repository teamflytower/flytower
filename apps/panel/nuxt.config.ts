// https://nuxt.com/docs/api/configuration/nuxt-config
let builtServer = false

export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  // The docs/ folder, shared with the website: link handling and help routing.
  extends: ['../../packages/docs-layer'],
  modules: ['@nuxt/ui', '@nuxt/content', 'nuxt-auth-utils'],
  content: {
    build: {
      markdown: {
        toc: { depth: 3 },
        highlight: {
          theme: { default: 'github-light', dark: 'github-dark' },
          langs: ['sh', 'bash', 'yaml', 'json', 'ts', 'ini'],
        },
      },
    },
    // Help is read in the browser from a bundled copy of the docs, so the server's copy only
    // answers the odd fallback query. Keep it in memory: the install folder isn't writable.
    database: { type: 'sqlite', filename: ':memory:' },
    experimental: { sqliteConnector: 'bun' },
    watch: { enabled: false },
  },
  css: ['~/assets/css/main.css'],
  colorMode: { preference: 'dark', fallback: 'dark' },
  app: {
    head: {
      link: [
        // Branding: an uploaded favicon (or Flytower's), and the brand's colours and font as a
        // stylesheet, so they apply before the first paint instead of flashing amber.
        { rel: 'icon', href: '/branding/favicon' },
        { rel: 'stylesheet', href: '/branding/theme.css' },
      ],
    },
  },
  // Fonts come from @fontsource imports in main.css; stop @nuxt/fonts fetching from the web.
  fonts: {
    providers: {
      google: false,
      googleicons: false,
      bunny: false,
      fontshare: false,
      fontsource: false,
      adobe: false,
    },
  },
  // Bundle the icons we use into the client; the panel never fetches icons at runtime.
  icon: { provider: 'none', clientBundle: { scan: true } },
  routeRules: {
    // Moved out of System in 1.2.0.
    '/system/account': { redirect: '/account' },
    '/system/people': { redirect: '/access' },
    '/people': { redirect: '/access' },
    // The panel loads nothing from other sites except content icons (Modrinth, Hangar).
    '/**': {
      headers: {
        'content-security-policy': [
          "default-src 'self'",
          // Nuxt's SPA shell boots with a small inline script.
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join('; '),
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'cross-origin-opener-policy': 'same-origin',
      },
    },
  },
  runtimeConfig: {
    version: '0.0.0-dev',
    agentSocket: '/run/flytower/agent.sock',
    /** The hostname router's control socket (flytower-router, #76). */
    routerSocket: '/run/flytower-router/router.sock',
    dbPath: '/var/lib/flytower/flytower.db',
    /** Where the agent puts server folders; the panel reads logs from here. */
    serversDir: '/srv/flytower/servers',
    backupsDir: '/var/lib/flytower/backups',
    exportsDir: '/var/lib/flytower/exports',
    importsDir: '/var/lib/flytower/imports',
    /** Where the agent archives deleted servers. */
    archiveDir: '/var/lib/flytower-archive',
    /** Player skins from Mojang, cached for drawing heads. */
    skinsDir: '/var/lib/flytower/skins',
    /** Web map tiles, drawn by flytower-map. Outside the servers, so never in backups. */
    mapsDir: '/var/lib/flytower/maps',
    /** Players' modpacks for public pages, rebuilt when a server's content changes. */
    packsDir: '/var/lib/flytower/packs',
    /** Each Minecraft version's commands, from its own reports, for console completion. */
    commandsDir: '/var/lib/flytower/commands',
    /** Where the agent installs Java; the panel reads which versions are there. */
    runtimesDir: '/opt/flytower/runtimes',
    /** Modrinth's API; overridable for a mirror or for tests. */
    modrinthApi: 'https://api.modrinth.com/v2',
    hangarApi: 'https://hangar.papermc.io/api/v1',
    vanillaTweaksSite: 'https://vanillatweaks.net',
    setupTokenFile: '/var/lib/flytower/setup-token.hash',
    /** The machine's public addresses, if its interfaces don't show them (behind NAT). */
    machineIpv4: '',
    machineIpv6: '',
    devSetupToken: '',
    /** Pins the passkey domain; empty means the request's host. */
    rpId: '',
    session: {
      name: 'flytower-session',
      maxAge: 12 * 60 * 60,
      cookie: { sameSite: 'strict' },
    },
  },
  nitro: {
    preset: 'bun',
    experimental: { websocket: true },
  },
  $development: {
    runtimeConfig: {
      dbPath: '.data/flytower.db',
      serversDir: '.data/servers',
      backupsDir: '.data/backups',
      exportsDir: '.data/exports',
      importsDir: '.data/imports',
      archiveDir: '.data/archive',
      skinsDir: '.data/skins',
      mapsDir: '.data/maps',
      packsDir: '.data/packs',
      commandsDir: '.data/commands',
      runtimesDir: '.data/runtimes',
      agentSocket: '.data/agent.sock',
      routerSocket: '.data/router.sock',
      setupTokenFile: '.data/setup-token.hash',
      devSetupToken: 'dev-setup-token',
    },
  },
  typescript: { strict: true },
  hooks: {
    // With @nuxt/content under Bun, `nuxt build` finishes but the process never exits (nothing
    // shows as open; a promise in the build never settles). Once Nitro has compiled the server
    // and Nuxt has closed, end the process with whatever exit code it has. Prepare and
    // typecheck never compile Nitro, so they're untouched.
    // Nuxt Content asks Nitro to prerender each collection's dump, which boots the server
    // app (and opens the panel's database) at build time. The dump has a server route anyway,
    // so serve it from there instead.
    'nitro:config': (config) => {
      for (const [route, rules] of Object.entries(config.routeRules ?? {})) {
        if (route.startsWith('/__nuxt_content/')) delete rules.prerender
      }
    },
    'nitro:init': (nitro) => {
      nitro.hooks.hook('compiled', () => {
        builtServer = true
      })
    },
    close: () => {
      if (builtServer) setTimeout(() => process.exit(), 1000).unref()
    },
  },
})
