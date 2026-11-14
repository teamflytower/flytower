/**
 * What `flytower-world trim` says it did, or would do with `--dry-run`. Shared by the
 * browser (the trim dialog) and the panel's API.
 */

export interface TrimDimension {
  /** Like `minecraft:overworld`. */
  id: string
  /** Region files, and the chunks in them. */
  regions: number
  chunks: number
  /** Chunks removed, or that would be. */
  removed: number
  /** Region files deleted because nothing was left in them. */
  regionsDeleted: number
  /** Region files in `region/`, `entities/` and `poi/`, before and after. */
  bytesBefore: number
  bytesAfter: number
  /** Fully generated chunks, and how many of those nobody has ever been near. */
  full: number
  unvisited: number
  /** Files or chunks that couldn't be read. Unreadable chunks are always kept. */
  errors: number
  firstError: string | null
}

export interface TrimReport {
  dryRun: boolean
  /** Most chunks are fully generated and nobody has been near them: Chunky's work. */
  pregenerated: boolean
  /** Things the tool couldn't read about the world, like a player file. */
  warnings: string[]
  dimensions: TrimDimension[]
  ms: number
}

/** A preview, with when it was made and whether the server was running. */
export interface TrimPreview extends TrimReport {
  at: string
  /** The server was running, so the figures may move a little by the time it's trimmed. */
  running: boolean
}

/**
 * Which chunks a trim would remove, for the map: per dimension, per region `[x, z, mask]`,
 * where the mask is base64 of 128 bytes and chunk `x + z * 32` within the region is bit
 * `i % 8` of byte `i / 8`. Regions with nothing going are left out.
 */
export interface TrimBitmap {
  dimensions: { id: string; regions: [number, number, string][] }[]
}

/** The last preview as the map overlay keeps it: when, with which rules, and what goes. */
export interface TrimOverlayPreview {
  at: string
  /** The rules as the tool read them, to tell whether the saved rules have moved on. */
  rules: object
  removed: number
  bitmap: TrimBitmap
}

const DIMENSION_NAMES: Record<string, string> = {
  'minecraft:overworld': 'Overworld',
  'minecraft:the_nether': 'Nether',
  'minecraft:the_end': 'End',
}

/** A dimension's name for people: "Nether" for `minecraft:the_nether`. */
export function dimensionName(id: string): string {
  return DIMENSION_NAMES[id] ?? id.replace(/^minecraft:/, '').replaceAll('_', ' ')
}

/** The report summed over its dimensions. */
export function trimTotals(r: Pick<TrimReport, 'dimensions'>) {
  const t = { chunks: 0, removed: 0, bytesBefore: 0, bytesAfter: 0, errors: 0 }
  for (const d of r.dimensions) {
    t.chunks += d.chunks
    t.removed += d.removed
    t.bytesBefore += d.bytesBefore
    t.bytesAfter += d.bytesAfter
    t.errors += d.errors
  }
  return { ...t, saved: Math.max(0, t.bytesBefore - t.bytesAfter) }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Reads the tool's answer, refusing one this panel doesn't understand. */
export function parseTrimReport(out: string): TrimReport {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new Error("flytower-world's answer isn't JSON")
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.dimensions)) {
    throw new Error("flytower-world's answer isn't one this panel understands")
  }
  return {
    dryRun: parsed.dryRun === true,
    pregenerated: parsed.pregenerated === true,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    dimensions: (parsed.dimensions as Record<string, unknown>[]).map((d) => ({
      id: String(d.id),
      regions: num(d.regions),
      chunks: num(d.chunks),
      removed: num(d.removed),
      regionsDeleted: num(d.regionsDeleted),
      bytesBefore: num(d.bytesBefore),
      bytesAfter: num(d.bytesAfter),
      full: num(d.full),
      unvisited: num(d.unvisited),
      errors: num(d.errors),
      firstError: typeof d.firstError === 'string' ? d.firstError : null,
    })),
    ms: num(parsed.ms),
  }
}

/**
 * Where a server's trim preview is, as the `trim:<name>` topic sends it. A preview runs in
 * the background, since a big world takes minutes; `run` tells one preview from the next.
 */
export type TrimPreviewState =
  | { state: 'idle' }
  | { state: 'running'; run: number; rules: unknown; done: number; total: number }
  | { state: 'done'; run: number; rules: unknown; preview: TrimPreview }
  | { state: 'failed'; run: number; rules: unknown; error: string }
