// 部署感知 fastMode 状态机:workload 变更进行中 → 立即进入高频;全部收敛 → 保持 holdMs 后回落。
// 消费方:NamespaceOverview 自适应轮询(唯一);source 为懒求值 getter,返回 K8s raw 数组。
// 边界:数据 undefined/空 → 视为收敛;作用域销毁清回落 timer(onScopeDispose)。
import { ref, computed, watch, toValue, onScopeDispose } from 'vue'
import { anyWorkloadTransitioning } from '@/logic/workloadTransition'

export const FAST_MS = 3000
export const SLOW_MS = 30000

export function useDeployFastPoll(source, { holdMs = 10000 } = {}) {
  const fastMode = ref(false)
  const pollInterval = computed(() => (fastMode.value ? FAST_MS : SLOW_MS))
  let fallTimer = null
  const stop = () => { if (fallTimer) { clearTimeout(fallTimer); fallTimer = null } }
  watch(
    () => anyWorkloadTransitioning(toValue(source)),
    busy => {
      if (busy) { stop(); fastMode.value = true }
      else if (fastMode.value && !fallTimer) fallTimer = setTimeout(() => { fallTimer = null; fastMode.value = false }, holdMs)
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(stop)
  return { fastMode, pollInterval }
}
