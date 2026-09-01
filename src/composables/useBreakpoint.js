// 断点组合式(2026-08-31 响应式适配设计 §2):matchMedia 响应式封装,零依赖。
// 仅在纯 CSS 表达不了处使用(搜索弹层开关/rail 类);纯样式退化一律 Tailwind 断点类。
// MQ_BELOW_LG 必须与 Tailwind 默认 lg=1024 对齐(1023.98 避免整数像素边界抖动)。
import { ref, onScopeDispose } from 'vue'

export const MQ_BELOW_LG = '(max-width: 1023.98px)'

// 手机档(<640,tailwind sm 断点):结构性切换(抽屉/卡片/全屏 Modal)的 JS 单源。
export const MQ_BELOW_SM = '(max-width: 639.98px)'

export function useBreakpoint(query) {
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null
  const matches = ref(mq ? !!mq.matches : false)
  function onChange(e) { matches.value = !!e.matches }
  if (mq) {
    mq.addEventListener?.('change', onChange)
    onScopeDispose(() => mq.removeEventListener?.('change', onChange))
  }
  return { matches }
}

export function useIsPhone() {
  const { matches } = useBreakpoint(MQ_BELOW_SM)
  return { isPhone: matches }
}
