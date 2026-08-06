// 工作台项目存储(W2):workbench_projects 表 + CRUD。
// 纯函数、db 注入(无全局状态),便于单测传临时 db。repo 路径由 index.mjs 按 clusterId+id 派生,git 操作走 workbench-repos。
import { randomUUID } from 'node:crypto'

// 项目 = 一个目标 = 一个 git repo。创建时绑 clusterId(项目 ⊂ 集群)+ owner(userId)。
export function createWorkbenchSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    clusterId TEXT NOT NULL,
    ownerId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workbench_projects_owner ON workbench_projects(ownerId)`)
}

export function createProject(db, { name, clusterId, ownerId }) {
  if (!name || !clusterId || !ownerId) throw new Error('createProject 缺 name / clusterId / ownerId')
  const id = randomUUID()
  const createdAt = Date.now()
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES (?,?,?,?,?)').run(id, name, clusterId, ownerId, createdAt)
  return getProject(db, id)
}

// 列表按归属过滤:admin 见全部,普通用户只见自己的。
export function listProjects(db, { userId, role }) {
  if (role === 'admin') return db.prepare('SELECT * FROM workbench_projects ORDER BY createdAt DESC').all()
  return db.prepare('SELECT * FROM workbench_projects WHERE ownerId=? ORDER BY createdAt DESC').all(userId)
}

export function getProject(db, id) {
  return db.prepare('SELECT * FROM workbench_projects WHERE id=?').get(id) || null
}
