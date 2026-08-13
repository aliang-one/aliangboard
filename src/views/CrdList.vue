<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useI18n } from 'vue-i18n'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { useResourceList } from '@/composables/useK8sQuery'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('crds'))
const store = useClusterStore()

const cid = computed(() => (store.currentCluster || 'cluster'))
const crdsQuery = useResourceList({
  key: ['cluster', cid, 'crds'],
  fetcher: () => store.fetchCRDs(),
  options: { refetchInterval: 30000 },
})
const crds = computed(() => crdsQuery.data.value || [])

// 搜索关键字
const search = ref('')

const filteredCrds = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return crds.value
  return crds.value.filter(c =>
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
    <DataTable :headers="headers" :rows="paginated" column-key="crds">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-base">extension</span>
          <router-link :to="{ name: 'CrdDetail', params: { name: row.name } }" class="font-mono text-code-sm text-on-surface font-semibold hover:text-primary transition-colors">{{ row.name }}</router-link>
        </div>
      </template>
      <template #groupVersion="{ row }">
        <span class="font-mono text-code-sm text-on-surface-variant">{{ row.group }}/{{ row.version }}</span>
      </template>
      <template #kind="{ row }">
        <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-xs font-semibold rounded">{{ row.kind }}</span>
      </template>
      <template #scope="{ row }">
        <span
          v-if="row.scope === 'Namespaced'"
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
      </template>
      <template #description="{ row }">
        <span class="text-xs text-on-surface-variant line-clamp-1">{{ row.description || '-' }}</span>
      </template>
      <template v-if="filteredCrds.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>
</template>
