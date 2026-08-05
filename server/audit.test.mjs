// T7 测试:审计链哈希 + 两阶段 + 篡改检测(内存 sqlite)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAuditSchema, writeAudit, reserveAudit, finalizeAudit, verifyChain, GENESIS_HASH } from './audit.mjs'

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

test('canonical 确定性: 同 entry → 同 hash(重写不漂移)', () => {
  const db1 = makeDb(), db2 = makeDb()
  const a = writeAudit(db1, { ...intent, result: 'ok' })
  const b = writeAudit(db2, { ...intent, result: 'ok' })
  assert.equal(a.hash, b.hash, '同样内容 → 同样 hash(创世首条)')
})
