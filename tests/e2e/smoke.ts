/**
 * Drives a freshly installed panel the way a person would: first-run setup with a passkey,
 * then (unless E2E_SKIP_SERVER is set) a real Fabric server created, started and talked to.
 *
 *   E2E_URL=http://localhost:3000 E2E_SETUP_TOKEN=... bun tests/e2e/smoke.ts
 */
import { api, clickButton, fill, openBrowser, until, waitForPath, waitForText } from './browser.ts'

const base = process.env.E2E_URL ?? 'http://localhost:3000'
const token = process.env.E2E_SETUP_TOKEN ?? 'dev-setup-token'
const shots = process.env.E2E_SHOTS

const step = (msg: string) => console.log(`✓ ${msg}`)
const view = await openBrowser(base + '/')

function waitForJob(id: number, what: string, timeoutMs: number) {
  return until(
    what,
    async () => {
      const j = await api<{ state: string; step: string; message: string }>(view, `/api/jobs/${id}`)
      if (j.body.state === 'failed')
        throw Object.assign(new Error(`job failed at ${j.body.step}: ${j.body.message}`), {
          fatal: true,
        })
      return j.body.state === 'succeeded' ? j.body : null
    },
    timeoutMs,
    2000,
  )
}

async function shot(name: string) {
  if (shots) await Bun.write(`${shots}/${name}.png`, await view.screenshot())
}

try {
  await waitForPath(view, '/setup')
  await fill(view, 'input', 'not-the-token')
  await clickButton(view, 'Continue')
  await waitForText(view, 'That setup token is not right')
  await fill(view, 'input', token)
  await clickButton(view, 'Continue')
  await waitForText(view, 'Create your passkey')
  await fill(view, 'input', 'Smoke Test')
  await clickButton(view, 'Create passkey')
  await waitForText(view, 'Save your recovery codes')
  const codes = await view.evaluate<string[]>(
    `[...document.querySelectorAll('ol li')].map((li) => li.innerText.trim())`,
  )
  if (codes.length !== 10) throw new Error(`expected 10 recovery codes, got ${codes.length}`)
  await clickButton(view, "I've saved them")
  await fill(view, 'input', codes[0]!)
  await clickButton(view, 'Finish setup')
  await waitForPath(view, '/')
  await shot('1-home')
  step('setup with passkey and recovery codes')

  const health = await api<{ agent: { ok: boolean; version: string } }>(view, '/api/health')
  if (!health.body.agent.ok) throw new Error('the panel cannot reach the agent')
  step(`agent ${health.body.agent.version} reachable`)

  {
    const res = await fetch(`${base}/`)
    const csp = res.headers.get('content-security-policy') ?? ''
    if (
      !csp.includes("frame-ancestors 'none'") ||
      res.headers.get('x-content-type-options') !== 'nosniff'
    ) {
      throw new Error(`security headers missing: ${csp || 'no CSP'}`)
    }
    step('security headers set')
  }

  {
    // Branding: a name and colour saved on System reach the theme, the title and sign-in page.
    await view.navigate(`${base}/system/branding`)
    await waitForText(view, 'Name, colour and font', 30_000)
    await fill(
      view,
      '[data-e2e=branding-name] input, input[data-e2e=branding-name]',
      'Smoke Theatre',
    )
    await fill(view, '[data-e2e=branding-accent] input, input[data-e2e=branding-accent]', '#2f6fd0')
    await clickButton(view, 'Save')
    await until(
      'the branding saved',
      async () =>
        (await api<{ name: string }>(view, '/api/branding')).body?.name === 'Smoke Theatre',
      30_000,
      500,
    )
    const css = await (await fetch(`${base}/branding/theme.css`)).text()
    if (!css.includes('--ui-color-primary-500')) throw new Error(`theme not applied: ${css}`)
    await until('the title to follow the name', () =>
      view.evaluate<boolean>(`document.title.endsWith('Smoke Theatre')`),
    )
    await shot('branding')
    const reset = await api<{ isDefault: boolean }>(view, '/api/system/branding', {
      method: 'DELETE',
    })
    if (!reset.body?.isDefault) throw new Error(`branding not reset: ${reset.status}`)
    if ((await (await fetch(`${base}/branding/theme.css`)).text()) !== '') {
      throw new Error('theme left behind after a reset')
    }
    step('branding saved through the UI, applied to the theme and title, and reset')
  }

  {
    // Notifications: a JSON webhook channel added through the form gets one signed test POST.
    const got: { signature: string | null; body: string }[] = []
    using receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        got.push({ signature: req.headers.get('x-flytower-signature'), body: await req.text() })
        return new Response('ok')
      },
    })
    await view.navigate(`${base}/system/notifications`)
    await waitForText(view, 'Notifications')
    await clickButton(view, 'Add channel')
    await waitForText(view, 'Add a notification channel')
    await fill(view, 'input[placeholder="Admins"]', 'E2E hook')
    await view.click('[data-e2e=notify-kind]')
    await until('the kinds of channel', () =>
      view.evaluate<boolean>(`document.querySelectorAll('[role=option]').length === 3`),
    )
    await view.click('[role=option]:last-child')
    await waitForText(view, 'Signing secret')
    await fill(
      view,
      'input[placeholder="https://example.com/flytower-hook"]',
      `http://127.0.0.1:${receiver.port}/hook`,
    )
    await clickButton(view, 'Generate')
    const secret = await view.evaluate<string>(
      `[...document.querySelectorAll('input')].find((i) => /^[0-9a-f]{48}$/.test(i.value)).value`,
    )
    await view.evaluate(`document.querySelector('[data-e2e=notify-save]').click()`)
    await waitForText(view, 'Added E2E hook')
    await shot('1b-notifications')
    await view.evaluate(`document.querySelector('[aria-label="Send a test to E2E hook"]').click()`)
    const hit = await until('the test notification', async () => got[0])
    const expected = `sha256=${new Bun.CryptoHasher('sha256', secret).update(hit.body).digest('hex')}`
    if (hit.signature !== expected) throw new Error(`bad signature ${hit.signature}`)
    if (JSON.parse(hit.body).kind !== 'test') throw new Error(`unexpected body ${hit.body}`)
    step('notification channel added; its test arrived signed')
  }

  if (!process.env.E2E_SKIP_SERVER) {
    const versions = await api<{ id: string }[]>(view, '/api/loaders/fabric/minecraft')
    const mc = process.env.E2E_MC_VERSION ?? versions.body[0]?.id
    if (!mc) throw new Error(`no Minecraft versions (${versions.status})`)
    const created = await api<{ jobId: number }>(view, '/api/servers', {
      body: {
        name: 'smoke',
        displayName: 'Smoke',
        loader: 'fabric',
        mcVersion: mc,
        memoryMb: 1024,
        acceptEula: true,
      },
    })
    if (created.status !== 202) throw new Error(`create failed: ${JSON.stringify(created.body)}`)
    const job = await waitForJob(created.body.jobId, 'the create-server job', 10 * 60_000)
    step(`created Fabric ${mc}: ${job.message}`)

    await view.navigate(`${base}/servers/smoke`)
    await waitForText(view, 'Running', 30_000)
    await until(
      'the server to finish starting',
      () =>
        view.evaluate<boolean>(
          `document.querySelector('[role=log]')?.innerText.includes('Done (')`,
        ),
      5 * 60_000,
      2000,
    )
    await shot('2-console')
    step('server started and console streaming')

    // Right-click menus (#106): the card's menu follows the live state; Shift leaves it alone.
    await view.navigate(`${base}/`)
    const rightClick = (shift: boolean) =>
      view.evaluate(`document.querySelector('[data-e2e=server-card]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: ${shift}, clientX: 200, clientY: 200 }))`)
    await until('the server card', () =>
      view.evaluate<boolean>(`!!document.querySelector('[data-e2e=server-card]')`),
    )
    await rightClick(true)
    await Bun.sleep(300)
    if (await view.evaluate<boolean>(`!!document.querySelector('[role=menu]')`)) {
      throw new Error('Shift + right-click opened the Flytower menu')
    }
    await rightClick(false)
    await until('the card menu with Restart and Stop', () =>
      view.evaluate<boolean>(
        `(() => { const m = document.querySelector('[role=menu]')?.innerText ?? ''; return m.includes('Restart') && m.includes('Stop') && !m.includes('Start') })()`,
      ),
    )
    await view.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    step('right-click menu on a running server card')

    // Help (#270): a docs chip's Show me goes to the control and lights it up.
    await view.navigate(`${base}/servers/smoke/world`)
    await waitForText(view, 'Back up now', 30_000)
    await view.evaluate(`document.querySelector('[data-e2e=help-button]').click()`)
    await until('the Back up now chip in Help', () =>
      view.evaluate<boolean>(`!!document.querySelector('[data-doc-chip="backups.back-up-now"]')`),
    )
    await view.evaluate(`document.querySelector('[data-doc-chip="backups.back-up-now"]').click()`)
    await until('the spotlight round Back up now', () =>
      view.evaluate<boolean>(`(() => {
        const ring = document.querySelector('[data-e2e=doc-spotlight]')?.getBoundingClientRect()
        const button = document.querySelector('[data-doc="backups.back-up-now"]')?.getBoundingClientRect()
        return !!ring && !!button && ring.left < button.left && ring.right > button.right
          && ring.top < button.top && ring.bottom > button.bottom
      })()`),
    )
    await shot('help-show-me')
    await view.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    step('Show me in Help lit up Back up now')
    // Back to the console, where the crash banner below shows.
    await view.navigate(`${base}/servers/smoke`)

    const reply = await until(
      'RCON',
      async () => {
        const r = await api<{ reply: string }>(view, '/api/servers/smoke/command', {
          body: { command: 'list' },
        })
        return r.status === 200 ? r.body.reply : null
      },
      60_000,
      2000,
    )
    if (!/players online/.test(reply)) throw new Error(`unexpected RCON reply: ${reply}`)
    step(`RCON answered: ${reply}`)

    // Console completion: the game's own reports, run with the server's Java, list every
    // vanilla command; help over RCON adds the commands only Fabric API has.
    type Commands = {
      vanilla: string
      extra: string
      root: { literals?: Record<string, { usage?: string }> }
      registries: Record<string, string[]>
    }
    const commands = await api<Commands>(view, '/api/servers/smoke/commands?wait=1')
    const commandNames = Object.keys(commands.body.root?.literals ?? {})
    if (
      commands.status !== 200 ||
      commands.body.vanilla !== 'ready' ||
      !commandNames.includes('give')
    ) {
      throw new Error(
        `command catalogue: ${commands.status} ${JSON.stringify(commands.body).slice(0, 300)}`,
      )
    }
    if (commands.body.extra !== 'ready') throw new Error('help over RCON gave no commands')
    if (!commands.body.registries.item?.includes('diamond_sword')) {
      throw new Error('the catalogue has no item ids')
    }
    step(
      `console completion knows ${commandNames.length} commands and ${commands.body.registries.item.length} items`,
    )

    // Crash detection: kill Java outright. systemd restarts it after 15 seconds; Flytower
    // records the crash, shows the banner, and the console answers again afterwards.
    const killed = Bun.spawnSync(['docker', 'exec', 'vps', 'pkill', '-KILL', '-u', 'mc-smoke'])
    if (killed.exitCode !== 0) throw new Error(`couldn't kill the server: ${killed.stderr}`)
    type Health = { condition: string | null; crash: { id: number; cause: string } | null }
    const crash = await until(
      'the crash to be recorded',
      async () => {
        const r = await api<{ health: Health }>(view, '/api/servers/smoke')
        return r.body.health.crash
      },
      60_000,
      2000,
    )
    if (!/SIGKILL/.test(crash.cause)) throw new Error(`unexpected crash cause: ${crash.cause}`)
    await waitForText(view, 'Crashed at', 30_000)
    await shot('2b-crash-banner')
    await until(
      'systemd to restart it',
      async () => {
        const r = await api<{ reply: string }>(view, '/api/servers/smoke/command', {
          body: { command: 'list' },
        })
        return r.status === 200 && /players online/.test(r.body.reply) ? true : null
      },
      5 * 60_000,
      3000,
    )
    const after = await api<{ status: string; health: Health }>(view, '/api/servers/smoke')
    if (after.body.status !== 'active' || after.body.health.condition !== null) {
      throw new Error(`not back to normal after the crash: ${JSON.stringify(after.body)}`)
    }
    const dismissed = await api(view, `/api/servers/smoke/events/${crash.id}/dismiss`, { body: {} })
    if (dismissed.status !== 200)
      throw new Error(`dismiss failed: ${JSON.stringify(dismissed.body)}`)
    step(`a killed server was noticed (${crash.cause}) and restarted by systemd`)

    // Scheduled tasks: a restart with one 10-second warning, run with Run now. It warns,
    // restarts the normal way (not a crash), and the console answers again afterwards.
    {
      type Task = { id: number; running: boolean; lastOk: boolean | null; lastResult: string }
      const saved = await api<{ tasks: Task[] }>(view, '/api/servers/smoke/schedules', {
        method: 'PUT',
        body: {
          timezone: 'Europe/London',
          schedules: [
            { restart: '0 5 * * *', warn: ['10s'], skipWarningsWhenEmpty: false },
            { command: 'seed', cron: '0 4 * * *' },
          ],
        },
      })
      if (saved.status !== 200) throw new Error(`saving schedules: ${JSON.stringify(saved.body)}`)
      const [restartTask, seedTask] = saved.body.tasks
      const seedRun = await api(view, `/api/servers/smoke/schedules/${seedTask!.id}/run`, {
        body: {},
      })
      if (seedRun.status !== 200) throw new Error(`run now: ${JSON.stringify(seedRun.body)}`)
      const ran = await api(view, `/api/servers/smoke/schedules/${restartTask!.id}/run`, {
        body: {},
      })
      if (ran.status !== 200) throw new Error(`run now: ${JSON.stringify(ran.body)}`)
      const done = await until(
        'the scheduled restart to finish',
        async () => {
          const r = await api<{ tasks: Task[] }>(view, '/api/servers/smoke/schedules')
          const t = r.body.tasks.find((x) => x.id === restartTask!.id)
          return t && !t.running && t.lastResult ? t : null
        },
        4 * 60_000,
        2000,
      )
      if (done.lastOk !== true) throw new Error(`scheduled restart: ${done.lastResult}`)
      const seed = (
        await api<{ tasks: (Task & { lastReply: string })[] }>(view, '/api/servers/smoke/schedules')
      ).body.tasks.find((x) => x.id === seedTask!.id)
      if (!/Seed/.test(seed?.lastReply ?? '')) {
        throw new Error(`the command's reply wasn't kept: ${JSON.stringify(seed)}`)
      }
      await until(
        'the console to answer after the scheduled restart',
        async () => {
          const r = await api<{ reply: string }>(view, '/api/servers/smoke/command', {
            body: { command: 'list' },
          })
          return r.status === 200 && /players online/.test(r.body.reply) ? true : null
        },
        5 * 60_000,
        3000,
      )
      const health = await api<{ health: Health }>(view, '/api/servers/smoke')
      if (health.body.health.crash) {
        throw new Error(`the scheduled restart counted as a crash: ${JSON.stringify(health.body)}`)
      }
      await api(view, '/api/servers/smoke/schedules', {
        method: 'PUT',
        body: { timezone: 'Europe/London', schedules: [] },
      })
      step(`scheduled restart with a 10-second warning: ${done.lastResult}`)
    }

    // Backups: a block placed before the backup survives a change and a restore.
    const rcon = async (command: string) => {
      const r = await api<{ reply: string }>(view, '/api/servers/smoke/command', {
        body: { command },
      })
      if (r.status !== 200) throw new Error(`${command} failed: ${JSON.stringify(r.body)}`)
      return r.body.reply
    }
    const goldIsThere = async () =>
      /passed/i.test(await rcon('execute if block 0 100 0 minecraft:gold_block'))
    await rcon('forceload add 0 0')
    await rcon('setblock 0 100 0 minecraft:gold_block')
    if (!(await goldIsThere())) throw new Error('setblock did not place the gold block')

    const backup = await api<{ jobId: number }>(view, '/api/servers/smoke/backups', {
      body: { note: 'e2e' },
    })
    if (backup.status !== 200) throw new Error(`backup failed: ${JSON.stringify(backup.body)}`)
    await waitForJob(backup.body.jobId, 'the backup job', 5 * 60_000)
    step('backed up a running server')

    {
      // Disk use: the finished backup has the server measured again, backups and all.
      const disk = await until('the server to be measured', async () => {
        const r = await api<{
          percent: number | null
          servers: { server: string; bytes: number; groups: { world: number; backups: number } }[]
        }>(view, '/api/system/disk')
        const s = r.body.servers.find((x) => x.server === 'smoke')
        return s && s.groups.world > 0 && s.groups.backups > 0 ? { ...r.body, s } : null
      })
      await view.navigate(`${base}/system`)
      await waitForText(view, 'Largest part')
      await waitForText(view, 'Smoke')
      await shot('2c-disk-use')
      step(
        `disk ${disk.percent}% full; smoke measured at ${Math.round(disk.s.bytes / 1024 / 1024)} MB`,
      )
    }

    await rcon('setblock 0 100 0 minecraft:air')
    if (await goldIsThere()) throw new Error('the gold block should be gone before restoring')

    /** Restores the newest backup through the UI, which also answers the passkey check. */
    const restoreNewest = async (waitFor: string) => {
      await view.navigate(`${base}/servers/smoke/world`)
      await waitForText(view, waitFor, 30_000)
      // Menus open on a real pointer press, so use native clicks here.
      await view.click('[aria-label^="Actions for backup"]')
      await until('the Restore menu item', () =>
        view.evaluate<boolean>(`(() => {
          const i = [...document.querySelectorAll('[role=menuitem]')].find((e) => e.innerText.includes('Restore'))
          if (!i) return false
          i.setAttribute('data-e2e', 'restore')
          return true
        })()`),
      )
      await view.click('[data-e2e=restore]')
      await waitForText(view, 'Restore this backup?')
      await until('the Restore button in the dialog', () =>
        view.evaluate<boolean>(`(() => {
          const b = [...document.querySelectorAll('[role=dialog] button')].find((e) => e.innerText.trim() === 'Restore')
          if (!b) return false
          b.setAttribute('data-e2e', 'confirm-restore')
          return true
        })()`),
      )
      await view.click('[data-e2e=confirm-restore]')
      const outcome = await until(
        'the restore to finish',
        () =>
          view.evaluate<string | null>(`(() => {
            const t = document.body.innerText
            if (t.includes('Restored the backup')) return 'ok'
            if (t.includes("That didn't work")) return t.slice(t.indexOf("That didn't work"), t.indexOf("That didn't work") + 300)
            return null
          })()`),
        5 * 60_000,
        1000,
      ).catch(async (err) => {
        const text = await view.evaluate<string>('document.body.innerText').catch(() => '')
        const toasts = await view
          .evaluate<string>(
            `[...document.querySelectorAll('[role=region] li, [data-sonner-toast], [role=status], [role=alert]')].map((e) => e.innerText).join(' | ')`,
          )
          .catch(() => '')
        throw new Error(
          `${(err as Error).message}; toasts: ${toasts || 'none'}; the page ended: ${text.slice(-500)}`,
        )
      })
      if (outcome !== 'ok') throw new Error(`restore failed: ${outcome}`)
    }
    await restoreNewest('e2e')
    await shot('3-restored')
    await until(
      'RCON after the restore',
      async () =>
        (await api(view, '/api/servers/smoke/command', { body: { command: 'list' } })).status ===
        200,
      5 * 60_000,
      2000,
    )
    if (!(await goldIsThere())) throw new Error('the restore did not bring the gold block back')
    step('restored the backup through the UI and the block came back')

    // Off-site: add S3Mock through the UI, copy a backup there, lose the local file, and
    // restore from the copy.
    const labelled = async (text: string) => {
      const id = await view.evaluate<string | null>(`(() => {
        const l = [...document.querySelectorAll('label')].find((e) => e.innerText.replace('*', '').trim() === ${JSON.stringify(text)})
        return l?.getAttribute('for') ?? null
      })()`)
      if (!id) throw new Error(`no field labelled ${text}`)
      return `[id="${id}"]`
    }
    await view.navigate(`${base}/system/storage`)
    await waitForText(view, 'Off-site backups', 30_000)
    await clickButton(view, 'Add storage')
    await waitForText(view, 'Secret access key')
    for (const [label, value] of [
      ['Name', 'S3Mock'],
      ['Endpoint', 'http://127.0.0.1:9090'],
      ['Bucket', 'mc-backups'],
      ['Region', 'us-east-1'],
      ['Access key ID', 'flytower'],
      ['Secret access key', 'flytower-e2e-secret'],
    ] as const) {
      await fill(view, await labelled(label), value)
    }
    await clickButton(view, 'Test')
    await waitForText(view, 'Connected: wrote, read and deleted', 30_000)
    await view.evaluate(`document.querySelector('[role=dialog] button[type=submit]').click()`)
    await waitForText(view, 'Used by', 30_000).catch(() =>
      waitForText(view, 'Not used by any server'),
    )
    const targets = await api<{ id: number; name: string }[]>(view, '/api/system/backup-targets')
    const minio = targets.body.find((t) => t.name === 'S3Mock')
    if (!minio) throw new Error(`target not added: ${JSON.stringify(targets.body)}`)
    await api(view, '/api/servers/smoke/backups/offsite', {
      method: 'PUT',
      body: { target: minio.id },
    })
    const offsiteBackup = await api<{ jobId: number }>(view, '/api/servers/smoke/backups', {
      body: { note: 'offsite' },
    })
    await waitForJob(offsiteBackup.body.jobId, 'the off-site backup job', 5 * 60_000)
    type Listed = {
      backups: {
        id: number
        file: string
        note: string | null
        local: boolean
        offsite: { state: string; error: string | null } | null
      }[]
    }
    let lastSeen: unknown = null
    const copied = await until(
      'the off-site copy',
      async () => {
        const r = await api<Listed>(view, '/api/servers/smoke/backups')
        lastSeen = r.body.backups.map((x) => ({ note: x.note, local: x.local, offsite: x.offsite }))
        const b = r.body.backups.find((x) => x.note === 'offsite')
        if (b?.offsite?.state === 'failed') {
          throw Object.assign(new Error(`upload failed: ${b.offsite.error}`), { fatal: true })
        }
        return b?.offsite?.state === 'done' ? b : null
      },
      3 * 60_000,
      2000,
    ).catch((err) => {
      throw new Error(`${(err as Error).message}; backups: ${JSON.stringify(lastSeen)}`)
    })
    await rcon('setblock 0 100 0 minecraft:air')
    const removed = Bun.spawnSync([
      'docker',
      'exec',
      'vps',
      'rm',
      '-f',
      `/var/lib/flytower/backups/smoke/${copied.file}`,
    ])
    if (removed.exitCode !== 0) throw new Error(`couldn't remove the local file: ${removed.stderr}`)
    await restoreNewest('Off-site only')
    await until(
      'RCON after the off-site restore',
      async () =>
        (await api(view, '/api/servers/smoke/command', { body: { command: 'list' } })).status ===
        200,
      5 * 60_000,
      2000,
    )
    if (!(await goldIsThere())) throw new Error('the off-site restore did not bring the block back')
    step('copied a backup to S3-compatible storage and restored it after losing the local file')

    // World export: a zip with level.dat that unzip accepts, shared through a public link.
    const exported = await api<{ jobId: number }>(view, '/api/servers/smoke/exports', { body: {} })
    if (exported.status !== 200) throw new Error(`export failed: ${JSON.stringify(exported.body)}`)
    await waitForJob(exported.body.jobId, 'the export job', 5 * 60_000)
    const list = await api<{ id: number }[]>(view, '/api/servers/smoke/exports')
    const link = await api<{ url: string }>(
      view,
      `/api/servers/smoke/exports/${list.body[0]!.id}/shares`,
      {
        body: { ttl: '1h' },
      },
    )
    const zipRes = await fetch(link.body.url.replace(/^https?:\/\/[^/]+/, base))
    if (zipRes.status !== 200) throw new Error(`share link answered ${zipRes.status}`)
    const zipPath = `${process.env.RUNNER_TEMP ?? '/tmp'}/smoke-world.zip`
    await Bun.write(zipPath, zipRes)
    const test = Bun.spawnSync(['unzip', '-tq', zipPath])
    const names = Bun.spawnSync(['unzip', '-Z1', zipPath]).stdout.toString()
    if (test.exitCode !== 0 || !/\/level\.dat$/m.test(names)) {
      throw new Error(`bad export zip: ${test.stdout}${test.stderr}`)
    }
    step(
      `exported the world and downloaded it through a share link (${zipRes.headers.get('content-length')} bytes)`,
    )

    // Trim unused chunks through the UI: keep only a protected area round the gold block, so
    // the rest of the spawn area goes, then check the block survived and the server is back.
    const rules = await api(view, '/api/servers/smoke/world/trim-rules', {
      method: 'PATCH',
      body: {
        spawnRadius: 0,
        playerRadius: 0,
        buffer: 0,
        protect: [{ name: 'Gold', dimension: 'overworld', from: [-16, -16], to: [15, 15] }],
      },
    })
    if (rules.status !== 200) throw new Error(`trim rules: ${JSON.stringify(rules.body)}`)
    await view.navigate(`${base}/servers/smoke/world#tools`)
    await until('the Preview and trim button', () =>
      view.evaluate<boolean>(`!!document.querySelector('[data-e2e=trim-open]')`),
    )
    await view.click('[data-e2e=trim-open]')
    const preview = await until(
      'the trim preview',
      () =>
        view.evaluate<string | null>(`(() => {
          const s = document.querySelector('[data-e2e=trim-summary]')
          if (s) return s.innerText.trim()
          const a = document.querySelector('[role=dialog] [role=alert]')
          return a ? 'failed: ' + a.innerText : null
        })()`),
      3 * 60_000,
      1000,
    )
    if (!/would remove/.test(preview)) throw new Error(`trim preview: ${preview}`)
    await shot('3a-trim-preview')
    await view.click('[data-e2e=trim-confirm]')
    const trimmed = await until(
      'the trim to finish',
      () =>
        view.evaluate<string | null>(`(() => {
          const t = document.body.innerText
          const i = t.indexOf('World trimmed')
          if (i >= 0) return 'ok: ' + t.slice(i, i + 200)
          const f = t.indexOf("That didn't work")
          return f >= 0 ? t.slice(f, f + 300) : null
        })()`),
      5 * 60_000,
      1000,
    )
    if (!trimmed.startsWith('ok')) throw new Error(`trim failed: ${trimmed}`)
    await until(
      'RCON after the trim',
      async () =>
        (await api(view, '/api/servers/smoke/command', { body: { command: 'list' } })).status ===
        200,
      5 * 60_000,
      2000,
    )
    if (!(await goldIsThere())) throw new Error('trimming removed the protected gold block')
    step(`previewed and trimmed unused chunks: ${preview.slice(0, 120)}`)

    const stopped = await api(view, '/api/servers/smoke/stop', { body: {} })
    if (stopped.status !== 200) throw new Error(`stop failed: ${JSON.stringify(stopped.body)}`)
    step('server stopped')

    // Import: the exported world becomes a second server, gold block and all.
    const shareUrl = new URL(link.body.url).pathname
    const imp = await view.evaluate<{ id: string; error?: string }>(`(async () => {
      const blob = await (await fetch(${JSON.stringify(shareUrl)})).blob()
      const meta = await (await fetch('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'smoke-world.zip', size: blob.size }),
      })).json()
      const put = await fetch('/api/imports/' + meta.id + '/chunk?offset=0', { method: 'PUT', body: blob })
      if (!put.ok) return { id: meta.id, error: await put.text() }
      return { id: meta.id }
    })()`)
    if (imp.error) throw new Error(`upload failed: ${imp.error}`)
    const unpackJob = await api<{ jobId: number }>(view, `/api/imports/${imp.id}/unpack`, {
      body: {},
    })
    await waitForJob(unpackJob.body.jobId, 'unpacking the import', 60_000)
    const created2 = await api<{ jobId: number }>(view, `/api/imports/${imp.id}/create`, {
      body: {
        name: 'imported',
        displayName: 'Imported',
        loader: 'fabric',
        mcVersion: mc,
        memoryMb: 1024,
        port: 25570,
        acceptEula: true,
      },
    })
    if (created2.status !== 202) throw new Error(`import failed: ${JSON.stringify(created2.body)}`)
    await waitForJob(created2.body.jobId, 'the import job', 10 * 60_000)
    const importedGold = await until(
      'the imported server to answer',
      async () => {
        // Forced chunks are saved with the world, but make sure 0,0 is loaded.
        await api(view, '/api/servers/imported/command', { body: { command: 'forceload add 0 0' } })
        const r = await api<{ reply: string }>(view, '/api/servers/imported/command', {
          body: { command: 'execute if block 0 100 0 minecraft:gold_block' },
        })
        return r.status === 200 ? r.body.reply : null
      },
      5 * 60_000,
      2000,
    )
    if (!/passed/i.test(importedGold))
      throw new Error(`gold block missing after import: ${importedGold}`)
    step('imported the exported world as a new server, gold block intact')
    await api(view, '/api/servers/imported/stop', { body: {} })

    // Specs: add a mod from Modrinth through plan and apply, then check Fabric loads it.
    const planned = await api<{
      ok: boolean
      plan?: { id: string; problems: string[]; changes: { action: string; label: string }[] }
      issues?: unknown
    }>(view, '/api/servers/smoke/plan', {
      body: {
        yaml: `name: smoke\nloader:\n  type: fabric\n  minecraft: "${mc}"\ncontent:\n  - modrinth: lithium\n`,
      },
    })
    if (planned.status !== 200 || !planned.body.ok || !planned.body.plan) {
      throw new Error(`plan failed: ${JSON.stringify(planned.body)}`)
    }
    const plan = planned.body.plan
    if (plan.problems.length || !plan.changes.some((c) => c.action === 'add')) {
      throw new Error(`unexpected plan: ${JSON.stringify(plan)}`)
    }
    const applied = await api<{ jobId: number }>(view, '/api/servers/smoke/apply', {
      body: { planId: plan.id },
    })
    if (applied.status !== 200) throw new Error(`apply failed: ${JSON.stringify(applied.body)}`)
    await waitForJob(applied.body.jobId, 'the apply job', 10 * 60_000)
    const again = await api<{ ok: boolean; plan: { changes: unknown[] } }>(
      view,
      '/api/servers/smoke/plan',
      {
        body: {
          yaml: `name: smoke\nloader:\n  type: fabric\n  minecraft: "${mc}"\ncontent:\n  - modrinth: lithium\n`,
        },
      },
    )
    if (again.body.plan.changes.length) {
      throw new Error(`a second plan should change nothing: ${JSON.stringify(again.body)}`)
    }
    await api(view, '/api/servers/smoke/start', { body: {} })
    const loaded = await until(
      'Fabric to load Lithium',
      async () => {
        const r = await api<{ lines: string[] }>(
          view,
          '/api/servers/smoke/logs/view?name=latest.log&q=lithium',
        )
        return r.status === 200 && r.body.lines.length ? r.body.lines[0] : null
      },
      5 * 60_000,
      2000,
    )
    step(`added Lithium from Modrinth through plan and apply: ${loaded.slice(0, 120)}`)

    // Lithium came from the panel, so the server reads the panel's files through its extra
    // group. Inside the server's own view of the disk, the agent's socket, the panel's data
    // and its secrets must be hidden.
    const hidden = Bun.spawnSync([
      'docker',
      'exec',
      'vps',
      'sh',
      '-c',
      'pid="$(systemctl show -p MainPID --value flytower-mc@smoke)" && ' +
        'nsenter -t "$pid" -m sh -c \'test ! -e /run/flytower/agent.sock && ' +
        'test ! -s /etc/flytower/panel.env && test -z "$(ls -A /var/lib/flytower)"\'',
    ])
    if (hidden.exitCode !== 0) {
      throw new Error(`the server can see the agent or the panel's data: ${hidden.stderr}`)
    }
    step("the server can't see the agent's socket or the panel's data")

    // Vanilla Tweaks has no official API, so a change on their side is reported, not fatal.
    try {
      const cat = await api<{ datapacks: { name: string; packs: { name: string }[] }[] }>(
        view,
        '/api/servers/smoke/content/vanillatweaks',
      )
      if (cat.status !== 200) throw new Error(`catalogue: ${JSON.stringify(cat.body)}`)
      const group = cat.body.datapacks[0]!
      const pack = `${group.name}/${group.packs[0]!.name}`
      const vtYaml = `name: smoke\nloader:\n  type: fabric\n  minecraft: "${mc}"\ncontent:\n  - modrinth: lithium\n  - vanillatweaks: ${JSON.stringify(pack)}\n`
      const vtPlan = await api<{ ok: boolean; plan: { id: string; problems: string[] } }>(
        view,
        '/api/servers/smoke/plan',
        { body: { yaml: vtYaml } },
      )
      if (!vtPlan.body.ok || vtPlan.body.plan.problems.length) {
        throw new Error(`plan: ${JSON.stringify(vtPlan.body)}`)
      }
      const vtApply = await api<{ jobId: number }>(view, '/api/servers/smoke/apply', {
        body: { planId: vtPlan.body.plan.id },
      })
      await waitForJob(vtApply.body.jobId, 'the Vanilla Tweaks apply job', 10 * 60_000)
      const packs = await until(
        'the datapack to load',
        async () => {
          const r = await api<{ reply: string }>(view, '/api/servers/smoke/command', {
            body: { command: 'datapack list enabled' },
          })
          return r.status === 200 && r.body.reply.includes('vt-') ? r.body.reply : null
        },
        5 * 60_000,
        2000,
      )
      step(`added Vanilla Tweaks "${pack}": ${packs.slice(0, 160)}`)
    } catch (err) {
      console.log(`⚠ Vanilla Tweaks check skipped: ${(err as Error).message}`)
    }

    // Pre-generation: add Chunky through a plan, then generate a small area and cancel.
    const current = await api<{ spec: { content: unknown[] } }>(view, '/api/servers/smoke/spec')
    const chunkyPlan = await api<{ ok: boolean; plan: { id: string; problems: string[] } }>(
      view,
      '/api/servers/smoke/plan',
      {
        body: {
          spec: {
            ...current.body.spec,
            content: [...current.body.spec.content, { modrinth: 'chunky' }],
          },
        },
      },
    )
    const noBuild = chunkyPlan.body.plan?.problems.find((p) =>
      /no version|isn't available/i.test(p),
    )
    if (noBuild) {
      console.log(`⚠ Pre-generation check skipped: ${noBuild}`)
    } else {
      if (!chunkyPlan.body.ok || chunkyPlan.body.plan.problems.length) {
        throw new Error(`Chunky plan: ${JSON.stringify(chunkyPlan.body)}`)
      }
      const chunkyApply = await api<{ jobId: number }>(view, '/api/servers/smoke/apply', {
        body: { planId: chunkyPlan.body.plan.id },
      })
      await waitForJob(chunkyApply.body.jobId, 'the Chunky apply job', 10 * 60_000)
      await until(
        'Chunky to be ready',
        async () => {
          const r = await api<{ blocked: string | null }>(view, '/api/servers/smoke/world/pregen')
          return r.status === 200 && r.body.blocked === null ? true : null
        },
        5 * 60_000,
        2000,
      )
      const started = await api<{ reply: string }>(view, '/api/servers/smoke/world/pregen', {
        body: {
          action: 'start',
          dimension: 'overworld',
          radius: 256,
          center: null,
          shape: 'square',
        },
      })
      if (started.status !== 200) throw new Error(`pregen start: ${JSON.stringify(started.body)}`)
      const progress = await until(
        'Chunky to make progress',
        async () => {
          const r = await api<{ lines: string[] }>(
            view,
            '/api/servers/smoke/logs/view?name=latest.log&q=Processed',
          )
          return r.status === 200 && r.body.lines.length ? r.body.lines.at(-1) : null
        },
        5 * 60_000,
        2000,
      )
      await api(view, '/api/servers/smoke/world/pregen', { body: { action: 'cancel' } })
      step(`pre-generated with Chunky: ${progress.slice(0, 160)}`)
    }

    // Clone the running server with its world: the gold block comes along.
    const cloned = await api<{ jobId: number }>(view, '/api/servers/smoke/clone', {
      body: {
        name: 'smoke-copy',
        displayName: 'Smoke copy',
        memoryMb: 1024,
        withWorld: true,
        acceptEula: true,
      },
    })
    if (cloned.status !== 202) throw new Error(`clone failed: ${JSON.stringify(cloned.body)}`)
    await waitForJob(cloned.body.jobId, 'the clone job', 10 * 60_000)
    const clonedGold = await until(
      'the gold block in the clone',
      async () => {
        const r = await api<{ reply: string }>(view, '/api/servers/smoke-copy/command', {
          body: { command: 'execute if block 0 100 0 minecraft:gold_block' },
        })
        return r.status === 200 ? r.body.reply : null
      },
      5 * 60_000,
      2000,
    )
    if (!/passed/i.test(clonedGold)) throw new Error(`gold block missing in clone: ${clonedGold}`)
    const budget = await api<{ budget: { servers: unknown[] } }>(view, '/api/servers/defaults')
    step(
      `cloned a running server with its world (${budget.body.budget.servers.length} servers in the memory budget)`,
    )

    // An over-budget clone is refused before anything is copied.
    const tooBig = await api<{ statusMessage?: string }>(view, '/api/servers/smoke/clone', {
      body: {
        name: 'too-big',
        displayName: 'Too big',
        memoryMb: 65536,
        withWorld: false,
        acceptEula: true,
      },
    })
    if (tooBig.status !== 409) {
      throw new Error(`an over-budget clone should be refused: ${JSON.stringify(tooBig.body)}`)
    }
    await api(view, '/api/servers/smoke-copy/stop', { body: {} })

    // The metrics history has been sampling the running server once a minute.
    type Sample = {
      cpu: number | null
      memMb: number | null
      players: number | null
      mspt: number | null
    }
    const sample = await until(
      'a full metrics sample',
      async () => {
        const r = await api<{ points: Sample[] }>(view, '/api/servers/smoke/metrics?range=hour')
        return r.status === 200
          ? r.body.points.findLast(
              (p) => p.cpu !== null && p.memMb !== null && p.players !== null && p.mspt !== null,
            )
          : null
      },
      3 * 60_000,
      5000,
    )
    const machine = await api<{ points: Sample[] }>(view, '/api/system/metrics?range=hour')
    if (!machine.body.points.some((p) => p.memMb !== null)) {
      throw new Error('no machine metrics recorded')
    }
    step(
      `metrics: ${sample.cpu}% CPU, ${sample.memMb} MB, ${sample.players} online, ${sample.mspt} ms a tick`,
    )

    // Update channel: choose Beta on the System page, and it sticks after a reload.
    await view.navigate(`${base}/system/updates`)
    await waitForText(view, 'Update channel', 30_000)
    await view.evaluate(`(() => {
      const group = document.querySelector('[data-e2e=update-channel]')
      const beta = [...group.querySelectorAll('label')].find((l) => l.innerText.trim().startsWith('Beta'))
      beta.click()
    })()`)
    await until(
      'the Beta channel saved',
      async () =>
        (await api<{ channel: string }>(view, '/api/system/updates')).body?.channel === 'beta',
      30_000,
      500,
    )
    await view.navigate(`${base}/system/updates`)
    await waitForText(view, 'Update channel', 30_000)
    const checked = await view.evaluate<string | null>(`(() => {
      const r = document.querySelector('[data-e2e=update-channel] [role=radio][aria-checked=true]')
      return r?.closest('[data-slot=item]')?.innerText?.trim() ?? null
    })()`)
    if (!checked?.startsWith('Beta'))
      throw new Error(`after a reload, the channel shows ${checked}`)
    const back = await api<{ channel: string }>(view, '/api/system/updates/channel', {
      method: 'PUT',
      body: { channel: 'stable' },
    })
    if (back.body.channel !== 'stable') throw new Error(`channel not changed back: ${back.status}`)
    step('update channel set to Beta through the UI, and kept after a reload')

    // Paper: newest stable build, checked by sha256, starts and answers RCON.
    const paperVersions = await api<{ id: string }[]>(view, '/api/loaders/paper/minecraft')
    const paperMc = paperVersions.body[0]?.id
    if (!paperMc) throw new Error(`no Paper versions (${paperVersions.status})`)
    await api(view, '/api/servers/smoke/stop', { body: {} })
    const paper = await api<{ jobId: number }>(view, '/api/servers', {
      body: {
        name: 'smoke-paper',
        displayName: 'Smoke on Paper',
        loader: 'paper',
        mcVersion: paperMc,
        memoryMb: 1024,
        port: 25590,
        acceptEula: true,
      },
    })
    if (paper.status !== 202) throw new Error(`Paper create failed: ${JSON.stringify(paper.body)}`)
    const paperJob = await waitForJob(paper.body.jobId, 'the Paper create job', 10 * 60_000)
    const paperReply = await until(
      'Paper to answer RCON',
      async () => {
        const r = await api<{ reply: string }>(view, '/api/servers/smoke-paper/command', {
          body: { command: 'version' },
        })
        return r.status === 200 && /paper/i.test(r.body.reply) ? r.body.reply : null
      },
      6 * 60_000,
      3000,
    )
    step(`Paper ${paperMc}: ${paperJob.message} ${paperReply.split('\n')[0]!.slice(0, 100)}`)

    // Plugins: Chunky from Modrinth, plus Hangar's most downloaded plugin if Hangar has one
    // for this version (Hangar trouble is reported, not fatal).
    let hangarSlug: string | null = null
    const found = await api<{ hits: { slug: string; title: string }[] }>(
      view,
      '/api/servers/smoke-paper/content/search?kind=plugin&source=hangar',
    )
    if (found.status === 200 && found.body.hits[0]) hangarSlug = found.body.hits[0].slug
    else step(`⚠ Hangar search: ${found.status} ${JSON.stringify(found.body).slice(0, 160)}`)
    const pluginYaml = (withHangar: boolean) =>
      `name: smoke-paper\nloader:\n  type: paper\n  minecraft: "${paperMc}"\ncontent:\n  - modrinth: chunky\n` +
      (withHangar && hangarSlug ? `  - hangar: ${hangarSlug}\n` : '')
    let pluginPlan = await api<{ plan: { id: string; problems: string[] } }>(
      view,
      '/api/servers/smoke-paper/plan',
      { body: { yaml: pluginYaml(true) } },
    )
    if (pluginPlan.body.plan?.problems.length && hangarSlug) {
      step(`⚠ Hangar plugin ${hangarSlug} not usable: ${pluginPlan.body.plan.problems.join('; ')}`)
      hangarSlug = null
      pluginPlan = await api(view, '/api/servers/smoke-paper/plan', {
        body: { yaml: pluginYaml(false) },
      })
    }
    if (!pluginPlan.body.plan || pluginPlan.body.plan.problems.length) {
      throw new Error(`plugin plan: ${JSON.stringify(pluginPlan.body)}`)
    }
    const pluginApply = await api<{ jobId: number }>(view, '/api/servers/smoke-paper/apply', {
      body: { planId: pluginPlan.body.plan.id },
    })
    if (pluginApply.status !== 200)
      throw new Error(`plugin apply: ${JSON.stringify(pluginApply.body)}`)
    await waitForJob(pluginApply.body.jobId, 'the plugin apply job', 10 * 60_000)
    await api(view, '/api/servers/smoke-paper/start', { body: {} })
    const plugins = await until(
      'Paper to load Chunky',
      async () => {
        const r = await api<{ reply: string }>(view, '/api/servers/smoke-paper/command', {
          body: { command: 'plugins' },
        })
        return r.status === 200 && /chunky/i.test(r.body.reply) ? r.body.reply : null
      },
      6 * 60_000,
      3000,
    )
    step(
      `plugins on Paper${hangarSlug ? ` (with ${hangarSlug} from Hangar)` : ''}: ${plugins.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    await api(view, '/api/servers/smoke-paper/stop', { body: {} })
  }
  console.log('smoke test passed')
} catch (err) {
  await shot('failure').catch(() => {})
  console.error(`✗ ${(err as Error).message}`)
  process.exitCode = 1
} finally {
  view.close()
  Bun.WebView.closeAll()
}
