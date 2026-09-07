// Wave 4 OIDC Task 3:JIT 建户 + claims 驱动组同步(spec D2/D6)。
//   - OIDC 用户:authProvider='oidc'、passwordHash=NULL(本地密码登录天然不可用,break-glass 走本地账号)
//   - 归属锚:oidcSubject = '<issuer>|<sub>'(唯一索引,同 IdP 同 sub 二次登录走 UPDATE 而非新建)
//   - username 冲突拒不接管:同名本地(或另一 OIDC)用户已存在 → { error:'usernameTaken' }
//   - 组同步:**仅对 authProvider='oidc' 用户**全量对齐 group_members(DELETE+INSERT 事务);
//     本地用户的组成员是管理员手工事实,claims 不得触碰。组行只建不删(授权可能仍引用)。
// node:sqlite 绑定禁 undefined(displayName 等 ?? null 归一)。
import { randomUUID } from 'node:crypto'

// OIDC 身份锚:issuer|sub(IdP 内 sub 唯一,跨 IdP 靠 issuer 命名空间)。
export function oidcSubjectOf(issuer, sub) {
  return `${issuer}|${sub}`
}

// JIT upsert 三路:①oidcSubject 已知 → UPDATE displayName 返;②username 被占(任何现有用户)→
// { error:'usernameTaken' };③否则 INSERT(authProvider='oidc', passwordHash=NULL, role='user')。
export function upsertOidcUser(db, { issuer, sub, username, displayName }) {
  const subject = oidcSubjectOf(issuer, sub)
  const existing = db.prepare('SELECT * FROM platform_users WHERE oidcSubject=?').get(subject)
  if (existing) {
    db.prepare('UPDATE platform_users SET displayName=? WHERE id=?').run(displayName ?? null, existing.id)
    return { user: db.prepare('SELECT * FROM platform_users WHERE id=?').get(existing.id) }
  }
  const clash = db.prepare('SELECT id FROM platform_users WHERE username=?').get(username)
  if (clash) return { error: 'usernameTaken' }
  const id = randomUUID()
  db.prepare(`INSERT INTO platform_users (id, username, passwordHash, role, displayName, createdAt, authProvider, oidcSubject)
    VALUES (?,?,NULL,'user',?,?, 'oidc', ?)`).run(id, username, displayName ?? null, Date.now(), subject)
  return { user: db.prepare('SELECT * FROM platform_users WHERE id=?').get(id) }
}

// claims 组 → 全量对齐该用户的 group_members(事务)。返回 { created } = 本轮新建组数。
// 输入必须 string[](缺 claim 由调用方按 [] 传入——裁决 R3;非 string[] 在此硬拒)。
// 本地用户(或用户不存在)→ no-op { created:0 }。
export function syncGroupsFromClaims(db, userId, groupNames) {
  if (!Array.isArray(groupNames) || !groupNames.every((g) => typeof g === 'string')) {
    throw new Error('groups') // 非 string[] 拒整次登录(plan 安全红线),调用方按失败分支处理
  }
  const user = db.prepare('SELECT id, authProvider FROM platform_users WHERE id=?').get(userId)
  if (!user || user.authProvider !== 'oidc') return { created: 0 }

  db.exec('BEGIN')
  try {
    let created = 0
    const now = Date.now()
    for (const name of groupNames) {
      const res = db.prepare("INSERT OR IGNORE INTO groups (id, name, createdAt, createdBy) VALUES (?, ?, ?, 'oidc')").run(randomUUID(), name, now)
      if (res.changes === 1) created++
    }
    const memberInsert = db.prepare("INSERT INTO group_members (groupId, userId, addedBy, createdAt) VALUES (?, ?, 'oidc', ?)")
    db.prepare('DELETE FROM group_members WHERE userId=?').run(userId)
    const groupById = db.prepare('SELECT id FROM groups WHERE name=?')
    for (const name of groupNames) memberInsert.run(groupById.get(name).id, userId, now)
    db.exec('COMMIT')
    return { created }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
