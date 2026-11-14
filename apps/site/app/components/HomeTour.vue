<script setup lang="ts">
/**
 * The home page tour: a row of tabs, each showing one real panel screen. The screens come from
 * the docs screenshots (docs/screens/, served at /screens), in light and dark to match the site.
 */
interface Stop {
  id: string
  label: string
  title: string
  body: string
  link: { label: string; to: string }
  /** A docs screenshot name, shown in light or dark to match the site. */
  screen?: string
  /** A fixed picture instead, for screens the docs don't take. */
  src?: string
  alt: string
}

const stops: Stop[] = [
  {
    id: 'console',
    label: 'Console',
    title: 'Every server, live',
    body: 'Watch players join and chat as it happens, and type commands with suggestions as you go.',
    link: { label: 'Your first server', to: '/docs/first-server' },
    src: '/home/console-dark.webp',
    alt: "A server's console in Flytower, with players joining and chatting",
  },
  {
    id: 'create',
    label: 'New server',
    title: 'A new server in a minute',
    body: 'Choose vanilla, Fabric or Paper and a version, and Flytower fetches the rest. You can bring an old world with you, too.',
    link: { label: 'Your first server', to: '/docs/first-server' },
    screen: 'new-server',
    alt: 'The New server form',
  },
  {
    id: 'backups',
    label: 'Backups',
    title: 'Backups every night',
    body: 'Kept for as long as you choose, with a copy somewhere else if you want one. Restoring takes one click.',
    link: { label: 'Backups', to: '/docs/backups' },
    screen: 'backups',
    alt: "The Backups section of a server's World tab",
  },
  {
    id: 'schedules',
    label: 'Schedules',
    title: 'Restarts while you sleep',
    body: 'Players get a countdown in chat first. Commands and announcements can run on a timer too.',
    link: { label: 'Scheduled tasks', to: '/docs/schedules' },
    screen: 'schedules',
    alt: 'Scheduled tasks for a server',
  },
  {
    id: 'public',
    label: 'Public page',
    title: 'A page for your players',
    body: 'The address to join, whether the server is up, and who is playing right now.',
    link: { label: 'Public status page', to: '/docs/status-page' },
    screen: 'public-page',
    alt: 'Settings for the public status page',
  },
  {
    id: 'discord',
    label: 'Discord',
    title: 'Chat that reaches Discord',
    body: 'Messages go both ways between a Discord channel and the game, and /status works in your Discord server.',
    link: { label: 'Discord', to: '/docs/discord' },
    screen: 'discord-chat',
    alt: 'Settings for Discord chat',
  },
  {
    id: 'people',
    label: 'People',
    title: 'Share the running of it',
    body: 'Invite friends to help, with only the access they need, on one server or all of them.',
    link: { label: 'People and roles', to: '/docs/people' },
    screen: 'people',
    alt: 'The Access page, with people and their roles',
  },
]

const extras = [
  {
    title: 'Mods and datapacks',
    body: 'From Modrinth, Hangar or Vanilla Tweaks, or upload your own.',
  },
  {
    title: 'Crash recovery',
    body: 'A crashed server restarts on its own, and stops trying if it keeps crashing.',
  },
  {
    title: 'Notifications',
    body: 'Hear about crashes, failed backups and a full disk on Discord or your phone.',
  },
  { title: 'Web map', body: 'Look around your world in the browser, with players shown on it.' },
  {
    title: 'Player stats',
    body: 'Leaderboards for playtime, distance and more. Anyone can ask to be left out.',
  },
  {
    title: 'Your own branding',
    body: 'Your name, colour and logo on the panel, the sign-in page and Discord.',
  },
  {
    title: 'Performance history',
    body: 'A week of CPU, memory, players and tick time for each server.',
  },
  { title: 'Safe updates', body: 'Every update is signed and checked, and undone if it fails.' },
]

const active = ref(0)
const current = computed(() => stops[active.value]!)
const tabs = ref<HTMLButtonElement[]>([])

/** Arrow keys, Home and End move between tabs, as the ARIA tabs pattern expects. */
function onKey(e: KeyboardEvent) {
  const last = stops.length - 1
  const next =
    e.key === 'ArrowRight'
      ? (active.value + 1) % stops.length
      : e.key === 'ArrowLeft'
        ? (active.value - 1 + stops.length) % stops.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? last
            : null
  if (next === null) return
  e.preventDefault()
  active.value = next
  tabs.value[next]?.focus()
}
</script>

<template>
  <section id="tour" class="scroll-mt-20 py-20 sm:py-28">
    <UContainer>
      <div class="mx-auto max-w-2xl text-center">
        <h2 class="font-display text-4xl uppercase sm:text-6xl">Take the tour</h2>
        <p class="mt-3 text-lg text-muted">
          Here's what running your servers looks like day to day.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Features"
        class="-mx-4 mt-8 flex gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0"
        @keydown="onKey"
      >
        <button
          v-for="(s, i) in stops"
          :id="`tour-tab-${s.id}`"
          :key="s.id"
          ref="tabs"
          type="button"
          role="tab"
          :aria-selected="i === active"
          :aria-controls="`tour-panel`"
          :tabindex="i === active ? 0 : -1"
          class="min-h-11 shrink-0 cursor-pointer rounded-full border px-4 text-[15px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :class="
            i === active
              ? 'border-primary bg-primary font-semibold text-inverted'
              : 'border-accented text-toned hover:border-primary hover:text-highlighted'
          "
          @click="active = i"
        >
          {{ s.label }}
        </button>
      </div>

      <div
        id="tour-panel"
        role="tabpanel"
        :aria-labelledby="`tour-tab-${current.id}`"
        class="mt-8 grid items-center gap-8 lg:mt-10 lg:grid-cols-[1fr_2fr] lg:gap-10"
      >
        <div class="order-2 flex flex-col gap-3 lg:order-1">
          <h3 class="font-display text-3xl uppercase sm:text-4xl">{{ current.title }}</h3>
          <p class="text-lg text-muted">{{ current.body }}</p>
          <ULink :to="current.link.to" class="text-primary hover:underline"
            >{{ current.link.label }} →</ULink
          >
        </div>
        <div class="order-1 lg:order-2">
          <img
            v-if="current.src"
            :src="current.src"
            :alt="current.alt"
            class="w-full rounded-lg border border-default shadow-2xl"
            loading="lazy"
          />
          <template v-else>
            <img
              :src="`/screens/${current.screen}-light.webp`"
              :alt="current.alt"
              class="w-full rounded-lg border border-default shadow-2xl dark:hidden"
              loading="lazy"
            />
            <img
              :src="`/screens/${current.screen}-dark.webp`"
              :alt="current.alt"
              class="hidden w-full rounded-lg border border-default shadow-2xl dark:block"
              loading="lazy"
            />
          </template>
        </div>
      </div>
    </UContainer>

    <!-- Always eight cards, so the grid has no gaps: 1 column, then 2, 4 and finally 8 across. -->
    <div
      class="mx-auto mt-20 w-full max-w-(--ui-container) px-4 sm:mt-24 sm:px-6 lg:px-8 3xl:max-w-[1600px]"
    >
      <h3 class="font-display text-3xl uppercase sm:text-4xl">Also included</h3>
      <p class="mt-2 text-muted">Nothing to buy and nothing extra to install.</p>
      <ul
        class="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-default bg-(--ui-border) sm:grid-cols-2 lg:grid-cols-4 3xl:grid-cols-8"
      >
        <li v-for="x in extras" :key="x.title" class="bg-elevated p-5">
          <h4 class="font-semibold text-highlighted">{{ x.title }}</h4>
          <p class="mt-1 text-[15px] leading-6 text-muted">{{ x.body }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
