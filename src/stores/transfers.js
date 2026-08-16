// 传输任务 store(内存态):下载 fetch 流式 / 上传 XHR 进度,任务跑在 store 里与组件生命周期解耦。
// 刷新即清(fetch/XHR 无法幸存,不做持久化);完成下载经 Blob+a.download 落盘(浏览器下载栏即刻出现完整文件)。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { podFileApi } from '@/api/client'

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// samples: [{t(ms), received}],最近 ~3s 窗口内平均速率;样本不足 → 0。
// 字节基数取窗口边界(或之前)最后一个样本,时间锚点取窗口内第一个样本 —— 即
// 「窗口内累计字节 ÷ 窗口内经过时间」;样本密集时逼近真实窗口均值。
export function speedFromSamples(samples, now) {
  if (samples.length < 2) return 0
  const boundary = now - 3000
  let i = samples.findIndex(s => s.t > boundary)
  if (i === -1) i = 0
  const base = samples[Math.max(0, i - 1)]                       // 边界(或之前)样本:窗口起点字节
  const first = samples[i]                                       // 窗口内第一个样本:时间锚
  const last = samples[samples.length - 1]
  const dt = (last.t - first.t) / 1000
  if (dt <= 0) return 0
  return Math.max(0, (last.received - base.received) / dt)
}

let seq = 0
const controllers = new Map()   // id → AbortController

// Blob 落盘:浏览器下载栏瞬间出现完整文件(流式期间用户一直看的是应用内进度)
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

export const useTransferStore = defineStore('transfers', () => {
  const tasks = ref([])
  const panelOpen = ref(false)

  function patch(id, p) {
    const t = tasks.value.find(x => x.id === id)
    if (t) Object.assign(t, p)   // 经 tasks.value 代理改,保证响应式
  }
  function pushSample(t, received) {
    const samples = t._samples || (t._samples = [])
    samples.push({ t: Date.now(), received })
    while (samples.length > 60) samples.shift()
    t.speed = speedFromSamples(samples, Date.now())
  }
  // 注意:pushSample 需拿代理对象 —— 调用方统一从 tasks.value find 后再传
  function tracked(id) { return tasks.value.find(x => x.id === id) }

  function startDownload(ctx, path) {
    const id = `dl-${Date.now().toString(36)}-${++seq}`
    const name = (path.split('/').pop() || path)
    tasks.value.push({ id, kind: 'download', name, namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path, dir: '', received: 0, total: 0, status: 'active', error: '', startedAt: Date.now(), finishedAt: 0, speed: 0 })
    const ctl = new AbortController()
    controllers.set(id, ctl)
    podFileApi.downloadStream({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path }, {
      onProgress: ({ received, total }) => { const t = tracked(id); if (t) { t.received = received; t.total = total; pushSample(t, received) } },
      signal: ctl.signal,
    })
      .then(blob => { const t = tracked(id); if (t) { patch(id, { status: 'done', finishedAt: Date.now() }); saveBlob(blob, name) } })
      .catch(e => { const t = tracked(id); if (t) patch(id, { status: e?.aborted ? 'canceled' : 'error', error: e?.message || '', finishedAt: Date.now() }) })
      .finally(() => controllers.delete(id))
    return tracked(id)
  }

  function startUpload(ctx, { dir, path, file }) {
    const id = `ul-${Date.now().toString(36)}-${++seq}`
    tasks.value.push({ id, kind: 'upload', name: file.name, namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path, dir, received: 0, total: file.size || 0, status: 'active', error: '', startedAt: Date.now(), finishedAt: 0, speed: 0 })
    const ctl = new AbortController()
    controllers.set(id, ctl)
    podFileApi.uploadStream({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path }, file, {
      onProgress: ({ received, total }) => { const t = tracked(id); if (t) { t.received = received; t.total = total || t.total; pushSample(t, received) } },
      signal: ctl.signal,
    })
      .then(() => patch(id, { status: 'done', received: file.size || 0, finishedAt: Date.now() }))
      .catch(e => patch(id, { status: e?.aborted ? 'canceled' : 'error', error: e?.message || '', finishedAt: Date.now() }))
      .finally(() => controllers.delete(id))
    return tracked(id)
  }

  function cancel(id) { controllers.get(id)?.abort() }
  function remove(id) { const i = tasks.value.findIndex(t => t.id === id); if (i !== -1) tasks.value.splice(i, 1) }
  function clearFinished() { tasks.value = tasks.value.filter(t => t.status === 'active') }
  function openPanel() { panelOpen.value = true }

  const aggregate = computed(() => {
    const known = tasks.value.filter(t => t.total > 0)
    const received = known.reduce((s, t) => s + t.received, 0)
    const total = known.reduce((s, t) => s + t.total, 0)
    return {
      count: tasks.value.length,
      doneCount: tasks.value.filter(t => t.status === 'done').length,
      activeCount: tasks.value.filter(t => t.status === 'active').length,
      received, total,
      pct: total > 0 ? Math.round((received / total) * 100) : null,
    }
  })

  return { tasks, panelOpen, openPanel, startDownload, startUpload, cancel, remove, clearFinished, aggregate }
})
