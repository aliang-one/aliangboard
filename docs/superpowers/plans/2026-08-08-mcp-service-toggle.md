# MCP 服务开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Settings General tab 加 MCP 服务开关(admin 可见)+ 状态指示 + 开启时客户端使用提示;后端 `/mcp` gate(disabled→503)。

**Architecture:** `platform_settings` 存 `mcp_enabled`(默认 `'true'`);`/mcp` 路由 gate(OPTIONS 除外);`GET`/`PUT /api/admin/mcp-config`(`requireAdmin`);`Settings.vue` General tab 加卡片(admin guard via `auth.isAdmin`)。

**Tech Stack:** Node.js(`node --check`),Vue 3 + vue-i18n。零新依赖。

## Global Constraints

- **零新依赖**;`node --check`;`npm run build`;`npm run i18n:check`(门禁)。
- `platform_settings` 表 + `getSetting(key)` / `setSetting(key, value)` 已存在(`server/index.mjs`),直接用。
- **默认 enabled**:`getSetting('mcp_enabled')` 返 null(首次)→ 不等于 `'false'` → 放行 = 当前行为。
- **OPTIONS 不 gate**(CORS preflight 无害,放行;只 gate POST/GET/DELETE 等实际 MCP 方法)。
- **gate 仅 `/mcp`**:内部 agent(`/api/agent/chat`)不受影响。
- **i18n**:所有新文案经 `$t`/`t`,zh/en 对齐;`settings.mcp.*` 键。
- **commit 风格**:`feat(mcp): …` / `feat(ui): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。

## File Structure

| 文件 | 改动 |
|------|------|
| `server/index.mjs` | `/mcp` gate(line ~789);GET/PUT `/api/admin/mcp-config`(line ~880 区域) |
| `src/api/client.js` | `adminApi.mcpConfig = { get, update }` |
| `src/views/Settings.vue` | General tab MCP 卡片(toggle + 状态 + 使用提示);import useAuthStore |
| `src/locales/zh.json` / `en.json` | `settings.mcp.*` 键 |

---

### Task 1: 后端 — MCP gate + GET/PUT mcp-config

**Files:**
- Modify: `server/index.mjs`

**Interfaces:**
- Produces: `/mcp` gate(disabled→503);`GET /api/admin/mcp-config`→`{enabled}`;`PUT /api/admin/mcp-config`←`{enabled}`(requireAdmin)。

- [ ] **Step 1: `/mcp` gate** — `server/index.mjs` 的 `if (url.pathname === '/mcp') return mcpHandler(req, res)`(line ~789)改为:
```js
  if (url.pathname === '/mcp') {
    if (req.method !== 'OPTIONS' && getSetting('mcp_enabled') === 'false') return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'MCP service disabled by admin' } })
    return mcpHandler(req, res)
  }
```

- [ ] **Step 2: GET/PUT mcp-config 端点** — 紧邻 LLM config 端点(`GET /api/admin/llm-config`~line 880)之后加:
```js
  if (url.pathname === '/api/admin/mcp-config' && req.method === 'GET') {
    const ps = requireAdmin(req, res); if (!ps) return
    return sendJson(res, 200, { enabled: getSetting('mcp_enabled') !== 'false' })
  }
  if (url.pathname === '/api/admin/mcp-config' && req.method === 'PUT') {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const input = await readBody(req)
      setSetting('mcp_enabled', input.enabled === false ? 'false' : 'true')
      return sendJson(res, 200, { ok: true, enabled: input.enabled !== false })
    } catch (e) { return sendJson(res, 400, { message: e.message }) }
  }
```

- [ ] **Step 3: node --check + 回归**

Run: `node --check server/index.mjs && node --test server/audit.test.mjs server/api-key-tools.test.mjs`
Expected: 语法过;测试全绿(端点薄,逻辑在 getSetting/setSetting)。

- [ ] **Step 4: commit**

```bash
git add server/index.mjs
git commit -m "feat(mcp): /mcp gate(disabled→503)+ GET/PUT /api/admin/mcp-config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端 — Settings General tab MCP 卡片 + client + i18n

**Files:**
- Modify: `src/views/Settings.vue`、`src/api/client.js`、`src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: `GET`/`PUT /api/admin/mcp-config`(Task 1);`useAuthStore().isAdmin`(`src/stores/auth.js`)。
- Produces: MCP 服务卡片(admin 可见;toggle + 状态 + 开启时使用提示)。

- [ ] **Step 1: i18n 键** — `src/locales/zh.json` + `en.json` 同步加(在 `settings` 段内):
```jsonc
// zh.json settings 段内加:
"mcpTitle": "MCP 服务",
"mcpEnabled": "运行中",
"mcpDisabled": "已关闭",
"mcpUsageTitle": "客户端连接方式",
"mcpUsageUrl": "连接地址",
"mcpUsageAuth": "认证头",
"mcpUsageNote": "在「平台管理 → API Keys」签发 key;key 的权限档(tier)+ namespace + 工具覆盖决定可用工具/范围。",
"mcpDisabledHint": "MCP 服务已关闭,外部 AI 客户端无法连接。"
```
```jsonc
// en.json settings 段内加(同结构英文值):
"mcpTitle": "MCP Service",
"mcpEnabled": "Running",
"mcpDisabled": "Disabled",
"mcpUsageTitle": "Client connection",
"mcpUsageUrl": "Endpoint URL",
"mcpUsageAuth": "Auth header",
"mcpUsageNote": "Mint a key at API Keys management; the key's tier + namespace + tool_overrides determine available tools/scope.",
"mcpDisabledHint": "MCP service is disabled; external AI clients cannot connect."
```

- [ ] **Step 2: client 方法** — `src/api/client.js` 的 `adminApi` 对象(apikeys/auditTrail/llmConfig 同级)加:
```js
  mcpConfig: {
    get: () => platformHttp.request('/api/admin/mcp-config'),
    update: (enabled) => platformHttp.request('/api/admin/mcp-config', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },
```
> 读 client.js 确认 adminApi 对象的确切位置(在 apikeys 或 auditTrail 旁)。

- [ ] **Step 3: Settings.vue script** — import useAuthStore + MCP state:
```js
import { useAuthStore } from '@/stores/auth'
import { adminApi } from '@/api/client'  // 读 Settings.vue 确认是否已 import adminApi;若否加
const auth = useAuthStore()
const mcpEnabled = ref(true)
const mcpLoading = ref(false)
async function loadMcpConfig() { try { const r = await adminApi.mcpConfig.get(); mcpEnabled.value = r.enabled } catch { /* 非 admin 或无权限→静默 */ } }
async function toggleMcp() {
  mcpLoading.value = true
  try { const r = await adminApi.mcpConfig.update(!mcpEnabled.value); mcpEnabled.value = r.enabled } catch (e) { /* notify or silent */ } finally { mcpLoading.value = false }
}
const mcpUrl = computed(() => window.location.origin + '/mcp')
```
`onMounted` 里加 `loadMcpConfig()`(若 auth.isAdmin)。

- [ ] **Step 4: Settings.vue template — MCP 卡片** — General tab 的 `space-y-md` div 末尾(apiServer/status 之后)加(admin guard):
```html
            <!-- MCP Service (admin only) -->
            <div v-if="auth.isAdmin" class="flex flex-col gap-sm py-sm border-b border-outline-variant/50">
              <div class="flex justify-between items-center">
                <span class="text-body-sm text-on-surface-variant">{{ t('settings.mcpTitle') }}</span>
                <button @click="toggleMcp" :disabled="mcpLoading" class="text-xs px-sm py-xs rounded-md transition-colors"
                  :class="mcpEnabled ? 'bg-status-running/15 text-status-running' : 'bg-surface-container-low text-on-surface-variant'">
                  {{ mcpEnabled ? '🟢 ' + t('settings.mcpEnabled') : '🔴 ' + t('settings.mcpDisabled') }}
                </button>
              </div>
              <div v-if="mcpEnabled" class="bg-surface-container-low rounded-lg p-sm space-y-xs">
                <p class="text-body-xs font-semibold text-on-surface-variant">{{ t('settings.mcpUsageTitle') }}</p>
                <div class="flex justify-between items-center">
                  <span class="text-body-xs text-on-surface-variant">{{ t('settings.mcpUsageUrl') }}</span>
                  <code class="text-body-xs font-mono text-primary">{{ mcpUrl }}</code>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-body-xs text-on-surface-variant">{{ t('settings.mcpUsageAuth') }}</span>
                  <code class="text-body-xs font-mono text-primary">Authorization: Bearer &lt;API key&gt;</code>
                </div>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpUsageNote') }}</p>
              </div>
              <p v-else class="text-body-xs text-on-surface-variant">{{ t('settings.mcpDisabledHint') }}</p>
            </div>
```

- [ ] **Step 5: 校验 — i18n + typecheck + build**

Run: `npm run i18n:check && npm run typecheck && npm run build`
Expected: i18n:check 过(0 残存/对齐);typecheck 过;build 过。

- [ ] **Step 6: commit**

```bash
git add src/api/client.js src/views/Settings.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): Settings General tab 加 MCP 服务开关 + 使用提示(admin 可见)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review(写完后自查)

**1. Spec 覆盖:**
- platform_settings mcp_enabled + /mcp gate → Task 1 ✓
- GET/PUT /api/admin/mcp-config → Task 1 ✓
- Settings General tab MCP 卡片(toggle + 状态 + 使用提示)→ Task 2 ✓
- i18n(settings.mcp.* zh/en)→ Task 2 ✓
- admin guard(auth.isAdmin)→ Task 2 ✓
- OPTIONS 不 gate → Task 1 ✓

**2. 无占位:** 各步含可执行代码;i18n 键完整(zh+en);client 方法 + template 完整。

**3. 类型一致:** `adminApi.mcpConfig.get()` → `{enabled}`;`update(enabled)` → `{ok, enabled}`;Settings `mcpEnabled` ref + `toggleMcp` 调 update。
