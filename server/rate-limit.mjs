// 限流(T15):per-key token bucket,内存。
// 底座是给 AI 用的——AI 会循环/扇出,没限流则一把失控循环能打爆 apiserver / TokenRequest 风暴。
// codex #17:内存计数重启清空(=已知 fail-open 窗口),靠审计 + 单连接 TTL 兜底;不做 fail-open 之外的妥协。
export function createRateLimiter({ capacity = 60, refillPerSec = 1 } = {}) {
  const buckets = new Map() // key -> { tokens, last(ms) }
  function check(key) {
    const now = Date.now()
    let b = buckets.get(key)
    if (!b) { b = { tokens: capacity, last: now }; buckets.set(key, b) }
    // 按时间补充 token(上限 capacity)
    const elapsed = (now - b.last) / 1000
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec)
    b.last = now
    if (b.tokens >= 1) { b.tokens -= 1; return { allowed: true, remaining: Math.floor(b.tokens) } }
    return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) }
  }
  return { check, reset: () => buckets.clear(), _size: () => buckets.size }
}

// gateway 单例(从 env 配置)。MVP 单进程:重启清空(已知妥协)。
const _gateway = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_CAPACITY || 60),
  refillPerSec: Number(process.env.RATE_LIMIT_REFILL_PER_SEC || 1),
})
export function checkRate(key) { return _gateway.check(key) }

// 登录限流(2026-08-28 CSO 审计 #3):与 API-key 限流分离的更紧桶——预算 5 次、10s 回 1 token。
// 键 = `${ip}|${username}`(routes/auth.mjs 组装;IP 取 socket 直连地址,不信任 XFF)。
// env 可调:LOGIN_RATE_CAPACITY / LOGIN_RATE_REFILL_PER_SEC。重启清空(与网关单例同妥协)。
const _login = createRateLimiter({
  capacity: Number(process.env.LOGIN_RATE_CAPACITY || 5),
  refillPerSec: Number(process.env.LOGIN_RATE_REFILL_PER_SEC || 0.1),
})
export function checkLoginRate(key) { return _login.check(key) }
