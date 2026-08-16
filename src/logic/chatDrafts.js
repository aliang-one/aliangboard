// 每对话未发送草稿(模块级 Map——组件因 :key 切换/刷新而重建后仍可恢复)。
// 场景:长问题打了一半,切去别的对话查东西/刷新页面,回来草稿还在(标准聊天交互)。
// key: conversationId 或 'new'(新对话);发送(resetInput 清空 input)经 watch 自动删除。
const drafts = new Map()
export const getDraft = k => drafts.get(k) || ''
export const setDraft = (k, v) => { if (v) drafts.set(k, v); else drafts.delete(k) }
