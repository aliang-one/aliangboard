// 登录后回跳目标校验(2026-09-04 事故⑥):401 把弹窗/页面踢去 /login 时携带
// ?redirect=<原路径+query>,登录成功原路返回(SSH 弹窗同 sid 重建 WS)。
// 开放重定向闸:仅接受同源绝对路径——协议相对(//host)、反斜杠绕过(/\host)、
// 外链、非字符串一律落 fallback。
export function safeRedirectPath(raw, fallback = '/cluster') {
  if (typeof raw !== 'string' || !raw) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}
