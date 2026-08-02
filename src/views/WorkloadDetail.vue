<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

const workload = computed(() => store.workloadList.find(
  (w) => w.name === route.params.name && w.type?.toLowerCase() === route.params.type
))
const pod = computed(() => store.podList.find((p) => p.name === route.params.name))
const displayData = computed(() => pod.value || workload.value)

async function handleDelete() {
  if (!workload.value) { notify('error', '仅工作负载支持删除'); return }
  try { await store.deleteWorkload(workload.value.name, workload.value.namespace); router.push('/workloads') }
  catch (e) { notify('error', e.message || '删除失败') }
}
async function handleRestart() {
  if (!workload.value) { notify('error', '仅工作负载支持重启'); return }
  try { await store.restartWorkload(workload.value.name, workload.value.namespace); notify('success', '已重启') }
  catch (e) { notify('error', e.message || '重启失败') }
}
</script>

<template>
  <div class="animate-fade-in" v-if="displayData">
    <!-- Header -->
    <div class="mb-lg flex items-center justify-between">
      <div class="flex flex-col">
        <Breadcrumbs :items="[
          { label: 'Workloads', route: '/workloads' },
          { label: displayData.type || 'Detail' },
          { label: displayData.name }
        ]" />
        <div class="flex items-center gap-3 mt-2">
          <div class="w-3 h-3 rounded-full bg-primary-container animate-pulse-status"></div>
          <h2 class="text-display-lg">{{ displayData.name }}</h2>
          <StatusChip :status="displayData.status" />
        </div>
      </div>
      <div class="flex gap-2">
        <button @click="handleDelete" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">Delete</span>
        </button>
        <button @click="handleRestart" class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">refresh</span>
          <span class="font-medium text-body-md">Restart</span>
        </button>
      </div>
    </div>

    <!-- Detail Cards -->
    <div class="grid grid-cols-12 gap-gutter">
      <!-- Main Info -->
      <div class="col-span-12 lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Overview</h3>
          <div class="grid grid-cols-2 gap-lg">
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">TYPE</p>
              <p class="text-body-lg font-medium">{{ displayData.type }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">NAMESPACE</p>
              <p class="text-body-lg font-medium">{{ displayData.namespace }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">IMAGE</p>
              <p class="font-mono text-code-sm text-primary">{{ displayData.image }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">AGE</p>
              <p class="text-body-lg font-medium">{{ displayData.age }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">REPLICAS</p>
              <p class="text-body-lg font-medium">{{ displayData.replicas }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">REVISION</p>
              <p class="font-mono text-code-sm">{{ displayData.sha }}</p>
            </div>
          </div>
        </div>

        <!-- Managed Pods -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg pb-md">
            <h3 class="text-headline-sm">Managed Pods</h3>
          </div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Restarts</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Node</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(p, idx) in store.podList.slice(0, 4)" :key="idx" class="hover:bg-surface-container-low/50 cursor-pointer" @click="$router.push({ name: 'NsPodDetail', params: { namespace: p.namespace, name: p.name } })">
                <td class="px-lg py-md">
                  <span class="font-mono text-code-sm font-medium text-on-surface">{{ p.name }}</span>
                </td>
                <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
                <td class="px-lg py-md text-body-sm">{{ p.restarts }}</td>
                <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ p.node || '-' }}</td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.age }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Sidebar -->
      <div class="col-span-12 lg:col-span-4 flex flex-col gap-lg">
        <!-- Labels -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Labels</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="(val, key) in (displayData.labels || {})" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
              {{ key }}: {{ val }}
            </span>
          </div>
        </div>
        <!-- Events -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Events</h3>
          <div class="flex flex-col gap-md">
            <div v-for="(e, i) in store.eventList.slice(0, 4)" :key="i" class="flex gap-sm">
              <span class="material-symbols-outlined text-base mt-0.5" :class="e.color === 'primary' ? 'text-primary' : 'text-tertiary-container'">{{ e.icon }}</span>
              <div>
                <p class="text-body-sm font-medium">{{ e.reason }}</p>
                <p class="text-body-sm text-on-surface-variant">{{ e.time }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
