/**
 * Builds a release tarball for one architecture.
 *
 *   bun scripts/package.ts --version 0.1.0 --arch amd64 [--bun /path/to/bun] [--out dist]
 *
 * Expects `bun run build` to have produced apps/panel/.output, cargo (with the toolchain in
 * crates/rust-toolchain.toml) for the Rust helpers, go (the version in go/go.mod) for the
 * Go ones, and Java 25 for the flytower-proxy mod (Gradle comes with the mod's wrapper). Without --bun it downloads the official Bun release matching packageManager in
 * package.json and checks its hash.
 */
import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { $ } from 'bun'

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    arch: { type: 'string' },
    bun: { type: 'string' },
    out: { type: 'string', default: 'dist' },
  },
})

const repo = resolve(import.meta.dir, '..')
const version = values.version?.replace(/^v/, '')
const arch = values.arch
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
  throw new Error('--version x.y.z is required')
if (arch !== 'amd64' && arch !== 'arm64') throw new Error('--arch must be amd64 or arm64')

const out = resolve(repo, values.out!)
const name = `flytower-${version}`
const stage = join(out, `stage-${arch}`, name)
await rm(join(out, `stage-${arch}`), { recursive: true, force: true })
await mkdir(join(stage, 'bin'), { recursive: true })

// Panel: the Nitro output is plain JavaScript, so one build serves both architectures.
const panelOutput = join(repo, 'apps/panel/.output')
if (!(await Bun.file(join(panelOutput, 'server/index.mjs')).exists())) {
  throw new Error('apps/panel/.output is missing; run `bun run build` first')
}
// Nitro links duplicate dependency versions with absolute symlinks into the build folder,
// which won't exist on the server. Copy the real files instead.
await cp(panelOutput, join(stage, 'panel'), { recursive: true, dereference: true })
const links = (await $`find ${join(stage, 'panel')} -type l`.text()).trim()
if (links) throw new Error(`symlinks left in the panel output:\n${links}`)

// Bun itself, for the panel.
const bunTarget = join(stage, 'bin/bun')
if (values.bun) {
  await cp(values.bun, bunTarget)
} else {
  const pkg = await Bun.file(join(repo, 'package.json')).json()
  const bunVersion = String(pkg.packageManager).replace(/^bun@/, '')
  const asset = arch === 'amd64' ? 'bun-linux-x64' : 'bun-linux-aarch64'
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}`
  const tmp = join(out, `${asset}.zip`)
  await $`curl -fsSL -o ${tmp} ${base}/${asset}.zip`
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums
    .split('\n')
    .find((l) => l.endsWith(` ${asset}.zip`))
    ?.split(/\s+/)[0]
  const actual = new Bun.CryptoHasher('sha256').update(await Bun.file(tmp).bytes()).digest('hex')
  if (!expected || expected !== actual) throw new Error(`${asset}.zip failed its checksum`)
  await $`unzip -q -o ${tmp} -d ${out}`
  await cp(join(out, asset, 'bun'), bunTarget)
}
await chmod(bunTarget, 0o755)

// Rust helpers (crates/), as static binaries. rust-lld cross-links arm64 from amd64.
const rustTarget = arch === 'amd64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl'
const crates = join(repo, 'crates')
await $`cargo build --release --locked --target ${rustTarget}`.cwd(crates)
// systemd and the agent start bin/flytower-agent and bin/flytower-updater by these paths,
// whatever is behind them (docs/decisions/0001-rust-and-go.md). Since 1.5.0 that is the Rust
// programs themselves: no wrapper, no Bun fallback.
for (const bin of ['flytower-du', 'flytower-agent', 'flytower-updater', 'flytower-map']) {
  await cp(join(crates, 'target', rustTarget, 'release', bin), join(stage, 'bin', bin))
  await chmod(join(stage, 'bin', bin), 0o755)
}

// Go helpers (go/), cross-compiled with cgo off, so they're static for either architecture.
const goModule = join(repo, 'go')
for (const bin of ['flytower-router']) {
  const target = join(stage, 'bin', bin)
  await $`go build -trimpath -ldflags=${`-s -w -X main.version=${version}`} -o ${target} ./cmd/${bin}`
    .cwd(goModule)
    .env({ ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch })
  await chmod(target, 0o755)
}
// Their systemd units, which the agent installs when a feature that needs one is turned on.
await mkdir(join(stage, 'systemd'), { recursive: true })
await cp(
  join(goModule, 'cmd/flytower-router/flytower-router.service'),
  join(stage, 'systemd/flytower-router.service'),
)

// The flytower-proxy Fabric mod, which the panel puts in Fabric servers behind the hostname
// router so they see players' real addresses (#76). A jar runs anywhere, so one build serves
// both architectures; the second run finds it up to date. It's signed with the rest, through
// SHA256SUMS.
const modDir = join(repo, 'mods/flytower-proxy')
await $`./gradlew jar --no-daemon --console=plain -q -Pmod_version=${version}`.cwd(modDir)
await mkdir(join(stage, 'mods'), { recursive: true })
await cp(
  join(modDir, `build/libs/flytower-proxy-${version}.jar`),
  join(stage, 'mods/flytower-proxy.jar'),
)

await cp(join(repo, 'installer/install.sh'), join(stage, 'install.sh'))
await chmod(join(stage, 'install.sh'), 0o755)
await Bun.write(join(stage, 'VERSION'), `${version}\n`)

const tarball = join(out, `${name}-linux-${arch}.tar.gz`)
// System tar keeps the executable bits that Bun.Archive currently drops.
await $`tar --owner=0 --group=0 --numeric-owner -czf ${tarball} -C ${join(out, `stage-${arch}`)} ${name}`
await rm(join(out, `stage-${arch}`), { recursive: true, force: true })
console.log(tarball)
