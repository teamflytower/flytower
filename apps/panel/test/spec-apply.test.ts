import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Verb } from '@flytower/protocol'
import {
  vanillaTweaksProvider,
  ProviderError,
  type ContentProvider,
  type ContentRef,
  type ContentTarget,
  type LoaderProvider,
  type ResolvedContent,
} from '@flytower/providers'
import { eq } from 'drizzle-orm'
import { ServerSpec, type ServerSpecInput } from '../shared/spec'
import { openDb, schema } from '../server/db'
import { JobRunner, type AgentCall } from '../server/jobs/runner'
import { SpecService } from '../server/spec/apply'
import { writeZip } from '../server/zip'
import { LOCK_FILE, readLock } from '../server/spec/lock'
import { parseProperties, stringifyProperties, setProperties, toRecord } from '../server/properties'
import type { TaskSpec } from '../shared/schedules'

const sha512 = (s: string) => new Bun.CryptoHasher('sha512').update(s).digest('hex')

/** A tiny catalogue: project → versions (newest first), each with a body. */
const CATALOGUE: Record<
  string,
  {
    title: string
    versions: string[]
    deps?: string[]
    kind?: 'mod' | 'plugin' | 'datapack'
    /** Versions for Minecraft other than 26.3. */
    other?: Record<string, string[]>
    clientOnly?: boolean
  }
> = {
  lithium: {
    title: 'Lithium',
    versions: ['0.19', '0.18'],
    other: { '26.4': ['0.20'], '26.3.1': ['0.19'] },
  },
  chunky: { title: 'Chunky', versions: ['1.4'], deps: ['fabric-api'] },
  'fabric-api': { title: 'Fabric API', versions: ['0.100'] },
  terralith: { title: 'Terralith', versions: ['2.5'], kind: 'datapack' },
  essentials: { title: 'EssentialsX', versions: ['2.21'], kind: 'plugin' },
  voxy: { title: 'Voxy', versions: ['0.2'], clientOnly: true },
}

function fakeModrinth(opts: { badHash?: string } = {}): ContentProvider {
  const make = (slug: string, version: string): ResolvedContent => {
    const p = CATALOGUE[slug]!
    const kind = p.kind ?? 'mod'
    return {
      source: 'modrinth',
      projectId: `id-${slug}`,
      slug,
      title: p.title,
      versionId: `${slug}@${version}`,
      versionNumber: version,
      kind,
      filename: `${slug}-${version}.${kind === 'datapack' ? 'zip' : 'jar'}`,
      url: `https://cdn.test/${slug}/${version}`,
      hash: {
        algorithm: 'sha512',
        value: opts.badHash === slug ? 'f'.repeat(128) : sha512(`${slug}@${version}`),
      },
      size: 100,
      dependencies: (p.deps ?? []).map((d) => ({ projectId: `id-${d}`, versionId: null })),
      incompatible: [],
      ...(p.clientOnly ? { clientOnly: true } : {}),
    }
  }
  return {
    id: 'modrinth',
    name: 'Fake',
    search: async () => ({ hits: [], total: 0 }),
    versions: async () => [],
    resolve: async (ref: ContentRef, target: ContentTarget) => {
      const slug = ref.project.replace(/^id-/, '')
      const p = CATALOGUE[slug]
      if (!p) throw new ProviderError(`No project ${ref.project}`)
      const versions =
        target.minecraft === '26.3' ? p.versions : (p.other?.[target.minecraft] ?? [])
      if (!versions.length) {
        throw new ProviderError(`${p.title} has no version for Minecraft ${target.minecraft}.`)
      }
      const version = ref.version ? ref.version.replace(/^.*@/, '') : versions[0]!
      if (!versions.includes(version))
        throw new ProviderError(`${p.title} has no version "${version}".`)
      return make(slug, version)
    },
  }
}

// A Vanilla Tweaks download: a zip holding one datapack zip, both with names at the root.
const vtDir = mkdtempSync(join(tmpdir(), 'ft-vt-'))
writeFileSync(join(vtDir, 'pack.mcmeta'), '{"pack":{"pack_format":80}}')
const entry = (name: string, source: string) => ({
  name,
  source,
  size: Bun.file(source).size,
  mtime: new Date(),
  mode: 0o644,
})
await writeZip([entry('pack.mcmeta', join(vtDir, 'pack.mcmeta'))], join(vtDir, 'inner.zip'))
await writeZip(
  [entry('graves v3.0.0 (MC 26.3).zip', join(vtDir, 'inner.zip'))],
  join(vtDir, 'wrapped.zip'),
)
const INNER = readFileSync(join(vtDir, 'inner.zip'))
const WRAPPED = readFileSync(join(vtDir, 'wrapped.zip'))

const fetchFiles = (async (input: string | URL | Request) => {
  const url = String(input)
  const m = /cdn\.test\/([^/]+)\/(.+)$/.exec(url)
  if (m) return new Response(`${m[1]}@${m[2]}`)
  if (url.endsWith('/26.3/dpcategories.json')) {
    return Response.json({
      categories: [
        { category: 'Survival', packs: [{ name: 'graves', display: 'Graves', version: '3.0.0' }] },
      ],
    })
  }
  if (url.endsWith('/26.3/ctcategories.json')) return Response.json({ categories: [] })
  if (url.endsWith('/zipdatapacks.php')) {
    return Response.json({ status: 'success', link: '/download/VanillaTweaks_d1_UNZIP_ME.zip' })
  }
  if (url.endsWith('/download/VanillaTweaks_d1_UNZIP_ME.zip')) return new Response(WRAPPED)
  return new Response('', { status: 404 })
}) as never

const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex')

/** Minecraft 26.2 to 26.4; 26.4 needs Java 26. */
function fakeLoader(id: 'vanilla' | 'fabric' | 'paper'): LoaderProvider {
  return {
    id,
    name: id,
    minecraftVersions: async () =>
      ['26.4', '26.3.1', '26.3', '26.2'].map((v) => ({ id: v, stable: true })),
    loaderVersions: async () => [],
    resolve: async (mc, loader) => ({
      url: `https://cdn.test/${id}-server/${mc}`,
      hash: {
        algorithm: 'sha1',
        value: mc === '26.3.1' ? '0'.repeat(40) : sha1(`${id}-server@${mc}`),
      },
      javaMajor: mc === '26.4' ? 26 : 25,
      loaderVersion:
        id === 'fabric' ? (loader ?? '0.21.0') : id === 'paper' ? (loader ?? '120') : null,
    }),
  }
}

function setup(
  opts: { running?: boolean; loader?: 'vanilla' | 'fabric' | 'paper'; badHash?: string } = {},
) {
  const db = openDb(':memory:')
  const base = mkdtempSync(join(tmpdir(), 'ft-spec-'))
  const servers = join(base, 'servers')
  const dir = join(servers, 'survival')
  mkdirSync(join(dir, 'world'), { recursive: true })
  writeFileSync(join(dir, 'server.properties'), 'server-port=25565\nmotd=Hello\nenable-rcon=true\n')
  db.insert(schema.servers)
    .values({
      name: 'survival',
      displayName: 'Survival',
      loader: opts.loader ?? 'fabric',
      mcVersion: '26.3',
      loaderVersion: '0.20.1',
      javaMajor: 25,
      memoryMb: 4096,
      port: 25565,
      rconPort: 25575,
      rconPassword: 'x',
      eulaAcceptedAt: new Date(),
    })
    .run()
  db.insert(schema.servers)
    .values({
      name: 'creative',
      displayName: 'Creative',
      loader: 'vanilla',
      mcVersion: '26.3',
      javaMajor: 25,
      memoryMb: 2048,
      port: 25566,
      rconPort: 25576,
      rconPassword: 'y',
      eulaAcceptedAt: new Date(),
    })
    .run()

  let state = opts.running ? 'active' : 'inactive'
  const calls: string[] = []
  const statsChanges: { name: string; before: unknown }[] = []
  const mapSyncs: string[] = []
  const agent = (async (verb: Verb, params: unknown) => {
    calls.push(verb === 'server.configure' ? `${verb} ${JSON.stringify(params)}` : verb)
    if (verb === 'service.status') return { active: state, since: null }
    if (verb === 'service.stop') state = 'inactive'
    if (verb === 'service.start') state = 'active'
    return {}
  }) as AgentCall
  const runner = new JobRunner({
    db,
    agent,
    loaders: {} as never,
    fetch: fetchFiles,
    sleep: async () => {},
    totalMemoryMb: () => 16384,
  })
  let locked = false
  const snapshots: string[] = []
  const scheduled: { tasks: TaskSpec[]; timezone: string } = { tasks: [], timezone: 'UTC' }
  const propsPath = join(dir, 'server.properties')
  const service = new SpecService({
    db,
    serverDir: (n) => join(servers, n),
    agent,
    jobs: runner,
    backups: {
      lock: () => {
        if (locked) throw new Error('busy')
        locked = true
        return () => void (locked = false)
      },
      snapshot: async (_n, note) => {
        snapshots.push(note)
        return {} as never
      },
    },
    modrinth: fakeModrinth(opts),
    vanillatweaks: vanillaTweaksProvider(fetchFiles, 'https://vt.test'),
    loaders: {
      vanilla: fakeLoader('vanilla'),
      fabric: fakeLoader('fabric'),
      paper: fakeLoader('paper'),
    },
    fetch: fetchFiles,
    readProperties: async () => toRecord(parseProperties(readFileSync(propsPath, 'utf8'))),
    writeProperties: async (_n, changes) =>
      writeFileSync(
        propsPath,
        stringifyProperties(
          setProperties(parseProperties(readFileSync(propsPath, 'utf8')), changes),
        ),
      ),
    offsiteTargets: () => [
      { id: 1, name: 'B2' },
      { id: 2, name: 'R2' },
    ],
    offsiteChanged: (n) => calls.push(`offsite ${n}`),
    statsChanged: (name, before) => statsChanges.push({ name, before }),
    mapChanged: async (name) => void mapSyncs.push(name),
    tasks: {
      tasks: () => scheduled.tasks,
      replace: (_n, tasks, timezone) => {
        scheduled.tasks = tasks
        if (timezone) scheduled.timezone = timezone
      },
    },
    sleep: async () => {},
  })
  const spec = (extra: Partial<ServerSpecInput> = {}) =>
    ServerSpec.parse({
      name: 'survival',
      loader: { type: opts.loader ?? 'fabric', minecraft: '26.3' },
      ...extra,
    })
  return { db, dir, service, calls, snapshots, spec, scheduled, statsChanges, mapSyncs }
}

describe('plan', () => {
  it('lists content to add, with dependencies and why', async () => {
    const { service, spec } = setup()
    const plan = await service.plan(
      'survival',
      spec({ content: [{ modrinth: 'chunky' }, { modrinth: 'lithium' }] }),
    )
    expect(plan.problems).toEqual([])
    expect(plan.changes).toEqual([
      { area: 'content', action: 'add', label: 'Chunky', to: '1.4', note: undefined },
      { area: 'content', action: 'add', label: 'Lithium', to: '0.19', note: undefined },
      {
        area: 'content',
        action: 'add',
        label: 'Fabric API',
        to: '0.100',
        note: 'Needed by Chunky',
      },
    ])
    expect(plan.backup).toBe(true)
    expect(plan.restart).toBe(true)
    expect(plan.downloadBytes).toBe(300)
    expect(plan).not.toHaveProperty('work')
  })

  it('an unchanged spec plans nothing', async () => {
    const { service, spec } = setup()
    const plan = await service.plan('survival', spec())
    expect(plan.changes).toEqual([])
    expect(plan.restart).toBe(false)
    expect(plan.backup).toBe(false)
  })

  it('diffs settings, properties and backups, leaving out what the spec leaves out', async () => {
    const { service, spec } = setup()
    const plan = await service.plan(
      'survival',
      spec({
        displayName: 'Big Survival',
        memory: '6G',
        port: 25570,
        properties: { motd: 'Hello', 'max-players': 30 },
        backups: { schedule: '0 4 * * *' },
      }),
    )
    expect(plan.changes.map((c) => `${c.action} ${c.label} ${c.from ?? ''}→${c.to}`)).toEqual([
      'set Display name Survival→Big Survival',
      'set Memory 4G→6G',
      'set Port 25565→25570',
      'add max-players →30',
      'set Backups off, keep 6/7/4→0 4 * * * (UTC), keep 6/7/4',
    ])
    expect(plan.restart).toBe(true)
    expect(plan.backup).toBe(false)
  })

  it('turns restarting when not responding on without a restart', async () => {
    const { service, spec, db } = setup()
    const plan = await service.plan(
      'survival',
      spec({ recovery: { restartWhenUnresponsive: true } }),
    )
    expect(plan.changes).toEqual([
      {
        area: 'settings',
        action: 'set',
        label: 'Restart when not responding',
        from: 'Off',
        to: 'On',
      },
    ])
    expect(plan.restart).toBe(false)
    await (
      await service.apply('survival', plan.id)
    ).done
    expect(
      db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get(),
    ).toMatchObject({ restartWhenUnresponsive: true })
    expect((await service.currentSpec('survival')).recovery).toEqual({
      restartWhenUnresponsive: true,
    })
    // Left out, it stays.
    expect((await service.plan('survival', spec())).changes).toEqual([])
  })

  it('changes player stats settings and says what was there before', async () => {
    const { service, spec, db, statsChanges } = setup()
    const leaveOut = [{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve' }]
    const plan = await service.plan('survival', spec({ stats: { leaveOut } }))
    expect(plan.changes).toEqual([
      {
        area: 'settings',
        action: 'set',
        label: 'Player stats',
        from: 'On',
        to: 'On, 1 player left out',
      },
    ])
    expect(plan.restart).toBe(false)
    await (
      await service.apply('survival', plan.id)
    ).done
    expect(
      db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()?.stats,
    ).toEqual({ enabled: true, leaveOut })
    expect(statsChanges).toEqual([{ name: 'survival', before: null }])
    expect((await service.currentSpec('survival')).stats).toEqual({ enabled: true, leaveOut })
    // Left out, it stays.
    expect((await service.plan('survival', spec())).changes).toEqual([])
  })

  it('changes map settings and tells the map service', async () => {
    const { service, spec, db, mapSyncs } = setup()
    const plan = await service.plan('survival', spec({ map: { enabled: true, public: true } }))
    expect(plan.changes).toEqual([
      {
        area: 'settings',
        action: 'set',
        label: 'Web map',
        from: 'Off',
        to: 'On: anyone, with players',
      },
    ])
    expect(plan.restart).toBe(false)
    await (
      await service.apply('survival', plan.id)
    ).done
    expect(
      db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()?.map,
    ).toEqual({ enabled: true, public: true, players: true })
    expect(mapSyncs).toEqual(['survival'])
    expect((await service.currentSpec('survival')).map).toEqual({
      enabled: true,
      public: true,
      players: true,
    })
    expect((await service.plan('survival', spec())).changes).toEqual([])
  })

  it('sets off-site storage by name, and refuses one that does not exist', async () => {
    const { service, spec, db, calls } = setup()
    const set = await service.plan('survival', spec({ backups: { offsite: 'b2' } }))
    expect(set.problems).toEqual([])
    expect(set.changes).toEqual([
      { area: 'backups', action: 'set', label: 'Off-site copies', from: 'None', to: 'B2' },
    ])
    expect(set.restart).toBe(false)
    await (
      await service.apply('survival', set.id)
    ).done
    expect(
      db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get(),
    ).toMatchObject({ offsiteTarget: 1 })
    expect(calls).toContain('offsite survival')
    expect((await service.currentSpec('survival')).backups?.offsite).toBe('B2')
    expect((await service.plan('survival', spec({ backups: {} }))).changes).toEqual([])
    expect((await service.plan('survival', spec({ backups: { offsite: null } }))).changes).toEqual([
      { area: 'backups', action: 'set', label: 'Off-site copies', from: 'B2', to: 'None' },
    ])
    expect((await service.plan('survival', spec({ backups: { offsite: 'S3' } }))).problems).toEqual(
      ['There\'s no off-site storage called "S3". Use one of: B2, R2.'],
    )
  })

  it('refuses a port clash, a new name and mods on vanilla', async () => {
    const { service, spec } = setup({ loader: 'vanilla' })
    expect((await service.plan('survival', spec({ port: 25566 }))).problems).toEqual([
      'Port 25566 is already used by creative.',
    ])
    expect((await service.plan('survival', spec({ name: 'other' }))).problems[0]).toContain(
      "Names can't change",
    )
    const mods = await service.plan('survival', spec({ content: [{ modrinth: 'lithium' }] }))
    expect(mods.problems).toContain("Lithium is a mod, which a vanilla server can't run.")
    expect((await service.plan('survival', spec({ memory: '16G' }))).problems[0]).toContain(
      'more than this machine has room for',
    )
    const datapack = await service.plan('survival', spec({ content: [{ modrinth: 'terralith' }] }))
    expect(datapack.problems).toEqual([])
  })

  it('sets, keeps, clears and refuses a taken hostname', async () => {
    const { service, spec, db } = setup()
    db.update(schema.servers)
      .set({ hostname: 'creative.example.com' })
      .where(eq(schema.servers.name, 'creative'))
      .run()
    const set = await service.plan('survival', spec({ hostname: 'survival.example.com' }))
    expect(set.changes).toMatchObject([{ action: 'add', label: 'Address' }])
    expect(set.restart).toBe(false)
    await (
      await service.apply('survival', set.id)
    ).done
    expect((await service.plan('survival', spec())).changes).toEqual([])
    expect((await service.plan('survival', spec({ hostname: null }))).changes).toMatchObject([
      { action: 'remove', label: 'Address', from: 'survival.example.com' },
    ])
    expect(
      (await service.plan('survival', spec({ hostname: 'creative.example.com' }))).problems,
    ).toEqual(["creative.example.com is already creative's address."])
  })

  it('flags hand-added files that are in the way, and lists unmanaged ones', async () => {
    const { service, spec, dir } = setup()
    mkdirSync(join(dir, 'mods'))
    writeFileSync(join(dir, 'mods', 'lithium-0.19.jar'), 'by hand')
    writeFileSync(join(dir, 'mods', 'other.jar'), 'by hand')
    // The hostname router's mod is the panel's own, not content.
    writeFileSync(join(dir, 'mods', 'flytower-proxy.jar'), 'from the release')
    const plan = await service.plan('survival', spec({ content: [{ modrinth: 'lithium' }] }))
    expect(plan.unmanaged).toEqual(['mods/lithium-0.19.jar', 'mods/other.jar'])
    expect(plan.problems[0]).toContain('added by hand')
  })
})

describe('client-only content', () => {
  it('plans and installs a client-only mod with a warning, and locks it', async () => {
    const { service, spec, dir } = setup()
    const plan = await service.plan('survival', spec({ content: [{ modrinth: 'voxy' }] }))
    expect(plan.problems).toEqual([])
    expect(plan.warnings).toEqual([
      "Modrinth marks Voxy as client-only. It's installed because you asked for it; remove it if the server won't start.",
    ])
    const { done } = await service.apply('survival', plan.id)
    expect(await done).toMatchObject({ state: 'succeeded' })
    expect(existsSync(join(dir, 'mods', 'voxy-0.2.jar'))).toBe(true)
    expect((await readLock(dir)).content.map((l) => l.slug)).toEqual(['voxy'])
  })
})

describe('apply', () => {
  it('installs content and writes the lockfile, restarting a running server', async () => {
    const { service, spec, dir, calls, snapshots, db } = setup({ running: true })
    const plan = await service.plan(
      'survival',
      spec({ content: [{ modrinth: 'chunky' }, { modrinth: 'terralith' }] }),
    )
    const { done } = await service.apply('survival', plan.id)
    expect(await done).toMatchObject({ state: 'succeeded' })
    expect(readFileSync(join(dir, 'mods', 'chunky-1.4.jar'), 'utf8')).toBe('chunky@1.4')
    expect(existsSync(join(dir, 'mods', 'fabric-api-0.100.jar'))).toBe(true)
    expect(existsSync(join(dir, 'world', 'datapacks', 'terralith-2.5.zip'))).toBe(true)
    expect(existsSync(join(dir, '.flytower-staging'))).toBe(false)
    const lock = await readLock(dir)
    expect(lock.content.map((l) => l.path)).toEqual([
      'mods/chunky-1.4.jar',
      'mods/fabric-api-0.100.jar',
      'world/datapacks/terralith-2.5.zip',
    ])
    expect(lock.content[0]!.sha256).toBe(
      new Bun.CryptoHasher('sha256').update('chunky@1.4').digest('hex'),
    )
    expect(snapshots).toEqual(['Before applying spec changes'])
    expect(calls).toContain('service.stop')
    expect(calls.at(-2)).toBe('service.start')
    const row = db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()!
    expect(row.content).toEqual([{ modrinth: 'chunky' }, { modrinth: 'terralith' }])
  })

  it('keeps locked versions, upgrades when asked, and removes what was dropped', async () => {
    const { service, spec, dir } = setup()
    const first = await service.plan(
      'survival',
      spec({ content: [{ modrinth: 'lithium', version: '0.18' }, { modrinth: 'chunky' }] }),
    )
    await (
      await service.apply('survival', first.id)
    ).done

    // Unpinned now, but the lockfile keeps 0.18.
    const same = await service.plan(
      'survival',
      spec({ content: [{ modrinth: 'lithium' }, { modrinth: 'chunky' }] }),
    )
    expect(same.changes).toEqual([])

    const up = await service.plan('survival', spec({ content: [{ modrinth: 'lithium' }] }), [
      'lithium',
    ])
    expect(up.changes.map((c) => `${c.action} ${c.label}`)).toEqual([
      'update Lithium',
      'remove Chunky',
      'remove Fabric API',
    ])
    expect(await (await service.apply('survival', up.id)).done).toMatchObject({
      state: 'succeeded',
    })
    expect(existsSync(join(dir, 'mods', 'lithium-0.18.jar'))).toBe(false)
    expect(existsSync(join(dir, 'mods', 'lithium-0.19.jar'))).toBe(true)
    expect(existsSync(join(dir, 'mods', 'chunky-1.4.jar'))).toBe(false)
  })

  it('reinstalls a locked file that has gone missing', async () => {
    const { service, spec, dir } = setup()
    const s = spec({ content: [{ modrinth: 'lithium' }] })
    await (
      await service.apply('survival', (await service.plan('survival', s)).id)
    ).done
    Bun.spawnSync(['rm', join(dir, 'mods', 'lithium-0.19.jar')])
    const plan = await service.plan('survival', s)
    expect(plan.changes).toMatchObject([{ action: 'reinstall', label: 'Lithium' }])
  })

  it('a bad download changes nothing and leaves the server running', async () => {
    const { service, spec, dir, calls } = setup({ running: true, badHash: 'chunky' })
    const plan = await service.plan(
      'survival',
      spec({ content: [{ modrinth: 'lithium' }, { modrinth: 'chunky' }] }),
    )
    const final = await (await service.apply('survival', plan.id)).done
    expect(final).toMatchObject({ state: 'failed' })
    expect(final.message).toContain('checksum')
    expect(existsSync(join(dir, 'mods'))).toBe(false)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
    expect(calls).not.toContain('service.stop')
  })

  it('saves settings through the agent and server.properties without a restart when stopped', async () => {
    const { service, spec, dir, calls, db } = setup()
    const plan = await service.plan(
      'survival',
      spec({ memory: '6G', port: 25570, properties: { motd: 'Hi' } }),
    )
    expect(await (await service.apply('survival', plan.id)).done).toMatchObject({
      state: 'succeeded',
    })
    expect(calls).toContain('server.configure {"name":"survival","memoryMb":6144,"port":25570}')
    expect(calls).not.toContain('service.start')
    const props = readFileSync(join(dir, 'server.properties'), 'utf8')
    expect(props).toContain('server-port=25570')
    expect(props).toContain('motd=Hi')
    const row = db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()!
    expect(row).toMatchObject({ memoryMb: 6144, port: 25570 })
  })

  it('plans and applies scheduled tasks without a restart', async () => {
    const { service, spec, calls, scheduled } = setup({ running: true })
    scheduled.tasks = [
      { kind: 'command', cron: '*/30 * * * *', text: 'save-all', warn: [], skipWhenEmpty: false },
    ]
    const plan = await service.plan(
      'survival',
      spec({ timezone: 'Europe/London', schedules: [{ restart: '0 5 * * *', warn: ['1m'] }] }),
    )
    expect(plan.changes.filter((c) => c.area === 'schedules')).toEqual([
      { area: 'schedules', action: 'set', label: 'Time zone', from: 'UTC', to: 'Europe/London' },
      { area: 'schedules', action: 'add', label: 'Restart (0 5 * * *), warning 1m' },
      { area: 'schedules', action: 'remove', label: 'Run "save-all" (*/30 * * * *)' },
    ])
    expect(plan.restart).toBe(false)
    expect(await (await service.apply('survival', plan.id)).done).toMatchObject({
      state: 'succeeded',
    })
    expect(calls).not.toContain('service.stop')
    expect(scheduled).toEqual({
      timezone: 'Europe/London',
      tasks: [{ kind: 'restart', cron: '0 5 * * *', text: null, warn: [60], skipWhenEmpty: true }],
    })
    // The YAML tab shows them, and leaving them out changes nothing.
    const current = await service.currentSpec('survival')
    expect(current.schedules).toEqual([
      { restart: '0 5 * * *', warn: ['1m'], skipWarningsWhenEmpty: true },
    ])
    const same = await service.plan('survival', spec({ properties: {} }))
    expect(same.changes).toEqual([])
  })

  it('refuses a stale, unknown or blocked plan', async () => {
    const { service, spec, dir } = setup()
    const plan = await service.plan('survival', spec({ properties: { motd: 'Hi' } }))
    writeFileSync(join(dir, 'server.properties'), 'motd=Changed by hand\n')
    await expect(service.apply('survival', plan.id)).rejects.toThrow('changed since')
    await expect(service.apply('survival', 'nope')).rejects.toThrow('expired')
    const blocked = await service.plan('survival', spec({ port: 25566 }))
    await expect(service.apply('survival', blocked.id)).rejects.toThrow('already used')
  })
})

describe('version and loader changes', () => {
  const on = (minecraft: string, type: 'vanilla' | 'fabric' = 'fabric', version?: string) =>
    ServerSpec.parse({
      name: 'survival',
      loader: { type, minecraft, ...(version ? { version } : {}) },
      content: [{ modrinth: 'lithium' }],
    })

  it('upgrades Minecraft, moving content, the loader and Java along', async () => {
    const { service, dir, calls, db, snapshots } = setup({ running: true })
    writeFileSync(join(dir, 'server.jar'), 'old jar')
    const first = await service.plan('survival', on('26.3', 'fabric', '0.20.1'))
    await (
      await service.apply('survival', first.id)
    ).done
    calls.length = 0

    const plan = await service.plan('survival', on('26.4', 'fabric', '0.20.1'))
    expect(plan.problems).toEqual([])
    expect(plan.changes.map((c) => `${c.action} ${c.label} ${c.from} → ${c.to}`)).toEqual([
      'set Minecraft 26.3 → 26.4',
      'set Fabric loader 0.20.1 → 0.21.0',
      'set Java 25 → 26',
      'update Lithium 0.19 → 0.20',
    ])
    expect(plan).toMatchObject({ backup: true, restart: true })

    expect(await (await service.apply('survival', plan.id)).done).toMatchObject({
      state: 'succeeded',
    })
    expect(readFileSync(join(dir, 'server.jar'), 'utf8')).toBe('fabric-server@26.4')
    expect(existsSync(join(dir, 'mods', 'lithium-0.20.jar'))).toBe(true)
    expect(calls).toContain('runtime.install')
    expect(calls).toContain('server.configure {"name":"survival","javaMajor":26}')
    expect(snapshots.at(-1)).toBe('Before applying spec changes')
    const row = db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()!
    expect(row).toMatchObject({ mcVersion: '26.4', loaderVersion: '0.21.0', javaMajor: 26 })
    // Nothing left to do once applied.
    expect((await service.plan('survival', await service.currentSpec('survival'))).changes).toEqual(
      [],
    )
  })

  it('refuses going back, unknown versions, and content with no build for the new version', async () => {
    const { service } = setup()
    expect((await service.plan('survival', on('26.2'))).problems[0]).toContain('restore a backup')
    expect((await service.plan('survival', on('27.1'))).problems).toContain(
      "Fabric doesn't have Minecraft 27.1.",
    )
    const stuck = await service.plan(
      'survival',
      ServerSpec.parse({
        name: 'survival',
        loader: { type: 'fabric', minecraft: '26.4' },
        content: [{ modrinth: 'chunky' }],
      }),
    )
    expect(stuck.problems).toContain('Chunky has no version for Minecraft 26.4.')
  })

  it('switches vanilla to Fabric, and bumps only the Fabric loader', async () => {
    const { service, dir, db } = setup({ loader: 'vanilla' })
    writeFileSync(join(dir, 'server.jar'), 'old jar')
    db.update(schema.servers).set({ loaderVersion: null }).run()
    const plan = await service.plan('survival', on('26.3'))
    expect(plan.changes.map((c) => `${c.action} ${c.label}`)).toEqual([
      'set Loader',
      'add Fabric loader',
      'add Lithium',
    ])
    await (
      await service.apply('survival', plan.id)
    ).done
    expect(readFileSync(join(dir, 'server.jar'), 'utf8')).toBe('fabric-server@26.3')

    const bump = await service.plan('survival', on('26.3', 'fabric', '0.22.0'))
    expect(bump.changes.map((c) => `${c.label} ${c.from} → ${c.to}`)).toEqual([
      'Fabric loader 0.21.0 → 0.22.0',
    ])
    expect(bump.restart).toBe(true)
  })

  it('switches vanilla to Paper and follows Paper builds', async () => {
    const { service, dir, db } = setup({ loader: 'vanilla' })
    writeFileSync(join(dir, 'server.jar'), 'old jar')
    db.update(schema.servers).set({ loaderVersion: null }).run()
    const paper = (minecraft: string, version?: string) =>
      ServerSpec.parse({
        name: 'survival',
        loader: { type: 'paper', minecraft, ...(version ? { version } : {}) },
      })
    const plan = await service.plan('survival', paper('26.3'))
    expect(plan.problems).toEqual([])
    expect(plan.changes.map((c) => `${c.action} ${c.label} ${c.to}`)).toEqual([
      'set Loader Paper',
      'add Paper build 120',
    ])
    await (
      await service.apply('survival', plan.id)
    ).done
    expect(readFileSync(join(dir, 'server.jar'), 'utf8')).toBe('paper-server@26.3')
    const row = db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()!
    expect(row).toMatchObject({ loader: 'paper', loaderVersion: '120' })

    const bump = await service.plan('survival', paper('26.3', '125'))
    expect(bump.changes.map((c) => `${c.label} ${c.from} → ${c.to}`)).toEqual([
      'Paper build 120 → 125',
    ])
    expect((await service.plan('survival', paper('26.2'))).problems[0]).toContain(
      'restore a backup',
    )
  })

  it("won't move a Fabric server with mods to Paper", async () => {
    const { service } = setup()
    const plan = await service.plan(
      'survival',
      ServerSpec.parse({
        name: 'survival',
        loader: { type: 'paper', minecraft: '26.3' },
        content: [{ modrinth: 'lithium' }],
      }),
    )
    expect(plan.problems.join(' ')).toMatch(/mod/i)
  })

  it('a bad jar download changes nothing', async () => {
    const { service, dir, db, calls } = setup({ running: true })
    writeFileSync(join(dir, 'server.jar'), 'old jar')
    // The fake publishes a wrong checksum for 26.3.1.
    const plan = await service.plan('survival', on('26.3.1'))
    const final = await (await service.apply('survival', plan.id)).done
    expect(final).toMatchObject({ state: 'failed' })
    expect(final.message).toContain('checksum')
    expect(readFileSync(join(dir, 'server.jar'), 'utf8')).toBe('old jar')
    expect(calls).not.toContain('service.stop')
    const row = db.select().from(schema.servers).where(eq(schema.servers.name, 'survival')).get()!
    expect(row.mcVersion).toBe('26.3')
  })
})

describe('plugins', () => {
  it('installs a plugin into plugins/ on Paper, and refuses it on Fabric', async () => {
    const { service, spec, dir } = setup({ loader: 'paper' })
    const plan = await service.plan('survival', spec({ content: [{ modrinth: 'essentials' }] }))
    expect(plan.problems).toEqual([])
    expect(await (await service.apply('survival', plan.id)).done).toMatchObject({
      state: 'succeeded',
    })
    expect(readFileSync(join(dir, 'plugins', 'essentials-2.21.jar'), 'utf8')).toBe(
      'essentials@2.21',
    )
    writeFileSync(join(dir, 'plugins', 'handmade.jar'), 'x')
    const list = await service.content('survival')
    expect(list.accepts).toEqual(['plugin', 'datapack'])
    expect(list.unmanaged).toEqual([{ path: 'plugins/handmade.jar', kind: 'plugin' }])

    const fabric = setup()
    const refused = await fabric.service.plan(
      'survival',
      fabric.spec({ content: [{ modrinth: 'essentials' }] }),
    )
    expect(refused.problems.join(' ')).toContain('plugin')
  })
})

describe('content listing', () => {
  it('tells asked-for items from dependencies, and lists pending and hand-added files', async () => {
    const { service, spec, dir, db } = setup()
    const plan = await service.plan('survival', spec({ content: [{ modrinth: 'chunky' }] }))
    await (
      await service.apply('survival', plan.id)
    ).done
    writeFileSync(join(dir, 'mods', 'handmade.jar'), 'x')
    db.update(schema.servers)
      .set({ content: [{ modrinth: 'chunky' }, { modrinth: 'lithium' }] })
      .where(eq(schema.servers.name, 'survival'))
      .run()
    const list = await service.content('survival')
    expect(list.accepts).toEqual(['mod', 'datapack'])
    expect(list.items.map((i) => [i.slug, i.asked, i.requiredBy])).toEqual([
      ['chunky', true, []],
      ['fabric-api', false, ['Chunky']],
    ])
    expect(list.pending).toEqual([{ modrinth: 'lithium' }])
    expect(list.unmanaged).toEqual([{ path: 'mods/handmade.jar', kind: 'mod' }])
    expect((await service.currentSpec('survival')).content).toHaveLength(2)
  })
})

describe('vanilla tweaks', () => {
  it('installs the datapack from inside the wrapper zip, on a vanilla server', async () => {
    const { service, spec, dir } = setup({ loader: 'vanilla' })
    const plan = await service.plan(
      'survival',
      spec({ content: [{ vanillatweaks: 'Survival/graves' }] }),
    )
    expect(plan.problems).toEqual([])
    expect(plan.changes).toMatchObject([{ action: 'add', label: 'Graves', to: '3.0.0' }])
    expect(await (await service.apply('survival', plan.id)).done).toMatchObject({
      state: 'succeeded',
    })
    const installed = readFileSync(join(dir, 'world', 'datapacks', 'vt-graves.zip'))
    expect(Buffer.compare(installed, INNER)).toBe(0)
    const lock = await readLock(dir)
    expect(lock.content[0]).toMatchObject({
      source: 'vanillatweaks',
      projectId: 'datapack:Survival/graves',
      sha256: new Bun.CryptoHasher('sha256').update(INNER).digest('hex'),
    })
    const listing = await service.content('survival')
    expect(listing.items[0]!.asked).toBe(true)
    expect(listing.pending).toEqual([])
    const again = await service.plan(
      'survival',
      spec({ content: [{ vanillatweaks: 'Survival/graves' }] }),
    )
    expect(again.changes).toEqual([])
  })
})

describe('which permissions a spec change needs', () => {
  it('needs nothing for the spec as it stands', async () => {
    const { service } = setup()
    const current = await service.currentSpec('survival')
    expect(await service.needs('survival', current)).toEqual([])
    // A form that sends the current spec back through ServerSpec changes nothing either.
    expect(await service.needs('survival', ServerSpec.parse(current))).toEqual([])
  })

  it('needs the permission for each part that changes', async () => {
    const { service } = setup()
    const current = await service.currentSpec('survival')
    const needs = (extra: Partial<ServerSpecInput>) =>
      service.needs('survival', ServerSpec.parse({ ...current, ...extra }))
    expect(await needs({ properties: { motd: 'Hi' } })).toEqual(['settings.edit'])
    expect(await needs({ content: [{ modrinth: 'lithium' }] })).toEqual(['content.manage'])
    expect(await needs({ schedules: [{ restart: '0 5 * * *' }] })).toEqual(['schedules.manage'])
    expect(await needs({ timezone: 'Europe/London', content: [{ modrinth: 'lithium' }] })).toEqual([
      'settings.edit',
      'content.manage',
    ])
    expect(await service.needs('survival', current, true)).toEqual(['content.manage'])
  })

  it('keeps what a plan needs until it is applied', async () => {
    const { service, spec } = setup()
    const plan = await service.plan('survival', spec({ properties: { motd: 'Hi' } }))
    expect(service.planNeeds('survival', plan.id)).toContain('settings.edit')
    expect(service.planNeeds('creative', plan.id)).toBeNull()
    expect(service.planNeeds('survival', 'nope')).toBeNull()
  })
})
