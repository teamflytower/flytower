<script setup lang="ts">
/**
 * What "Trim unused chunks" keeps: the rules and protected areas, the same as the spec's
 * `world.trim`. Saving never trims anything; trimming is started separately.
 */
import {
  DEFAULT_TRIM,
  TrimRules,
  VANILLA_DIMENSIONS,
  sameTrimRules,
  type TrimRules as Rules,
} from '#shared/trim-rules'

const emit = defineEmits<{ saved: [rules: Rules] }>()

const { server, refresh: refreshServer } = useServerContext()
const toast = useToast()
const can = useCan()
const name = computed(() => server.value?.name ?? '')
const canEdit = computed(() => can('world.manage', name.value))

const DIMENSION_LABELS: Record<string, string> = {
  overworld: 'Overworld',
  the_nether: 'Nether',
  the_end: 'End',
}
const dimensionLabel = (d: string) => DIMENSION_LABELS[d] ?? d

interface AreaDraft {
  key: number
  name: string
  dimension: string
  fromX: number
  fromZ: number
  toX: number
  toZ: number
}

let nextKey = 0
const clone = (r: Rules) => ({
  ...r,
  dimensions: [...r.dimensions],
  areas: r.protect.map((p): AreaDraft => ({
    key: nextKey++,
    name: p.name,
    dimension: p.dimension,
    fromX: p.from[0],
    fromZ: p.from[1],
    toX: p.to[0],
    toZ: p.to[1],
  })),
})

const saved = computed<Rules>(() => server.value?.trim ?? DEFAULT_TRIM)
const draft = ref(clone(saved.value))
// Pick up rules saved elsewhere (the YAML tab, another person) unless there are edits here.
watch(saved, (now, was) => {
  if (!was || sameTrimRules(toRules.value ?? was, was)) draft.value = clone(now)
})

const candidate = computed(() => ({
  inhabitedMinutes: draft.value.inhabitedMinutes,
  spawnRadius: draft.value.spawnRadius,
  playerRadius: draft.value.playerRadius,
  buffer: draft.value.buffer,
  endRadius: draft.value.endRadius,
  unfinished: draft.value.unfinished,
  border: draft.value.border,
  dimensions: draft.value.dimensions,
  protect: draft.value.areas.map((a) => ({
    name: a.name,
    dimension: a.dimension,
    from: [a.fromX, a.fromZ],
    to: [a.toX, a.toZ],
  })),
}))
const parsed = computed(() => TrimRules.safeParse(candidate.value))
const toRules = computed(() => (parsed.value.success ? parsed.value.data : null))
const problem = computed(() => {
  if (parsed.value.success) return null
  const issue = parsed.value.error.issues[0]!
  const [field, index] = issue.path
  return field === 'protect' && typeof index === 'number'
    ? `Protected area ${index + 1}: ${issue.message}`
    : issue.message
})
const dirty = computed(() => !toRules.value || !sameTrimRules(toRules.value, saved.value))
// Protected areas aren't rules, so going back to the default rules keeps them.
const isDefault = computed(
  () => !!toRules.value && sameTrimRules({ ...toRules.value, protect: [] }, DEFAULT_TRIM),
)

// Vanilla dimensions are switches; any modded ones in the rules are kept as they are.
const extraDimensions = computed(() =>
  draft.value.dimensions.filter((d) => !(VANILLA_DIMENSIONS as readonly string[]).includes(d)),
)
function setDimension(d: string, on: boolean) {
  const rest = draft.value.dimensions.filter((x) => x !== d)
  draft.value.dimensions = on ? [...rest, d] : rest
}
const dimensionItems = computed(() =>
  [...VANILLA_DIMENSIONS, ...extraDimensions.value].map((d) => ({
    label: dimensionLabel(d),
    value: d,
  })),
)

function addArea() {
  draft.value.areas.push({
    key: nextKey++,
    name: '',
    dimension: 'overworld',
    fromX: 0,
    fromZ: 0,
    toX: 0,
    toZ: 0,
  })
}
const removeArea = (key: number) =>
  (draft.value.areas = draft.value.areas.filter((a) => a.key !== key))

const chunksIn = (a: AreaDraft) =>
  (Math.abs((a.toX >> 4) - (a.fromX >> 4)) + 1) * (Math.abs((a.toZ >> 4) - (a.fromZ >> 4)) + 1)

const saving = ref(false)
async function save() {
  if (!toRules.value) return
  saving.value = true
  try {
    const { rules } = await $fetch<{ rules: Rules }>(
      `/api/servers/${name.value}/world/trim-rules` as string,
      { method: 'PATCH', body: toRules.value },
    )
    await refreshServer()
    draft.value = clone(rules)
    emit('saved', rules)
    toast.add({ title: 'Trim rules saved', color: 'success' })
  } catch (err) {
    toast.add({ title: "Couldn't save the rules", description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}
const reset = () => (draft.value = clone(saved.value))
const useDefaults = () => (draft.value = { ...clone(DEFAULT_TRIM), areas: draft.value.areas })
</script>

<template>
  <div v-if="server" class="space-y-5" data-e2e="trim-rules" data-doc="world.trim-rules">
    <div>
      <h3 class="text-sm font-semibold">What trimming keeps</h3>
      <p class="mt-1 text-sm text-muted">
        A chunk is removed only when every rule agrees it can go. Distances are in chunks (16
        blocks), measured as squares. These rules are also in the server's YAML, under
        <code>world.trim</code>.
      </p>
    </div>

    <fieldset :disabled="!canEdit || saving" class="space-y-4">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <UFormField
          label="Time spent (minutes)"
          help="Keep chunks players have been in for at least this long, in total."
        >
          <UInputNumber
            v-model="draft.inhabitedMinutes"
            :min="0"
            :max="60"
            :step="0.5"
            class="w-full"
            data-e2e="trim-inhabited"
          />
        </UFormField>
        <UFormField label="Round spawn" help="Chunks kept round world spawn.">
          <UInputNumber v-model="draft.spawnRadius" :min="0" :max="256" class="w-full" />
        </UFormField>
        <UFormField
          label="Round each player"
          help="Chunks kept round each player's last position and bed."
        >
          <UInputNumber v-model="draft.playerRadius" :min="0" :max="64" class="w-full" />
        </UFormField>
        <UFormField
          label="Buffer"
          help="Chunks kept round every kept chunk, so builds have no seam."
        >
          <UInputNumber v-model="draft.buffer" :min="0" :max="16" class="w-full" />
        </UFormField>
        <UFormField label="End island" help="Chunks kept round 0,0 in the End.">
          <UInputNumber v-model="draft.endRadius" :min="0" :max="256" class="w-full" />
        </UFormField>
      </div>

      <div class="space-y-3">
        <USwitch
          v-model="draft.unfinished"
          label="Remove half-generated chunks"
          description="Chunks the game started but never finished, wherever they are."
        />
        <USwitch
          v-model="draft.border"
          label="Remove chunks outside the world border"
          description="Only chunks wholly outside it."
        />
      </div>

      <div>
        <p class="text-sm font-medium">Dimensions to trim</p>
        <div class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          <UCheckbox
            v-for="d in VANILLA_DIMENSIONS"
            :key="d"
            :model-value="draft.dimensions.includes(d)"
            :label="dimensionLabel(d)"
            @update:model-value="(v: boolean | 'indeterminate') => setDimension(d, v === true)"
          />
        </div>
        <p v-if="extraDimensions.length" class="mt-2 text-xs text-muted">
          Also trims {{ extraDimensions.join(', ') }}. Change modded dimensions in the YAML.
        </p>
      </div>

      <div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium">Protected areas</p>
            <p class="text-xs text-muted">
              Always kept, whatever the rules say. Use two opposite corners, in block coordinates
              (press F3 in game to see them).
            </p>
          </div>
          <UButton
            v-if="canEdit"
            label="Add area"
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            size="sm"
            data-e2e="trim-add-area"
            @click="addArea"
          />
        </div>

        <p v-if="!draft.areas.length" class="mt-3 text-sm text-muted">No protected areas yet.</p>
        <ul v-else class="mt-3 space-y-3">
          <li
            v-for="(a, i) in draft.areas"
            :key="a.key"
            class="rounded-md border border-default p-3"
            data-e2e="trim-area"
          >
            <div class="grid gap-3 sm:grid-cols-[1fr_10rem_auto]">
              <UFormField :label="`Area ${i + 1} name`">
                <UInput v-model="a.name" placeholder="Town" class="w-full" maxlength="60" />
              </UFormField>
              <UFormField label="Dimension">
                <USelect v-model="a.dimension" :items="dimensionItems" class="w-full" />
              </UFormField>
              <div class="flex items-end">
                <UButton
                  v-if="canEdit"
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Remove ${a.name || `area ${i + 1}`}`"
                  @click="removeArea(a.key)"
                />
              </div>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <UFormField label="From X"
                ><UInputNumber v-model="a.fromX" class="w-full"
              /></UFormField>
              <UFormField label="From Z"
                ><UInputNumber v-model="a.fromZ" class="w-full"
              /></UFormField>
              <UFormField label="To X"><UInputNumber v-model="a.toX" class="w-full" /></UFormField>
              <UFormField label="To Z"><UInputNumber v-model="a.toZ" class="w-full" /></UFormField>
            </div>
            <p class="mt-2 text-xs text-muted">
              Keeps {{ chunksIn(a).toLocaleString() }} chunk{{ chunksIn(a) === 1 ? '' : 's' }}.
            </p>
          </li>
        </ul>
      </div>
    </fieldset>

    <p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>

    <div v-if="canEdit" class="flex flex-wrap items-center justify-end gap-2">
      <UButton
        v-if="!isDefault"
        label="Use default rules"
        color="neutral"
        variant="ghost"
        :disabled="saving"
        @click="useDefaults"
      />
      <UButton
        v-if="dirty"
        label="Undo changes"
        color="neutral"
        variant="ghost"
        :disabled="saving"
        @click="reset"
      />
      <UButton
        label="Save rules"
        icon="i-lucide-save"
        :disabled="!dirty || !toRules"
        :loading="saving"
        data-e2e="trim-rules-save"
        @click="save"
      />
    </div>
  </div>
</template>
