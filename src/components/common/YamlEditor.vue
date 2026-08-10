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
})

const emit = defineEmits(['update:modelValue', 'save', 'discard', 'edit-start'])

const editableContent = ref(props.modelValue)
const hasChanges = ref(false)
const isEditing = ref(false)

// 外部 modelValue 变化 → 同步 + 回到查看模式
watch(() => props.modelValue, (val) => {
  editableContent.value = val
  hasChanges.value = false
  isEditing.value = false
})

// editableContent 变化（编辑时）→ 更新 hasChanges + emit
watch(editableContent, (val) => {
  hasChanges.value = val !== props.modelValue
  emit('update:modelValue', val)
})

async function copy() {
  try { await navigator?.clipboard?.writeText(editableContent.value) } catch {}
}

function startEdit() {
  editableContent.value = props.modelValue
  isEditing.value = true
  emit('edit-start')
}

function handleSave() {
  emit('save', editableContent.value)
  hasChanges.value = false
  isEditing.value = false
}

function handleDiscard() {
  editableContent.value = props.modelValue
  hasChanges.value = false
  isEditing.value = false
  emit('discard')
}
</script>

<template>
  <div class="flex flex-col rounded-lg overflow-hidden border border-outline-variant">
    <!-- Toolbar -->
    <div class="flex items-center justify-between px-md py-sm bg-surface-container-low border-b border-outline-variant">
      <div class="flex items-center gap-sm">
        <span class="material-symbols-outlined text-primary text-lg">description</span>
        <span class="text-label-caps text-on-surface-variant">YAML</span>
        <span v-if="readonly" class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant">READ ONLY</span>
        <span v-if="isEditing" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary-container text-label-caps rounded">EDITING</span>
      </div>
      <div class="flex items-center gap-sm">
        <button v-if="!readonly && !isEditing" @click="startEdit" class="flex items-center gap-xs px-sm py-xs text-body-sm text-primary font-medium hover:bg-primary-container/10 rounded-lg transition-colors">
          <span class="material-symbols-outlined text-base">edit</span> Edit
        </button>
        <button @click="copy" class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm" title="Copy">
          <span class="material-symbols-outlined text-lg">content_copy</span>
        </button>
        <button @click="() => { const b=new Blob([editableContent],{type:'text/yaml'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='resource.yaml'; a.click(); URL.revokeObjectURL(u); }" class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm" title="Download">
          <span class="material-symbols-outlined text-lg">download</span>
        </button>
      </div>
    </div>

    <!-- Diff Mode -->
    <div v-if="diffMode" class="grid grid-cols-2 divide-x divide-outline-variant">
      <div>
        <div class="px-md py-xs bg-surface-container text-label-caps text-on-surface-variant text-center border-b border-outline-variant">LIVE</div>
        <CodeViewer :code="originalValue" lang="yaml" :max-height="height" />
      </div>
      <div>
        <div class="px-md py-xs bg-primary-container/10 text-label-caps text-primary text-center border-b border-outline-variant">EDITABLE</div>
        <textarea v-model="editableContent" class="w-full bg-code-surface text-on-code-surface p-md font-mono text-code-sm outline-none border-0 resize-y" :style="{ minHeight: height, maxHeight: height }"></textarea>
      </div>
    </div>

    <!-- Single Mode -->
    <div v-else>
      <!-- 查看模式（默认）：CodeViewer YAML 高亮 -->
      <CodeViewer v-if="!isEditing" :code="editableContent" lang="yaml" :max-height="height" />
      <!-- 编辑模式：textarea -->
      <textarea v-else v-model="editableContent" class="w-full bg-code-surface text-on-code-surface p-md font-mono text-code-sm outline-none border-0 resize-y" :style="{ minHeight: height, maxHeight: height }"></textarea>
    </div>

    <!-- Action Bar（编辑且有改动时）-->
    <div v-if="isEditing && hasChanges" class="flex justify-end gap-sm px-md py-sm bg-surface-container-low border-t border-outline-variant">
      <button @click="handleDiscard" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high transition-colors">Discard</button>
      <button @click="handleSave" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all">Apply Changes</button>
    </div>
  </div>
</template>
