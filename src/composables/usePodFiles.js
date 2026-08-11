// Pod 文件数据层：封装 podFileApi，带 container:path 复合键缓存。
// 供 FileBrowserBody 及其子组件（经 provide/inject）复用。预留为 Vue Query 迁移替换点。
import { ref } from 'vue'
import { podFileApi } from '@/api/client'

function sortEntries(a, b) {
  return a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
}
function parentDir(path) {
  if (path === '/' || !path) return '/'
  const parts = path.split('/').filter(Boolean); parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}
// Uint8Array → base64（分块避免 fromCharCode 栈溢出，与原 writeBytes 行为一致）
function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function usePodFiles() {
  const dirCache = ref(new Map())   // `${container}::${path}` -> entries[]
  const fileCache = ref(new Map())  // key -> { name, path, content, truncated, binary }
  const inflight = ref(new Set())   // 正在加载的 dir key
  const lastError = ref('')

  const dk = (container, path) => `${container || ''}::${path}`
  const setMap = (refObj, next) => { refObj.value = next } // 整体替换触发响应式

  async function listDir(ctx, path, { force = false } = {}) {
    const k = dk(ctx.container, path)
    if (!force && dirCache.value.has(k)) return dirCache.value.get(k)
    const s = new Set(inflight.value); s.add(k); inflight.value = s
    lastError.value = ''
    try {
      const res = await podFileApi.list({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
      const entries = (res.entries || []).slice().sort(sortEntries)
      setMap(dirCache, new Map(dirCache.value).set(k, entries))
      return entries
    } catch (e) { lastError.value = e.message || 'readDirFailed'; throw e }
    finally { const s2 = new Set(inflight.value); s2.delete(k); inflight.value = s2 }
  }

  async function readFile(ctx, path, { force = false } = {}) {
    const k = dk(ctx.container, path)
    if (!force && fileCache.value.has(k)) return fileCache.value.get(k)
    lastError.value = ''
    try {
      const res = await podFileApi.read({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
      const f = { name: (path.split('/').pop() || path), path: res.path, content: res.content, truncated: res.truncated, binary: res.binary }
      setMap(fileCache, new Map(fileCache.value).set(k, f))
      return f
    } catch (e) { lastError.value = e.message || 'readFailed'; throw e }
  }

  async function writeFile(ctx, path, bytes) {
    await podFileApi.write({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path, data: bytesToBase64(bytes) })
    invalidate(ctx.container, path)
    invalidateDir(ctx.container, parentDir(path))
  }

  function download(ctx, path) {
    return podFileApi.download({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
  }

  function invalidate(container, path) {
    const k = dk(container, path)
    if (fileCache.value.has(k)) setMap(fileCache, (() => { const n = new Map(fileCache.value); n.delete(k); return n })())
  }
  function invalidateDir(container, path) {
    const k = dk(container, path)
    if (dirCache.value.has(k)) setMap(dirCache, (() => { const n = new Map(dirCache.value); n.delete(k); return n })())
  }

  function resetForContainer(container) {
    const prefix = `${container || ''}::`
    const filterMap = (m) => { const n = new Map(); for (const [k, v] of m) if (!k.startsWith(prefix)) n.set(k, v); return n }
    setMap(dirCache, filterMap(dirCache.value))
    setMap(fileCache, filterMap(fileCache.value))
  }

  return { dirCache, fileCache, inflight, lastError, listDir, readFile, writeFile, download, invalidate, invalidateDir, resetForContainer }
}
