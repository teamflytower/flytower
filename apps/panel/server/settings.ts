/** Panel-wide settings, stored as JSON in the settings table. Each key has a type and a default. */
import { eq } from 'drizzle-orm'
import { schema, type DbOrTx } from './db'
import type { DiskReport } from '../shared/disk'
import type { BrandingSettings, ImageType } from '../shared/branding'
import type { DiscordApp } from './discord/service'
import type { DiscordRoleMapping } from '../shared/discord'
import type { RouterSettings } from './routing/table'

export type UpdateChannel = 'stable' | 'beta'

export interface Settings {
  /**
   * Which releases are offered: stable only, or betas too. Unset until someone chooses.
   * `native` is from 1.2 to 1.4, when there was a Native channel: it reads as unset, with a
   * notice, until someone chooses again (see `updateChannel`).
   */
  'update.channel': UpdateChannel | 'native'
  /** The last disk use measurement, so the System page has figures straight after a restart. */
  'disk.usage': DiskReport
  /** The install's own name, colour and font. Missing fields mean Flytower's own. */
  branding: Partial<BrandingSettings>
  /** Cleaned uploads, base64, with a hash for cache busting. */
  'branding.logo': StoredImage
  'branding.favicon': StoredImage
  /** The connected Discord app, with its bot token sealed. */
  'discord.app': DiscordApp
  /** Discord roles whose members get Flytower roles in slash commands. */
  'discord.roles': DiscordRoleMapping[]
  /** Chat from Discord into the game: whether the panel keeps a Gateway connection open. */
  'discord.chat': { enabled: boolean }
  /** One address for every server: the hostname router's switch, port and messages (#76). */
  router: RouterSettings
}

export interface StoredImage {
  type: ImageType
  data: string
  hash: string
}

export function getSetting<K extends keyof Settings>(db: DbOrTx, key: K): Settings[K] | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value as Settings[K] | undefined
}

export function setSetting<K extends keyof Settings>(db: DbOrTx, key: K, value: Settings[K]) {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run()
}

export function deleteSetting(db: DbOrTx, key: keyof Settings) {
  db.delete(schema.settings).where(eq(schema.settings.key, key)).run()
}
