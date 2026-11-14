import { CONSENT_VERSION, normaliseEmail, sameOrigin } from '../../utils/newsletter'

// Mailing list sign-up. The site checks the request (rate, origin, size, honeypot, Turnstile) and
// then hands the address to the mailing list service over the LISTS service binding, which
// stores it as unconfirmed and emails a confirmation link. Every accepted request gets the same
// reply, so the form can't be used to find out who is already on the list.
//
// Never log the address or the body here: Worker logs are kept by Cloudflare.

interface Env {
  NEWSLETTER_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  TURNSTILE_SECRET?: { get(): Promise<string> }
  LISTS?: {
    subscribe(input: { list: string; email: string; consentVersion: string }): Promise<unknown>
  }
}

const MAX_BODY = 2048
// Cloudflare's always-pass test secret, used only in `nuxt dev` where there is no real one.
const DEV_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'

const refuse = (statusCode: number, code: string) =>
  createError({ statusCode, statusMessage: code, data: { code } })

export default defineEventHandler(async (event) => {
  if (!useRuntimeConfig(event).public.newsletterOpen) throw refuse(404, 'closed')

  const env = (event.context.cloudflare?.env ?? {}) as Env
  const ip = getRequestHeader(event, 'cf-connecting-ip') ?? ''

  if (env.NEWSLETTER_LIMITER && !(await env.NEWSLETTER_LIMITER.limit({ key: ip })).success)
    throw refuse(429, 'slow_down')

  if (!sameOrigin(getRequestHeader(event, 'origin'), getRequestURL(event)))
    throw refuse(403, 'origin')
  if (!getRequestHeader(event, 'content-type')?.startsWith('application/json'))
    throw refuse(415, 'json_only')
  if (Number(getRequestHeader(event, 'content-length') ?? MAX_BODY + 1) > MAX_BODY)
    throw refuse(413, 'too_large')

  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  if (!body || typeof body !== 'object') throw refuse(400, 'bad_body')

  // The honeypot: a field hidden from people. A filled one is a bot, which gets the normal
  // reply so it learns nothing.
  if (typeof body.website === 'string' && body.website !== '') return { ok: true }

  const email = normaliseEmail(body.email)
  if (!email) throw refuse(400, 'bad_email')

  const secret = env.TURNSTILE_SECRET
    ? await env.TURNSTILE_SECRET.get()
    : import.meta.dev
      ? DEV_TURNSTILE_SECRET
      : ''
  if (!secret) throw refuse(503, 'unavailable')
  if (typeof body.turnstile !== 'string' || !(await turnstileOk(secret, body.turnstile, ip)))
    throw refuse(400, 'bot_check')

  // `nuxt dev` has no binding: accept the form so the page can be worked on, and store nothing.
  if (!env.LISTS) {
    if (import.meta.dev) return { ok: true }
    throw refuse(503, 'unavailable')
  }
  try {
    await env.LISTS.subscribe({ list: 'newsletter', email, consentVersion: CONSENT_VERSION })
  } catch {
    throw refuse(503, 'unavailable')
  }
  return { ok: true }
})

async function turnstileOk(secret: string, response: string, ip: string): Promise<boolean> {
  if (!response || response.length > 2048) return false
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', response)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  }).catch(() => null)
  if (!res?.ok) return false
  const outcome = (await res.json().catch(() => null)) as { success?: boolean } | null
  return outcome?.success === true
}
