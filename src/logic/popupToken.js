// src/logic/popupToken.js
// 弹窗页(新标签页)K8s session token 交接的单一事实源:opener 写交接槽(writePopupTokenHandoff),
// 弹窗页启动时消费(consumePopupToken)。
//
// 背景:弹窗页与 opener 同源但 sessionStorage 不跨标签页,token 需经 URL ?token= 或 localStorage
// 交接槽传入。URL 传参会进浏览器历史(2026-09-04 审计裁决弃用,legacy 仅过渡兼容),故正道是
// opener 在 window.open 前写槽、弹窗页读后即焚;值在同一浏览器会话内恒同(同一集群会话),
// 误读无越权面。
//
// 2026-09-07 事故回归:4d4eede 把消费分支收紧到 /terminal-popup 时,漏了同机制的第二消费者
// /log-popup(openLogTab 仍拼 URL token 却无人消费)→ 日志弹窗恒报「会话已过期」。
// 槽键与消费路径白名单收敛在本模块,新增弹窗页只改 POPUP_PATHS 一处。
export const TOKEN_HANDOFF_KEY = 'aliangboard.termTokenHandoff'
export const SESSION_KEY = 'aliangboard.session'

// 消费分支覆盖的弹窗路径前缀(新弹窗页若也依赖 K8s session token,必须在此登记)
const POPUP_PATHS = ['/terminal-popup', '/log-popup']

// opener 侧:open 前写交接槽。存储不可用时静默降级(弹窗页会渲染会话过期页)。
export function writePopupTokenHandoff(token, storage = window.localStorage) {
  try { storage.setItem(TOKEN_HANDOFF_KEY, token) } catch { /* 存储不可用 */ }
}

// 弹窗页侧(main.js 启动早期调用):legacy URL ?token= 优先(过渡兼容,不烧槽),
// 否则读交接槽写 sessionStorage 并读后即焚。非弹窗路径一律不动(主应用不受槽残留影响)。
export function consumePopupToken({
  pathname = window.location.pathname,
  search = window.location.search,
  sessionStorage: ss = window.sessionStorage,
  localStorage: ls = window.localStorage,
} = {}) {
  if (!POPUP_PATHS.some(p => pathname.startsWith(p))) return
  const legacyToken = new URLSearchParams(search).get('token')
  let handoffToken = null
  try { handoffToken = ls.getItem(TOKEN_HANDOFF_KEY) } catch { /* noop */ }
  const popupToken = legacyToken || handoffToken
  if (popupToken) {
    ss.setItem(SESSION_KEY, popupToken)
    if (!legacyToken) { try { ls.removeItem(TOKEN_HANDOFF_KEY) } catch { /* noop */ } }
  }
}
