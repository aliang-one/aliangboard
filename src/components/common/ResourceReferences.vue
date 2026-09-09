<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const { t } = useI18n()

const props = defineProps({
  // 被引用的资源类型：'ConfigMap' | 'Secret'
  kind: { type: String, required: true },
  // 被引用的资源名称
  name: { type: String, required: true },
})

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

// P2-B：引用反查改 Vue Query workloads（旧实现读孤儿 store.workloadList 恒空 → 面板空白）。
// 与工作负载列表页同 key —— 共享缓存，零额外请求。
const cid = computed(() => store.currentCluster || 'cluster')
const workloadsQuery = useResourceList({
  key: ['cluster', cid, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
})
const references = computed(() =>
  store.findResourceReferences(workloadsQuery.data.value || [], props.kind, props.name, route.params.namespace)
)

// 按引用方式分组统计
const refTypeStats = computed(() => {
  const stats = { envFrom: 0, env: 0, volume: 0, imagePullSecrets: 0 }
  references.value.forEach(r => { stats[r.reference.type] = (stats[r.reference.type] || 0) + 1 })
  return stats
})

const refTypeMeta = {
  envFrom: { label: 'EnvFrom', icon: 'code', descKey: 'component.resourceRef.refTypeEnvFromDesc', color: 'bg-primary-container/10 text-primary border-primary/20' },
  env: { label: 'Env', icon: 'terminal', descKey: 'component.resourceRef.refTypeEnvDesc', color: 'bg-tertiary-container/10 text-tertiary border-tertiary/20' },
  volume: { label: 'Volume', icon: 'folder', descKey: 'component.resourceRef.refTypeVolumeDesc', color: 'bg-secondary-container/10 text-secondary border-secondary/20' },
  imagePullSecrets: { label: 'Image Pull', icon: 'key', descKey: 'component.resourceRef.refTypeImagePullDesc', color: 'bg-surface-container text-on-surface-variant border-outline-variant' },
}

function typeMeta(type) {
  return refTypeMeta[type] || { label: type, icon: 'link', descKey: '', color: 'bg-surface-container text-on-surface-variant border-outline-variant' }
}

function goToWorkload(wl) {
  router.push({
    name: 'NsWorkloadDetail',
    params: { namespace: route.params.namespace, type: wl.type, name: wl.name },
  })
}

// —— 引用表迁 DataTable(Wave5 B5,审计 #70):五列 detail 列 mono 不可断 min-content ≈600px,
// 外层卡 overflow-hidden 硬裁;DataTable 手机卡片模式(首列=标题)根治,桌面五列等价。
// 行集无唯一键 → 注入 _idx 作 row-key;detail 列保留 truncate+title(桌面信息等价)。
const refHeaders = computed(() => [
  { key: 'workload', label: 'Workload' },
  { key: 'type', label: 'Type' },
  { key: 'refType', label: t('component.resourceRef.thRefType') },
  { key: 'detail', label: t('component.resourceRef.thDetail') },
  { key: 'status', label: t('common.status') },
])
const refRows = computed(() => references.value.map((r, i) => ({ ...r, _idx: i })))
// detail 列完整文本(供 title 兜底):volume=mountPath,env=ENV ← kind.key,其余文案列无长串
function detailTitle(row) {
  const ref = row.reference
  if (ref.type === 'volume') return ref.mountPath
  if (ref.type === 'env') return `${ref.envName} ← ${props.kind}.${ref.key}`
  return ''
}
</script>

<template>
  <div>
    <!-- 影响摘要 -->
    <div v-if="references.length" class="grid grid-cols-1 lg:grid-cols-12 gap-lg mb-lg">
      <!-- 左侧：受影响的 Workload 列表(DataTable:手机卡片模式,Wave5 B5) -->
      <div class="lg:col-span-8 flex flex-col gap-sm min-w-0">
        <div class="flex items-center justify-between flex-wrap gap-x-sm gap-y-xs">
          <h3 class="text-headline-sm">{{ t('component.resourceRef.refsTitle', { kind, count: references.length }) }}</h3>
          <span class="text-body-sm text-on-surface-variant">{{ t('component.resourceRef.refsHint', { kind }) }}</span>
        </div>
        <DataTable :headers="refHeaders" :rows="refRows" row-key="_idx" @row-click="row => goToWorkload(row.workload)">
          <template #workload="{ row }">
            <div class="flex items-center gap-sm min-w-0">
              <span class="material-symbols-outlined text-secondary text-lg shrink-0">apps</span>
              <span class="font-mono text-code-sm font-semibold text-on-surface truncate" :title="row.workload.name">{{ row.workload.name }}</span>
            </div>
          </template>
          <template #type="{ row }">
            <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ row.workload.type }}</span>
          </template>
          <template #refType="{ row }">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-base" :class="typeMeta(row.reference.type).color.split(' ')[1]">{{ typeMeta(row.reference.type).icon }}</span>
              <span class="text-body-sm font-medium text-on-surface">{{ typeMeta(row.reference.type).label }}</span>
            </div>
          </template>
          <template #detail="{ row }">
            <span v-if="row.reference.type === 'volume'" class="font-mono text-code-sm text-primary block truncate max-w-[280px]" :title="detailTitle(row)">{{ row.reference.mountPath }}</span>
            <span v-else-if="row.reference.type === 'env'" class="font-mono text-code-sm block truncate max-w-[280px]" :title="detailTitle(row)">
              <span class="text-primary">{{ row.reference.envName }}</span>
              <span class="text-on-surface-variant"> ← {{ kind }}.{{ row.reference.key }}</span>
            </span>
            <span v-else-if="row.reference.type === 'envFrom'">{{ t('component.resourceRef.envFromDetail') }}</span>
            <span v-else-if="row.reference.type === 'imagePullSecrets'">{{ t('component.resourceRef.imagePullDetail') }}</span>
            <span v-else>-</span>
          </template>
          <template #status="{ row }">
            <StatusChip :status="row.workload.status" size="sm" />
          </template>
        </DataTable>
      </div>

      <!-- 右侧：引用方式统计 -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('component.resourceRef.distTitle') }}</h3>
          <div class="flex flex-col gap-md">
            <div v-for="(meta, type) in refTypeMeta" :key="type" class="flex items-center justify-between p-sm rounded-lg" :class="refTypeStats[type] ? meta.color : 'opacity-40'">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg">{{ meta.icon }}</span>
                <div>
                  <p class="text-body-sm font-semibold">{{ meta.label }}</p>
                  <p class="text-xs opacity-70">{{ meta.descKey ? t(meta.descKey) : '' }}</p>
                </div>
              </div>
              <span class="text-body-lg font-bold">{{ refTypeStats[type] || 0 }}</span>
            </div>
          </div>
        </div>

        <!-- 影响提示 -->
        <div class="bg-tertiary-container/5 border border-tertiary-container/20 rounded-xl p-lg">
          <div class="flex gap-sm">
            <span class="material-symbols-outlined text-tertiary-container">info</span>
            <div>
              <p class="text-body-sm font-semibold text-on-surface mb-xs">{{ t('component.resourceRef.impactTitle') }}</p>
              <p class="text-body-sm text-on-surface-variant">
                {{ t('component.resourceRef.impactDescPrefix', { kind }) }}
                <span class="font-semibold text-tertiary-container">{{ references.length }}</span>
                {{ t('component.resourceRef.impactDescCountUnit') }}
                <span class="font-semibold">{{ t('component.resourceRef.impactRestart') }}</span>
                {{ t('component.resourceRef.impactDescSuffix') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 无引用 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">link_off</span>
      <h3 class="text-headline-sm text-on-surface mt-md">{{ t('component.resourceRef.noRefsTitle') }}</h3>
      <p class="text-body-md text-on-surface-variant mt-sm">{{ t('component.resourceRef.noRefsHint', { kind }) }}</p>
      <p class="text-body-sm text-on-surface-variant mt-xs opacity-70">{{ t('component.resourceRef.noRefsHint2') }}</p>
    </div>
  </div>
</template>
