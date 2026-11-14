/**
 * A server spec: one YAML document that says what a server is. The form pages and the YAML
 * tab are two views of it. This file is shared by the browser and the panel's API, so it
 * holds only the schema and pure helpers; YAML parsing lives in server/spec.
 */
import { z } from 'zod'
import { Schedules, toItem, toTask } from './schedules'
import { PublicPage, compactPublicPage } from './public-page'
import { StatsSettings, isDefaultStats } from './stats-settings'
import { MapSettings, compactMap } from './map-settings'

export const SPEC_SCHEMA_PATH = '/schema/server-v1.json'

/** Keys Flytower manages itself; edit them through their own settings. */
export const MANAGED_PROPERTIES = [
  'server-port',
  'enable-rcon',
  'rcon.port',
  'rcon.password',
  // 127.0.0.1 behind the hostname router (#76), otherwise empty.
  'server-ip',
]

/** Secrets Minecraft keeps in server.properties that Flytower knows by name. */
export const SECRET_PROPERTIES = ['rcon.password', 'management-server-secret']

/**
 * True for a property that holds a credential. Besides the known ones, any key ending in
 * `secret` or `password` counts, so a secret added by a later Minecraft version is hidden
 * from the start. Secrets never go into a spec, the properties API or a clone; the Files
 * tab still shows server.properties as it is.
 */
export function isSecretProperty(key: string): boolean {
  return SECRET_PROPERTIES.includes(key) || /(^|[.-])(secret|password)$/i.test(key)
}

/** True for a property a spec or the Settings form can't set. */
export const isManagedProperty = (key: string) =>
  MANAGED_PROPERTIES.includes(key) || isSecretProperty(key)

/**
 * Whether a level-name is a plain folder name inside the server folder: letters, numbers,
 * spaces, dots, dashes and underscores, never "..".
 */
export const isSafeLevelName = (name: string) =>
  /^\w[\w .-]{0,63}$/.test(name) && !name.includes('..')

export const BAD_LEVEL_NAME =
  'The world folder name (level-name) can only use letters, numbers, spaces, dots, dashes and underscores.'

export const MIN_MEMORY_MB = 1024
export const MAX_MEMORY_MB = 65536
export const DEFAULT_MEMORY_MB = 4096

/** "4G", "3584M" or a number of megabytes, to megabytes. */
export function memoryToMb(value: string | number): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([MG])B?\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1]) * (m[2]!.toUpperCase() === 'G' ? 1024 : 1)
  return Number.isInteger(n) ? n : null
}

/** Megabytes the way a person would write them: 4096 is "4G", 3584 is "3584M". */
export function mbToMemory(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`
}

const versionString = (what: string) =>
  z
    .string({
      error: (iss) =>
        typeof iss.input === 'number'
          ? `Put the ${what} in quotes. Unquoted, YAML reads it as the number ${iss.input} (so 1.20 would become 1.2).`
          : `The ${what} should be text.`,
    })
    .trim()
    .min(1)
    .max(40)

const Name = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,30}$/,
    'Use lowercase letters, digits and hyphens, 2 to 31 characters, starting with a letter.',
  )
  .refine((n) => !n.endsWith('-'), "The name can't end with a hyphen.")
  .describe("The server's short name, used for its folder. It can't change once the server exists.")

const Loader = z
  .object({
    type: z
      .enum(['vanilla', 'fabric', 'paper'], {
        error: 'The loader is "vanilla", "fabric" or "paper".',
      })
      .describe('Which server software runs the world.'),
    minecraft: versionString('Minecraft version').describe('The Minecraft version, in quotes.'),
    version: versionString('loader version')
      .optional()
      .describe(
        'The Fabric loader version or Paper build number. Leave it out for the newest stable one.',
      ),
  })
  .strict()

const Memory = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const mb = memoryToMb(v)
    if (mb === null) {
      ctx.addIssue({ code: 'custom', message: 'Write memory like "4G" or "3584M".' })
      return z.NEVER
    }
    if (mb < MIN_MEMORY_MB || mb > MAX_MEMORY_MB) {
      ctx.addIssue({
        code: 'custom',
        message: `Memory must be between ${mbToMemory(MIN_MEMORY_MB)} and ${mbToMemory(MAX_MEMORY_MB)}.`,
      })
      return z.NEVER
    }
    return mb
  })
  .describe('Memory for Java, like "4G" or "3584M".')

const Properties = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'Property names are letters, numbers, dots and dashes.'),
    z.union([z.string().max(2000), z.number(), z.boolean()]),
  )
  .superRefine((props, ctx) => {
    const level = props['level-name']
    if (level !== undefined && !isSafeLevelName(String(level))) {
      ctx.addIssue({ code: 'custom', path: ['level-name'], message: BAD_LEVEL_NAME })
    }
    for (const key of Object.keys(props)) {
      if (isManagedProperty(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            key === 'server-port'
              ? 'Set the port with "port", not in properties.'
              : isSecretProperty(key)
                ? `${key} is a secret, so it's managed by Flytower and never kept in a spec.`
                : `${key} is managed by Flytower.`,
        })
      }
    }
  })
  .describe('Values for server.properties. Anything left out keeps its current value.')

const ContentKind = z.enum(['mod', 'plugin', 'datapack'])

const ModrinthItem = z
  .object({
    modrinth: z.string().trim().min(1).max(64).describe('A Modrinth project slug or id.'),
    version: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('A version number or id. Leave it out for the newest compatible one.'),
    kind: ContentKind.optional().describe('Usually worked out from the project.'),
  })
  .strict()

const UrlItem = z
  .object({
    url: z
      .url({ protocol: /^https$/, error: 'Content links must be https.' })
      .describe('Where to download it.'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'sha256 is 64 hex characters.')
      .describe('The file must match this hash, or it is refused.'),
    kind: ContentKind.describe("Where it goes: mods/, plugins/ or the world's datapacks/."),
    filename: z
      .string()
      .regex(/^[\w.+-]{1,120}\.(jar|zip)$/, 'A file name ending in .jar or .zip.')
      .optional(),
  })
  .strict()

const HangarItem = z
  .object({
    hangar: z
      .string()
      .trim()
      .regex(/^([\w.-]{1,64}\/)?[\w.-]{1,64}$/, 'A Hangar project, as "slug" or "owner/slug".')
      .describe('A plugin from Hangar (hangar.papermc.io), for Paper servers.'),
    version: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('A version name. Leave it out for the newest compatible one.'),
    kind: z.literal('plugin').optional(),
  })
  .strict()

const VanillaTweaksItem = z
  .object({
    vanillatweaks: z
      .string()
      .trim()
      .regex(/^[^/]{1,60}(\/[^/]{1,60})*\/[^/]{1,80}$/, 'Write it as "Category/pack name".')
      .describe(
        'A Vanilla Tweaks pack as "Category/pack name", e.g. "Survival/multiplayer sleep".',
      ),
    tweak: z
      .enum(['datapack', 'crafting'])
      .optional()
      .describe('"crafting" for a crafting tweak; datapacks are the default.'),
    kind: z.literal('datapack').optional(),
  })
  .strict()

const ContentItem = z.union([ModrinthItem, HangarItem, UrlItem, VanillaTweaksItem], {
  error:
    'Each content item needs "modrinth" or "hangar" (a project), "vanillatweaks" (a pack), or "url" with "sha256" and "kind".',
})

const Keep = z
  .object({
    last: z.number().int().min(0).max(100).default(6),
    daily: z.number().int().min(0).max(366).default(7),
    weekly: z.number().int().min(0).max(520).default(4),
  })
  .strict()

const Backups = z
  .object({
    schedule: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .default(null)
      .describe('A cron expression such as "0 4 * * *", or null for none.'),
    timezone: z.string().trim().min(1).max(60).default('UTC'),
    keep: Keep.default({ last: 6, daily: 7, weekly: 4 }),
    offsite: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .nullable()
      .optional()
      .describe(
        'Off-site storage (by its name on the System page) to copy backups to, or null for none. Left out, it stays.',
      ),
  })
  .strict()

const Recovery = z
  .object({
    restartWhenUnresponsive: z
      .boolean()
      .default(false)
      .describe(
        "Restart the server once, automatically, when its console hasn't answered for five minutes.",
      ),
  })
  .strict()

/** A DNS name players connect with, stored lower case. */
export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    'Use a full address like survival.example.com: letters, numbers, hyphens and dots.',
  )

export const ServerSpec = z
  .object({
    name: Name,
    displayName: z.string().trim().min(1).max(60).optional(),
    loader: Loader,
    memory: Memory.optional(),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe('The game port. Leave it out to use the next free one.'),
    hostname: Hostname.nullable()
      .optional()
      .describe(
        'The address players use, like survival.example.com. null for none; left out, it stays.',
      ),
    properties: Properties.default({}),
    content: z.array(ContentItem).max(500).default([]),
    backups: Backups.optional().describe(
      'Backup schedule and how many to keep. Left out, the current settings stay.',
    ),
    recovery: Recovery.optional().describe(
      'What Flytower does when the server gets stuck. Left out, the current settings stay.',
    ),
    schedules: Schedules.optional(),
    public: PublicPage.optional().describe(
      'The public status page. Left out, the current settings stay.',
    ),
    stats: StatsSettings.optional().describe(
      'Player stats and who is left out of them. Left out, the current settings stay.',
    ),
    map: MapSettings.optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'The time zone schedules are read in, like Europe/London. Left out, it stays (UTC at first).',
      ),
  })
  .strict()
  .describe('A Flytower server.')

/** What a spec says once defaults are filled in. */
export type ServerSpec = z.output<typeof ServerSpec>
/** What a person may write. */
export type ServerSpecInput = z.input<typeof ServerSpec>
export type ContentItem = z.output<typeof ContentItem>

export interface SpecIssue {
  /** Where, like "loader.minecraft" or "content.2.sha256"; empty for the whole document. */
  path: string
  message: string
  /** 1-based line in the YAML, when it can be found. */
  line?: number
}

export const issuePath = (path: readonly PropertyKey[]) => path.map(String).join('.')

/** The spec as a person would write it: defaults left out, memory as "4G". */
export function compactSpec(spec: ServerSpec): ServerSpecInput {
  const out: Record<string, unknown> = { name: spec.name }
  if (spec.displayName && spec.displayName !== spec.name) out.displayName = spec.displayName
  out.loader = { ...spec.loader }
  if (spec.memory !== undefined) out.memory = mbToMemory(spec.memory)
  if (spec.port !== undefined) out.port = spec.port
  if (spec.hostname) out.hostname = spec.hostname
  if (Object.keys(spec.properties).length) out.properties = spec.properties
  if (spec.content.length) out.content = spec.content
  if (spec.recovery?.restartWhenUnresponsive) out.recovery = { restartWhenUnresponsive: true }
  if (spec.timezone && spec.timezone !== 'UTC') out.timezone = spec.timezone
  if (spec.schedules?.length) out.schedules = spec.schedules.map((s) => toItem(toTask(s)))
  const publicPage = spec.public && compactPublicPage(spec.public)
  if (publicPage) out.public = publicPage
  if (spec.stats && !isDefaultStats(spec.stats)) {
    out.stats = spec.stats.enabled
      ? { leaveOut: spec.stats.leaveOut }
      : spec.stats.leaveOut.length
        ? { enabled: false, leaveOut: spec.stats.leaveOut }
        : { enabled: false }
  }
  const map = spec.map && compactMap(spec.map)
  if (map) out.map = map
  const b = spec.backups
  if (!b) return out as ServerSpecInput
  const keepDefault = b.keep.last === 6 && b.keep.daily === 7 && b.keep.weekly === 4
  if (b.schedule || b.timezone !== 'UTC' || !keepDefault || b.offsite) {
    out.backups = {
      schedule: b.schedule,
      ...(b.timezone !== 'UTC' ? { timezone: b.timezone } : {}),
      ...(keepDefault ? {} : { keep: b.keep }),
      ...(b.offsite ? { offsite: b.offsite } : {}),
    }
  }
  return out as ServerSpecInput
}
