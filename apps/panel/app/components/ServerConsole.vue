<script setup lang="ts">
import {
  accept,
  complete,
  isReadyLine,
  trackPlayers,
  type Catalogue,
  type Completion,
  type Suggestion,
} from '#shared/commands'

const props = defineProps<{ server: string; running: boolean }>()
const can = useCan()
const canSend = computed(() => can('console.command', props.server))

type ConsoleMessage = { type: 'snapshot' | 'lines'; lines: string[] }
const MAX_LINES = 1000

const lines = ref<string[]>([])
const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)

useTopic<ConsoleMessage>(
  () => `console:${props.server}`,
  (m) => {
    lines.value = m.type === 'snapshot' ? m.lines : [...lines.value, ...m.lines].slice(-MAX_LINES)
    if (m.type === 'lines') onLines(m.lines)
    if (pinned.value) nextTick(scrollToEnd)
  },
)

function scrollToEnd() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
function jumpToLatest() {
  pinned.value = true
  scrollToEnd()
}
function onScroll() {
  const el = scroller.value
  if (el) pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

// Per-server command history, kept in this browser only.
const historyKey = computed(() => `flytower:history:${props.server}`)
const history = ref<string[]>([])
let cursor = -1
onMounted(() => {
  try {
    history.value = JSON.parse(localStorage.getItem(historyKey.value) ?? '[]')
  } catch {
    history.value = []
  }
})
function remember(command: string) {
  history.value = [command, ...history.value.filter((c) => c !== command)].slice(0, 50)
  try {
    localStorage.setItem(historyKey.value, JSON.stringify(history.value))
  } catch {
    // Private windows can refuse storage; history then lasts for this page only.
  }
}

const input = ref('')
const sending = ref(false)
const toast = useToast()

/** Set while history fills the box, so walking history doesn't open suggestions. */
let fromHistory = false
function browse(step: 1 | -1) {
  if (open.value) return move(step === 1 ? -1 : 1)
  if (history.value.length === 0) return
  cursor = Math.max(-1, Math.min(history.value.length - 1, cursor + step))
  fromHistory = true
  input.value = cursor === -1 ? '' : history.value[cursor]!
}

async function send() {
  const command = input.value.trim()
  if (!command || sending.value) return
  sending.value = true
  try {
    await $fetch(`/api/servers/${props.server}/command`, { method: 'POST', body: { command } })
    remember(command.replace(/^\//, ''))
    input.value = ''
    cursor = -1
    endCycle()
    pinned.value = true
    nextTick(scrollToEnd)
  } catch (err) {
    toast.add({
      title: 'Command failed',
      description: (err as { data?: { statusMessage?: string } }).data?.statusMessage,
      color: 'error',
    })
  } finally {
    sending.value = false
  }
}

// Command completion: the catalogue is fetched once, and everything after that runs here.
const catalogue = ref<Catalogue | null>(null)
let loading = false
async function loadCommands(wait = false) {
  if (!canSend.value || (loading && !wait)) return
  loading = true
  try {
    const view = await $fetch<Catalogue & { vanilla: string }>(
      `/api/servers/${props.server}/commands`,
      { query: wait ? { wait: '1' } : undefined },
    )
    catalogue.value = view
    // The game's command list for this version is still being made: ask again once it's done.
    if (view.vanilla === 'building' && !wait) void loadCommands(true)
  } catch {
    // Completion is a nicety; the console works without it.
  } finally {
    loading = false
  }
}
onMounted(() => loadCommands())
watch(
  () => [props.server, props.running],
  () => loadCommands(),
)
function onLines(added: string[]) {
  const cat = catalogue.value
  if (cat) cat.players = trackPlayers(cat.players, added)
  // Started: mods' commands can be asked for now.
  if (added.some(isReadyLine)) void loadCommands()
}

const field = ref<HTMLInputElement | null>(null)
const focused = ref(false)
const atEnd = ref(true)
const dismissed = ref(false)
const highlight = ref(0)
/** Tab cycles through the suggestions it started from, like the game's own chat. */
const cycle = ref<{ completion: Completion; index: number; value: string } | null>(null)

function syncCaret() {
  const el = field.value
  atEnd.value = !el || el.selectionStart === el.value.length
}

const completion = computed<Completion | null>(() => {
  if (cycle.value) return cycle.value.completion
  const cat = catalogue.value
  if (!cat || !props.running || !input.value.trim() || !atEnd.value) return null
  return complete(input.value, cat)
})
const suggestions = computed<Suggestion[]>(() => completion.value?.suggestions ?? [])
const open = computed(() => focused.value && !dismissed.value && suggestions.value.length > 0)
const active = computed(() => (cycle.value ? cycle.value.index : highlight.value))
const ghost = computed(() => {
  const c = completion.value
  const top = suggestions.value[active.value]
  if (!c || !top || cycle.value || !open.value || !c.typed) return ''
  return top.text.toLowerCase().startsWith(c.typed.toLowerCase())
    ? top.text.slice(c.typed.length)
    : ''
})

watch(input, (value) => {
  if (cycle.value && value !== cycle.value.value) cycle.value = null
  if (!cycle.value) {
    highlight.value = 0
    dismissed.value = fromHistory
  }
  fromHistory = false
})

function endCycle() {
  cycle.value = null
}
function move(step: 1 | -1) {
  const n = suggestions.value.length
  if (n === 0) return
  cycle.value = null
  highlight.value = (highlight.value + step + n) % n
}
function take(s: Suggestion, space = true) {
  const c = completion.value
  if (!c) return
  cycle.value = null
  input.value = accept(input.value, c, s, space)
  nextTick(() => {
    field.value?.focus()
    syncCaret()
  })
}
function onTab(e: KeyboardEvent) {
  const c = completion.value
  if (!c || suggestions.value.length === 0 || !focused.value) return
  e.preventDefault()
  // One choice: take it and carry on with the next word.
  if (suggestions.value.length === 1 && !cycle.value) return take(suggestions.value[0]!)
  const n = suggestions.value.length
  const step = e.shiftKey ? -1 : 1
  const index = cycle.value
    ? (cycle.value.index + step + n) % n
    : e.shiftKey
      ? (highlight.value - 1 + n) % n
      : highlight.value
  const value = accept(input.value, c, suggestions.value[index]!, false)
  cycle.value = { completion: c, index, value }
  input.value = value
  dismissed.value = false
}
function onEscape() {
  if (cycle.value || open.value) {
    cycle.value = null
    dismissed.value = true
  }
}
function onRight(e: KeyboardEvent) {
  if (!ghost.value || !atEnd.value) return
  e.preventDefault()
  take(suggestions.value[active.value]!, false)
}
</script>

<template>
  <!-- Always dark, like a terminal, whatever the panel's theme: `dark` gives the lines inside
       the dark theme's text colours, so they stay readable in light mode. -->
  <section
    class="dark flex min-h-0 flex-col overflow-hidden rounded-lg border border-default bg-[#0b0e14]"
  >
    <div class="relative min-h-0 flex-1">
      <div
        ref="scroller"
        class="absolute inset-0 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed"
        role="log"
        aria-live="polite"
        aria-label="Server console"
        @scroll="onScroll"
      >
        <p v-if="lines.length === 0" class="text-muted">
          {{
            running
              ? 'Waiting for the server to log something…'
              : 'No log yet. Start the server to see its output.'
          }}
        </p>
        <div
          v-for="(line, i) in lines"
          :key="i"
          class="break-words whitespace-pre-wrap"
          :class="logTone(line)"
        >
          {{ line }}
        </div>
      </div>
      <UButton
        v-if="!pinned"
        class="absolute right-4 bottom-3"
        size="xs"
        color="neutral"
        variant="solid"
        icon="i-lucide-arrow-down"
        label="Latest"
        @click="jumpToLatest"
      />
      <div
        v-if="open || completion?.hint"
        class="pointer-events-none absolute inset-x-2 bottom-2 hidden flex-col items-start gap-1 sm:flex"
      >
        <ul
          v-if="open"
          id="console-suggestions"
          role="listbox"
          aria-label="Suggestions"
          class="pointer-events-auto max-h-60 max-w-full min-w-56 overflow-y-auto rounded-md border border-white/10 bg-[#151a24] py-1 font-mono text-[13px] text-neutral-200 shadow-lg"
        >
          <li
            v-for="(s, i) in suggestions"
            :id="`console-suggestion-${i}`"
            :key="s.text"
            role="option"
            :aria-selected="i === active"
            class="flex cursor-pointer items-baseline justify-between gap-6 px-3 py-0.5"
            :class="i === active ? 'bg-primary/25 text-white' : ''"
            @mousedown.prevent="take(s)"
            @mousemove="!cycle && (highlight = i)"
          >
            <span class="truncate">{{ s.text }}</span>
            <span v-if="s.detail" class="shrink-0 truncate text-xs text-neutral-500">{{
              s.detail
            }}</span>
          </li>
        </ul>
        <p
          v-if="completion?.hint"
          class="max-w-full truncate rounded bg-[#151a24]/95 px-2 py-0.5 font-mono text-xs text-neutral-400"
          aria-live="polite"
        >
          {{ completion.hint }}
        </p>
      </div>
    </div>
    <div v-if="canSend" class="border-t border-white/10">
      <div v-if="open || completion?.hint" class="flex flex-col gap-1.5 px-2 pt-2 sm:hidden">
        <p v-if="completion?.hint" class="truncate font-mono text-xs text-neutral-400">
          {{ completion.hint }}
        </p>
        <div v-if="open" class="flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Suggestions">
          <button
            v-for="(s, i) in suggestions.slice(0, 20)"
            :key="s.text"
            type="button"
            class="shrink-0 rounded-full border px-2.5 py-1 font-mono text-xs"
            :class="
              i === active
                ? 'border-primary/60 bg-primary/25 text-white'
                : 'border-white/10 bg-[#151a24] text-neutral-200'
            "
            @mousedown.prevent
            @click="take(s)"
          >
            {{ s.text }}
          </button>
        </div>
      </div>
      <form class="flex items-center gap-2 p-2" @submit.prevent="send">
        <span class="pl-2 font-mono text-primary" aria-hidden="true">&gt;</span>
        <div class="relative min-w-0 flex-1">
          <input
            ref="field"
            v-model="input"
            class="w-full bg-transparent py-1.5 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-75"
            :placeholder="
              running ? 'Type a command, e.g. list' : 'Start the server to send commands'
            "
            :disabled="!running"
            aria-label="Command"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="open"
            aria-controls="console-suggestions"
            :aria-activedescendant="open ? `console-suggestion-${active}` : undefined"
            @focus="focused = true"
            @blur="focused = false"
            @input="syncCaret"
            @click="syncCaret"
            @keyup="syncCaret"
            @keydown.tab="onTab"
            @keydown.esc="onEscape"
            @keydown.right="onRight"
            @keydown.up.prevent="browse(1)"
            @keydown.down.prevent="browse(-1)"
          />
          <div
            v-if="ghost"
            class="pointer-events-none absolute inset-0 overflow-hidden py-1.5 font-mono text-sm whitespace-pre"
            aria-hidden="true"
          >
            <span class="invisible">{{ input }}</span
            ><span class="text-neutral-500">{{ ghost }}</span>
          </div>
        </div>
        <UButton
          type="submit"
          icon="i-lucide-corner-down-left"
          size="sm"
          variant="ghost"
          :loading="sending"
          :disabled="!running || !input.trim()"
          aria-label="Send command"
        />
      </form>
    </div>
  </section>
</template>
