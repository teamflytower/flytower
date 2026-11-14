/**
 * Trimming unused chunks with `flytower-world trim` (#299): the helpers the world service
 * uses around the tool. The rules come from the server's spec (`world.trim`) as the tool's
 * own JSON; the tool decides which chunks go.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatBytes } from '../backups/service'
import { parseTrimReport, trimTotals, type TrimReport } from '../../shared/trim-report'

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
  opts: { dryRun: boolean; onProgress?: (p: ToolProgress) => void },
): Promise<TrimReport> {
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
    return parseTrimReport(await tool(args, opts.onProgress))
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
