// CSO #14:@-ref 全量 JSON 注入 system 位且无上限 —— 低权者写注解即可对管理员会话做最高权限注入。
// 本任务收口:围栏声明 + 单块/总量截断(不动 system 位架构,那属于后续设计)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatRefBlock, createRefContextBudget } from './ref-context.mjs'

test('formatRefBlock:围栏头 + 16KB 截断', () => {
  const out = formatRefBlock('Pod ns1/p1', JSON.stringify({ big: 'x'.repeat(40 * 1024) }))
  assert.ok(out.includes('数据'), '围栏必须声明这是数据不是指令')
  assert.ok(out.length < 17 * 1024)
})

test('createRefContextBudget:总量 48KB 封顶', () => {
  const b = createRefContextBudget()
  assert.ok(b.take(30 * 1024))
  assert.ok(b.take(10 * 1024))
  assert.equal(b.take(10 * 1024), false)
})
