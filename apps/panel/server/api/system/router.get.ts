import { defaultMessages } from '../../routing/table'

/**
 * One address for every server: the switch, its port and messages, live counts, and which
 * servers see players' real addresses.
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'system.network')
  const routing = useRouting()
  return {
    settings: routing.settings(),
    defaults: defaultMessages(useBranding().settings().name),
    status: await routing.status(),
    addresses: await routing.addresses(),
  }
})
