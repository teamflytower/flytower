<script setup lang="ts">
import { can, type InstallPermission } from '#shared/permissions'
import { systemUpdateCount } from '#shared/updates'

const updates = useLiveUpdates()
const { state } = useAuthState()
const allowed = (p: InstallPermission) => (state.value?.access ? can(state.value.access, p) : false)
/** System is split into sections, so health, updates, storage, alerts, integrations, branding and SSH each get a page. */
interface Section {
  label: string
  icon: string
  to: string
  exact?: boolean
  badge?: { label: string; color: 'info'; variant: 'subtle' }
  /** Who sees it; the overview is for everyone. */
  permission?: InstallPermission
}
const sections = computed<Section[]>(() => [
  { label: 'Overview', icon: 'i-lucide-gauge', to: '/system', exact: true },
  ...systemSections.value.filter((s) => s.permission && allowed(s.permission)),
])
/** Install-wide pages, each for people with its permission. */
const systemSections = computed<Section[]>(() => [
  {
    label: 'Updates',
    icon: 'i-lucide-arrow-up-circle',
    to: '/system/updates',
    permission: 'system.updates',
    ...(systemUpdateCount(updates.value)
      ? {
          badge: {
            label: String(systemUpdateCount(updates.value)),
            color: 'info' as const,
            variant: 'subtle' as const,
          },
        }
      : {}),
  },
  {
    label: 'Off-site storage',
    icon: 'i-lucide-cloud',
    to: '/system/storage',
    permission: 'system.integrations',
  },
  {
    label: 'Notifications',
    icon: 'i-lucide-bell',
    to: '/system/notifications',
    permission: 'system.notifications',
  },
  {
    label: 'Integrations',
    icon: 'i-lucide-blocks',
    to: '/system/integrations',
    permission: 'system.integrations',
  },
  {
    label: 'Branding',
    icon: 'i-lucide-palette',
    to: '/system/branding',
    permission: 'system.branding',
  },
  {
    label: 'Addresses',
    icon: 'i-lucide-route',
    to: '/system/addresses',
    permission: 'system.network',
  },
  {
    label: 'SSH',
    icon: 'i-lucide-terminal-square',
    to: '/system/ssh',
    permission: 'system.ssh',
  },
])
const route = useRoute()
const current = computed(
  () =>
    [...sections.value]
      .reverse()
      .find((s) => (s.exact ? route.path === s.to : route.path.startsWith(s.to))) ??
    sections.value[0]!,
)
const menu = computed(() => [
  sections.value.map((s) => ({ ...s, type: 'link' as const, active: s.to === current.value.to })),
])
</script>

<template>
  <UDashboardPanel id="system">
    <template #header>
      <UDashboardNavbar title="System">
        <template #right><HelpButton /></template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <UNavigationMenu :items="sections" highlight class="-mx-1 hidden flex-1 lg:flex" />
        <UDropdownMenu :items="menu" :content="{ align: 'start' }" class="lg:hidden">
          <UButton
            :label="current.label"
            :icon="current.icon"
            trailing-icon="i-lucide-chevron-down"
            color="neutral"
            variant="ghost"
            class="-mx-2.5 my-1"
          />
        </UDropdownMenu>
      </UDashboardToolbar>
    </template>
    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <NuxtPage />
      </div>
    </template>
  </UDashboardPanel>
</template>
