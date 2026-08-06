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
  // 项目对话历史(跨会话;不进 git repo——决策 5:隐私 + repo 只放工程产物)
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_history (
    projectId TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workbench_history_proj ON workbench_history(projectId, ts)`)
  // 定时蒸馏的待审 diff(每集群一条,最新覆盖;D4)
  db.exec(`CREATE TABLE IF NOT EXISTS pending_distills (clusterId TEXT PRIMARY KEY, proposed TEXT, current TEXT, summary TEXT, stats TEXT, ts INTEGER NOT NULL)`)
  // 项目 reconcile 的最近结果(每项目一条;R1,第 4 阶段)
  db.exec(`CREATE TABLE IF NOT EXISTS last_reconcile (projectId TEXT PRIMARY KEY, result TEXT, ts INTEGER NOT NULL)`)
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

// 项目对话历史(跨会话)。append 一条;recent 取最近 n 条(最旧在前,喂给 agent 当 history)。
export function appendHistory(db, projectId, role, content) {
  db.prepare('INSERT INTO workbench_history (projectId,role,content,ts) VALUES (?,?,?,?)').run(projectId, role, String(content ?? ''), Date.now())
}
export function recentHistory(db, projectId, n = 30) {
  const rows = db.prepare('SELECT role,content FROM workbench_history WHERE projectId=? ORDER BY ts DESC LIMIT ?').all(projectId, n)
  return rows.reverse() // 最旧在前
}

// 定时蒸馏的待审 diff(每集群一条,最新覆盖)。scheduler 写,台账页读,apply 后清。
export function setPendingDistill(db, clusterId, { proposed, current, summary, stats }) {
  db.prepare('INSERT OR REPLACE INTO pending_distills (clusterId,proposed,current,summary,stats,ts) VALUES (?,?,?,?,?,?)')
    .run(clusterId, proposed ?? '', current ?? '', summary ?? '', JSON.stringify(stats ?? {}), Date.now())
}
export function getPendingDistill(db, clusterId) {
  const r = db.prepare('SELECT * FROM pending_distills WHERE clusterId=?').get(clusterId)
  if (r) { try { r.stats = JSON.parse(r.stats || '{}') } catch { r.stats = {} } }
  return r || null
}
export function clearPendingDistill(db, clusterId) {
  db.prepare('DELETE FROM pending_distills WHERE clusterId=?').run(clusterId)
}

// 项目 reconcile 最近结果(每项目一条;第 4 阶段 R1)
export function setLastReconcile(db, projectId, result) {
  db.prepare('INSERT OR REPLACE INTO last_reconcile (projectId,result,ts) VALUES (?,?,?)').run(projectId, JSON.stringify(result ?? {}), Date.now())
}
export function getLastReconcile(db, projectId) {
  const r = db.prepare('SELECT * FROM last_reconcile WHERE projectId=?').get(projectId)
  if (r) { try { r.result = JSON.parse(r.result || '{}') } catch { r.result = {} } }
  return r || null
}
