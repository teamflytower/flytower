<script setup lang="ts">
/**
 * Trim unused chunks (#301): the rules, a read-only preview of what would go with the saved
 * ones, then a trim after a passkey check: backup, stop, trim, start.
 */
import type { TrimRules } from '#shared/trim-rules'
import { dimensionName, trimTotals, type TrimPreview } from '#shared/trim-report'

const { server } = useServerContext()
const route = useRoute()
const router = useRouter()
const can = useCan()
const toast = useToast()
const withElevation = useElevation()

const name = computed(() => server.value?.name ?? '')
const canTrim = computed(() => can('world.manage', name.value))

const open = ref(false)
const keepBackup = ref(false)
const previewing = ref(false)
const previewError = ref<string | null>(null)
const preview = ref<TrimPreview | null>(null)
/** The rules the preview used: the trim sends them back so they can't change unseen. */
const previewRules = ref<TrimRules | null>(null)
const starting = ref(false)
const job = ref<number | null>(null)
const finished = ref<JobEvent | null>(null)

const totals = computed(() => (preview.value ? trimTotals(preview.value) : null))
const count = (n: number) => n.toLocaleString()
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

async function runPreview() {
  previewing.value = true
  previewError.value = null
  try {
    const r = await $fetch<{ rules: TrimRules; preview: TrimPreview }>(
      `/api/servers/${name.value}/world/trim-preview` as string,
      { method: 'POST' },
    )
    preview.value = r.preview
    previewRules.value = r.rules
  } catch (err) {
    preview.value = null
    previewError.value = errorMessage(err)
  } finally {
    previewing.value = false
  }
}

function begin() {
  keepBackup.value = false
  job.value = null
  finished.value = null
  preview.value = null
  previewError.value = null
  open.value = true
  void runPreview()
}

// The Storage page links here with ?trim to open the dialog straight away.
onMounted(() => {
  if (route.query.trim === undefined || !canTrim.value) return
  const { trim: _, ...query } = route.query
  void router.replace({ query, hash: route.hash })
  begin()
})

const canStart = computed(
  () =>
    !!preview.value &&
    !!previewRules.value &&
    !previewing.value &&
    (totals.value?.removed ?? 0) > 0,
)

async function trim() {
  if (!previewRules.value) return
  starting.value = true
  try {
    const r = await withElevation(() =>
      $fetch<{ jobId: number }>(`/api/servers/${name.value}/world/trim` as string, {
        method: 'POST',
        body: { rules: previewRules.value, keepBackup: keepBackup.value },
      }),
    )
    job.value = r.jobId
  } catch (err) {
    toast.add({ title: "Couldn't trim the world", description: errorMessage(err), color: 'error' })
    // The rules may have changed elsewhere: show what trimming would do now.
    if ((err as { statusCode?: number }).statusCode === 409) void runPreview()
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section v-if="server" class="rounded-lg border border-default p-5" data-doc="world.trim">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="max-w-lg">
        <h2 class="text-base font-semibold">Trim unused chunks</h2>
        <p class="mt-1 text-sm text-muted">
          Removes the parts of the world nobody has spent time in, so it takes less space. They're
          generated again, fresh, if anyone goes back. You see what would go before anything
          changes.
        </p>
      </div>
      <UButton
        v-if="canTrim"
        label="Preview and trim"
        color="neutral"
        variant="outline"
        icon="i-lucide-scissors"
        data-doc="trim.open"
        data-e2e="trim-open"
        @click="begin"
      />
    </div>
    <WorldTrimRules class="mt-5" />

    <UModal
      v-model:open="open"
      :title="`Trim unused chunks from ${server.displayName}`"
      :dismissible="!job || !!finished"
      :ui="{ content: 'sm:max-w-2xl' }"
    >
      <template #body>
        <JobProgress
          v-if="job"
          :job-id="job"
          :steps="WORLD_TRIM_STEPS"
          success-title="World trimmed"
          @finished="(e: JobEvent) => (finished = e)"
        />
        <div v-else class="space-y-5">
          <div
            v-if="previewing"
            class="flex items-start gap-3 rounded-md bg-elevated p-4 text-sm"
            data-e2e="trim-previewing"
          >
            <UIcon name="i-lucide-loader-circle" class="mt-0.5 size-5 shrink-0 animate-spin" />
            <div>
              <p class="font-medium">Looking at every chunk…</p>
              <p class="text-muted">
                Nothing is changed and the server keeps running. This takes a few seconds, or a
                minute or two on a big world.
              </p>
            </div>
          </div>

          <UAlert
            v-else-if="previewError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Couldn't look at the world"
            :description="previewError"
            :actions="[
              { label: 'Try again', color: 'neutral', variant: 'outline', onClick: runPreview },
            ]"
          />

          <template v-else-if="preview && totals">
            <p class="text-sm" data-e2e="trim-summary">
              <template v-if="totals.removed > 0">
                Trimming would remove
                <strong>{{ plural(totals.removed, 'chunk', 'chunks') }}</strong> of
                {{ count(totals.chunks) }} and free <strong>{{ humanBytes(totals.saved) }}</strong
                >.
              </template>
              <template v-else> Nothing to trim: every chunk is kept by the rules below. </template>
            </p>

            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-e2e="trim-preview">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="py-1.5 pe-3 font-medium">Dimension</th>
                    <th class="py-1.5 pe-3 text-right font-medium">Chunks going</th>
                    <th class="py-1.5 pe-3 text-right font-medium">Size now</th>
                    <th class="py-1.5 text-right font-medium">After</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default tabular-nums">
                  <tr v-for="d in preview.dimensions" :key="d.id">
                    <td class="py-1.5 pe-3">{{ dimensionName(d.id) }}</td>
                    <td class="py-1.5 pe-3 text-right whitespace-nowrap">
                      {{ count(d.removed) }}
                      <span class="text-muted">of {{ count(d.chunks) }}</span>
                    </td>
                    <td class="py-1.5 pe-3 text-right whitespace-nowrap">
                      {{ humanBytes(d.bytesBefore) }}
                    </td>
                    <td class="py-1.5 text-right whitespace-nowrap">
                      {{ humanBytes(d.bytesAfter) }}
                    </td>
                  </tr>
                  <tr v-if="!preview.dimensions.length">
                    <td colspan="4" class="py-1.5 text-muted">
                      No dimensions to trim. Pick some under the rules.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <UAlert
              v-if="preview.pregenerated && totals.removed > 0"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="This world looks pre-generated"
              description="Most of its chunks have never had a player near them, as after a Chunky run. Trimming removes them, so players will wait for them to generate again. Add protected areas or raise the radii to keep them."
              data-e2e="trim-pregenerated"
            />
            <UAlert
              v-if="totals.errors > 0"
              color="warning"
              variant="subtle"
              icon="i-lucide-file-warning"
              :title="`${plural(totals.errors, 'chunk or file', 'chunks or files')} couldn't be read`"
              description="They're always kept, never removed. A backup restore or the server's own repair may fix them."
            />
            <ul
              v-if="preview.warnings.length"
              class="list-disc space-y-1 ps-5 text-xs text-muted"
              aria-label="Warnings"
            >
              <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
            </ul>
            <p v-if="preview.running" class="text-xs text-muted">
              The server is running, so these figures may move a little by the time it's trimmed.
            </p>
          </template>

          <p v-if="preview && !previewing" class="text-xs text-muted">
            To keep more or less, close this, change the rules under Trim unused chunks, and preview
            again.
          </p>

          <div v-if="preview && totals && totals.removed > 0" class="space-y-2">
            <UCheckbox
              v-model="keepBackup"
              label="Keep the backup forever"
              description="A backup of the whole server is taken first either way. Retention never deletes this one."
            />
            <p class="text-xs text-muted">
              Players are disconnected while it trims, and the server starts again after. The web
              map redraws by itself. You'll be asked for your passkey.
            </p>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <template v-if="!job">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
            <UButton
              v-if="preview && !previewing"
              label="Preview again"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              @click="runPreview"
            />
            <UButton
              :label="
                totals?.removed ? `Trim ${plural(totals.removed, 'chunk', 'chunks')}` : 'Trim'
              "
              color="error"
              icon="i-lucide-scissors"
              :disabled="!canStart"
              :loading="starting"
              data-e2e="trim-confirm"
              @click="trim"
            />
          </template>
          <UButton
            v-else-if="finished"
            label="Done"
            color="neutral"
            variant="outline"
            @click="open = false"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
