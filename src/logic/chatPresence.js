// 悬浮对话入口的纯逻辑(无 Vue 依赖,可单测)。
// 活跃定义(spec §2):running/paused 显示;终态 done/failed 且 updatedAt > readAt 为「未读终答」,
// 打开读过才消;cancelled 不算(用户主动停,无未读价值)。
const READ_AT_KEY = 'aliangboard.chat.readAt'
const TERMINAL_STATUSES = ['done', 'failed']

export function isUnread(conv, readAt) {
  if (!TERMINAL_STATUSES.includes(conv.status)) return false
  const seen = readAt?.[conv.id]
  return seen == null || conv.updatedAt > seen
}

// 可见列表 = 服务端 active 原料 −「正在看的项目」的对话 − 已读终态
export function visibleConversations(convs, { currentProjectId, readAt }) {
  return convs.filter(c => {
    if (currentProjectId && c.projectId === currentProjectId) return false
    if (TERMINAL_STATUSES.includes(c.status) && !isUnread(c, readAt)) return false
    return true
  })
}

// 按钮聚合状态:徽标优先级 paused(等人决策) > 未读终答 > running(安静转圈)
export function presenceState(visible, readAt) {
  if (!visible.length) return { show: false, level: 'none', icon: '', badgeCount: 0, directOpen: false }
  const level = visible.some(c => c.status === 'paused') ? 'paused'
    : visible.some(c => isUnread(c, readAt)) ? 'unread'
    : 'running'
  const icon = level === 'paused' ? 'pending_actions' : level === 'unread' ? 'smart_toy' : 'progress_activity'
  return { show: true, level, icon, badgeCount: visible.length, directOpen: visible.length === 1 }
}

export function loadReadAt() {
  try { return JSON.parse(localStorage.getItem(READ_AT_KEY) || '{}') } catch { return {} }
}

// 写入已读时间并持久化;不回退(取 max),避免轮询乱序抹掉新时间。
export function markRead(readAt, convIds, now = Date.now()) {
  const next = { ...readAt }
  for (const id of convIds) next[id] = Math.max(next[id] || 0, now)
  try { localStorage.setItem(READ_AT_KEY, JSON.stringify(next)) } catch { /* 隐私模式等 */ }
  return next
}

// Map 防膨胀:只保留服务端仍返回的对话的 readAt(离场对话的历史已读无消费方)。
export function pruneReadAt(readAt, liveIds) {
  const live = new Set(liveIds)
  const next = {}
  for (const [id, ts] of Object.entries(readAt)) if (live.has(id)) next[id] = ts
  return next
}
