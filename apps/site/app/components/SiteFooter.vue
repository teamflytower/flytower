<script setup lang="ts">
const site = useAppConfig().site
const columns = [
  {
    label: 'Flytower',
    children: [
      { label: 'Docs', to: '/docs' },
      { label: 'Install', to: '/docs/install' },
      { label: 'Changelog', to: '/changelog' },
      { label: 'FAQ', to: '/faq' },
      { label: 'Why Flytower?', to: '/why-flytower' },
    ],
  },
  {
    label: 'Community',
    children: [
      { label: 'GitHub', to: site.repo, target: '_blank' },
      ...(site.discord ? [{ label: 'Discord', to: site.discord, target: '_blank' }] : []),
      { label: 'Sponsor', to: '/sponsor' },
      { label: 'Advertise', to: '/advertise' },
    ],
  },
  {
    label: 'Legal',
    children: [
      { label: 'Privacy', to: '/legal/privacy' },
      { label: 'Terms', to: '/legal/terms' },
      { label: 'Sponsorship terms', to: '/legal/sponsorship' },
      { label: 'Advertising policy', to: '/legal/advertising' },
      { label: 'Accessibility', to: '/legal/accessibility' },
      { label: 'Minecraft notice', to: '/legal/minecraft' },
    ],
  },
]
</script>

<template>
  <USeparator class="h-px" />
  <UFooter
    :ui="{
      top: 'border-b border-default',
      container:
        'flex flex-col items-center gap-4 py-8 text-center text-sm text-muted xl:flex-row xl:justify-between xl:gap-8 xl:py-4 xl:text-left',
      left: 'order-1 mt-0',
      center: 'hidden',
      right: 'order-2',
    }"
  >
    <template #top>
      <UContainer>
        <UFooterColumns
          :columns="columns"
          :ui="{
            root: 'xl:gap-16',
            center:
              'grid grid-flow-row grid-cols-1 gap-8 text-center sm:grid-cols-3 sm:text-left xl:col-span-2 xl:flex xl:flex-row xl:justify-end xl:gap-24',
            list: 'mt-4 space-y-3 sm:mt-6 sm:space-y-4',
            link: 'justify-center sm:justify-start',
          }"
        >
          <template #left>
            <NewsletterSignup />
          </template>
        </UFooterColumns>
      </UContainer>
    </template>

    <template #left>
      <p>
        Flytower is free software under the
        <ULink :to="`${site.repo}/blob/main/LICENSE`" target="_blank" class="underline"
          >AGPL-3.0</ULink
        >.
      </p>
    </template>

    <template #right>
      <ULink to="/legal/minecraft" class="hover:text-default">
        Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
      </ULink>
    </template>
  </UFooter>
</template>
