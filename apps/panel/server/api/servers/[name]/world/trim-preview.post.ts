import { readTrimRules, toToolRules } from '../../../../../shared/trim-rules'

/**
 * What "Trim unused chunks" would remove with the server's saved rules: a read-only dry run.
 * The server keeps running. Returns the rules it used, so the trim can be checked against them.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'world.manage')
  const { name, world } = await worldContext(event)
  limit(event, `trim-preview:${name}`, 6, 60_000)
  const rules = readTrimRules(findServer(name).trim)
  const preview = await worldHttp(() => world.trimPreview(name, toToolRules(rules)))
  return { rules, preview }
})
