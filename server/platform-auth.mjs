// 平台鉴权辅助(T8):把 token 提取逻辑从 index.mjs 入口模块抽出来便于单测。
// index.mjs 是入口(导入即起服务 → 无法直接 node --test)。
//
// EventSource 不能加自定义 header → SSE 端点走 ?token= query 回退。
export function extractPlatformToken(req) {
  const headerToken = req.headers['x-platform-token']
  if (headerToken) return headerToken
  try {
    const u = new URL(req.url, 'http://x')
    return u.searchParams.get('token') || ''
  } catch { return '' }
}
