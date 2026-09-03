<script setup>
// AI 行为配置(admin,2026-08-25 设计):追加指令 + 工具开关(只收紧)+ 生效预览 + 最大执行步数(2026-09-03)。
// 预览来自服务端拼装(effectivePreview)——admin 改什么,新对话发出去的就是什么。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const loading = ref(true)
const saving = ref(false)
const instructions = ref('')
const disabled = ref([])          // string[](Set 语义,vue 响应式用数组+includes)
const projectMemory = ref(true)   // 项目记忆注入(T4,2026-08-29):新对话自动携带项目历史决策摘要
// 最大执行步数(2026-09-03):0=不限制;输入框在勾选不限制时禁用
const maxSteps = ref(16)
const maxStepsUnlimited = ref(false)
const catalog = ref([])
const preview = ref('')
// 悬浮对话入口(2026-08-29 自 WorkbenchConfig 迁入):展示条数/隐去时间,保存约 10s 内全端生效。
const presence = ref({ maxItems: 5, windowMin: 30 })
const presenceSaving = ref(false)

const readTools = computed(() => catalog.value.filter(x => !x.requiresApproval))
const writeTools = computed(() => catalog.value.filter(x => x.requiresApproval))
const allDisabled = computed(() => catalog.value.length > 0 && disabled.value.length >= catalog.value.length)

async function load() {
  loading.value = true
  try {
    const s = await adminApi.workbenchAiConfig.get()
    instructions.value = s.additionalInstructions || ''
    disabled.value = s.disabledTools || []
    projectMemory.value = s.projectMemory !== false   // 服务端缺省视为开
    maxStepsUnlimited.value = s.maxSteps === 0
    maxSteps.value = s.maxSteps > 0 ? s.maxSteps : 16
    catalog.value = s.toolCatalog || []
    preview.value = s.effectivePreview || ''
  } catch (e) {
    notify('error', e.message || t('admin.aiBehavior.loadFailed'))
  } finally { loading.value = false }
}

async function loadPresence() {
  try {
    const r = await adminApi.presenceConfig.get()
    presence.value = { maxItems: r.maxItems, windowMin: r.windowMin }
  } catch { /* 未配置/异常 → 默认 5/30 */ }
}

async function savePresence() {
  presenceSaving.value = true
  try {
    await adminApi.presenceConfig.save({ maxItems: Number(presence.value.maxItems), windowMin: Number(presence.value.windowMin) })
    notify('success', t('admin.aiBehavior.presenceSaved'))
  } catch { notify('error', t('admin.aiBehavior.presenceSaveFailed')) }
  finally { presenceSaving.value = false }
}

onMounted(() => { load(); loadPresence() })

function toggle(name) {
  disabled.value = disabled.value.includes(name)
    ? disabled.value.filter(n => n !== name)
    : [...disabled.value, name]
}

async function save() {
  saving.value = true
  try {
    const n = Number(maxSteps.value)
    const maxStepsPayload = maxStepsUnlimited.value ? 0 : (Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 16)
    await adminApi.workbenchAiConfig.save({ additionalInstructions: instructions.value.slice(0, 4000), disabledTools: disabled.value, projectMemory: projectMemory.value, maxSteps: maxStepsPayload })
    notify('success', t('common.saved'))
    await load() // 保存后刷新预览(服务端拼装,所见即所发)
  } catch (e) {
    notify('error', e.message || t('common.saveFailed'))
  } finally { saving.value = false }
}
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl flex flex-col gap-md">
    <div>
      <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm">
        <span class="material-symbols-outlined">tune</span> {{ $t('admin.aiBehavior.title') }}
      </h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.aiBehavior.subtitle') }}</p>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <template v-else>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md flex flex-col gap-md">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.aiBehavior.instructionsLabel') }}</label>
          <textarea v-model="instructions" rows="4" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" :placeholder="$t('admin.aiBehavior.instructionsPlaceholder')"></textarea>
          <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('admin.aiBehavior.instructionsHint') }}</p>
        </div>

        <!-- 项目记忆注入(T4,2026-08-29):同族开关行 -->
        <div class="flex items-center gap-sm">
          <button data-testid="project-memory-switch" @click="projectMemory = !projectMemory" role="switch" :aria-checked="String(projectMemory)"
            class="w-9 h-5 rounded-full relative transition-colors shrink-0"
            :class="projectMemory ? 'bg-primary' : 'bg-surface-container-highest'">
            <span class="absolute top-0.5 w-4 h-4 rounded-full bg-on-primary transition-all"
              :class="projectMemory ? 'left-4.5' : 'left-0.5'"></span>
          </button>
          <div class="flex flex-col">
            <span class="text-body-sm font-medium">{{ $t('admin.aiBehavior.projectMemory') }}</span>
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.projectMemoryDesc') }}</span>
          </div>
        </div>

        <!-- 最大执行步数(2026-09-03):0/勾选=不限制,仅上下文预算兜底;保存即时生效 -->
        <div class="flex flex-col gap-xs">
          <div class="flex items-center gap-sm flex-wrap">
            <button data-testid="max-steps-unlimited" @click="maxStepsUnlimited = !maxStepsUnlimited" role="switch" :aria-checked="String(maxStepsUnlimited)"
              class="w-9 h-5 rounded-full relative transition-colors shrink-0"
              :class="maxStepsUnlimited ? 'bg-primary' : 'bg-surface-container-highest'">
              <span class="absolute top-0.5 w-4 h-4 rounded-full bg-on-primary transition-all"
                :class="maxStepsUnlimited ? 'left-4.5' : 'left-0.5'"></span>
            </button>
            <span class="text-body-sm font-medium">{{ $t('admin.aiBehavior.maxStepsUnlimited') }}</span>
            <label class="flex items-center gap-xs ml-auto">
              <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.maxStepsLabel') }}</span>
              <input v-model.number="maxSteps" type="number" min="1" max="200" :disabled="maxStepsUnlimited" data-testid="max-steps"
                class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm disabled:opacity-40" />
            </label>
          </div>
          <p class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.maxStepsHint') }}</p>
        </div>
      </div>

      <!-- 悬浮对话入口(2026-08-29 自 WorkbenchConfig 迁入):独立保存端点,与上方主保存按钮互不影响 -->
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md flex flex-col gap-md">
        <p class="text-label-caps text-on-surface-variant">{{ $t('admin.aiBehavior.presenceTitle') }}</p>
        <div class="flex items-end gap-md flex-wrap">
          <label class="flex flex-col gap-xs">
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceMaxItems') }}</span>
            <input v-model.number="presence.maxItems" type="number" min="1" max="20" data-testid="presence-max"
              class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
          </label>
          <label class="flex flex-col gap-xs">
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceWindowMin') }}</span>
            <input v-model.number="presence.windowMin" type="number" min="1" max="1440" data-testid="presence-window"
              class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
          </label>
          <button data-testid="presence-save" @click="savePresence" :disabled="presenceSaving"
            class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40">
            {{ $t('common.save') }}</button>
        </div>
        <p class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceHint') }}</p>
      </div>

      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md flex flex-col gap-md">
        <p class="text-label-caps text-on-surface-variant">{{ $t('admin.aiBehavior.toolsTitle') }}</p>
        <div v-if="allDisabled" class="rounded-lg p-sm text-body-sm bg-status-warning/10 text-status-warning flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">warning</span> {{ $t('admin.aiBehavior.allDisabledWarn') }}
        </div>
        <div v-for="group in [{ key: 'readGroup', items: readTools }, { key: 'writeGroup', items: writeTools }]" :key="group.key">
          <p class="text-body-xs font-semibold text-on-surface-variant mb-xs">{{ $t(`admin.aiBehavior.${group.key}`) }}</p>
          <div class="flex flex-col gap-xs">
            <div v-for="tool in group.items" :key="tool.name" class="flex items-center gap-sm bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs">
              <button @click="toggle(tool.name)" role="switch" :aria-checked="!disabled.includes(tool.name)"
                class="w-9 h-5 rounded-full relative transition-colors shrink-0"
                :class="disabled.includes(tool.name) ? 'bg-surface-container-highest' : 'bg-primary'">
                <span class="absolute top-0.5 w-4 h-4 rounded-full bg-on-primary transition-all"
                  :class="disabled.includes(tool.name) ? 'left-0.5' : 'left-4.5 bg-on-primary'"></span>
              </button>
              <span class="font-mono text-body-sm">{{ tool.name }}</span>
              <span v-if="tool.requiresApproval" class="px-1.5 py-0.5 rounded text-body-xs font-semibold bg-status-warning/10 text-status-warning shrink-0">{{ $t('admin.aiBehavior.approvalBadge') }}</span>
              <span class="text-body-xs text-on-surface-variant truncate">{{ tool.description }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md flex flex-col gap-sm">
        <p class="text-label-caps text-on-surface-variant">{{ $t('admin.aiBehavior.previewTitle') }}</p>
        <p class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.previewHint') }}</p>
        <pre class="text-body-xs font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-sm">{{ preview }}</pre>
        <div>
          <button data-testid="save-btn" @click="save" :disabled="saving"
            class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">
            <span class="material-symbols-outlined text-base">save</span> {{ saving ? $t('admin.llm.saving') : $t('common.save') }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
