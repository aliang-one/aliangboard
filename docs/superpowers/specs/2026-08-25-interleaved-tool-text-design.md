# 回合内「文本↔工具调用」交错渲染 + 审批链活体回归网 设计

日期:2026-08-25
状态:已批准(用户确认两轮:交错形态「文本 换行 工具 换行 文本」;审批排查并入规划)

## 背景与动机

工具调用目前以两种聚合形态展示(chips 总览 + 独立时间线块),看不出**模型文本与工具调用的先后
交织**——用户要 Cursor/Claude.ai 式交错:模型先说一段 → 调工具 → 再说一段 → 最终回答。
数据障碍:①服务端每轮落库的 message.trace 过滤掉了 assistant 事件(中间文本不入);②前端流式
把所有轮文本拼成一坨 content(conv-stream 无轮间清零)。

另:用户报「审批确认后对话从页面消失」——七路径实测当前代码无复现(详见排查记录),判定为
旧构建历史 bug 或未构造变体;本 spec 顺带固化审批链活体回归网防复发。

## 设计

### 1. 服务端:中间文本入每轮 trace(workbench-agent.mjs)

turnTrace 累积时纳入 assistant 事件并**瘦身**:`{ type:'assistant', content: <message.content||''>, ts }`
(丢弃 tool_calls/reasoning——终答 content 恒等于末个 assistant 事件的 content,渲染去重靠它)。
conv.trace(appendTrace 全事件)不动。

### 2. 流式归约:轮间清零(conv-stream.js)

step 处理 assistant 事件:push 瘦身事件入 trace + **清空 state.content/reasoning**——已完成轮
文本活在 trace,当前轮流式继续累积,零重复、零拼接。(兼容 SSE 全量事件与本地瘦身两种形状:
content 取 `s.message?.content ?? s.content`。)

### 3. 前端交错渲染(ChatTurn + 新 ToolRow)

- 判定:turn.trace 含 assistant 事件 → 交错模式;否则回退现布局(chips+ToolTimeline+终答)
- 交错模式:按 trace 顺序渲染——非空 assistant 文本 → 文本块(纯文本排版);tool/denied/
  tool_start → 工具行(新 `ToolRow.vue`:时刻+名称+首行预览+点击 ToolCallModal,自持 modal);
  thinking 态时当前轮流式文本(带光标)即流的末段
- done 态终答=末个非空 assistant 文本块,turn.content 不再单独渲染(防重复);防御:交错模式下
  trace 无任何非空文本而 content 非空 → 整体回退旧布局
- chips 总览保留;独立 ToolTimeline 仅回退布局使用
- 存量对话(无 assistant 事件的 trace)自动走回退,不受影响

### 4. 审批链活体回归网(server/wb-approval-roundtrip.test.mjs)

mock LLM 首轮发需审批工具(wb_exec)→ 对话 paused → API approve → 续跑 → 终答 done。
断言:消息级 trace 含 tool+assistant(瘦身)事件、GET 回读对话完整、状态迁移 paused→running→done。
(mock K8s 提供 /exec 端点;harness 复用 wb-podlogs-roundtrip 模式。)

## 测试

- conv-stream 单测:assistant step → trace 得瘦身事件 + content/reasoning 清零;tool 事件不受影响
- ChatTurn:交错渲染(文本↔行顺序、终答不重复、thinking 末段流式)/ 无 assistant 事件回退
- ToolRow 单测:行渲染/预览/点击开 modal
- 活体:approval-roundtrip(见 §4)+ 现有 roundtrip 回归(message.trace 断言补 assistant 存在)
- 门禁:npm test / typecheck / i18n:check

## 非目标

- 中间文本的 markdown 渲染(短句纯文本;终答仍走 marked)
- 存量对话 assistant 文本回补迁移
- 交错模式下隐藏 chips 总览(保留)
