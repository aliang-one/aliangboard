<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useResourceApply } from '@/composables/useResourceApply'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsEndpoints'))
store.setNamespace(route.params.namespace)

// Endpoints 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.currentCluster || 'cluster'))
const endpointsKey = ['cluster', cid.value, 'endpoints']
const endpointsQuery = useResourceList({
  key: endpointsKey,
  fetcher: () => store.fetchEndpoints(),
  options: { refetchInterval: 30000 },
})
const nsEndpoints = computed(() => (endpointsQuery.data.value || []).filter(e => e.namespace === route.params.namespace))
// Service 名查询（svcByName 在 remote 下孤立）
const svcQ = useResourceList({ key: ['cluster', cid.value, 'services'], fetcher: () => store.fetchServices(), options: { refetchInterval: 30000 } })
const svcByName = (name, ns) => (svcQ.data.value || []).find(s => s.name === name && s.namespace === ns)

const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = nsEndpoints.value
  return q ? list.filter(e => e.name.toLowerCase().includes(q)) : list
})
const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [search] })

const yamlOf = (e) => store.generateYAML('endpoints', e)
const svcOf = (e) => svcByName(e.name, e.namespace)
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.endpoints.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md font-bold text-on-surface">{{ $t('ns.endpoints.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ $t('ns.endpoints.subtitle', { n: nsEndpoints.length, ns: route.params.namespace }) }}</p>
      </div>
    </div>

    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary" :placeholder="$t('ns.endpoints.searchPlaceholder')" />
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ nsEndpoints.length }}</span>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsEndpoints" expandable row-key="name">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-lg">hub</span>
          <button v-if="svcOf(row)" class="font-semibold text-on-surface text-body-md hover:text-primary hover:underline" @click="router.push({ name: 'NsServiceDetail', params: { namespace: row.namespace, name: row.name } })">{{ row.name }}</button>
          <span v-else class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #ready="{ row }">
        <span class="font-mono text-code-sm">
          <span class="text-primary font-semibold">{{ (row.addresses || []).length }}</span>
          <span class="text-on-surface-variant"> / {{ (row.addresses || []).length + (row.notReadyAddresses || []).length }}</span>
        </span>
      </template>
      <template #addresses="{ row }">
        <div class="flex flex-wrap gap-xs max-w-md">
          <span v-for="ip in (row.addresses || []).slice(0, 3)" :key="ip" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded font-mono">{{ ip }}</span>
          <span v-if="(row.addresses || []).length > 3" class="text-xs text-on-surface-variant">+{{ row.addresses.length - 3 }}</span>
          <span v-for="ip in (row.notReadyAddresses || [])" :key="'nr-'+ip" class="px-1.5 py-0.5 bg-error-container/20 text-error text-xs rounded font-mono" :title="`${$t('ns.endpoints.notReady')}: ${ip}`">{{ ip }}</span>
          <span v-if="!(row.addresses||[]).length && !(row.notReadyAddresses||[]).length" class="text-on-surface-variant">—</span>
        </div>
      </template>
      <template #ports="{ row }">
        <div class="flex flex-wrap gap-xs">
          <span v-for="(p, i) in (row.ports || [])" :key="i" class="px-1.5 py-0.5 bg-surface-container text-on-surface-variant text-xs rounded border border-outline-variant font-mono">{{ p.port }}/{{ p.protocol }}</span>
        </div>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #expanded="{ row }">
        <YamlEditor :model-value="yamlOf(row)" :readonly="false" height="360px" @save="applyYaml" />
      </template>
      <template v-if="filtered.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>
</template>
