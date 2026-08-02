<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const store = useClusterStore()
const node = computed(() => store.getNodeByName(route.params.name))
const yaml = computed(() => store.generateYAML('node', node.value))

const activeTab = ref('overview')
const showCordonModal = ref(false)
const showDrainModal = ref(false)
const drainResult = ref(null)

const nodePods = computed(() => store.podList.filter(p => p.node === route.params.name))
const isCordoned = computed(() => node.value?.unschedulable === true)

async function handleCordon() {
  try {
    await store.cordonNode(route.params.name)
    notify('success', '已封锁节点')
    showCordonModal.value = false
  } catch (e) {
    notify('error', e.message || '封锁节点失败')
  }
}

async function handleUncordon() {
  try {
    await store.uncordonNode(route.params.name)
    notify('success', '已恢复调度')
  } catch (e) {
    notify('error', e.message || '恢复调度失败')
  }
}

async function handleDrain() {
  try {
    const count = await store.drainNode(route.params.name)
    drainResult.value = count
    showDrainModal.value = false
    notify('success', `已驱逐 ${count} 个 Pod`)
  } catch (e) {
    notify('error', e.message || '驱逐失败')
  }
}
</script>

<template>
  <div class="animate-fade-in" v-if="node">
    <div class="mb-lg">
      <Breadcrumbs :items="[
        { label: 'Nodes', route: '/nodes' },
        { label: node.name }
      ]" />
      <div class="flex items-center justify-between mt-sm mb-xl">
        <div class="flex items-center gap-lg">
          <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-3xl">dns</span>
          </div>
          <div>
            <h1 class="text-display-lg text-on-surface">{{ node.name }}</h1>
            <div class="flex items-center gap-md mt-xs">
              <StatusChip :status="node.status === 'Ready' ? 'Ready' : 'NotReady'" />
              <span class="text-body-sm text-on-surface-variant">{{ node.ip }}</span>
              <span class="text-body-sm text-on-surface-variant">{{ node.os }} · {{ node.kernel }}</span>
              <span v-if="isCordoned" class="px-2.5 py-0.5 bg-tertiary-container/10 text-tertiary-container text-label-caps rounded-full font-medium">CORDONED</span>
            </div>
          </div>
        </div>
        <div class="flex gap-sm">
          <button v-if="isCordoned" @click="handleUncordon" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
            <span class="material-symbols-outlined">lock_open</span> Uncordon
          </button>
          <button v-else @click="showCordonModal = true" class="flex items-center gap-sm px-md py-sm border border-outline-variant font-semibold rounded-lg hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">lock</span> Cordon
          </button>
          <button @click="showDrainModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
            <span class="material-symbols-outlined">output</span> Drain
          </button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'pods', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-12 gap-gutter">
      <div class="col-span-12 lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Resource Usage</h3>
          <div v-if="node.cpu != null || node.memory != null" class="grid grid-cols-2 gap-xl">
            <div>
              <ProgressBar :value="node.cpu || 0" size="lg" show-label label="CPU" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-2">{{ node.cpu != null ? node.cpu + '% allocated' : '—' }}</p>
              <p v-if="node.usedCpu != null" class="font-mono text-code-xs text-on-surface-variant/70 -mt-1">{{ formatCpu(node.usedCpu) }} / {{ formatCpu(node.allocCpu) }}</p>
            </div>
            <div>
              <ProgressBar :value="node.memory || 0" size="lg" show-label label="Memory" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-2">{{ node.memory != null ? node.memory + '% allocated' : '—' }}</p>
              <p v-if="node.usedMem != null" class="font-mono text-code-xs text-on-surface-variant/70 -mt-1">{{ formatMem(node.usedMem) }} / {{ formatMem(node.allocMem) }}</p>
            </div>
          </div>
          <div v-else class="flex items-center gap-sm text-on-surface-variant py-md">
            <span class="material-symbols-outlined">sensors_off</span>
            <span class="text-body-sm">指标不可用（集群未安装 metrics-server 或缺少 metrics 读取权限）</span>
          </div>
        </div>

        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg pb-md"><h3 class="text-headline-sm">Conditions</h3></div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Last Transition</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(val, key) in node.conditions" :key="key" class="hover:bg-surface-container-low/50">
                <td class="px-lg py-md text-body-md font-medium">{{ key }}</td>
                <td class="px-lg py-md">
                  <span class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full" :class="val ? 'bg-primary-container' : 'bg-error'"></span>
                    <span class="text-body-sm" :class="val ? 'text-primary' : 'text-error'">{{ val ? 'True' : 'False' }}</span>
                  </span>
                </td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ node.age }} ago</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="col-span-12 lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">System Info</h3>
          <div class="space-y-md">
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">OS</span><span class="text-body-sm font-medium">{{ node.os }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Kernel</span><span class="font-mono text-code-sm">{{ node.kernel }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Kubelet</span><span class="font-mono text-code-sm">{{ node.version }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Role</span><span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant">{{ node.roles }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Internal IP</span><span class="font-mono text-code-sm text-primary">{{ node.ip }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Age</span><span class="text-body-sm font-medium">{{ node.age }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Pods</span><span class="text-body-sm font-semibold text-primary">{{ nodePods.length }}</span></div>
            <div class="flex justify-between"><span class="text-body-sm text-on-surface-variant">Schedulable</span><span :class="isCordoned ? 'text-error' : 'text-primary'" class="text-body-sm font-semibold">{{ isCordoned ? 'No' : 'Yes' }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pods Tab -->
    <div v-if="activeTab === 'pods'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Pods on this Node ({{ nodePods.length }})</h3>
        </div>
        <table v-if="nodePods.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">CPU</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Restarts</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="p in nodePods" :key="p.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="$router.push(`/ns/${p.namespace}/pods/${p.name}`)">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">layers</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ p.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md"><span class="text-body-sm text-primary font-medium">{{ p.namespace }}</span></td>
              <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
              <td class="px-lg py-md font-mono text-code-sm">{{ p.cpu || '—' }}</td>
              <td class="px-lg py-md text-body-sm">{{ p.restarts }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">search_off</span>
          <p class="mt-sm">No pods running on this node</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="true" height="500px" />
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Node Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Node "{{ route.params.name }}" not found</p>
    <button @click="$router.push('/nodes')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Nodes</button>
  </div>

  <!-- Cordon Modal -->
  <Modal v-model="showCordonModal" title="Cordon Node" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to cordon <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-on-surface-variant mt-sm">No new pods will be scheduled on this node. Existing pods are not affected.</p>
    <template #actions>
      <button @click="showCordonModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCordon" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Cordon</button>
    </template>
  </Modal>

  <!-- Drain Modal -->
  <Modal v-model="showDrainModal" title="Drain Node" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to drain <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">All pods will be evicted from this node. This will cordone the node and gracefully terminate all pods.</p>
    <p class="text-body-sm text-on-surface-variant mt-sm">{{ nodePods.length }} pods will be affected.</p>
    <template #actions>
      <button @click="showDrainModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDrain" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Drain</button>
    </template>
  </Modal>
</template>
