<script setup lang="ts">
/** System, Addresses: one address for every server through the hostname router (#76). */
interface Messages {
  unknownMotd: string
  unknownDisconnect: string
  stoppedMotd: string
  stoppedDisconnect: string
  startingMotd: string
  startingDisconnect: string
  bannedDisconnect: string
}
interface RouterState {
  settings: { enabled: boolean; port: number; messages: Messages }
  defaults: Messages
  status: {
    since: string
    routes: { name: string; active: number; total: number }[]
    unknown: number
    refused: number
    active: number
  } | null
  addresses: { name: string; real: boolean; afterRestart: boolean }[]
}
interface Moved {
  name: string
  from: number
  to: number
}

const toast = useToast()
const withElevation = useElevation()
const { data, error, refresh } = await useFetch<RouterState>('/api/system/router')

const port = ref(data.value?.settings.port ?? 25565)
const messages = ref<Messages>({ ...(data.value?.settings.messages ?? ({} as Messages)) })
watch(data, (d) => {
  if (!d) return
  port.value = d.settings.port
  messages.value = { ...d.settings.messages }
})
const moved = ref<Moved[]>([])
const busy = ref(false)

async function post(body: object, done: string, elevated: boolean) {
  busy.value = true
  try {
    const call = () => $fetch<{ moved: Moved[] }>('/api/system/router', { method: 'POST', body })
    const r = elevated ? await withElevation(call) : await call()
    moved.value = r.moved
    toast.add({ title: done, color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: "That didn't work", description: errorMessage(err), color: 'error' })
  } finally {
    busy.value = false
  }
}
const turnOn = () =>
  post(
    { enabled: true, port: port.value },
    'Every server with an address now shares one port',
    true,
  )
const turnOff = () => post({ enabled: false }, 'Every server has its own port again', true)
const saveMessages = () => post({ messages: messages.value }, 'Messages saved', false)
const resetMessages = () => data.value && (messages.value = { ...data.value.defaults })

function realAddress(name: string) {
  const a = data.value?.addresses.find((x) => x.name === name)
  if (!a) return ''
  if (a.real) return 'Yes'
  if (a.afterRestart) return 'After a restart'
  return 'No'
}

const FIELDS: { key: keyof Messages; label: string; motd: boolean }[] = [
  { key: 'unknownMotd', label: 'No server at this address: server list', motd: true },
  { key: 'unknownDisconnect', label: 'No server at this address: joining', motd: false },
  { key: 'stoppedMotd', label: 'Stopped: server list', motd: true },
  { key: 'stoppedDisconnect', label: 'Stopped: joining', motd: false },
  { key: 'startingMotd', label: 'Starting: server list', motd: true },
  { key: 'startingDisconnect', label: 'Starting: joining', motd: false },
  { key: 'bannedDisconnect', label: 'Banned: joining', motd: false },
]
</script>

<template>
  <div class="space-y-4">
    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-semibold">One address for every server</h2>
          <UBadge
            v-if="data"
            variant="subtle"
            :color="data.settings.enabled ? 'success' : 'neutral'"
            :label="data.settings.enabled ? `On, port ${data.settings.port}` : 'Off'"
          />
        </div>
      </template>
      <UAlert v-if="error" color="error" variant="subtle" :title="errorMessage(error)" />
      <div v-else-if="data" class="space-y-4 text-sm">
        <p>
          Players type a server's address, like <span class="font-mono">survival.example.com</span>,
          and the router sends them to the right server, all on one port. Servers with an address
          stop having a public port of their own. Servers without one keep theirs.
        </p>
        <template v-if="!data.settings.enabled">
          <UFormField label="Port players connect to" help="25565 means nobody has to type a port.">
            <UInputNumber v-model="port" :min="1024" :max="65535" class="w-40" />
          </UFormField>
          <p class="text-muted">
            A server already on this port moves to the next free one. Servers listen only inside the
            machine from their next restart.
          </p>
          <UButton
            label="Turn on"
            icon="i-lucide-route"
            :loading="busy"
            data-e2e="router-on"
            @click="turnOn"
          />
        </template>
        <template v-else>
          <UAlert
            v-if="moved.length"
            color="warning"
            variant="subtle"
            title="Restart these servers"
            :description="
              moved.map((m) => `${m.name} moved from port ${m.from} to ${m.to}`).join('. ') +
              '. Players reach them again once they restart.'
            "
          />
          <div v-if="data.status" data-e2e="router-status">
            <table class="w-full text-left">
              <thead class="text-muted">
                <tr>
                  <th class="py-1 font-normal">Server</th>
                  <th class="py-1 font-normal">Playing now</th>
                  <th class="py-1 font-normal">Connections since start</th>
                  <th class="py-1 font-normal">Real addresses</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in data.status.routes" :key="r.name" class="border-t border-default">
                  <td class="py-1">{{ r.name }}</td>
                  <td class="py-1">{{ r.active }}</td>
                  <td class="py-1">{{ r.total }}</td>
                  <td class="py-1">{{ realAddress(r.name) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-2 text-muted">
              {{ data.status.unknown }} tried an address with no server, and
              {{ data.status.refused }} were turned away (a ban, a limit or not Minecraft).
            </p>
            <p class="mt-2 text-muted">
              Fabric and Paper servers see each player's real address, for bans and logs, from their
              next restart. Fabric servers get Flytower's small proxy mod for this; Paper does it by
              itself. Vanilla servers see every player as 127.0.0.1, so the router enforces their IP
              bans for them.
            </p>
          </div>
          <UAlert
            v-else
            color="warning"
            variant="subtle"
            title="The router isn't answering"
            description="Players may not be able to join. It restarts by itself; check again in a moment."
          />
          <UButton
            label="Turn off"
            color="neutral"
            variant="outline"
            :loading="busy"
            data-e2e="router-off"
            @click="turnOff"
          />
        </template>
      </div>
    </UCard>

    <UCard v-if="data">
      <template #header>
        <h2 class="font-semibold">What players see</h2>
      </template>
      <div class="space-y-3 text-sm">
        <p class="text-muted">
          When the router answers for a server. § codes add colour, a new line starts a second line,
          and {hostname} becomes the address the player typed.
        </p>
        <UFormField v-for="f in FIELDS" :key="f.key" :label="f.label">
          <UTextarea v-model="messages[f.key]" :rows="f.motd ? 2 : 1" autoresize class="w-full" />
        </UFormField>
        <div class="flex gap-2">
          <UButton label="Save" :loading="busy" @click="saveMessages" />
          <UButton
            label="Reset to defaults"
            color="neutral"
            variant="ghost"
            @click="resetMessages"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>
