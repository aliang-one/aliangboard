<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const search = ref('')
const expanded = ref(new Set())
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = store.nsEndpoints
  return q ? list.filter(e => e.name.toLowerCase().includes(q)) : list
})
const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [search] })

function toggleExpand(name) {
  const s = new Set(expanded.value)
  if (s.has(name)) s.delete(name); else s.add(name)
  expanded.value = s
}
const yamlOf = (e) => store.generateYAML('endpoints', e)
const svcOf = (e) => store.getServiceByName(e.name, e.namespace)
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
        <p class="text-body-sm text-on-surface-variant mt-1">{{ $t('ns.endpoints.subtitle', { n: store.nsEndpoints.length, ns: route.params.namespace }) }}</p>
      </div>
    </div>

    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary" :placeholder="$t('ns.endpoints.searchPlaceholder')" />
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.nsEndpoints.length }}</span>
    </div>

    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('ns.endpoints.thName') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('ns.endpoints.thReady') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('ns.endpoints.thAddresses') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('ns.endpoints.thPorts') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ $t('ns.endpoints.thAge') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-20">{{ $t('ns.endpoints.thActions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <template v-for="row in paginated" :key="row.name">
            <tr class="hover:bg-surface-container-low/40 transition-colors">
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">hub</span>
                  <button v-if="svcOf(row)" class="font-semibold text-on-surface text-body-md hover:text-primary hover:underline" @click="router.push({ name: 'NsServiceDetail', params: { namespace: row.namespace, name: row.name } })">{{ row.name }}</button>
                  <span v-else class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-md py-2">
                <span class="font-mono text-code-sm">
                  <span class="text-primary font-semibold">{{ (row.addresses || []).length }}</span>
                  <span class="text-on-surface-variant"> / {{ (row.addresses || []).length + (row.notReadyAddresses || []).length }}</span>
                </span>
              </td>
              <td class="px-md py-2">
                <div class="flex flex-wrap gap-xs max-w-md">
                  <span v-for="ip in (row.addresses || []).slice(0, 3)" :key="ip" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded font-mono">{{ ip }}</span>
                  <span v-if="(row.addresses || []).length > 3" class="text-xs text-on-surface-variant">+{{ row.addresses.length - 3 }}</span>
                  <span v-for="ip in (row.notReadyAddresses || [])" :key="'nr-'+ip" class="px-1.5 py-0.5 bg-error-container/20 text-error text-xs rounded font-mono" :title="`${$t('ns.endpoints.notReady')}: ${ip}`">{{ ip }}</span>
                  <span v-if="!(row.addresses||[]).length && !(row.notReadyAddresses||[]).length" class="text-on-surface-variant">—</span>
                </div>
              </td>
              <td class="px-md py-2">
                <div class="flex flex-wrap gap-xs">
                  <span v-for="(p, i) in (row.ports || [])" :key="i" class="px-1.5 py-0.5 bg-surface-container text-on-surface-variant text-xs rounded border border-outline-variant font-mono">{{ p.port }}/{{ p.protocol }}</span>
                </div>
              </td>
              <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-md py-2" @click.stop>
                <button @click="toggleExpand(row.name)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="expanded.has(row.name) ? $t('ns.endpoints.collapseYamlHint') : $t('ns.endpoints.expandYamlHint')">
                  <span class="material-symbols-outlined text-lg" :class="expanded.has(row.name) ? 'rotate-180' : ''">expand_more</span>
                </button>
              </td>
            </tr>
            <tr v-if="expanded.has(row.name)">
              <td colspan="6" class="px-md py-md bg-surface-container-low">
                <YamlEditor :model-value="yamlOf(row)" :readonly="false" height="360px" @save="applyYaml" />
              </td>
            </tr>
          </template>
          <tr v-if="!filtered.length">
            <td :colspan="6" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-body-sm text-on-surface-variant">{{ search ? $t('ns.endpoints.noMatch') : $t('common.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">{{ search ? 'search_off' : 'hub' }}</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ search ? $t('ns.endpoints.noMatch') : $t('ns.endpoints.emptyState') }}</p>
    </div>
  </section>
</template>
