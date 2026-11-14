/**
 * Pretends to be a running Minecraft server for the fake agent: writes believable lines to
 * logs/latest.log and answers RCON on the port and password in server.properties.
 *
 * For working on crash detection, two extra console commands: `crash` (or `crash oom`)
 * writes a crash report and dies, and `hang` stops the console answering.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TCPSocketListener } from 'bun'
import { encodePacket, PacketParser, PacketType } from '@flytower/rcon'

const stamp = () => new Date().toTimeString().slice(0, 8)
const line = (thread: string, level: string, msg: string) =>
  `[${stamp()}] [${thread}/${level}]: ${msg}\n`

function properties(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

const online = ['Steve', 'Alex']

const replies: Record<string, (args: string) => string> = {
  list: () => `There are ${online.length} of a max of 20 players online: ${online.join(', ')}`,
  kick: (a) => {
    const n = a.split(' ')[0] ?? ''
    const i = online.indexOf(n)
    if (i < 0) return 'No player was found'
    online.splice(i, 1)
    return `Kicked ${n}: Kicked by an operator`
  },
  tick: (a) =>
    a.startsWith('query')
      ? `The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: ${(4 + Math.random() * 20).toFixed(1)}ms (Target: 50.0ms)\nPercentiles: P50: 8.1ms P95: 14.0ms P99: 19.3ms, sample: 100`
      : 'Unknown or incomplete command',
  seed: () => 'Seed: [-4172144997902289642]',
  'save-off': () => 'Automatic saving is now disabled',
  'save-on': () => 'Automatic saving is now enabled',
  'save-all': () => 'Saving the game (this may take a moment!)\nSaved the game',
  say: () => '',
  // No feedback, like the real thing, unless nobody matches.
  tellraw: (a) =>
    a.startsWith('@') || online.includes(a.split(' ')[0] ?? '') ? '' : 'No player was found',
  // Like the real thing: one usage per command, joined with no line breaks. spark and chunky
  // stand in for mods' commands.
  help: () =>
    '/advancement (grant|revoke)/ban <targets> [<reason>]/chunky/list [uuids]/say <message>' +
    '/seed/spark (profiler|health|tps|gc)/stop/time (add|query|set)/weather (clear|rain|thunder)',
  time: (a) =>
    a.startsWith('query') ? 'The time is 6000' : `Set the time to ${a.split(' ')[1] ?? '0'}`,
}

type ListCmd = { file: string; add: boolean; ok: (n: string) => string }
const LIST_CMDS: Record<string, ListCmd> = {
  'whitelist add': { file: 'whitelist.json', add: true, ok: (n) => `Added ${n} to the whitelist` },
  'whitelist remove': {
    file: 'whitelist.json',
    add: false,
    ok: (n) => `Removed ${n} from the whitelist`,
  },
  op: { file: 'ops.json', add: true, ok: (n) => `Made ${n} a server operator` },
  deop: { file: 'ops.json', add: false, ok: (n) => `Made ${n} no longer a server operator` },
  ban: { file: 'banned-players.json', add: true, ok: (n) => `Banned ${n}` },
  pardon: { file: 'banned-players.json', add: false, ok: (n) => `Unbanned ${n}` },
}

/** Applies whitelist/op/ban commands to the JSON files the way Minecraft does. */
async function listCommand(dir: string, body: string): Promise<string | null> {
  const key = Object.keys(LIST_CMDS).find((k) => body === k || body.startsWith(`${k} `))
  if (!key) return null
  const cmd = LIST_CMDS[key]!
  const [name = '', ...reason] = body.slice(key.length).trim().split(' ')
  const path = join(dir, cmd.file)
  const list = JSON.parse(await readFile(path, 'utf8').catch(() => '[]')) as { name: string }[]
  const has = list.some((e) => e.name.toLowerCase() === name.toLowerCase())
  if (cmd.add === has) return 'Nothing changed'
  const next = cmd.add
    ? [
        ...list,
        { uuid: crypto.randomUUID(), name, ...(reason.length ? { reason: reason.join(' ') } : {}) },
      ]
    : list.filter((e) => e.name.toLowerCase() !== name.toLowerCase())
  await writeFile(path, JSON.stringify(next, null, 2))
  return cmd.ok(name)
}

export interface FakeHooks {
  /** Called when `crash` is typed; `oom` for `crash oom`. */
  onCrash?: (oom: boolean) => void
}

/** Writes what a ticking crash leaves behind: a crash report and an error in the log. */
async function fakeCrash(dir: string, log: string, oom: boolean) {
  if (oom) {
    await appendFile(log, line('Server thread', 'ERROR', 'Out of memory, pretending to be killed'))
    return
  }
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `crash-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}-server.txt`
  await mkdir(join(dir, 'crash-reports'), { recursive: true })
  await writeFile(
    join(dir, 'crash-reports', name),
    `---- Minecraft Crash Report ----\n// Don't be sad, have a hug! <3\n\nTime: ${d.toISOString()}\nDescription: Exception ticking world (pretend)\n\njava.lang.NullPointerException: Cannot invoke "Object.hashCode()" because "key" is null\n\tat net.minecraft.server.level.ServerLevel.tick(ServerLevel.java:42)\n`,
  )
  await appendFile(log, line('Server thread', 'ERROR', 'Encountered an unexpected exception'))
  await appendFile(
    log,
    line('Server thread', 'ERROR', `This crash report has been saved to: ./crash-reports/${name}`),
  )
}

export async function startFakeMinecraft(dir: string, hooks: FakeHooks = {}) {
  const log = join(dir, 'logs', 'latest.log')
  await mkdir(join(dir, 'logs'), { recursive: true })
  await writeFile(log, line('main', 'INFO', 'Loading Minecraft 26.3 with Fabric Loader 0.18.4'))
  const props = properties(await readFile(join(dir, 'server.properties'), 'utf8').catch(() => ''))
  const port = Number(props['rcon.port'] ?? 0)
  const password = props['rcon.password'] ?? ''

  const boot = [
    ['Server thread', 'INFO', 'Starting minecraft server version 26.3'],
    ['Server thread', 'INFO', 'Loading properties'],
    ['Server thread', 'INFO', `Starting Minecraft server on *:${props['server-port'] ?? 25565}`],
    ['Server thread', 'WARN', '**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE! (pretend)'],
    ['Server thread', 'INFO', 'Preparing level "world"'],
    ['Server thread', 'INFO', 'Done (3.142s)! For help, type "help"'],
    ['Server thread', 'INFO', `Starting remote control listener`],
    ['Server thread', 'INFO', `RCON running on 0.0.0.0:${port}`],
  ] as const
  for (const [t, l, m] of boot) {
    await Bun.sleep(150)
    await appendFile(log, line(t, l, m))
  }

  let rcon: TCPSocketListener<PacketParser> | null = null
  let hung = false
  if (port) {
    rcon = Bun.listen<PacketParser>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (s) => void (s.data = new PacketParser()),
        data: async (s, chunk) => {
          for (const p of s.data.push(chunk)) {
            if (p.type === PacketType.Auth) {
              s.write(encodePacket(p.body === password ? p.id : -1, PacketType.Command, ''))
            } else if (p.type === PacketType.Command) {
              if (hung) continue
              if (p.body === 'hang') {
                hung = true
                await appendFile(log, line('Server thread', 'WARN', "Can't keep up! (pretend)"))
                continue
              }
              if (p.body === 'crash' || p.body === 'crash oom') {
                s.write(encodePacket(p.id, PacketType.Response, 'Crashing (pretend)'))
                await fakeCrash(dir, log, p.body === 'crash oom')
                hooks.onCrash?.(p.body === 'crash oom')
                continue
              }
              const listed = await listCommand(dir, p.body)
              if (listed !== null) {
                s.write(encodePacket(p.id, PacketType.Response, listed))
                continue
              }
              const [cmd = '', ...rest] = p.body.split(' ')
              const reply = replies[cmd]?.(rest.join(' ')) ?? `Unknown or incomplete command`
              if (cmd === 'say')
                void appendFile(log, line('Server thread', 'INFO', `[Rcon] ${rest.join(' ')}`))
              s.write(encodePacket(p.id, PacketType.Response, reply))
            } else {
              s.write(encodePacket(p.id, PacketType.Response, `Unknown request ${p.type}`))
            }
          }
        },
      },
    })
  }
  const heartbeat = setInterval(
    () => void appendFile(log, line('Server thread', 'INFO', 'Saving the game (autosave)')),
    15_000,
  )
  return {
    async stop() {
      clearInterval(heartbeat)
      rcon?.stop(true)
      await appendFile(log, line('Server thread', 'INFO', 'Stopping the server'))
      await appendFile(log, line('Server thread', 'INFO', 'Saving worlds'))
    },
  }
}
