# 工作台项目生命周期补全实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目可删除/重命名,项目记忆(projectRecap)可人工编辑/清空,摘要器断掉"瞬时能力结论固化为持久先验"的机制。

**Architecture:** 数据层(deleteProject/setProjectRecap)+ 路由(DELETE/PATCH /api/workbench/projects/:id,owner/admin)+ 前端(列表删除/重命名 + recap 卡编辑/清空)+ 摘要器两条加固。规格:`docs/superpowers/specs/2026-08-31-workbench-project-lifecycle-design.md`。

**Tech Stack:** node:25(node:sqlite,node --test)、Vue3 + vitest(happy-dom)。无新依赖。

## Global Constraints

- 路由鉴权:`/api/workbench/` 前缀已在 ROUTE_AUTH 登记为 platform(地板),内层按既有项目路由同款做 owner/admin 收严(`project.ownerId !== ps.userId && ps.role !== 'admin'` → 403),无需改 route-auth-map。
- 删除级联:消息+对话+项目行**单事务**;repo 目录删除在事务提交后,失败仅 `console.error` 不回滚;repo 路径必须 `path.resolve` 后以 `WORKBENCH_DIR` 为前缀(防逃逸),双形态(`repoRoot==='projects'` 与 legacy)都要支持。
- running/paused 对话先 `wbAgent.cancelConversation(id)` + `busDispose(id)`(沿用对话删除 P0(F) 守卫)。
- recap:非空 ≤64KB;空串 = 置 NULL + `historyWatermark=0`;覆写保留水位。
- 审计:删除落 `writeAudit { verb:'write', tool:'project_delete', source:'platform' }`。
- server 字符串 zh-only 沿惯例;前端新 UI 键 en/zh 双语齐,过 `npm run i18n:check`。
- 提交作者 repo config,信息不带 AI 尾注。
- 所有 server 测试用 `node --test <file>`;TDD 红灯先行。

---

### Task 1: 数据层——deleteProject + setProjectRecap

**Files:**
- Modify: `server/workbench-projects.mjs`
- Test: `server/workbench-projects.test.mjs`(若已有则追加)

**Interfaces:**
- Produces:
  - `deleteProject(db, { workbenchDir, projectId }) -> { ok, removedConversations, repoRemoved, repoError? }`:校验项目存在(不存在返 `{ok:false,status:404}`);repo 路径 resolve 后必须以 `workbenchDir` resolve 为前缀,否则返 `{ok:false,status:400,error:'repo path escape'}`;单事务删 messages(conversationId IN 子查询)→ conversations(projectId=?)→ projects 行;事务提交后 `fs.rmSync(repo,{recursive,force})`,失败置 `repoError`(不回滚);返回移除的对话数
  - `setProjectRecap(db, projectId, recap) -> { ok }`:recap 为空串 → `projectRecap=NULL, historyWatermark=0`;非空(≤65536)→ 覆写 `projectRecap=recap`(不动 watermark);超长返 `{ok:false,status:400}`
- 依赖注入注意:`deleteProject` 需要 `wbAgent.cancelConversation`/`busDispose` 吗?——**不需要**,那是路由层职责(Task 2);数据层只管数据与目录

- [x] **Step 1: 写失败测试**(覆盖:404 / 路径逃逸 400 / 双形态删除 / 级联完整 / running 对话行也被删 / repoError 不回滚 / recap 清空归零水位 / recap 超长 400)。用真 `node:sqlite` 临时库 + `mkdtemp` 临时 workbenchDir + 真 git init 不必要(repo 目录用假文件树即可,`fs.mkdirSync(projectRepoPath(...), {recursive:true})` + 放一个哨兵文件,断言删除后目录消失)。路径逃逸用例:手工 UPDATE 该行 `repoRoot='../../escape'` → deleteProject 返 400 且文件仍在
- [x] **Step 2: 跑测试确认失败** — `node --test server/workbench-projects.test.mjs`
- [x] **Step 3: 实现**(顶部 `import { rmSync } from 'node:fs'`、`import { resolve, join } from 'node:path'`;事务 `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` 同对话删除写法)
- [x] **Step 4: 跑测试全绿**
- [x] **Step 5: Commit** `feat(workbench): 项目删除数据层——级联事务+repoRoot 双形态+路径逃逸拒绝+recap 人工写`

### Task 2: 路由——DELETE /:id + PATCH /:id

**Files:**
- Modify: `server/routes/workbench-projects.mjs`(在 `seg[1] === 'cluster'` 分支旁)
- Modify: `server/index.mjs`(createWorkbenchProjectRoutes deps 增 `wbAgent`/`busDispose`/`writeAudit` 中缺失者——先核该 routes 工厂现有 deps,已有则不动)
- Test: `server/routes/workbench-projects.test.mjs`(若已有则追加;无则新建,harness 参照 `server/ssh/job-policy-routes.test.mjs` 的 spawn-网关模式或既有项目路由测试)

**Interfaces:**
- `DELETE /api/workbench/projects/:id` body `{ confirmName }`:`confirmName !== project.name`(trim 后)→ 400;非 owner/admin → 403;项目不存在 → 404;有 running/paused 对话 → 逐个 `deps.wbAgent.cancelConversation(id)` + `deps.busDispose?.(id)`;然后调 Task 1 `deleteProject`;成功 → 审计 + `{ ok:true, removedConversations, repoRemoved }`,`repoError` 存在时响应带 `warning` 字段仍 200
- `PATCH /api/workbench/projects/:id` body `{ name?, recap? }`:name trim 非空 ≤80(空/超长 400);recap 校验同 Task 1;至少给一个字段,全缺 → 400;成功 `{ ok:true, project: {...更新后} }`
- 两路由各落一条审计(PATCH verb write tool `project_update` / DELETE tool `project_delete`)

- [x] **Step 1: 写失败测试**(确认名不符 400 / 403 / 404 / 成功删除后 GET 列表不再含它、其对话 GET 404 / PATCH 改名生效 / PATCH recap 空串清空)
- [x] **Step 2: 跑测试确认失败**(DELETE/PATCH 现为 404——门的行为)
- [x] **Step 3: 实现**(路由插在既有 `seg[1] === 'cluster'` 分支旁;DELETE 里先查对话列表拿 running 集合与计数再调数据层)
- [x] **Step 4: 全绿 + 回归** `node --test server/routes/`
- [x] **Step 5: Commit** `feat(workbench): 项目删除/重命名/recap 人工通道路由——owner 收严+确认名+审计`

### Task 3: 摘要器加固

**Files:**
- Modify: `server/workbench-summarize.mjs`(摘要提示词拼装处,~103 行附近)
- Modify: `server/workbench-agent.mjs:186 与 276`(注入头两处字面)
- Test: `server/workbench-summarize.test.mjs`(追加)、`server/workbench-agent.test.mjs`(更新注入字面断言)

**Interfaces:**
- 摘要提示词追加(逐字):`硬性约束:工具、能力、权限的可用性随时可能因部署/配置变化,禁止把"某功能不可用/缺少某接口"这类瞬时状态写入摘要;摘要只记录稳定的项目事实、目标与决策。`
- 注入头字面改为:`[Project memory — 之前对话的决策摘要](历史经验供参考;工具与能力以本轮实际提供的为准)`
- 两处注入字面同步;grep 全仓旧字面确保无第三处

- [x] **Step 1: 写失败测试**(summarize:mock db 捕获拼装的 summarizer 指令含约束语句;agent:注入断言更新为带 caveat 的新字面)
- [x] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全绿**(回归 `node --test server/workbench-summarize.test.mjs server/workbench-agent.test.mjs`)
- [x] **Step 5: Commit** `fix(workbench): 摘要器加固——禁止瞬时能力结论入记忆+注入头标注以本轮实际工具为准(毒记忆事故)`

### Task 4: 前端——项目列表删除/重命名 + client API

**Files:**
- Modify: `src/api/client.js`(~250 行 workbenchApi 段加两个方法)
- Modify: `src/views/WorkbenchList.vue`(项目列表行加「重命名」「删除」;删除用 Modal/confirm 输入项目名)
- Test: `src/views/__tests__/WorkbenchList.lifecycle.test.js`(vitest,mount + 交互;Teleport/Modal 断言查 document.body)
- Modify: `src/locales/zh.json` + `src/locales/en.json`(键:`workbench.list.deleteProject / renameProject / confirmDeleteProjectTitle / confirmDeleteProjectHint / confirmDeleteProjectPlaceholder / projectDeleted / projectDeleteFailed / projectRenamed / projectRenameFailed`)

**Interfaces:**
- client:`deleteProject: (id, confirmName) => platformHttp.request(\`/api/workbench/projects/\${encodeURIComponent(id)}\`, { method: 'DELETE', body: JSON.stringify({ confirmName }) })`;`updateProject: (id, patch) => platformHttp.request(\`/api/workbench/projects/\${encodeURIComponent(id)}\`, { method: 'PATCH', body: JSON.stringify(patch) })`
- 删除交互:点删除 → 输入框必须与项目名逐字一致才启用确定按钮;成功后从列表移除 + notify
- 重命名:行内输入(参照 WorkbenchDetail 对话重命名的既有交互形态)

- [x] **Step 1: 写失败 vitest** → **Step 2: 红** → **Step 3: 实现 client + 视图 + i18n** → **Step 4: `npx vitest run src/views/__tests__/WorkbenchList.lifecycle.test.js` 绿 + `npm run i18n:check` 绿**
- [x] **Step 5: Commit** `feat(workbench): 项目列表删除/重命名——确认名防误删+行内重命名`

### Task 5: 前端——recap 卡编辑/清空

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(recap 折叠卡 ~997 行)
- Test: `src/components/workbench/__tests__/WorkbenchChat.recap.test.js`
- Modify: `src/locales/zh.json` + `en.json`(键:`workbench.chat.recapEdit / recapSave / recapCancel / recapClear / recapClearConfirm / recapSaved / recapClearDone / recapSaveFailed`)

**Interfaces:**
- 卡片头部加「编辑」「清空」(有 recap 时;编辑态 textarea + 保存/取消)
- 保存 → `workbenchApi.updateProject(projectId, { recap })` → 成功刷新 `projectRecap.value` + notify;清空 → 二次确认 → `updateProject(projectId, { recap: '' })` → 卡片隐藏(recap 为空时 v-if 收起)
- 权限:沿用该组件现有的 owner/admin 判定(若无则不显式限制——后端已收严)

- [x] **Step 1: 写失败 vitest**(mock workbenchApi.updateProject;断言编辑保存调用与清空调用 `recap:''`)→ **Step 2: 红** → **Step 3: 实现 + i18n** → **Step 4: vitest 绿 + i18n:check 绿**
- [x] **Step 5: Commit** `feat(workbench): 项目记忆卡编辑/清空——人工纠偏通道`

### Task 6: 全量门禁 + 手测清单

- [ ] `npm run test:server` 全绿;`npm run test:unit` 全绿;`npm run i18n:check` 绿;`npm run build` 绿
- [ ] 写运维/手测清单 `docs/superpowers/specs/2026-08-31-workbench-project-lifecycle-ops.md`:①删项目(建一次性项目→删→列表消失+pod 内 repo 目录消失+对话 404)②删项目确认名不符被拒 ③重命名 ④recap 编辑/清空后新对话注入变化(透明面板核) ⑤摘要器 caveat 出现在新对话提示词(透明面板核) ⑥旧毒项目(全局分析)在清 recap 后新对话恢复 SSH 工具调用
- [ ] Commit `test(workbench): 项目生命周期门禁+手测清单`

## 任务依赖

Task 1 → 2 → 4 / 5;Task 3 独立;Task 6 收尾。Task 3 可与 1/2 并行。

## Self-Review 记录

- 规格覆盖:§1 删除→T1/T2/T4;§2 重命名+recap 通道→T1/T2/T5;§3 加固→T3;§5 测试→各任务+T6。无遗漏。
- 占位符:无 TBD;harness「参照既有文件」为显式指令。
- 一致性:`setProjectRecap`/`deleteProject` 签名 T1↔T2 一致;client 方法名 `deleteProject/updateProject` T4/T5 一致;注入头新字面 T3 单点定义两处同步。
