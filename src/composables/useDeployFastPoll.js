// 部署感知 fastMode 状态机:workload 变更进行中 → 立即进入高频;全部收敛 → 保持 holdMs 后回落。
// 高频封顶(spec 2026-08-17):fast 真上升沿启动 maxFastMs 封顶计时,期间 busy 抖动不重置;
// 到点强制回落并进入抑制态——rising 被忽略、取消进行中的解除计时;busy 连续平静满 holdMs
// 才解除抑制重新武装。稳态半就绪负载(crashloop 1/2)不会让页面永久 3s 轮询。
// 消费方:NamespaceOverview 自适应轮询(唯一);source 为懒求值 getter(flush:'sync' 前提:纯读)。
import { ref, computed, watch, toValue, onScopeDispose } from 'vue'
import { anyWorkloadTransitioning } from '@/logic/workloadTransition'

export const FAST_MS = 3000
export const SLOW_MS = 30000
export const MAX_FAST_MS = 300000

export function useDeployFastPoll(source, { holdMs = 10000, maxFastMs = MAX_FAST_MS } = {}) {
  const fastMode = ref(false)
  const pollInterval = computed(() => (fastMode.value ? FAST_MS : SLOW_MS))
  let fallTimer = null    // holdMs 平静计时:fast 态=收敛保持回落;抑制态=解除抑制
  let maxTimer = null     // 高频封顶计时(跨抖动不重置)
  let suppressed = false  // 封顶后抑制:需连续 holdMs 平静才重新武装
  const clearFall = () => { if (fallTimer) { clearTimeout(fallTimer); fallTimer = null } }
  const clearMax = () => { if (maxTimer) { clearTimeout(maxTimer); maxTimer = null } }
  const armFall = () => {
    if (fallTimer) return
    fallTimer = setTimeout(() => {
      fallTimer = null
      fastMode.value = false
      clearMax()          // 自然回落:短会话不占用下一会话封顶额度
      suppressed = false  // 连续平静达标:解除抑制
    }, holdMs)
  }
  const tripCap = () => { maxTimer = null; clearFall(); fastMode.value = false; suppressed = true }
  watch(
    () => anyWorkloadTransitioning(toValue(source)),
    busy => {
      if (busy) {
        if (suppressed) { clearFall(); return }   // 抑制期:忽略 rising,并取消解除计时
        clearFall()
        if (!fastMode.value) {                    // 真上升沿:进 fast + 启封顶
          fastMode.value = true
          maxTimer = setTimeout(tripCap, maxFastMs)
        }
        // fast 态 re-trigger(10s 保持期内又 busy):不重置 maxTimer——抖动不续命
      } else {
        armFall()                                  // fast=收敛保持;抑制=解除计时;slow 平静=幂等
      }
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => { clearFall(); clearMax() })
  return { fastMode, pollInterval }
}
