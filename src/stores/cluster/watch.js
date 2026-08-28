// cluster store · Watch 域(Plan 5 第二波,2026-08-28):workload 族多路复用 watch(网关 /api/k8s-watch
// 单 NDJSON 流聚合 7 路,根治浏览器同源 6 连接上限)+ 旧单资源 watch 入口 + 状态机暴露。
// 自 cluster.js 逐字搬迁;依赖显式注入;store 公开名不变。
import { reactive } from 'vue'
import { k8sStream, k8sChannel, api } from '@/api/client'
import { queryClient } from '@/queryClient'
import { applyWatchEvent } from '@/composables/useK8sQuery'
import { createWatchController } from '@/composables/useClusterWatch'
import { recordListRv, getListRv, clearWatchRegistry } from '@/composables/watchRegistry'
import { mapWorkload, mapService, mapIngress, mapPod, mapEvent } from '@/composables/useResourceMappers'

export function createWatchDomain({ currentCluster, podWatchLive, eventWatchLive }) {
  // === Workload 族 Watch：多路复用单通道(网关 /api/k8s-watch)增量写 Vue Query canonical key ===
  // spec §5.3:deployments/statefulsets/daemonsets 三流 merge 进同一 'workloads' key;
  // 断线由 createWatchController 退避重连/410 relist/降级轮询接管。
  // 下面的 controllerFor 直连流仅供旧手动开关(startPodWatch 等)使用,family 主路走 familyChannel。
  const WATCH_CONFIGS = [
    { key: 'pods', queryKey: 'pods', watchPath: '/api/v1/pods', mapFn: mapPod },
    { key: 'events', queryKey: 'events', watchPath: '/api/v1/events', mapFn: mapEvent },
    { key: 'deployments', queryKey: 'workloads', watchPath: '/apis/apps/v1/deployments', mapFn: i => mapWorkload(i, 'Deployment') },
    { key: 'statefulsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/statefulsets', mapFn: i => mapWorkload(i, 'StatefulSet') },
    { key: 'daemonsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/daemonsets', mapFn: i => mapWorkload(i, 'DaemonSet') },
    { key: 'services', queryKey: 'services', watchPath: '/api/v1/services', mapFn: mapService },
    { key: 'ingresses', queryKey: 'ingresses', watchPath: '/apis/networking.k8s.io/v1/ingresses', mapFn: mapIngress },
  ]
  const watchStates = reactive(Object.fromEntries(WATCH_CONFIGS.map(c => [c.key, 'off'])))
  const watchControllers = new Map()

  function relistQueryKey(queryKey) {
    return queryClient.refetchQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === queryKey })
  }

  function controllerFor(cfg) {
    if (watchControllers.has(cfg.key)) return watchControllers.get(cfg.key)
    const ctl = createWatchController({
      connect: ({ onOpen, onError, onClose }) => {
        const rv = getListRv(cfg.watchPath)
        return k8sStream(`${cfg.watchPath}?watch=true${rv ? `&resourceVersion=${encodeURIComponent(rv)}` : ''}`, {
          onOpen,
          onClose,
          onError,
          onMessage: line => {
            try {
              const evt = JSON.parse(line)
              if (evt.object?.metadata?.resourceVersion) recordListRv(cfg.watchPath, evt.object.metadata.resourceVersion)
              const _cid = currentCluster.value || 'cluster'
              queryClient.setQueryData(['cluster', _cid, cfg.queryKey], old => applyWatchEvent(old || [], evt.type, cfg.mapFn(evt.object)))
            } catch { /* 忽略非 JSON 心跳行 */ }
          },
        })
      },
      relist: () => relistQueryKey(cfg.queryKey),
      onState: s => {
        watchStates[cfg.key] = s
        if (cfg.key === 'pods') podWatchLive.value = s === 'live'
        if (cfg.key === 'events') eventWatchLive.value = s === 'live'
      },
    })
    watchControllers.set(cfg.key, ctl)
    return ctl
  }

  // === 多路复用单通道:7 watch 归 1 连接(根治浏览器 HTTP/1.1 同源 6 连接上限饿死) ===
  // 网关 /api/k8s-watch 聚合 7 路上游为单条 NDJSON;每行 {r,t,o} 或 {r,err}。
  // 任一路 {r,err}(含 RV 失效 410)时网关整条关闭 → 这里 relist 该资源拿新 RV 再重连。
  let familyChannelHandle = null
  let familyChannelEnded = false   // err 行已触发 abort 后防重复处理
  let familyChannelNotify = null   // connect 注入的 { onError, onClose },err 行 abort 后显式通知控制器

  function handleChannelLine(line) {
    if (familyChannelEnded) return
    let evt
    try { evt = JSON.parse(line) } catch { return /* 心跳/非 JSON 行 */ }
    if (!evt || !evt.r) return
    const cfg = WATCH_CONFIGS.find(c => c.key === evt.r)
    if (evt.err) {
      // 上游失败(含 410 RV 失效):relist 该资源拿新 RV,再关掉通道交给控制器重连。
      // 注意:k8sChannel 的 abort 是静默的(不会回调 onClose),控制器必须被显式通知,
      // 否则 err 行后永不重连。410 走 onError({status:410}) 的不计失败 relist 路径
      // (RV 过期是正常生命周期,计失败会在 churn 下误降级);其余 err 走 onClose 计失败退避。
      if (!cfg) return
      familyChannelEnded = true
      relistQueryKey(cfg.queryKey)          // fire-and-forget:refetch 刷新注册表 RV,重连即可续接
      familyChannelHandle?.abort()
      if (evt.err === 410) familyChannelNotify?.onError?.({ status: 410 })
      else familyChannelNotify?.onClose?.()
      return
    }
    if (!cfg || !evt.t) return
    recordListRv(cfg.watchPath, evt.o?.metadata?.resourceVersion)
    const _cid = currentCluster.value || 'cluster'
    queryClient.setQueryData(['cluster', _cid, cfg.queryKey], old => applyWatchEvent(old || [], evt.t, cfg.mapFn(evt.o)))
  }

  const familyChannel = createWatchController({
    connect: ({ onOpen, onError, onClose }) => {
      familyChannelEnded = false
      familyChannelNotify = { onError, onClose }
      const rvParams = WATCH_CONFIGS
        .map(c => { const rv = getListRv(c.watchPath); return rv ? `&rv_${c.key}=${encodeURIComponent(rv)}` : '' })
        .join('')
      familyChannelHandle = k8sChannel(`/api/k8s-watch?resources=${WATCH_CONFIGS.map(c => c.key).join(',')}${rvParams}`, {
        onOpen,
        onError,
        onClose,
        onMessage: handleChannelLine,
      })
      return familyChannelHandle
    },
    // HTTP 410(整条通道层)→ 全家族 relist
    relist: () => Promise.all([...new Set(WATCH_CONFIGS.map(c => c.queryKey))].map(relistQueryKey)),
    // mux 下 7 资源同生共死:状态联动写全 7 key + pods/events live refs
    onState: s => {
      for (const cfg of WATCH_CONFIGS) {
        watchStates[cfg.key] = s
        if (cfg.key === 'pods') podWatchLive.value = s === 'live'
        if (cfg.key === 'events') eventWatchLive.value = s === 'live'
      }
    },
  })

  // 多路 watch 总开关(默认开):watchFamily 现走多路复用单连接(网关 /api/k8s-watch),
  // 浏览器只占 1 条常驻连接,无 6 连接上限风险。'0' 为 kill-switch:强制回落轮询世界(60s 兜底)。
  function watchFamilyEnabled() {
    try { return localStorage.getItem('aliangboard.watchFamily') !== '0' } catch { return true }
  }
  function startWorkloadFamilyWatch() {
    if (!watchFamilyEnabled()) return
    familyChannel.start()
  }
  function stopWorkloadFamilyWatch() {
    familyChannel.stop()
    familyChannelHandle = null
    for (const ctl of watchControllers.values()) ctl.stop()
    clearWatchRegistry()
  }
  // canonical queryKey 聚合态:全 live 才 live;任一 degraded 即 degraded
  function watchStateOf(queryKey) {
    const ss = WATCH_CONFIGS.filter(c => c.queryKey === queryKey).map(c => watchStates[c.key])
    if (!ss.length || ss.every(s => s === 'off')) return 'off'
    if (ss.some(s => s === 'degraded')) return 'degraded'
    if (ss.some(s => s === 'reconnecting')) return 'reconnecting'
    if (ss.every(s => s === 'live')) return 'live'
    return 'off'
  }
  // 旧入口兼容(NsPods toggleLive / NsEvents / AuditLogs / MonitoringCenter 既存调用点)
  // 注意:family 通道已携带这些资源的事件,这些手动开关只控制「额外」的单资源直连流。
  function startPodWatch() { controllerFor(WATCH_CONFIGS[0]).start() }
  function stopPodWatch() { controllerFor(WATCH_CONFIGS[0]).stop() }
  function startEventWatch() { controllerFor(WATCH_CONFIGS[1]).start() }
  function stopEventWatch() { controllerFor(WATCH_CONFIGS[1]).stop() }
  return { watchStates, startWorkloadFamilyWatch, stopWorkloadFamilyWatch, watchStateOf, startPodWatch, stopPodWatch, startEventWatch, stopEventWatch }
}
