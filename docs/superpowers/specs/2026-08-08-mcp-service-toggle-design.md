# MCP 服务开关 + 使用提示

- 日期:2026-08-08
- 分支:`feat/mcp-toggle`(worktree `.claude/worktrees/mcp-toggle`,从 `origin/main` `97de8a5` 起)
- 状态:APPROVED(brainstorm 2026-08-08)

## 背景

`/mcp` 路由目前**始终开放**(`index.mjs:789 if (url.pathname === '/mcp') return mcpHandler(req, res)`)——无开关、无状态指示。管理员需要能从 UI 控制是否对外暴露 MCP 服务,并在开启时看到客户端连接方式。

## 范围

**做:**
1. `platform_settings` 存 `mcp_enabled`(默认 `'true'`);`/mcp` 路由 gate(disabled → 503)。
2. `GET` / `PUT /api/admin/mcp-config`(`requireAdmin`)。
3. `Settings.vue` General tab 加「MCP 服务」卡片:开关 toggle + 状态(🟢/🔴)+ **开启时的客户端使用提示**(连接 URL + Auth 格式 + 指向 API Keys 管理)。
4. i18n 全覆盖(zh/en,`npm run i18n:check` 门禁)。

**不做:** 在线客户端状态(stateless MCP 无 session,已排除);gate 内部 agent(`/api/agent/chat`,内部路径,不受影响)。

## 设计

### 后端(`server/index.mjs`)

**MCP gate**(line 789 区域):
```js
if (url.pathname === '/mcp') {
  if (getSetting('mcp_enabled') === 'false') return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'MCP service disabled by admin' } })
  return mcpHandler(req, res)
}
```
默认 `'true'`(getSetting 返 null → 不等于 'false' → 放行 = 当前行为)。

**端点**(mirror LLM config pattern at line 880/893):
```js
if (url.pathname === '/api/admin/mcp-config' && req.method === 'GET') {
  const ps = requireAdmin(req, res); if (!ps) return
  return sendJson(res, 200, { enabled: getSetting('mcp_enabled') !== 'false' })
}
if (url.pathname === '/api/admin/mcp-config' && req.method === 'PUT') {
  const ps = requireAdmin(req, res); if (!ps) return
  try { const input = await readBody(req); setSetting('mcp_enabled', input.enabled === false ? 'false' : 'true'); return sendJson(res, 200, { ok: true, enabled: input.enabled !== false }) }
  catch (e) { return sendJson(res, 400, { message: e.message }) }
}
```

### 前端(`src/views/Settings.vue` General tab)

General tab 的 `space-y-md` div 里(Language/cluster name/version 之后)加 MCP 卡片,**admin 可见**(v-if auth.isAdmin):
- **Toggle 开关**:点击 → PUT mcp-config。
- **状态**:🟢 运行中 / 🔴 已关闭。
- **开启时使用提示**(enabled && 展开):显示连接方式:
  - URL: `<平台地址>/mcp`(用 `window.location.origin + '/mcp'` 计算近似值 + 说明)
  - Header: `Authorization: Bearer <API key>`
  - 说明:在「平台管理 → API Keys」签发 key;key 的 tier + namespace + tool_overrides 决定可用的工具/范围。
- **关闭时**:「MCP 服务已关闭,外部 AI 客户端无法通过 /mcp 连接。」

### i18n

`settings.mcp.*` 键(zh + en 对齐):
- `title`: MCP 服务
- `enabled`: 运行中 / Running
- `disabled`: 已关闭 / Disabled
- `usageTitle`: 客户端连接方式 / Client connection
- `usageUrl`: 连接地址 / Endpoint URL
- `usageAuth`: 认证头 / Auth header
- `usageNote`: 在「API Keys 管理」签发 key;key 的权限档(tier)+ namespace + 工具覆盖决定可用工具/范围。/ Mint a key at API Keys management; the key's tier + namespace + tool_overrides determine available tools/scope.
- `disabledHint`: MCP 服务已关闭,外部 AI 客户端无法连接。/ MCP service is disabled; external AI clients cannot connect.

## 错误处理

- `/mcp` disabled → HTTP 503 + JSON-RPC error(MCP 客户端识别为服务不可用)。
- GET/PUT mcp-config 非 admin → requireAdmin 返 401/403。
- PUT 无 body / 坏 body → `input.enabled` undefined → 默认 `true`(fail-safe:不意外关闭)。

## 测试

- 后端:GET mcp-config 默认 enabled;PUT enabled=false → GET 返 false;/mcp gate disabled → 503(集成测或 node --check + 逻辑推断)。
- 前端:`npm run build` + `npm run i18n:check` 通过。

## 非目标

在线客户端状态 / agent gate / MCP 服务重启(无状态,无需)/ WebSocket 传输。
