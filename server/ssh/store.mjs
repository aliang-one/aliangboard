// ssh_servers 表 CRUD。三条铁律:①写入即加密(四个 enc* 字段)②API 层只见 sanitize 行
// ③明文凭据仅 materializeCreds(连接/测试路径)可取得。凭据更新语义:undefined/'' = 保持,
// null = 清除,非空 = 覆盖(spec §5「编辑不回填,留空=不改」)。
import { encryptField, decryptField } from './crypt.mjs'

export const SSH_APPROVAL_POLICIES = ['always', 'readonly', 'none']

export function ensureSshSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ssh_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    authMethod TEXT NOT NULL CHECK (authMethod IN ('password','privateKey')),
    encPassword      TEXT,
    encPrivateKey    TEXT,
    encPassphrase    TEXT,
    encSudoPassword  TEXT,
    hostKeyFingerprint TEXT,
    description TEXT,
    clusterRef  TEXT,
    exposeToAi INTEGER NOT NULL DEFAULT 0,
    aiApprovalPolicy TEXT NOT NULL DEFAULT 'always' CHECK (aiApprovalPolicy IN ('always','readonly','none')),
    tags TEXT,
    createdBy TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`)
}

export function validateSshServerInput(input = {}) {
  const errs = []
  if (!String(input.name || '').trim()) errs.push('name 必填')
  if (!String(input.host || '').trim()) errs.push('host 必填')
  if (!String(input.username || '').trim()) errs.push('username 必填')
  if (input.port != null && !(Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535)) errs.push('port 须为 1..65535')
  const m = input.authMethod
  if (!['password', 'privateKey'].includes(m)) errs.push('authMethod 须为 password|privateKey')
  else if (m === 'password' && !String(input.password || '').trim()) errs.push('密码必填(authMethod=password)')
  else if (m === 'privateKey' && !String(input.privateKey || '').trim()) errs.push('私钥必填(authMethod=privateKey)')
  if (input.aiApprovalPolicy != null && !SSH_APPROVAL_POLICIES.includes(input.aiApprovalPolicy)) errs.push('aiApprovalPolicy 非法')
  return errs
}

// 凭据字段名与输入字段名对应;空串归一为 undefined(「留空=保持」)
const SECRET_MAP = { password: 'encPassword', privateKey: 'encPrivateKey', passphrase: 'encPassphrase', sudoPassword: 'encSudoPassword' }
const norm = v => (v === '' ? undefined : v)

function encSecrets(db, key, input) {
  const out = {}
  for (const [inField, col] of Object.entries(SECRET_MAP)) {
    const v = norm(input[inField])
    if (v === undefined) continue
    out[col] = v === null ? null : encryptField(key, v)
  }
  return out
}

export function sanitizeSshServer(r) {
  if (!r) return null
  return {
    id: r.id, name: r.name, host: r.host, port: r.port, username: r.username,
    authMethod: r.authMethod, description: r.description || '', clusterRef: r.clusterRef || '',
    exposeToAi: !!r.exposeToAi, aiApprovalPolicy: r.aiApprovalPolicy,
    tags: r.tags ? JSON.parse(r.tags) : [],
    hostKeyFingerprint: r.hostKeyFingerprint || '',
    hasPassword: !!r.encPassword, hasPrivateKey: !!r.encPrivateKey,
    hasPassphrase: !!r.encPassphrase, hasSudoPassword: !!r.encSudoPassword,
    createdBy: r.createdBy || '', createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

export function createSshServer(db, key, input, createdBy) {
  const errs = validateSshServerInput(input)
  if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e }
  const id = crypto.randomUUID()
  const ts = Date.now()
  db.prepare(`INSERT INTO ssh_servers
    (id,name,host,port,username,authMethod,encPassword,encPrivateKey,encPassphrase,encSudoPassword,
     description,clusterRef,exposeToAi,aiApprovalPolicy,tags,createdBy,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, String(input.name).trim(), String(input.host).trim(), input.port ?? 22, String(input.username).trim(),
      input.authMethod, encryptField(key, input.password), encryptField(key, input.privateKey),
      encryptField(key, input.passphrase), encryptField(key, input.sudoPassword),
      String(input.description || ''), String(input.clusterRef || ''),
      input.exposeToAi ? 1 : 0, input.aiApprovalPolicy || 'always',
      JSON.stringify(Array.isArray(input.tags) ? input.tags : []), createdBy || '', ts, ts)
  return sanitizeSshServer(getSshServerRow(db, id))
}

export function updateSshServer(db, key, id, patch = {}) {
  const row = getSshServerRow(db, id)
  if (!row) return null
  const sets = [], args = []
  const plain = { name: 'name', host: 'host', port: 'port', username: 'username', authMethod: 'authMethod',
    description: 'description', clusterRef: 'clusterRef', aiApprovalPolicy: 'aiApprovalPolicy' }
  for (const [f, col] of Object.entries(plain)) {
    if (patch[f] !== undefined) { sets.push(`${col}=?`); args.push(f === 'name' || f === 'host' || f === 'username' ? String(patch[f]).trim() : patch[f]) }
  }
  if (patch.exposeToAi !== undefined) { sets.push('exposeToAi=?'); args.push(patch.exposeToAi ? 1 : 0) }
  if (patch.tags !== undefined) { sets.push('tags=?'); args.push(JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])) }
  for (const [inField, col] of Object.entries(SECRET_MAP)) {
    const v = norm(patch[inField])
    if (v === undefined) continue
    sets.push(`${col}=?`); args.push(v === null ? null : encryptField(key, v))
  }
  if (!sets.length) return sanitizeSshServer(row)
  sets.push('updatedAt=?'); args.push(Date.now())
  args.push(id)
  db.prepare(`UPDATE ssh_servers SET ${sets.join(',')} WHERE id=?`).run(...args)
  return sanitizeSshServer(getSshServerRow(db, id))
}

export function deleteSshServer(db, id) {
  const r = db.prepare('DELETE FROM ssh_servers WHERE id=?').run(id)
  return r.changes > 0
}

const SANITIZE_COLS = 'id,name,host,port,username,authMethod,description,clusterRef,exposeToAi,aiApprovalPolicy,tags,hostKeyFingerprint,encPassword,encPrivateKey,encPassphrase,encSudoPassword,createdBy,createdAt,updatedAt'

export function listSshServers(db, { exposedOnly = false } = {}) {
  const rows = db.prepare(`SELECT ${SANITIZE_COLS} FROM ssh_servers ${exposedOnly ? 'WHERE exposeToAi=1' : ''} ORDER BY name`).all()
  return rows.map(sanitizeSshServer)
}

export function getSshServerRow(db, id) {
  return db.prepare(`SELECT ${SANITIZE_COLS} FROM ssh_servers WHERE id=?`).get(id)
}

export function findSshServersByName(db, name) {
  return db.prepare(`SELECT ${SANITIZE_COLS} FROM ssh_servers WHERE name=?`).all(String(name).trim())
}

// 连接专用:解密凭据。解密失败(密钥丢失/换库)抛固定码,路由映射「凭据密钥不可用,请重录」。
export function materializeCreds(db, key, serverId) {
  const row = getSshServerRow(db, serverId)
  if (!row) return null
  const dec = enc => { try { return decryptField(key, enc) } catch { throw new Error('SSH_CRED_DECRYPT_FAILED') } }
  return {
    row,
    password: dec(row.encPassword),
    privateKey: dec(row.encPrivateKey),
    passphrase: dec(row.encPassphrase),
    sudoPassword: dec(row.encSudoPassword),
  }
}

export function recordHostKey(db, id, fingerprint) {
  db.prepare('UPDATE ssh_servers SET hostKeyFingerprint=?, updatedAt=? WHERE id=?').run(fingerprint, Date.now(), id)
}
