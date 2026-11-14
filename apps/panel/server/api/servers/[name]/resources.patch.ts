import { and, eq, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '../../../db'
import { budgetProblem } from '../../../memory'
import { Hostname } from '../../../../shared/spec'

const Params = z.object({ name: z.string().max(40) })
const Body = z
  .object({
    memoryMb: z.number().int().min(1024).max(65536).optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    hostname: z.union([Hostname, z.literal('').transform(() => null), z.null()]).optional(),
  })
  .refine(
    (b) => b.memoryMb !== undefined || b.port !== undefined || b.hostname !== undefined,
    'Nothing to change.',
  )

/** Changes memory, the game port and/or the hostname. Memory and port apply on the next restart. */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'settings.edit')
  const { user } = await requireUserSession(event)
  const { name } = await getValidatedRouterParams(event, Params.parse)
  const body = await readValidatedBody(event, Body.parse)
  const server = findServer(name)
  const db = useDb()

  const port = body.port !== undefined && body.port !== server.port ? body.port : undefined
  const memoryMb =
    body.memoryMb !== undefined && body.memoryMb !== server.memoryMb ? body.memoryMb : undefined
  const hostname =
    body.hostname !== undefined && body.hostname !== server.hostname ? body.hostname : undefined
  if (port === undefined && memoryMb === undefined && hostname === undefined) {
    return { changed: false }
  }
  if (hostname) {
    const taken = db
      .select({ name: schema.servers.name })
      .from(schema.servers)
      .where(and(ne(schema.servers.name, name), eq(schema.servers.hostname, hostname)))
      .get()
    if (taken) {
      throw createError({
        statusCode: 409,
        statusMessage: `${hostname} is already ${taken.name}'s address.`,
      })
    }
  }

  if (port !== undefined) {
    const clash = db
      .select({ name: schema.servers.name })
      .from(schema.servers)
      .where(
        and(
          ne(schema.servers.name, name),
          or(eq(schema.servers.port, port), eq(schema.servers.rconPort, port)),
        ),
      )
      .get()
    if (useRouting().reservedPorts().includes(port)) {
      throw createError({
        statusCode: 409,
        statusMessage: `Port ${port} is the router's: every server with an address shares it.`,
      })
    }
    if (clash || port === server.rconPort) {
      throw createError({
        statusCode: 409,
        statusMessage: `Port ${port} is already used${clash ? ` by ${clash.name}` : ' for RCON'}.`,
      })
    }
  }

  if (memoryMb !== undefined) {
    const jobs = useJobs()
    const tooBig = budgetProblem(jobs.totalMemoryMb(), jobs.memoryUsers(), { name, memoryMb })
    if (tooBig) throw createError({ statusCode: 409, statusMessage: tooBig })
  }

  if (port !== undefined || memoryMb !== undefined) {
    try {
      await agent('server.configure', { name, memoryMb, port })
    } catch (err) {
      throw createError({ statusCode: 502, statusMessage: (err as Error).message })
    }
  }
  if (port !== undefined) await writeProperties(name, { 'server-port': String(port) })
  db.update(schema.servers)
    .set({
      ...(port !== undefined ? { port } : {}),
      ...(memoryMb !== undefined ? { memoryMb } : {}),
      ...(hostname !== undefined ? { hostname } : {}),
    })
    .where(eq(schema.servers.name, name))
    .run()
  if (port !== undefined || hostname !== undefined) {
    try {
      await useRouting().serverChanged(name)
    } catch (err) {
      throw createError({ statusCode: 502, statusMessage: (err as Error).message })
    }
  }
  db.insert(schema.audit)
    .values({
      userId: user.id,
      action: 'server.resources',
      target: name,
      detail: { port, memoryMb, hostname },
    })
    .run()
  return { changed: true }
})
