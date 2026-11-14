import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readPublicPage, type PublicPage } from '../../shared/public-page'
import { readStatsSettings } from '../../shared/stats-settings'
import { readMapSettings } from '../../shared/map-settings'
import { readTrimRules } from '../../shared/trim-rules'
import { relayView } from '../../shared/discord-relay'
import { eq } from 'drizzle-orm'
import { schema } from '../db'
import type { ServiceState } from '../jobs/status'
import type { Health } from '../crashes/monitor'
import { ICON_FILE } from '../icon'

type Row = typeof schema.servers.$inferSelect

/** A server as the browser sees it. The RCON password stays on the server. */
export function publicServer(row: Row, status: ServiceState, health?: Health) {
  return {
    name: row.name,
    displayName: row.displayName,
    loader: row.loader,
    mcVersion: row.mcVersion,
    loaderVersion: row.loaderVersion,
    javaMajor: row.javaMajor,
    memoryMb: row.memoryMb,
    port: row.port,
    hostname: row.hostname,
    createdAt: row.createdAt,
    restartWhenUnresponsive: row.restartWhenUnresponsive,
    publicPage: readPublicPage(row.publicPage),
    stats: readStatsSettings(row.stats),
    map: readMapSettings(row.map),
    trim: readTrimRules(row.trim),
    discordRelay: relayView(row.discordRelay, discordInbound),
    status,
    health: health ?? { condition: null, crash: null },
    icon: iconUrl(row.name),
  }
}

/**
 * Where the panel loads the server's icon from, or null if it has none. The file's time is
 * in the URL, so a new icon is never hidden by the browser's cache.
 */
export function iconUrl(name: string): string | null {
  try {
    const st = statSync(join(serverDir(name), ICON_FILE))
    return st.isFile() ? `/api/servers/${name}/icon?v=${Math.floor(st.mtimeMs)}` : null
  } catch {
    return null
  }
}

export type PublicServer = ReturnType<typeof publicServer>

export function findServer(name: string): Row {
  const row = useDb().select().from(schema.servers).where(eq(schema.servers.name, name)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: `No server called ${name}.` })
  return row
}

/**
 * A server whose public page is on. Anything else, including a server that doesn't exist,
 * is the same 404, so the public routes can't be used to find out which servers there are.
 */
export function findPublicServer(name: string): Row & { publicPage: PublicPage } {
  const row = useDb().select().from(schema.servers).where(eq(schema.servers.name, name)).get()
  const page = readPublicPage(row?.publicPage)
  if (!row || !page.enabled) throw createError({ statusCode: 404, statusMessage: 'Not found.' })
  return { ...row, publicPage: page }
}
