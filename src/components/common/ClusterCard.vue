<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import StatusChip from '@/components/common/StatusChip.vue'

const { t } = useI18n()

// 公共集群卡片：/clusters 与 /admin/clusters 共用。
// 点击卡片 → 切换到该集群 + 进入集群管理(/cluster)；「切换」按钮仅切换；删除 emit('remove')。
// admin 列表由 /api/admin/clusters 实时探测补 status/nodeCount/podCount；断连集群计数缺失优雅降级为 —。
const props = defineProps({
  cluster: { type: Object, required: true },
  active: { type: Boolean, default: false },
  showRemove: { type: Boolean, default: true },
})
const emit = defineEmits(['remove'])
const router = useRouter()
const store = useClusterStore()
const c = computed(() => props.cluster)

// 集群状态映射到 StatusChip 现有值（StatusChip 只识 Ready/Failed/Unknown 等，无 Disconnected）
function mapStatus(status) {
  if (status === 'Healthy') return 'Ready'
  if (status === 'Degraded' || status === 'Disconnected') return 'Failed'
  return status || 'Unknown'
}
async function open() {
  if (c.value.apiServer && c.value.apiServer !== store.cluster?.apiServer) await store.switchCluster(c.value.apiServer)
  router.push('/cluster')
}
async function switchOnly() {
  if (c.value.apiServer && c.value.apiServer !== store.cluster?.apiServer) {
    await store.switchCluster(c.value.apiServer)
    notify('success', t('component.clusterCard.switchedTo', { name: store.currentCluster }))
  }
}
</script>

<template>
  <div
    class="rounded-xl overflow-hidden bg-surface-container-lowest border p-md flex flex-col gap-sm cursor-pointer hover:border-primary/40 transition-all"
    :class="active ? 'border-primary/60' : 'border-outline-variant'"
    @click="open"
  >
    <!-- 头部：名称 + 状态 -->
    <div class="flex items-start justify-between gap-sm">
      <div class="flex items-center gap-sm min-w-0">
        <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
          <span class="material-symbols-outlined text-base">hub</span>
        </div>
        <div class="min-w-0">
          <h3 class="text-body-sm text-on-surface font-bold truncate">{{ c.name }}</h3>
          <p class="text-xs text-on-surface-variant truncate">{{ c.version || '—' }}</p>
        </div>
      </div>
      <StatusChip v-if="c.status" :status="mapStatus(c.status)" size="sm" />
    </div>

    <!-- 徽章区 -->
    <div class="flex flex-wrap items-center gap-xs">
      <span v-if="active" class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-primary text-on-primary text-xs font-bold">
        <span class="material-symbols-outlined text-xs">check_circle</span> {{ t('component.clusterCard.current') }}
      </span>
      <span v-if="c.distribution" class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-tertiary-container/20 text-tertiary-container text-xs font-medium">
        <span class="material-symbols-outlined text-xs">dns</span>{{ c.distribution }}
      </span>
      <span v-if="c.context" class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-surface-container text-on-surface-variant text-xs font-medium">
        <span class="material-symbols-outlined text-xs">account_tree</span>{{ c.context }}
      </span>
    </div>

    <!-- 指标（有数据才显示）-->
    <div v-if="c.nodeCount != null || c.podCount != null" class="grid grid-cols-2 gap-sm">
      <div class="bg-surface-container-low rounded-lg px-sm py-xs">
        <p class="text-xs text-on-surface-variant">{{ t('component.clusterCard.nodes') }}</p>
        <p class="text-body-sm text-on-surface font-bold mt-0.5">{{ c.nodeCount ?? '—' }}</p>
      </div>
      <div class="bg-surface-container-low rounded-lg px-sm py-xs">
        <p class="text-xs text-on-surface-variant">{{ t('component.clusterCard.pods') }}</p>
        <p class="text-body-sm text-on-surface font-bold mt-0.5">{{ c.podCount ?? '—' }}</p>
      </div>
    </div>

    <!-- API Server -->
    <div class="flex items-center gap-sm bg-surface-container-low rounded-lg px-sm py-xs">
      <span class="material-symbols-outlined text-on-surface-variant text-base shrink-0">link</span>
      <span class="text-xs text-on-surface-variant truncate font-mono">{{ c.apiServer || '—' }}</span>
    </div>

    <!-- 操作区 -->
    <div class="flex items-center justify-end gap-sm mt-auto pt-xs" @click.stop>
      <button v-if="!active" @click="switchOnly" class="flex items-center gap-xs px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined text-sm">swap_horiz</span> {{ t('component.clusterCard.switchTo') }}
      </button>
      <span v-else class="inline-flex items-center gap-xs px-3 py-1.5 text-primary font-semibold text-body-sm">
        <span class="material-symbols-outlined text-sm">check_circle</span> {{ t('component.clusterCard.activeCluster') }}
      </span>
      <button v-if="showRemove && !active" @click="emit('remove')" :title="t('component.clusterCard.removeCluster')" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-colors">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
    </div>
  </div>
</template>
