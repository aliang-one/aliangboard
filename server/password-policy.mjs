// 密码策略单源(2026-08-29 用户中心设计 G5):自改/建户/重置三路同一规则。
export const PASSWORD_MIN_LENGTH = 8
export function isPasswordOk(pw) {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN_LENGTH
}
