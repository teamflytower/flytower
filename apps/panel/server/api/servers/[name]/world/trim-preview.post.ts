import { readTrimRules, toToolRules } from '../../../../../shared/trim-rules'

/**
 * Starts a read-only dry run of "Trim unused chunks" with the server's saved rules. The
 * server keeps running. It runs in the background, since a big world takes minutes: progress
 * and the result go to the `trim:<name>` topic. Returns where the preview is now.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'world.manage')
  const { name, world } = await worldContext(event)
  limit(event, `trim-preview:${name}`, 6, 60_000)
  const rules = readTrimRules(findServer(name).trim)
  const state = await worldHttp(() => world.startTrimPreview(name, toToolRules(rules)))
  return { rules, state }
})
