<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
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
</script>

<template>
  <div>
    <!-- 影响摘要 -->
    <div v-if="references.length" class="grid grid-cols-1 lg:grid-cols-12 gap-lg mb-lg">
      <!-- 左侧：受影响的 Workload 列表 -->
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
            <h3 class="text-headline-sm">{{ t('component.resourceRef.refsTitle', { kind, count: references.length }) }}</h3>
            <span class="text-body-sm text-on-surface-variant">{{ t('component.resourceRef.refsHint', { kind }) }}</span>
          </div>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-surface-container-low border-b border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Workload</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('component.resourceRef.thRefType') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('component.resourceRef.thDetail') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('common.status') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(ref, idx) in references" :key="idx" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="goToWorkload(ref.workload)">
                <td class="px-lg py-md">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-secondary text-lg">apps</span>
                    <span class="font-mono text-code-sm font-semibold text-on-surface">{{ ref.workload.name }}</span>
                  </div>
                </td>
                <td class="px-lg py-md">
                  <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ ref.workload.type }}</span>
                </td>
                <td class="px-lg py-md">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-base" :class="typeMeta(ref.reference.type).color.split(' ')[1]">{{ typeMeta(ref.reference.type).icon }}</span>
                    <span class="text-body-sm font-medium text-on-surface">{{ typeMeta(ref.reference.type).label }}</span>
                  </div>
                </td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">
                  <span v-if="ref.reference.type === 'volume'" class="font-mono text-code-sm text-primary">{{ ref.reference.mountPath }}</span>
                  <span v-else-if="ref.reference.type === 'env'" class="font-mono text-code-sm">
                    <span class="text-primary">{{ ref.reference.envName }}</span>
                    <span class="text-on-surface-variant"> ← {{ kind }}.{{ ref.reference.key }}</span>
                  </span>
                  <span v-else-if="ref.reference.type === 'envFrom'">{{ t('component.resourceRef.envFromDetail') }}</span>
                  <span v-else-if="ref.reference.type === 'imagePullSecrets'">{{ t('component.resourceRef.imagePullDetail') }}</span>
                  <span v-else>-</span>
                </td>
                <td class="px-lg py-md"><StatusChip :status="ref.workload.status" size="sm" /></td>
              </tr>
            </tbody>
          </table>
        </div>
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
