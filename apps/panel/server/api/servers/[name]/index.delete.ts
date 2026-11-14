import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '../../../db'
import { forgetMetrics } from '../../../metrics/sampler'

const Params = z.object({ name: z.string().max(40) })
const Body = z.object({ confirm: z.string() })

/**
 * Deletes a server. Needs a fresh passkey check and the name typed back. The agent archives
 * the folder before removing anything, so a mistake can still be undone.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'server.delete')
  const { user } = await requireElevated(event)
  const { name } = await getValidatedRouterParams(event, Params.parse)
  const { confirm } = await readValidatedBody(event, Body.parse)
  findServer(name)
  if (confirm !== name) {
    throw createError({ statusCode: 400, statusMessage: `Type ${name} to confirm.` })
  }

  if (useBackups().isBusy(name)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'A backup or restore is running. Try again when it has finished.',
    })
  }

  useConsole().forget(name)
  let archivedTo: string | null
  try {
    ;({ archivedTo } = await agent('server.delete', { name }, { timeoutMs: 10 * 60_000 }))
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `Couldn't delete ${name}: ${(err as Error).message}`,
    })
  }
  const db = useDb()
  db.delete(schema.servers).where(eq(schema.servers.name, name)).run()
  forgetMetrics(db, name)
  useDiskUsage().forget(name)
  forgetNotifyServer(name)
  forgetRelay(name)
  useSessions().forget(name)
  useStatsSnapshot().forget(name)
  useUpdates().forget(name)
  syncBackupSchedules()
  useSchedules().remove(name)
  await useExports().removeAll(name)
  await useMap().forget(name)
  db.insert(schema.audit)
    .values({ userId: user.id, action: 'server.delete', target: name, detail: { archivedTo } })
    .run()
  await useStatus().poke()
  useRouting().sync()
  return { archivedTo }
})
