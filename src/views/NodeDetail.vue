<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const route = useRoute()
const store = useClusterStore()
const node = computed(() => store.getNodeByName(route.params.name))
</script>

<template>
  <div class="animate-fade-in" v-if="node">
    <div class="mb-lg">
      <Breadcrumbs :items="[
        { label: 'Nodes', route: '/nodes' },
        { label: node.name }
      ]" />
      <div class="flex items-center justify-between mt-2">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center">
            <span class="material-symbols-outlined text-on-surface-variant">dns</span>
          </div>
          <div>
            <h2 class="text-display-lg">{{ node.name }}</h2>
            <p class="text-body-sm text-on-surface-variant">{{ node.ip }} · {{ node.os }} · {{ node.kernel }}</p>
          </div>
          <StatusChip :status="node.status === 'Ready' ? 'Ready' : 'NotReady'" class="ml-md" />
        </div>
        <div class="flex gap-2">
          <button class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">lock</span> Cordon
          </button>
          <button class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors text-tertiary-container">
            <span class="material-symbols-outlined">output</span> Drain
          </button>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-gutter">
      <!-- Resource Usage -->
      <div class="col-span-12 lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Resource Usage</h3>
          <div class="grid grid-cols-2 gap-xl">
            <div>
              <ProgressBar :value="node.cpu" size="lg" show-label label="CPU" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-2">{{ node.cpu }}% allocated</p>
            </div>
            <div>
              <ProgressBar :value="node.memory" size="lg" show-label label="Memory" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-2">{{ node.memory }}% allocated</p>
            </div>
          </div>
        </div>

        <!-- Conditions -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg pb-md"><h3 class="text-headline-sm">Conditions</h3></div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(val, key) in node.conditions" :key="key" class="hover:bg-surface-container-low/50">
                <td class="px-lg py-md text-body-md font-medium">{{ key }}</td>
                <td class="px-lg py-md">
                  <span class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full" :class="val ? 'bg-primary-container' : 'bg-error'"></span>
                    <span class="text-body-sm" :class="val ? 'text-primary' : 'text-on-surface-variant'">{{ val ? 'True' : 'False' }}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pods on this node -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg pb-md"><h3 class="text-headline-sm">Pods ({{ node.pods || 0 }})</h3></div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">CPU</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="p in store.podList.filter(p => p.node === node.name)" :key="p.name" class="hover:bg-surface-container-low/50 cursor-pointer" @click="$router.push(`/pods/${p.namespace}/${p.name}`)">
                <td class="px-lg py-md font-mono text-code-sm font-medium">{{ p.name }}</td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.namespace }}</td>
                <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
                <td class="px-lg py-md font-mono text-code-sm">{{ p.cpu }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Sidebar -->
      <div class="col-span-12 lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">System Info</h3>
          <div class="space-y-md">
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">OS</span><span class="text-body-sm font-medium">{{ node.os }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Kernel</span><span class="font-mono text-code-sm">{{ node.kernel }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Kubelet</span><span class="font-mono text-code-sm">{{ node.version }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Role</span><span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant">{{ node.roles }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Age</span><span class="text-body-sm font-medium">{{ node.age }}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
