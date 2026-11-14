<script setup lang="ts">
/**
 * Where the disk has gone: one bar split by server, then the rest of the machine in parts,
 * then free space, and a table of each server's share and each part. Figures come from the
 * background walk. Parts that can be cleaned up have a button for it.
 */
import {
  CLEAN_UPS,
  DISK_GROUPS,
  DISK_URGENT,
  DISK_WARN,
  SYSTEM_PARTS,
  biggestWorld,
  type CleanUp,
  type SystemPart,
} from '~~/shared/disk'

const { data, refresh } = useDiskStatus()
const toast = useToast()

/** Servers get the first six colours in a fixed order; any more share the seventh. */
const SLOTS = 6
const MB = 1024 * 1024

const servers = computed(() => [...(data.value?.servers ?? [])].sort((a, b) => b.bytes - a.bytes))

interface Segment {
  key: string
  label: string
  bytes: number
  swatch: string
}

const segments = computed<Segment[]>(() => {
  const d = data.value
  if (!d?.totalMb || d.usedMb == null) return []
  // Colour follows the server (alphabetical), not its rank, so it doesn't change as sizes do.
  const alpha = [...servers.value].map((s) => s.server).sort()
  const shown = servers.value.filter((s) => alpha.indexOf(s.server) < SLOTS)
  const rest = servers.value.filter((s) => alpha.indexOf(s.server) >= SLOTS)
  const out: Segment[] = shown.map((s) => ({
    key: s.server,
    label: s.displayName,
    bytes: s.bytes,
    swatch: `disk-s${alpha.indexOf(s.server) + 1}`,
  }))
  if (rest.length) {
    out.push({
      key: '+others',
      label: `${rest.length} more servers`,
      bytes: rest.reduce((a, s) => a + s.bytes, 0),
      swatch: 'disk-s7',
    })
  }
  const shared = (d.shared?.imports ?? 0) + (d.shared?.archive ?? 0)
  if (shared > 0) {
    out.push({
      key: '+shared',
      label: 'Imports and archives',
      bytes: shared,
      swatch: 'disk-shared',
    })
  }
  for (const p of parts.value) {
    if (p.key === 'os') continue
    out.push({ key: `+${p.key}`, label: p.label, bytes: p.bytes, swatch: p.swatch })
  }
  const counted = out.reduce((a, s) => a + s.bytes, 0)
  out.push({
    key: '+system',
    label: d.system ? 'Operating system and everything else' : 'System and other files',
    bytes: Math.max(0, d.usedMb * MB - counted),
    swatch: 'disk-system',
  })
  return out
})

interface Part {
  key: SystemPart | 'os'
  label: string
  bytes: number
  swatch: string
  cleanUp: CleanUp | null
}

/** The rest of the machine, in parts, when the agent could measure it. */
const parts = computed<Part[]>(() => {
  const d = data.value
  if (!d?.system) return []
  const keys = Object.keys(SYSTEM_PARTS) as SystemPart[]
  const out: Part[] = keys.map((key, i) => ({
    key,
    label: SYSTEM_PARTS[key],
    bytes: d.system![key],
    swatch: `disk-n${i + 1}`,
    cleanUp:
      (Object.entries(CLEAN_UPS) as [CleanUp, { part: SystemPart }][]).find(
        ([, c]) => c.part === key,
      )?.[0] ?? null,
  }))
  if (d.usedMb != null) {
    const servers = (d.servers ?? []).reduce((a, s) => a + s.bytes, 0)
    const shared = (d.shared?.imports ?? 0) + (d.shared?.archive ?? 0)
    const known = out.reduce((a, p) => a + p.bytes, 0)
    out.push({
      key: 'os',
      label: 'Operating system and everything else',
      bytes: Math.max(0, d.usedMb * MB - servers - shared - known),
      swatch: 'disk-system',
      cleanUp: null,
    })
  }
  return out
})

/** What a part's clean-up would free, to show beside its button. */
const freeable = (c: CleanUp) => {
  const s = data.value?.system
  if (!s) return 0
  return c === 'journal' ? s.journal : c === 'apt' ? s.aptCache : s.oldReleases
}

const cleaning = ref<CleanUp | null>(null)
const cleanOpen = computed({
  get: () => cleaning.value !== null,
  set: (v) => {
    if (!v) cleaning.value = null
  },
})
const can = useCan()
const canManage = computed(() => can('system.updates'))

/** When a world is the biggest thing on the disk, trimming it is the best place to start. */
const trimTip = computed(() => {
  const big = data.value ? biggestWorld(data.value) : null
  if (!big || !can('world.manage', big.server)) return null
  const s = servers.value.find((x) => x.server === big.server)
  return { ...big, displayName: s?.displayName ?? big.server }
})

const totalBytes = computed(() => (data.value?.totalMb ?? 0) * MB)
const width = (bytes: number) =>
  totalBytes.value ? `${Math.max(0.5, (bytes / totalBytes.value) * 100)}%` : '0%'
const free = computed(() =>
  data.value?.totalMb != null && data.value.usedMb != null
    ? humanMb(data.value.totalMb - data.value.usedMb)
    : null,
)

const color = computed(() =>
  data.value?.level === 'urgent'
    ? 'error'
    : data.value?.level === 'warning'
      ? 'warning'
      : 'neutral',
)

const largest = (groups: Record<keyof typeof DISK_GROUPS, number>) => {
  const [g] = (Object.entries(groups) as [keyof typeof DISK_GROUPS, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  return g ? `${DISK_GROUPS[g[0]]}, ${humanBytes(g[1])}` : '—'
}

/** The panel re-measures after a clean-up; reload once that's had a moment. */
async function refreshAfterCleanUp() {
  await refresh()
  setTimeout(() => void refresh(), 3000)
}

const measuring = ref(false)
async function measureNow() {
  measuring.value = true
  try {
    await $fetch('/api/system/disk/refresh', { method: 'POST' })
    await refresh()
  } catch (err) {
    toast.add({
      title: "Couldn't measure the disk",
      description: errorMessage(err),
      color: 'error',
    })
  } finally {
    measuring.value = false
  }
}
</script>

<template>
  <div v-if="data" class="space-y-4" data-e2e="disk-use">
    <div class="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span class="font-medium">Disk</span>
      <span v-if="data.percent !== null" class="text-muted tabular-nums">
        {{ humanMb(data.usedMb!) }} of {{ humanMb(data.totalMb!) }} used ·
        <span :class="{ 'text-warning': color === 'warning', 'text-error': color === 'error' }">
          {{ Math.round(data.percent) }}% full, {{ free }} free
        </span>
      </span>
      <span v-else class="text-muted">Waiting for the first reading…</span>
    </div>

    <div
      v-if="segments.length"
      class="flex h-4 w-full gap-0.5 overflow-hidden rounded-full bg-elevated"
      role="img"
      :aria-label="`Disk ${Math.round(data.percent ?? 0)}% full`"
    >
      <UTooltip
        v-for="s in segments"
        :key="s.key"
        :text="`${s.label}: ${humanBytes(s.bytes)}`"
        :content="{ side: 'top' }"
      >
        <div :class="['h-full shrink-0', s.swatch]" :style="{ width: width(s.bytes) }" />
      </UTooltip>
    </div>

    <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <li v-for="s in segments" :key="s.key" class="flex items-center gap-1.5">
        <span :class="['size-2.5 rounded-sm', s.swatch]" />
        {{ s.label }} <span class="tabular-nums">{{ humanBytes(s.bytes) }}</span>
      </li>
      <li v-if="free" class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-sm bg-elevated ring-1 ring-default" />
        Free <span class="tabular-nums">{{ free }}</span>
      </li>
    </ul>

    <UAlert
      v-if="data.level !== 'ok'"
      :color="color === 'error' ? 'error' : 'warning'"
      variant="subtle"
      icon="i-lucide-hard-drive"
      :title="
        data.level === 'urgent'
          ? `Over ${DISK_URGENT}%: scheduled backups are paused`
          : `Over ${DISK_WARN}%: time to free up some space`
      "
      description="Old backups and world exports are the usual culprits. Lower how many backups each server keeps, or delete exports you've downloaded."
    />

    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted">
          <tr>
            <th class="py-1.5 pe-4 font-medium">Server</th>
            <th class="py-1.5 pe-4 text-right font-medium">Size</th>
            <th class="hidden py-1.5 pe-4 font-medium sm:table-cell">Largest part</th>
            <th class="py-1.5 font-medium"><span class="sr-only">Links</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="s in servers" :key="s.server">
            <td class="py-1.5 pe-4">{{ s.displayName }}</td>
            <td class="py-1.5 pe-4 text-right whitespace-nowrap tabular-nums">
              {{ humanBytes(s.bytes) }}
            </td>
            <td class="hidden py-1.5 pe-4 text-muted sm:table-cell">
              {{ largest(s.groups) }}
              <UTooltip v-if="s.unreadable" text="Some files couldn't be read, so this is a floor">
                <UIcon name="i-lucide-circle-alert" class="ms-1 align-middle text-warning" />
              </UTooltip>
            </td>
            <td class="py-1.5 text-right whitespace-nowrap">
              <UButton
                :to="`/servers/${s.server}/settings#maintenance`"
                label="Details"
                size="xs"
                color="neutral"
                variant="ghost"
              />
              <UButton
                :to="`/servers/${s.server}/world#backups`"
                label="Backups"
                size="xs"
                color="neutral"
                variant="ghost"
              />
            </td>
          </tr>
          <tr v-if="data.shared && data.shared.imports + data.shared.archive > 0">
            <td class="py-1.5 pe-4">Imports and archives</td>
            <td class="py-1.5 pe-4 text-right whitespace-nowrap tabular-nums">
              {{ humanBytes(data.shared.imports + data.shared.archive) }}
            </td>
            <td class="hidden py-1.5 pe-4 text-muted sm:table-cell" colspan="2">
              Uploads waiting to be imported, and deleted servers kept so they can be restored
            </td>
          </tr>
          <tr v-if="parts.length">
            <th colspan="4" class="pt-4 pb-1.5 text-left text-xs font-medium text-muted">
              The rest of the machine
            </th>
          </tr>
          <tr v-for="p in parts" :key="p.key" data-e2e="disk-part">
            <td class="py-1.5 pe-4">
              <span class="flex items-center gap-1.5">
                <span :class="['size-2.5 shrink-0 rounded-sm', p.swatch]" />
                {{ p.label }}
              </span>
            </td>
            <td class="py-1.5 pe-4 text-right whitespace-nowrap tabular-nums">
              {{ humanBytes(p.bytes) }}
            </td>
            <td class="hidden py-1.5 pe-4 text-muted sm:table-cell">
              <template v-if="p.cleanUp && freeable(p.cleanUp) > 0">
                {{
                  p.cleanUp === 'journal'
                    ? `The journal uses ${humanBytes(freeable(p.cleanUp))}`
                    : `${humanBytes(freeable(p.cleanUp))} can be freed`
                }}
              </template>
            </td>
            <td class="py-1.5 text-right whitespace-nowrap">
              <UButton
                v-if="p.cleanUp && canManage"
                label="Clean up"
                icon="i-lucide-brush-cleaning"
                size="xs"
                color="neutral"
                variant="ghost"
                :data-e2e="`clean-up-${p.cleanUp}`"
                @click="cleaning = p.cleanUp"
              />
            </td>
          </tr>
          <tr v-if="!servers.length && !parts.length">
            <td colspan="4" class="py-3 text-center text-muted">
              {{ data.measuring ? 'Measuring…' : 'No servers measured yet.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="trimTip"
      class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default p-3 text-sm"
      data-e2e="disk-trim-tip"
    >
      <p class="max-w-xl text-muted">
        <span class="text-default">{{ trimTip.displayName }}'s world</span> is the biggest thing on
        this disk, at {{ humanBytes(trimTip.bytes) }}. Trimming chunks nobody has spent time in can
        make it smaller.
      </p>
      <UButton
        :to="`/servers/${trimTip.server}/world?trim#tools`"
        label="Trim unused chunks"
        icon="i-lucide-scissors"
        size="sm"
        color="neutral"
        variant="outline"
      />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span>
        {{
          data.measuredAt
            ? `Measured ${formatDateTime(data.measuredAt)}. Updated after backups, restores and imports, and every hour.`
            : 'Not measured yet.'
        }}
      </span>
      <UButton
        icon="i-lucide-refresh-cw"
        label="Measure now"
        data-doc="disk.measure-now"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="measuring || data.measuring"
        @click="measureNow"
      />
    </div>

    <DiskCleanUp
      v-if="cleaning && data.system"
      v-model:open="cleanOpen"
      :action="cleaning"
      :system="data.system"
      @done="refreshAfterCleanUp"
    />
  </div>
</template>

<style>
/* Categorical slots in a fixed order; dark mode uses its own steps of the same hues. */
.disk-s1 {
  background: #2a78d6;
}
.disk-s2 {
  background: #1baf7a;
}
.disk-s3 {
  background: #e87ba4;
}
.disk-s4 {
  background: #6250d6;
}
.disk-s5 {
  background: #eb6834;
}
.disk-s6 {
  background: #008300;
}
.disk-s7 {
  background: #eda100;
}
.disk-shared {
  background: var(--ui-text-dimmed);
}
.disk-system {
  background: var(--ui-text-muted);
}
/* The rest of the machine: neutral steps, so servers keep the colours. */
.disk-n1 {
  background: color-mix(in oklab, var(--ui-text-muted) 82%, transparent);
}
.disk-n2 {
  background: color-mix(in oklab, var(--ui-text-muted) 64%, transparent);
}
.disk-n3 {
  background: color-mix(in oklab, var(--ui-text-muted) 48%, transparent);
}
.disk-n4 {
  background: color-mix(in oklab, var(--ui-text-muted) 34%, transparent);
}
.dark .disk-s1 {
  background: #3987e5;
}
.dark .disk-s2 {
  background: #199e70;
}
.dark .disk-s3 {
  background: #d55181;
}
.dark .disk-s4 {
  background: #9085e9;
}
.dark .disk-s5 {
  background: #d95926;
}
.dark .disk-s7 {
  background: #c98500;
}
</style>
