import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '../../../../db'
import {
  TrimRules,
  describeTrim,
  readTrimRules,
  sameTrimRules,
} from '../../../../../shared/trim-rules'

const Params = z.object({ name: z.string().max(40) })

/**
 * Saves what "Trim unused chunks" keeps: the same rules as the spec's `world.trim`. Saving
 * never trims anything and never restarts the server.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'world.manage')
  const { user } = await requireUserSession(event)
  const { name } = await getValidatedRouterParams(event, Params.parse)
  const body = await readValidatedBody(event, TrimRules.parse)
  const server = findServer(name)
  const was = readTrimRules(server.trim)
  if (sameTrimRules(was, body)) return { changed: false, rules: was }
  useDb().update(schema.servers).set({ trim: body }).where(eq(schema.servers.name, name)).run()
  audit(user.id, 'world.trim_rules', name, { summary: describeTrim(body), was: describeTrim(was) })
  return { changed: true, rules: body }
})
