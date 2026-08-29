// SSH 会话回收策略(2026-08-29 spec:docs/superpowers/specs/2026-08-29-ssh-session-reap-policy-design.md)
// 三阈值全局策略,分钟单位,0=该条件禁用,全 0=永不自动关闭;判定为纯函数(时钟注入可测)。
export const SESSION_POLICY_DEFAULT = { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }
export const SESSION_POLICY_MAX_MIN = 10080   // 0~7 天

export function isValidMinutes(v) {
  return Number.isInteger(v) && v >= 0 && v <= SESSION_POLICY_MAX_MIN
}

// 设置值 > env SSH_IDLE_REAP_MS(ms→分钟向下取整,仅 detached 兜底,兼容旧环境变量)> 内置默认。
// 非法落库值(手改库)warn 后按缺省处理,绝不抛(sweep 里抛=清道夫死)。
export function resolvePolicy(getFn, env = {}) {
  const envMs = Number(env.SSH_IDLE_REAP_MS)
  const envFallback = Number.isFinite(envMs) && envMs > 0 ? Math.floor(envMs / 60000) : undefined
  const read = (key, fallback) => {
    const raw = getFn?.(key)
    if (raw == null) return fallback
    const n = Number(raw)
    if (!isValidMinutes(n)) { console.warn(`[ssh] 非法会话策略值 ${key}=${raw},按缺省处理`); return fallback }
    return n
  }
  return {
    detachedIdleMin: read('ssh.session.detachedIdleMin', envFallback ?? SESSION_POLICY_DEFAULT.detachedIdleMin),
    attachedIdleMin: read('ssh.session.attachedIdleMin', SESSION_POLICY_DEFAULT.attachedIdleMin),
    maxLifetimeMin: read('ssh.session.maxLifetimeMin', SESSION_POLICY_DEFAULT.maxLifetimeMin),
  }
}

// 判定。时钟口径刻意非对称(spec §2.2):
//  - detached-idle 只看 lastActiveAt:无人看管即闲置,输出续命防「无主 tail -f 永生」
//  - attached-idle 看 max(lastActiveAt, lastOutputAt):输出流动=有事发生,不误杀看日志/跑构建
export function shouldReapSession(session, policy, now = Date.now()) {
  if (policy.maxLifetimeMin > 0 && now - session.createdAt > policy.maxLifetimeMin * 60000) return { reap: true, reason: 'max-lifetime' }
  if (policy.detachedIdleMin > 0 && session.browserCount === 0 && now - session.lastActiveAt > policy.detachedIdleMin * 60000) return { reap: true, reason: 'detached-idle' }
  const act = Math.max(session.lastActiveAt ?? 0, session.lastOutputAt ?? 0)
  if (policy.attachedIdleMin > 0 && session.browserCount > 0 && now - act > policy.attachedIdleMin * 60000) return { reap: true, reason: 'attached-idle' }
  return { reap: false, reason: null }
}
