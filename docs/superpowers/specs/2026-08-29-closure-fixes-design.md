# 收官修复包:余量口径/摘要时机/slash×编辑态 设计

- 日期:2026-08-29
- 状态:回顾审计定案(A1/A2/A3 应修,A4 记档),待实施
- 范围:九特性回顾审计的跨特性瑕疵修复

## 1. 审计发现 → 决策

| # | 发现 | 决策 |
|---|------|------|
| A1 | `contextInfo` 只算 system+history,漏项目记忆段(≤2000字恒注入)与 @refs 注入(动态)——余量条系统性低估,违背「两线合不说谎」初衷 | **修**:口径补全 |
| A2 | 项目摘要 fire 在 append 路由(发送时刻)——「聊完最后一轮就开新对话」场景下最后一轮决策不在摘要,产品承诺打折 | **修**:done 后补 fire(append 处保留兜底;水位幂等不双跑) |
| A3 | `selectSlashItem` 不清 editing——编辑态选 /compact 输入被清但提示条挂着;选剧本顶掉编辑回填内容且语义困惑 | **修**:面板选中先 `cancelEdit()`(恢复草稿)再执行选中项 |
| A4 | edit 截断 messages 不截 history——项目摘要可能记被编辑掉的问题版本 | **记档**:与 conv.recap 同取舍(「当时聊过」),不改 |

## 2. 实现

### 2.1 A1:`contextInfo` 口径补全(routes/workbench-conversations.mjs)

```js
function contextInfo(conv) {
  const history = buildHistory(db, conv)
  const pmChars = (getProject(db, conv.projectId)?.projectRecap || '').length   // 项目记忆恒注入段
  let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
  const refChars = Array.isArray(refs) ? refs.length * 2048 : 0                 // @refs 估算:每资源 2KB(命名常量 REF_EST_CHARS)
  const chars = conv.system.length + pmChars + refChars + history.reduce((n, m) => n + JSON.stringify(m).length, 0)
  ...其余不变
}
```

注释注明:refs 为估算(动态拉取体积不落库,常数近似;pm 为精确值)。

### 2.2 A2:done 后 fire(workbench-agent.mjs)

- import `maybeSummarizeProject`;run/resume 两处 `finalizeConvEmit(convId, out)` **之后**加:
  `maybeSummarizeProject(db, conv.projectId, llmClient).catch(() => {}) // 项目记忆:done 后补 fire(A2;append 处保留兜底,水位幂等)`
- 放 finalize 之后:不阻塞 SSE done 事件;水位守卫保证与 append 处 fire 不双跑(后到者见 pending<阈值即 no-op)。

### 2.3 A3:slash 选中先退编辑态(WorkbenchChat.vue `selectSlashItem`)

函数开头加:

```js
  if (editing.value) cancelEdit()   // A3:编辑态让位——先还原暂存草稿,再执行选中项(剧本替换/compact 清输入)
```

(cancelEdit 恢复 draftBackup 后,后续 `input.value = ...` 自然覆盖为选中项内容——用户看到:banner 消失、输入框变为剧本正文/被清。)

## 3. 测试

- A1:workbench-conversations.test.mjs——项目行置 projectRecap 4000 字 + conv.references 三条 → GET /:id 的 estTokens 比空项目/无 refs 时大出约 (4000+3×2048)/2 tokens(断言区间,容 i18n/JSON 包装噪声)。
- A2:workbench-agent.test.mjs——预置 7 条 history + run done(追加 user+assistant=9 ≥8)→ 短轮询 DB(≤2s)断言 projectRecap 非空;llmClient.chat mock 返回固定摘要。
- A3:WorkbenchChat.test.js——进入编辑态(banner 在)→ 输 `/compact` 选中 → banner 消失 + modal 开;剧本路径同理断言输入=剧本正文。

## 4. 错误处理

A2 的 fire 失败静默(既有语义);A1 的 getProject/JSON.parse 防御已含;A3 cancelEdit 为纯前端状态操作无失败路径。

## 5. 开放问题

无。
