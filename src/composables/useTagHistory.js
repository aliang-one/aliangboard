// 标签组历史：从 namespace 内已有 deployment 收集标签，按频率+时效排序供快速选择。
// localStorage 持久化（aliangboard.tagHistory.{ns}），记录每个标签的使用次数 + 最后使用时间。

const KEY_PREFIX = 'aliangboard.tagHistory.'

function storageKey(ns) { return `${KEY_PREFIX}${ns}` }

// 从 localStorage 读取该 ns 的标签历史
function loadHistory(ns) {
  try { return JSON.parse(localStorage.getItem(storageKey(ns)) || '{}') }
  catch { return {} }
}

// 写入 localStorage
function saveHistory(ns, history) {
  try { localStorage.setItem(storageKey(ns), JSON.stringify(history)) } catch { /* 隐私模式 */ }
}

// 从 deployment 列表收集标签，更新历史
// deployments: [{ labels: { 'aliangboard.io/tags': 'auth,gateway' }, ... }]
export function syncTagHistory(ns, deployments) {
  if (!ns || !deployments?.length) return
  const history = loadHistory(ns)
  const now = Date.now()
  for (const dep of deployments) {
    const raw = dep?.labels?.['aliangboard.io/tags'] || dep?.annotations?.['aliangboard.io/tags']
    if (!raw) continue
    for (const tag of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
      if (!history[tag]) history[tag] = { count: 0, lastUsed: 0 }
      // 只更新 lastUsed（count 由实际 deployment 数量决定，不在这里加）
      if (history[tag].lastUsed < now) history[tag].lastUsed = now
    }
  }
  // count 重新统计（以实际 deployment 中的出现次数为准）
  const counts = {}
  for (const dep of deployments) {
    const raw = dep?.labels?.['aliangboard.io/tags'] || dep?.annotations?.['aliangboard.io/tags']
    if (!raw) continue
    for (const tag of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
      counts[tag] = (counts[tag] || 0) + 1
    }
  }
  for (const tag of Object.keys(history)) {
    history[tag].count = counts[tag] || 0
  }
  saveHistory(ns, history)
}

// 记录用户手动使用了某个标签（创建/编辑时）
export function recordTagUsage(ns, tagsString) {
  if (!ns || !tagsString) return
  const history = loadHistory(ns)
  const now = Date.now()
  for (const tag of String(tagsString).split(',').map(s => s.trim()).filter(Boolean)) {
    if (!history[tag]) history[tag] = { count: 0, lastUsed: 0 }
    history[tag].lastUsed = now
  }
  saveHistory(ns, history)
}

// 获取排序后的标签建议（频率高→前，最近用→前，与输入匹配→前）
export function getTagSuggestions(ns, input = '') {
  const history = loadHistory(ns)
  const inputLower = input.trim().toLowerCase()
  let entries = Object.entries(history)
  if (inputLower) {
    entries = entries.filter(([tag]) => tag.toLowerCase().includes(inputLower))
  }
  // 排序：count 降序 → lastUsed 降序
  entries.sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count
    return b[1].lastUsed - a[1].lastUsed
  })
  return entries.map(([tag, info]) => ({ tag, count: info.count, lastUsed: info.lastUsed }))
}
