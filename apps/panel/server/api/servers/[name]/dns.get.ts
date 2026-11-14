import { checkRecords, expectedRecords, machineAddresses, publicLookup } from '../../../dns'
import { isRouted } from '../../../routing/table'

/** The DNS records this server's hostname needs, and whether public DNS has them. */
export default defineEventHandler(async (event) => {
  await requireServerPermission(event, 'server.view')
  const server = findServer(getRouterParam(event, 'name') ?? '')
  if (!server.hostname) return { hostname: null, records: [] }
  const config = useRuntimeConfig()
  const machine = machineAddresses({ ipv4: config.machineIpv4, ipv6: config.machineIpv6 })
  // Behind the router, players connect to its port, not the server's own.
  const router = useRouting().settings()
  const routed = isRouted(router, server)
  const port = routed ? router.port : server.port
  const expected = expectedRecords(server.hostname, port, machine)
  const lookup = publicLookup()
  try {
    const records = await checkRecords(expected, lookup)
    // An SRV record left from before sends players to a port that's now closed.
    const srvName = `_minecraft._tcp.${server.hostname}`
    const staleSrv =
      routed &&
      !expected.some((e) => e.type === 'SRV') &&
      (await lookup.srv(srvName)).some((s) => s.port !== port)
    return { hostname: server.hostname, routed, records, staleSrv: staleSrv ? srvName : null }
  } catch {
    // DNS itself unreachable: still show what to create.
    return {
      hostname: server.hostname,
      routed,
      records: expected.map((e) => ({ ...e, status: 'unknown' as const, found: [] })),
      staleSrv: null,
    }
  }
})
