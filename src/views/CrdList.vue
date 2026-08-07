<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { useResourceList } from '@/composables/useK8sQuery'

const { t } = useI18n()
const store = useClusterStore()

const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const crdsQuery = useResourceList({
  key: ['cluster', cid.value, 'crds'],
  fetcher: () => store.fetchCRDs(),
  mock: store.crdList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const crds = computed(() => crdsQuery.data.value || [])

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
  if (!kw) return crds
  return crds.filter(c =>
    c.name.toLowerCase().includes(kw) ||
    c.kind.toLowerCase().includes(kw) ||
    c.group.toLowerCase().includes(kw) ||
    (c.description || '').toLowerCase().includes(kw)
  )
})

const { currentPage, pageSize, paginated, total } = usePagination(filteredCrds, { resetDeps: [search] })
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'Custom Resource Definitions' }
    ]" />

    <!-- 标题区 -->
    <div class="flex flex-col gap-sm mt-sm mb-md">
      <div class="flex items-end justify-between gap-md flex-wrap">
        <div>
          <h1 class="text-headline-md text-on-surface font-bold">{{ $t('admin.crdList.title') }}</h1>
          <p class="text-body-sm text-on-surface-variant mt-xs">
            {{ $t('admin.crdList.subtitle') }}
          </p>
        </div>
        <div class="flex items-center gap-sm">
          <div class="px-md py-xs bg-surface-container-lowest border border-outline-variant rounded-lg text-center">
            <p class="text-xs text-on-surface-variant">{{ $t('admin.crdList.crdsLabel') }}</p>
            <p class="text-body-sm text-primary font-bold">{{ crds.length }}</p>
          </div>
          <div class="px-md py-xs bg-surface-container-lowest border border-outline-variant rounded-lg text-center">
            <p class="text-xs text-on-surface-variant">{{ $t('admin.crdList.instancesLabel') }}</p>
            <p class="text-body-sm text-primary font-bold">—</p>
          </div>
        </div>
      </div>

      <!-- 搜索框 -->
      <div class="relative max-w-md mt-sm">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
        <input
          v-model="search"
          type="text"
          :placeholder="$t('admin.crdList.searchPlaceholder')"
          class="w-full pl-xl pr-md py-1.5 bg-surface-container-lowest border border-outline-variant rounded-lg text-body-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary transition-colors"
        />
      </div>
    </div>

    <!-- 表格 -->
    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full">
        <thead>
          <tr class="border-b border-outline-variant bg-surface-container-low/50">
            <th class="w-10 px-md py-2"></th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thName') }}</th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thGroupVersion') }}</th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thKind') }}</th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thScope') }}</th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thInstances') }}</th>
            <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thDescription') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="crd in paginated" :key="crd.name">
            <!-- 主行 -->
            <tr
              class="border-b border-outline-variant/15 cursor-pointer hover:bg-surface-container-low/40 transition-colors"
              @click="toggle(crd.name)"
            >
              <td class="px-md py-2 text-on-surface-variant">
                <span
                  class="material-symbols-outlined text-base transition-transform duration-200"
                  :class="expanded.has(crd.name) ? 'rotate-90' : ''"
                >chevron_right</span>
              </td>
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-base">extension</span>
                  <span class="font-mono text-code-sm text-on-surface font-semibold">{{ crd.name }}</span>
                </div>
              </td>
              <td class="px-md py-2">
                <span class="font-mono text-code-sm text-on-surface-variant">{{ crd.group }}/{{ crd.version }}</span>
              </td>
              <td class="px-md py-2">
                <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-xs font-semibold rounded">{{ crd.kind }}</span>
              </td>
              <td class="px-md py-2">
                <span
                  v-if="crd.scope === 'Namespaced'"
                  class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary-container text-xs font-semibold rounded inline-flex items-center gap-1"
                >
                  <span class="material-symbols-outlined text-xs">folder</span> {{ $t('admin.crdList.namespaced') }}
                </span>
                <span
                  v-else
                  class="px-2 py-0.5 bg-secondary-fixed/20 text-secondary text-xs font-semibold rounded inline-flex items-center gap-1"
                >
                  <span class="material-symbols-outlined text-xs">public</span> {{ $t('admin.crdList.cluster') }}
                </span>
              </td>
              <td class="px-md py-2">
                <span class="font-mono text-code-sm text-on-surface font-semibold">{{ crd.instances?.length || 0 }}</span>
              </td>
              <td class="px-md py-2 max-w-xs">
                <span class="text-xs text-on-surface-variant line-clamp-1">{{ crd.description || '-' }}</span>
              </td>
            </tr>

            <!-- 展开行：instances -->
            <tr v-if="expanded.has(crd.name)" class="bg-surface-container-low/40">
              <td></td>
              <td colspan="6" class="px-md py-2">
                <div class="rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest">
                  <div class="flex items-center justify-between px-md py-2 bg-surface-container-low/50 border-b border-outline-variant/50">
                    <div class="flex items-center gap-sm">
                      <span class="material-symbols-outlined text-primary text-base">list_alt</span>
                      <span class="text-xs font-medium text-on-surface">{{ $t('admin.crdList.instancesTitle') }}</span>
                      <span class="text-xs text-on-surface-variant">({{ crd.kind }})</span>
                    </div>
                    <span class="text-xs text-on-surface-variant">{{ $t('admin.crdList.instancesCount', { n: crd.instances?.length || 0 }) }}</span>
                  </div>
                  <table v-if="crd.instances && crd.instances.length" class="w-full">
                    <thead>
                      <tr class="border-b border-outline-variant/50 bg-surface-container-low/30">
                        <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thInstanceName') }}</th>
                        <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thNamespace') }}</th>
                        <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thStatus') }}</th>
                        <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('admin.crdList.thAge') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="inst in crd.instances"
                        :key="inst.name + (inst.namespace || '')"
                        class="border-b border-outline-variant/15 last:border-0 hover:bg-surface-container-low/40 transition-colors"
                      >
                        <td class="px-md py-2">
                          <span class="font-mono text-code-sm text-on-surface font-medium">{{ inst.name }}</span>
                        </td>
                        <td class="px-md py-2">
                          <span v-if="inst.namespace" class="px-2 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ inst.namespace }}</span>
                          <span v-else class="text-on-surface-variant text-xs">-</span>
                        </td>
                        <td class="px-md py-2">
                          <StatusChip :status="inst.status || 'Unknown'" size="sm" />
                        </td>
                        <td class="px-md py-2">
                          <span class="text-xs text-on-surface-variant font-mono text-code-sm">{{ inst.age }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="px-md py-md text-center">
                    <span class="material-symbols-outlined text-2xl text-surface-container-high">inbox</span>
                    <p class="text-xs text-on-surface-variant mt-xs">{{ $t('admin.crdList.noInstances') }}</p>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>

      <!-- 空状态 -->
      <div v-if="!filteredCrds.length" class="px-md py-md text-center">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
        <p class="text-body-sm text-on-surface-variant mt-xs">
          {{ search ? $t('admin.crdList.noMatchSearch') : $t('admin.crdList.noCrds') }}
        </p>
      </div>
    </div>
  </section>
</template>
