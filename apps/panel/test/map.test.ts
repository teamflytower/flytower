import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  MapService,
  parseProgress,
  parseReport,
  readStderr,
  runRenderer,
  type MapDeps,
  type MapStatus,
} from '../server/map/service'
import { DEFAULT_MAP, type MapSettings } from '../shared/map-settings'
import { mapAccess, mapFile, mapShowsPlayers, viewerPage } from '../server/map/serve'
import { defaultPublicPage, type PlayerVisibility } from '../shared/public-page'
import { parseDimension, parsePos, PlayerPositions } from '../server/map/players'

const REPORT = JSON.stringify({
  version: 1,
  dimensions: [
    {
      id: 'minecraft:overworld',
      regions: 4,
      drawn: 3,
      unchanged: 1,
      removed: 0,
      chunks: 900,
      errors: 1,
      firstError: "chunk won't decompress",
    },
    {
      id: 'minecraft:the_nether',
      regions: 1,
      drawn: 1,
      unchanged: 0,
      removed: 1,
      chunks: 20,
      errors: 0,
      firstError: null,
    },
  ],
  ms: 1234,
})

function setup(opts: { world?: boolean; palette?: 'ok' | 'fails' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ft-map-'))
  const servers = join(root, 'servers')
  mkdirSync(join(servers, 'survival'), { recursive: true })
  if (opts.world !== false) mkdirSync(join(servers, 'survival', 'world'))
  const settings: Record<string, MapSettings> = { survival: { ...DEFAULT_MAP, enabled: true } }
  const runs: string[][] = []
  const published: MapStatus['state'][] = []
  const progress: (MapStatus['progress'] | null)[] = []
  const palettes: string[] = []
  const watching: { dir: string; save: () => void; stopped: boolean }[] = []
  let fail: string | null = null
  const deps: MapDeps = {
    mapsDir: join(root, 'maps'),
    serverDir: (name) => join(servers, name),
    servers: () => Object.keys(settings),
    settings: (name) => settings[name] ?? null,
    minecraft: () => '26.3',
    levelName: async () => null,
    async makePalette(mc, dest) {
      palettes.push(mc)
      if (opts.palette === 'fails') throw new Error('offline')
      writeFileSync(dest, 'block minecraft:stone 7d7d7d\n')
    },
    async run(args, onProgress) {
      runs.push(args)
      if (fail) throw new Error(fail)
      for (let done = 0; done <= 3; done++) onProgress?.({ done, total: 3 })
      const out = args[args.indexOf('--out') + 1]!
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'maps.json'), '{}')
      return REPORT
    },
    publish: (_name, status) => {
      published.push(status.state)
      progress.push(status.progress)
    },
    watch(dir, save) {
      const w = { dir, save, stopped: false }
      watching.push(w)
      return () => (w.stopped = true)
    },
    quietMs: 20,
    maxWaitMs: 60,
    progressMs: 0,
  }
  const service = new MapService(deps)
  return {
    root,
    deps,
    service,
    settings,
    runs,
    published,
    progress,
    palettes,
    watching,
    failWith: (why: string | null) => (fail = why),
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('map service', () => {
  it('draws a map that is on, with the game colours, and remembers the pass', async () => {
    const { service, runs, root, published, progress, watching, palettes, deps } = setup()
    await service.sync('survival')
    await service.draw('survival')
    expect(watching.map((w) => w.dir)).toEqual([join(root, 'servers', 'survival')])
    expect(palettes).toEqual(['26.3'])
    expect(runs[0]).toEqual([
      'render',
      '--world',
      join(root, 'servers', 'survival', 'world'),
      '--out',
      join(root, 'maps', 'servers', 'survival'),
      '--progress',
      '--palette',
      join(root, 'maps', 'palettes', '26.3.palette'),
    ])
    expect(published).toContain('drawing')
    expect(published.at(-1)).toBe('idle')
    // Watchers see the pass move along, and no progress once it's done.
    expect(progress.filter(Boolean).slice(-4)).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
    expect(progress.at(-1)).toBeNull()
    const status = await service.status('survival')
    expect(status).toMatchObject({ enabled: true, state: 'idle', error: null })
    expect(status.lastPass).toMatchObject({
      ms: 1234,
      full: false,
      drawn: 4,
      unchanged: 1,
      removed: 1,
      chunks: 920,
      errors: 1,
      firstError: "chunk won't decompress",
      colours: 'game',
    })

    // The palette is made once per version, and the last pass survives a restart.
    await service.draw('survival', { full: true })
    expect(palettes).toEqual(['26.3'])
    expect(runs.at(-1)).toContain('--full')
    const again = new MapService(deps)
    expect((await again.status('survival')).lastPass?.full).toBe(true)
  })

  it('falls back to the built-in colours when the jar cannot be fetched', async () => {
    const { service, runs, palettes } = setup({ palette: 'fails' })
    await service.sync('survival')
    await service.draw('survival')
    expect(runs[0]).not.toContain('--palette')
    expect((await service.status('survival')).lastPass?.colours).toBe('built-in')
    // Every pass tries again.
    expect(palettes.length).toBe(runs.length)
  })

  it('waits for the world to exist', async () => {
    const { service, runs } = setup({ world: false })
    await service.sync('survival')
    await service.draw('survival')
    expect(runs).toEqual([])
    expect((await service.status('survival')).state).toBe('waiting')
  })

  it('draws once saving goes quiet, however many saves there were', async () => {
    const { service, runs, watching } = setup()
    await service.sync('survival')
    await service.draw('survival')
    runs.length = 0
    for (let i = 0; i < 5; i++) watching[0]!.save()
    expect((await service.status('survival')).state).toBe('queued')
    await wait(50)
    await service.draw('survival') // waits for the queue
    expect(runs.length).toBe(2)
  })

  it('does not wait forever while saving goes on', async () => {
    const { service, runs, watching } = setup()
    await service.sync('survival')
    await service.draw('survival')
    runs.length = 0
    // Saves keep coming faster than the quiet time, so only the maximum wait can start a
    // pass. The deadline is generous because a busy CI runner can be slow to run timers.
    const started = Date.now()
    while (runs.length === 0 && Date.now() - started < 3000) {
      watching[0]!.save()
      await wait(5)
    }
    expect(runs.length).toBe(1)
  })

  it('shows why a pass failed, and clears it on the next good one', async () => {
    const { service, failWith } = setup()
    await service.sync('survival')
    failWith('flytower-map: world/region: Permission denied')
    await service.draw('survival')
    expect((await service.status('survival')).error).toBe(
      'flytower-map: world/region: Permission denied',
    )
    failWith(null)
    await service.draw('survival')
    expect((await service.status('survival')).error).toBeNull()
  })

  it('stops and removes the map when turned off, and when the server is deleted', async () => {
    const { service, settings, watching, root } = setup()
    const dir = join(root, 'maps', 'servers', 'survival')
    await service.sync('survival')
    await service.draw('survival')
    expect(existsSync(dir)).toBe(true)
    settings.survival = { ...DEFAULT_MAP }
    await service.sync('survival')
    expect(watching[0]!.stopped).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(await service.status('survival')).toEqual({
      enabled: false,
      state: 'off',
      lastPass: null,
      error: null,
      progress: null,
    })

    settings.survival = { ...DEFAULT_MAP, enabled: true }
    await service.sync('survival')
    await service.draw('survival')
    expect(existsSync(dir)).toBe(true)
    await service.forget('survival')
    expect(existsSync(dir)).toBe(false)
  })

  it('does nothing for a map that is off', async () => {
    const { service, settings, runs, watching } = setup()
    settings.survival = { ...DEFAULT_MAP }
    await service.start()
    await service.draw('survival')
    expect(runs).toEqual([])
    expect(watching).toEqual([])
  })
})

describe('map passes across servers', () => {
  it("runs a couple at once, so one big world doesn't hold up the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), 'ft-map-'))
    const names = ['big', 'small', 'third']
    for (const n of names) mkdirSync(join(root, 'servers', n, 'world'), { recursive: true })
    const started: string[] = []
    const finished: string[] = []
    let releaseBig!: () => void
    const big = new Promise<void>((r) => (releaseBig = r))
    const service = new MapService({
      mapsDir: join(root, 'maps'),
      serverDir: (name) => join(root, 'servers', name),
      servers: () => names,
      settings: () => ({ ...DEFAULT_MAP, enabled: true }),
      minecraft: () => null,
      levelName: async () => null,
      makePalette: async () => {},
      async run(args) {
        const name = args[args.indexOf('--out') + 1]!.split('/').at(-1)!
        started.push(name)
        if (name === 'big') await big
        else await wait(5)
        finished.push(name)
        return REPORT
      },
      publish: () => {},
      watch: () => () => {},
      parallel: 2,
    })
    const passes = names.map((n) => service.draw(n))
    await Promise.all([passes[1], passes[2]])
    // The small worlds were drawn while the big one was still going.
    expect(finished).toEqual(['small', 'third'])
    expect(started).toContain('big')
    releaseBig()
    await passes[0]
    expect(finished).toEqual(['small', 'third', 'big'])
  })
})

describe('running the renderer', () => {
  it('stops a run that makes no progress', async () => {
    const err = await runRenderer(
      ['sh', '-c', 'echo "progress 0 2" >&2; exec sleep 5'],
      undefined,
      150,
    )
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(err).toContain('made no progress')
  })

  it('lets a run go on while it keeps reporting progress', async () => {
    const seen: number[] = []
    const out = await runRenderer(
      ['sh', '-c', 'for i in 1 2 3 4; do echo "progress $i 4" >&2; sleep 0.1; done; echo done'],
      (p) => seen.push(p.done),
      300,
    )
    expect(out.trim()).toBe('done')
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('passes on why a run failed', async () => {
    const err = await runRenderer(['sh', '-c', 'echo "no world here" >&2; exit 3'])
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(err).toBe('no world here')
  })
})

describe('parseProgress', () => {
  it('reads only progress lines', () => {
    expect(parseProgress('progress 12 340')).toEqual({ done: 12, total: 340 })
    expect(parseProgress('progress 0 0\r')).toEqual({ done: 0, total: 0 })
    expect(parseProgress('progress 5 4')).toBeNull()
    expect(parseProgress('flytower-map: world/region: Permission denied')).toBeNull()
    expect(parseProgress('progress -1 4')).toBeNull()
  })

  it('passes progress on as it comes and keeps the rest for errors', async () => {
    const parts = ['progress 0 2\nprog', 'ress 1 2\nflytower-map: oh no\n', 'progress 2 2']
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p))
        c.close()
      },
    })
    const seen: unknown[] = []
    expect(await readStderr(stream, (p) => seen.push(p))).toBe('flytower-map: oh no')
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })
})

describe('parseReport', () => {
  it('refuses answers it does not understand', () => {
    expect(() => parseReport('{"version":2,"dimensions":[]}')).toThrow("isn't one this panel")
    expect(() => parseReport('{"version":1}')).toThrow()
    expect(parseReport('{"version":1,"dimensions":[],"ms":5}')).toMatchObject({
      drawn: 0,
      ms: 5,
      firstError: null,
    })
  })
})

describe('serving the map', () => {
  const root = '/var/lib/flytower/maps/servers/survival'

  it('shows players on a public map only when the public page shows names', () => {
    const on = { ...DEFAULT_MAP, enabled: true, public: true, players: true }
    const page = (players: PlayerVisibility) => {
      const p = defaultPublicPage()
      return { ...p, enabled: true, show: { ...p.show, players } }
    }
    expect(mapShowsPlayers(on, page('names'))).toBe(true)
    expect(mapShowsPlayers(on, page('count'))).toBe(false)
    expect(mapShowsPlayers(on, page('none'))).toBe(false)
    // Signed in, the map's own switch decides.
    expect(mapShowsPlayers(on, null)).toBe(true)
    expect(mapShowsPlayers({ ...on, players: false }, null)).toBe(false)
    expect(mapShowsPlayers({ ...on, players: false }, page('names'))).toBe(false)
  })

  it('serves only the manifest and tiles, never state or anything outside', () => {
    expect(mapFile(root, 'maps.json')).toEqual({
      file: `${root}/maps.json`,
      type: 'application/json',
      cache: 'no-cache',
    })
    expect(mapFile(root, 'tiles/minecraft/overworld/0/-1_2.png')).toMatchObject({
      type: 'image/png',
      cache: 'public, max-age=60',
    })
    for (const bad of [
      '',
      'state/minecraft/overworld.txt',
      'last-pass.json',
      'tiles/../state/x.png',
      'tiles/./a.png',
      'tiles//a.png',
      'tiles/.hidden.png',
      'tiles/a.png\0',
      'tiles\\a.png',
      'tiles/a.txt',
      '../servers/other/maps.json',
    ]) {
      expect(mapFile(root, bad)).toBeNull()
    }
  })

  it('decides who may open a map', () => {
    const on = { ...DEFAULT_MAP, enabled: true }
    expect(mapAccess({ map: DEFAULT_MAP, publicPage: true, canView: true })).toBe('not-found')
    expect(mapAccess({ map: { ...on, public: true }, publicPage: true, canView: null })).toBe(
      'allow',
    )
    // Public needs the public page too.
    expect(mapAccess({ map: { ...on, public: true }, publicPage: false, canView: null })).toBe(
      'sign-in',
    )
    expect(mapAccess({ map: on, publicPage: true, canView: null })).toBe('sign-in')
    expect(mapAccess({ map: on, publicPage: false, canView: true })).toBe('allow')
    expect(mapAccess({ map: on, publicPage: false, canView: false })).toBe('not-found')
  })

  it("escapes the server's name in the page", () => {
    const html = viewerPage({ title: '<Survival & "co">', version: '1.3.0' })
    expect(html).toContain('<title>&lt;Survival &amp; &quot;co&quot;&gt; · Map</title>')
    expect(html).toContain('src="/_map/viewer.js?v=1.3.0"')
    expect(html).toContain('src="/_map/trim.js?v=1.3.0"')
    expect(html).not.toContain('<Survival')
  })

  it('keeps tiles under the bars and markers', async () => {
    // Tiles use z-index to stack zoom levels; the layer must contain that, or tiles
    // paint over the controls drawn after it.
    const css = await Bun.file(join(import.meta.dir, '../public/_map/viewer.css')).text()
    expect(css).toMatch(/\.tiles\s*\{[^}]*isolation:\s*isolate/)
  })
})

describe('player positions', () => {
  it('reads positions and dimensions from the data command', () => {
    expect(parsePos('Steve has the following entity data: [12.5d, 64.0d, -3.25d]')).toEqual([
      12.5, 64, -3.25,
    ])
    expect(parsePos('Steve has the following entity data: [1.0E-4d, 70.0d, 5.0d]')).toEqual([
      0.0001, 70, 5,
    ])
    expect(parsePos('No entity was found')).toBeNull()
    expect(parseDimension('Steve has the following entity data: "minecraft:the_nether"')).toBe(
      'minecraft:the_nether',
    )
    expect(parseDimension('No entity was found')).toBeNull()
  })

  it('asks at most once every few seconds, and skips odd names', async () => {
    const asked: string[] = []
    const positions = new PlayerPositions({
      online: async () => [
        { name: 'Steve', uuid: 'u1' },
        { name: 'bad name; op me', uuid: null },
        { name: 'Gone', uuid: null },
      ],
      rcon: async (_server, command) => {
        asked.push(command)
        if (command.includes('Gone')) return 'No entity was found'
        return command.endsWith('Pos')
          ? 'Steve has the following entity data: [1.5d, 2.0d, 3.5d]'
          : 'Steve has the following entity data: "minecraft:overworld"'
      },
      ttlMs: 1000,
    })
    const first = await positions.get('survival')
    expect(first).toEqual([
      { name: 'Steve', uuid: 'u1', dimension: 'minecraft:overworld', x: 1.5, y: 2, z: 3.5 },
    ])
    await positions.get('survival')
    expect(asked).toEqual([
      'data get entity Steve Pos',
      'data get entity Steve Dimension',
      'data get entity Gone Pos',
    ])
    positions.forget('survival')
    await positions.get('survival')
    expect(asked.length).toBe(6)
  })

  it('asks for the dimension again only after a while or a long jump', async () => {
    const asked: string[] = []
    let x = 0
    let dimension = 'minecraft:overworld'
    const positions = new PlayerPositions({
      online: async () => [{ name: 'Steve', uuid: null }],
      rcon: async (_server, command) => {
        asked.push(command.split(' ').at(-1)!)
        return command.endsWith('Pos')
          ? `Steve has the following entity data: [${x}.0d, 64.0d, 0.0d]`
          : `Steve has the following entity data: "${dimension}"`
      },
      ttlMs: 0,
      dimensionMs: 60_000,
    })
    await positions.get('survival')
    x = 10
    await positions.get('survival')
    expect(asked).toEqual(['Pos', 'Dimension', 'Pos'])
    // Through a portal: far away, and somewhere else.
    x = 2000
    dimension = 'minecraft:the_nether'
    const [steve] = await positions.get('survival')
    expect(asked.slice(3)).toEqual(['Pos', 'Dimension'])
    expect(steve).toMatchObject({ x: 2000, dimension: 'minecraft:the_nether' })
  })

  it('shares a slow sweep instead of starting another', async () => {
    let sweeps = 0
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const positions = new PlayerPositions({
      online: async () => {
        sweeps++
        await slow
        return []
      },
      rcon: async () => '',
      ttlMs: 0,
    })
    const first = positions.get('survival')
    await wait(5)
    const second = positions.get('survival')
    expect(sweeps).toBe(1)
    release()
    expect(await first).toEqual([])
    expect(await second).toEqual([])
    // Once it's done, the next ask starts a new one.
    await positions.get('survival')
    expect(sweeps).toBe(2)
  })

  it('gives nobody when the server cannot be asked', async () => {
    const positions = new PlayerPositions({
      online: async () => {
        throw new Error('stopped')
      },
      rcon: async () => '',
    })
    expect(await positions.get('survival')).toEqual([])
  })
})
