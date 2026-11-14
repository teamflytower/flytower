import { dirname, join } from 'node:path'
import type { H3Event } from 'h3'
import { z } from 'zod'
import { JobError } from '../jobs/runner'
import { runRenderer } from '../map/service'
import { WorldService } from '../world/service'
import { TrimPreviews, type ToolProgress } from '../world/trim'

let service: WorldService | undefined
let previews: TrimPreviews | undefined

/** The last trim preview of each server, for the web map's overlay. Never served as a file. */
export function useTrimPreviews(): TrimPreviews {
  previews ??= new TrimPreviews(join(useRuntimeConfig().mapsDir, 'trim-previews'))
  return previews
}

/** Where the world tool is: next to Bun in the release's bin/, or wherever FLYTOWER_WORLD says. */
export const worldBinary = () =>
  process.env.FLYTOWER_WORLD || join(dirname(process.execPath), 'flytower-world')

/**
 * Runs flytower-world at low CPU and disk priority, so the Minecraft servers come first. It
 * runs as the panel, after `server.permissions`, like the web map.
 */
function runWorldTool(args: string[], onProgress?: (p: ToolProgress) => void): Promise<string> {
  const low = [
    ...(Bun.which('nice') ? ['nice', '-n', '15'] : []),
    ...(Bun.which('ionice') ? ['ionice', '-c', '3'] : []),
  ]
  return runRenderer([...low, worldBinary(), ...args], onProgress, undefined, 'flytower-world')
}

/** The one world service for this process. */
export function useWorld(): WorldService {
  service ??= new WorldService({
    db: useDb(),
    serverDir,
    agent,
    jobs: useJobs(),
    backups: useBackups(),
    exports: useExports(),
    rcon: (name, command, timeoutMs) =>
      useConsole().command(name, command, { echo: false, timeoutMs }),
    readProperties,
    writeProperties,
    stopped: (name) => useConsole().forget(name),
    worldTool: runWorldTool,
    notify: (e) => useNotify().notify(e),
    trimPreviews: useTrimPreviews(),
  })
  return service
}

const Params = z.object({ name: z.string().max(40) })

/** Signed in and a real server. */
export async function worldContext(event: H3Event) {
  const { user } = await requireUserSession(event)
  const { name } = await getValidatedRouterParams(event, Params.parse)
  findServer(name)
  return { user, name, world: useWorld() }
}

/** World and backup-lock errors become 409s with their message. */
export async function worldHttp<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    // WorldError and BackupError (the server is busy) are both JobErrors.
    if (err instanceof JobError) throw createError({ statusCode: 409, statusMessage: err.message })
    throw err
  }
}
