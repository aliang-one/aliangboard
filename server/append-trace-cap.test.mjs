// appendTrace 滚动上限(TDD):长对话 conv.trace 无界增长(生产实测 328KB),GET /:id 与
// 2s 轮询载荷持续放大。契约(2026-09-06 对抗审查修订):
//   ①超 256KB 只丢【旧轮】事件(ts ≤ lastMsgTs,即最后一条消息行之前)——当前轮事件
//     (ts > lastMsgTs)绝不丢:resume 路径的消息级 trace 与降级轮询/SSE 重连 live 视图
//     都从 conv.trace 按 ts>lastMsgTs 切片派生,丢当前轮头部=持久击穿且不可恢复;
//   ②当前轮超限时接受软上限(单事件体积已被 clampTraceStep 32KB 钳制,done 落库后
//     append/regenerate/edit 均复位 trace——单轮大体积只在轮内存在);
//   ③收缩单遍完成(前缀和定位丢弃下标,一次终序列化):存量超限行(数千事件)首 append
//     不得秒级停摆(旧逐条丢弃×全量重序列化实测 2-4s,单进程不变式下全进程冻结);
//   ④未超限路径零变化。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, createConversation, updateConversation, getConversation, appendTrace } from './workbench-projects.mjs'

const CAP = 256 * 1024

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  return db
}

function makeConv(db) {
  const p = createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
  return createConversation(db, { projectId: p.id, userMessage: 'hi' })
}

// 锚一条 user 消息行(createdAt=ts)——之后 ts 更大的事件属「当前轮」(currentTurnTrace 口径)
function anchorMessage(db, convId, createdAt) {
  db.prepare("INSERT INTO workbench_messages (id,conversationId,role,content,seq,createdAt) VALUES (?,?,?,?,?,?)")
    .run(`m-${createdAt}`, convId, 'user', 'anchor', 1, createdAt)
}

test('appendTrace 超限只丢旧轮:旧轮头部丢弃、当前轮与尾部保留', () => {
  const db = makeDb()
  const conv = makeConv(db)
  const big = 'x'.repeat(100 * 1024)
  // 锚点 ts=2000:e1..e3 属旧轮(可丢),e4 属当前轮(绝不丢)
  anchorMessage(db, conv.id, 2000)
  const e1 = { type: 'tool_end', ts: 1001, result: big }
  const e2 = { type: 'tool_end', ts: 1002, result: big }
  const e3 = { type: 'tool_end', ts: 1003, result: big }
  updateConversation(db, conv.id, { trace: JSON.stringify([e1, e2, e3]) })
  const e4 = { type: 'assistant', ts: 3004, content: 'final' }
  const returned = appendTrace(db, conv.id, e4)
  const stored = JSON.parse(getConversation(db, conv.id).trace)
  assert.ok(Buffer.byteLength(getConversation(db, conv.id).trace) <= CAP,
    `trace bytes ${Buffer.byteLength(getConversation(db, conv.id).trace)} > ${CAP}`)
  assert.ok(!stored.some(e => e.ts === e1.ts), '旧轮最旧事件 e1 应被丢弃(腾出 100KB)')
  assert.deepEqual(stored.map(e => e.ts), [e2.ts, e3.ts, e4.ts], '幸存顺序完整')
  assert.deepEqual(stored[stored.length - 1], e4, '本次 append 的事件在尾部')
  assert.deepEqual(returned, stored, '返回值与落库一致')
})

test('appendTrace 当前轮事件绝不丢:单轮超限走软上限(防击穿 resume 消息级 trace)', () => {
  const db = makeDb()
  const conv = makeConv(db)
  anchorMessage(db, conv.id, 1000) // 当前轮 = ts>1000 的全部事件
  const big = 'y'.repeat(30 * 1024)
  const events = []
  for (let i = 0; i < 9; i++) {
    events.push({ type: 'tool_end', ts: 2000 + i, result: big })
  }
  updateConversation(db, conv.id, { trace: JSON.stringify(events.slice(0, 8)) })
  // 第 9 条 append 后 ≈270KB > cap——但全部属当前轮,一条都不许丢
  appendTrace(db, conv.id, events[8])
  const stored = JSON.parse(getConversation(db, conv.id).trace)
  assert.equal(stored.length, 9, '当前轮 9/9 全保留(软超限)')
  assert.ok(Buffer.byteLength(getConversation(db, conv.id).trace) > CAP, '当前轮超限被接受(软上限)')
  assert.deepEqual(stored.map(e => e.ts), events.map(e => e.ts), '顺序完整')
})

test('appendTrace 混合场景:丢到 ≤cap 即止(不多丢),当前轮一条不动', () => {
  const db = makeDb()
  const conv = makeConv(db)
  anchorMessage(db, conv.id, 500)
  const big = 'z'.repeat(60 * 1024)
  // 5 条旧轮 60KB(300KB)+ 当前轮 60KB+小 assistant ≈ 362KB:丢 2 条旧轮(120KB)即 ≤cap,应停(不多丢)
  const old = [1, 2, 3, 4, 5].map(i => ({ type: 'tool_end', ts: 100 + i, result: big }))
  const cur = [{ type: 'tool_end', ts: 900, result: big }, { type: 'assistant', ts: 901, content: 'ans' }]
  updateConversation(db, conv.id, { trace: JSON.stringify([...old, cur[0]]) })
  appendTrace(db, conv.id, cur[1])
  const stored = JSON.parse(getConversation(db, conv.id).trace)
  assert.ok(Buffer.byteLength(getConversation(db, conv.id).trace) <= CAP, '收缩后 ≤cap')
  assert.deepEqual(stored.map(e => e.ts), [103, 104, 105, 900, 901], '恰丢最旧 2 条旧轮即止,当前轮 2/2 原样')
})

test('appendTrace 收缩单遍完成:存量数千事件超限行首 append 不秒级停摆', () => {
  const db = makeDb()
  const conv = makeConv(db)
  anchorMessage(db, conv.id, 4000) // 锚点在存量之后:3000 条全属旧轮(可丢),append 事件属当前轮
  // 3000 条 ~140B 旧轮小事件(≈420KB,模拟无上限时代的存量行)
  const old = Array.from({ length: 3000 }, (_, i) => ({ type: 'tool_end', ts: 1 + i, result: `r-${i}-${'p'.repeat(110)}` }))
  updateConversation(db, conv.id, { trace: JSON.stringify(old) })
  const t0 = process.hrtime.bigint()
  appendTrace(db, conv.id, { type: 'assistant', ts: 2000, content: 'final' })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(ms < 1000, `存量收缩耗时 ${ms.toFixed(1)}ms 应 <1000ms(旧逐条实现实测 2-4s)`)
  const stored = JSON.parse(getConversation(db, conv.id).trace)
  assert.ok(Buffer.byteLength(getConversation(db, conv.id).trace) <= CAP, '收缩后 ≤cap')
  assert.equal(stored[stored.length - 1].ts, 2000, 'append 事件在尾')
})

test('appendTrace 未超限路径零变化:小 trace append 后内容 = 原+新(精确 deepEqual)', () => {
  const db = makeDb()
  const conv = makeConv(db)
  const e1 = { type: 'tool_end', ts: 1, result: { ok: true } }
  const e2 = { type: 'tool_end', ts: 2, result: 'small' }
  updateConversation(db, conv.id, { trace: JSON.stringify([e1, e2]) })
  const e3 = { type: 'assistant', ts: 3, content: 'done' }
  const returned = appendTrace(db, conv.id, e3)
  assert.deepEqual(JSON.parse(getConversation(db, conv.id).trace), [e1, e2, e3])
  assert.deepEqual(returned, [e1, e2, e3])
})
