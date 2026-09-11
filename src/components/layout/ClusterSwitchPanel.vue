<script setup>
import { computed } from 'vue'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { Z } from '@/styles/zScale'

// 集群选择面板(2026-09-04 顶栏去重:自 TopNavBar 迁出,集群切换归侧栏)。
// 哑组件契约:clusters/currentName/health* props 进,select/manage 事件出;
// 定位形态二选一——bottomSheet=true 贴底全宽(手机抽屉),否则 Teleport+fixed
// 锚定 triggerRef(桌面/rail,issue#4 同款配方)。开关状态归宿主。
const props = defineProps({
  open: { type: Boolean, default: false },
  // 桌面锚定触发元素(template ref);bottomSheet 档不参与定位
  triggerRef: { type: Object, default: null },
  bottomSheet: { type: Boolean, default: false },
  clusters: { type: Array, default: () => [] },
  currentName: { type: String, default: '' },
  healthSeverity: { type: String, default: 'none' },
  healthReasons: { type: Array, default: () => [] },
})
const emit = defineEmits(['select', 'manage'])

// 注意:i18n 只走模板 $t(不 useI18n)——SideNavBar 既有测试基建是 $t mock 且不装
// i18n 插件,脚本层取 t 会炸「Need to install with app.use」
// 锚定仅桌面档生效;手机 sheet 走固定贴底样式
const openAnchored = computed(() => props.open && !props.bottomSheet)
const { panelRef, panelStyle } = useDropdownPanel(
  computed(() => props.triggerRef),
  openAnchored,
)
// 手机 bottom sheet(spec §13.1 同款):fixed 贴底全宽,Z.popover(110) 盖过抽屉遮罩
const SHEET_STYLE = { position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: Z.popover }
const style = computed(() => (props.bottomSheet ? SHEET_STYLE : panelStyle.value))

// 集群健康 → 圆点颜色(承自顶栏旧实现:当前集群按控制面分级,他集群中性)
function dotColor(severity) {
  if (severity === 'ok') return 'bg-primary'
  if (severity === 'warn') return 'bg-tertiary-container'
  if (severity === 'crit') return 'bg-error'
  return 'bg-on-surface-variant'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="panelRef" data-testid="cluster-dropdown-panel"
      data-test="cluster-dropdown-panel"
      :data-bottom-sheet="String(bottomSheet)"
      class="bg-surface-container-lowest border border-outline-variant shadow-dropdown overflow-hidden"
      :class="bottomSheet
        ? 'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]'
        : 'rounded-lg w-80'"
      :style="style">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant">
        <p class="text-label-caps text-on-surface-variant">{{ $t('nav.switchCluster') }}</p>
        <button
          data-test="manage-all"
          class="flex items-center gap-1 text-body-sm text-primary hover:opacity-80 transition-opacity"
          @click.stop="emit('manage')"
        >
          <span class="material-symbols-outlined text-base">view_module</span>
          {{ $t('nav.manageAll') }}
        </button>
      </div>

      <!-- 集群列表 -->
      <div class="max-h-80 overflow-y-auto p-sm">
        <div
          v-for="c in clusters"
          :key="c.id"
          data-test="cluster-row"
          class="flex items-center justify-between px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
          :class="c.name === currentName ? 'bg-primary-container/20' : ''"
          @click="emit('select', c.id)"
        >
          <div class="flex items-center gap-sm min-w-0">
            <span
              data-test="cluster-dot"
              class="w-2 h-2 rounded-full shrink-0"
              :class="dotColor(c.name === currentName ? healthSeverity : 'none')"
              :title="c.name === currentName ? (healthReasons.map(r => $t(r)).join('；') || $t('clusterHealth.healthy')) : c.status"
            ></span>
            <div class="min-w-0">
              <p class="text-body-md font-medium truncate" :class="c.name === currentName ? 'text-primary' : 'text-on-surface'">{{ c.name }}</p>
              <p class="text-xs text-on-surface-variant truncate">{{ c.version }} · {{ c.distribution }}</p>
            </div>
          </div>
          <div class="flex items-center gap-xs shrink-0">
            <span v-if="c.name === currentName" class="text-xs font-bold text-primary px-sm py-0.5 rounded-full bg-primary-container/30">CURRENT</span>
            <span class="material-symbols-outlined text-base text-on-surface-variant opacity-40">chevron_right</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
