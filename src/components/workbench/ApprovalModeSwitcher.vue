<script setup>
// 审批三档模式切换器(2026-09-09 VSCode 风格设计):聊天 composer 工具栏入口。
// ask=每项确认(默认,完全现状)/writes=写自动放行、命令仍确认/auto=全部放行(SSH 工具
// 恒按服务器策略裁决,更严者胜——菜单脚注明示)。切 auto 须 ConfirmDialog 一次性危险确认;
// 非 ask 档 trigger 常驻警示色(tertiary 琥珀/error 红,防忘记自己在放行档)。档位存用户
// 偏好(platform_users.prefs),服务端逐调用现读 owner 值,切换即时生效。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferencesStore } from '@/stores/preferences'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const prefs = usePreferencesStore()
const open = ref(false)
const confirmAuto = ref(false)
const rootEl = ref(null)

// 键表用全字面量(i18n 门禁静态抽取可覆盖;模板拼接键会被静默跳过)
const MODES = [
  { value: 'ask', icon: 'verified_user', labelKey: 'workbench.chat.approvalMode.ask', descKey: 'workbench.chat.approvalMode.askDesc' },
  { value: 'writes', icon: 'edit_note', labelKey: 'workbench.chat.approvalMode.writes', descKey: 'workbench.chat.approvalMode.writesDesc' },
  { value: 'auto', icon: 'bolt', labelKey: 'workbench.chat.approvalMode.auto', descKey: 'workbench.chat.approvalMode.autoDesc' },
]
const LABEL_KEY = { ask: 'workbench.chat.approvalMode.ask', writes: 'workbench.chat.approvalMode.writes', auto: 'workbench.chat.approvalMode.auto' }
const mode = computed(() => prefs.workbenchApprovalMode || 'ask')
const modeLabelKey = computed(() => LABEL_KEY[mode.value] || LABEL_KEY.ask)
const modeIcon = computed(() => MODES.find(m => m.value === mode.value)?.icon || 'verified_user')

function select(v) {
  open.value = false
  if (v === mode.value) return
  if (v === 'auto') { confirmAuto.value = true; return } // 升到全放行:一次性危险确认(防误触)
  prefs.setWorkbenchApprovalMode(v)
}
function confirmAutoYes() {
  confirmAuto.value = false
  prefs.setWorkbenchApprovalMode('auto')
}

// 菜单外点击关闭(document 级监听,卸载即摘;root 内点击不关——由 select/trigger 自管)
function onDocClick(e) { if (open.value && rootEl.value && !rootEl.value.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="rootEl" class="relative">
    <button type="button" data-testid="approval-mode-trigger" :title="t('workbench.chat.approvalMode.tooltip')"
      class="flex items-center gap-xs text-body-xs rounded-lg px-xs py-0.5 transition-colors"
      :class="mode === 'auto' ? 'text-error hover:bg-error/10' : mode === 'writes' ? 'text-tertiary hover:bg-tertiary/10' : 'text-on-surface-variant hover:text-primary'"
      @click="open = !open">
      <span class="material-symbols-outlined text-sm">{{ modeIcon }}</span>
      <span>{{ t(modeLabelKey) }}</span>
    </button>

    <div v-if="open" data-testid="approval-mode-menu" class="absolute bottom-full left-0 mb-xs bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl w-72 max-w-[80vw] z-30">
      <button v-for="m in MODES" :key="m.value" type="button" :data-testid="`approval-mode-option-${m.value}`"
        class="w-full flex items-start gap-sm text-left px-md py-sm transition-colors"
        :class="m.value === mode ? 'bg-primary/10' : 'hover:bg-primary/5'"
        @mousedown.prevent="select(m.value)">
        <span class="material-symbols-outlined text-base mt-0.5 shrink-0"
          :class="m.value === 'auto' ? 'text-error' : m.value === 'writes' ? 'text-tertiary' : 'text-primary'">{{ m.icon }}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-body-sm font-semibold text-on-surface">{{ t(m.labelKey) }}</span>
          <span class="block text-body-xs text-on-surface-variant">{{ t(m.descKey) }}</span>
        </span>
        <span v-if="m.value === mode" class="material-symbols-outlined text-base text-primary shrink-0">check</span>
      </button>
      <div class="px-md py-xs text-body-xs text-on-surface-variant border-t border-outline-variant">{{ t('workbench.chat.approvalMode.sshNote') }}</div>
    </div>

    <!-- v-if 按需挂载:rest 态不留隐藏 Modal 实例(组件树首个 Modal 恒为审批弹窗,测试/可访问性两便) -->
    <ConfirmDialog v-if="confirmAuto" :model-value="confirmAuto" :title="t('workbench.chat.approvalMode.autoConfirmTitle')"
      :message="t('workbench.chat.approvalMode.autoConfirmMessage')" :confirm-text="t('workbench.chat.approvalMode.autoConfirmOk')" danger
      @update:model-value="v => { if (!v) confirmAuto = false }" @confirm="confirmAutoYes" />
  </div>
</template>
