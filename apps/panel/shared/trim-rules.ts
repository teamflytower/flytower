/**
 * What "Trim unused chunks" keeps: the rules and protected areas in a server's spec
 * (`world.trim`). Shared by the spec, the World tab's trim dialog and the trim job, which
 * hands them to `flytower-world trim --rules` as JSON (see toToolRules).
 *
 * A chunk goes only if every rule agrees it can. Radii and the buffer are in chunks;
 * protected areas are in blocks, and keep every chunk they touch.
 */
import { z } from 'zod'

/** Block coordinates as far as Minecraft goes. */
export const COORD_LIMIT = 30_000_000
export const MAX_PROTECTED_AREAS = 100

/** The vanilla dimensions, as written in a spec. */
export const VANILLA_DIMENSIONS = ['overworld', 'the_nether', 'the_end'] as const

/** A dimension as a spec writes it: "minecraft:" is left off vanilla ones. */
export const shortDimension = (id: string) =>
  id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id

const Dimension = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^([a-z0-9_.-]{1,64}:)?[a-z0-9_./-]{1,128}$/,
    'A dimension is "overworld", "the_nether", "the_end", or a modded one like "mod:sky".',
  )
  .transform(shortDimension)

const Coord = z
  .number({ error: 'Coordinates are whole numbers of blocks.' })
  .int('Coordinates are whole numbers of blocks.')
  .min(-COORD_LIMIT, `Coordinates go from -${COORD_LIMIT} to ${COORD_LIMIT}.`)
  .max(COORD_LIMIT, `Coordinates go from -${COORD_LIMIT} to ${COORD_LIMIT}.`)

const Corner = z.tuple([Coord, Coord], { error: 'Write a corner as [x, z], in blocks.' })

export const ProtectedArea = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Give the area a name, like "Town".')
      .max(60, 'Keep the name to 60 characters.')
      .describe('What the area is, so people know why it is kept.'),
    dimension: Dimension.default('overworld').describe(
      'Which dimension the area is in. Left out, the overworld.',
    ),
    from: Corner.describe('One corner, as [x, z] in blocks.'),
    to: Corner.describe('The opposite corner, as [x, z] in blocks.'),
  })
  .strict()
  .describe('An area that is always kept, whatever the other rules say.')

const whole = (what: string, max: number) =>
  z
    .number({ error: `${what} is a whole number of chunks.` })
    .int(`${what} is a whole number of chunks.`)
    .min(0, `${what} can't be below 0.`)
    .max(max, `${what} is at most ${max} chunks.`)

export const TrimRules = z
  .object({
    inhabitedMinutes: z
      .number({ error: 'inhabitedMinutes is a number of minutes.' })
      .min(0, "inhabitedMinutes can't be below 0.")
      .max(60, 'inhabitedMinutes is at most 60.')
      .default(2)
      .describe(
        'Keep chunks players have spent at least this many minutes in, in total. Even at 0, a chunk anyone has spent time in is kept.',
      ),
    spawnRadius: whole('spawnRadius', 256)
      .default(16)
      .describe('Keep this many chunks round world spawn.'),
    playerRadius: whole('playerRadius', 64)
      .default(4)
      .describe("Keep this many chunks round each player's last position and respawn point."),
    buffer: whole('buffer', 16)
      .default(2)
      .describe('Keep this many chunks round every kept chunk, so builds never end at a seam.'),
    endRadius: whole('endRadius', 256)
      .default(12)
      .describe('In the End, keep this many chunks round 0,0: the main island.'),
    unfinished: z
      .boolean()
      .default(true)
      .describe('Remove half-generated chunks, wherever they are.'),
    border: z.boolean().default(true).describe('Remove chunks wholly outside the world border.'),
    dimensions: z
      .array(Dimension)
      .max(32)
      .default([...VANILLA_DIMENSIONS])
      .refine((d) => new Set(d).size === d.length, 'Each dimension is listed once.')
      .describe('The dimensions to trim. Others are left alone.'),
    protect: z
      .array(ProtectedArea)
      .max(MAX_PROTECTED_AREAS, `At most ${MAX_PROTECTED_AREAS} protected areas.`)
      .default([])
      .superRefine((areas, ctx) => {
        const seen = new Set<string>()
        areas.forEach((a, i) => {
          const key = a.name.toLowerCase()
          if (seen.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'name'],
              message: `There's already an area called "${a.name}".`,
            })
          }
          seen.add(key)
        })
      })
      .describe('Areas that are always kept.'),
  })
  .strict()
  .describe(
    'What "Trim unused chunks" keeps. Left out, the current rules stay. Trimming itself is started from the World tab.',
  )

export type TrimRules = z.output<typeof TrimRules>
export type TrimRulesInput = z.input<typeof TrimRules>
export type ProtectedArea = z.output<typeof ProtectedArea>

export const DEFAULT_TRIM: TrimRules = TrimRules.parse({})

/** The rules as stored (null until first set), with defaults filled in. */
export function readTrimRules(raw: unknown): TrimRules {
  const r = TrimRules.safeParse(raw ?? {})
  return r.success ? r.data : TrimRules.parse({})
}

/** The same area: corners in either order mean the same rectangle. */
function areaKey(a: ProtectedArea): string {
  const [x1, x2] = [a.from[0], a.to[0]].sort((p, q) => p - q)
  const [z1, z2] = [a.from[1], a.to[1]].sort((p, q) => p - q)
  return `${a.name}\u0000${a.dimension}\u0000${x1},${z1},${x2},${z2}`
}

export function sameTrimRules(a: TrimRules, b: TrimRules): boolean {
  return (
    a.inhabitedMinutes === b.inhabitedMinutes &&
    a.spawnRadius === b.spawnRadius &&
    a.playerRadius === b.playerRadius &&
    a.buffer === b.buffer &&
    a.endRadius === b.endRadius &&
    a.unfinished === b.unfinished &&
    a.border === b.border &&
    a.dimensions.length === b.dimensions.length &&
    a.dimensions.every((d, i) => d === b.dimensions[i]) &&
    a.protect.length === b.protect.length &&
    a.protect.every((p, i) => areaKey(p) === areaKey(b.protect[i]!))
  )
}

export const isDefaultTrim = (t: TrimRules) => sameTrimRules(t, DEFAULT_TRIM)

const SCALARS = [
  'inhabitedMinutes',
  'spawnRadius',
  'playerRadius',
  'buffer',
  'endRadius',
  'unfinished',
  'border',
] as const

/** Only what differs from the defaults, for a tidy spec; null when it's all defaults. */
export function compactTrim(t: TrimRules): TrimRulesInput | null {
  if (isDefaultTrim(t)) return null
  const out: Record<string, unknown> = {}
  for (const key of SCALARS) if (t[key] !== DEFAULT_TRIM[key]) out[key] = t[key]
  const dims = t.dimensions
  if (
    dims.length !== DEFAULT_TRIM.dimensions.length ||
    dims.some((d, i) => d !== DEFAULT_TRIM.dimensions[i])
  ) {
    out.dimensions = dims
  }
  if (t.protect.length) {
    out.protect = t.protect.map((p) => ({
      name: p.name,
      ...(p.dimension !== 'overworld' ? { dimension: p.dimension } : {}),
      from: p.from,
      to: p.to,
    }))
  }
  return out as TrimRulesInput
}

/** A one-line summary for plans and the activity log. */
export function describeTrim(t: TrimRules): string {
  if (isDefaultTrim(t)) return 'Default rules'
  const changed = SCALARS.filter((k) => t[k] !== DEFAULT_TRIM[k]).length
  const parts: string[] = []
  if (changed) parts.push(`${changed} rule${changed === 1 ? '' : 's'} changed`)
  const dimsDefault =
    t.dimensions.length === DEFAULT_TRIM.dimensions.length &&
    t.dimensions.every((d, i) => d === DEFAULT_TRIM.dimensions[i])
  if (!dimsDefault) {
    parts.push(t.dimensions.length ? `trims ${t.dimensions.join(', ')}` : 'trims no dimensions')
  }
  if (t.protect.length) {
    parts.push(`${t.protect.length} protected area${t.protect.length === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

/**
 * The rules as the JSON `flytower-world trim --rules` reads. Every field is written out,
 * so a change to the tool's defaults can never change what a saved spec means.
 */
export function toToolRules(t: TrimRules) {
  return {
    inhabitedMinutes: t.inhabitedMinutes,
    spawnRadius: t.spawnRadius,
    playerRadius: t.playerRadius,
    buffer: t.buffer,
    endRadius: t.endRadius,
    unfinished: t.unfinished,
    border: t.border,
    dimensions: [...t.dimensions],
    protect: t.protect.map((p) => ({
      name: p.name,
      dimension: p.dimension,
      from: [...p.from],
      to: [...p.to],
    })),
  }
}

/** The world part of a spec. More world settings can join `trim` later. */
export const WorldSettings = z
  .object({
    trim: TrimRules.optional(),
  })
  .strict()
  .describe('World settings. Left out, the current settings stay.')

export type WorldSettings = z.output<typeof WorldSettings>
