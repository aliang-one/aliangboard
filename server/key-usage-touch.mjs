// API key lastUsedAt 节流回写:内存节流(默认 60s)经统一轴向 throttle 原语,SQLite 同步写降频。
import { createThrottle } from './state/kernel.mjs'

const lastTouch = createThrottle({ name: 'keyUsageTouch', domain: 'authkey', windowMs: 60_000 })

export function touchKeyUsage(db, keyRow, { now = Date.now(), ip = null, minIntervalMs = 60_000 } = {}) {
  if (!db || !keyRow?.id) return false
  if (!lastTouch.touch(keyRow.id, now)) return false
  try {
    db.prepare('UPDATE api_keys SET lastUsedAt=?, lastUsedIp=? WHERE id=?').run(now, ip ?? null, keyRow.id)
    return true
  } catch { return false }
}

export function _resetKeyUsageForTest() { lastTouch.clear() }
