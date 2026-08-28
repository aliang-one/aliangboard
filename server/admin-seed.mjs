// 首次启动 admin 种子(2026-08-28 CSO 审计 #3 从 index.mjs 抽出 + 强化,可单测)。
// 强化语义(此前 deployment.yaml 明文 admin/admin 直通):
//   · 显式弱口令('admin' 或 <8 字符)→ 拒绝播种,返回说人话的原因;
//   · ADMIN_PASSWORD 未设但 ADMIN_USERNAME 已设 → 生成 32 字符随机口令,一次性返回明文供调用方展示/落文件;
//   · 强口令 → 正常播种,不回明文;
//   · 库中已有 admin → 幂等跳过。
// 纯函数式:env 与 hashPassword 注入(db 同步 API);index.mjs 负责打日志/写一次性凭证文件。
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'

const MIN_LEN = 8

export function generateAdminPassword() {
  return randomBytes(24).toString('base64url') // 32 字符,~192 位熵
}

// 与 index.mjs 平台用户同格式的 scrypt 哈希(saltHex:hashHex:N:r:p;N=16384 抗暴力)
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${salt.toString('hex')}:${hash.toString('hex')}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}`
}

// env: { ADMIN_USERNAME?, ADMIN_PASSWORD? }。
// 返回 {action: 'skipped'|'rejected-weak'|'seeded'|'seeded-generated'|'noop', reason?, refuse?, username?, password?(仅生成时)}
export function seedAdminIfNeeded(db, env) {
  const count = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin'").get().c
  if (count > 0) return { action: 'skipped' }
  const username = env.ADMIN_USERNAME
  const password = env.ADMIN_PASSWORD
  if (!username) {
    return { action: 'noop', reason: '未设置 ADMIN_USERNAME,无法创建管理员;旧 K8s 直连模式仍可用' }
  }
  if (password !== undefined && password !== '') {
    const weakWhy = password === 'admin' ? '字面 admin'
      : password.length < MIN_LEN ? `不足 ${MIN_LEN} 字符`
      : /^\d+$/.test(password) ? '纯数字' : null
    if (weakWhy) {
      return { action: 'rejected-weak', username, reason: `ADMIN_PASSWORD 过弱(${weakWhy})`, refuse: `拒绝创建管理员 ${username}:口令${weakWhy}。请设置 ≥${MIN_LEN} 字符且非纯数字的强口令,或去掉 ADMIN_PASSWORD 让平台自动生成(首启日志/一次性凭证文件可查)` }
    }
    db.prepare('INSERT INTO platform_users (id, username, passwordHash, role, displayName, createdAt) VALUES (?,?,?,?,?,?)')
      .run(cryptoRandomId(), username, hashPassword(password), 'admin', 'Administrator', Date.now())
    return { action: 'seeded', username }
  }
  // 未设口令 → 自动生成(一次性明文仅本次返回,库里只落哈希)
  const generated = generateAdminPassword()
  db.prepare('INSERT INTO platform_users (id, username, passwordHash, role, displayName, createdAt) VALUES (?,?,?,?,?,?)')
    .run(cryptoRandomId(), username, hashPassword(generated), 'admin', 'Administrator', Date.now())
  return { action: 'seeded-generated', username, password: generated }
}

function cryptoRandomId() { return randomUUID() }
