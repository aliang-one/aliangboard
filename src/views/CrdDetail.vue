<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

const crd = computed(() => store.getCRDByName(route.params.name))

const activeTab = ref('overview')

const tabs = [
  { key: 'overview', label: 'Overview' },
  { key: 'instances', label: 'Instances' },
  { key: 'yaml', label: 'YAML' },
]

// store.generateYAML 暂不支持 crd，提供一个静态模板
const staticYaml = computed(() => {
  if (!crd.value) return ''
  const c = crd.value
  const plural = c.name.split('.')[0]
  return `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${c.name}
spec:
  group: ${c.group}
  names:
    kind: ${c.kind}
    listKind: ${c.kind}List
    plural: ${plural}
    singular: ${plural.replace(/s$/, '')}
  scope: ${c.scope}
  versions:
    - name: ${c.version}
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          description: "${c.description || ''}"
          properties:
            spec:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              x-kubernetes-preserve-unknown-fields: true
`
})
</script>

<template>
  <div class="animate-fade-in" v-if="crd">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'CRDs', route: '/crds' },
      { label: crd.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">extension</span>
        </div>
        <div>
          <div class="flex items-center gap-md">
            <h1 class="text-display-lg text-on-surface font-mono">{{ crd.name }}</h1>
            <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-body-sm font-semibold rounded">{{ crd.kind }}</span>
          </div>
          <div class="flex items-center gap-md mt-xs">
            <span class="font-mono text-code-sm text-on-surface-variant">{{ crd.group }}/{{ crd.version }}</span>
            <span class="text-on-surface-variant">·</span>
            <span
              class="text-body-sm font-semibold inline-flex items-center gap-1"
              :class="crd.scope === 'Namespaced' ? 'text-tertiary-container' : 'text-secondary'"
            >
              <span class="material-symbols-outlined text-sm">{{ crd.scope === 'Namespaced' ? 'folder' : 'public' }}</span>
              {{ crd.scope }}
            </span>
            <span class="text-on-surface-variant">·</span>
            <span class="text-body-sm text-on-surface-variant">{{ crd.instances?.length || 0 }} 个实例</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button
          @click="router.push('/crds')"
          class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-high transition-colors"
        >
          <span class="material-symbols-outlined">arrow_back</span> 返回列表
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">概览</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">GROUP</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ crd.group }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">VERSION</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ crd.version }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">KIND</p>
              <p class="text-body-md text-on-surface font-semibold">{{ crd.kind }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">SCOPE</p>
              <p class="text-body-md text-on-surface font-semibold">{{ crd.scope }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">NAMESPACED</p>
              <span class="material-symbols-outlined" :class="crd.namespaced ? 'text-primary' : 'text-outline-variant'">
                {{ crd.namespaced ? 'check_circle' : 'cancel' }}
              </span>
              <span class="ml-1 text-body-md" :class="crd.namespaced ? 'text-on-surface' : 'text-on-surface-variant'">
                {{ crd.namespaced ? '是' : '否' }}
              </span>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">FULL NAME</p>
              <p class="font-mono text-code-sm text-on-surface break-all">{{ crd.name }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">描述</h3>
          <p class="text-body-md text-on-surface-variant leading-relaxed">
            {{ crd.description || '暂无描述信息。' }}
          </p>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">实例统计</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">实例总数</span>
              <span class="font-mono text-code-md text-primary font-semibold">{{ crd.instances?.length || 0 }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Scope</span>
              <span class="text-body-md text-on-surface">{{ crd.scope }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Instances Tab -->
    <div v-if="activeTab === 'instances'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="flex items-center justify-between px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary">list_alt</span>
            <span class="text-headline-sm text-on-surface">{{ crd.kind }} 实例</span>
          </div>
          <span class="text-body-sm text-on-surface-variant">{{ crd.instances?.length || 0 }} 个实例</span>
        </div>
        <table v-if="crd.instances && crd.instances.length" class="w-full">
          <thead>
            <tr class="border-b border-outline-variant bg-surface-container-low">
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">NAME</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">NAMESPACE</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">STATUS</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">AGE</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="inst in crd.instances"
              :key="inst.name + (inst.namespace || '')"
              class="border-b border-outline-variant/30 last:border-0 hover:bg-surface-container-low transition-colors"
            >
              <td class="px-md py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-on-surface-variant text-lg">deployed_code</span>
                  <span class="font-mono text-code-md text-on-surface font-semibold">{{ inst.name }}</span>
                </div>
              </td>
              <td class="px-md py-md">
                <span v-if="inst.namespace" class="px-2 py-0.5 bg-surface-container rounded text-body-sm text-on-surface-variant border border-outline-variant">{{ inst.namespace }}</span>
                <span v-else class="text-on-surface-variant text-body-sm">-</span>
              </td>
              <td class="px-md py-md">
                <StatusChip :status="inst.status || 'Unknown'" />
              </td>
              <td class="px-md py-md">
                <span class="text-body-sm text-on-surface-variant font-mono text-code-sm">{{ inst.age }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="px-md py-xxl text-center">
          <span class="material-symbols-outlined text-5xl text-surface-container-high">inbox</span>
          <p class="text-body-md text-on-surface-variant mt-md">该 CRD 暂无实例</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="staticYaml" :readonly="false" height="560px" @save="() => {}" />
    </div>
  </div>

  <!-- Not Found 兜底 -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">CRD 未找到</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">找不到名为 <span class="font-mono text-on-surface font-semibold">{{ route.params.name }}</span> 的自定义资源定义。</p>
    <button
      @click="router.push('/crds')"
      class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 transition-opacity"
    >返回 CRD 列表</button>
  </div>
</template>
