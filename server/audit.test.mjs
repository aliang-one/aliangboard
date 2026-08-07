// T7 测试:审计链哈希 + 两阶段 + 篡改检测(内存 sqlite)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAuditSchema, writeAudit, reserveAudit, finalizeAudit, verifyChain, rowHash, GENESIS_HASH, activeKeys, queryAuditLog } from './audit.mjs'
import { createApiKeysSchema } from './auth-keys.mjs'

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

// T4 读 helper:activeKeys(按 key 聚合)+ queryAuditLog(分页流水)。
// 内存库同时建 audit_log + api_keys,以便 LEFT JOIN label。
function makeAudDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  createApiKeysSchema(db)
  return db
}

test('activeKeys: 近 window 按 key 聚合 + source 过滤 + label join + 排除 started', () => {
  const db = makeAudDb()
  // label 不给 → LEFT JOIN 得 NULL;owner/clusterId/boundSA_* 是 NOT NULL,必须填。
  db.prepare("INSERT INTO api_keys (id,keyHash,prefix,owner,clusterId,boundSA_namespace,boundSA_name,tier,createdAt,revokedAt) VALUES ('k1','h','p','alice','c1','ns','sa','read',0,NULL)").run()
  const now = Date.now()
  writeAudit(db, { keyId: 'k1', owner: 'alice', clusterId: 'c1', tool: 'list_resources', result: 'ok', source: 'mcp', ts: now - 60_000 })
  writeAudit(db, { keyId: 'k1', owner: 'alice', clusterId: 'c1', tool: 'scale', result: 'denied', source: 'agent', ts: now - 30_000 })
  writeAudit(db, { keyId: 'k1', owner: 'alice', clusterId: 'c1', tool: 'get', result: 'error', source: 'mcp', ts: now - 10_000 })
  writeAudit(db, { keyId: 'k1', owner: 'alice', clusterId: 'c1', tool: 'old', result: 'ok', source: 'mcp', ts: now - 10_000_000 }) // 超出 window
  writeAudit(db, { keyId: 'k1', owner: 'alice', clusterId: 'c1', tool: 'started-only', result: null, source: 'mcp', ts: now - 5_000, status: 'started' }) // started 行不计
  const all = activeKeys(db, { windowSec: 900 })
  assert.equal(all.length, 1)
  assert.equal(all[0].keyId, 'k1')
  assert.equal(all[0].label, null)
  assert.equal(all[0].count, 3, 'started 行不计 → 3(finalized)非 4')
  assert.equal(all[0].ok, 1)
  assert.equal(all[0].denied, 1)
  assert.equal(all[0].error, 1)
  const mcpOnly = activeKeys(db, { windowSec: 900, source: 'mcp' })
  assert.equal(mcpOnly[0].count, 2)
})

test('queryAuditLog: 默认只列 finalized(排除 started) + 过滤 + 分页 + size 钳制', () => {
  const db = makeAudDb()
  for (let i = 0; i < 5; i++) writeAudit(db, { keyId: 'k1', tool: 't', result: 'ok', source: 'mcp', ts: 1000 + i })          // 5 finalized
  for (let i = 0; i < 3; i++) writeAudit(db, { keyId: 'k1', tool: 't', result: null, source: 'mcp', ts: 2000 + i, status: 'started' }) // 3 started(默认不计)
  const r = queryAuditLog(db, { source: 'mcp', page: 1, size: 2 })
  assert.equal(r.total, 5, '默认 finalized → 5,排除 3 started')
  assert.equal(r.items.length, 2)
  assert.ok(r.items[0].ts >= r.items[1].ts, 'DESC')
  assert.equal(queryAuditLog(db, { size: 9999 }).size, 200, 'size 钳到 200')
  assert.equal(queryAuditLog(db, { result: 'denied' }).total, 0)
  assert.equal(queryAuditLog(db, { status: null }).total, 8, 'status=null → 全部(5 finalized + 3 started)')
})

test('queryAuditLog: 同 ts 行按 seq DESC tiebreaker(分页列表稳定排序)', () => {
  const db = makeAudDb()
  // 两行 ts 完全相同(5000),distinct content;先插 A 后 B → seq A < seq B。
  // 不传 status → writeAudit 默认 'finalized',默认查询(status='finalized')会命中。
  writeAudit(db, { keyId: 'k1', tool: 't-A', result: 'ok', ts: 5000 })  // seq 1(A)
  writeAudit(db, { keyId: 'k1', tool: 't-B', result: 'ok', ts: 5000 })  // seq 2(B)
  const { items } = queryAuditLog(db, { size: 50 })
  assert.equal(items.length, 2)
  // ts DESC, seq DESC tiebreaker:后插的 B(seq 2)应在前,A(seq 1)在后。
  assert.ok(items[0].seq > items[1].seq, '同 ts 行 seq DESC(后插在前)')
  assert.equal(items[0].tool, 't-B')
  assert.equal(items[1].tool, 't-A')
})
