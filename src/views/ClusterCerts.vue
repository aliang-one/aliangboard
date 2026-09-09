<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Pagination from '@/components/common/Pagination.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import { usePagination } from '@/composables/usePagination'
import { certSeverity } from '@/logic/certExpiry'
import { routeForResource } from '@/logic/resourceNavigation'

// 集群证书可观测(2026-09-06,K 轨):A 段集群连接证书(API server 服务证书 + 面板存储 CA 锚,
// TLS 双拨归因 banner),B 段 kubernetes.io/tls Secret 到期表。与 AlertBell 共用
// ['cluster',cid,'certs'] queryKey → Vue Query 去重;证书变化慢,60s stale + 5min 轮询。
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()

const cid = computed(() => (store.currentCluster || 'cluster'))
const certsQ = useResourceList({
  key: ['cluster', cid, 'certs'],
  fetcher: () => store.fetchClusterCerts(),
  options: { staleTime: 60_000, refetchInterval: 300_000 },
})
const report = computed(() => certsQ.data.value || null)
const loading = computed(() => certsQ.isLoading.value)
const loadError = computed(() => certsQ.error.value || null)
const syncing = computed(() => certsQ.isFetching.value)
async function sync() {
  try { await certsQ.refetch(); notify('success', t('certs.synced')) }
  catch (e) { notify('error', `${t('certs.syncFailed')}：${e.message || ''}`) }
}

// A 段:连接证书 + 归因 banner
const conn = computed(() => report.value?.connection || null)
const apiCert = computed(() => conn.value?.peerChain?.[0] || null)
const caAnchors = computed(() => report.value?.caAnchors || [])
const BANNER = {
  'ca-mismatch': 'certs.bannerCaMismatch',
  'cert-expired': 'certs.bannerCertExpired',
  'hostname-mismatch': 'certs.bannerHostnameMismatch',
  'unreachable': 'certs.bannerUnreachable',
  'unverified': 'certs.insecureHint',
  'error': 'certs.bannerError',
}
const bannerKey = computed(() => (conn.value && BANNER[conn.value.trust]) || null)
const bannerIsError = computed(() => conn.value != null && conn.value.trust !== 'unverified')

// 分级 pill:无 warning token → tertiary=warn,error=危险(透明度须 5 的倍数)
const SEV_CLASS = {
  expired: 'bg-error-container/30 text-error',
  critical: 'bg-error-container/30 text-error',
  warn: 'bg-tertiary-container/20 text-tertiary-container',
  ok: 'bg-primary/10 text-primary',
  unknown: 'bg-surface-container text-on-surface-variant',
}
function pillClass(daysLeft) { return SEV_CLASS[certSeverity(daysLeft)] || SEV_CLASS.unknown }
function fmtDays(d) {
  if (d == null) return '—'
  return d < 0 ? t('certs.expiredDays', { n: Math.abs(d) }) : t('certs.daysLeft', { n: d })
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString() : '—' }

// B 段:过滤(全部/30 天内含已过期/已过期)+ 搜索
const filterMode = ref('all')
const searchQuery = ref('')
const secretsError = computed(() => report.value?.secrets?.error || null)
const secretItems = computed(() => report.value?.secrets?.items || [])
const filtered = computed(() => {
  let list = secretItems.value
  if (filterMode.value === 'expiring') list = list.filter(s => s.daysLeft != null && s.daysLeft <= 30)
  if (filterMode.value === 'expired') list = list.filter(s => s.daysLeft != null && s.daysLeft < 0)
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(s => `${s.name} ${s.namespace} ${s.cn || ''} ${(s.sans || []).join(' ')}`.toLowerCase().includes(q))
})
const headers = computed(() => tableColumns('clusterCerts'))
const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery, filterMode] })
// 跨 ns 列表:name 在不同 namespace 会重名(cert-manager 的 <app>-tls 惯例如此),
// 复合 _key 防行 key 冲突(对标 ClusterResourceList 的 ns+'/'+name 先例)。
const tableRows = computed(() => paginated.value.map(s => ({ ...s, _key: `${s.namespace}/${s.name}` })))
function onRowClick(row) {
  const target = routeForResource('Secret', row.name, row.namespace)
  if (target) router.push(target)
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex flex-wrap items-center justify-between gap-x-sm gap-y-sm mb-md">
      <div class="min-w-0">
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('certs.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('certs.subtitle') }}</p>
      </div>
      <button @click="sync" :disabled="syncing" class="flex items-center gap-xs px-3 py-1.5 max-sm:min-h-[40px] text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <span class="material-symbols-outlined text-base" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ $t('common.sync') }}
      </button>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-xl">
      <span class="material-symbols-outlined text-2xl animate-spin text-on-surface-variant">progress_activity</span>
    </div>
    <div v-else-if="loadError" data-testid="certs-load-error"
      class="flex items-center gap-sm rounded-lg bg-error-container/20 border border-error/30 text-error px-md py-sm mb-md">
      <span class="material-symbols-outlined text-base">cloud_off</span>
      <p class="text-body-sm font-medium">{{ $t('certs.bannerError', { reason: loadError.message || '' }) }}</p>
      <button class="ml-auto text-body-sm underline underline-offset-2" @click="sync">{{ $t('common.sync') }}</button>
    </div>
    <template v-else-if="report">
      <!-- 归因 banner:trusted 不渲染 -->
      <div v-if="bannerKey" data-testid="certs-banner"
        class="flex items-start gap-sm rounded-lg px-md py-sm mb-md"
        :class="bannerIsError ? 'bg-error-container/20 border border-error/30 text-error' : 'bg-tertiary-container/15 border border-tertiary/30 text-tertiary-container'">
        <span class="material-symbols-outlined text-base shrink-0 mt-0.5">{{ bannerIsError ? 'gpp_bad' : 'info' }}</span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium">{{ $t(bannerKey, { reason: conn?.reason || conn?.reasonCode || '' }) }}</p>
          <router-link v-if="conn?.trust === 'ca-mismatch'" to="/clusters" class="text-body-sm underline underline-offset-2">{{ $t('certs.goAdminClusters') }}</router-link>
        </div>
      </div>

      <!-- A 段:集群连接证书 -->
      <h3 class="text-body-md font-bold text-on-surface mb-sm">{{ $t('certs.sectionConnection') }}</h3>
      <div data-testid="certs-apiserver-card" class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
        <div class="flex items-center gap-sm mb-sm">
          <span class="material-symbols-outlined text-primary">verified_user</span>
          <p class="text-body-md font-bold text-on-surface">{{ $t('certs.apiServerCert') }}</p>
          <span class="flex items-center gap-xs ml-auto">
            <span v-if="conn?.trust === 'trusted'" data-testid="certs-trusted" class="px-1.5 py-0.5 rounded text-xs font-semibold bg-primary/10 text-primary">{{ $t('certs.trusted') }}</span>
            <span data-testid="cert-days" class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(apiCert?.daysLeft)">{{ fmtDays(apiCert?.daysLeft) }}</span>
          </span>
        </div>
        <div v-if="apiCert" class="grid grid-cols-1 md:grid-cols-3 gap-sm text-body-sm">
          <div class="min-w-0">
            <p class="text-xs text-on-surface-variant">{{ $t('certs.subject') }}</p>
            <p class="truncate max-w-[20rem] font-mono text-code-sm" :title="apiCert.subject">{{ apiCert.subject }}</p>
          </div>
          <div class="min-w-0">
            <p class="text-xs text-on-surface-variant">{{ $t('certs.issuer') }}</p>
            <p class="truncate max-w-[20rem] font-mono text-code-sm" :title="apiCert.issuer">{{ apiCert.issuer }}</p>
          </div>
          <div>
            <p class="text-xs text-on-surface-variant">{{ $t('certs.expires') }}</p>
            <p class="font-mono text-code-sm">{{ fmtDate(apiCert.validTo) }}</p>
          </div>
        </div>
        <p v-else class="text-body-sm text-on-surface-variant">—</p>
        <div v-if="apiCert?.sans?.length" class="mt-sm min-w-0">
          <p class="text-xs text-on-surface-variant">{{ $t('certs.sans') }}</p>
          <p class="font-mono text-code-sm text-on-surface truncate max-w-[36rem]" :title="apiCert.sans.join(', ')">{{ apiCert.sans.join(', ') }}</p>
        </div>
      </div>
      <div data-testid="certs-ca-anchors" class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
        <p class="text-body-md font-bold text-on-surface mb-sm">{{ $t('certs.caAnchors') }}({{ caAnchors.length }})</p>
        <div v-for="a in caAnchors" :key="a.fingerprint256 || a.subject" class="flex items-center gap-sm py-xs border-b border-outline-variant/50 last:border-0">
          <span class="material-symbols-outlined text-base text-on-surface-variant">key</span>
          <span class="font-mono text-code-sm text-on-surface truncate max-w-[22rem]" :title="a.subject">{{ a.subject }}</span>
          <span class="font-mono text-xs text-on-surface-variant shrink-0" :title="`${$t('certs.fingerprint')}: ${a.fingerprint256 || ''}`">{{ (a.fingerprint256 || '').replace(/:/g, '').slice(0, 8) }}</span>
          <span data-testid="cert-days" class="ml-auto px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(a.daysLeft)">{{ fmtDays(a.daysLeft) }}</span>
        </div>
        <p v-if="!caAnchors.length" class="text-body-sm text-on-surface-variant">{{ $t('certs.insecureHint') }}</p>
      </div>

      <!-- B 段:TLS 证书 Secret -->
      <div class="flex flex-wrap items-center justify-between gap-x-sm gap-y-sm mb-sm">
        <h3 class="text-body-md font-bold text-on-surface">{{ $t('certs.sectionSecrets') }}</h3>
        <div class="flex flex-wrap gap-xs">
          <button v-for="mode in ['all', 'expiring', 'expired']" :key="mode" :data-testid="`certs-filter-${mode}`"
            class="px-sm py-0.5 max-sm:min-h-[40px] rounded-full text-xs font-medium border transition-colors"
            :class="filterMode === mode ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'"
            @click="filterMode = mode">{{ $t(mode === 'all' ? 'certs.filterAll' : mode === 'expiring' ? 'certs.filterExpiring' : 'certs.filterExpired') }}</button>
        </div>
      </div>
      <div v-if="secretsError" data-testid="certs-secrets-error" class="flex items-center gap-sm rounded-lg bg-tertiary-container/15 border border-tertiary/30 text-tertiary-container px-md py-sm mb-md">
        <span class="material-symbols-outlined text-base">lock</span>
        <p class="text-body-sm">{{ $t('certs.secretsForbidden') }}</p>
      </div>
      <div class="flex items-center gap-md mb-md">
        <div class="relative flex-1 max-w-md">
          <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
          <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="$t('certs.searchPlaceholder')" />
        </div>
        <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ secretItems.length }}</span>
      </div>
      <EmptyState v-if="!secretItems.length && !secretsError" icon="verified_user" :title="$t('certs.noSecretsTitle')" :description="$t('certs.noSecretsDesc')" />
      <EmptyState v-else-if="secretItems.length && !filtered.length" icon="search" :title="$t('certs.noMatchTitle')" :description="$t('certs.noMatchDesc')" />
      <DataTable v-else :headers="headers" :rows="tableRows" column-key="clusterCerts" row-key="_key" @row-click="onRowClick">
        <template #name="{ row }">
          <span class="font-semibold text-on-surface text-body-md block truncate max-w-[14rem]" :title="row.name">{{ row.name }}</span>
        </template>
        <template #cn="{ row }">
          <span class="font-mono text-code-sm text-on-surface truncate max-w-[16rem] block" :title="row.cn">{{ row.cn || '—' }}</span>
        </template>
        <template #issuer="{ row }">
          <span class="font-mono text-code-sm text-on-surface-variant truncate max-w-[14rem] block" :title="row.issuer">{{ row.issuer || '—' }}</span>
        </template>
        <template #sans="{ row }">
          <span class="font-mono text-code-sm text-on-surface-variant truncate max-w-[18rem] block" :title="(row.sans || []).join(', ')">{{ (row.sans || []).join(', ') || '—' }}</span>
        </template>
        <template #expires="{ row }">
          <span class="font-mono text-code-sm text-on-surface">{{ fmtDate(row.expires) }}</span>
        </template>
        <template #daysLeft="{ row }">
          <span data-testid="cert-days" class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="pillClass(row.daysLeft)">{{ fmtDays(row.daysLeft) }}</span>
        </template>
        <template #certManager="{ row }">
          <span v-if="row.certManager" class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded">
            <span class="material-symbols-outlined text-xs">autorenew</span>{{ row.certManager.ready ? $t('certs.cmReady') : '—' }}<span v-if="row.certManager.renewalTime" class="text-on-surface-variant"> · {{ $t('certs.cmRenew', { time: fmtDate(Date.parse(row.certManager.renewalTime)) }) }}</span>
          </span>
          <span v-else class="text-on-surface-variant">—</span>
        </template>
        <template #pagination>
          <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
        </template>
      </DataTable>
    </template>
  </section>
</template>
