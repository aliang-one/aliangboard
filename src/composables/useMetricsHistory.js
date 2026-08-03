import { ref, onUnmounted } from 'vue'
import { api } from '@/api/client'

// K8s quantity → 毫核（CPU）/ Mi（内存）
export function toMilli(q) {
  if (q == null) return 0
  if (typeof q === 'number') return q
  const s = String(q)
  if (s.endsWith('m')) return parseInt(s) || 0
  const n = parseFloat(s)
  return isNaN(n) ? 0 : Math.round(n * 1000)
}
export function toMi(q) {
  if (q == null) return 0
  if (typeof q === 'number') return q
  const s = String(q)
  const m = s.match(/^([\d.]+)([KMGTPE]i)?/)
  if (!m) return parseInt(s) || 0
  const n = parseFloat(m[1]); const u = m[2]
  const f = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, Pi: 1024 ** 3, Ei: 1024 ** 4 }
  return Math.round(n * (f[u] || 1))
}

// 工作负载实时指标：每 interval 拉一次 metrics.k8s.io 的 namespace pod 指标，
// 过滤到 podNames 的 Pod，聚合 CPU/内存用量，维护滚动窗口（默认 30 样本≈2.5 分钟）。
// 用法：const { cpuSeries, memSeries, current, available, start } = useMetricsHistory(nsRef, podNamesRef)
export function useMetricsHistory(namespaceRef, podNamesRef, opts = {}) {
  const interval = opts.interval ?? 5000
  const max = opts.max ?? 30
  const cpuSeries = ref([])
  const memSeries = ref([])
  const current = ref({ cpu: 0, mem: 0 })
  const sampling = ref(false)
  const available = ref(true)
  let timer = null
  let stopped = false

  async function tick() {
    if (stopped) return
    const ns = namespaceRef.value
    const names = new Set(podNamesRef.value || [])
    if (!ns || !names.size) return
    sampling.value = true
    try {
      const data = await api.k8s(`/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/pods`)
      let cpu = 0, mem = 0
      for (const pm of (data?.items || [])) {
        if (!names.has(pm.metadata?.name)) continue
        for (const c of (pm.containers || [])) {
          cpu += toMilli(c.usage?.cpu)
          mem += toMi(c.usage?.memory)
        }
      }
      current.value = { cpu, mem }
      cpuSeries.value = [...cpuSeries.value, cpu].slice(-max)
      memSeries.value = [...memSeries.value, mem].slice(-max)
      available.value = true
    } catch {
      available.value = false
    } finally {
      sampling.value = false
    }
  }
  function start() { if (timer || stopped) return; tick(); timer = setInterval(tick, interval) }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null }
  onUnmounted(stop)
  return { cpuSeries, memSeries, current, sampling, available, start, stop }
}
