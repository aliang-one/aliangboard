// 对话错误显示净化:上游网关(nginx 等)故障时返回整页 HTML,原样塞进 banner/turn
// 会把标签当正文多行倾倒(2026-08-17 LLM 502 实例)。剥标签/解码常见实体/压空白/截断;
// 库内与日志保留原文,仅显示层净化。纯函数无 i18n,空结果交调用方用 t() 兜底。
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

export function sanitizeChatError(raw, { maxLen = 160 } = {}) {
  if (!raw) return ''
  let s = String(raw)
  s = s.replace(/<[^>]*>/g, ' ')      // 先剥真标签(<html>/<head><title>502 Bad Gateway</title>… → 文本)
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch) // 再解码转义内容(&lt;c&gt; → <c> 存活)
  s = s.replace(/\s+/g, ' ').trim()   // 压换行/多空格为单空格
  if (!s) return ''
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}
