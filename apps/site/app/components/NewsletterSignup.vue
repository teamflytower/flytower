<script setup lang="ts">
// The mailing list sign-up in the footer. The address is stored as unconfirmed and a confirmation
// email goes out (see server/api/newsletter). Closed (shown but disabled) unless `newsletterOpen` is set.
import { CONSENT, CONSENT_VERSION } from '~~/server/utils/newsletter'

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, options: Record<string, unknown>): string
      reset(id: string): void
    }
  }
}

const config = useRuntimeConfig().public
const open = config.newsletterOpen
// Cloudflare's always-pass test key in dev, so the form works on localhost.
const siteKey = import.meta.dev ? '1x00000000000000000000AA' : config.turnstileSiteKey

const email = ref('')
const website = ref('') // honeypot: hidden from people, bots fill it in
const token = ref('')
const state = ref<'idle' | 'sending' | 'done' | 'error'>('idle')
const error = ref('')
const widget = useTemplateRef<HTMLElement>('widget')
let widgetId = ''
let loading: Promise<void> | undefined
let waiting = false

// Turnstile only loads once someone starts to sign up, so most visitors never fetch it.
function loadTurnstile() {
  if (!open || loading) return
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('turnstile'))
    document.head.append(script)
  }).then(() => {
    if (!widget.value || !window.turnstile) return
    widgetId = window.turnstile.render(widget.value, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      callback: (t: string) => {
        token.value = t
        // Someone who pressed Subscribe and then had to tick the box doesn't press it twice.
        if (waiting) subscribe()
      },
      'expired-callback': () => (token.value = ''),
    })
  })
  loading.catch(() => {
    loading = undefined
  })
}

function tokenWithin(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    const stop = watch(token, (t) => t && done())
    function done() {
      clearTimeout(timer)
      stop()
      resolve()
    }
  })
}

const messages: Record<string, string> = {
  bad_email: 'That doesn’t look like an email address.',
  bot_check: 'We couldn’t check you’re not a bot. Please try again.',
  slow_down: 'Too many tries. Please wait a minute and try again.',
}

async function subscribe() {
  if (!open || state.value === 'sending') return
  error.value = ''
  loadTurnstile()
  await loading?.catch(() => {})
  // The invisible check usually finishes within a second or two of loading.
  if (!token.value) await tokenWithin(4000)
  if (!token.value) {
    // Turnstile wants a tick; its callback sends the form once that's done.
    waiting = true
    error.value = 'Please tick the box above to finish signing up.'
    return
  }
  waiting = false
  state.value = 'sending'
  try {
    await $fetch('/api/newsletter/subscribe', {
      method: 'POST',
      body: { email: email.value, website: website.value, turnstile: token.value },
    })
    state.value = 'done'
  } catch (e) {
    const code = (e as { data?: { data?: { code?: string } } }).data?.data?.code ?? ''
    state.value = 'error'
    error.value = messages[code] ?? 'Something went wrong. Please try again later.'
    token.value = ''
    if (widgetId) window.turnstile?.reset(widgetId)
  }
}
</script>

<template>
  <section aria-labelledby="newsletter-heading" class="max-w-sm">
    <h2 id="newsletter-heading" class="text-sm font-semibold">Mailing list</h2>
    <p class="mt-2 text-sm text-muted">{{ CONSENT[CONSENT_VERSION] }}</p>

    <p v-if="state === 'done'" class="mt-4 text-sm" role="status">
      Thanks. Check your email for a link to confirm your sign-up.
    </p>

    <form v-else class="mt-4" novalidate @submit.prevent="subscribe">
      <div class="flex gap-2">
        <label for="newsletter-email" class="sr-only">Email address</label>
        <UInput
          id="newsletter-email"
          v-model="email"
          type="email"
          name="email"
          autocomplete="email"
          placeholder="you@example.com"
          required
          maxlength="254"
          :disabled="!open"
          class="min-w-0 flex-1"
          @focus="loadTurnstile"
        />
        <UButton type="submit" label="Subscribe" :disabled="!open" :loading="state === 'sending'" />
      </div>
      <div class="absolute -left-[9999px]" aria-hidden="true">
        <label for="newsletter-website">Leave this empty</label>
        <input
          id="newsletter-website"
          v-model="website"
          type="text"
          name="website"
          tabindex="-1"
          autocomplete="off"
        />
      </div>
      <div ref="widget" class="mt-2 empty:hidden" />
      <p v-if="error" class="mt-2 text-xs text-error" role="alert">{{ error }}</p>
    </form>

    <p v-if="state !== 'done'" class="mt-3 text-xs text-dimmed">
      <template v-if="open">
        We only keep your email address. See the
        <ULink to="/legal/privacy" class="underline hover:text-default">privacy policy</ULink>.
      </template>
      <template v-else>Sign-ups open soon.</template>
    </p>
  </section>
</template>
