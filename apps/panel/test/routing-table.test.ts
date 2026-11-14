import { describe, expect, it } from 'bun:test'
import { RouteTable } from '@flytower/protocol'
import { defaultMessages, isRouted, routeState, routeTable } from '../server/routing/table'

describe('routeTable', () => {
  const messages = defaultMessages('Nottingham New Theatre')
  const servers = [
    { name: 'survival', hostname: 'Survival.mc.example.com', port: 25566 },
    { name: 'creative', hostname: 'creative.mc.example.com', port: 25567 },
    { name: 'lobby', hostname: null, port: 25568 },
  ]

  it('routes every server with a hostname, in name order', () => {
    const t = routeTable(servers, { survival: 'active', creative: 'inactive' }, messages)
    expect(t.routes.map((r) => [r.name, r.hostnames, r.port, r.state])).toEqual([
      ['creative', ['creative.mc.example.com'], 25567, 'stopped'],
      ['survival', ['survival.mc.example.com'], 25566, 'running'],
    ])
  })

  it('is a table the router accepts', () => {
    const t = routeTable(servers, {}, messages)
    expect(RouteTable.safeParse(t).success).toBe(true)
  })

  it('puts the install name in the server list', () => {
    expect(messages.unknownMotd.startsWith('Nottingham New Theatre\n')).toBe(true)
  })
})

describe('routeState', () => {
  it.each([
    ['active', 'running'],
    ['activating', 'starting'],
    ['inactive', 'stopped'],
    ['failed', 'stopped'],
    ['deactivating', 'stopped'],
    ['unknown', 'running'],
    [undefined, 'running'],
  ] as const)('%s is %s', (active, want) => {
    expect(routeState(active)).toBe(want)
  })
})

describe('isRouted', () => {
  it('needs the switch on and a hostname', () => {
    expect(isRouted({ enabled: true }, { hostname: 'a.example.com' })).toBe(true)
    expect(isRouted({ enabled: true }, { hostname: null })).toBe(false)
    expect(isRouted({ enabled: false }, { hostname: 'a.example.com' })).toBe(false)
  })
})
