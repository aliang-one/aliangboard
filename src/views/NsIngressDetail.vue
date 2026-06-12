<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const ing = computed(() => store.getIngressByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('ingress', ing.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)

function handleDelete() {
  store.deleteIngress(route.params.name, route.params.namespace)
  router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })
}

const allRules = computed(() => {
  if (!ing.value?.rules) return []
  return ing.value.rules.flatMap(r =>
    (r.http?.paths || []).map(p => ({
      host: r.host,
      path: p.path,
      pathType: p.pathType,
      serviceName: p.backend?.serviceName,
      servicePort: p.backend?.servicePort,
    }))
  )
})

const allAnnotations = computed(() => {
  if (!ing.value?.annotations) return []
  return Object.entries(ing.value.annotations)
})
</script>

<template>
  <div class="animate-fade-in" v-if="ing">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Ingress', route: `/ns/${route.params.namespace}/ingress` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">language</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ ing.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">Ingress</span>
            <span class="flex items-center gap-xs text-body-sm" :class="ing.tls ? 'text-primary' : 'text-on-surface-variant'">
              <span class="material-symbols-outlined text-lg">{{ ing.tls ? 'lock' : 'lock_open' }}</span>
              {{ ing.tls ? 'TLS Enabled' : 'No TLS' }}
            </span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ ing.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'rules', 'annotations', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Ingress Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Hosts</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ ing.hosts }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Ingress Class</p>
              <p class="text-body-md text-on-surface">{{ ing.className || 'nginx' }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">TLS</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg" :class="ing.tls ? 'text-primary' : 'text-on-surface-variant'">{{ ing.tls ? 'lock' : 'lock_open' }}</span>
                <span class="text-body-md" :class="ing.tls ? 'text-primary font-semibold' : 'text-on-surface-variant'">{{ ing.tls ? 'Enabled' : 'Disabled' }}</span>
              </div>
            </div>
            <div v-if="ing.tlsSecret" class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">TLS Secret</p>
              <p class="font-mono text-code-sm text-on-surface">{{ ing.tlsSecret }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Rules</span>
              <span class="text-body-md font-semibold text-primary">{{ allRules.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Annotations</span>
              <span class="text-body-md font-semibold text-on-surface">{{ allAnnotations.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ ing.age }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Rules Tab -->
    <div v-if="activeTab === 'rules'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">Routing Rules ({{ allRules.length }})</h3>
        </div>
        <table v-if="allRules.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Host</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Path</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Path Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Backend Service</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Port</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(rule, idx) in allRules" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md"><span class="font-mono text-code-sm text-primary font-semibold">{{ rule.host }}</span></td>
              <td class="px-lg py-md"><span class="font-mono text-code-sm">{{ rule.path }}</span></td>
              <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ rule.pathType }}</span></td>
              <td class="px-lg py-md">
                <span class="font-mono text-code-sm text-secondary font-medium cursor-pointer hover:text-primary" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: rule.serviceName } })">{{ rule.serviceName }}</span>
              </td>
              <td class="px-lg py-md font-mono text-code-sm">{{ rule.servicePort }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Annotations Tab -->
    <div v-if="activeTab === 'annotations'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <h3 class="text-headline-sm mb-md">Annotations</h3>
        <div class="flex flex-col gap-sm">
          <div v-for="([key, val], idx) in allAnnotations" :key="idx" class="flex items-start gap-md p-md rounded-lg bg-surface-container-low">
            <span class="font-mono text-code-sm text-primary font-semibold min-w-0 break-all">{{ key }}</span>
            <span class="text-body-sm text-on-surface-variant flex-1 min-w-0 break-all">{{ val }}</span>
          </div>
          <p v-if="!allAnnotations.length" class="text-on-surface-variant text-body-sm text-center py-md">No annotations</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="() => {}" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Ingress Not Found</h2>
    <button @click="router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Ingress</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Ingress" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ingress <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will remove all routing rules. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
