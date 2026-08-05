<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import PodCard from '@/components/common/PodCard.vue'

const route = useRoute()
const store = useClusterStore()
const node = computed(() => store.getNodeByName(route.params.name))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/nodes/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('node', node.value),
})

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
    <div class="mb-md">
      <Breadcrumbs :items="[
        { label: 'Nodes', route: '/nodes' },
        { label: node.name }
      ]" />
      <div class="flex items-center justify-between mt-sm mb-md">
        <div class="flex items-center gap-md">
          <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-2xl">dns</span>
          </div>
          <div>
            <h1 class="text-headline-md text-on-surface font-bold">{{ node.name }}</h1>
            <div class="flex items-center gap-sm mt-xs">
              <StatusChip :status="node.status === 'Ready' ? 'Ready' : 'NotReady'" />
              <span class="text-xs text-on-surface-variant">{{ node.ip }}</span>
              <span class="text-xs text-on-surface-variant">{{ node.os }} · {{ node.kernel }}</span>
              <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant capitalize">{{ node.roles }}</span>
              <span v-if="node.arch" class="text-xs text-on-surface-variant">{{ node.arch }}</span>
              <span v-if="node.containerRuntimeShort" class="font-mono text-xs text-on-surface-variant">{{ node.containerRuntimeShort }}</span>
              <span v-if="isCordoned" class="px-1.5 py-0.5 bg-tertiary-container/10 text-tertiary-container text-xs rounded font-medium">CORDONED</span>
            </div>
          </div>
        </div>
        <div class="flex gap-xs">
          <button v-if="isCordoned" @click="handleUncordon" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-colors">
            <span class="material-symbols-outlined text-base">lock_open</span> Uncordon
          </button>
          <button v-else @click="showCordonModal = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined text-base">lock</span> Cordon
          </button>
          <button @click="showDrainModal = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">
            <span class="material-symbols-outlined text-base">output</span> Drain
          </button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in ['overview', 'pods', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-lg py-2 text-body-sm font-medium capitalize transition-colors relative"
        :class="activeTab === tab ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'">
        {{ tab }}
        <span v-if="activeTab === tab" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-12 gap-md">
      <div class="col-span-12 lg:col-span-8 flex flex-col gap-sm">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">monitoring</span>
            <span class="text-body-sm font-semibold">Resource Usage</span>
          </div>
          <div v-if="node.cpu != null || node.memory != null" class="grid grid-cols-3 gap-md p-md">
            <div>
              <ProgressBar :value="node.cpu || 0" size="lg" show-label label="CPU" />
              <p class="font-mono text-xs text-on-surface-variant mt-1">{{ node.cpu != null ? node.cpu + '% allocated' : '—' }}</p>
              <p v-if="node.usedCpu != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatCpu(node.usedCpu) }} / {{ formatCpu(node.allocCpu) }}</p>
            </div>
            <div>
              <ProgressBar :value="node.memory || 0" size="lg" show-label label="Memory" />
              <p class="font-mono text-xs text-on-surface-variant mt-1">{{ node.memory != null ? node.memory + '% allocated' : '—' }}</p>
              <p v-if="node.usedMem != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatMem(node.usedMem) }} / {{ formatMem(node.allocMem) }}</p>
            </div>
            <div>
              <ProgressBar :value="node.podCapacity ? Math.min(100, Math.round(((node.podCount ?? 0) / node.podCapacity) * 100)) : 0" size="lg" show-label label="Pods" />
              <p class="font-mono text-xs text-on-surface-variant mt-1">{{ node.podCapacity ? Math.min(100, Math.round(((node.podCount ?? 0) / node.podCapacity) * 100)) + '% used' : '—' }}</p>
              <p class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ node.podCount ?? 0 }} / {{ node.podCapacity ?? '—' }}</p>
            </div>
          </div>
          <div v-else class="flex items-center gap-sm text-on-surface-variant p-md">
            <span class="material-symbols-outlined text-lg">sensors_off</span>
            <span class="text-body-sm">指标不可用（集群未安装 metrics-server 或缺少 metrics 读取权限）</span>
          </div>
        </div>

        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">checklist</span>
            <span class="text-body-sm font-semibold">Conditions</span>
          </div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low/50 border-b border-outline-variant">
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Type</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Status</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Last Transition</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              <tr v-for="(val, key) in node.conditions" :key="key" class="hover:bg-surface-container-low/40">
                <td class="px-md py-2 text-body-sm font-medium">{{ key }}</td>
                <td class="px-md py-2">
                  <span class="flex items-center gap-xs">
                    <span class="w-1.5 h-1.5 rounded-full" :class="val ? 'bg-primary-container' : 'bg-error'"></span>
                    <span class="text-xs" :class="val ? 'text-primary' : 'text-error'">{{ val ? 'True' : 'False' }}</span>
                  </span>
                </td>
                <td class="px-md py-2 text-xs text-on-surface-variant">{{ node.age }} ago</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="col-span-12 lg:col-span-4 flex flex-col gap-sm">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">info</span>
            <span class="text-body-sm font-semibold">System Info</span>
          </div>
          <div class="px-md py-sm space-y-sm">
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">OS</span><span class="text-body-sm font-medium">{{ node.os }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Kernel</span><span class="font-mono text-xs">{{ node.kernel }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Kubelet</span><span class="font-mono text-xs">{{ node.version }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Container Runtime</span><span class="font-mono text-xs">{{ node.containerRuntimeShort || node.containerRuntime || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Architecture</span><span class="text-body-sm font-medium">{{ node.arch || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">OS Type</span><span class="text-body-sm font-medium capitalize">{{ node.osType || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Role</span><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant">{{ node.roles }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Internal IP</span><span class="font-mono text-xs text-primary">{{ node.ip }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">External IP</span><span class="font-mono text-xs text-primary">{{ node.externalIp || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Pod CIDR</span><span class="font-mono text-xs">{{ node.podCIDR || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Age</span><span class="text-body-sm font-medium">{{ node.age }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Pods</span><span class="text-body-sm font-semibold text-primary">{{ nodePods.length }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Schedulable</span><span :class="isCordoned ? 'text-error' : 'text-primary'" class="text-body-sm font-semibold">{{ isCordoned ? 'No' : 'Yes' }}</span></div>
          </div>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">block</span>
            <span class="text-body-sm font-semibold">Taints</span>
            <span class="text-xs text-on-surface-variant ml-auto">{{ node.taintCount ?? 0 }}</span>
          </div>
          <div v-if="node.taints && node.taints.length" class="px-md py-sm space-y-sm">
            <div v-for="(t, i) in node.taints" :key="i" class="flex justify-between gap-md">
              <span class="font-mono text-xs text-on-surface truncate">{{ t.key }}{{ t.value ? '=' + t.value : '' }}</span>
              <span class="px-1.5 py-0.5 bg-tertiary-container/20 text-tertiary-container text-xs rounded whitespace-nowrap">{{ t.effect }}</span>
            </div>
          </div>
          <div v-else class="px-md py-sm text-xs text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base">check_circle</span> No taints
          </div>
        </div>
      </div>
    </div>

    <!-- Pods Tab -->
    <div v-if="activeTab === 'pods'">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">view_in_ar</span>
          <span class="text-body-sm font-semibold">Pods on this Node</span>
          <span class="text-xs text-on-surface-variant ml-auto">{{ nodePods.length }}</span>
        </div>
        <div v-if="nodePods.length" class="p-sm flex flex-col gap-xs max-h-[60vh] overflow-y-auto">
          <PodCard v-for="p in nodePods" :key="p.name" :pod="p" show-namespace @click="(pod) => $router.push(`/ns/${pod.namespace}/pods/${pod.name}`)" />
        </div>
        <div v-else class="py-md text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-2xl">search_off</span>
          <p class="text-body-sm mt-xs">No pods running on this node</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="true" height="500px" />
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xl">
    <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface font-bold mt-md">Node Not Found</h2>
    <p class="text-body-sm text-on-surface-variant mt-xs">Node "{{ route.params.name }}" not found</p>
    <button @click="$router.push('/nodes')" class="mt-md px-lg py-1.5 bg-primary text-on-primary rounded-lg font-semibold text-body-sm">Back to Nodes</button>
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
