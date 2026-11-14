<script setup lang="ts">
const site = useAppConfig().site
useSeoMeta({ title: site.name, description: site.tagline })

const comparison = [
  {
    row: 'Where the world lives',
    ours: 'On a machine you rent and control',
    hosted: "On the host's machines",
  },
  {
    row: 'Several servers',
    ours: 'As many as the box can run',
    hosted: 'Usually one plan per server',
  },
  {
    row: 'Leaving',
    ours: 'Stop using Flytower; your servers keep running',
    hosted: 'Download your world and start again',
  },
  {
    row: 'Who does the admin',
    ours: 'You, with a panel that makes it easy',
    hosted: 'The host',
  },
]
</script>

<template>
  <div class="overflow-x-clip">
    <section
      class="border-b border-default bg-[radial-gradient(ellipse_55%_70%_at_85%_10%,color-mix(in_oklab,var(--ui-primary)_10%,transparent),transparent_70%)]"
    >
      <UContainer
        class="grid items-center gap-12 pt-16 lg:gap-16 pb-20 sm:pt-20 lg:grid-cols-[1fr_1.15fr] lg:pb-28"
      >
        <div class="flex min-w-0 flex-col gap-6">
          <ULink
            :to="site.announcement.to"
            class="inline-flex items-center gap-2 self-start rounded-full border border-accented px-3.5 py-1 text-sm text-toned hover:border-primary"
          >
            <span class="font-semibold text-primary">{{ site.announcement.label }}</span>
            {{ site.announcement.text }}
            <UIcon name="i-lucide-arrow-right" class="size-4" />
          </ULink>
          <h1 class="font-display text-5xl leading-[0.95] uppercase sm:text-7xl xl:text-[96px]">
            A <span class="text-primary">new kind</span> of Minecraft panel
          </h1>
          <p class="max-w-xl text-lg text-muted sm:text-xl">
            A free, self-hosted panel. Install it once, sign in with a passkey, and run vanilla,
            Fabric and Paper servers without touching SSH.
          </p>
          <div class="flex flex-col gap-2">
            <InstallCommand class="max-w-xl" />
            <p class="text-sm text-muted">
              Ubuntu 24.04+ or Debian 12+, amd64 or arm64, and a domain.
              <ULink to="/docs/install" class="text-primary">Installer options</ULink>
            </p>
          </div>
          <div class="flex flex-wrap gap-3">
            <UButton to="/docs/install" size="xl">Read the install guide</UButton>
            <UButton to="#tour" size="xl" color="neutral" variant="outline">Take the tour</UButton>
          </div>
        </div>

        <div class="relative min-w-0 pr-3 pb-20 sm:pr-6 sm:pb-28">
          <div
            class="overflow-hidden rounded-xl border border-accented bg-default shadow-[0_40px_120px_rgba(0,0,0,0.45)]"
          >
            <div
              class="flex h-8 items-center gap-1.5 border-b border-default bg-elevated px-3.5"
              aria-hidden="true"
            >
              <span class="size-2.5 rounded-full bg-accented" />
              <span class="size-2.5 rounded-full bg-accented" />
              <span class="size-2.5 rounded-full bg-accented" />
              <span class="mx-auto font-mono text-[11px] text-dimmed">panel.example.com</span>
            </div>
            <img
              src="/home/servers-dark.webp"
              alt="Flytower's server list, with Survival and Creative running and Events stopped"
              width="1440"
              height="900"
              class="block h-auto w-full"
              fetchpriority="high"
            />
          </div>
          <div
            class="absolute right-0 bottom-0 w-[56%] overflow-hidden rounded-xl border border-accented shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
          >
            <img
              src="/home/console-dark.webp"
              alt="Survival's console, with players joining and chatting"
              width="1440"
              height="900"
              class="block h-auto w-full"
            />
          </div>
        </div>
      </UContainer>
    </section>

    <HomeTour />

    <section class="border-y border-default bg-elevated/50 py-20 sm:py-24">
      <UContainer>
        <h2 class="font-display text-4xl uppercase sm:text-5xl">Your own box, or a hosted plan?</h2>
        <p class="mt-3 max-w-2xl text-lg text-muted">
          Both are good choices. Here's what changes when the machine is yours.
        </p>
        <div class="mt-8 overflow-x-auto rounded-md border border-default">
          <table class="w-full min-w-[640px] border-collapse text-[15px]">
            <thead>
              <tr class="bg-elevated text-left">
                <td class="px-4 py-3.5" />
                <th scope="col" class="px-4 py-3.5 font-semibold text-primary">
                  Flytower on your VPS
                </th>
                <th scope="col" class="px-4 py-3.5 font-medium text-muted">
                  A typical hosted plan
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in comparison" :key="r.row" class="border-t border-default">
                <th scope="row" class="px-4 py-3.5 text-left font-medium">{{ r.row }}</th>
                <td class="px-4 py-3.5">{{ r.ours }}</td>
                <td class="px-4 py-3.5 text-muted">{{ r.hosted }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UContainer>
    </section>

    <UPageSection>
      <UPageCTA
        title="Why “Flytower”?"
        description="A fly tower is the space above a stage where scenery hangs, ready to fly in on cue. Flytower does the same for servers: several hang in one box, and you bring each one in when it's needed."
        :links="[
          {
            label: 'Read the story',
            to: '/why-flytower',
            trailingIcon: 'i-lucide-arrow-right',
            color: 'neutral',
            variant: 'subtle',
          },
        ]"
        variant="soft"
      />
    </UPageSection>

    <UPageSection
      id="sponsors"
      title="Sponsors"
      description="Flytower is free. Sponsors pay for the time it takes to build and look after it."
    >
      <div class="flex flex-col items-center gap-8">
        <ul class="grid w-full max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
          <li v-for="n in 3" :key="n">
            <ULink
              to="/sponsor"
              class="flex h-24 items-center justify-center rounded-lg border border-dashed border-accented text-[15px] text-dimmed hover:border-primary hover:text-highlighted"
              >Your logo here</ULink
            >
          </li>
        </ul>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <UButton to="/sponsor" icon="i-lucide-heart" color="neutral" variant="outline" size="lg"
            >Become a sponsor</UButton
          >
          <UButton
            :to="site.sponsors + '?frequency=one-time'"
            target="_blank"
            color="neutral"
            variant="link"
            size="lg"
            >or make a one-off donation</UButton
          >
        </div>
      </div>
    </UPageSection>
  </div>
</template>
