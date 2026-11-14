/**
 * Checks the hostname router on a real install (#76), from inside the E2E container: the agent
 * installs and starts it, the panel's route table reaches it, and it answers the server list
 * for addresses it knows and doesn't. Then turns it off again.
 *
 *   bun /src/tests/e2e/router.ts
 */
import type { RouteTable } from '../../packages/protocol/src/index.ts'
import { callAgent, callRouter } from '../../packages/protocol/src/client.ts'

const PORT = 25599
const agent = { socketPath: '/run/flytower/agent.sock', timeoutMs: 60_000 }
const router = { socketPath: '/run/flytower-router/router.sock', timeoutMs: 10_000 }

function varint(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
const packet = (body: number[]) => [...varint(body.length), ...body]
const text = (s: string) => {
  const b = [...new TextEncoder().encode(s)]
  return [...varint(b.length), ...b]
}

/** The server list entry the router gives for `hostname`: a status handshake and request. */
async function motd(hostname: string): Promise<string> {
  const handshake = packet([0x00, ...varint(775), ...text(hostname), PORT >> 8, PORT & 0xff, 1])
  const request = packet([0x00])
  let got = new Uint8Array(0)
  // The whole status packet: its length, as a VarInt, then that many bytes.
  const complete = () => {
    let len = 0
    for (let i = 0; i < 5 && i < got.length; i++) {
      len |= (got[i]! & 0x7f) << (7 * i)
      if (!(got[i]! & 0x80)) return got.length >= i + 1 + len
    }
    return false
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from the router')), 5000)
    void Bun.connect({
      hostname: '127.0.0.1',
      port: PORT,
      socket: {
        open: (s) => void s.write(new Uint8Array([...handshake, ...request])),
        data: (s, d) => {
          got = new Uint8Array([...got, ...d])
          if (complete()) {
            clearTimeout(timer)
            resolve()
            s.end()
          }
        },
        close: () => reject(new Error('the router closed the connection')),
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })
  const all = Buffer.from(got).toString('utf8')
  const json = all.slice(all.indexOf('{'))
  return (JSON.parse(json) as { description: { text: string } }).description.text
}

async function retry<T>(what: string, f: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 20; i++) {
    try {
      return await f()
    } catch (err) {
      last = err
      await Bun.sleep(500)
    }
  }
  throw new Error(`${what}: ${(last as Error).message}`)
}

function expectEqual(got: unknown, want: unknown, what: string) {
  if (got !== want)
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  console.log(`✓ ${what}`)
}

await callAgent('router.enable', { port: PORT }, agent)
const pinged = await retry('the router answers', () => callRouter('ping', {}, router))
console.log(`✓ the router is up: ${JSON.stringify(pinged)}`)

const table: RouteTable = {
  routes: [
    {
      name: 'survival',
      hostnames: ['survival.example.com'],
      port: 25601,
      state: 'stopped',
      proxyProtocol: false,
      bans: [],
    },
  ],
  messages: {
    unknownMotd: 'nothing here',
    unknownDisconnect: 'nothing at {hostname}',
    stoppedMotd: 'stopped for now',
    stoppedDisconnect: 'stopped',
    startingMotd: 'starting',
    startingDisconnect: 'starting',
    bannedDisconnect: 'banned',
  },
}
await callRouter('routes.set', table, router)
expectEqual(
  await retry('status', () => motd('survival.example.com')),
  'stopped for now',
  'a stopped server',
)
expectEqual(await motd('SURVIVAL.example.com.'), 'stopped for now', 'case and a trailing dot')
expectEqual(await motd('other.example.com'), 'nothing here', 'an unknown address')

// Routes survive a restart of the router.
await callAgent('router.enable', { port: PORT }, agent)
const proc = Bun.spawnSync(['systemctl', 'restart', 'flytower-router'])
if (proc.exitCode !== 0) throw new Error('restarting the router failed')
expectEqual(
  await retry('status after a restart', () => motd('survival.example.com')),
  'stopped for now',
  'routes kept across a restart',
)

const status = await callRouter('routes.status', {}, router)
expectEqual(status.routes[0]?.name, 'survival', 'routes.status lists the route')

await callAgent('router.disable', {}, agent)
const active = Bun.spawnSync(['systemctl', 'is-active', 'flytower-router']).stdout.toString().trim()
expectEqual(active, 'inactive', 'turned off')
