# AI 对话 compact + 上下文余量 设计

- 日期:2026-08-28
- 状态:已评审(brainstorming 四问四答定案),待实施
- 范围:workbench AI 对话上下文管理(压缩 + 余量透明化)

## 1. 背景与问题

现状(2026-08-28 审计):

| 机制 | 现状 | 缺陷 |
|------|------|------|
| 自动摘要(recap) | 超 12 轮未摘要时,append 后异步把旧消息 LLM 摘要成 recap;上下文 = recap + 未摘要消息全文 | 不可控、不可见 |
| 硬裁剪(trimMessages) | 固定 60K 字符预算,超线从最旧消息直接丢弃(tool_call 悬空清理) | 无摘要静默失忆;60K 字符 ≈ 3 万 token ≈ 200K 窗口的 15%,远低于现代模型容量 |
| 手动 compact | 无 | — |
| 余量展示 | 无 | 黑盒 |

## 2. 目标 / 非目标

**目标**
1. 余量透明:输入框上方常驻余量条(估算 token / 模型窗口),阈值变色
2. 手动 compact:全量重摘要 + 可选自定义指令(类 Claude Code `/compact`)
3. 两线合一:硬裁剪预算跟随模型窗口派生,不再固定 60K

**非目标(YAGNI,明确不做)**
- 自动 compact(接近窗口自动重摘要)——用户裁决:手动可控优先,以后可叠加
- maybeSummarize 调整(12 轮/保 8 条全文)——轮数驱动的轻量折叠,与窗口余量无关,保持不动
- token 精确计数(走 tokenizer)——估算足够,UI 标注「估算」
- 每模型窗口 admin 覆盖字段——内置表 + 默认 200K 已覆盖;表条目保守取家族下限

## 3. 决策记录(brainstorming 定案)

| # | 决策 | 选择 |
|---|------|------|
| D1 | 余量分母口径 | 模型真实窗口;默认 200K;内置主流模型窗口表 |
| D2 | compact 语义 | 全量重摘要(含旧 recap 归零)+ 可选自定义指令;保最近 2 条消息全文 |
| D3 | 展示形态 | 输入框上方常驻细条;<70% 灰 / ≥70% 黄 / ≥90% 红 + 「压缩」快捷钮;点击展开详情 |
| D4 | 硬裁剪线 | `budgetChars = windowTokens × 0.7 × 2`(窗口 70% 折算字符);60K 常量退役 |

## 4. 架构

### 4.1 模型窗口表:`server/model-context.mjs`(新,纯函数)

```js
// 家族 substring 匹配 → 窗口 tokens;未命中默认 200_000
export function contextWindowFor(modelName)  // 'gpt-4o' → 128000;'claude-xxx' → 200000;未知 → 200000
export function estTokens(chars)             // Math.ceil(chars / 2)——中文≈1字/token、英文≈4字符/token 折中
export function trimBudgetChars(windowTokens)// windowTokens * 0.7 * 2
```

内置表(保守取家族下限;条目错漏只影响展示与预算派生,修正表即修复;**精确条目以 model-context.mjs 为单一事实源**,下表为家族示意):
`gpt-4o/gpt-4-turbo: 128k`、`gpt-4.1/gpt-5/o系列: 200k~1M 取低值`、`claude: 200k`、`deepseek: 128k`、`qwen: 128k(qwen-long 除外不列)`、`glm: 128k`、`kimi/moonshot: 128k`、`gemini: 1M`、`doubao: 128k`。未命中 200k。

**色彩阈值与预算线的关系**(自审修正,防歧义):预算线 = 窗口 70%;黄(≥70%)= 已到预算线,下轮起将发生硬裁剪,建议压缩;红(≥90%)= 已显著超预算,硬裁剪正在丢弃历史,需立即压缩。`willTrim`(estTokens > budgetTokens)与黄线同时为真。

### 4.2 硬裁剪预算注入(agent.mjs / agent-runner / workbench-agent)

- `createAgent({ ..., budgetChars })` 新参,`trimMessages(messages, budgetChars)` 消费;缺省仍 `DEFAULT_BUDGET_CHARS`(单测兼容)
- 注入链:`runConversation/resumeConversation` 里 `getLlmConfig().model → contextWindowFor() → trimBudgetChars()` 传 `createAgentRunner`
- 60K 常量保留为缺省值语义(未注入时),生产链恒注入

### 4.3 context 用量下发(GET /:id 及变更响应)

`GET /api/workbench/conversations/:id` 响应新增字段(服务端单一计算源,前端不重复估算):

```json
"context": {
  "estTokens": 45000,      // buildHistory 装配 + system(含 @refs 注入后)总字符 × estTokens 比例
  "windowTokens": 200000,  // contextWindowFor(model)
  "budgetTokens": 140000,  // 硬裁剪预算(token 口径,= budgetChars/2)
  "recapUpTo": 6,          // summarizedUpTo——第 6 条(含)前已折叠进 recap
  "willTrim": false        // estTokens > budgetTokens(当前装配已在裁剪线上)
}
```

实现:`turnSnapshot` 旁新增 `contextInfo(conv)`(同文件,routes/workbench-conversations.mjs):调 `buildHistory(db, conv)` + refreshSystem 形状(refs 上下文长度;避免真拉集群——用 conv.references 现有 JSON 的长度近似?**否**:@refs 每轮重拉,长度动态。取 `conv.system.length + references 拉取后的实际长度`需要网络。**决策**:estTokens 只算 buildHistory 产物 + conv.system + 常数余量(refs 通常远小于正文,YAGNI;若 refs 巨大 willTrim 会保守偏小——可接受,spec 记录该近似)。)
create/append/compact 响应顺带 `context`。

### 4.4 compact 端点

`POST /api/workbench/conversations/:id/compact`,body `{ instruction?: string }`(≤200 字)

- 门禁:仅终态(`done/failed/cancelled`);`running/paused` → 400(改 messages 会破坏 resume 状态);**消息数 ≤3 → 400「对话太短,无需压缩」**(自审补:否则 summarizedUpTo=maxSeq-2≤0 时 recap 与全量消息双份进上下文,反效果)
- 语义:取全部 `workbench_messages` + 现 recap → LLM 全量重摘要(prompt 带可选 instruction)→ 成功后原子落库:
  - `recap = 新摘要;summarizedUpTo = 最大seq - 2`(保最近 2 条全文)
  - 失败(LLM 错误/未配置)→ 不动任何字段,错误返回
- 响应:`{ ok: true, recap, context }`
- 复用 `workbench-summarize.mjs` 的 LLM 摘要调用形状,新增全量变体(参数化,不复制)

### 4.5 前端(WorkbenchChat,ChatModal 自动复用)

- **余量条**(输入框上方,常驻):细进度条 + `≈45k / 200k(22%)` + 状态色(灰/黄≥70%/红≥90%);数据源 `conv.context`(pollOnce 已每次 GET /:id,存 ref 即可)
- **详情 popover**(点击):估算口径说明、recap 覆盖(「前 6 条已折叠进摘要」)、willTrim 提示
- **「压缩」按钮**:≥70% 时出现在余量条右侧;仅 idle(convStatus 终态)可用;点击 → 小 modal(可选指令 textarea + 确认)→ POST compact → 成功后 `pollOnce` 刷新(recap 卡更新、context 重算)+ toast;失败 toast 错误
- 屏上全文消息保留(compact 只折叠上下文,不改展示;顶部 recap 折叠卡已有此语义)
- i18n:zh/en 同步新增键(`workbench.chat.context.*`);余量数值非 i18n

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| LLM 未配置 | compact 400(与 create/append 一致);余量条仍显示(context 不依赖 LLM) |
| compact 摘要失败 | DB 不动;toast 错误;余量条不变 |
| running/paused compact | 400 明确文案 |
| 模型不在表内 | 默认 200k;预算/展示按 200k |
| 估算偏差 | UI 标注「估算」;provider 侧溢出表现为该轮 failed(既有错误链路) |

## 6. 测试计划

- **model-context 单测**:表匹配(各家族)/未命中默认/estTokens/trimBudgetChars 派生
- **agent 单测**:budgetChars 注入后 trimMessages 用新预算;缺省回退
- **routes 集成测**:GET /:id 带 context 字段(含 recapUpTo/willTrim 口径);compact 成功落库(recap 替换+summarizedUpTo=maxSeq-2+instruction 拼入 LLM 调用断言)/失败不动/paused 拒绝/LLM 未配置 400
- **前端测试**:三色阈值渲染;≥70% 出压缩钮;非 idle 禁用;modal 指令提交;compact 成功刷新;ChatModal 复用不另测(同组件)

## 7. 开放问题

无(brainstorming 四问全部定案;maybeSummarize 维持不动已裁决)。
