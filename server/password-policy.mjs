// 密码策略单源(2026-08-29 用户中心设计 G5;2026-09-04 Wave1 可配置化):自改/建户/重置三路同一规则。
// 策略对象注入:isPasswordOk 保持布尔契约(既有调用方零改动);精细规则用 firstFailedRule。
// 默认档(DEFAULT_PASSWORD_POLICY)与 2026-08-29~2026-09-04 的历史行为逐字一致(仅长度≥8)。
export const PASSWORD_MIN_LENGTH = 8
export const DEFAULT_PASSWORD_POLICY = { minLength: PASSWORD_MIN_LENGTH, requireMixed: false, requireDigit: false, requireSymbol: false }

// 坏值逐字段回退默认;minLength 钳 [8,128](防 admin 把自己锁死在 0 或锁死所有人)。
export function normalizePolicy(raw) {
  const p = { ...DEFAULT_PASSWORD_POLICY }
  if (raw && typeof raw === 'object') {
    const n = Number(raw.minLength)
    if (Number.isFinite(n) && n > 0) p.minLength = Math.min(Math.max(Math.floor(n), PASSWORD_MIN_LENGTH), 128)
    for (const k of ['requireMixed', 'requireDigit', 'requireSymbol']) if (raw[k] != null) p[k] = !!raw[k]
  }
  return p
}

// getSetting('auth.passwordPolicy') → JSON → policy;缺值/坏 JSON/读库异常一律回默认(fail-open 到历史行为)。
export function resolvePasswordPolicy(getSetting) {
  try {
    const raw = typeof getSetting === 'function' ? getSetting('auth.passwordPolicy') : null
    return normalizePolicy(raw ? JSON.parse(raw) : null)
  } catch { return { ...DEFAULT_PASSWORD_POLICY } }
}

// 返回第一个未满足的规则名;null = 通过。mixed = 必须同时含大小写字母。
export function firstFailedRule(pw, policy = DEFAULT_PASSWORD_POLICY) {
  if (typeof pw !== 'string' || pw.length < (policy.minLength ?? PASSWORD_MIN_LENGTH)) return 'minLength'
  if (policy.requireMixed && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) return 'mixed'
  if (policy.requireDigit && !/\d/.test(pw)) return 'digit'
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) return 'symbol'
  return null
}

export function isPasswordOk(pw, policy = DEFAULT_PASSWORD_POLICY) {
  return firstFailedRule(pw, policy) == null
}
