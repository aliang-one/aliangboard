// 会话列表 UA 摘要(2026-08-29 用户中心设计):只拆「浏览器 · 系统」两级,不追求全量指纹库。
export function uaSummary(ua) {
  if (!ua) return '—'
  const s = String(ua)
  const os = /Windows/.test(s) ? 'Windows'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS'
  // 注:测试 mock 的 UA 是无版本号形态(`Mozilla/5.0 Chrome Safari`),故匹配不带 `/` 的裸 token;
  // 顺序承重:Edg/OPR 必须先于 Chrome/ Safari 判定(Edge UA 同时含 Chrome 与 Safari)。
  const browser = /Edg/.test(s) ? 'Edge'
    : /OPR|Opera/.test(s) ? 'Opera'
    : /Chrome/.test(s) ? 'Chrome'
    : /Firefox/.test(s) ? 'Firefox'
    : /Safari/.test(s) ? 'Safari'
    : 'Unknown'
  return `${browser} · ${os}`
}
