// Mailing list helpers. Kept free of Nuxt and Cloudflare imports so `bun test` can run them.

/**
 * The words shown beside the Subscribe button, by version. Each sign-up stores the version it
 * saw, so change the wording by adding a new entry, never by editing an old one.
 */
export const CONSENT = {
  '2026-11-12':
    'Occasional news about Flytower releases. No tracking, and you can unsubscribe at any time.',
} as const
export const CONSENT_VERSION: keyof typeof CONSENT = '2026-11-12'

/** RFC 5321 caps an address at 254 characters. */
const MAX_EMAIL = 254
// Deliberately plain: one @, something either side, a dot in the domain, no spaces or controls.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trims and lower-cases an address, or returns null when it isn't one we'll store. */
export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const email = input.trim().toLowerCase()
  if (!email || email.length > MAX_EMAIL) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(email)) return null
  return EMAIL.test(email) ? email : null
}

/** The request came from one of our own pages (blocks other sites posting the form). */
export function sameOrigin(origin: string | undefined, requestUrl: URL): boolean {
  if (!origin) return false
  try {
    return new URL(origin).host === requestUrl.host
  } catch {
    return false
  }
}
