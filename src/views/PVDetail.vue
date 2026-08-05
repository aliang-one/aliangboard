<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

const pv = computed(() => store.getPVByName(route.params.name))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/persistentvolumes/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('pv', pv.value),
})
const activeTab = ref('overview')

const claimParts = computed(() => (pv.value?.claim || '').split('/'))
const pvc = computed(() => {
  const [ns, nm] = claimParts.value
  return nm ? store.pvcList.find(p => p.name === nm && (!ns || p.namespace === ns)) : null
})
const sc = computed(() => pv.value?.storageClass ? store.getSCByName(pv.value.storageClass) : null)
const accessModeLabels = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }
</script>

<template>
  <section class="animate-fade-in" v-if="pv">
    <Breadcrumbs :items="[
      { label: 'Storage', route: '/storage' },
      { label: 'PersistentVolumes' },
      { label: pv.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pv.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pv.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pv.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pv.age }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">PersistentVolume Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">STATUS</p><StatusChip :status="pv.status" size="sm" /></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">CAPACITY</p><p class="font-mono text-code-sm text-primary font-semibold">{{ pv.capacity }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">ACCESS MODE</p><p class="text-body-md text-on-surface" :title="accessModeLabels[pv.accessModes]">{{ pv.accessModes }} · {{ accessModeLabels[pv.accessModes] || pv.accessModes }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">RECLAIM POLICY</p><p class="text-body-md text-on-surface">{{ pv.reclaimPolicy }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">STORAGECLASS</p><p class="text-body-md text-on-surface">{{ pv.storageClass || '—' }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">CLAIM</p><p class="font-mono text-code-sm" :class="pv.claim ? 'text-primary' : 'text-on-surface-variant'">{{ pv.claim || 'Available' }}</p></div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div v-if="pvc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bound Claim</h3>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">PVC</span>
            <button class="font-mono text-code-sm text-primary font-semibold hover:underline" @click="router.push({ name: 'NsPVCDetail', params: { namespace: pvc.namespace, name: pvc.name } })">{{ pvc.name }}</button>
          </div>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">Namespace</span><span class="text-body-md text-on-surface">{{ pvc.namespace }}</span>
          </div>
          <div class="flex justify-between items-center py-sm">
            <span class="text-body-sm text-on-surface-variant">Status</span><StatusChip :status="pvc.status" size="sm" />
          </div>
        </div>
        <div v-if="sc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">StorageClass</h3>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">Name</span>
            <button class="text-body-md text-primary font-semibold hover:underline" @click="router.push({ name: 'StorageClassDetail', params: { name: sc.name } })">{{ sc.name }}</button>
          </div>
          <div class="flex justify-between items-center py-sm">
            <span class="text-body-sm text-on-surface-variant">Provisioner</span><span class="font-mono text-code-sm text-on-surface-variant">{{ sc.provisioner }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">PersistentVolume Not Found</h2>
    <button @click="router.push('/storage')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Storage</button>
  </section>
</template>
