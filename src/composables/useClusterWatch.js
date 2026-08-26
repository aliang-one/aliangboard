// K8s watch 控制器状态机(纯逻辑,依赖注入可测):
//   live --断流(非410)--> reconnecting --退避重连-->
//   任意 --410--> reconnecting + relist 后重开(不计失败)
//   连续 maxFailures 次失败 --> degraded(60s 慢重试,期间页面回落轮询)
//   任一次成功 open --> live 且失败计数清零
// 推翻旧「手动恢复」决策(spec §3 决策2),风暴风险由退避+降级控制。
export const WATCH_BACKOFF_BASE_MS = 1000
export const WATCH_BACKOFF_MAX_MS = 60000
export const WATCH_MAX_FAILURES = 5
export const WATCH_DEGRADED_RETRY_MS = 60000

export function createWatchController({ connect, relist, onState, baseMs = WATCH_BACKOFF_BASE_MS, maxMs = WATCH_BACKOFF_MAX_MS, maxFailures = WATCH_MAX_FAILURES }) {
  let state = 'off'
  let failures = 0
  let timer = null
  let stopped = true
  let handle = null

  const setState = s => { state = s; onState?.(s) }
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const delayFor = n => Math.min(baseMs * 2 ** (n - 1), maxMs)

  function open() {
    clearTimer()
    if (handle) { try { handle.abort() } catch { /* noop */ } }
    handle = connect({
      onOpen: () => { failures = 0; setState('live') },
      onError: err => onFailure(err),
      onClose: () => onFailure(null),
    })
  }

  function onFailure(err) {
    if (stopped) return
    clearTimer()
    if (err?.status === 410) {                       // RV 失效:relist 拿新 RV 再重开,不计失败
      setState('reconnecting')
      Promise.resolve(relist?.()).finally(() => { if (!stopped) open() })
      return
    }
    failures += 1
    if (failures >= maxFailures) {                   // 降级:页面轮询接管,60s 慢重试
      setState('degraded')
      timer = setTimeout(() => { if (!stopped) open() }, WATCH_DEGRADED_RETRY_MS)
      return
    }
    setState('reconnecting')
    timer = setTimeout(() => { if (!stopped) open() }, delayFor(failures))
  }

  return {
    start() { if (!stopped) return; stopped = false; failures = 0; setState('reconnecting'); open() },
    stop() { stopped = true; clearTimer(); if (handle) { try { handle.abort() } catch { /* noop */ } } handle = null },
    get state() { return state },
  }
}
