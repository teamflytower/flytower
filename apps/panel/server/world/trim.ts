/**
 * Trimming unused chunks with `flytower-world trim` (#299): the helpers the world service
 * uses around the tool. The rules come from the server's spec (`world.trim`) as the tool's
 * own JSON; the tool decides which chunks go.
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatBytes } from '../backups/service'
import {
  parseTrimReport,
  trimTotals,
  type TrimBitmap,
  type TrimOverlayPreview,
  type TrimReport,
} from '../../shared/trim-report'

export interface ToolProgress {
  done: number
  total: number
}

/** Runs `flytower-world` with these arguments and returns what it prints. */
export type WorldTool = (args: string[], onProgress?: (p: ToolProgress) => void) => Promise<string>

/** Region files the tool rewrites at once, each through a temporary copy. */
const TOOL_THREADS = 4

/**
 * Space the trim needs while it runs: each region file is written to a new file and then
 * swapped in, a few at a time, so it's a few of the biggest region files, plus a margin.
 */
export async function trimNeedBytes(world: string): Promise<number> {
  let largest = 0
  for await (const rel of new Bun.Glob('**/*.mca').scan({ cwd: world, onlyFiles: true })) {
    const s = await stat(join(world, rel)).catch(() => null)
    if (s && s.size > largest) largest = s.size
  }
  return largest * TOOL_THREADS + 16 * 1024 * 1024
}

/** Runs the tool on a world with these rules, through a rules file it reads and we delete. */
export async function runTrim(
  tool: WorldTool,
  world: string,
  rules: object,
  opts: { dryRun: boolean; onProgress?: (p: ToolProgress) => void; bitmap?: boolean },
): Promise<TrimReport & { bitmap?: TrimBitmap }> {
  const dir = await mkdtemp(join(tmpdir(), 'flytower-trim-'))
  try {
    const file = join(dir, 'rules.json')
    await writeFile(file, JSON.stringify(rules), { mode: 0o600 })
    const args = [
      'trim',
      '--world',
      world,
      '--rules',
      file,
      '--progress',
      '--threads',
      String(TOOL_THREADS),
    ]
    if (opts.dryRun) args.push('--dry-run')
    const bitmapFile = join(dir, 'bitmap.json')
    if (opts.bitmap) args.push('--bitmap', bitmapFile)
    const report = parseTrimReport(await tool(args, opts.onProgress))
    if (!opts.bitmap) return report
    try {
      return { ...report, bitmap: parseBitmap(await readFile(bitmapFile, 'utf8')) }
    } catch (err) {
      // The preview still stands without it; only the map's overlay goes without.
      console.error("[flytower] couldn't read the trim preview's chunk map", err)
      return report
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const count = (n: number) => n.toLocaleString('en-GB')

/** One sentence on what a trim did, for the job and the notification. */
export function trimSummary(report: TrimReport): string {
  const t = trimTotals(report)
  if (t.removed === 0) return 'Nothing needed trimming: every chunk is in use.'
  const chunks = t.removed === 1 ? '1 chunk' : `${count(t.removed)} chunks`
  const unread =
    t.errors > 0
      ? ` ${count(t.errors)} ${t.errors === 1 ? "chunk or file couldn't" : "chunks or files couldn't"} be read and ${t.errors === 1 ? 'was' : 'were'} kept.`
      : ''
  return `Removed ${chunks} and freed ${formatBytes(t.saved)}. The region files are now ${formatBytes(t.bytesAfter)}.${unread}`
}

/** Reads the tool's `--bitmap` file: which chunks would go, per region, for the map. */
export function parseBitmap(text: string): TrimBitmap {
  const parsed = JSON.parse(text) as { version?: number; dimensions?: unknown }
  if (parsed.version !== 1 || !Array.isArray(parsed.dimensions)) {
    throw new Error("flytower-world's chunk map isn't one this panel understands")
  }
  return {
    dimensions: (parsed.dimensions as { id?: unknown; regions?: unknown }[]).map((d) => ({
      id: String(d.id),
      regions: (Array.isArray(d.regions) ? d.regions : [])
        .filter(
          (r): r is [number, number, string] =>
            Array.isArray(r) &&
            Number.isInteger(r[0]) &&
            Number.isInteger(r[1]) &&
            typeof r[2] === 'string',
        )
        .map(([x, z, mask]) => [x, z, mask] as [number, number, string]),
    })),
  }
}

/**
 * The last preview's chunk map for each server, kept for the web map's overlay (#303). One
 * small file per server, replaced whole; removed once the world has been trimmed.
 */
export class TrimPreviews {
  constructor(private dir: string) {}

  private file(name: string) {
    return join(this.dir, `${name}.json`)
  }

  async save(name: string, preview: TrimOverlayPreview) {
    await mkdir(this.dir, { recursive: true })
    const part = `${this.file(name)}.part`
    await writeFile(part, JSON.stringify(preview))
    await rename(part, this.file(name))
  }

  async get(name: string): Promise<TrimOverlayPreview | null> {
    try {
      return JSON.parse(await readFile(this.file(name), 'utf8')) as TrimOverlayPreview
    } catch {
      return null
    }
  }

  async clear(name: string) {
    await rm(this.file(name), { force: true })
  }
}
