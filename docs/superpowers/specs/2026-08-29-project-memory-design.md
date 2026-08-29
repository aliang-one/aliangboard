# 项目级跨对话记忆 设计

- 日期:2026-08-29
- 状态:已评审(brainstorming 两问定案:滚动摘要+动态注入;折叠卡+admin 开关),待实施
- 范围:AI 工作台项目级记忆(新对话继承项目历史决策)

## 1. 背景

`workbench_history` 每次对话 done 都在累积 user/assistant 全文,但 `recentHistory()` **零消费方**——新对话对"这个项目之前做过什么决定"完全失忆。原料已在攒,缺生成与注入。

## 2. 决策记录

| # | 决策 | 选择 |
|---|------|------|
| D1 | 形态 | **项目滚动摘要**(与对话 recap 同族):新增未摘要 history ≥ 阈值时,LLM 把「旧项目摘要+新增历史」滚动重摘要;**refreshSystem 每轮动态注入**(不烘焙,恒新鲜)。不做原文直注/learnings 融合 |
| D2 | 可见性 | 对话顶部「项目背景」折叠卡(recap 卡同款同位,只读)+ admin ai-config「项目记忆注入」开关(默认开,即时生效)。不做编辑器 |

## 3. 架构

### 3.1 数据(workbench-projects.mjs)

- `workbench_projects` 迁移加列:`projectRecap TEXT`、`historyWatermark INTEGER DEFAULT 0`(已并入摘要的 history 最大 ts)。
- `unsummarizedProjectHistory(db, projectId) → rows[]`(ts > watermark 的 history,升序;条数与内容消费共用)。

### 3.2 生成:`maybeSummarizeProject(db, projectId, llmClient)`(workbench-summarize.mjs)

- 触发:未摘要条数 **≥ 8**(PROJECT_SUMMARY_THRESHOLD)。
- 输入:`旧 projectRecap(可空) + 未摘要 history`(单条截 800 字,distill 同款);system prompt 要求保留「已做决定/关键事实/未决问题」,滚动合并非拼接。
- 成功才落库:`{ projectRecap: 新摘要, historyWatermark: 本批最大 ts }`,`touch:false`;失败/空产出静默返回 false。
- 挂载:append 路由现有 `maybeSummarize(...).catch(() => {})` 旁 fire `maybeSummarizeProject(db, conv.projectId, llmClient).catch(() => {})`。

### 3.3 注入(workbench-agent.mjs)

- run/resume 两处 `refreshSystem`:`const pm = getProject(db, conv.projectId)?.projectRecap` → `conv.system + (启用 && pm ? '\n\n[Project memory — 之前对话的决策摘要]\n' + pm : '') + refContext`。
- **开关**:ai-config(workbench-ai-config.mjs)加 `projectMemory: true` 默认;workbench-agent **每次 run 现读**(与 disabledTools 同族,即时生效);GET /api/workbench/ai-config 出参带出。

### 3.4 可见性(前端)

- `GET /:id` 响应加 `projectRecap`(项目当前摘要);WorkbenchChat 顶部 recap details 卡旁**并列**「项目背景」卡(同款 UI,`v-if="projectRecap"`,展开看全文;AI 记得什么完全透明)。
- admin `AiBehaviorConfig.vue` 加开关行(读写既有 ai-config 端点族);zh/en 键。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| 摘要 LLM 失败/空 | 不动库,静默;下次 append 重试 |
| 开关关 | refreshSystem 完全不拼;卡片仍显示存量(只是不注入) |
| 项目删除 | 级联既有逻辑;history/摘要随项目行消失 |
| 摘要期间新 history | watermark 只记已摘要批次,下轮补 |

## 5. 测试

- 领域:unsummarizedProjectHistory 过滤;maybeSummarizeProject(不足阈值不动/触发滚动合并含旧摘要/失败不动库/水位推进/空历史)
- workbench-agent:refreshSystem 注入断言(拼入格式/开关关不拼/无摘要不拼)
- 路由:GET /:id 带 projectRecap;ai-config 读写 projectMemory roundtrip;append 路由 fire 调用断言
- 前端:项目背景卡渲染/无摘要不渲染;admin 开关测试

## 6. 开放问题

无。
