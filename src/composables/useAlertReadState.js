import { ref, watch } from 'vue'

// 告警铃铛已读状态(2026-09-04 顶栏改版配套)。
// 按「集群名」分账本持久在 localStorage(键 ab.alertsRead.<cluster>);uid 上限裁剪
// 防长期膨胀(保留最新)。事件 uid 缺失时退化为 ns/reason/relatedName 复合键,
// 保证无 uid 事件也能被标记已读(不出现永久红点)。
const STORAGE_PREFIX = 'ab.alertsRead.'
export const MAX_READ_UIDS = 500

export function eventKey(e) {
  return e?.uid || `${e?.namespace || ''}/${e?.reason || ''}/${e?.relatedName || ''}`
}

export function loadReadUids(clusterKey) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + clusterKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(u => typeof u === 'string') : []
  } catch {
    return [] // 损坏 JSON:防御式读,当作全未读
  }
}

export function saveReadUids(clusterKey, uids) {
  // 去重 + 保留最新尾部(旧读态先裁,新标记不被裁)
  const merged = [...new Set(uids)].slice(-MAX_READ_UIDS)
  try {
    localStorage.setItem(STORAGE_PREFIX + clusterKey, JSON.stringify(merged))
  } catch {
    /* 存储满/隐私模式:已读态降级为会话内,不致命 */
  }
}

// warning 事件中不在已读集合的部分(调用方传入的 events 已是 mapper 产物)
export function unreadWarnings(events, readUids) {
  if (!Array.isArray(events)) return []
  const read = new Set(readUids)
  return events.filter(e => e.type === 'warning' && !read.has(eventKey(e)))
}

export function useAlertReadState(clusterKeyRef) {
  const readUids = ref(loadReadUids(clusterKeyRef.value))
  watch(clusterKeyRef, k => { readUids.value = loadReadUids(k) })
  function markAllRead(events) {
    const merged = [...readUids.value, ...events.map(eventKey)]
    saveReadUids(clusterKeyRef.value, merged)
    readUids.value = loadReadUids(clusterKeyRef.value)
  }
  return { readUids, markAllRead }
}
