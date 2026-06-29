<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const store = useClusterStore()

// 搜索关键字
const search = ref('')
// 当前展开的 CRD name 集合
const expanded = ref(new Set())

function toggle(name) {
  const next = new Set(expanded.value)
  if (next.has(name)) {
    next.delete(name)
  } else {
    next.add(name)
  }
  expanded.value = next
}

const filteredCrds = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return store.crdList
  return store.crdList.filter(c =>
    c.name.toLowerCase().includes(kw) ||
    c.kind.toLowerCase().includes(kw) ||
    c.group.toLowerCase().includes(kw) ||
    (c.description || '').toLowerCase().includes(kw)
  )
})

const totalInstances = computed(() =>
  store.crdList.reduce((sum, c) => sum + (c.instances?.length || 0), 0)
)
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'Custom Resource Definitions' }
    ]" />

    <!-- 标题区 -->
    <div class="flex flex-col gap-sm mt-sm mb-xl">
      <div class="flex items-end justify-between gap-lg flex-wrap">
        <div>
          <h1 class="text-display-lg text-on-surface">自定义资源定义 (CRDs)</h1>
          <p class="text-body-lg text-on-surface-variant mt-1">
            管理集群中已注册的自定义资源定义及其实例。
          </p>
        </div>
        <div class="flex items-center gap-md">
          <div class="px-md py-sm bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card text-center">
            <p class="text-label-caps text-on-surface-variant">CRDS</p>
            <p class="text-headline-sm text-primary font-bold">{{ store.crdList.length }}</p>
          </div>
          <div class="px-md py-sm bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card text-center">
            <p class="text-label-caps text-on-surface-variant">INSTANCES</p>
            <p class="text-headline-sm text-primary font-bold">{{ totalInstances }}</p>
          </div>
        </div>
      </div>

      <!-- 搜索框 -->
      <div class="relative max-w-md mt-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
        <input
          v-model="search"
          type="text"
          placeholder="按 name / kind / group 搜索..."
          class="w-full pl-xl pr-md py-sm bg-surface-container-lowest border border-outline-variant rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary transition-colors"
        />
      </div>
    </div>

    <!-- 表格 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full">
        <thead>
          <tr class="border-b border-outline-variant bg-surface-container-low">
            <th class="w-10 px-md py-sm"></th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">NAME</th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">GROUP / VERSION</th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">KIND</th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">SCOPE</th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">INSTANCES</th>
            <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">DESCRIPTION</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="crd in filteredCrds" :key="crd.name">
            <!-- 主行 -->
            <tr
              class="border-b border-outline-variant cursor-pointer hover:bg-surface-container-low transition-colors"
              @click="toggle(crd.name)"
            >
              <td class="px-md py-md text-on-surface-variant">
                <span
                  class="material-symbols-outlined transition-transform duration-200"
                  :class="expanded.has(crd.name) ? 'rotate-90' : ''"
                >chevron_right</span>
              </td>
              <td class="px-md py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">extension</span>
                  <span class="font-mono text-code-md text-on-surface font-semibold">{{ crd.name }}</span>
                </div>
              </td>
              <td class="px-md py-md">
                <span class="font-mono text-code-sm text-on-surface-variant">{{ crd.group }}/{{ crd.version }}</span>
              </td>
              <td class="px-md py-md">
                <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-body-sm font-semibold rounded">{{ crd.kind }}</span>
              </td>
              <td class="px-md py-md">
                <span
                  v-if="crd.scope === 'Namespaced'"
                  class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary-container text-body-sm font-semibold rounded inline-flex items-center gap-1"
                >
                  <span class="material-symbols-outlined text-sm">folder</span> Namespaced
                </span>
                <span
                  v-else
                  class="px-2 py-0.5 bg-secondary-fixed/20 text-secondary text-body-sm font-semibold rounded inline-flex items-center gap-1"
                >
                  <span class="material-symbols-outlined text-sm">public</span> Cluster
                </span>
              </td>
              <td class="px-md py-md">
                <span class="font-mono text-code-md text-on-surface font-semibold">{{ crd.instances?.length || 0 }}</span>
              </td>
              <td class="px-md py-md max-w-xs">
                <span class="text-body-sm text-on-surface-variant line-clamp-1">{{ crd.description || '-' }}</span>
              </td>
            </tr>

            <!-- 展开行：instances -->
            <tr v-if="expanded.has(crd.name)" class="bg-surface-container-low">
              <td></td>
              <td colspan="6" class="px-md py-md">
                <div class="rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest">
                  <div class="flex items-center justify-between px-md py-sm bg-surface-container-low border-b border-outline-variant">
                    <div class="flex items-center gap-sm">
                      <span class="material-symbols-outlined text-primary text-lg">list_alt</span>
                      <span class="text-label-caps text-on-surface">INSTANCES</span>
                      <span class="text-body-sm text-on-surface-variant">({{ crd.kind }})</span>
                    </div>
                    <span class="text-body-sm text-on-surface-variant">{{ crd.instances?.length || 0 }} 个实例</span>
                  </div>
                  <table v-if="crd.instances && crd.instances.length" class="w-full">
                    <thead>
                      <tr class="border-b border-outline-variant">
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
                        <td class="px-md py-sm">
                          <span class="font-mono text-code-sm text-on-surface font-medium">{{ inst.name }}</span>
                        </td>
                        <td class="px-md py-sm">
                          <span v-if="inst.namespace" class="px-2 py-0.5 bg-surface-container rounded text-body-sm text-on-surface-variant border border-outline-variant">{{ inst.namespace }}</span>
                          <span v-else class="text-on-surface-variant text-body-sm">-</span>
                        </td>
                        <td class="px-md py-sm">
                          <StatusChip :status="inst.status || 'Unknown'" size="sm" />
                        </td>
                        <td class="px-md py-sm">
                          <span class="text-body-sm text-on-surface-variant font-mono text-code-sm">{{ inst.age }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="px-md py-lg text-center">
                    <span class="material-symbols-outlined text-3xl text-surface-container-high">inbox</span>
                    <p class="text-body-sm text-on-surface-variant mt-sm">该 CRD 暂无实例</p>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <!-- 空状态 -->
      <div v-if="!filteredCrds.length" class="px-md py-xxl text-center">
        <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
        <p class="text-body-md text-on-surface-variant mt-md">
          {{ search ? '没有匹配的 CRD' : '当前集群没有已注册的 CRD' }}
        </p>
      </div>
    </div>
  </section>
</template>
