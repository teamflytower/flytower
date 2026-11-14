import { z } from 'zod'
import { RouterMessages } from '@flytower/protocol'
import { RoutingError } from '../../routing/service'

const Body = z.union([
  z.object({
    enabled: z.literal(true),
    port: z.number().int().min(1024).max(65535),
    messages: RouterMessages.optional(),
  }),
  z.object({ enabled: z.literal(false) }),
  z.object({ messages: RouterMessages }),
])

/**
 * Turns one address for every server on or off, or changes its messages. Turning it on or
 * off changes the firewall, so it needs a recent passkey check.
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'system.network')
  const body = await readValidatedBody(event, Body.parse)
  const routing = useRouting()
  try {
    if ('enabled' in body) {
      const { user } = await requireElevated(event)
      if (body.enabled) {
        const { moved } = await routing.enable(body.port, body.messages)
        audit(user.id, 'router.enable', null, { port: body.port, moved })
        return { moved }
      }
      await routing.disable()
      audit(user.id, 'router.disable', null)
      return { moved: [] }
    }
    const { user } = await requireUserSession(event)
    await routing.saveMessages(body.messages)
    audit(user.id, 'router.messages', null)
    return { moved: [] }
  } catch (err) {
    if (err instanceof RoutingError)
      throw createError({ statusCode: 409, statusMessage: err.message })
    throw createError({ statusCode: 502, statusMessage: (err as Error).message })
  }
})
