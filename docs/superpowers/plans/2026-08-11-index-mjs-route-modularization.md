# index.mjs 路由模块化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2179 行的 `server/index.mjs`(61 条 HTTP 路由全堆在一起)拆成 per-module 路由文件,让 AI 各模块(M2 Agent/LLM、M3 工具、M4 工作台后端、M5 MCP、M6 API-key/审计)能各自 own 自己的路由文件 → 多个 AI 真正并行,不在同一个文件里撞车。

**Architecture:** 纯重构,零行为变更。
- 在 `index.mjs` 顶部建一个 `ctx` 对象,装载所有路由共享的依赖(`db`、`sendJson`、`readBody`、`requireAdmin`/`requirePlatform`、`requestKubernetes`、`buildCallContext`、`sessions`、failover 状态、`WORKBENCH_DIR`、`getLlmConfig`、`createLlmClient`、`createAgentRunner` 等)。
- 每个 `server/routes/<name>.mjs` 导出 `handle(req, res, url, ctx) => boolean`(命中并响应了返回 `true`,否则 `false` 落到下一个)。
- `index.mjs` 的请求监听器:`for (const r of ROUTES) { if (await r.handle(req, res, url, ctx)) return }` → 再走剩余内联路由 + `serveStatic`。
- **增量**:每 Task 只搬一组路由,搬完即可独立验证;未搬的继续内联。

**Tech Stack:** Node `http`(无框架)+ undici + node:sqlite。路由是手写 `if (url.pathname...)` 链。

## Global Constraints

- **纯重构,零行为变更**:只搬位置,不改任何路由的逻辑/返回/错误处理。搬完每个端点的行为必须与搬前**逐字节一致**。
- **每个 Task 结束必须**:`npm run test:server` 全绿 + 受影响端点手测(curl 或浏览器)通过,才进下一个 Task。
- **闭包陷阱**:`index.mjs` 里大量路由闭包引用模块级变量(`db`、`sessions`、`discoveryCache`、failover、各 helper)。搬到 `routes/*.mjs` 时,这些必须经 `ctx` 传入——**搬之前先 grep 出该路由引用的所有模块级符号**,确保 ctx 都带上了;漏一个就是运行时 `ReferenceError`(往往要触发该端点才暴露)。
- **WebSocket 端点**(`/api/exec`、`/api/attach`、`/api/portforward` 等 ws 升级)**本计划不动**——它们不是 `handle(req,res)` 形态,留在 index.mjs。
- **detached 后台执行**:`runConversation`/`resumeConversation` 是闭包(捕获 llmClient + workbench ctx + db),跟对话端点一起搬到 `routes/workbench-conversations.mjs`,经 ctx 传依赖。
- 零新增依赖。`.mjs` 由 `npm run typecheck`(`node --check`)覆盖。

## File Structure(目标)

```
server/
  index.mjs                    # 瘦身后:启动 + ctx 构建 + ROUTES 分发 + 剩余非-AI 路由 + WS
  routes/
    workbench-conversations.mjs # M2/M4:5 对话端点 + run/resumeConversation(detached)
    workbench-projects.mjs      # M4:项目 CRUD
    workbench-search.mjs        # M4/F:@-mention 资源搜索
    workbench-ledger.mjs        # M4:cluster ledger + distill + reconcile
    mcp.mjs                     # M5:/mcp
    api-key.mjs                 # M3:/api/key/*(工具调用)
    admin-llm.mjs               # M2:LLM 配置
    admin-keys.mjs              # M6:API key 签发/列表/吊销
    admin-audit.mjs             # M6:审计流水
  ctx.mjs                       # (可选)makeCtx 工厂 + ctx 的 JSDoc 类型说明
```

> 剩余非-AI 路由(`/api/auth/*`、`/api/connect-cluster`、`/api/k8s/*` 透传、`/api/admin/clusters`、`/api/admin/users`、各种 WS)留在 index.mjs,本计划不强制拆(后续若要并行可再拆)。

---

### Task 1: 地基——ctx 对象 + ROUTES 分发环(不搬任何路由)

**Files:** Modify `server/index.mjs`

**Interfaces:**
- Produces: `ctx` 对象(在请求监听器外构建一次)+ `ROUTES` 数组(初始为空)+ 分发循环。后续 Task 往 ROUTES 里 push 模块。

- [ ] **Step 1:** 在 `index.mjs` 所有 setup(db、helpers、probers 等)完成后,构建 `ctx` 对象,字段 = 所有路由可能用到的模块级符号(先尽量全,后面发现缺再加):`db, sendJson, readBody, requireAdmin, requirePlatform, resolveSession`(或现有会话解析),`requestKubernetes, buildCallContext, sessions, discoveryCache, failover({isFailoverEligible,currentEndpoint,currentDispatcher}), WORKBENCH_DIR, getLlmConfig, createLlmClient, createAgentRunner, createWbCtx/buildWbCtx`(工作台上下文工厂),`apiKeyTools, mcpHandler, clusterProber`,以及 workbench-* 导出的函数(`createConversation` 等)。**逐一核对**:grep 几个路由确认它们用的符号都在 ctx 里。
- [ ] **Step 2:** 在请求监听器入口加分发环:`const url = new URL(req.url, 'http://localhost'); for (const r of ROUTES) { try { if (await r.handle(req, res, url, ctx)) return } catch (e) { return sendJson(res, e.status||500, {message:e?.message||'路由失败'}) } }`(注意:现有监听器里 `url` 已在用——复用同一个,别重复声明)。ROUTES 初始 `[]`。
- [ ] **Step 3:** `npm run test:server` + 启动网关 curl `/api/health` 与一个 workbench 端点,确认**行为未变**(此时所有路由仍走原内联逻辑,分发环空转)。
- [ ] **Step 4:** Commit `chore(server): routes 分发环 + ctx 地基(无路由迁移)`。

---

### Task 2: 抽 workbench-conversations(M2/M4 最大面,含 detached run)

**Files:** Create `server/routes/workbench-conversations.mjs`; Modify `server/index.mjs`

**Interfaces:**
- Consumes (from ctx): `db, sendJson, readBody, requireAdmin, requestKubernetes, buildCallContext, getLlmConfig, createLlmClient, createAgentRunner, buildWbCtx/getProject, createConversation, getConversation, updateConversation, listConversations, appendTrace, appendHistory`(以及 `runConversation`/`resumeConversation` 里用到的)。
- Produces: `handle(req,res,url,ctx) => boolean`,匹配 `/api/workbench/conversations`(POST 列表)、`/api/workbench/conversations/:id`(GET)、`/:id/approve`、`/:id/deny`。

- [ ] **Step 1:** grep `index.mjs` 里这 5 个对话端点 + `runConversation`/`resumeConversation`/`handleAgentResult` 闭包,列出它们引用的**所有模块级符号**(db、sendJson、workbench-projects 函数、llmClient 构造、agent runner、@-ref 注入的 requestKubernetes/buildCallContext 等)。把列表写进模块顶部注释。
- [ ] **Step 2:** 新建 `routes/workbench-conversations.mjs`,把这些端点的 `if` 块 + 三个 helper 函数整体搬入,函数体里把模块级符号全改成 `ctx.xxx`。导出 `handle(req,res,url,ctx)`:`if (!url.pathname.startsWith('/api/workbench/conversations')) return false` → 内部按 method+pathname 分派 → 命中并 sendJson 后 `return true`,否则 `return false`。
- [ ] **Step 3:** `index.mjs`:import 该模块,`ROUTES.push(workbenchConversations)`,**删掉**原内联的 5 个对话 if 块 + 三个 helper(确认没被别处引用)。
- [ ] **Step 4:** 验证:`npm run test:server` + 手测(登录→workbench→项目→发消息→对话跑到 done;@pod:x 发送→卡片)。**重点确认 detached run 不报 ReferenceError**。
- [ ] **Step 5:** Commit `refactor(server): 抽 workbench-conversations 路由到 routes/`。

---

### Task 3: 抽 workbench-projects + workbench-search + workbench-ledger(M4)

**Files:** Create `routes/workbench-projects.mjs`、`routes/workbench-search.mjs`、`routes/workbench-ledger.mjs`; Modify `index.mjs`

每个按 Task 2 的同套流程(列闭包符号→搬→改 ctx.xxx→push ROUTES→删内联→验证)。注意:
- **workbench-search**(`@-mention`)用 `requestKubernetes`/`buildCallContext`(取集群凭据)+ `getProject`;`requestKubernetes` 返回 `{status,headers,body}`,资源在 `.body`(别踩之前修过的坑)。
- **workbench-ledger**(ledger + distill + reconcile)用到 `wbReadFile/wbListFiles`、`runDistill`、`reconcileProject`、`formatIndexMd`、scheduler 状态(`getPendingDistill` 等)——distill 的定时器/后台任务若在 index.mjs 启动,保留在 index.mjs,只搬 HTTP 端点。

- [ ] 每个 sub-task 结束 `npm run test:server` + 手测对应端点;全部完成后一次 commit `refactor(server): 抽 workbench projects/search/ledger 路由`。

---

### Task 4: 抽 mcp + api-key(M5/M3)

**Files:** Create `routes/mcp.mjs`、`routes/api-key.mjs`; Modify `index.mjs`

- **mcp**:`/mcp`(SSE/streaming,POST tools/call 等)——确认 `mcpHandler`/`createMcpServer` 已在 ctx;handle() 里转发给 mcpHandler。
- **api-key**:`/api/key/*`(API-key 工具调用,经 `apiKeyTools` + 鉴权 + 审计)——`apiKeyTools`、`resolveApiKey`、`checkRate`、审计写入都在 ctx。
- 验证:外接 AI(Claude Code)走 MCP 打通 + 用 API key 调一个工具(curl `/api/key/...`)。

---

### Task 5: 抽 admin-llm + admin-keys + admin-audit(M2/M6)

**Files:** Create `routes/admin-llm.mjs`、`routes/admin-keys.mjs`、`routes/admin-audit.mjs`; Modify `index.mjs`

- **admin-llm**:LLM 配置 GET/PUT(`getLlmConfig`/setLlmConfig,GET 不回传 key)。
- **admin-keys**:`mintKey`/`listKeys`/`revokeKey` + `normalizeToolOverrides`/`normalizeAllowedNamespaces`。
- **admin-audit**:`queryAuditLog`/`activeKeys`/`verifyChain`。
- 验证:各 admin 页面/端点手测。

---

### Task 6: 收口 + 全量验证

**Files:** Modify `server/index.mjs`

- [ ] **Step 1:** `index.mjs` 现在应只剩:imports、setup、`ctx`、`ROUTES` 分发、**剩余非-AI 路由**(auth、connect-cluster、k8s 透传、admin/clusters、admin/users、WS 升级)、`serveStatic`。给 index.mjs 顶部写一段路由地图注释(指向 routes/*)。
- [ ] **Step 2:** 全量门禁:`npm run i18n:check && npm run typecheck && npm test && npm run build`。
- [ ] **Step 3:** 端到端冒烟:登录→选集群→workbench→发消息(含 @pod:x 卡片)→对话 done;MCP/API-key 端点;admin 页面。
- [ ] **Step 4:** Commit `refactor(server): index.mjs 路由模块化收口(瘦身 + 路由地图)`。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| 漏传闭包符号 → 运行时 `ReferenceError`(往往要触发端点才暴露) | 搬之前 grep 该路由所有模块级引用;Task 2 的 detached run 是高危,重点手测发消息流程 |
| 行为漂移(搬的时候手滑改了逻辑) | 纯搬:函数体逐字复制,只把 `foo`→`ctx.foo`;diff 时确认无逻辑改动 |
| 分发环改变错误处理/响应头顺序 | Task 1 的 try/catch 包裹 + 逐端点比对响应;分发环只在 `handle` 返回 false 时落空 |
| WS 端点误抽 | 显式排除(`/api/exec` 等),本计划不动 |
| 测试覆盖不到被搬端点 | 每个 Task 必做手测(curl/浏览器),不只跑 npm test |

## 完成标志
- 9 个 `routes/*.mjs` 就位;`index.mjs` 瘦到 ≈启动+分发+剩余非-AI 路由;全量门禁绿;端到端冒烟通过。
- 之后 M2/M3/M4/M5/M6 各 AI 在自己模块的 `routes/*.mjs` + 业务 `.mjs` 里改,**互不冲突**。
