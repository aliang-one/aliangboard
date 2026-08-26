// 悬浮对话入口的纯逻辑(无 Vue 依赖,可单测)。
// 近期动态模型(2026-08-17):列表成员/窗口过滤/Top-N 在服务端(active 端点按 presence.* 配置);
// 前端只做「正在看的项目」排除(paused 例外,见 visibleConversations),readAt 仅驱动「新动态」徽标。
const READ_AT_KEY = 'aliangboard.chat.readAt'

// 新动态:updatedAt 晚于上次看过(无记录=没看过=有);任意状态(running 的新动静也算)
export function hasUpdate(conv, readAt) {
  const seen = readAt?.[conv.id]
  return seen == null || conv.updatedAt > seen
}

// 可见列表 = 服务端原料 −「正在看的项目」的对话(终态窗口过滤已在服务端)。
// 例外(2026-08-26):paused(审批等人)不排除——审批是等人决策的紧急态,用户正在该项目
// 工作台页时若也藏掉,审批就只剩悬浮 Modal 一处可见(用户报告「审批只在 modal 里出现,
// 工作台里没弹出来」)。running/终态仍排除:正在看着的项目无需重复提示。
export function visibleConversations(convs, { currentProjectId }) {
  return convs.filter(c => c.status === 'paused' || !(currentProjectId && c.projectId === currentProjectId))
}

// 按钮聚合状态:paused(等人决策) > 有新动态 > running(转圈) > idle(全读终态,常驻安静)。
// badgeCount = 未读数(有新动态的条数)——条目常驻后总数恒定,数字必须是「待看的」才会随阅读递减。
export function presenceState(visible, readAt) {
  if (!visible.length) return { show: false, level: 'none', icon: '', badgeCount: 0 }
  const level = visible.some(c => c.status === 'paused') ? 'paused'
    : visible.some(c => hasUpdate(c, readAt)) ? 'update'
    : visible.some(c => c.status === 'running') ? 'running'
    : 'idle'
  const icon = level === 'paused' ? 'pending_actions' : level === 'running' ? 'progress_activity' : 'smart_toy'
  return { show: true, level, icon, badgeCount: visible.filter(c => hasUpdate(c, readAt)).length }
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
