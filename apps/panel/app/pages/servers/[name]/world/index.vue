<script setup lang="ts">
import type { CollapsibleSection } from '~/components/CollapsibleSections.vue'

const { server } = useServerContext()

const sections = computed<CollapsibleSection[]>(() => [
  {
    id: 'backups',
    doc: 'world.backups',
    label: 'Backups',
    icon: 'i-lucide-archive',
    description: 'Copies of the world, on a schedule or by hand',
    need: {
      permission: 'backups.create',
      text: 'You can see the backups but not take or manage them.',
    },
  },
  {
    id: 'map',
    label: 'Web map',
    icon: 'i-lucide-map',
    description: 'A map of the world in the browser',
    summary: server.value ? (server.value.map?.enabled ? 'On' : 'Off') : null,
    need: { permission: 'world.manage', text: 'You can see the map but not change it.' },
  },
  {
    id: 'past',
    label: 'Past worlds',
    icon: 'i-lucide-history',
    description: 'Worlds kept after a reset, and downloads',
    need: { permission: 'world.manage', text: 'You can see past worlds but not change them.' },
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: 'i-lucide-hammer',
    description: 'Pre-generate, copy, reset or trim the world',
    need: { permission: 'world.manage', text: 'You can see the world but not change it.' },
  },
])
</script>

<template>
  <CollapsibleSections
    v-if="server"
    :sections="sections"
    storage-key="world"
    :default-open="['backups']"
  >
    <template #backups>
      <ServerBackups />
    </template>
    <template #map>
      <WorldMap />
    </template>
    <template #past>
      <div class="space-y-6">
        <WorldPastWorlds :server="server.name" />
        <WorldExports :server="server.name" />
      </div>
    </template>
    <template #tools>
      <div class="space-y-6">
        <WorldPregen />
        <WorldCopy />
        <WorldTrim />
        <WorldReset />
      </div>
    </template>
  </CollapsibleSections>
</template>
