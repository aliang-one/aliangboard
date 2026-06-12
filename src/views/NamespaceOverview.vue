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
store.setNamespace(route.params.namespace)

const ns = computed(() => store.getNamespaceByName(route.params.namespace))
const stats = computed(() => store.nsStats)

const recentPods = computed(() => store.nsPods.slice(0, 6))
const recentWorkloads = computed(() => store.nsWorkloads.slice(0, 5))
</script>

<template>
  <div class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-sm mb-xl">
      <Breadcrumbs :items="[
        { label: 'Cluster', route: '/cluster' },
        { label: route.params.namespace }
      ]" />
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-md">
          <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-2xl">folder_open</span>
          </div>
          <div>
            <h1 class="text-display-lg text-on-surface">{{ route.params.namespace }}</h1>
            <div class="flex items-center gap-md mt-xs">
              <StatusChip status="Active" />
              <span class="text-body-sm text-on-surface-variant">Age: {{ ns?.age || 'N/A' }}</span>
              <span class="text-body-sm text-on-surface-variant">·</span>
              <span class="text-body-sm text-on-surface-variant">{{ stats.pods }} Pods</span>
              <span class="text-body-sm text-on-surface-variant">·</span>
              <span class="text-body-sm text-on-surface-variant">{{ stats.services }} Services</span>
            </div>
          </div>
        </div>
        <div class="flex gap-sm">
          <button class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">edit</span> Edit YAML
          </button>
          <button
            @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
            class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all"
          >
            <span class="material-symbols-outlined">add</span> Deploy
          </button>
        </div>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-gutter mb-xl">
      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group" @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-primary text-2xl">layers</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-primary">{{ stats.pods }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.runningPods }} Running · {{ stats.pods - stats.runningPods }} Other</p>
      </div>
      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group" @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-secondary text-2xl">apps</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.deployments + stats.statefulSets + stats.daemonSets + stats.jobs }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.deployments }} Deploy · {{ stats.statefulSets }} STS · {{ stats.daemonSets }} DS</p>
      </div>
      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group" @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-tertiary text-2xl">hub</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.services }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.ingress }} Ingress</p>
      </div>
      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group" @click="router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-on-surface-variant text-2xl">description</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.configMaps + stats.secrets }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.configMaps }} CM · {{ stats.secrets }} Secrets</p>
      </div>
    </div>

    <!-- Main Content -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-xl">
      <!-- Left: Workload Summary + Pods -->
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <!-- Workload Summary -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-lg">
            <h3 class="text-headline-sm">Workload Summary</h3>
            <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="text-primary font-semibold flex items-center gap-xs text-body-sm hover:opacity-80">
              View all <span class="material-symbols-outlined text-md">arrow_forward</span>
            </button>
          </div>
          <!-- Workload Type Grid -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
            <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors cursor-pointer" @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })">
              <span class="material-symbols-outlined text-primary text-2xl">view_carousel</span>
              <p class="text-headline-md font-bold mt-sm">{{ stats.deployments }}</p>
              <p class="text-body-sm text-on-surface-variant">Deployments</p>
            </div>
            <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
              <span class="material-symbols-outlined text-secondary text-2xl">database</span>
              <p class="text-headline-md font-bold mt-sm">{{ stats.statefulSets }}</p>
              <p class="text-body-sm text-on-surface-variant">StatefulSets</p>
            </div>
            <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
              <span class="material-symbols-outlined text-tertiary text-2xl">settings_slow_motion</span>
              <p class="text-headline-md font-bold mt-sm">{{ stats.daemonSets }}</p>
              <p class="text-body-sm text-on-surface-variant">DaemonSets</p>
            </div>
            <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
              <span class="material-symbols-outlined text-on-surface-variant text-2xl">schedule</span>
              <p class="text-headline-md font-bold mt-sm">{{ stats.jobs }}</p>
              <p class="text-body-sm text-on-surface-variant">Jobs</p>
            </div>
          </div>
          <!-- Recent Workloads Table -->
          <table v-if="recentWorkloads.length" class="w-full text-left">
            <thead>
              <tr class="border-b border-outline-variant">
                <th class="pb-sm text-label-caps text-on-surface-variant">Name</th>
                <th class="pb-sm text-label-caps text-on-surface-variant">Type</th>
                <th class="pb-sm text-label-caps text-on-surface-variant">Status</th>
                <th class="pb-sm text-label-caps text-on-surface-variant">Replicas</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="w in recentWorkloads" :key="w.name" class="hover:bg-surface-container-low/50 cursor-pointer" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: w.type.toLowerCase(), name: w.name } })">
                <td class="py-sm font-semibold text-on-surface text-body-md">{{ w.name }}</td>
                <td class="py-sm text-body-sm text-on-surface-variant">{{ w.type }}</td>
                <td class="py-sm"><StatusChip :status="w.status" size="sm" /></td>
                <td class="py-sm font-mono text-code-sm">{{ w.replicas }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No workloads in this namespace</p>
        </div>

        <!-- Recent Pods -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-lg">
            <h3 class="text-headline-sm">Recent Pods</h3>
            <button @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })" class="text-primary font-semibold flex items-center gap-xs text-body-sm hover:opacity-80">
              View all <span class="material-symbols-outlined text-md">arrow_forward</span>
            </button>
          </div>
          <div v-if="recentPods.length" class="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div v-for="p in recentPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="p-md rounded-lg border border-outline-variant bg-surface-container-low hover:border-primary transition-colors cursor-pointer">
              <div class="flex items-center justify-between mb-sm">
                <span class="font-mono text-code-sm font-semibold text-on-surface truncate mr-sm">{{ p.name }}</span>
                <StatusChip :status="p.status" size="sm" />
              </div>
              <div class="flex items-center gap-md text-body-sm text-on-surface-variant">
                <span class="flex items-center gap-xs"><span class="material-symbols-outlined text-sm">dns</span>{{ p.node || 'Unscheduled' }}</span>
                <span v-if="p.restarts > 0" class="text-tertiary-container font-medium">⚠ {{ p.restarts }} restarts</span>
              </div>
            </div>
          </div>
          <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No pods in this namespace</p>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <!-- Resource Quotas -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Resource Quotas</h3>
          <div class="space-y-lg">
            <div>
              <ProgressBar :value="62" show-label label="CPU Usage" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-1">7.4 / 12 Cores</p>
            </div>
            <div>
              <ProgressBar :value="75" show-label label="Memory Usage" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-1">24.1 / 32 GiB</p>
            </div>
            <div class="grid grid-cols-2 gap-md pt-md border-t border-outline-variant">
              <div>
                <p class="text-on-surface-variant text-body-sm mb-xs">Pods</p>
                <p class="text-headline-sm">{{ stats.pods }}</p>
              </div>
              <div>
                <p class="text-on-surface-variant text-body-sm mb-xs">PVCs</p>
                <p class="text-headline-sm">{{ stats.pvcs }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Quick Actions</h3>
          <div class="flex flex-col gap-sm">
            <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="flex items-center gap-md px-md py-sm bg-primary/5 text-primary rounded-lg hover:bg-primary/10 transition-colors text-body-md font-medium">
              <span class="material-symbols-outlined">rocket_launch</span> Deploy New App
            </button>
            <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="flex items-center gap-md px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-md font-medium">
              <span class="material-symbols-outlined">notifications_active</span> View Events
            </button>
            <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="flex items-center gap-md px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-md font-medium">
              <span class="material-symbols-outlined">admin_panel_settings</span> Manage RBAC
            </button>
            <button @click="router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })" class="flex items-center gap-md px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-md font-medium">
              <span class="material-symbols-outlined">storage</span> View Storage
            </button>
          </div>
        </div>

        <!-- Events -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-md">
            <h3 class="text-headline-sm">Events</h3>
            <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="text-primary font-semibold text-body-sm hover:opacity-80">View all</button>
          </div>
          <div v-if="store.nsEvents.length" class="flex flex-col gap-md">
            <div v-for="(event, idx) in store.nsEvents.slice(0, 4)" :key="idx" class="flex gap-sm border-b border-outline-variant/30 pb-md last:border-0 last:pb-0">
              <div class="mt-0.5">
                <span class="material-symbols-outlined text-base" :class="{
                  'text-primary': event.color === 'primary',
                  'text-tertiary-container': event.color === 'tertiary',
                  'text-error': event.color === 'error',
                  'text-on-surface-variant': event.color === 'surface',
                }">{{ event.icon }}</span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-body-sm font-medium text-on-surface truncate">{{ event.reason }}</p>
                <p class="text-body-sm text-on-surface-variant truncate">{{ event.message }}</p>
                <p class="font-mono text-code-xs text-on-surface-variant mt-xs">{{ event.time }}</p>
              </div>
            </div>
          </div>
          <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No recent events</p>
        </div>
      </div>
    </div>
  </div>
</template>
