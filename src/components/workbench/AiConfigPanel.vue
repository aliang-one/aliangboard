<script setup>
// AI 配置透明面板(用户只读,2026-08-25 设计):生效系统提示词 + 工具清单 + 追加指令 + 模型。
// 打开对话时显示该对话烘焙的 conv.system(逐对话审计,与 agent 实际发送一致),否则显示全局当前生效。
// 纯只读——没有任何编辑入口;连接配置(baseURL/apiKey)刻意不展示。
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { workbenchApi } from '@/api/client'
import Modal from '@/components/common/Modal.vue'

const props = defineProps({ modelValue: Boolean, conversationId: { type: String, default: null } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const loading = ref(false)
const data = ref(null)     // GET /api/workbench/ai-config
const convSystem = ref('') // 有对话上下文时:该对话创建时烘焙的 system

async function load() {
  loading.value = true; data.value = null; convSystem.value = ''
  try {
    const [cfg, conv] = await Promise.all([
      workbenchApi.aiConfig(),
      props.conversationId ? workbenchApi.conversations.get(props.conversationId).catch(() => null) : Promise.resolve(null),
    ])
    data.value = cfg
    convSystem.value = conv?.system || ''
  } finally { loading.value = false }
}
watch(() => props.modelValue, v => { if (v) load() }, { immediate: true })
</script>

<template>
  <Modal :model-value="modelValue" :title="t('workbench.chat.aiConfig.title')" @update:model-value="emit('update:modelValue', $event)">
    <div class="min-w-[32rem] max-w-[48rem] max-h-[70vh] overflow-y-auto flex flex-col gap-md text-body-sm">
      <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>
      <template v-else-if="data">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workbench.chat.aiConfig.promptTitle') }}</p>
          <p class="text-body-xs text-on-surface-variant mb-xs">{{ convSystem ? t('workbench.chat.aiConfig.promptConvNote') : t('workbench.chat.aiConfig.promptGlobalNote') }}</p>
          <pre class="text-body-xs font-mono whitespace-pre-wrap break-words max-h-56 overflow-y-auto bg-surface-container-low border border-outline-variant rounded-lg p-sm">{{ convSystem || data.effectivePrompt }}</pre>
        </div>
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workbench.chat.aiConfig.toolsTitle') }}</p>
          <div class="flex flex-col gap-xs">
            <div v-for="tool in data.tools" :key="tool.name" class="flex items-center gap-sm" :class="{ 'opacity-40': !tool.enabled }">
              <span class="font-mono">{{ tool.name }}</span>
              <span v-if="tool.requiresApproval" class="px-1.5 py-0.5 rounded text-body-xs font-semibold bg-status-warning/10 text-status-warning">{{ t('workbench.chat.aiConfig.approvalBadge') }}</span>
              <span v-if="!tool.enabled" class="px-1.5 py-0.5 rounded text-body-xs font-semibold bg-surface-container-highest text-on-surface-variant">{{ t('workbench.chat.aiConfig.disabledBadge') }}</span>
              <span class="text-body-xs text-on-surface-variant truncate">{{ tool.description }}</span>
            </div>
          </div>
        </div>
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workbench.chat.aiConfig.instructionsTitle') }}</p>
          <p class="text-body-sm">{{ data.additionalInstructions || t('workbench.chat.aiConfig.none') }}</p>
        </div>
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workbench.chat.aiConfig.modelTitle') }}</p>
          <p class="font-mono">{{ data.model }}</p>
        </div>
      </template>
    </div>
  </Modal>
</template>
