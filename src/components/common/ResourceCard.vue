<script setup>
/**
 * ResourceCard — catalog 驱动的通用 K8s 资源卡片渲染器。
 *
 * 读 resourceCatalog 的属性定义 + 传入的资源对象 → 卡片。
 * 5 种属性类型: text / badge / chips / age / code。
 * 加 kind 只需在 catalog 加配置,不改此组件。
 *
 * 注:原 ResourceCard(纯 label/value stat 卡)未被任何页面引用,
 * P4 重构为 catalog 驱动渲染器。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getCardSpec, getPath } from '@/data/resourceCatalog'

const { t } = useI18n()

const props = defineProps({
  resource: { type: Object, required: true },
  // 来源集群标识(gap3-01,2026-09-07 审计批次二):工作台 @refs 落库盖 clusterId 戳后,
  // 换绑项目的旧消息卡片须标注「这份快照来自哪个集群」——否则同名资源串味/旧快照被当
  // 新集群现状,零提示。传 null/undefined(未换绑场景/其他消费方)则不渲染徽标,零侵入。
  sourceCluster: { type: String, default: null },
})

const spec = computed(() => getCardSpec(props.resource?.kind))

const attrs = computed(() =>
  spec.value.attributes
    .map((a) => ({ ...a, value: getPath(props.resource, a) }))
    .filter((a) => a.value != null && a.value !== '' && !(Array.isArray(a.value) && a.value.length === 0)),
)

// ── badge 颜色映射 ──────────────────────────────────────
const BADGE_CLASS = {
  ok: 'text-status-running bg-status-running/10',
  warn: 'text-status-pending bg-status-pending/10',
  err: 'text-error bg-error/10',
}
const BADGE_DEFAULT = 'text-on-surface-variant bg-surface-container-high'

function badgeClass(attr) {
  const level = attr.badgeMap?.[attr.value]
  return BADGE_CLASS[level] || BADGE_DEFAULT
}

// ── 相对时间(age) ──────────────────────────────────────
function relTime(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0 || isNaN(diff)) return '—'
  const s = Math.floor(diff / 1000)
  if (s < 60) return t('component.resourceCard.justNow')
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
</script>

<template>
  <div class="border border-outline-variant rounded-xl bg-surface-container-lowest p-md">
    <!-- Header: icon + kind badge + name + 来源集群徽标(仅换绑过的旧 refs 有) -->
    <div class="flex items-center gap-sm mb-md">
      <span class="material-symbols-outlined text-xl text-on-surface-variant">{{ spec.icon }}</span>
      <span class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ resource?.kind || t('component.resourceCard.unknownKind') }}</span>
      <span class="font-bold text-sm text-on-surface truncate flex-1 min-w-0" :title="resource?.metadata?.name">{{ resource?.metadata?.name || '—' }}</span>
      <span v-if="sourceCluster" data-testid="resource-source-cluster"
        class="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-status-warning/10 text-status-warning"
        :title="t('component.resourceCard.sourceCluster', { name: sourceCluster })">
        <span class="material-symbols-outlined text-xs">lan</span>{{ t('component.resourceCard.sourceCluster', { name: sourceCluster }) }}
      </span>
    </div>

    <!-- Body: attribute grid (2-col: label left / value right) -->
    <div v-if="attrs.length" class="grid grid-cols-[auto_1fr] gap-x-md gap-y-xs items-center">
      <template v-for="attr in attrs" :key="attr.key">
        <span class="text-xs text-on-surface-variant whitespace-nowrap">{{ attr.labelKey ? t(attr.labelKey) : attr.label }}</span>

        <!-- text -->
        <span v-if="attr.type === 'text'" class="text-sm text-on-surface text-right truncate">{{ attr.value }}</span>

        <!-- badge -->
        <span v-else-if="attr.type === 'badge'" class="inline-flex justify-end">
          <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeClass(attr)">{{ attr.value }}</span>
        </span>

        <!-- chips -->
        <span v-else-if="attr.type === 'chips'" class="flex flex-wrap justify-end gap-1">
          <span v-for="(v, i) in attr.value" :key="i" class="px-1.5 py-0.5 rounded font-mono text-[11px] bg-surface-container-high text-on-surface-variant">{{ v }}</span>
        </span>

        <!-- age -->
        <span v-else-if="attr.type === 'age'" class="text-sm text-on-surface text-right tabular-nums">{{ relTime(attr.value) }}</span>

        <!-- code -->
        <code v-else-if="attr.type === 'code'" class="text-right font-mono text-xs text-primary truncate">{{ attr.value }}</code>
      </template>
    </div>

    <p v-else class="text-xs text-on-surface-variant/50 py-sm text-center">{{ t('component.resourceCard.noAttributes') }}</p>
  </div>
</template>
