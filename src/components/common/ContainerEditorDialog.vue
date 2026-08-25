<script setup>
// Init/Sidecar 容器「完整编辑」弹窗:复用 Modal 壳(z 层/ESC/遮罩)。draft 副本编辑,
// 确认(合法才可点)emit('confirm', {...draft}),父组件 Object.assign 写回原槽位
// (数组身份不变 → 卷挂载 init:idx/sidecar:idx target 稳定);取消/ESC/遮罩丢弃 draft。
// 校验单源 logic/containerValidation。显错规则 = 字段 blur 过才显示
// (确认按钮非法即禁用,故无需「点确认后」分支,避免新容器一打开满屏红)。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import ResourceInput from '@/components/common/ResourceInput.vue'
import { validateContainerFields } from '@/logic/containerValidation'
import { sanitizeImageToName } from '@/utils/containerNames'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  container: { type: Object, required: true },
  kind: { type: String, default: 'init' },          // 'init' | 'sidecar'
  index: { type: Number, default: 0 },
  otherNames: { type: Array, default: () => [] },   // 主容器有效名 + 其他容器显式名(查重)
})
const emit = defineEmits(['update:modelValue', 'confirm'])
const { t } = useI18n()

// 打开即重置 draft(8 字段全字符串,浅拷贝即深拷贝)与 touched
const draft = ref({ ...props.container })
const touched = ref({})
watch(() => props.modelValue, open => {
  if (open) { draft.value = { ...props.container }; touched.value = {} }
})

const errors = computed(() => validateContainerFields(draft.value, props.otherNames))
const errorsByField = computed(() => {
  const m = {}
  for (const e of errors.value) if (!m[e.field]) m[e.field] = e
  return m
})
function showErr(field) { return touched.value[field] ? errorsByField.value[field] : null }
function markTouched(field) { touched.value[field] = true }

const title = computed(() => t(props.kind === 'init' ? 'deploy.editInitContainer' : 'deploy.editSidecarContainer'))

// name 留空 → 自动派生名预览(与 YAML 生成同源清洗;撞名时 YAML 端会自动加 -2 序号)
const autoName = computed(() => {
  const base = sanitizeImageToName(draft.value.image) || `${props.kind}-${props.index + 1}`
  return { base, conflict: props.otherNames.includes(base) }
})

function onConfirm() {
  if (errors.value.length) return
  emit('confirm', { ...draft.value })
  emit('update:modelValue', false)
}
</script>

<template>
  <Modal :model-value="modelValue" :title="title" width="max-w-2xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionBasic') }}</h4>
        <div>
          <label for="ced-name" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.containerName') }}</label>
          <input id="ced-name" data-testid="ced-name-input" v-model="draft.name" @blur="markTouched('name')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('name') ? 'border-error' : 'border-outline-variant'" placeholder="init name" />
          <p v-if="showErr('name')" data-testid="ced-name-error" class="text-xs text-error mt-xs">{{ t(showErr('name').msgKey, showErr('name').params) }}</p>
          <p v-else-if="!draft.name" data-testid="ced-auto-name-preview" class="text-xs text-on-surface-variant mt-xs">
            {{ autoName.conflict ? t('deploy.containerFv.autoNameDedupeNote', { name: autoName.base }) : t('deploy.containerFv.autoNamePreview', { name: autoName.base }) }}
          </p>
        </div>
        <div>
          <label for="ced-image" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.imageUrl') }}</label>
          <input id="ced-image" data-testid="ced-image-input" v-model="draft.image" @blur="markTouched('image')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('image') ? 'border-error' : 'border-outline-variant'" placeholder="image" />
          <p v-if="showErr('image')" data-testid="ced-image-error" class="text-xs text-error mt-xs">{{ t(showErr('image').msgKey, showErr('image').params) }}</p>
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionCommand') }}</h4>
        <div>
          <label for="ced-command" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.command') }}</label>
          <input id="ced-command" data-testid="ced-command-input" v-model="draft.command"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="sh -c" />
          <p class="text-xs text-on-surface-variant mt-xs">{{ t('deploy.commandHint') }}</p>
        </div>
        <div>
          <label for="ced-args" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.args') }}<span class="ml-xs font-normal text-on-surface-variant/70">{{ t('deploy.argsHint') }}</span></label>
          <textarea id="ced-args" data-testid="ced-args-input" v-model="draft.args" rows="6"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono resize-y" />
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionResources') }}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <div data-testid="ced-cpu-request" @focusout="markTouched('cpu')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuRequestLabel') }}</label>
            <ResourceInput v-model="draft.cpuRequest" kind="cpu" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuLimitLabel') }}</label>
            <ResourceInput v-model="draft.cpuLimit" kind="cpu" />
          </div>
          <div data-testid="ced-memory-request" @focusout="markTouched('memory')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryRequestLabel') }}</label>
            <ResourceInput v-model="draft.memoryRequest" kind="memory" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryLimitLabel') }}</label>
            <ResourceInput v-model="draft.memoryLimit" kind="memory" />
          </div>
        </div>
        <p v-if="showErr('cpu')" data-testid="ced-cpu-error" class="text-xs text-error">{{ t(showErr('cpu').msgKey, showErr('cpu').params) }}</p>
        <p v-if="showErr('memory')" data-testid="ced-memory-error" class="text-xs text-error">{{ t(showErr('memory').msgKey, showErr('memory').params) }}</p>
      </section>
    </div>

    <template #actions>
      <span v-if="errors.length" class="mr-auto text-xs text-on-surface-variant self-center">{{ t('deploy.containerFv.confirmDisabledHint') }}</span>
      <button data-testid="ced-cancel-btn" @click="emit('update:modelValue', false)"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.modal.cancel') }}</button>
      <button data-testid="ced-confirm-btn" :disabled="errors.length" @click="onConfirm"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-40">{{ t('component.modal.confirm') }}</button>
    </template>
  </Modal>
</template>
