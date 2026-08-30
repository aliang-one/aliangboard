// 路由鉴权单一事实源(2026-08-28 架构治理第二项):每条 /api/* + /mcp 路由的鉴权 class。
// 由 index.mjs handle() 顶部的「门」统一预检;handler 内的 requireX/sessionFromRequest 保留为纵深防御
// (workbench 混合层:门只做地板=platform,内层 requireAdmin 再收严)。
//
// class 语义:
//   none     — 公有(健康探针/登录/登出/旧直连建会话)。allowlist 有守卫测试逐项锁定,加条目须改测试。
//   session  — K8s 会话(Authorization: Bearer <sessionId>)。
//   platform — 平台会话(x-platform-token header 或 ?token=)。
//   admin    — 平台会话且 role=admin。
//   apikey   — Authorization: Bearer <apiKey>(/api/key/*,401 shape 特殊:PERMISSION_DENIED/revoked)。
//   mcp      — /mcp 专用;门放行,由 mcp.mjs 内层自检(JSON-RPC 错误 shape 在那里,mcp_enabled=off 的 503 须先于 401)。
//
// 门外规则:index.mjs 对「/api/* 或 /mcp 且未命中任何条目」的请求直接 404——新路由不登记就不可达,
// 登记动作本身强迫作者声明鉴权 class。守卫测试(route-auth-map.test.mjs)静态扫源码路径字面量交叉强制。
//
// 匹配语义:先精确(pattern+可选 method),后前缀(prefix+可选 method)。历史事故:2026-08-28 审计 #
// /api/registry/tags 曾是全文件唯一漏挂 session 的端点(未认证 SSRF),本表即其结构性根治。
export const ROUTE_AUTH = [
  // --- 公有(allowlist 守卫测试锁定) ---
  { method: 'GET',    pattern: '/api/health',    auth: 'none' },  // 存活探针(无鉴权,deployment.yaml 探针依赖)
  { method: 'POST',   pattern: '/api/auth/login', auth: 'none' },
  { method: 'POST',   pattern: '/api/auth/logout', auth: 'none' }, // 幂等:无 token 也 200
  { method: 'DELETE', pattern: '/api/session',   auth: 'none' },  // 幂等登出:无 token 也 204(POST /api/session 已下线:CSO #1 未认证 SSRF 链)
  // --- 平台 ---
  { method: 'GET',  pattern: '/api/auth/me',            auth: 'platform' },
  { method: 'PATCH', pattern: '/api/auth/me',              auth: 'platform' }, // 自助改 displayName
  { method: 'PUT',   pattern: '/api/auth/preferences',     auth: 'platform' }, // 自助偏好(language/theme)
  { method: 'POST',   pattern: '/api/auth/change-password',     auth: 'platform' }, // 自助改密(踢其他会话)
  { method: 'GET',    pattern: '/api/auth/sessions',            auth: 'platform' }, // 我的活跃会话
  { method: 'DELETE', pattern: '/api/auth/sessions/others',     auth: 'platform' }, // 退出其他设备
  { prefix: '/api/auth/sessions/', auth: 'platform' },                              // :fingerprint 吊销
  { method: 'GET',  pattern: '/api/ssh/terminal',        auth: 'platform' }, // WS 升级(ssh 终端):upgrade 时自校验平台 session,门登记为地板
  { method: 'GET',  pattern: '/api/my-clusters',        auth: 'platform' },
  { method: 'POST', pattern: '/api/connect-cluster',    auth: 'platform' },
  { method: 'GET',  pattern: '/api/version',            auth: 'platform' },
  { method: 'POST', pattern: '/api/version/check',      auth: 'platform' },
  { method: 'GET',  pattern: '/api/ingress-controllers/catalog',        auth: 'platform' }, // 此前无鉴权(自称静态资产);门收归平台
  { prefix: '/api/ingress-controllers/manifest/',       auth: 'platform' },
  { prefix: '/api/auth/',   auth: 'platform' },  // 未来 auth 子路由的地板(精确条目在上面优先命中)
  // --- 会话(K8s session) ---
  { method: 'GET',  pattern: '/api/session',   auth: 'session' },
  { method: 'POST', pattern: '/api/apply',     auth: 'session' },
  { method: 'POST', pattern: '/api/pod/debug', auth: 'session' },
  { method: 'POST', pattern: '/api/cronjob/trigger', auth: 'session' },
  { method: 'POST', pattern: '/api/registry/tags',    auth: 'session' }, // CSO 审计 #2(2026-08-28 修):曾漏挂
  { method: 'GET',  pattern: '/api/resource/tree',    auth: 'session' },
  { method: 'GET',  pattern: '/api/k8s-watch',        auth: 'session' },
  { prefix: '/api/k8s/',         auth: 'session' },
  { prefix: '/api/portforward',  auth: 'session' },   // 精确 + /:id 子路径
  { prefix: '/api/pvcfile/',     auth: 'session' },
  { prefix: '/api/podfile/',     auth: 'session' },
  { prefix: '/api/terminals',    auth: 'session' },   // 精确 + /:id 子路径
  { prefix: '/api/file-browsers',auth: 'session' },
  // --- SSH 服务器管理(2026-08-28 ssh-management 合并后补登记:regex dispatch 逃过字面量扫描,门外 404) ---
  { prefix: '/api/sshfile/', auth: 'platform' },  // 文件浏览/下载:内层 requirePlatform
  { prefix: '/api/ssh/',     auth: 'admin' },     // servers CRUD/test:内层 requireAdmin
  // --- 管理员(全部 /api/admin/*:llm-config/clusters/apikeys/audit-log/users/…) ---
  { prefix: '/api/admin/', auth: 'admin' },
  // --- 工作台(混合层:地板=platform;records/distill/conv 等内层 requireAdmin 收严) ---
  { prefix: '/api/workbench/', auth: 'platform' },
  // --- API key 机器面(/api/key/<cluster>/call、…/logs;401 shape 特殊) ---
  { prefix: '/api/key/', auth: 'apikey' },
  // --- MCP(JSON-RPC;门放行,内层自检,见文件头注释) ---
  { pattern: '/mcp', auth: 'mcp' },
]

// (method, pathname) → 鉴权 class;未登记 → undefined(门将 404)。精确优先于前缀。
export function authClassFor(method, pathname) {
  for (const r of ROUTE_AUTH) {
    if (r.pattern != null && r.pattern === pathname && (!r.method || r.method === method)) return r.auth
  }
  for (const r of ROUTE_AUTH) {
    if (r.prefix != null && pathname.startsWith(r.prefix) && (!r.method || r.method === method)) return r.auth
  }
  return undefined
}

// 门机制:按 class 分发到注入的验证器。纯函数式(验证器/sendJson 均注入),可单测。
// 验证器 (req, res) => boolean|Promise<boolean>:true=放行(可顺带把解析结果挂 req 供 handler 复用);
// false=已写响应(401/403),门终止。未知 class fail-closed(500+吵,配置 bug 不能静默放行)。
export function createAuthGate({ sendJson, verifiers }) {
  return async function gate(cls, req, res) {
    if (cls === 'none') return true
    const v = verifiers[cls]
    if (!v) {
      console.error(`[auth-gate] 未知鉴权 class: ${cls}(ROUTE_AUTH 配置错误)`)
      sendJson(res, 500, { message: `route auth class 配置错误: ${cls}` })
      return false
    }
    return !!(await v(req, res))
  }
}
