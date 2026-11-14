import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  ftruncateSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  type DiskDeps,
  DiskUsage,
  groupOf,
  largestGroup,
  measure,
  measureInTs,
  measureMany,
  measureServer,
  measureWithBinary,
} from '../server/disk'
import { biggestWorld, diskLevel, type DiskReport } from '../shared/disk'

const KB = 1024

function tree() {
  const base = mkdtempSync(join(tmpdir(), 'ft-disk-'))
  const dirs = {
    serversDir: join(base, 'servers'),
    backupsDir: join(base, 'backups'),
    exportsDir: join(base, 'exports'),
    importsDir: join(base, 'imports'),
    archiveDir: join(base, 'archive'),
    mapsDir: join(base, 'maps'),
  }
  const file = (path: string, bytes: number) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Buffer.alloc(bytes, 1))
  }
  return { base, dirs, file }
}

/** Sizes on disk are whole blocks, so compare with some slack for directories. */
const about = (actual: number, expected: number) => {
  expect(actual).toBeGreaterThanOrEqual(expected)
  expect(actual).toBeLessThan(expected + 64 * KB)
}

describe('grouping', () => {
  it('puts each top-level entry in a group', () => {
    expect(groupOf('world', null)).toBe('world')
    expect(groupOf('world_nether', null)).toBe('world')
    expect(groupOf('logs', null)).toBe('logs')
    expect(groupOf('crash-reports', null)).toBe('logs')
    expect(groupOf('mods', null)).toBe('content')
    expect(groupOf('plugins', null)).toBe('content')
    expect(groupOf('config', null)).toBe('content')
    expect(groupOf('libraries', null)).toBe('other')
    expect(groupOf('server.jar', null)).toBe('other')
  })

  it('follows a custom level-name', () => {
    expect(groupOf('survival-2026', 'survival-2026')).toBe('world')
    expect(groupOf('survival-2026', null)).toBe('other')
    expect(groupOf('maps', 'maps/main')).toBe('world')
  })

  it('names the largest group', () => {
    const groups = { world: 5, backups: 9, exports: 0, logs: 1, content: 0, map: 0, other: 0 }
    expect(largestGroup({ groups })).toBe('backups')
    expect(largestGroup({ groups: { ...groups, world: 0, backups: 0, logs: 0 } })).toBeNull()
  })
})

describe('measuring', () => {
  it("adds up files and doesn't follow symlinks", async () => {
    const { base, file } = tree()
    file(join(base, 'a', 'one'), 100 * KB)
    file(join(base, 'b', 'big'), 500 * KB)
    symlinkSync(join(base, 'b'), join(base, 'a', 'link'))
    about((await measure(join(base, 'a'))).bytes, 100 * KB)
  })

  it('counts a hard-linked file once', async () => {
    const { base, file } = tree()
    file(join(base, 'a', 'one'), 200 * KB)
    linkSync(join(base, 'a', 'one'), join(base, 'a', 'two'))
    about((await measure(join(base, 'a'))).bytes, 200 * KB)
  })

  it('treats a missing folder as empty', async () => {
    expect(await measure('/nonexistent/flytower')).toEqual({ bytes: 0, unreadable: 0 })
  })

  it.skipIf(process.getuid?.() === 0)('counts folders it cannot read', async () => {
    const { base, file } = tree()
    file(join(base, 'a', 'secret', 'x'), 10 * KB)
    chmodSync(join(base, 'a', 'secret'), 0o000)
    try {
      expect((await measure(join(base, 'a'))).unreadable).toBe(1)
    } finally {
      chmodSync(join(base, 'a', 'secret'), 0o755)
    }
  })

  it("splits a server's space into groups, with its backups, exports and map", async () => {
    const { dirs, file } = tree()
    const dir = join(dirs.serversDir, 'survival')
    file(join(dir, 'survival-2026', 'region', 'r.0.0.mca'), 400 * KB)
    file(join(dir, 'logs', 'latest.log'), 20 * KB)
    file(join(dir, 'mods', 'lithium.jar'), 60 * KB)
    file(join(dir, 'server.jar'), 80 * KB)
    file(join(dirs.backupsDir, 'survival', 'b.tar.zst'), 300 * KB)
    file(join(dirs.exportsDir, 'survival', 'w.zip'), 120 * KB)
    file(join(dirs.backupsDir, 'other', 'b.tar.zst'), 900 * KB)
    file(join(dirs.mapsDir, 'servers', 'survival', 'tiles', '0_0.png'), 50 * KB)
    const s = await measureServer(
      {
        serverDir: (n) => join(dirs.serversDir, n),
        backupsDir: dirs.backupsDir,
        exportsDir: dirs.exportsDir,
        mapsDir: dirs.mapsDir,
        levelName: async () => 'survival-2026',
      },
      'survival',
      new Date(0),
    )
    about(s.groups.world, 400 * KB)
    about(s.groups.logs, 20 * KB)
    about(s.groups.content, 60 * KB)
    about(s.groups.other, 80 * KB)
    about(s.groups.backups, 300 * KB)
    about(s.groups.exports, 120 * KB)
    about(s.groups.map, 50 * KB)
    expect(s.bytes).toBe(Object.values(s.groups).reduce((a, b) => a + b, 0))
    expect(s.unreadable).toBe(0)
  })
})

/** A tree with every awkward case: nesting, hard links across paths, symlinks, sparse files. */
function awkward() {
  const { base, file } = tree()
  file(join(base, 'world', 'region', 'r.0.0.mca'), 300 * KB)
  file(join(base, 'world', 'level.dat'), 3 * KB)
  for (let i = 0; i < 30; i++) file(join(base, 'world', 'data', `map_${i}.dat`), i * 100)
  file(join(base, 'backups', 'b.tar.zst'), 200 * KB)
  linkSync(join(base, 'backups', 'b.tar.zst'), join(base, 'world', 'linked.tar.zst'))
  symlinkSync(join(base, 'backups'), join(base, 'world', 'backups-link'))
  const sparse = openSync(join(base, 'world', 'region', 'sparse.mca'), 'w')
  ftruncateSync(sparse, 512 * 1024 * 1024)
  closeSync(sparse)
  return [join(base, 'world'), join(base, 'backups'), join(base, 'missing')]
}

describe('falling back to the TypeScript walk', () => {
  it('when flytower-du is missing', async () => {
    const paths = awkward()
    expect(await measureMany(paths, '/nonexistent/flytower-du')).toEqual(await measureInTs(paths))
  })

  it('when flytower-du fails', async () => {
    const paths = awkward()
    expect(await measureMany(paths, '/bin/false')).toEqual(await measureInTs(paths))
  })
})

// The Rust job in CI builds crates/flytower-du and runs these with FLYTOWER_DU set.
describe.skipIf(!process.env.FLYTOWER_DU)('flytower-du', () => {
  const rust = () => measureWithBinary(process.env.FLYTOWER_DU!)

  it('gives exactly the same numbers as the TypeScript walk', async () => {
    const paths = awkward()
    const ts = await measureInTs(paths)
    expect(await rust()(paths)).toEqual(ts)
    // The hard link counts towards the first path only, and the sparse file barely counts.
    expect(ts[0]!.bytes).toBeLessThan(10 * 1024 * KB)
  })

  it('measures a server the same way', async () => {
    const { dirs, file } = tree()
    file(join(dirs.serversDir, 's', 'world', 'level.dat'), 50 * KB)
    file(join(dirs.backupsDir, 's', 'b.tar.zst'), 80 * KB)
    const deps = {
      serverDir: (n: string) => join(dirs.serversDir, n),
      backupsDir: dirs.backupsDir,
      exportsDir: dirs.exportsDir,
      levelName: async () => null,
    }
    expect(await measureServer({ ...deps, measure: rust() }, 's', new Date(0))).toEqual(
      await measureServer({ ...deps, measure: measureInTs }, 's', new Date(0)),
    )
  })
})

describe('the tracker', () => {
  function setup(names = ['alpha', 'beta'], agent?: DiskDeps['agent']) {
    const { dirs, file } = tree()
    for (const n of names) file(join(dirs.serversDir, n, 'world', 'level.dat'), 50 * KB)
    file(join(dirs.importsDir, 'x', 'upload.zip'), 70 * KB)
    let saved: DiskReport | null = null
    const live = [...names]
    const usage = new DiskUsage({
      names: () => live,
      serverDir: (n) => join(dirs.serversDir, n),
      ...dirs,
      levelName: async () => null,
      save: (r) => (saved = r),
      now: () => new Date(Date.UTC(2026, 10, 10)),
      agent,
    })
    return { usage, dirs, file, live, saved: () => saved }
  }

  it('measures everything, and keeps the result', async () => {
    const { usage, saved } = setup()
    await usage.refresh()
    const r = usage.current()
    expect(r.servers.map((s) => s.server)).toEqual(['alpha', 'beta'])
    about(r.shared!.imports, 70 * KB)
    expect(r.measuring).toBe(false)
    expect(saved()?.servers).toHaveLength(2)
  })

  it('re-measures one server after a change', async () => {
    const { usage, dirs, file } = setup()
    await usage.refresh()
    const before = usage.server('alpha')!.groups.backups
    file(join(dirs.backupsDir, 'alpha', 'new.tar.zst'), 256 * KB)
    await usage.refresh('alpha')
    about(usage.server('alpha')!.groups.backups - before, 256 * KB)
  })

  it('folds requests made while measuring into the same run', async () => {
    const { usage } = setup()
    const a = usage.refresh()
    const b = usage.refresh('alpha')
    expect(a).toBe(b)
    await a
  })

  it('starts from the saved result and drops deleted servers', async () => {
    const { usage, live } = setup()
    await usage.refresh()
    live.splice(live.indexOf('beta'), 1)
    expect(usage.current().servers.map((s) => s.server)).toEqual(['alpha'])
    usage.forget('alpha')
    expect(usage.server('alpha')).toBeNull()
  })
})

describe('measuring through the agent', () => {
  const groups = { world: 100, logs: 1, content: 2, map: 0, backups: 50, exports: 0, other: 3 }
  const system = {
    java: 10,
    flytower: 20,
    logs: 30,
    temp: 40,
    unreadable: 0,
    journal: 25,
    aptCache: 5,
    oldReleases: 7,
  }
  function setup(answer: DiskDeps['agent']) {
    const { dirs, file } = tree()
    file(join(dirs.serversDir, 'alpha', 'world', 'level.dat'), 50 * KB)
    file(join(dirs.importsDir, 'upload.zip'), 70 * KB)
    const calls: [string[], boolean][] = []
    const usage = new DiskUsage({
      names: () => ['alpha'],
      serverDir: (n) => join(dirs.serversDir, n),
      ...dirs,
      levelName: async () => null,
      agent: (servers, sys) => (calls.push([servers, sys]), answer!(servers, sys)),
    })
    return { usage, calls }
  }

  it("uses the agent's figures, with the rest of the machine in parts", async () => {
    const { usage, calls } = setup(async (servers, sys) => ({
      servers: Object.fromEntries(servers.map((s) => [s, { groups, unreadable: 0 }])),
      shared: sys ? { imports: 9, archive: 0, unreadable: 0 } : null,
      system: sys ? system : null,
    }))
    await usage.refresh()
    const r = usage.current()
    expect(calls).toEqual([
      [[], true],
      [['alpha'], false],
    ])
    expect(r.machine).toBe('local')
    expect(r.servers[0]!.bytes).toBe(156)
    expect(r.servers[0]!.groups.world).toBe(100)
    expect(r.shared).toEqual({ imports: 9, archive: 0, unreadable: 0 })
    expect(r.system).toEqual(system)
  })

  it('walks by itself, with the system as one slice, when the agent fails', async () => {
    const { usage } = setup(async () => {
      throw new Error('unknown verb "disk.usage"')
    })
    await usage.refresh()
    const r = usage.current()
    about(r.servers[0]!.groups.world, 50 * KB)
    about(r.shared!.imports, 70 * KB)
    expect(r.system).toBeNull()
  })
})

describe('levels', () => {
  it('warns at 85% and is urgent at 95%', () => {
    expect(diskLevel(null)).toBe('ok')
    expect(diskLevel(84.9)).toBe('ok')
    expect(diskLevel(85)).toBe('warning')
    expect(diskLevel(95)).toBe('urgent')
  })
})

describe('suggesting a trim', () => {
  const GB = 1024 ** 3
  const groups = (world: number, backups = 0) => ({
    world,
    backups,
    exports: 0,
    logs: 0,
    content: 0,
    map: 0,
    other: 0,
  })
  const report = (over: Partial<DiskReport> = {}): DiskReport => ({
    servers: [
      { server: 'survival', bytes: 0, groups: groups(3 * GB, GB), unreadable: 0, measuredAt: '' },
      { server: 'creative', bytes: 0, groups: groups(GB), unreadable: 0, measuredAt: '' },
    ],
    shared: { imports: 0, archive: 0, unreadable: 0 },
    system: null,
    measuredAt: null,
    ...over,
  })

  it('names the server whose world is the biggest thing on the disk', () => {
    expect(biggestWorld(report())).toEqual({ server: 'survival', bytes: 3 * GB })
  })

  it('says nothing when something else is bigger, or the world is small', () => {
    const backups = report()
    backups.servers[1]!.groups.backups = 4 * GB
    expect(biggestWorld(backups)).toBeNull()
    expect(
      biggestWorld(report({ shared: { imports: 0, archive: 5 * GB, unreadable: 0 } })),
    ).toBeNull()
    expect(
      biggestWorld(
        report({
          system: {
            java: 4 * GB,
            flytower: 0,
            logs: 0,
            temp: 0,
            unreadable: 0,
            journal: 0,
            aptCache: 0,
            oldReleases: 0,
          },
        }),
      ),
    ).toBeNull()
    const small = report()
    small.servers = [{ ...small.servers[0]!, groups: groups(100 * 1024 ** 2) }]
    expect(biggestWorld(small)).toBeNull()
  })
})
