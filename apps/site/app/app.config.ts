// Flytower website settings. The domain and contact addresses live here and nowhere else.
export default defineAppConfig({
  site: {
    name: 'Flytower',
    url: 'https://flytower.dev',
    email: { hello: 'hello@flytower.dev', privacy: 'privacy@flytower.dev' },
    tagline: 'Run Minecraft servers on your own VPS, from the browser.',
    repo: 'https://github.com/teamflytower/flytower',
    releases: 'https://github.com/teamflytower/flytower/releases',
    sponsors: 'https://github.com/sponsors/MattA-Official',
    kofi: '', // set once the Ko-fi page exists
    discord: '', // set once the Discord server exists
    install:
      'curl -fsSL https://flytower.dev/install.sh | sudo bash -s -- --domain panel.example.com',
  },
  /** Docs are served at /docs; the sidebar groups pages by their `section` frontmatter. */
  docs: { base: '/docs' },
  ui: {
    colors: {
      primary: 'tungsten',
      neutral: 'steel',
      success: 'emerald',
      warning: 'tungsten',
      error: 'red',
      info: 'blue',
    },
  },
})
