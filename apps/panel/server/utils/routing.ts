import { dirname, join } from 'node:path'
import { callRouter } from '@flytower/protocol/client'
import { MOD_FILE, parseSystemdTime } from '../routing/files'
import { Routing } from '../routing/service'

let routing: Routing | undefined

/**
 * The release's copy of the flytower-proxy mod: mods/ next to bin/, where bin/bun runs the
 * panel. FLYTOWER_PROXY_MOD points elsewhere, for development.
 */
const modPath = () =>
  process.env.FLYTOWER_PROXY_MOD || join(dirname(process.execPath), '..', 'mods', MOD_FILE)

/** The one hostname-routing service for this process (#76). */
export function useRouting(): Routing {
  routing ??= new Routing({
    db: useDb(),
    agent,
    router: (verb, params) =>
      callRouter(verb, params, { socketPath: useRuntimeConfig().routerSocket, timeoutMs: 10_000 }),
    writeProperties,
    statuses: () => useStatus().current(),
    brand: () => useBranding().settings().name,
    serverDir,
    since: async (name) => {
      const { active, since } = await agent('service.status', { server: name })
      return active === 'active' && since ? parseSystemdTime(since) : null
    },
    mod: () =>
      Bun.file(modPath())
        .bytes()
        .catch(() => null),
    fixPermissions: async (name) => {
      await agent('server.permissions', { name }, { timeoutMs: 120_000 })
    },
  })
  return routing
}
