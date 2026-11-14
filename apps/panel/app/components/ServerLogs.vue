<script setup lang="ts">
interface LogFile {
  name: string
  size: number
  modified: number
  live: boolean
}
interface LogView {
  lines: string[]
  total: number
  matched: number
  truncated: boolean
}

/**
 * Log files with search and download, and the Crashes list alongside them. Shown in the
 * Console's Logs pop-up; `selected` is the file being read, or "crashes".
 */
const model = defineModel<string>({ required: true })
const { server } = useServerContext()
const base = computed(() => `/api/servers/${server.value?.name}/logs`)

const { data: files, refresh: refreshList } = await useFetch<LogFile[]>(() => base.value, {
  default: () => [],
})

/** With nothing chosen, the newest log. */
const selected = computed({
  get: () => model.value || files.value[0]?.name || '',
  set: (v: string) => (model.value = v),
})
const search = ref('')
const query = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => (query.value = v), 250)
})

const {
  data: view,
  status,
  error,
  refresh,
} = await useFetch<LogView>(() => `${base.value}/view`, {
  query: computed(() => ({ name: selected.value, q: query.value })),
  immediate: !!selected.value && selected.value !== 'crashes',
  watch: [selected, query],
})

/** The Crashes list sits alongside the log files, as ?logs=crashes. */
const CRASHES = 'crashes'
const showCrashes = computed(() => selected.value === CRASHES)
const items = computed(() => [
  { label: 'Crashes', value: CRASHES },
  ...files.value.map((f) => ({
    label: f.live ? `${f.name} (live)` : f.name,
    value: f.name,
  })),
])

function size(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}
const when = (ms: number) => formatDateTime(ms)
const count = (n: number) => n.toLocaleString()

/** Splits a line around the search term so matches can be highlighted. */
function parts(line: string) {
  const q = query.value.trim()
  if (!q) return [{ text: line, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  const lower = line.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, i)) {
    if (at > i) out.push({ text: line.slice(i, at), hit: false })
    out.push({ text: line.slice(at, at + q.length), hit: true })
    i = at + q.length
  }
  if (i < line.length) out.push({ text: line.slice(i), hit: false })
  return out
}

const scroller = ref<HTMLElement | null>(null)
watch(view, async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})

/** Escape clears a search first, so it doesn't close the pop-up and lose it. */
function clearSearch(e: KeyboardEvent) {
  if (!search.value) return
  e.stopPropagation()
  search.value = ''
}

async function reload() {
  await Promise.all([refreshList(), refresh()])
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 md:flex-row">
    <aside class="md:w-64 md:shrink-0">
      <USelect v-model="selected" :items="items" class="w-full md:hidden" aria-label="Log file" />
      <ul class="hidden space-y-0.5 md:block" aria-label="Log files">
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-elevated"
            :class="showCrashes ? 'bg-elevated text-highlighted' : 'text-muted'"
            :aria-current="showCrashes ? 'true' : undefined"
            data-e2e="crashes-tab"
            @click="selected = CRASHES"
          >
            <UIcon name="i-lucide-octagon-alert" class="size-4" />
            Crashes
          </button>
        </li>
        <li v-for="f in files" :key="f.name">
          <button
            type="button"
            class="w-full rounded-md px-3 py-2 text-left hover:bg-elevated"
            :class="f.name === selected ? 'bg-elevated text-highlighted' : 'text-muted'"
            :aria-current="f.name === selected ? 'true' : undefined"
            @click="selected = f.name"
          >
            <span class="flex items-center gap-2 font-mono text-sm">
              <span class="truncate">{{ f.name }}</span>
              <UBadge v-if="f.live" label="live" size="sm" color="success" variant="subtle" />
            </span>
            <span class="block text-xs text-dimmed"
              >{{ size(f.size) }} · {{ when(f.modified) }}</span
            >
          </button>
        </li>
      </ul>
    </aside>

    <section class="flex min-h-[60vh] min-w-0 flex-1 flex-col gap-3 md:min-h-0">
      <ServerCrashes v-if="showCrashes" />
      <UEmpty
        v-else-if="files.length === 0"
        icon="i-lucide-scroll-text"
        title="No logs yet"
        description="Logs appear here once the server has run."
      />
      <template v-else>
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            placeholder="Search this log"
            aria-label="Search this log"
            class="min-w-48 flex-1"
            @keydown.esc="clearSearch"
            :loading="status === 'pending'"
          />
          <span v-if="view" class="text-sm text-muted tabular-nums">
            <template v-if="query.trim()">{{ count(view.matched) }} of </template
            >{{ count(view.total) }} lines
          </span>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            aria-label="Reload"
            @click="reload"
          />
          <UButton
            label="Download"
            icon="i-lucide-download"
            color="neutral"
            variant="outline"
            :href="`${base}/download?name=${encodeURIComponent(selected)}`"
            download
          />
        </div>

        <UAlert v-if="error" color="error" variant="subtle" :title="errorMessage(error)" />
        <div
          v-else
          ref="scroller"
          class="dark min-h-0 flex-1 overflow-y-auto rounded-lg border border-default bg-[#0b0e14] px-4 py-3 font-mono text-[13px] leading-relaxed"
          role="log"
          :aria-label="selected"
        >
          <p v-if="view?.truncated" class="mb-2 text-muted">
            Showing the last {{ count(view.lines.length) }} lines. Download the log for the rest.
          </p>
          <p v-if="view && view.lines.length === 0" class="text-muted">
            {{ query.trim() ? 'Nothing matches.' : 'This log is empty.' }}
          </p>
          <div
            v-for="(line, i) in view?.lines"
            :key="i"
            class="break-words whitespace-pre-wrap"
            :class="logTone(line)"
          >
            <template v-for="(p, j) in parts(line)" :key="j"
              ><mark v-if="p.hit" class="rounded-sm bg-primary/30 text-inherit">{{ p.text }}</mark
              ><template v-else>{{ p.text }}</template></template
            >
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
