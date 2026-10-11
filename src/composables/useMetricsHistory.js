import { ref, onUnmounted } from 'vue'
import { api } from '@/api/client'
import { toBaseValue } from '@/composables/useResourceQuantity'

// K8s quantity → 毫核（CPU）/ Mi（内存）。文法解析单源 toBaseValue(完整后缀+科学计数):
// 指数形态('1E9')曾按裸前缀处理,参考线画在 ~9.5e11 Mi(10^9 倍错,审查修复)。
export function toMilli(q) {
  if (q == null) return 0
  if (typeof q === 'number') return q
  const v = toBaseValue(String(q), 'cpu')
  const m = v == null ? 0 : v
  // 标准整数毫核(1000m=1 核),对齐 kubectl top:非零用量至少显示 1m,避免 0.02m 被 round 抹成 0m
  return m > 0 ? Math.max(1, Math.round(m)) : 0
}
export function toMi(q) {
  if (q == null) return 0
  if (typeof q === 'number') return q
  const s = String(q)
  const v = toBaseValue(s, 'memory')
  // 非法串退 parseInt 兜底(与旧实现一致);裸数字=字节(曾误当 Mi)
  const mi = v == null ? (parseInt(s) || 0) / 2 ** 20 : v / 1024
  // 与 toMilli 同款:非零值至少 1Mi,避免亚 Mi 值被 round 抹成 0 参考线消失
  return mi > 0 ? Math.max(1, Math.round(mi)) : 0
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
  const failThreshold = opts.failThreshold ?? 3   // 连续失败 N 次进入退避
  const failBackoff = opts.failBackoff ?? 30000   // 退避间隔:metrics endpoint 挂了(503)别每 5s 空转刷屏
  let timer = null
  let stopped = false
  let failStreak = 0

  function scheduleNext(delay) { if (!stopped) timer = setTimeout(tick, delay) }

  async function tick() {
    if (stopped) return
    const ns = namespaceRef.value
    const names = new Set(podNamesRef.value || [])
    if (!ns || !names.size) { scheduleNext(interval); return }
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
      failStreak = 0
    } catch {
      available.value = false
      failStreak++
    } finally {
      sampling.value = false
    }
    // 连续失败 → 退避(避免对不可用的 metrics endpoint 每秒级空转);一旦成功 failStreak 复原回基础间隔
    scheduleNext(failStreak >= failThreshold ? failBackoff : interval)
  }
  function start() { if (timer || stopped) return; scheduleNext(interval) }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null }
  onUnmounted(stop)
  return { cpuSeries, memSeries, current, sampling, available, start, stop }
}
