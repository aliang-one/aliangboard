# Workbench Chat — Cursor-style 改造设计

> 日期：2026-08-10｜分支：`feat/workbench-v2-ui`｜前置：P3 @-mention（已合）+ @-mention 搜索端到端修复（f4db336 / 4582aca）
>
> 把 WorkbenchChat 从「半 SMS 气泡」升级为 Cursor/Composer 式全宽对话：消息全宽左对齐、角色标记 + 标签 + 用户底色、agent 答案 markdown 渲染、工具调用紧凑卡片、输入框自动增高。

## 1. 目标 / 背景

当前 `WorkbenchChat.vue`（437 行）的渲染：用户消息仍是右对齐气泡（`max-w-[80%]` + `bg-primary-container` + 圆角），agent 答案是带边框卡片，工具调用是可折叠 `<details>`「N tool calls」。读起来「半 SMS 气泡、半 Cursor」。

本次做一次**整体 Cursor 风格改造**（holistic pass）：消息排版、工具卡片、输入框、密度/排版一并打磨成一个连贯的 Cursor/Composer 观感。

## 2. 非目标（明确排除）

- agent 系统提示词 / 行为 / 后端逻辑不变（只改前端渲染与交互）。
- 不改审批 Modal 的内容语义（仅随排版微调样式）。
- 不改其它工作台视图（WorkbenchShell / WorkbenchDetail 的 Agent|Edit 双模式骨架不变；只动 WorkbenchChat 及其拆出的子组件）。
- 不引入 markdown 之外的运行时依赖（`marked` + `dompurify` 是本次仅有的两个新依赖，见 §6）。

## 3. 已锁定决策（brainstorming 结论）

| 维度 | 决策 |
|---|---|
| 用户/agent 区分 | **标记 + 标签 + 用户底色**：每轮 `● You` / `◆ Agent` + 右侧 meta；用户轮加一层极淡底色带，agent 轮底色留空 |
| 消息排版 | **全宽左对齐**，去掉右对齐气泡与 `max-w-[80%]`；轮间细分隔线 + 更紧的纵向 padding |
| Markdown 渲染 | agent 终答 **full markdown**（标题/粗斜体/列表/行内代码/链接/围栏代码块），用 **`marked` + `DOMPurify`** |
| 代码高亮 | 围栏代码块复用现有 **prismjs**（与 `CodeViewer` 一致） |
| 工具调用 | **紧凑卡片（chips）**：每次调用一颗 chip（`▶ name ✓` / `✗ denied`），点开就地展开结果，取代 `<details>` |
| 输入框 | textarea **按内容自动增高**（1 → ~8 行封顶），保留 @-mention 下拉与 ref chips，顶部状态栏瘦身 |

## 4. 架构 / 组件

把 `WorkbenchChat.vue` 拆成「编排者 + 两个展示子组件 + 一个纯函数」，降低单文件复杂度（437 行会在改造中继续增长）。拆分遵循「单一职责、清晰接口、可独立理解」。

### 4.1 `src/logic/markdown.js`（纯函数，新）

```js
// 入口：md 字符串 → 已消毒、已高亮的 HTML 字符串
export function renderMarkdown(md)
// 内部：marked.parse(md, { renderer }) → 代码块走 Prism.highlight → DOMPurify.sanitize(html)
```

- **职责**：把 LLM 终答 markdown 转成**安全** HTML（`conv.content` 是模型生成、不可信 → 必须消毒防 XSS）。
- **marked 代码块路由**：用 marked 的自定义 `renderer.code(code, lang)` 调 `Prism.highlight(code, Prism.languages[lang] || Prism.languages.plain, lang)`，产出带 `token` span 的 HTML；未识别语言降级为纯文本转义。
- **DOMPurify 配置**：默认即保留 `class`（prism 的 `token`/`language-*` class 不被剥离）；显式 `ADD_ATTR` 不需要。禁止任何 `<script>`/`<iframe>`/事件属性（默认行为）。
- **消费**：`ChatTurn` 对 agent 终答 `v-html="renderMarkdown(turn.content)"`；其余状态（thinking/error/trace 结果里的 JSON）仍走 `<pre>` 等价/`whitespace-pre-wrap`，不进 markdown。
- **依赖**：`marked`、`dompurify`、`prismjs`（已有）。版本/API 以实现时 `npm view` 为准（marked 跨版本 renderer 签名有差异，实现时核对）。
- **测试**：vitest（用了依赖，不进零依赖运行器）。断言：`<script>` 被剥离、`**b**` → `<strong>`、围栏代码产出 `<code class="language-*">`、空串/`null` 安全返回空。

### 4.2 `src/components/workbench/ChatTurn.vue`（新）

- **props**：`turn`（单轮对象：`role` / `content` / `status` / `trace` / `steps` / `refs` / `error` / `denied` / `truncated`）、`projectName`（可选）。
- **职责**：渲染**一行**对话——左侧角色标记（`●`/`◆` Material Symbols）+ 标签（`You`/`Agent`）+ 右侧 meta（时间/`N steps`/`truncated`），下方是内容。
- **分支**：
  - `role === 'user'`：行加 `bg-primary/[0.04]` 极淡底色带（左右贯通），内容 = 纯文本（`whitespace-pre-wrap`）+ 内联 ref chips。
  - `role === 'assistant'`：底色留空。按 `status` 分支：
    - `thinking`（且无 trace）→ 极简「Thinking…」行（保留三点动画）。
    - `pending_approval` → 审批等待条（动作仍在 `WorkbenchChat` 的 Modal）。
    - `error` → 错误条。
    - `done` → `v-html="renderMarkdown(turn.content)"`。
    - 有 `trace` → 渲染 `<ToolTrace :trace="turn.trace" />`（放在答案上方）。
- **不发事件**（纯展示；审批/重试由父组件统一处理）。

### 4.3 `src/components/workbench/ToolTrace.vue`（新）

- **props**：`trace`（事件数组：`{ type: 'tool'|'denied', name, result }`）。
- **职责**：渲染一行**紧凑 chips**，每个 tool/denied 事件一颗：
  - chip：图标 + `name`（mono）+ 状态记号（`✓` done / `✗` denied / `▶` running-痕迹）。
  - 点击 chip → 就地展开 `result`（`<pre>` 等价，复用现有 `fmtResult` 风格，截断 + 滚动）；再点收起。
- **本地状态**：`expanded = ref(null)`（当前展开的 chip 索引）。
- 取代 `WorkbenchChat` 现有的 `<details>「N tool calls」`块。

### 4.4 `WorkbenchChat.vue`（编排者，瘦身）

- 保留：轮询/对话状态、`send`、审批（Modal）、@-mention 全套逻辑（watch + doSearch + refs）、`<Modal>` 审批弹窗、顶部状态栏、输入区。
- 改动：
  - 消息循环 `v-for="turn in turns"` 渲染 `<ChatTurn :turn="turn" />`，删掉模板里的 user/assistant 分支大段。
  - 删掉内联 tool trace `<details>` 块（移入 `ToolTrace`）。
  - 移除 `fmtResult` / `toolCount`（迁入 `ToolTrace`）。
  - 输入 textarea：`rows="1"` + 监听 input 自动调 `rows`（或用 `field-sizing: content`/scrollHeight），封顶 `max-h-32`（已有）。
  - 顶部状态栏与错误 banner 样式微调（更细）。
  - 预计净减 ~80–120 行模板，逻辑不变。

## 5. 数据流

不变。仍是：`send` → `POST /conversations` → `startPolling` → 每 2s `GET /conversations/:id` → 更新 `turns[i].trace`/`status`/`content` → 响应式重渲染。`paused` → Modal 审批 → `approve/deny` → 续轮询。改造只动**渲染层**（`turns` → `<ChatTurn>` → markdown/trace/composer）。

## 6. 依赖（+2 运行时，登记 CLAUDE.md 例外表）

| 依赖 | 类别 | 引入原因 | 裁决来源 |
|---|---|---|---|
| `marked` | dependencies | workbench chat agent 终答 markdown → HTML 解析（标准、~30KB） | 本设计（Cursor-style chat），需 /plan-eng-review 同等审视 |
| `dompurify` | dependencies | 消毒 marked 产出的 HTML（`conv.content` 是 LLM 生成、走 `v-html`，必须防 XSS） | 本设计（安全前置） |

> 与既有例外（`@tanstack/vue-query`、`vitest` 等）同等登记。安装前在 CLAUDE.md「依赖政策」表追加这两行 + rationale。`prismjs` 已是依赖，不新增。

## 7. i18n

- 新增键（`workbench.chat.*`，zh/en 对齐）：
  - `roleYou`：`You` / `你`
  - `roleAgent`：`Agent` / `Agent`
  - 工具 chip 状态用图标 `✓/✗`，不需文案。
  - `toolDenied`：`已拒绝` / `denied` —— 新增键，替换 `WorkbenchChat.vue:326` 现有硬编码 `rejected`。
- 门禁：`npm run i18n:check` 必须绿（残存中文 0）。**注意 `@` 转义**：本次新键值若含字面 `@`（如示例），按仓库约定写 `{'@'}`，否则运行时 `Invalid linked format` 崩溃（见 memory `i18n-at-sign-escaping`）。当前计划的新键不含 `@`，但实现时若有 `@-mention` 类文案需注意。

## 8. 约束遵循

- 零新增运行时依赖（仅 `marked` + `dompurify` 两个已登记例外）。
- 复用 M3 token（`surface-container-*` / `on-surface*` / `primary*`）、Material Symbols、JetBrains Mono、prismjs / CodeViewer 配色。
- 所有新文案经 `$t()`；`.vue` 由 `npm run build` 覆盖、`.js`/`.mjs` 由 `npm run typecheck` 覆盖。
- 提交前 `npm test && npm run typecheck && npm run build` 全绿。

## 9. 测试

- `src/logic/markdown.js` → vitest 单测（XSS 剥离、基础 markdown、代码高亮 class、空值安全）。
- 纯排版/交互（ChatTurn/ToolTrace 的展开）以**浏览器手测**为主（沿用本次会话的 playwright 流程：登录 → workbench → 项目 → 验证排版/工具 chip/markdown 渲染）。
- 不为 markdown util 走零依赖运行器（它依赖 marked/dompurify）。

## 10. 风险 / 待实现时确认

- **marked 跨版本 renderer 签名**：marked v5+ 与旧版 `renderer.code(code, infostring)` 签名不同；实现时按安装版本写自定义 renderer，并核对 prism 高亮在 DOMPurify 消毒后 token span 是否完整保留（预期保留，因 `class` 默认放行）。
- **用户底色色阶**：`bg-primary/[0.04]` 是建议值，实装时在浏览器里对照 Cursor 调到「能扫读但不抢眼」；可降级为 `bg-surface-container-low`。
- **ChatTurn 拆分粒度**：若 thinking/approval/error 分支令 ChatTurn 仍偏重，可再把「agent 状态条」拆出；但优先保持 3 文件（markdown + ChatTurn + ToolTrace），不过度拆。
