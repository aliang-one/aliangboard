// 终端字号热调(mobile Wave 3 起源于 InteractiveTerminal,Wave5 B6 抽出与 SSH 终端共享):
// 8~20px 钳制,默认 13(=创建 term 的 fontSize);term.options.fontSize 热改后立即 fit 重排行;
// 重连重建 term 时复位 13(热调值不跨会话残留,终审 E)。
// term/fit 是组件内晚绑定实例(xterm 构造后才存在),经 getter(() => term)或 ref 传入。
import { ref } from 'vue'

export const FONT_MIN = 8, FONT_MAX = 20
export const clampFont = n => Math.min(FONT_MAX, Math.max(FONT_MIN, n))

// 兼容 getter 与 ref 两种晚绑定形态
const deref = a => (typeof a === 'function' ? a() : a?.value)

export function useTerminalFont({ term, fit }) {
  const termFont = ref(13)

  // 热调:钳制后热写 fontSize 并 fit 重排行;term 未初始化时静默安全(只记账字号)
  function adjustFont(delta) {
    termFont.value = clampFont(termFont.value + delta)
    const t = deref(term), f = deref(fit)
    if (t) { t.options.fontSize = termFont.value; f?.fit() }
  }

  // 重连重建 term 时在 ensureTerm 内调用:热调值不跨会话残留
  function resetFont() { termFont.value = 13 }

  return { termFont, adjustFont, resetFont }
}
