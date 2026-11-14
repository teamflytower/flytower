<script setup lang="ts">
const site = useAppConfig().site
const route = useRoute()
const items = computed(() => [
  { label: 'Docs', to: '/docs', active: route.path.startsWith('/docs') },
  { label: 'FAQ', to: '/faq' },
  { label: 'Changelog', to: '/changelog' },
  { label: 'Why Flytower?', to: '/why-flytower' },
  { label: 'Sponsor', to: '/sponsor' },
])
</script>

<template>
  <UHeader :to="'/'" :title="site.name">
    <template #title>
      <span class="flex items-center gap-2">
        <img src="/flytower-mark.svg" alt="" class="size-7" />
        <span class="font-display text-2xl text-highlighted">Flytower</span>
      </span>
    </template>

    <UNavigationMenu :items="items" />

    <template #right>
      <UContentSearchButton :collapsed="true" />
      <UColorModeButton />
      <UButton
        v-if="site.discord"
        :to="site.discord"
        target="_blank"
        icon="i-simple-icons-discord"
        color="neutral"
        variant="ghost"
        aria-label="Discord"
      />
      <UButton
        :to="site.repo"
        target="_blank"
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
        aria-label="GitHub"
      />
    </template>

    <template #body>
      <UNavigationMenu :items="items" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
