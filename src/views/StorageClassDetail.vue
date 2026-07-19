<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

const sc = computed(() => store.getSCByName(route.params.name))
const yaml = computed(() => store.generateYAML('storageclass', sc.value))
const activeTab = ref('overview')

const paramMap = computed(() => Object.fromEntries(
  String(sc.value?.parameters || '').split(',').map(kv => kv.split('=')).filter(([k]) => k).map(([k, v]) => [k.trim(), (v || '').trim()])
))
const boundPVCs = computed(() => store.pvcList.filter(p => p.storageClass === sc.value?.name))
</script>

<template>
  <section class="animate-fade-in" v-if="sc">
    <Breadcrumbs :items="[
      { label: 'Storage', route: '/storage' },
      { label: 'StorageClasses' },
      { label: sc.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ sc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span v-if="sc.default" class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant font-mono">{{ sc.provisioner }}</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ sc.age }}</span>
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
          <h3 class="text-headline-sm mb-lg">StorageClass Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">PROVISIONER</p><p class="font-mono text-code-sm text-on-surface">{{ sc.provisioner }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">RECLAIM POLICY</p><p class="text-body-md text-on-surface">{{ sc.reclaimPolicy }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">DEFAULT</p><p class="text-body-md text-on-surface">{{ sc.default ? 'Yes' : 'No' }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">AGE</p><p class="text-body-md text-on-surface">{{ sc.age }}</p></div>
          </div>
          <div v-if="Object.keys(paramMap).length" class="mt-lg">
            <p class="text-label-caps text-on-surface-variant mb-sm">PARAMETERS</p>
            <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
              <div v-for="(v, k) in paramMap" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface">{{ v }}</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bound PVCs ({{ boundPVCs.length }})</h3>
          <div v-if="boundPVCs.length" class="flex flex-col gap-sm">
            <button v-for="p in boundPVCs" :key="p.name" @click="router.push({ name: 'NsPVCDetail', params: { namespace: p.namespace, name: p.name } })"
              class="flex items-center justify-between px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors">
              <span class="font-mono text-code-sm text-primary">{{ p.name }}</span>
              <span class="text-body-sm text-on-surface-variant">{{ p.namespace }} · {{ p.capacity }}</span>
            </button>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">No PVCs bound</p>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">StorageClass Not Found</h2>
    <button @click="router.push('/storage')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Storage</button>
  </section>
</template>
