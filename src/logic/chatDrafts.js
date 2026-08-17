// 每对话未发送草稿(场景:长问题打了一半,切去别的对话查东西/刷新页面,回来草稿还在)。
// key: conversationId 或 'new'(新对话);发送(resetInput 清空 input)经 watch 自动删除。
// H(2026-08-17 审计):曾为纯内存 Map——刷新整页即丢(旧注释谎称"刷新不丢")。现以
// localStorage 持久(aliangboard.chat.drafts),模块级 Map 作会话内缓存;
// storage 事件让多标签页互见(收到即整体重载,本端写入总是先落盘,无丢失窗口)。
const DRAFTS_KEY = 'aliangboard.chat.drafts'
const drafts = new Map()

function loadAll() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}')
    for (const [k, v] of Object.entries(stored)) if (!drafts.has(k)) drafts.set(k, v)
  } catch { /* 损坏则弃,以内存为准 */ }
}
function persist() {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts))) } catch { /* 隐私模式等 */ }
}

export const getDraft = k => { if (!drafts.has(k)) loadAll(); return drafts.get(k) || '' }
export const setDraft = (k, v) => { if (v) drafts.set(k, v); else drafts.delete(k); persist() }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => { if (e.key === DRAFTS_KEY) { drafts.clear(); loadAll() } })
}
