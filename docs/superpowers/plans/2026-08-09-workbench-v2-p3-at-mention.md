# 工作台 V2 P3 — @-mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 对话输入 `@pod:nginx` 搜资源 → 选中插 chip → 发送时注入 agent 上下文。

**Architecture:** 后端搜索 endpoint + WorkbenchChat @-tokenizer + 发送 references 注入。

**Tech Stack:** Node.js + Vue 3。零新依赖。

## Global Constraints
- 零新依赖;`npm run build` + `npm run i18n:check`。
- 搜索 endpoint requireAdmin;用平台 dispatcher(非 SA token)。
- commit: `feat(workbench): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: 搜索 endpoint + client API

**Files:** Modify `server/index.mjs`; Modify `src/api/client.js`

- [ ] **Step 1:** `server/index.mjs` 加 `GET /api/workbench/search`:
  - requireAdmin。
  - query: `projectId, kind, q`。
  - 取 project → clusterId → buildCallContext → requestKubernetes(session, listPath)。
  - kind → listPath map: pods/services/configmaps → core `/api/v1/...`;deployments/statefulsets/daemonsets → apps `/apis/apps/v1/...`;ingresses → networking `/apis/networking.k8s.io/v1/...`;secrets → core `/api/v1/...`;namespaces → core `/api/v1/namespaces`。
  - 返回 items filter by name includes(q) → `[{name,namespace,kind}]` capped 50。
  - q 空 → 全部 capped 50。

- [ ] **Step 2:** `src/api/client.js` workbenchApi 加:
```js
search: (projectId, kind, q) => platformHttp.request(`/api/workbench/search?projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q || '')}`),
```

- [ ] **Step 3:** `node --check server/index.mjs && npm run build`

- [ ] **Step 4:** commit `feat(workbench): GET /api/workbench/search(项目集群资源搜索,capped 50)`

### Task 2: WorkbenchChat @-tokenizer + 下拉 + chip

**Files:** Modify `src/components/workbench/WorkbenchChat.vue`; i18n keys

- [ ] **Step 1:** WorkbenchChat script 加:
  - `const refs = ref([])` — 已选 @-refs。
  - `const searchResults = ref([])` `const searching = ref(false)` `const searchOpen = ref(false)`。
  - `const KIND_MAP = { pod:'pods', pods:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', cm:'configmaps', configmap:'configmaps', ns:'namespaces', namespace:'namespaces', ingress:'ingresses', secret:'secrets' }`。
  - `watch(input)` → 检测 `@kind:query` token(regex `/@(\w*):(\S*)$/`)→ debounce 300ms → search。
  - `async function doSearch(kind, q)` → `workbenchApi.search(props.projectId, kind, q)` → `searchResults`。
  - `function selectRef(item)` → 从 input 删 token → `refs.push({kind:item.kind,namespace:item.namespace,name:item.name})` → clear search。
  - `function removeRef(idx)` → `refs.splice(idx, 1)`。

- [ ] **Step 2:** 模板加:
  - refs chips 行(输入框上方):`v-for="ref in refs"` chip 显示 `kind/ns/name` + ×。
  - 搜索下拉(输入框 absolute):`v-if="searchOpen"` 列表 `v-for="item in searchResults"` → click selectRef。
  - kind 补全:`@` 后无 `:` → 提示 KIND_MAP keys。

- [ ] **Step 3:** `send()` 加 references:
```js
const payload = { projectId: props.projectId, message: msg }
if (refs.value.length) { payload.references = refs.value.map(r => ({kind:r.kind,namespace:r.namespace,name:r.name})); refs.value = [] }
const res = await workbenchApi.chat(payload)
```

- [ ] **Step 4:** i18n `workbench.chat.atMention*`(zh/en):hint/noResults/searching。

- [ ] **Step 5:** `npm run i18n:check && npm run build`

- [ ] **Step 6:** commit `feat(workbench): @-mention tokenizer + 搜索下拉 + chip + references 注入`

### Task 3: 服务端 references 注入 agent 上下文 + 全量验证

**Files:** Modify `server/index.mjs`(agent chat handler)

- [ ] **Step 1:** `/api/agent/chat` projectId 分支：
  - 收到 `input.references` → 对每个 ref → `requestKubernetes(session, getApiPath(ref.kind, ref.namespace, ref.name))` → 取完整资源。
  - 拼成 context block → prepend 到 message 或注入 system prompt。
  - 格式: `Referenced resources:\n[<kind>/<ns>/<name>]:\n<yaml>\n`。
  - 失败(not found) → `[<kind>/<ns>/<name>]: (not found)`。
  - 注入到 user message 前缀(不改动 agent loop,只改 message content)。

- [ ] **Step 2:** `node --check server/index.mjs && npm test && npm run build`

- [ ] **Step 3:** commit `feat(workbench): references 注入 agent 上下文(YAML prepend to message)`
