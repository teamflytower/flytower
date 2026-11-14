import { z } from 'zod'
import {
  TrimRules,
  describeTrim,
  readTrimRules,
  sameTrimRules,
  toToolRules,
} from '../../../../../shared/trim-rules'

const Body = z.object({
  /** The rules the preview used. Trimming refuses if they've been changed since. */
  rules: TrimRules,
  /** Keep the backup taken first forever. */
  keepBackup: z.boolean().optional(),
})

/**
 * Trims unused chunks after a backup, stopping the server while it runs. Needs a recent
 * passkey check.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'world.manage')
  await requireElevated(event)
  const { user, name, world } = await worldContext(event)
  const { rules, keepBackup } = await readValidatedBody(event, Body.parse)
  const saved = readTrimRules(findServer(name).trim)
  if (!sameTrimRules(rules, saved)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'The trim rules changed since this preview. Preview again, then trim.',
    })
  }
  const { jobId } = await worldHttp(() => world.trim(name, toToolRules(saved), { keepBackup }))
  audit(user.id, 'world.trim', name, { rules: describeTrim(saved), keepBackup, jobId })
  useStatus().poke()
  return { jobId }
})
