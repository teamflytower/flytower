/**
 * Takes the labelled screenshots the docs ask for (#270), from a demo panel with made-up
 * servers and people, and writes them to docs/screens/.
 *
 *   bun run docs:screens              every ::screenshot in docs/*.md
 *   bun run docs:screens backups      just the ones with these names
 *
 * It builds the panel if there's no build yet, starts it with the stand-in agent (never a
 * real one) on a throwaway data folder, signs in with a virtual passkey like the E2E test,
 * seeds the demo data, then shoots each picture in light and dark. Label positions are read
 * from the controls' `data-doc` anchors, so they move with the UI.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { anchorRoute, anchorSelector, docAnchor } from '../packages/docs-layer/anchors.ts'
import {
  SCREENSHOT_NAME,
  screenshotFiles,
  screenshotsInMarkdown,
  type ScreenshotData,
  type ScreenshotSpec,
} from '../packages/docs-layer/screens.ts'
import {
  api,
  clickButton,
  fill,
  openBrowser,
  until,
  waitForPath,
  waitForText,
  type View,
} from '../tests/e2e/browser.ts'

const root = resolve(import.meta.dir, '..')
const docsDir = join(root, 'docs')
const outDir = join(docsDir, 'screens')
const panelDir = join(root, 'apps/panel')
const port = Number(process.env.DOCS_SCREENS_PORT ?? 3917)
// Passkeys need a name, not an IP address.
const base = `http://localhost:${port}`
/** The panel's address as the pictures show it. */
const SHOWN_AS = 'https://panel.example.com'
/** The demo server every server page is shot on. */
const SERVER = 'survival'
const SIZES = {
  desktop: { width: 1280, height: 960, mobile: false },
  phone: { width: 390, height: 844, mobile: true },
} as const

const log = (msg: string) => console.log(`• ${msg}`)

/** Every screenshot the docs ask for, checked before anything starts. */
async function wanted(only: string[]): Promise<ScreenshotSpec[]> {
  const specs: ScreenshotSpec[] = []
  for (const file of (await readdir(docsDir)).filter((f) => f.endsWith('.md')).sort()) {
    specs.push(...screenshotsInMarkdown(await Bun.file(join(docsDir, file)).text(), file))
  }
  const problems: string[] = []
  const names = new Set<string>()
  for (const s of specs) {
    if (!SCREENSHOT_NAME.test(s.name)) problems.push(`${s.file}: bad screenshot name "${s.name}"`)
    if (names.has(s.name)) problems.push(`${s.file}: screenshot "${s.name}" is used twice`)
    names.add(s.name)
    for (const id of [s.anchor, ...s.labels]) {
      if (!docAnchor(id)) problems.push(`${s.file}: ${s.name}: no anchor "${id}"`)
    }
  }
  if (problems.length) throw new Error(problems.join('\n'))
  return only.length ? specs.filter((s) => only.includes(s.name)) : specs
}

/** Starts the stand-in agent and the built panel on a throwaway folder. */
async function start(data: string) {
  if (!(await Bun.file(join(panelDir, '.output/server/index.mjs')).exists())) {
    log('building the panel')
    const build = Bun.spawn(['bun', 'run', 'build'], {
      cwd: panelDir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await build.exited) !== 0) throw new Error('the panel build failed')
  }
  await Bun.write(join(data, 'setup-token.hash'), await Bun.password.hash('docs-screens'))
  const dirs = [
    'servers',
    'backups',
    'exports',
    'imports',
    'archive',
    'skins',
    'maps',
    'packs',
    'commands',
    'runtimes',
  ]
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FLYTOWER_DEV_DIR: data,
    FLYTOWER_AGENT_SOCKET: join(data, 'agent.sock'),
    NUXT_AGENT_SOCKET: join(data, 'agent.sock'),
    NUXT_DB_PATH: join(data, 'flytower.db'),
    NUXT_SETUP_TOKEN_FILE: join(data, 'setup-token.hash'),
    NUXT_APP_SECRET: crypto.getRandomValues(new Uint8Array(32)).toHex(),
    // An address from the documentation range, so no real one shows in a picture.
    NUXT_MACHINE_IPV4: '203.0.113.10',
    // As if the panel had a domain, so nothing asks for one; passkeys still work on localhost.
    NUXT_RP_ID: 'localhost',
    PORT: String(port),
    HOST: 'localhost',
  }
  for (const d of dirs) env[`NUXT_${d.toUpperCase()}_DIR`] = join(data, d)
  const quiet = process.env.DOCS_SCREENS_VERBOSE ? 'inherit' : 'ignore'
  const children: Bun.Subprocess[] = []
  const stop = () => children.forEach((c) => c.kill())
  try {
    children.push(
      Bun.spawn(['bun', 'src/main.ts'], {
        cwd: join(root, 'packages/dev-agent'),
        env,
        stdout: quiet,
        stderr: 'inherit',
      }),
    )
    await until('the stand-in agent', async () => existsSync(join(data, 'agent.sock')), 15_000, 200)
    children.push(
      Bun.spawn(['bun', '.output/server/index.mjs'], {
        cwd: panelDir,
        env,
        stdout: quiet,
        stderr: 'inherit',
      }),
    )
    await until(
      'the panel',
      () =>
        fetch(`${base}/api/health`).then(
          (r) => r.ok,
          () => false,
        ),
      30_000,
      300,
    )
  } catch (err) {
    stop()
    throw err
  }
  return stop
}

async function waitForJob(view: View, id: number, what: string) {
  await until(
    what,
    async () => {
      const j = await api<{ state: string; message: string }>(view, `/api/jobs/${id}`)
      if (j.body.state === 'failed')
        throw Object.assign(new Error(`${what}: ${j.body.message}`), { fatal: true })
      return j.body.state === 'succeeded'
    },
    5 * 60_000,
    1000,
  )
}

async function call<T>(view: View, path: string, init?: { method?: string; body?: unknown }) {
  const r = await api<T>(view, path, init)
  if (r.status >= 300)
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

/**
 * First-run setup as "Alex", then two servers, backups, schedules, an invite for Sam, a
 * notification channel and a public page.
 */
async function seed(view: View) {
  await waitForPath(view, '/setup', 30_000)
  await fill(view, 'input', 'docs-screens')
  await clickButton(view, 'Continue')
  await waitForText(view, 'Create your passkey')
  await fill(view, 'input', 'Alex')
  await clickButton(view, 'Create passkey')
  await waitForText(view, 'Save your recovery codes')
  const code = await view.evaluate<string>(
    `document.querySelector('ol li')?.innerText.trim() ?? ''`,
  )
  await clickButton(view, "I've saved them")
  await fill(view, 'input', code)
  await clickButton(view, 'Finish setup')
  await waitForPath(view, '/')
  log('signed in as Alex')

  const versions = await call<{ id: string; stable: boolean }[]>(
    view,
    '/api/loaders/vanilla/minecraft',
  )
  const mcVersion = versions.find((v) => v.stable)?.id
  if (!mcVersion) throw new Error('no Minecraft release to create the demo servers with')
  for (const [displayName, name, port] of [
    ['Survival', 'survival', 25565],
    ['Creative', 'creative', 25566],
  ] as const) {
    const { jobId } = await call<{ jobId: number }>(view, '/api/servers', {
      body: {
        displayName,
        name,
        loader: 'vanilla',
        mcVersion,
        loaderVersion: 'latest-stable',
        memoryMb: 2048,
        port,
        acceptEula: true,
      },
    })
    await waitForJob(view, jobId, `creating ${name}`)
  }
  log(`created survival and creative (Minecraft ${mcVersion})`)

  await call(view, `/api/servers/${SERVER}/backups/schedule`, {
    method: 'PUT',
    body: { cron: '0 3 * * *', tz: 'Europe/London', keepLast: 6, keepDaily: 7, keepWeekly: 4 },
  })
  for (const note of ['Before the 1.0 update', '']) {
    const { jobId } = await call<{ jobId: number }>(view, `/api/servers/${SERVER}/backups`, {
      body: { note },
    })
    await waitForJob(view, jobId, 'a backup')
  }
  await call(view, `/api/servers/${SERVER}/schedules`, {
    method: 'PUT',
    body: {
      timezone: 'Europe/London',
      schedules: [
        { restart: '0 5 * * *', warn: ['15m', '5m', '1m', '10s'], skipWarningsWhenEmpty: false },
        { command: 'save-all', cron: '0 * * * *' },
      ],
    },
  })
  // Invites ask for the passkey again, so make Sam's through the form.
  await view.navigate(`${base}/access`)
  await clickButton(view, 'Invite someone')
  await fill(view, 'input[placeholder="Sam"]', 'Sam')
  await view.evaluate(`document.querySelector('[data-e2e=invite-create]').click()`)
  await until(
    'the invite link',
    () => view.evaluate<boolean>(`!!document.querySelector('[data-e2e=invite-link]')`),
    30_000,
  )
  // The invite's passkey check lasts a few minutes, long enough to add a channel too.
  await call(view, '/api/system/notify', {
    body: {
      name: "Alex's phone",
      kind: 'ntfy',
      url: 'https://ntfy.sh/flytower-demo-alerts',
      events: ['backup.failed', 'server.crashed', 'server.crash_loop', 'disk.full'],
      servers: [],
    },
  })
  await call(view, `/api/servers/${SERVER}/resources`, {
    method: 'PATCH',
    body: { hostname: 'survival.example.com' },
  })
  await call(view, `/api/servers/${SERVER}/public-page`, {
    method: 'PATCH',
    body: {
      enabled: true,
      description: 'Our survival world. Be kind, build what you like, and ask before you borrow.',
      show: { players: 'names', version: true, leaderboard: false },
    },
  })
  // The Disk card waits for the machine's first reading.
  await until(
    'the first disk reading',
    async () => (await call<{ percent: number | null }>(view, '/api/system/disk')).percent !== null,
    60_000,
  )
  log('seeded backups, schedules, an invite for Sam, a notification channel and a public page')
}

/** Shoots one screenshot in one theme; returns where its labels are. */
async function shoot(
  view: View,
  spec: ScreenshotSpec,
  theme: 'light' | 'dark',
): Promise<ScreenshotData> {
  const size = SIZES[spec.device]
  await view.cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2 })
  const anchor = docAnchor(spec.anchor)!
  // The panel follows the system's light or dark setting until someone picks one.
  await view.cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  })
  // Going to the address the page is already on (the other theme) wouldn't load it again.
  await view.navigate('about:blank')
  await view.navigate(`${base}${anchorRoute(anchor, SERVER)}`)
  const selector = JSON.stringify(anchorSelector(spec.anchor))
  await until(
    `${spec.name}: ${anchor.label}`,
    () => view.evaluate<boolean>(`!!document.querySelector(${selector})`),
    30_000,
  )
  // Show the panel at a made-up domain rather than the address the script runs it on.
  await view.evaluate(`(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeValue.includes(${JSON.stringify(base)})) {
        n.nodeValue = n.nodeValue.replaceAll(${JSON.stringify(base)}, ${JSON.stringify(SHOWN_AS)})
      }
    }
  })()`)
  // Let data, fonts and transitions settle, and leave nothing focused or hovered.
  await view.evaluate(`document.fonts.ready.then(() => document.activeElement?.blur())`)
  await Bun.sleep(1200)
  // A section or card is pictured whole; anything else with the window around it.
  const frame = `(() => {
    const el = document.querySelector(${selector})
    return ${JSON.stringify(anchor.kind)} === 'card'
      ? el
      : ${JSON.stringify(anchor.kind)} === 'section'
        ? el.closest('[data-e2e^="section-"]')
        : null
  })()`
  // Make the window tall enough for it (within reason).
  const tall = await view.evaluate<number>(`(() => {
    const s = ${frame}
    return s ? Math.ceil(s.getBoundingClientRect().height) + 260 : 0
  })()`)
  if (tall > size.height) {
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      ...size,
      height: Math.min(tall, 2400),
      deviceScaleFactor: 2,
    })
    await Bun.sleep(400)
  }

  const labels = JSON.stringify(spec.labels.map(anchorSelector))
  const box = await view.evaluate<{
    clip: DOMRectInit
    labels: (DOMRectInit | null)[]
  } | null>(`(() => {
    const el = document.querySelector(${selector})
    const section = ${frame}
    // A card goes in the middle, clear of a sticky header above it.
    if (section) section.scrollIntoView({ block: ${JSON.stringify(anchor.kind)} === 'card' ? 'center' : 'start' })
    else el.scrollIntoView({ block: 'center' })
    const pad = section ? 16 : 0
    const r = section ? section.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight)
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad)
    const clip = {
      x, y,
      width: Math.min(innerWidth, r.right + pad) - x,
      height: Math.min(innerHeight, r.bottom + pad) - y,
    }
    const labels = ${labels}.map((s) => {
      const l = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length)
      if (!l) return null
      const b = l.getBoundingClientRect()
      return { x: b.left - clip.x, y: b.top - clip.y, width: b.width, height: b.height }
    })
    return { clip, labels }
  })()`)
  if (!box) throw new Error(`${spec.name}: nothing to picture`)
  const missing = spec.labels.filter((_, i) => !box.labels[i])
  if (missing.length) throw new Error(`${spec.name}: not on screen: ${missing.join(', ')}`)

  const { clip } = box as { clip: Required<Pick<DOMRectInit, 'x' | 'y' | 'width' | 'height'>> }
  const shot = await view.cdp<{ data: string }>('Page.captureScreenshot', {
    format: 'webp',
    quality: 82,
    clip: { ...clip, scale: 1 },
  })
  await Bun.write(join(outDir, screenshotFiles(spec.name)[theme]), Buffer.from(shot.data, 'base64'))

  const pct = (n: number, of: number) => Math.round((n / of) * 10000) / 100
  return {
    width: Math.round(clip.width),
    height: Math.round(clip.height),
    device: spec.device,
    labels: spec.labels.map((id, i) => {
      const b = box.labels[i] as Required<Pick<DOMRectInit, 'x' | 'y' | 'width' | 'height'>>
      return {
        anchor: id,
        x: pct(b.x, clip.width),
        y: pct(b.y, clip.height),
        w: pct(b.width, clip.width),
        h: pct(b.height, clip.height),
      }
    }),
  }
}

const specs = await wanted(process.argv.slice(2))
if (!specs.length) {
  log('no screenshots to take')
  process.exit(0)
}
const data = await mkdtemp(join(tmpdir(), 'flytower-docs-screens-'))
const stop = await start(data)
const view = await openBrowser(`${base}/`)
try {
  // Dates and times as a British reader sees them, the same on every machine.
  await view.cdp('Emulation.setLocaleOverride', { locale: 'en-GB' })
  await view.cdp('Emulation.setTimezoneOverride', { timezoneId: 'Europe/London' })
  await seed(view)
  await mkdir(outDir, { recursive: true })
  for (const spec of specs) {
    const light = await shoot(view, spec, 'light')
    await shoot(view, spec, 'dark')
    await Bun.write(
      join(outDir, screenshotFiles(spec.name).data),
      `${JSON.stringify(light, null, 2)}\n`,
    )
    log(`${spec.name}: ${light.width}×${light.height}, ${light.labels.length} labels`)
  }
} finally {
  view.close()
  stop()
  await rm(data, { recursive: true, force: true })
}
process.exit(0)
