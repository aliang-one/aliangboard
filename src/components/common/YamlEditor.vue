<script setup>
// 统一 YAML 展示组件：默认 CodeViewer 高亮查看；非只读时点「Edit」切换 textarea 编辑；Save/Discard 回到高亮。
import { ref, watch } from 'vue'
import CodeViewer from '@/components/common/CodeViewer.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  height: { type: String, default: '400px' },
  diffMode: { type: Boolean, default: false },
  originalValue: { type: String, default: '' },
  // 传入时根元素挂该 class 且内部单模式视图区改 flex 填充(供最大化弹窗用);
  // 不传 = 行为与固定 height 模式完全一致。与 CodeTextarea 的 heightClass 契约镜像。
  heightClass: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'save', 'discard', 'edit-start'])

const editableContent = ref(props.modelValue)
// 编辑会话基线:startEdit 时的快照,hasChanges 的比较锚点 + Discard 的回滚目标。
// 不直接比 props.modelValue:双向(v-model)消费方里父值随每次键入回流,永远追平草稿,
// hasChanges 会被恒置 false(Action Bar 永不出现)。
const editBase = ref(props.modelValue)
const hasChanges = ref(false)
const isEditing = ref(false)

// 外部 modelValue 变化 → 同步 + 回到查看模式。
// 回声守卫:双向(v-model / :model-value+@update)消费方里,组件自己 emit 的值会经父组件
// 原样回流 —— 那不是外部变化,绝不能打断进行中的编辑(否则键入第一字即被踢出编辑态)。
// 草稿保护:编辑中有未保存改动时,外部(如 live refetch)变化不覆盖用户草稿,交给 save/discard 收束。
watch(() => props.modelValue, (val) => {
  if (val === editableContent.value) return // 自身 emit 的回声:忽略
  if (isEditing.value && hasChanges.value) return
  editableContent.value = val
  editBase.value = val
  hasChanges.value = false
  isEditing.value = false
})

// editableContent 变化（编辑时）→ 更新 hasChanges + emit
watch(editableContent, (val) => {
  hasChanges.value = val !== editBase.value
  emit('update:modelValue', val)
})

async function copy() {
  try { await navigator?.clipboard?.writeText(editableContent.value) } catch {}
}

function startEdit() {
  editBase.value = props.modelValue
  editableContent.value = props.modelValue
  isEditing.value = true
  emit('edit-start')
}

function handleSave() {
  emit('save', editableContent.value)
  editBase.value = editableContent.value
  hasChanges.value = false
  isEditing.value = false
}

function handleDiscard() {
  editableContent.value = editBase.value
  // 双向消费方:父值已随键入漂移,须一并回滚到基线(单向消费方忽略此 emit,无害)
  emit('update:modelValue', editBase.value)
  hasChanges.value = false
  isEditing.value = false
  emit('discard')
}
</script>

<template>
  <div data-testid="yaml-editor-root" class="flex flex-col rounded-lg overflow-hidden border border-outline-variant" :class="heightClass">
    <!-- Toolbar -->
    <div class="flex items-center justify-between px-md py-sm bg-surface-container-low border-b border-outline-variant">
      <div class="flex items-center gap-sm">
        <span class="material-symbols-outlined text-primary text-lg">description</span>
        <span class="text-label-caps text-on-surface-variant">YAML</span>
        <span v-if="readonly" class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant">{{ $t('component.yaml.readOnly') }}</span>
        <span v-if="isEditing" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary-container text-label-caps rounded">{{ $t('common.editing') }}</span>
      </div>
      <div class="flex items-center gap-sm">
        <button v-if="!readonly && !isEditing" @click="startEdit" class="flex items-center gap-xs px-sm py-xs text-body-sm text-primary font-medium hover:bg-primary-container/10 rounded-lg transition-colors">
          <span class="material-symbols-outlined text-base">edit</span> {{ $t('common.edit') }}
        </button>
        <button @click="copy" class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('common.copy')">
          <span class="material-symbols-outlined text-lg">content_copy</span>
        </button>
        <button @click="() => { const b=new Blob([editableContent],{type:'text/yaml'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='resource.yaml'; a.click(); URL.revokeObjectURL(u); }" class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('common.download')">
          <span class="material-symbols-outlined text-lg">download</span>
        </button>
      </div>
    </div>

    <!-- Diff Mode -->
    <div v-if="diffMode" class="grid grid-cols-2 divide-x divide-outline-variant">
      <div>
        <div class="px-md py-xs bg-surface-container text-label-caps text-on-surface-variant text-center border-b border-outline-variant">{{ $t('component.yaml.live') }}</div>
        <CodeViewer :code="originalValue" lang="yaml" :max-height="height" />
      </div>
      <div>
        <div class="px-md py-xs bg-primary-container/10 text-label-caps text-primary text-center border-b border-outline-variant">{{ $t('component.yaml.editable') }}</div>
        <textarea v-model="editableContent" class="w-full bg-code-surface text-on-code-surface p-md font-mono text-code-sm outline-none border-0 resize-y" :style="{ minHeight: height, maxHeight: height }"></textarea>
      </div>
    </div>

    <!-- Single Mode -->
    <div v-else data-testid="yaml-view" :class="heightClass ? 'flex-1 min-h-0 flex flex-col' : ''">
      <!-- 查看模式（默认）：CodeViewer YAML 高亮 -->
      <CodeViewer v-if="!isEditing" :code="editableContent" lang="yaml"
        :class="heightClass ? 'flex-1 min-h-0' : ''" :max-height="heightClass ? '100%' : height" />
      <!-- 编辑模式：textarea -->
      <textarea v-else v-model="editableContent"
        :class="['w-full bg-code-surface text-on-code-surface p-md font-mono text-code-sm outline-none border-0 resize-y', heightClass ? 'flex-1 min-h-0' : '']"
        :style="heightClass ? undefined : { minHeight: height, maxHeight: height }"></textarea>
    </div>

    <!-- Action Bar（编辑且有改动时）-->
    <div v-if="isEditing && hasChanges" class="flex justify-end gap-sm px-md py-sm bg-surface-container-low border-t border-outline-variant">
      <button @click="handleDiscard" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high transition-colors">{{ $t('common.discard') }}</button>
      <button @click="handleSave" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all">{{ $t('common.applyChanges') }}</button>
    </div>
  </div>
</template>
