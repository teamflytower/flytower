import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MOD_FILE,
  parseSystemdTime,
  prepareServer,
  readIpBans,
  readsProxyHeaders,
  setPaperProxyProtocol,
} from '../server/routing/files'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flytower-routing-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const PAPER = `# This is the global configuration file for Paper.
_version: 31
proxies:
  bungee-cord:
    online-mode: true
  proxy-protocol: false
  velocity:
    enabled: false
    online-mode: true
    secret: ''
scoreboards:
  save-empty-scoreboard-teams: true
`
const mod = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])
const at = (ms: number) => new Date(ms)
const age = (path: string, ms: number) => utimes(path, ms / 1000, ms / 1000)

describe('setPaperProxyProtocol', () => {
  test('changes only that line', () => {
    const on = setPaperProxyProtocol(PAPER, true)!
    expect(on).toBe(PAPER.replace('  proxy-protocol: false', '  proxy-protocol: true'))
    expect(setPaperProxyProtocol(on, true)).toBeNull()
    expect(setPaperProxyProtocol(on, false)).toBe(PAPER)
  })
  test('adds the setting when it is missing', () => {
    expect(setPaperProxyProtocol('_version: 31\n', true)).toBe(
      '_version: 31\nproxies:\n  proxy-protocol: true\n',
    )
    expect(setPaperProxyProtocol('_version: 31\nproxies:\n  bungee-cord: {}\n', true)).toBe(
      '_version: 31\nproxies:\n  proxy-protocol: true\n  bungee-cord: {}\n',
    )
    expect(setPaperProxyProtocol('_version: 31\n', false)).toBeNull()
  })
  test("doesn't take another section's key", () => {
    const text = 'other:\n  proxy-protocol: true\nproxies:\n  velocity: {}\n'
    expect(setPaperProxyProtocol(text, true)).toBe(
      'other:\n  proxy-protocol: true\nproxies:\n  proxy-protocol: true\n  velocity: {}\n',
    )
  })
})

describe('parseSystemdTime', () => {
  test('reads UTC and local times', () => {
    expect(parseSystemdTime('Tue 2026-11-10 15:00:00 UTC')?.toISOString()).toBe(
      '2026-11-10T15:00:00.000Z',
    )
    const local = parseSystemdTime('Tue 2026-11-10 15:00:00 BST')
    expect(local?.getHours()).toBe(15)
    expect(parseSystemdTime('n/a')).toBeNull()
  })
})

describe('Fabric', () => {
  test('gets the mod when routed and loses it when not', async () => {
    await prepareServer(dir, 'fabric', true, mod)
    expect(new Uint8Array(await readFile(join(dir, 'mods', MOD_FILE)))).toEqual(mod)
    await prepareServer(dir, 'fabric', false, mod)
    expect(await Bun.file(join(dir, 'mods', MOD_FILE)).exists()).toBe(false)
  })
  test('reads headers only once started after the mod arrived', async () => {
    await prepareServer(dir, 'fabric', true, mod)
    const jar = join(dir, 'mods', MOD_FILE)
    await age(jar, 1_000_000)
    expect(await readsProxyHeaders(dir, 'fabric', at(1_000_000))).toBe(true)
    expect(await readsProxyHeaders(dir, 'fabric', at(2_000_000))).toBe(true)
    expect(await readsProxyHeaders(dir, 'fabric', at(990_000))).toBe(false)
    expect(await readsProxyHeaders(dir, 'fabric', null)).toBe(false)
  })
  test('without the mod in the release, nothing is installed', async () => {
    await prepareServer(dir, 'fabric', true, null)
    expect(await readsProxyHeaders(dir, 'fabric', new Date())).toBe(false)
  })
})

describe('Paper', () => {
  test('waits for Paper to write its config', async () => {
    await prepareServer(dir, 'paper', true, null)
    expect(await Bun.file(join(dir, 'config', 'paper-global.yml')).exists()).toBe(false)
  })
  test('turns the setting on, and reads headers only after the next start', async () => {
    await mkdir(join(dir, 'config'))
    const path = join(dir, 'config', 'paper-global.yml')
    await writeFile(path, PAPER)
    await prepareServer(dir, 'paper', true, null)
    expect(await readFile(path, 'utf8')).toContain('  proxy-protocol: true')
    const marker = join(dir, 'config', '.flytower-proxy-protocol')
    await age(marker, 1_000_000)
    expect(await readsProxyHeaders(dir, 'paper', at(990_000))).toBe(false)
    // Paper rewrites its config as it starts, which mustn't count as a change.
    await age(path, 1_005_000)
    expect(await readsProxyHeaders(dir, 'paper', at(1_002_000))).toBe(true)

    await prepareServer(dir, 'paper', false, null)
    expect(await readFile(path, 'utf8')).toBe(PAPER)
    expect(await readsProxyHeaders(dir, 'paper', new Date(Date.now() + 10_000))).toBe(false)
  })
  test('a setting turned on by hand counts', async () => {
    await mkdir(join(dir, 'config'))
    await writeFile(join(dir, 'config', 'paper-global.yml'), setPaperProxyProtocol(PAPER, true)!)
    expect(await readsProxyHeaders(dir, 'paper', at(1))).toBe(true)
  })
  test('vanilla never does', async () => {
    expect(await readsProxyHeaders(dir, 'vanilla', new Date())).toBe(false)
  })
})

describe('readIpBans', () => {
  test('reads current bans and drops expired or odd entries', async () => {
    await writeFile(
      join(dir, 'banned-ips.json'),
      JSON.stringify([
        { ip: '203.0.113.7', created: 'x', source: 'Server', expires: 'forever', reason: 'r' },
        { ip: '2001:db8::1', expires: '2999-01-01 00:00:00 +0000' },
        { ip: '198.51.100.1', expires: '2000-01-01 00:00:00 +0000' },
        { ip: 'not an ip', expires: 'forever' },
        { ip: '203.0.113.7', expires: 'forever' },
        null,
      ]),
    )
    expect(await readIpBans(dir)).toEqual(['2001:db8::1', '203.0.113.7'])
  })
  test('a missing or broken file means no bans', async () => {
    expect(await readIpBans(dir)).toEqual([])
    await writeFile(join(dir, 'banned-ips.json'), '{')
    expect(await readIpBans(dir)).toEqual([])
  })
})
