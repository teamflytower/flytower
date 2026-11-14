import { readTrimRules, toToolRules } from '../../../../../shared/trim-rules'

/**
 * What the web map shows while trimming is being set up (#303): the saved rules (for the
 * protected areas) and the last preview's chunks that would go. Only for people who can
 * change the world, whatever the map's own settings.
 */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'world.manage')
  const { name } = await worldContext(event)
  const rules = readTrimRules(findServer(name).trim)
  const saved = await useTrimPreviews().get(name)
  const preview = saved && {
    at: saved.at,
    removed: saved.removed,
    // Rules saved since the preview mean it no longer shows what a trim would do.
    stale: JSON.stringify(saved.rules) !== JSON.stringify(toToolRules(rules)),
    bitmap: saved.bitmap,
  }
  setResponseHeader(event, 'cache-control', 'no-store')
  return { rules, preview }
})
