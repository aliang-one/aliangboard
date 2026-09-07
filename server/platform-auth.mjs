// 平台鉴权辅助(T8):把 token 提取逻辑从 index.mjs 入口模块抽出来便于单测。
// index.mjs 是入口(导入即起服务 → 无法直接 node --test)。
//
// 提取优先级:x-platform-token(浏览器)> Authorization: Bearer(W3 Task 6:kubectl 只能发
// 标准 Bearer,kubeconfig user.token 的唯一载体;浏览器 K8s 会话请求同带 Bearer 但都走
// session class 路由,平台 class 路由此前无 Bearer 消费方 —— K8s token 不在
// platform_sessions,查不到照旧 401,语义零变)> ?token= query(EventSource 不能加自定义 header)。
export function extractPlatformToken(req) {
  const headerToken = req.headers['x-platform-token']
  if (headerToken) return headerToken
  const auth = req.headers.authorization
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '')
  try {
    const u = new URL(req.url, 'http://x')
    return u.searchParams.get('token') || ''
  } catch { return '' }
}
