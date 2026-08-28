// cluster store · 指标域(Plan 5 第二波,2026-08-28):refreshMetrics(集群概览指标拉取)+ 15min 窗口
// 采样器(按集群持久化,多消费者共享)+ computeClusterMetrics(采样→概览展示形状)。
// 自 cluster.js 逐字搬迁;依赖显式注入;store 公开名不变。
import { ref } from 'vue'
import { api } from '@/api/client'
import { queryClient } from '@/queryClient'
import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'
import { deriveClusterCounts } from '@/logic/clusterCounts'
import { pushSample, restoreSamples, persistPayload } from '@/logic/metricsWindow'
import { notify } from '@/composables/useToast'

export function createMetricsDomain({ cluster, clusterList, currentCluster, nodeList, namespaceList }) {
  let prevClusterMetrics = { cpu: null, mem: null }
  // 轻量 metrics 刷新：只重拉 metrics.k8s.io nodes+pods → 就地更新现有 nodeList 指标字段 → 重算集群汇总。
  // 供监控中心高频轮询；不重拉 nodes/pods 列表（结构不变）。失败静默（保留上次 metricsAvailable，下次全量 hydrate 纠正）。
  async function refreshMetrics() {
    try {
      const [nodeMetricsData, podMetricsData] = await Promise.all([
        api.k8s('/apis/metrics.k8s.io/v1beta1/nodes'),
        api.k8s('/apis/metrics.k8s.io/v1beta1/pods'),
      ])
      const metricsAvailable = Boolean(nodeMetricsData && podMetricsData)
      const nodeMetricMap = new Map()
      for (const it of (nodeMetricsData?.items || [])) nodeMetricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
      const podMetricMap = new Map()
      for (const it of (podMetricsData?.items || [])) {
        let cpuMilli = 0, memKi = 0
        for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
        podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
      }
      const pct = (used, alloc) => (used != null && alloc > 0 ? Math.min(100, Math.round((used / alloc) * 100)) : null)
      for (const n of nodeList.value) {
        const m = metricsAvailable ? (nodeMetricMap.get(n.name) || null) : null
        n.usedCpu = m ? m.cpuMilli : null
        n.usedMem = m ? m.memKi : null
        n.cpu = pct(n.usedCpu, n.allocCpu)
        n.memory = pct(n.usedMem, n.allocMem)
      }
      // P2-B:pod 级指标不再写孤儿 podList——NsPods 等由 fetchPods 的 Query 轮询携带 podMetric;
      // podMetricMap 仅用于 metricsAvailable 探测(pods metrics 端点可达性)。
      computeClusterMetrics(metricsAvailable)
    } catch { /* 静默：保留上次 metricsAvailable */ }
  }

  // === 集群指标采样(全局共享,15min 窗口按集群持久化) ===
  // ClusterOverview/MonitoringCenter 引用计数共享:切页不清零、不双倍轮询;
  // 恢复窗口来自 localStorage,图表首屏即有最近 15 分钟历史。
  const cpuSamples = ref([])
  const memSamples = ref([])
  const metricsSampling = ref(false)
  const metricsLastRefresh = ref(null)
  let metricsTimer = null
  let metricsConsumers = 0
  let metricsVisListener = null
  // 切集群竞态双守卫:
  // - metricsEpoch:窗口代数。reloadMetricsWindow 真重载时 ++;tick 入口捕获、await 后
  //   不等则丢弃本次 push/persist——杀变体 A(tick 挂起间切集群,恢复后旧集群值进新窗口/新 key)。
  // - metricsHold:switchCluster 入口置 true、自身 finally 必清(hydrateCriticalResources
  //   的 finally 也兜底清)。hold 期间 tick 直接 return——杀变体 B(nodeList 未换血前,
  //   旧节点配新集群 metrics 算出 0% 假样本并持久化)。
  let metricsEpoch = 0
  let metricsHold = false
  // 当前内存窗口所属集群:reloadMetricsWindow 同集群时跳过重载——隐私模式/配额下
  // (localStorage 读写退化)页面导航 stop/start 不再清窗,会话内窗口得以延续。
  const metricsWindowCluster = ref(null)

  function metricsStorageKey() {
    return currentCluster.value ? `aliangboard.metrics.${encodeURIComponent(currentCluster.value)}.v1` : null
  }
  function persistMetricsWindow() {
    const key = metricsStorageKey()
    if (!key) return
    try { localStorage.setItem(key, JSON.stringify(persistPayload(cpuSamples.value, memSamples.value))) } catch { /* 配额/隐私模式:退化为会话内窗口 */ }
  }
  // 从 localStorage 恢复当前集群窗口(切集群/首个消费者上线时调用)。
  // 窗口已属于当前集群时跳过:隐私模式/配额下导航不清窗(降级持久化模式)。
  function reloadMetricsWindow() {
    if (metricsWindowCluster.value === currentCluster.value) return
    metricsEpoch++   // 翻代:挂起中的旧 tick 恢复后按代数不等自弃
    const key = metricsStorageKey()
    let cpu = [], mem = []
    if (key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null')
        const now = Date.now()
        cpu = restoreSamples(raw?.cpu, { now })
        mem = restoreSamples(raw?.mem, { now })
      } catch { cpu = []; mem = [] }
    }
    cpuSamples.value = cpu
    memSamples.value = mem
    metricsLastRefresh.value = null
    metricsWindowCluster.value = currentCluster.value
  }
  async function metricsTick() {
    if (document.hidden) return
    if (metricsSampling.value) return   // 重入守卫:慢 fetch 上一轮未完,本轮直接跳过(与 sampleNow 亦去重)
    if (metricsHold) return             // 切集群水合中:不采样,防旧 nodeList 算出假样本
    const epoch = metricsEpoch
    metricsSampling.value = true
    try {
      await refreshMetrics()
      if (epoch !== metricsEpoch) return   // await 间切了集群:丢弃本次 push/persist
      const now = Date.now()
      const cpu = cluster.value.cpuUsage
      const mem = cluster.value.memoryUsage
      if (cpu != null) cpuSamples.value = pushSample(cpuSamples.value, { t: now, v: cpu })
      if (mem != null) memSamples.value = pushSample(memSamples.value, { t: now, v: mem })
      if (cpu != null || mem != null) {
        metricsLastRefresh.value = now
        persistMetricsWindow()
      }
    } finally { metricsSampling.value = false }
  }
  function startMetricsSampling() {
    metricsConsumers++
    if (metricsConsumers === 1) {
      reloadMetricsWindow()
      metricsVisListener = () => { if (!document.hidden && metricsTimer) metricsTick() }
      document.addEventListener('visibilitychange', metricsVisListener)
      metricsTick()   // 立即一轮(不 await)
      metricsTimer = setInterval(metricsTick, 10000)
    }
  }
  function stopMetricsSampling() {
    metricsConsumers = Math.max(0, metricsConsumers - 1)
    if (metricsConsumers === 0) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null }
      if (metricsVisListener) { document.removeEventListener('visibilitychange', metricsVisListener); metricsVisListener = null }
    }
  }
  function sampleNow() { return metricsTick() }
  // === 概览指标计算(与采样器同域:唯一消费方是 refreshMetrics) ===
  function computeClusterMetrics(metricsAvailable) {
    let cpuUsage = null, memoryUsage = null
    if (metricsAvailable) {
      let usedCpu = 0, allocCpu = 0, usedMem = 0, allocMem = 0
      for (const n of nodeList.value) {
        if (n.usedCpu != null) usedCpu += n.usedCpu
        if (n.allocCpu > 0) allocCpu += n.allocCpu
        if (n.usedMem != null) usedMem += n.usedMem
        if (n.allocMem > 0) allocMem += n.allocMem
      }
      cpuUsage = allocCpu > 0 ? Math.min(100, Math.round((usedCpu / allocCpu) * 100)) : null
      memoryUsage = allocMem > 0 ? Math.min(100, Math.round((usedMem / allocMem) * 100)) : null
    }
    const trendOf = (cur, prev) => {
      if (cur == null || prev == null) return { trend: '—', up: false }
      const d = cur - prev
      return { trend: (d >= 0 ? '+' : '') + d.toFixed(1) + '%', up: d > 0 }
    }
    const cpuT = trendOf(cpuUsage, prevClusterMetrics.cpu)
    const memT = trendOf(memoryUsage, prevClusterMetrics.mem)
    prevClusterMetrics = { cpu: cpuUsage, mem: memoryUsage }
    const _cid = currentCluster.value || 'cluster'
    const counts = deriveClusterCounts({
      nodes: queryClient.getQueryData(['cluster', _cid, 'nodes']),
      pods: queryClient.getQueryData(['cluster', _cid, 'pods']),
      events: queryClient.getQueryData(['cluster', _cid, 'events']),
    })
    cluster.value = {
      ...cluster.value,
      nodeCount: counts.nodeCount ?? nodeList.value.length,
      podCount: counts.podCount ?? 0,
      activeEvents: counts.activeEvents ?? 0,
      metricsAvailable,
      cpuUsage, memoryUsage,
      cpuTrend: cpuT.trend, cpuTrendUp: cpuT.up,
      memoryTrend: memT.trend, memoryTrendUp: memT.up,
    }
  }
  function setMetricsHold(v) { metricsHold = v }
  return { refreshMetrics, computeClusterMetrics, cpuSamples, memSamples, metricsSampling, metricsLastRefresh, startMetricsSampling, stopMetricsSampling, sampleNow, setMetricsHold, reloadMetricsWindow }
}
