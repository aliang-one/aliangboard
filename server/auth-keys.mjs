// API key 管理(T4):建表 + 签发 / 查询 / 吊销。
// 高熵 key(32B 随机)→ SHA-256 快哈希(scrypt 是给低熵密码抗暴力的,key 不需要;且每请求验证要快);
// 明文仅签发时返回一次,库里只存 hash + 非密 prefix(UI 识别用,不见全 key)。
// 纯函数、db 注入(无全局状态):便于单测传临时 db。
import { randomUUID, randomBytes, createHash } from 'node:crypto'

const KEY_BYTES = 32 // 256 位熵 → base64url ≈ 43 字符

export function createApiKeysSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    keyHash TEXT NOT NULL UNIQUE,
    prefix TEXT,
    owner TEXT NOT NULL,
    clusterId TEXT NOT NULL,
    boundSA_namespace TEXT NOT NULL,
    boundSA_name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'read',
    label TEXT,
    createdBy TEXT,
    createdAt INTEGER NOT NULL,
    revokedAt INTEGER
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner)`)
}

export function hashKey(plaintext) {
  return createHash('sha256').update(String(plaintext)).digest('hex')
}

// 生成明文 key:base64url(URL 安全,适配 Authorization: Bearer / MCP --header)。
export function generateKeyPlaintext() {
  return randomBytes(KEY_BYTES).toString('base64url')
}

// 签发一把 key。返回 {id, plaintext(仅此次可见), prefix, ...}。明文不入库。
export function mintKey(db, input) {
  const { owner, clusterId, boundSA_namespace, boundSA_name, tier = 'read', label = null, createdBy = null } = input || {}
  if (!owner || !clusterId || !boundSA_namespace || !boundSA_name) {
    throw new Error('mintKey 缺少必填字段(owner / clusterId / boundSA_namespace / boundSA_name)')
  }
  if (!['read', 'operator', 'admin'].includes(tier)) throw new Error(`mintKey 非法 tier: ${tier}`)
  const plaintext = generateKeyPlaintext()
  const id = randomUUID()
  const createdAt = Date.now()
  db.prepare(`INSERT INTO api_keys (id, keyHash, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, label, createdBy, createdAt, revokedAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
    id, hashKey(plaintext), plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, label, createdBy, createdAt)
  return { id, plaintext, prefix: plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, label, createdBy, createdAt }
}

// 按明文查 key(高熵 hash 查找;返回行或 null。是否有效由 isActive 判)。
export function lookupKey(db, plaintext) {
  if (!plaintext) return null
  return db.prepare('SELECT * FROM api_keys WHERE keyHash = ?').get(hashKey(plaintext)) || null
}

export function isActive(row) {
  return !!row && !row.revokedAt
}

// 幂等吊销:已吊销再吊返回 false。
export function revokeKey(db, id) {
  return db.prepare('UPDATE api_keys SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL').run(Date.now(), id).changes > 0
}

// 列表(UI 用):绝不返回 keyHash / 明文,只 prefix。
export function listKeys(db, { owner } = {}) {
  const sql = `SELECT id, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, label, createdBy, createdAt, revokedAt
               FROM api_keys ${owner ? 'WHERE owner = ?' : ''} ORDER BY createdAt DESC`
  return owner ? db.prepare(sql).all(owner) : db.prepare(sql).all()
}
