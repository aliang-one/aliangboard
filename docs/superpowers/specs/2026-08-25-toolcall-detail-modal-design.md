# 工具调用详情 Modal 设计

日期:2026-08-25
状态:已批准(用户确认:入口仅对话内 chips;点击 chip 弹 modal 替代就地展开;方案 A)

## 背景与动机

AI 对话的工具调用记录展示过于粗略:ToolTrace chips 点击只**就地展开**一份智能摘要(fmtResult 提
取的关键字段),看不到**调用参数(args)**,也看不到**完整原始结果**。用户需要:点击某个工具
→ modal 里看该次调用的详细参数与完整结果。

系统性检查结论(2026-08-25,定本设计的边界):
- 完整 args/result 只存在于对话 trace(conv.trace / message.trace)——modal 的数据源。
- audit_log 从设计上就不存完整 payload(截断摘要),记录页审计行撑不起详情 → 入口仅对话内。
- 事件结构 `{type:'tool'|'denied', name, args, result}` **无时间戳** → 顺手补 ts。

## 设计

### 1. 格式化逻辑抽共享模块(消重复)

`src/utils/toolResultFormat.js`:从 ToolTrace.vue 抽出 `fmtResult(ev)` 及其依赖的
fmtDescribe/fmtList/fmtRollout/fmtExec/fmtPodFile/fmtTop(纯函数,零组件依赖)。
ToolTrace 与新 modal 共用;行为零变更(原样搬迁)。

### 2. 新组件 `src/components/workbench/ToolCallModal.vue`

- props:`event`(单个 trace 事件)、`modelValue`(Modal v-model)
- 复用 `common/Modal.vue` 壳(与仓库弹窗惯例一致)
- 结构三段:
  - **头部**:状态色点(tool=绿/denied=黄/tool_start=蓝转圈)+ 工具名(font-mono)+ 时间戳
    (`ts` 有则格式化,无则显示 `—`;i18n 键)
  - **参数**:args → JSON code 块(`JSON.stringify(args, null, 2)`;空 args 显示「无参数」)
  - **结果**:两 tab ——「摘要」(fmtResult(ev),string 结果原样/对象走格式化)与「原始」
    (`JSON.stringify(result, null, 2)`,string 结果显示原文;>64KB 截断 + 提示);
    右上复制按钮(navigator.clipboard,复制当前 tab 内容,成功/失败 toast 复用现有 notify)
- 事件分型:
  - `denied`:参数照常 + 结果区显示「用户拒绝了该操作」提示
  - `tool_start`:结果区显示「执行中…」(终态对话理论上不残留,防御)
  - `assistant` 等其他类型:不进入 modal(ToolTrace 已滤)

### 3. 事件加时间戳(写入端)

`server/agent.mjs` 三处 `onStep?.(...)` 调用点(tool/denied/tool_start/assistant)统一改为
`onStep?.({ ..., ts: Date.now() })`。新事件带时刻;存量事件无 ts → modal 显示 `—`,不迁移。

### 4. ToolTrace.vue 改造

- chips 点击行为:就地展开( expanded/toggle)**移除**,改为打开 ToolCallModal
  (ToolTrace 自持 modal 状态,selectedEvent ref;内聚,不经 ChatTurn/WorkbenchChat 透传)
- fmtResult 系列改从共享模块 import;其余(折叠阈值/摘要行/滤 assistant)不变

### 5. i18n(zh/en 对齐)

新键 `workbench.toolCall.*`:title(工具调用详情)/args(参数)/result(结果)/summaryTab(摘要)/
rawTab(原始)/noArgs(无参数)/denied(用户拒绝了该操作)/running(执行中…)/noTs(—)/
copied(已复制)/copyFailed(复制失败)/truncated(超 64KB 已截断)。

### 6. 测试

- `src/utils/__tests__/toolResultFormat.test.js`:搬迁回归(fmtResult 各分型输出与 ToolTrace
  时代一致——搬迁前先固化 2-3 个断言)
- `ToolCallModal.test.js`(vitest + mount + 真 i18n):参数渲染/摘要-原始切换/复制调用
  (mock clipboard)/denied 提示/无 ts 显示 —
- `ToolTrace.test.js` 若存在则回归;无则新增:点击 chip 打开 modal(不再就地展开)
- 活体(wb-podlogs-roundtrip.test.mjs 追加断言):事件含 ts 字段
- 门禁:npm test / typecheck / i18n:check

## 错误处理

| 场景 | 行为 |
|---|---|
| args 为空/undefined | 「无参数」占位 |
| result 为 string(如错误文案) | 原始 tab 显示原文,摘要 tab 同 |
| result 超大(>64KB) | 截断 + 提示(防卡死渲染) |
| navigator.clipboard 不可用 | toast 失败提示(手选复制) |
| 存量事件无 ts | 显示 — |

## 非目标

- 记录页/AuditTrail 审计行点击详情(审计无完整 payload,已裁决不做)
- trace 事件时间戳的历史数据回填迁移
- modal 内重放/导出工具调用
