<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import { useResourceDetail } from '@/composables/useK8sQuery'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const pcDetail = useResourceDetail({
  key: ['cluster', cid.value, 'priorityclasses', route.params.name],
  fetcher: () => store.fetchPriorityClass(route.params.name),
  mock: store.getPriorityClassByName(route.params.name),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const pc = computed(() => pcDetail.data.value ?? store.getPriorityClassByName(route.params.name))
const yaml = computed(() => store.generateExtraYAML('priorityclass', pc.value))
const activeTab = ref('overview')
</script>

<template>
  <section class="animate-fade-in" v-if="pc">
    <Breadcrumbs :items="[
      { label: 'PriorityClasses', route: '/priorityclasses' },
      { label: pc.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary-container text-3xl">flag</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">value: {{ pc.value }}</span>
            <span v-if="pc.globalDefault" class="px-2.5 py-0.5 bg-secondary-container/20 text-secondary text-label-caps rounded-full font-medium">GLOBAL DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pc.age }}</span>
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

    <div v-if="activeTab === 'overview'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card max-w-2xl">
        <h3 class="text-headline-sm mb-lg">PriorityClass Details</h3>
        <div class="grid grid-cols-2 gap-md">
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">VALUE</p><p class="font-mono text-code-sm text-primary font-semibold">{{ pc.value }}</p></div>
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">GLOBAL DEFAULT</p><p class="text-body-md text-on-surface">{{ pc.globalDefault ? 'true' : 'false' }}</p></div>
          <div class="p-md rounded-lg bg-surface-container-low col-span-2"><p class="text-label-caps text-on-surface-variant mb-xs">DESCRIPTION</p><p class="text-body-md text-on-surface">{{ pc.description || '—' }}</p></div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">PriorityClass Not Found</h2>
    <button @click="router.push('/priorityclasses')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to PriorityClasses</button>
  </section>
</template>
