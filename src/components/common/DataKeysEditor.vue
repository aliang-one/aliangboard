<script setup>
// 文件浏览器式多键管理编辑器：
// - 自由模式（fixedFields 空）：左键列表 + 右查看(CodeViewer)/编辑(textarea)，hover 删、底部添加
// - 固定模式（fixedFields 非空）：无左栏，固定字段纵向排列，secret 单行 input 掩码可切换
// - 自由模式 secret：左栏值摘要掩码（••••），编辑仍 textarea（多行值）
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import CodeViewer from './CodeViewer.vue'
import { detectLang, lineCount } from '@/utils/detectLang'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  secret: { type: Boolean, default: false },
  fixedFields: { type: Array, default: null },
})
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()

const isFixed = computed(() => Array.isArray(props.fixedFields) && props.fixedFields.length > 0)

// ---- 自由模式状态 ----
const selectedIdx = ref(0)
const editing = ref(false)
const draft = ref('')
const revealed = ref(new Set()) // 自由模式全局掩码用 '' 哨兵；固定模式按 key
const editArea = ref(null)

const entries = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
const selected = computed(() => entries.value[selectedIdx.value] || null)

watch(entries, (list) => {
  // 只钳制删除后的选中越界；不重置 editing——编辑中的 draft 不得被父回灌的
  // modelValue 引用级变化（如 updateKey 改键名）静默丢弃（契约：Save 前
  // 父组件更新 modelValue 不得覆盖 draft）。被编辑条目被删除时由
  // removeKey 显式退出编辑。saveEdit 按当前 selectedIdx 索引写回，
  // 键名在编辑期间被改名也能写到正确条目。
  if (selectedIdx.value >= list.length) selectedIdx.value = Math.max(0, list.length - 1)
})

function toggleReveal(token) {
  const s = new Set(revealed.value)
  s.has(token) ? s.delete(token) : s.add(token)
  revealed.value = s
}

function emitEntries(list) {
  emit('update:modelValue', list)
}

function addKey() {
  const list = entries.value.map((e) => ({ ...e }))
  list.push({ key: '', value: '' })
  selectedIdx.value = list.length - 1
  editing.value = false
  emitEntries(list)
}

function removeKey(i) {
  const list = entries.value.filter((_, idx) => idx !== i).map((e) => ({ ...e }))
  selectedIdx.value = 0 // 删除后选中移到首键（空则空态）
  editing.value = false
  emitEntries(list)
}

function updateKey(i, newKey) {
  const list = entries.value.map((e, idx) => (idx === i ? { ...e, key: newKey } : { ...e }))
  emitEntries(list)
}

function startEdit() {
  draft.value = selected.value ? selected.value.value : ''
  editing.value = true
  nextTick(() => editArea.value?.focus?.())
}

function saveEdit() {
  if (!selected.value) return
  const list = entries.value.map((e, idx) => (idx === selectedIdx.value ? { ...e, value: draft.value } : { ...e }))
  editing.value = false
  emitEntries(list)
}

function cancelEdit() {
  editing.value = false // 丢弃 draft
}

// ---- 固定字段模式 ----
function fieldValue(fKey) {
  const found = entries.value.find((e) => e.key === fKey)
  return found ? found.value : ''
}

function setFieldValue(fKey, val) {
  const list = entries.value.map((e) => ({ ...e }))
  const idx = list.findIndex((e) => e.key === fKey)
  if (idx >= 0) list[idx] = { ...list[idx], value: val }
  else list.push({ key: fKey, value: val })
  emitEntries(list)
}
</script>

<template>
  <!-- 固定字段模式：无左栏，字段纵向排列 -->
  <div v-if="isFixed" class="flex flex-col gap-md">
    <div v-for="f in fixedFields" :key="f.key" class="flex flex-col gap-xs">
      <label class="text-body-sm font-medium text-on-surface-variant">{{ t(f.labelKey) }}</label>
      <textarea v-if="f.multiline" :value="fieldValue(f.key)" @input="setFieldValue(f.key, $event.target.value)"
        class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono min-h-[120px] resize-y focus:ring-2 focus:ring-primary focus:border-primary" />
      <div v-else class="flex">
        <input v-if="f.secret" :type="revealed.has(f.key) ? 'text' : 'password'" :value="fieldValue(f.key)"
          @input="setFieldValue(f.key, $event.target.value)"
          class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-l-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary focus:border-primary" />
        <input v-else :value="fieldValue(f.key)" @input="setFieldValue(f.key, $event.target.value)"
          class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary focus:border-primary" />
        <button v-if="f.secret" :data-testid="`dk-mask-${f.key}`" type="button" @click="toggleReveal(f.key)"
          class="px-sm border border-l-0 border-outline-variant rounded-r-lg text-on-surface-variant hover:bg-surface-container-low"
          :title="t('component.dataKeysEditor.toggleMask')">
          <span class="material-symbols-outlined text-base">{{ revealed.has(f.key) ? 'visibility_off' : 'visibility' }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- 自由模式：左键列表 + 右内容 -->
  <div v-else class="grid grid-cols-[220px_1fr] gap-md">
    <!-- 左栏：键列表 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
      <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center gap-sm">
        <span class="material-symbols-outlined text-secondary text-base">folder</span>
        <span class="text-label-caps text-on-surface-variant truncate flex-1">{{ t('component.dataKeysEditor.keysCount', { n: entries.length }) }}</span>
        <button v-if="secret" data-testid="dk-mask" type="button" @click="toggleReveal('')"
          class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="t('component.dataKeysEditor.toggleMask')">
          <span class="material-symbols-outlined text-base">{{ revealed.has('') ? 'visibility_off' : 'visibility' }}</span>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto max-h-[60vh]">
        <div v-for="(e, i) in entries" :key="i" @click="selectedIdx = i; editing = false"
          class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors group cursor-pointer"
          :class="selectedIdx === i ? 'bg-primary-container/15 text-primary' : 'text-on-surface hover:bg-surface-container-low'">
          <span class="material-symbols-outlined text-base shrink-0" :class="selectedIdx === i ? 'text-primary' : 'text-on-surface-variant'">{{ detectLang(e.key).icon }}</span>
          <div class="flex-1 min-w-0">
            <!-- 选中行为 key 输入（新键可改名） -->
            <input v-if="selectedIdx === i" :value="e.key" @click.stop @input="updateKey(i, $event.target.value)"
              class="w-full bg-transparent border-0 border-b border-outline-variant/50 focus:ring-0 focus:border-primary text-body-sm font-mono px-0 py-0" />
            <div v-else class="text-body-sm font-mono truncate">{{ e.key }}</div>
            <div class="text-[10px] text-on-surface-variant truncate">
              {{ secret && !revealed.has('') ? '••••' : (e.value ? e.value.split('\n')[0].slice(0, 24) : '') }}
            </div>
          </div>
          <span class="text-[10px] text-on-surface-variant shrink-0">{{ lineCount(e.value) }}</span>
          <button :data-testid="`dk-del-${i}`" type="button" @click.stop="removeKey(i)"
            class="opacity-0 group-hover:opacity-100 max-sm:opacity-100 p-0.5 text-on-surface-variant hover:text-error rounded transition-opacity shrink-0" :title="t('common.delete')">
            <span class="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
        <div v-if="!entries.length" class="px-md py-lg text-center text-on-surface-variant text-body-sm">{{ t('component.dataKeysEditor.noKeys') }}</div>
      </div>
      <button data-testid="dk-add" type="button" @click="addKey"
        class="flex items-center justify-center gap-sm px-md py-sm border-t border-outline-variant text-body-sm text-primary font-medium hover:bg-primary-container/10 transition-colors">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('component.dataKeysEditor.addKey') }}
      </button>
    </div>

    <!-- 右栏：内容 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
      <template v-if="selected">
        <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <div class="flex items-center gap-sm min-w-0">
            <span class="material-symbols-outlined text-base text-on-surface-variant shrink-0">{{ detectLang(selected.key).icon }}</span>
            <span class="font-mono text-code-sm text-primary font-semibold truncate">{{ selected.key || t('component.dataKeysEditor.untitled') }}</span>
            <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded text-label-caps font-medium shrink-0" :class="detectLang(selected.key).color">
              <span class="material-symbols-outlined text-xs">{{ detectLang(selected.key).icon }}</span>{{ detectLang(selected.key).label }}
            </span>
            <span class="text-label-caps text-on-surface-variant shrink-0">{{ t('component.dataKeysEditor.lineCount', { n: lineCount(selected.value) }) }}</span>
          </div>
          <div class="flex gap-xs shrink-0">
            <button v-if="!editing" data-testid="dk-edit" type="button" @click="startEdit"
              class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')">
              <span class="material-symbols-outlined text-lg">edit</span>
            </button>
          </div>
        </div>
        <!-- 编辑模式 -->
        <div v-if="editing" class="p-md flex-1">
          <textarea ref="editArea" v-model="draft"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[300px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
          <div class="flex justify-end gap-sm mt-sm">
            <button data-testid="dk-cancel" type="button" @click="cancelEdit" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ t('common.cancel') }}</button>
            <button data-testid="dk-save" type="button" @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">{{ t('common.save') }}</button>
          </div>
        </div>
        <!-- 查看模式 -->
        <div v-else class="p-md flex-1">
          <CodeViewer :code="selected.value" :lang="detectLang(selected.key).prismLang" />
        </div>
      </template>
      <!-- 空态 -->
      <div v-else data-testid="dk-empty" class="flex items-center justify-center flex-1 min-h-[300px] text-on-surface-variant">
        <div class="text-center">
          <span class="material-symbols-outlined text-3xl text-surface-container-high">description</span>
          <p class="mt-sm text-body-sm">{{ t('component.dataKeysEditor.emptyHint') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
