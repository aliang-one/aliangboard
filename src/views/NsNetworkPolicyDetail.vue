<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const np = computed(() => store.getNetworkPolicyByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('networkpolicy', np.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)

// Flatten rule peers for display
function describePeer(peer) {
  if (!peer) return '-'
  if (peer.type === 'namespaceSelector') {
    const labels = peer.matchLabels ? Object.entries(peer.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : 'all namespaces'
    return `Namespace: ${labels}`
  }
  if (peer.type === 'podSelector') {
    const labels = peer.matchLabels ? Object.entries(peer.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : 'all pods'
    return `Pod: ${labels}`
  }
  return peer.type || '-'
}

function describePorts(ports) {
  if (!ports || !ports.length) return 'All Ports'
  return ports.map(p => `${p.port}/${p.protocol || 'TCP'}`).join(', ')
}

function handleDelete() {
  store.deleteNetworkPolicy(route.params.name, route.params.namespace)
  router.push({ name: 'NsNetworkPolicies', params: { namespace: route.params.namespace } })
}

// === 结构化编辑 ===
const showEditModal = ref(false)
const editPodSelector = ref([])
const editIngress = ref(false)
const editEgress = ref(false)

function openEdit() {
  editPodSelector.value = Object.entries(np.value.podSelector || {}).map(([key, value]) => ({ key, value }))
  editIngress.value = (np.value.policyTypes || []).includes('Ingress')
  editEgress.value = (np.value.policyTypes || []).includes('Egress')
  showEditModal.value = true
}

function addPodSelectorRow() {
  editPodSelector.value.push({ key: '', value: '' })
}

function removePodSelectorRow(idx) {
  editPodSelector.value.splice(idx, 1)
}

function saveEdit() {
  const podSelector = {}
  for (const entry of editPodSelector.value) {
    if (entry.key.trim()) {
      podSelector[entry.key.trim()] = entry.value
    }
  }
  const policyTypes = []
  if (editIngress.value) policyTypes.push('Ingress')
  if (editEgress.value) policyTypes.push('Egress')
  store.updateNetworkPolicy(route.params.name, route.params.namespace, { podSelector, policyTypes })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="np">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'NetworkPolicies', route: `/ns/${route.params.namespace}/networkpolicies` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">shield</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ np.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">NetworkPolicy</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ np.age }}</span>
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ np.namespace }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'ingress rules', 'egress rules', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <!-- Pod Selector -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Pod Selector</h3>
          <div v-if="Object.keys(np.podSelector || {}).length > 0" class="flex flex-wrap gap-sm">
            <span v-for="(val, key) in np.podSelector" :key="key"
              class="px-md py-xs bg-primary-container/10 text-primary text-body-sm rounded-full border border-primary/20">
              <span class="font-semibold">{{ key }}</span>: {{ val }}
            </span>
          </div>
          <div v-else class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-on-surface-variant">select_all</span>
            <span class="text-body-md text-on-surface-variant">Applies to <span class="font-semibold text-on-surface">all pods</span> in this namespace</span>
          </div>
        </div>

        <!-- Policy Types -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Policy Types</h3>
          <div class="flex gap-md">
            <div v-for="pt in np.policyTypes" :key="pt" class="flex-1 p-md rounded-lg border"
              :class="pt === 'Ingress' ? 'bg-primary-container/5 border-primary/20' : 'bg-tertiary-container/5 border-tertiary/20'">
              <div class="flex items-center gap-sm mb-sm">
                <span class="material-symbols-outlined text-xl" :class="pt === 'Ingress' ? 'text-primary' : 'text-tertiary'">
                  {{ pt === 'Ingress' ? 'arrow_downward' : 'arrow_upward' }}
                </span>
                <span class="text-body-md font-semibold" :class="pt === 'Ingress' ? 'text-primary' : 'text-tertiary'">{{ pt }}</span>
              </div>
              <p class="text-body-sm text-on-surface-variant">
                <span v-if="pt === 'Ingress'">{{ (np.ingressRules || []).length }} ingress rule(s) defined</span>
                <span v-else>{{ (np.egressRules || []).length }} egress rule(s) defined</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Policy Types</span>
              <span class="text-body-md font-semibold text-primary">{{ (np.policyTypes || []).join(', ') }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Ingress Rules</span>
              <span class="text-body-md font-semibold" :class="(np.ingressRules || []).length > 0 ? 'text-primary' : 'text-on-surface'">{{ (np.ingressRules || []).length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Egress Rules</span>
              <span class="text-body-md font-semibold" :class="(np.egressRules || []).length > 0 ? 'text-tertiary' : 'text-on-surface'">{{ (np.egressRules || []).length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Pod Selector</span>
              <span class="text-body-md text-on-surface">{{ Object.keys(np.podSelector || {}).length === 0 ? 'All Pods' : Object.keys(np.podSelector).length + ' label(s)' }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ np.age }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Ingress Rules Tab -->
    <div v-if="activeTab === 'ingress rules'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Ingress Rules ({{ (np.ingressRules || []).length }})</h3>
        </div>
        <table v-if="(np.ingressRules || []).length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">#</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">From</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Ports</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(rule, idx) in np.ingressRules" :key="idx" class="hover:bg-surface-container-low/30 transition-colors">
              <td class="px-lg py-md">
                <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary-container/10 text-primary text-body-sm font-bold">{{ idx + 1 }}</span>
              </td>
              <td class="px-lg py-md">
                <div class="flex flex-col gap-xs">
                  <div v-for="(peer, pIdx) in (rule.from || [])" :key="pIdx" class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-sm" :class="peer.type === 'namespaceSelector' ? 'text-primary' : 'text-tertiary'">
                      {{ peer.type === 'namespaceSelector' ? 'grid_view' : 'layers' }}
                    </span>
                    <span class="text-body-sm text-on-surface">{{ describePeer(peer) }}</span>
                  </div>
                  <span v-if="!rule.from || rule.from.length === 0" class="text-body-sm text-on-surface-variant">No from rules (blocks all ingress)</span>
                </div>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ describePorts(rule.ports) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">block</span>
          <p class="mt-sm">No ingress rules defined. All ingress traffic is {{ np.policyTypes.includes('Ingress') ? 'blocked' : 'allowed' }}.</p>
        </div>
      </div>
    </div>

    <!-- Egress Rules Tab -->
    <div v-if="activeTab === 'egress rules'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Egress Rules ({{ (np.egressRules || []).length }})</h3>
        </div>
        <table v-if="(np.egressRules || []).length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">#</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">To</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Ports</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(rule, idx) in np.egressRules" :key="idx" class="hover:bg-surface-container-low/30 transition-colors">
              <td class="px-lg py-md">
                <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-tertiary-container/10 text-tertiary text-body-sm font-bold">{{ idx + 1 }}</span>
              </td>
              <td class="px-lg py-md">
                <div class="flex flex-col gap-xs">
                  <div v-for="(peer, pIdx) in (rule.to || [])" :key="pIdx" class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-sm" :class="peer.type === 'namespaceSelector' ? 'text-primary' : 'text-tertiary'">
                      {{ peer.type === 'namespaceSelector' ? 'grid_view' : 'layers' }}
                    </span>
                    <span class="text-body-sm text-on-surface">{{ describePeer(peer) }}</span>
                  </div>
                  <span v-if="!rule.to || rule.to.length === 0" class="text-body-sm text-on-surface-variant">No to rules (blocks all egress)</span>
                </div>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ describePorts(rule.ports) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">block</span>
          <p class="mt-sm">No egress rules defined. All egress traffic is {{ np.policyTypes.includes('Egress') ? 'blocked' : 'allowed' }}.</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">NetworkPolicy Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">NetworkPolicy "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsNetworkPolicies', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to NetworkPolicies</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete NetworkPolicy" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete NetworkPolicy <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing this policy may expose pods to unintended network traffic. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit NetworkPolicy" width="max-w-xl">
    <div class="flex flex-col gap-lg">
      <!-- Pod Selector -->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Pod Selector</label>
          <span class="text-body-xs text-on-surface-variant">空表示所有 Pod</span>
        </div>
        <div class="flex flex-col gap-sm">
          <div v-for="(entry, idx) in editPodSelector" :key="idx" class="flex items-center gap-sm">
            <input v-model="entry.key" placeholder="label-key"
              class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
            <span class="text-on-surface-variant">=</span>
            <input v-model="entry.value" placeholder="label-value"
              class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
            <button @click="removePodSelectorRow(idx)"
              class="flex items-center justify-center w-9 h-9 border border-outline-variant rounded-lg text-on-surface-variant hover:bg-error-container/10 hover:text-error hover:border-error/30 transition-colors">
              <span class="material-symbols-outlined">remove</span>
            </button>
          </div>
          <div v-if="editPodSelector.length === 0" class="text-body-sm text-on-surface-variant italic py-sm">
            无标签 — 策略将应用于该命名空间下的所有 Pod
          </div>
        </div>
        <button @click="addPodSelectorRow"
          class="mt-sm flex items-center gap-xs px-md py-xs border border-outline-variant rounded-lg text-body-sm text-primary hover:bg-primary-container/10 transition-colors">
          <span class="material-symbols-outlined text-base">add</span> Add Label
        </button>
      </div>

      <!-- Policy Types -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Policy Types</label>
        <div class="flex gap-md">
          <label class="flex-1 flex items-center gap-sm px-md py-sm bg-surface-container-low border border-outline-variant rounded-lg cursor-pointer">
            <input type="checkbox" v-model="editIngress" class="w-4 h-4 accent-primary" />
            <span class="text-body-md text-on-surface">Ingress</span>
          </label>
          <label class="flex-1 flex items-center gap-sm px-md py-sm bg-surface-container-low border border-outline-variant rounded-lg cursor-pointer">
            <input type="checkbox" v-model="editEgress" class="w-4 h-4 accent-primary" />
            <span class="text-body-md text-on-surface">Egress</span>
          </label>
        </div>
      </div>

      <p class="text-body-sm text-on-surface-variant">
        <span class="material-symbols-outlined text-sm align-middle mr-xs">info</span>
        Ingress/Egress 规则请在 YAML 标签页编辑
      </p>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>
</template>
