// API key lastUsedAt 节流回写(2026-09-04 Wave1 §3.3;语义对齐 session-touch.mjs):
// 每 key 内存 Map 节流(默认 60s),SQLite 同步写降频。模块级 Map 与单进程不变式一致(重启清零=最多多写一次)。
const lastTouch = new Map() // keyId → ts

export function touchKeyUsage(db, keyRow, { now = Date.now(), ip = null, minIntervalMs = 60_000 } = {}) {
  if (!db || !keyRow?.id) return false
  const prev = lastTouch.get(keyRow.id)
  if (prev && now - prev < minIntervalMs) return false
  lastTouch.set(keyRow.id, now)
  try {
    db.prepare('UPDATE api_keys SET lastUsedAt=?, lastUsedIp=? WHERE id=?').run(now, ip ?? null, keyRow.id)
    return true
  } catch { return false }
}

export function _resetKeyUsageForTest() { lastTouch.clear() }
