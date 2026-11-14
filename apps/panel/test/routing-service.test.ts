import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteTable } from '@flytower/protocol'
import { openDb, schema, type Db } from '../server/db'
import { MOD_FILE } from '../server/routing/files'
import { Routing, RoutingError } from '../server/routing/service'
import type { StatusMap } from '../server/jobs/status'

let db: Db
let root: string
let calls: { verb: string; params: unknown }[]
let tables: RouteTable[]
let props: Record<string, Record<string, string>>
let statuses: StatusMap
let since: Date | null
let routing: Routing
let routerDown: boolean

const server = (name: string, over: Partial<typeof schema.servers.$inferInsert> = {}) =>
  db
    .insert(schema.servers)
    .values({
      name,
      displayName: name,
      loader: 'vanilla',
      mcVersion: '26.3',
      javaMajor: 25,
      memoryMb: 2048,
      port: 25565,
      rconPort: 25575,
      rconPassword: 'x',
      eulaAcceptedAt: new Date(),
      timezone: 'Europe/London',
      ...over,
    })
    .run()

beforeEach(async () => {
  db = openDb(':memory:')
  root = await mkdtemp(join(tmpdir(), 'flytower-routing-'))
  calls = []
  tables = []
  props = {}
  statuses = {}
  since = null
  routerDown = false
  routing = new Routing({
    db,
    agent: (async (verb: string, params: unknown) => {
      calls.push({ verb, params })
      return {}
    }) as never,
    router: (async (verb: string, params: unknown) => {
      if (routerDown) throw new Error('not listening')
      if (verb === 'routes.set') tables.push(params as RouteTable)
      return {}
    }) as never,
    writeProperties: async (name, changes) => {
      props[name] = { ...props[name], ...changes }
    },
    statuses: async () => statuses,
    brand: () => 'Flytower',
    serverDir: (name) => join(root, name),
    since: async () => since,
    mod: async () => new Uint8Array([1, 2, 3]),
    fixPermissions: async () => {},
    retryMs: 60_000,
  })
})
afterEach(async () => {
  routing.close()
  await rm(root, { recursive: true, force: true })
})

describe('Routing', () => {
  test('turning on moves a server off the port, closes routed ports and sends the routes', async () => {
    server('survival', { hostname: 'survival.example.com', port: 25565, rconPort: 25575 })
    server('creative', { hostname: null, port: 25566, rconPort: 25576 })
    await mkdir(join(root, 'survival'))
    statuses = { survival: 'active', creative: 'inactive' }

    const { moved } = await routing.enable(25565)
    expect(moved).toEqual([{ name: 'survival', from: 25565, to: 25567 }])
    expect(calls.map((c) => c.verb)).toEqual([
      'server.configure',
      'router.enable',
      'server.expose',
      'server.expose',
    ])
    expect(calls.filter((c) => c.verb === 'server.expose').map((c) => c.params)).toEqual([
      { name: 'survival', port: 25567, public: false },
      { name: 'creative', port: 25566, public: true },
    ])
    expect(props.survival).toEqual({ 'server-port': '25567', 'server-ip': '127.0.0.1' })
    expect(props.creative).toEqual({ 'server-ip': '' })
    expect(tables.at(-1)!.routes).toEqual([
      {
        name: 'survival',
        hostnames: ['survival.example.com'],
        port: 25567,
        state: 'running',
        proxyProtocol: false,
        bans: [],
      },
    ])
    expect(routing.reservedPorts()).toEqual([25565])
  })

  test("refuses a port that's a server's RCON port", async () => {
    server('survival', { rconPort: 25565, port: 25566 })
    expect(routing.enable(25565)).rejects.toBeInstanceOf(RoutingError)
  })

  test('a Fabric server gets the mod and real addresses once restarted', async () => {
    server('modded', { loader: 'fabric', hostname: 'modded.example.com', port: 25570 })
    await mkdir(join(root, 'modded'))
    statuses = { modded: 'active' }
    since = new Date(Date.now() - 60_000) // started before the mod arrived
    await routing.enable(25565)
    expect(await Bun.file(join(root, 'modded', 'mods', MOD_FILE)).exists()).toBe(true)
    expect(tables.at(-1)!.routes[0]!.proxyProtocol).toBe(false)
    expect(await routing.addresses()).toEqual([{ name: 'modded', real: false, afterRestart: true }])

    since = new Date(Date.now() + 5_000) // restarted
    await routing.syncNow()
    expect(tables.at(-1)!.routes[0]!.proxyProtocol).toBe(true)

    await routing.disable()
    expect(await Bun.file(join(root, 'modded', 'mods', MOD_FILE)).exists()).toBe(false)
  })

  test("sends the server's IP bans", async () => {
    server('survival', { hostname: 'survival.example.com', port: 25570 })
    await mkdir(join(root, 'survival'))
    await writeFile(
      join(root, 'survival', 'banned-ips.json'),
      JSON.stringify([{ ip: '203.0.113.7', expires: 'forever' }]),
    )
    await routing.enable(25565)
    expect(tables.at(-1)!.routes[0]!.bans).toEqual(['203.0.113.7'])
  })

  test('nothing changes while routing is off', async () => {
    server('survival', { hostname: 'survival.example.com' })
    await routing.serverChanged('survival')
    routing.sync()
    await routing.syncNow()
    expect(calls).toEqual([])
    expect(tables).toEqual([])
  })

  test('a router that is down is tried again', async () => {
    server('survival', { hostname: 'survival.example.com', port: 25570 })
    await routing.enable(25565)
    routerDown = true
    expect(routing.syncNow()).rejects.toThrow('not listening')
  })
})
