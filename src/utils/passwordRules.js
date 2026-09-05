// 密码规则前端镜像(2026-09-04 Wave1 §3.7)。与 server/password-policy.mjs 的 firstFailedRule 逐字同构
// (有意复制:前端不 import 服务端模块);两边由各自测试钉住同构用例,改一处必改另一处。
export const DEFAULT_PASSWORD_POLICY = { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false }

export function firstFailedRule(pw, policy = DEFAULT_PASSWORD_POLICY) {
  if (typeof pw !== 'string' || pw.length < (policy.minLength ?? 8)) return 'minLength'
  if (policy.requireMixed && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) return 'mixed'
  if (policy.requireDigit && !/\d/.test(pw)) return 'digit'
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) return 'symbol'
  return null
}

export function failedRuleMessageKey(rule) {
  return rule === 'minLength' ? 'userCenter.pwdNeedMin'
    : rule === 'mixed' ? 'userCenter.pwdNeedMixed'
    : rule === 'digit' ? 'userCenter.pwdNeedDigit' : 'userCenter.pwdNeedSymbol'
}
