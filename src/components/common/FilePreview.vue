<script setup>
// 右栏·文件：path 变化→readFile；查看态 CodeViewer 高亮；编辑态 textarea；
// 二进制→占位+下载；截断→提示+下载。保存走 usePodFiles.writeFile。
import { ref, computed, watch, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { langFor } from '@/logic/fileLang'
import { notify } from '@/composables/useToast'
import CodeViewer from './CodeViewer.vue'

const { t } = useI18n()
const props = defineProps({ path: { type: String, required: true } })
const x = inject('fileExplorer')

const file = ref(null)        // { name, path, content, truncated, binary }
const loading = ref(false)
const error = ref('')
const editing = ref(false)
const editContent = ref('')
const saving = ref(false)

const lang = computed(() => (file.value ? langFor(file.value.name) : 'none'))
const editable = computed(() => !!file.value && !file.value.binary && !file.value.truncated)

async function load() {
  loading.value = true; error.value = ''; editing.value = false
  try {
    file.value = await x.readFile(props.path)
  } catch (e) { error.value = e.message || t('component.fileBrowser.readFailed') }
  finally { loading.value = false }
}
watch(() => props.path, load, { immediate: true })

function startEdit() { if (!editable.value) return; editContent.value = file.value.content; editing.value = true }
function cancelEdit() { editing.value = false }
async function saveEdit() {
  saving.value = true
  try {
    await x.writeFile(file.value.path, new TextEncoder().encode(editContent.value))
    notify('success', t('component.fileBrowser.saved'))
    file.value = { ...file.value, content: editContent.value }
    editing.value = false
  } catch (e) { notify('error', e.message || t('component.fileBrowser.saveFailed')) }
  finally { saving.value = false }
}
async function download() {
  try {
    const blob = await x.download(file.value.path)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = file.value.name; a.click(); URL.revokeObjectURL(url)
  } catch (e) { notify('error', e.message || t('component.fileBrowser.downloadFailed')) }
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- 头部：路径 + 徽标 + 操作 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0 pr-10">
      <span class="material-symbols-outlined text-base text-on-surface-variant shrink-0">description</span>
      <span class="font-mono text-xs truncate flex-1" :title="path">{{ file?.name || path }}</span>
      <span v-if="file?.binary" class="text-[10px] px-1 rounded bg-surface-container text-on-surface-variant shrink-0">{{ t('component.fileBrowser.binary') }}</span>
      <span v-else-if="file?.truncated" class="text-[10px] px-1 rounded bg-tertiary-container/20 text-tertiary-container shrink-0">{{ t('component.fileBrowser.truncated') }}</span>
      <button class="p-1 rounded-md text-on-surface-variant hover:text-primary hover:bg-primary/10 shrink-0" :title="t('component.fileBrowser.download')" @click="download"><span class="material-symbols-outlined text-base">download</span></button>
      <template v-if="editable && !editing">
        <button class="fb-edit flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0" @click="startEdit"><span class="material-symbols-outlined text-sm">edit</span>{{ t('common.edit') }}</button>
      </template>
      <template v-else-if="editing">
        <button class="px-sm py-1 rounded-md border border-outline-variant text-xs text-on-surface hover:bg-surface-container shrink-0" @click="cancelEdit">{{ t('common.cancel') }}</button>
        <button class="fb-save flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 shrink-0" :disabled="saving" @click="saveEdit"><span class="material-symbols-outlined text-sm">{{ saving ? 'progress_activity' : 'save' }}</span>{{ t('common.save') }}</button>
      </template>
    </div>

    <!-- 主体 -->
    <div class="flex-1 overflow-auto mt-sm min-h-0">
      <p v-if="loading" class="py-md text-center text-body-sm text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></p>
      <p v-else-if="error" class="text-body-sm text-error py-sm flex items-center gap-xs"><span class="material-symbols-outlined text-base">error</span>{{ error }}</p>
      <template v-else-if="file">
        <!-- 截断提示 -->
        <p v-if="file.truncated" class="text-[11px] text-tertiary-container bg-tertiary-container/10 px-sm py-xs rounded mb-sm flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">warning</span>{{ t('component.fileBrowser.contentTruncated') }}
        </p>
        <!-- 二进制 -->
        <div v-if="file.binary" class="py-md text-center text-body-sm text-on-surface-variant/70 flex flex-col items-center gap-sm">
          <span class="material-symbols-outlined text-2xl">memory</span>
          <span>{{ t('component.fileBrowser.binaryHint') }}</span>
        </div>
        <!-- 查看 -->
        <CodeViewer v-else-if="!editing" :code="file.content" :lang="lang" max-height="100%" />
        <!-- 编辑 -->
        <textarea v-else v-model="editContent" class="w-full bg-code-surface text-on-code-surface p-md rounded-lg font-mono text-code-sm outline-none border border-primary/40" style="resize: none; min-height: 60vh" />
      </template>
    </div>
  </div>
</template>
