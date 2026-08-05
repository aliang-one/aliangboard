<script setup>
import { ref, computed, watch, onMounted } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  height: { type: String, default: '400px' },
  showLineNumbers: { type: Boolean, default: true },
  diffMode: { type: Boolean, default: false },
  originalValue: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'save', 'discard'])

const editableContent = ref(props.modelValue)
const hasChanges = ref(false)

watch(() => props.modelValue, (val) => {
  editableContent.value = val
  hasChanges.value = false
})

const lines = computed(() => {
  const content = editableContent.value || ''
  return content.split('\n')
})

// 复制到剪贴板（模板内联访问 navigator 在 Vue 中常为 undefined，故收口到函数）
async function copy() {
  try {
    await navigator?.clipboard?.writeText(editableContent.value)
  } catch { /* 剪贴板被浏览器拒绝时静默 */ }
}

function handleInput(e) {
  editableContent.value = e.target.innerText || e.target.textContent
  hasChanges.value = editableContent.value !== props.modelValue
  emit('update:modelValue', editableContent.value)
}

function handleSave() {
  emit('save', editableContent.value)
  hasChanges.value = false
}

function handleDiscard() {
  editableContent.value = props.modelValue
  hasChanges.value = false
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
        <span v-if="hasChanges" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary-container text-label-caps rounded">MODIFIED</span>
      </div>
      <div class="flex items-center gap-sm">
        <button class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm" title="Copy" @click="copy">
          <span class="material-symbols-outlined text-lg">content_copy</span>
        </button>
        <button class="p-1 hover:bg-surface-container rounded text-on-surface-variant text-sm" title="Download" @click="() => { const b=new Blob([editableContent],{type:'text/yaml'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='resource.yaml'; a.click(); URL.revokeObjectURL(u); }">
          <span class="material-symbols-outlined text-lg">download</span>
        </button>
      </div>
    </div>

    <!-- Diff Mode -->
    <div v-if="diffMode" class="grid grid-cols-2 divide-x divide-outline-variant">
      <div>
        <div class="px-md py-xs bg-surface-container text-label-caps text-on-surface-variant text-center border-b border-outline-variant">LIVE</div>
        <div class="bg-[#0b1c30] p-md font-mono text-code-sm text-[#cfe3ff] overflow-auto" :style="{ maxHeight: height }">
          <pre>{{ originalValue }}</pre>
        </div>
      </div>
      <div>
        <div class="px-md py-xs bg-primary-container/10 text-label-caps text-primary text-center border-b border-outline-variant">EDITABLE</div>
        <div
          class="bg-[#0b1c30] p-md font-mono text-code-sm text-[#cfe3ff] overflow-auto outline-none"
          :style="{ maxHeight: height }"
          :contenteditable="!readonly"
          @input="handleInput"
          v-text="editableContent"
        ></div>
      </div>
    </div>

    <!-- Single Editor Mode -->
    <div v-else class="flex">
      <!-- Line Numbers -->
      <div v-if="showLineNumbers" class="bg-[#0b1c30] text-[#cfe3ff]/40 font-mono text-code-sm text-right pr-sm pt-md select-none border-r border-outline-variant/20" :style="{ minHeight: height }">
        <div v-for="(_, i) in lines" :key="i" class="leading-[18px]">{{ i + 1 }}</div>
      </div>
      <!-- Editor -->
      <div
        class="flex-1 bg-[#0b1c30] p-md font-mono text-code-sm text-[#cfe3ff] overflow-auto outline-none whitespace-pre"
        :style="{ minHeight: height, maxHeight: height }"
        :contenteditable="!readonly"
        @input="handleInput"
        v-text="editableContent"
      ></div>
    </div>

    <!-- Action Bar -->
    <div v-if="hasChanges && !readonly" class="flex justify-end gap-sm px-md py-sm bg-surface-container-low border-t border-outline-variant">
      <button @click="handleDiscard" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high transition-colors">Discard</button>
      <button @click="handleSave" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all">Apply Changes</button>
    </div>
  </div>
</template>
