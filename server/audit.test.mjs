// T7 测试:审计链哈希 + 两阶段 + 篡改检测(内存 sqlite)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAuditSchema, writeAudit, reserveAudit, finalizeAudit, verifyChain, rowHash, GENESIS_HASH } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  return db
}
const intent = { keyId: 'k1', owner: 'alice', clusterId: 'c1', namespace: 'ns', verb: 'get', resource: 'Pod/p1', tool: 'get_pod_logs', requestSummary: 'tail=100' }

test('writeAudit: 第一条 prevHash=GENESIS;第二条 prevHash 链到上一条 hash', () => {
  const db = makeDb()
  const a = writeAudit(db, { ...intent, result: 'ok' })
  assert.equal(a.prevHash, GENESIS_HASH, '首条 prevHash = 创世')
  const b = writeAudit(db, { ...intent, result: 'denied', reason: 'policy' })
  assert.equal(b.prevHash, a.hash, '第二条 prevHash = 第一条 hash')
  assert.notEqual(a.hash, b.hash)
})

test('verifyChain: 干净链 → valid;count 正确', () => {
  const db = makeDb()
  writeAudit(db, { ...intent, result: 'ok' })
  writeAudit(db, { ...intent, result: 'ok' })
  const v = verifyChain(db)
  assert.equal(v.valid, true)
  assert.equal(v.count, 2)
})

test('verifyChain: 篡改某行核心字段(result)→ hash mismatch 被检出', () => {
  const db = makeDb()
  writeAudit(db, { ...intent, result: 'ok' })
  writeAudit(db, { ...intent, result: 'ok' })
  // 模拟篡改:直接改第 1 行的 result(不改 hash)
  db.prepare("UPDATE audit_log SET result = 'denied' WHERE seq = 1").run()
  const v = verifyChain(db)
  assert.equal(v.valid, false)
  assert.equal(v.brokenAt, 1)
  assert.match(v.reason, /hash mismatch/)
})

test('verifyChain: 删除中间行(乱序/断裂)→ prevHash mismatch 被检出', () => {
  const db = makeDb()
  writeAudit(db, { ...intent, result: 'ok' })
  writeAudit(db, { ...intent, result: 'ok' })
  writeAudit(db, { ...intent, result: 'ok' })
  db.prepare("DELETE FROM audit_log WHERE seq = 2").run() // 抽走中间
  const v = verifyChain(db)
  assert.equal(v.valid, false)
  assert.match(v.reason, /prevHash mismatch/)
})

test('两阶段 reserve/finalize: 两条独立行(started 无 result,finalized 有),都进链', () => {
  const db = makeDb()
  const r = reserveAudit(db, intent)
  assert.equal(r.seq, 1)
  const row1 = db.prepare('SELECT status, result FROM audit_log WHERE seq = 1').get()
  assert.equal(row1.status, 'started')
  assert.equal(row1.result, null)
  const f = finalizeAudit(db, intent, { result: 'ok' })
  assert.equal(f.seq, 2)
  assert.equal(f.prevHash, r.hash, 'finalized 链到 started')
  const row2 = db.prepare('SELECT status, result FROM audit_log WHERE seq = 2').get()
  assert.equal(row2.status, 'finalized')
  assert.equal(row2.result, 'ok')
  assert.equal(verifyChain(db).valid, true)
})

test('拒绝也审计: result=denied + reason 入库 + 链有效', () => {
  const db = makeDb()
  writeAudit(db, { ...intent, result: 'denied', reason: 'policy' })
  const row = db.prepare('SELECT result, reason FROM audit_log WHERE seq = 1').get()
  assert.equal(row.result, 'denied')
  assert.equal(row.reason, 'policy')
  assert.equal(verifyChain(db).valid, true)
})

test('rowHash 确定性: 相同输入(含固定 ts)→ 相同 hash;不同 prevHash → 不同', () => {
  const row = { ts: 1234567890, status: 'finalized', keyId: 'k1', owner: 'alice', clusterId: 'c1', namespace: 'ns', verb: 'get', resource: 'Pod/p1', tool: 'get_pod_logs', result: 'ok', reason: null, requestSummary: 's' }
  assert.equal(rowHash(GENESIS_HASH, row), rowHash(GENESIS_HASH, row), '相同输入 → 相同 hash')
  assert.notEqual(rowHash(GENESIS_HASH, row), rowHash('00000000000000000000000000000000', row), '不同 prevHash → 不同 hash')
})

test('writeAudit: source 落库(source 列)', () => {
  const db = makeDb()
  writeAudit(db, { keyId: 'k1', owner: 'a', clusterId: 'c1', tool: 'get_pod_logs', result: 'ok', source: 'mcp' })
  assert.equal(db.prepare('SELECT source FROM audit_log WHERE seq=1').get().source, 'mcp')
})
test('writeAudit: 缺 source → NULL', () => {
  const db = makeDb()
  writeAudit(db, { tool: 't', result: 'ok' })
  assert.equal(db.prepare('SELECT source FROM audit_log WHERE seq=1').get().source, null)
})
test('迁移幂等: 二次 createAuditSchema 不报错', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createAuditSchema(db))
})
test('verifyChain: source 与无 source 行混合仍 valid(source 不在 CORE_FIELDS)', () => {
  const db = makeDb()
  writeAudit(db, { tool: 't1', result: 'ok', source: null })
  writeAudit(db, { tool: 't2', result: 'ok', source: 'mcp' })
  writeAudit(db, { tool: 't3', result: 'ok', source: 'agent' })
  const v = verifyChain(db)
  assert.equal(v.valid, true)
})
