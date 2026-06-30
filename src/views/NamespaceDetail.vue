<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

const ns = computed(() => store.getNamespaceByName(route.params.name))
const nsWorkloads = computed(() => store.workloadList.filter(w => w.namespace === route.params.name))
const nsServices = computed(() => store.serviceList.filter(s => s.namespace === route.params.name))
</script>

<template>
  <div class="animate-fade-in" v-if="ns">
    <div class="flex flex-col md:flex-row md:items-end justify-between mb-xl gap-md">
      <div>
        <Breadcrumbs :items="[
          { label: 'Namespaces', route: '/namespaces' },
          { label: ns.name }
        ]" />
        <div class="flex items-center gap-sm mt-2">
          <span class="material-symbols-outlined text-lg text-on-surface-variant">folder_open</span>
          <span class="text-label-caps text-on-surface-variant uppercase">Namespace Explorer</span>
        </div>
        <h2 class="text-display-lg text-on-surface">Namespace: <span class="text-primary">{{ ns.name }}</span></h2>
      </div>
      <div class="flex gap-sm">
        <button class="px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors flex items-center gap-sm">
          <span class="material-symbols-outlined">refresh</span> Sync
        </button>
        <button class="px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 flex items-center gap-sm">
          <span class="material-symbols-outlined">edit</span> Edit YAML
        </button>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-gutter">
      <!-- Resource Quotas -->
      <section class="col-span-12 lg:col-span-4 bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex items-center justify-between mb-lg">
          <h3 class="text-headline-sm">Resource Quotas</h3>
          <span class="material-symbols-outlined text-primary">analytics</span>
        </div>
        <div class="space-y-xl">
          <div>
            <ProgressBar :value="62" show-label label="CPU Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant mt-1">7.4 / 12 Cores</p>
          </div>
          <div>
            <ProgressBar :value="75" show-label label="Memory Usage" color="primary" />
            <p class="font-mono text-code-sm text-on-surface-variant mt-1">24.1 / 32 GiB</p>
          </div>
          <div class="grid grid-cols-2 gap-md pt-md border-t border-outline-variant">
            <div>
              <p class="text-on-surface-variant text-body-sm mb-xs">Pods</p>
              <p class="text-headline-sm">{{ ns.pods }} / 50</p>
            </div>
            <div>
              <p class="text-on-surface-variant text-body-sm mb-xs">Services</p>
              <p class="text-headline-sm">{{ ns.services }} / 20</p>
            </div>
          </div>
        </div>
      </section>

      <!-- Distribution Map -->
      <section class="col-span-12 lg:col-span-8 bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex items-center justify-between mb-lg">
          <h3 class="text-headline-sm">Workload Distribution</h3>
          <span class="flex items-center gap-xs text-body-sm px-sm py-1 bg-primary/10 text-primary rounded-full">
            <span class="w-2 h-2 bg-primary rounded-full animate-pulse-status"></span> Healthy
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
          <div
            v-for="group in [
              { name: 'Deployments', icon: 'layers', items: nsWorkloads.filter(w => w.type === 'Deployment').slice(0, 6) },
              { name: 'StatefulSets', icon: 'storage', items: nsWorkloads.filter(w => w.type === 'StatefulSet').slice(0, 6) },
              { name: 'DaemonSets', icon: 'settings_slow_motion', items: nsWorkloads.filter(w => w.type === 'DaemonSet').slice(0, 6) },
            ]"
            :key="group.name"
            class="p-md rounded-lg border border-outline-variant bg-surface-container-low hover:border-primary transition-colors"
          >
            <div class="flex items-center justify-between mb-md">
              <span class="text-label-caps uppercase text-on-surface-variant">{{ group.name }}</span>
              <span class="material-symbols-outlined text-lg">{{ group.icon }}</span>
            </div>
            <div class="grid grid-cols-3 gap-sm">
              <div
                v-for="(item, idx) in group.items.length ? group.items : [{ status: 'empty' }]"
                :key="idx"
                class="w-full aspect-square rounded-sm border"
                :class="item.status === 'Running' ? 'bg-primary/20 border-primary/40' : item.status === 'Pending' ? 'bg-tertiary-container/20 border-tertiary-container/40' : item.status === 'Failed' ? 'bg-error/20 border-error/40' : 'bg-surface-container border-outline-variant'"
              >
                <span v-if="item.status === 'Failed'" class="absolute -top-1 -right-1 w-2 h-2 bg-error rounded-full relative float-right"></span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Workloads Table -->
      <section class="col-span-12 bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="p-lg pb-md">
          <h3 class="text-headline-sm">Workloads ({{ nsWorkloads.length }})</h3>
        </div>
        <table class="w-full text-left">
          <thead>
            <tr class="bg-surface-container-low border-y border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Replicas</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="w in nsWorkloads" :key="w.name" class="hover:bg-surface-container-low/50 cursor-pointer" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.name, type: w.type.toLowerCase(), name: w.name } })">
              <td class="px-lg py-md font-semibold text-on-surface text-body-md">{{ w.name }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ w.type }}</td>
              <td class="px-lg py-md"><StatusChip :status="w.status" /></td>
              <td class="px-lg py-md font-mono text-code-sm">{{ w.replicas }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ w.age }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
