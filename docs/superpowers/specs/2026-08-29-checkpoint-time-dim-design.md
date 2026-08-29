# 检查点时间维度精细化 设计

- 日期:2026-08-29
- 状态:已评审(brainstorming 定案:时间维度精细化;流式行架构记档延后),待实施
- 范围:WorkbenchChat 中途刷新的当前轮内容滞后

## 1. 背景与决策

R1/R3 后刷新中途已可见过往轮(交错 trace)与当前轮 reasoning/content(200 字检查点)。残余缺口=当前轮最多滞后 200 字。完整流式行(workbench_messages status 列+7 处读者教育)风险高收益边际,**记档延后**(触发条件:出现检查点无法覆盖的需求,如多端实时同步);本设计以 ~10 行把滞后压到 500ms。

| # | 决策 |
|---|------|
| D1 | trackPartial 触发改「≥200 字 **或** 距上次落库 >500ms」;onDelta/onReasoning 共享 lastCkAt;resetRound 同步刷新 |
| D2 | 写频上界 2 次/秒(delta 到达才可能触发,静默零写) |

## 2. 实现(server/workbench-agent.mjs trackPartial)

```js
let lastCkAt = Date.now()
const shouldCk = len => len >= 200 || Date.now() - lastCkAt > 500   // 阈值以常量提取
// onDelta: if (shouldCk(partial.length - ckAt)) { ckAt = partial.length; checkpoint() }
// onReasoning 同款;rCkAt 与 ckAt 分别记字位,但 lastCkAt/checkpoint 共享
// resetRound: 清零后 checkpoint() 并 lastCkAt = Date.now()
// checkpoint() 内部统一 lastCkAt = Date.now()
```

(实现者注:checkpoint() 内刷 lastCkAt 最收敛——两回调的守卫只比较。)

## 3. 测试(server/workbench-agent.test.mjs)

- 时间维度:两条 delta 各 100 字(不足 200),间隔真实 `await new Promise(r => setTimeout(r, 600))` → 第二条后 DB conv.content 已含第二条内容
- 阈值守卫仍在:flush 后紧接着一条 100 字 delta(<500ms 且 <200 字增量)→ DB 不变

## 4. 错误处理

无新增路径(checkpoint 既有语义不变,只是触发更频繁);500ms 常量提取命名(`CK_TIME_MS`)。

## 5. 开放问题

无。
