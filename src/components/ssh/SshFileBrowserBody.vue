<script setup>
// SSH 文件浏览体(Task 14):面包屑 + 扁平列表(目录优先,服务端已排序)+ 上传/下载进度。
// 进度走本地 ref(transfers store 为 pod 专属契约,不硬套);512MB 客户端预检;
// 上传名含 / \ .. . 前端先拦(服务端同样拒绝);ENOENT → 「路径不存在」。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { sshFileApi } from '@/api/client'

const { t } = useI18n()
const props = defineProps({
  serverId: { type: String, required: true },
  serverName: { type: String, default: '' },
})

const MAX_UPLOAD = 512 * 1024 * 1024   // 512MB,与服务端一致
const path = ref('/')
const entries = ref([])
const loading = ref(false)
const error = ref('')            // 行内红字
const fileInput = ref(null)
// { kind:'upload'|'download', name, received, total } | null
const progress = ref(null)
let transferAbort = null

const crumbs = computed(() => {
  const segs = path.value.split('/').filter(Boolean)
  return [{ name: '/', p: '/' }, ...segs.map((s, i) => ({ name: s, p: '/' + segs.slice(0, i + 1).join('/') }))]
})
const pct = computed(() => {
  const p = progress.value
  if (!p || !p.total) return null
  return Math.floor((p.received / p.total) * 100)
})
const isBadName = n => n.includes('/') || n.includes('\\') || n === '..' || n === '.' || n.includes('..')

async function load(p) {
  loading.value = true; error.value = ''
  try {
    const r = await sshFileApi.list(props.serverId, p)
    path.value = r.path || p
    entries.value = r.entries || []
  } catch (e) {
    entries.value = []
    error.value = /ENOENT|not found|\u4e0d\u5b58\u5728/i.test(e?.message || '') ? t('ssh.pathMissing') : (e?.message || t('ssh.pathMissing'))
  } finally { loading.value = false }
}
const refresh = () => load(path.value)
function openDir(name) {
  load(path.value === '/' ? '/' + name : path.value + '/' + name)
}
function crumbTo(p) { if (!transferBusy.value) load(p) }

const transferBusy = computed(() => !!progress.value && !progress.value.done)

async function onDownload(entry) {
  if (transferBusy.value) return
  const fp = path.value === '/' ? '/' + entry.name : path.value + '/' + entry.name
  transferAbort = new AbortController()
  progress.value = { kind: 'download', name: entry.name, received: 0, total: 0 }
  try {
    const blob = await sshFileApi.downloadStream(
      { serverId: props.serverId, path: fp },
      { onProgress: ({ received, total }) => { Object.assign(progress.value, { received, total }) }, signal: transferAbort.signal },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = entry.name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    progress.value.done = true   // 完成保留终值,用户可关闭条目;下次传输自动替换
  } catch (e) {
    progress.value = null
    if (e?.aborted) return
    notify('error', e?.message || t('ssh.download'))
  }
}

function pickUpload() { fileInput.value?.click() }
async function onUpload(e) {
  const f = e.target.files?.[0]
  e.target.value = ''
  if (!f) return
  // 客户端预检:非法名/超限(服务端同款拒绝,先拦给出友好提示)
  if (isBadName(f.name)) { error.value = t('ssh.badName', { name: f.name }); return }
  if (f.size > MAX_UPLOAD) { error.value = t('ssh.uploadLimit'); return }
  if (transferBusy.value) return
  transferAbort = new AbortController()
  progress.value = { kind: 'upload', name: f.name, received: 0, total: f.size }
  try {
    await sshFileApi.uploadStream(
      { serverId: props.serverId, path: path.value, name: f.name }, f,
      { onProgress: ({ received, total }) => { Object.assign(progress.value, { received, total }) }, signal: transferAbort.signal },
    )
    progress.value.done = true
    notify('success', t('ssh.uploaded', { name: f.name }))
    refresh()   // 完成后刷新当前目录
  } catch (err) {
    progress.value = null
    if (err?.aborted) return
    error.value = err?.message || t('ssh.uploadFailed')
  }
}
function cancelTransfer() { transferAbort?.abort(); progress.value = null }

onMounted(() => load('/'))
onBeforeUnmount(() => transferAbort?.abort())   // 关窗中止在途传输
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 工具条:面包屑 + 刷新 + 上传 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0 overflow-x-auto">
      <template v-for="(c, i) in crumbs" :key="c.p">
        <button v-if="i" class="text-on-surface-variant/40 shrink-0" disabled>/</button>
        <button data-test="crumb" class="px-1 rounded text-on-surface-variant hover:bg-surface-container hover:text-primary font-mono text-xs shrink-0"
          :class="i === crumbs.length - 1 ? 'text-primary font-semibold' : ''" @click="crumbTo(c.p)">{{ c.name }}</button>
      </template>
      <span class="flex-1" />
      <button class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('common.sync')" @click="refresh">
        <span class="material-symbols-outlined text-base" :class="loading ? 'animate-spin' : ''">refresh</span>
      </button>
      <button data-test="btnUpload" class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0"
        :title="t('ssh.uploadLimit')" @click="pickUpload">
        <span class="material-symbols-outlined text-sm">upload</span>{{ t('ssh.upload') }}
      </button>
    </div>

    <!-- 列表 -->
    <div class="flex-1 min-h-0 overflow-y-auto mt-xs">
      <div v-if="loading" class="p-md text-body-sm text-on-surface-variant">{{ t('common.loading') }}</div>
      <div v-else-if="error" data-test="error" class="p-md text-body-sm text-error">{{ error }}</div>
      <div v-else-if="!entries.length" class="p-md text-body-sm text-on-surface-variant/60">{{ t('ssh.emptyDir') }}</div>
      <template v-else>
        <div v-for="en in entries.filter(x => x.type === 'dir')" :key="'d' + en.name" data-test="dirRow"
          class="flex items-center gap-sm px-sm py-1.5 rounded-md hover:bg-surface-container/60 cursor-pointer font-mono text-body-sm"
          @click="openDir(en.name)">
          <span class="material-symbols-outlined text-base text-primary">folder</span>{{ en.name }}
        </div>
        <div v-for="en in entries.filter(x => x.type === 'file')" :key="'f' + en.name" data-test="fileRow"
          class="flex items-center gap-sm px-sm py-1.5 rounded-md hover:bg-surface-container/60 font-mono text-body-sm">
          <span class="material-symbols-outlined text-base text-on-surface-variant">description</span>
          <span class="flex-1 truncate">{{ en.name }}</span>
          <button data-test="btnDownload" class="flex items-center gap-0.5 px-sm py-0.5 rounded bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0"
            @click="onDownload(en)">
            <span class="material-symbols-outlined text-sm">download</span>{{ t('ssh.download') }}
          </button>
        </div>
      </template>
    </div>

    <!-- 进度条(上传/下载共用;total 未知时只显已收字节) -->
    <div v-if="progress" data-test="progress" class="flex items-center gap-sm pt-sm border-t border-outline-variant/40 shrink-0">
      <span class="material-symbols-outlined text-sm text-primary">{{ progress.kind === 'upload' ? 'upload' : 'download' }}</span>
      <span class="font-mono text-xs text-on-surface-variant truncate max-w-[240px]">{{ progress.name }}</span>
      <div class="flex-1 h-1.5 rounded-full bg-surface-container overflow-hidden">
        <div class="h-full bg-primary transition-all" :style="{ width: (pct ?? 100) + '%' }" />
      </div>
      <span class="text-xs text-on-surface-variant shrink-0">{{ pct !== null ? pct + '%' : Math.round(progress.received / 1024) + ' KB' }}</span>
      <button class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('common.cancel')" @click="cancelTransfer">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>

    <input ref="fileInput" type="file" class="hidden" @change="onUpload">
  </div>
</template>
