// 审计日志 writer(T7):链式哈希 + 两阶段(started/finalized)+ 拒绝也审计 + verifyChain。
// codex #9:执行前 reserve(started),执行后 finalize(补结果)→ 崩溃可追溯;初始 reservation 写不进则 fail-op。
// node:sqlite DatabaseSync 单进程同步 → 插入天然串行,prevHash 不会读到并发分叉(MVP 单进程)。
// codex #12:requestSummary 是截断摘要,不放原始日志/输出(防注入 + 防泄露)。
import { createHash } from 'node:crypto'

export const GENESIS_HASH = '0'.repeat(64) // 创世 prevHash(第一条记录前)
// 参与哈希的核心字段(固定序 → canonical 确定性)。prevHash/hash 本身不参与(它们是派生)。
const CORE_FIELDS = ['ts', 'status', 'keyId', 'owner', 'clusterId', 'namespace', 'verb', 'resource', 'tool', 'result', 'reason', 'requestSummary']

export function createAuditSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'finalized',
    keyId TEXT,
    owner TEXT,
    clusterId TEXT,
    namespace TEXT,
    verb TEXT,
    resource TEXT,
    tool TEXT,
    result TEXT,
    reason TEXT,
    requestSummary TEXT,
    source TEXT,
    prevHash TEXT NOT NULL,
    hash TEXT NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_owner ON audit_log(owner)`)
  // 旧库(表已存在但无 source 列)补列;新库 CREATE 已带 → ALTER 抛「列已存在」,吞掉。
  try { db.exec('ALTER TABLE audit_log ADD COLUMN source TEXT') } catch { /* 列已存在 */ }
}

// canonical:固定序字段 → JSON 数组(确定性,特殊字符安全转义)。
function canonical(row) {
  return JSON.stringify(CORE_FIELDS.map(f => (f in row && row[f] !== undefined) ? row[f] : null))
}
export function rowHash(prevHash, row) {
  return createHash('sha256').update(`${prevHash}|${canonical(row)}`).digest('hex')
}
function lastHash(db) {
  const r = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get()
  return r ? r.hash : GENESIS_HASH
}

// 写一条审计(原子:取 lastHash → 算 hash → insert)。返回 {seq, prevHash, hash}。
// entry 含核心字段 + status(默认 finalized)。不抛错时认为持久化成功(fail-op 由调用方据返回判定)。
export function writeAudit(db, entry) {
  const prevHash = lastHash(db)
  const row = { ts: Date.now(), status: 'finalized', ...entry }
  const hash = rowHash(prevHash, row)
  const r = db.prepare(`INSERT INTO audit_log (ts,status,keyId,owner,clusterId,namespace,verb,resource,tool,result,reason,requestSummary,source,prevHash,hash)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.ts, row.status, row.keyId ?? null, row.owner ?? null, row.clusterId ?? null, row.namespace ?? null,
    row.verb ?? null, row.resource ?? null, row.tool ?? null, row.result ?? null, row.reason ?? null, row.requestSummary ?? null,
    row.source ?? null, prevHash, hash)
  return { seq: Number(r.lastInsertRowid), prevHash, hash }
}

// 两阶段(codex #9):执行前 reserve(started,无 result)→ 执行后 finalize(补 result/reason)。
// 两条独立不可变行,都进链(started 记"将要做的",finalized 记"结果");崩溃在中间 → 只有 started 行,可追溯。
export function reserveAudit(db, intent) {
  return writeAudit(db, { ...intent, status: 'started', result: null })
}
export function finalizeAudit(db, intent, outcome) {
  return writeAudit(db, { ...intent, status: 'finalized', ...outcome })
}

// 校验链完整性:从 seq 1 重算 hash,逐条比对 prevHash + hash。篡改任何核心字段 → hash mismatch。
// 注意(codex #9/N6):链哈希只防单条 naive 篡改/乱序;能直接改库的人可重算整条尾巴。完整 tamper-evidence(外部锚)标为 MVP 后。
export function verifyChain(db) {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all()
  let prev = GENESIS_HASH
  for (const row of rows) {
    if (row.prevHash !== prev) return { valid: false, brokenAt: row.seq, reason: 'prevHash mismatch(链断裂/乱序)' }
    if (row.hash !== rowHash(prev, row)) return { valid: false, brokenAt: row.seq, reason: 'hash mismatch(核心字段被篡改)' }
    prev = row.hash
  }
  return { valid: true, count: rows.length }
}

// 近 windowSec 秒、按 key 聚合(可选 source 过滤);label LEFT JOIN api_keys。给「最近活跃 key」面板。
// ⚠️ 只计 status='finalized' 行(reserveAudit 另写 'started' 行;不计 finalized 会把每次调用算 2 次)。
export function activeKeys(db, { windowSec = 900, source = null } = {}) {
  const since = Date.now() - Math.min(Math.max(Number(windowSec) || 900, 1), 86400) * 1000
  const sql = `SELECT a.keyId, k.label, a.owner, a.clusterId, COUNT(*) AS count, MAX(a.ts) AS lastTs,
      SUM(CASE WHEN a.result='ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN a.result='denied' THEN 1 ELSE 0 END) AS denied,
      SUM(CASE WHEN a.result='error' THEN 1 ELSE 0 END) AS error
    FROM audit_log a LEFT JOIN api_keys k ON k.id = a.keyId
    WHERE a.ts > ? AND a.keyId IS NOT NULL AND a.status='finalized' ${source ? 'AND a.source = ?' : ''}
    GROUP BY a.keyId ORDER BY lastTs DESC`
  const rows = source ? db.prepare(sql).all(since, source) : db.prepare(sql).all(since)
  return rows.map(r => ({ keyId: r.keyId, label: r.label, owner: r.owner, clusterId: r.clusterId,
    count: Number(r.count) || 0, lastTs: Number(r.lastTs), ok: Number(r.ok) || 0, denied: Number(r.denied) || 0, error: Number(r.error) || 0 }))
}

// 分页调用流水(多过滤器可选,size 钳 1..200,ts DESC)。⚠️ 默认只列 status='finalized'(结果行);
// 每次 call 另有一条 'started' 行(reserveAudit),不计入 → 避免每调用显示 2 行。传 status=null/'' → 不过滤(全部)。
export function queryAuditLog(db, { keyId, owner, clusterId, tool, result, source, since, until, page = 1, size = 50, status = 'finalized' } = {}) {
  size = Math.min(Math.max(Number(size) || 50, 1), 200)
  page = Math.max(Number(page) || 1, 1)
  const where = []; const params = []
  if (status) { where.push('status = ?'); params.push(status) }   // 默认 'finalized';传 null/'' → 不过滤(全部)
  if (keyId) { where.push('keyId = ?'); params.push(keyId) }
  if (owner) { where.push('owner = ?'); params.push(owner) }
  if (clusterId) { where.push('clusterId = ?'); params.push(clusterId) }
  if (tool) { where.push('tool = ?'); params.push(tool) }
  if (result) { where.push('result = ?'); params.push(result) }
  if (source) { where.push('source = ?'); params.push(source) }
  if (since != null) { where.push('ts >= ?'); params.push(Number(since)) }
  if (until != null) { where.push('ts <= ?'); params.push(Number(until)) }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${clause}`).get(...params).c) || 0
  const items = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC, seq DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size)
  return { items, total, page, size }
}
