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
  // 迁移加列:项目当前活跃对话(每项目一条)。idempotent——列已存在时 ALTER 抛错被吞。
  try { db.exec('ALTER TABLE workbench_projects ADD COLUMN activeConversationId TEXT') } catch { /* 列已存在 */ }
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
  db.exec(`CREATE TABLE IF NOT EXISTS last_distills (clusterId TEXT PRIMARY KEY, stats TEXT, ts INTEGER NOT NULL)`)
  // 项目 reconcile 的最近结果(每项目一条;R1,第 4 阶段)
  db.exec(`CREATE TABLE IF NOT EXISTS last_reconcile (projectId TEXT PRIMARY KEY, result TEXT, ts INTEGER NOT NULL)`)
  createConversationsSchema(db)
}

// 对话实体(P5):服务端持久化的 agent 对话——后台执行 + 轮询 + checkpoint/resume。
export function createConversationsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_conversations (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    system TEXT,
    messages TEXT,
    queue TEXT,
    denied TEXT,
    pendingApproval TEXT,
    steps INTEGER DEFAULT 0,
    trace TEXT,
    content TEXT,
    error TEXT,
    userMessage TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workbench_conversations_proj ON workbench_conversations(projectId, createdAt)`)
  // 消息实体(T1):每条消息一行,seq 单调递增(按对话隔离)。
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_messages (
    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '', refs TEXT, trace TEXT,
    seq INTEGER NOT NULL, createdAt INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wb_messages_conv ON workbench_messages(conversationId, seq)`)
  // 迁移加列(既有库可能没有;idempotent——列已存在时 ALTER 抛错被吞):
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN recap TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN summarizedUpTo INTEGER NOT NULL DEFAULT 0') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN title TEXT') } catch { /* 列已存在 */ }
  // T5:@-ref 落库(每轮 chat 前刷新用)。幂等:旧库已存在该表无此列时补;新库直接建表后 noop。
  // 「references」是 SQLite 保留字,引用时必须双引号。
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN "references" TEXT') } catch { /* 列已存在 */ }
}

export function createConversation(db, { projectId, system, userMessage, references }) {
  if (!projectId || !userMessage) throw new Error('createConversation 缺 projectId / userMessage')
  const id = randomUUID()
  const ts = Date.now()
  db.prepare(`INSERT INTO workbench_conversations
    (id,projectId,status,system,userMessage,"references",steps,trace,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, 'running', system ?? '', userMessage, JSON.stringify(references || []), 0, '[]', ts, ts)
  return getConversation(db, id)
}

export function getConversation(db, id) {
  return db.prepare('SELECT * FROM workbench_conversations WHERE id=?').get(id) || null
}

export function updateConversation(db, id, patch, { touch = true } = {}) {
  if (!id) throw new Error('updateConversation 缺 id')
  const cols = Object.keys(patch)
  if (cols.length === 0) return getConversation(db, id)
  // 列名双引号:「references」等 SQLite 保留字裸插值会 syntax error;双引号对保留/非保留字都安全。
  const setClause = cols.map(k => `"${k}"=?`).join(', ')
  // node:sqlite 拒绝 undefined/对象/数组 → 强制成可绑定类型(undefined→null,对象→JSON)。
  // 否则 out.content 等为 undefined 时 "Provided value cannot be bound to SQLite parameter N"。
  const vals = cols.map(k => {
    const v = patch[k]
    if (v === undefined) return null
    if (v !== null && typeof v === 'object') return JSON.stringify(v)
    return v
  })
  // touch:false = 后台整理/元数据编辑(recap 摘要等)不 bump updatedAt——悬浮入口以 updatedAt
  // 判「新动态」,这类写入对用户不可见,动了会让已读对话的小点无故复活。
  if (touch) {
    db.prepare(`UPDATE workbench_conversations SET ${setClause}, updatedAt=? WHERE id=?`)
      .run(...vals, Date.now(), id)
  } else {
    db.prepare(`UPDATE workbench_conversations SET ${setClause} WHERE id=?`)
      .run(...vals, id)
  }
  return getConversation(db, id)
}

export function listConversations(db, projectId) {
  // updatedAt DESC(活跃度):续接/运行中的对话浮顶——createdAt 排序下旧对话永远沉底,
  // 与「打开看到最新」的直觉相反(2026-08-16 交互审查)
  return db.prepare(`SELECT id,status,steps,userMessage,title,content,error,createdAt,updatedAt
    FROM workbench_conversations WHERE projectId=? ORDER BY updatedAt DESC`).all(projectId)
}

// 悬浮入口配置(2026-08-17 近期动态模型):platform_settings 两键,clamp 兜底(手改越界/垃圾值不炸)。
// 缺 platform_settings 表(测试裸库等)回默认——生产 index.mjs 启动必建表,防御仅兜底。
export const PRESENCE_LIMITS = { maxItems: [1, 20, 5], windowMin: [1, 1440, 30] }
export function clampPresence(key, value) {
  const [lo, hi, dflt] = PRESENCE_LIMITS[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
export function getPresenceConfig(db) {
  let maxRaw, winRaw
  try {
    maxRaw = db.prepare("SELECT value FROM platform_settings WHERE key='presence.maxItems'").get()?.value
    winRaw = db.prepare("SELECT value FROM platform_settings WHERE key='presence.activityWindowMin'").get()?.value
  } catch { maxRaw = winRaw = undefined }
  const maxItems = clampPresence('maxItems', maxRaw)
  const windowMin = clampPresence('windowMin', winRaw)
  return { maxItems, windowMin, windowMs: windowMin * 60_000 }
}

// 近期动态模型:running/paused 永在;终态(done/failed/cancelled)窗口内有动态才在;
// Top-N 由调用方按配置传入。窗口过滤单一事实源在服务端,前端只做「正在看的项目」排除。
export function listActiveConversations(db, { now = Date.now(), windowMs = 30 * 60 * 1000, cap = 5 } = {}) {
  return db.prepare(`SELECT c.id, c.projectId, p.name AS projectName, c.title, c.status, c.updatedAt
    FROM workbench_conversations c JOIN workbench_projects p ON p.id = c.projectId
    WHERE c.status IN ('running','paused')
       OR (c.status IN ('done','failed','cancelled') AND c.updatedAt > ?)
    ORDER BY c.updatedAt DESC LIMIT ?`).all(now - windowMs, cap)
}

export function appendTrace(db, id, step) {
  const row = db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(id)
  if (!row) throw new Error(`appendTrace: conversation ${id} not found`)
  let trace = []
  try { trace = JSON.parse(row.trace || '[]') } catch { trace = [] }
  trace.push(step)
  db.prepare('UPDATE workbench_conversations SET trace=?, updatedAt=? WHERE id=?')
    .run(JSON.stringify(trace), Date.now(), id)
  return trace
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

// 上次蒸馏水位(每集群一条;scheduler 跳过判定用)。独立于 pending_distills——
// pending 被审掉(apply/dismiss)后水位仍在,无新料时不会重跑重产同样待审。
export function setLastDistill(db, clusterId, stats) {
  db.prepare('INSERT OR REPLACE INTO last_distills (clusterId,stats,ts) VALUES (?,?,?)').run(clusterId, JSON.stringify(stats ?? {}), Date.now())
}
export function getLastDistill(db, clusterId) {
  const r = db.prepare('SELECT * FROM last_distills WHERE clusterId=?').get(clusterId)
  if (r) { try { r.stats = JSON.parse(r.stats || '{}') } catch { r.stats = {} } }
  return r || null
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

// 消息 CRUD(T1):每条消息一行,seq 按对话隔离单调递增。
// node:sqlite 拒绝 undefined 绑定 → refs/trace 显式落 null(不传 undefined)。
export function appendMessage(db, { conversationId, role, content, refs, trace, seq }) {
  const finalSeq = seq ?? (getMaxSeq(db, conversationId) + 1)
  const id = randomUUID()
  db.prepare(`INSERT INTO workbench_messages (id,conversationId,role,content,refs,trace,seq,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, conversationId, role, content ?? '', refs ? JSON.stringify(refs) : null, trace ?? null, finalSeq, Date.now())
  return db.prepare('SELECT * FROM workbench_messages WHERE id=?').get(id)
}

export function listMessages(db, conversationId) {
  return db.prepare('SELECT * FROM workbench_messages WHERE conversationId=? ORDER BY seq ASC').all(conversationId)
}

// 重新生成(P1):删掉最后一条 user 消息之后的全部消息(即待重跑的 assistant 回复),
// 该 user 消息保留——runConversation 以 buildHistory(=剩余消息)重跑即重答此轮。
// 返回 { removed, lastUserSeq };无 user 消息返回 { removed: 0, lastUserSeq: 0 }(调用方据此 400)。
export function truncateAfterLastUser(db, conversationId) {
  const lastUser = db.prepare("SELECT seq FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq DESC LIMIT 1").get(conversationId)
  if (!lastUser) return { removed: 0, lastUserSeq: 0 }
  const removed = db.prepare('DELETE FROM workbench_messages WHERE conversationId=? AND seq>?').run(conversationId, lastUser.seq).changes
  return { removed, lastUserSeq: lastUser.seq }
}

// 启动抢救(2026-08-17 意外中断内容保全):上次运行中的对话标记 failed('Server restarted');
// 若流式检查点已写过 conv.content 而末条消息不是该内容(中断轮的答案从未 append),补录为
// assistant 消息——否则重开对话时,用户亲眼看着流出来的答案会"蒸发"(重建只吃 messages)。
// 返回补录条数。
export function salvageInterrupted(db, { now = Date.now() } = {}) {
  const running = db.prepare("SELECT id, content, trace FROM workbench_conversations WHERE status='running'").all()
  let salvaged = 0
  for (const c of running) {
    const msgs = listMessages(db, c.id)
    const last = msgs[msgs.length - 1]
    if (c.content && !(last && last.role === 'assistant' && last.content === c.content)) {
      appendMessage(db, { conversationId: c.id, role: 'assistant', content: c.content, trace: c.trace || null })
      salvaged++
    }
    db.prepare("UPDATE workbench_conversations SET status='failed', error='Server restarted', updatedAt=? WHERE id=?").run(now, c.id)
  }
  return salvaged
}

// regenerate 后的摘要水位钳制(dev29 风险修复):appendMessage 的 seq 取"现存最大+1",
// truncate 删除后新回复会复用被删 seq。若 summarizedUpTo ≥ lastUserSeq,buildHistory 会把
// 原问题(seq ≤ upTo)当"已进 recap"跳过 → 重答只靠摘要、偏题。钳到 lastUserSeq-1,
// 保证原问题走全文(recap 里的旧摘要冗余无害,LLM 可处理)。
export function regenWatermark(prevUpTo, lastUserSeq) {
  return Math.max(0, Math.min(prevUpTo ?? 0, lastUserSeq - 1))
}

export function getMaxSeq(db, conversationId) {
  return db.prepare('SELECT MAX(seq) AS m FROM workbench_messages WHERE conversationId=?').get(conversationId).m ?? 0
}

// 多轮上下文装配(T2):recap 段(if any)在前 + summarizedUpTo<seq 的全文消息。
// 纯函数,读 listMessages;conv.summarizedUpTo 旧行可能 null → 默认 0。
export function buildHistory(db, conv) {
  const msgs = listMessages(db, conv.id)
  const upTo = conv.summarizedUpTo ?? 0
  const history = []
  if (conv.recap) history.push({ role: 'system', content: `Earlier in this conversation (summary):\n${conv.recap}` })
  for (const m of msgs) {
    if (m.seq <= upTo) continue            // 已进 recap,跳过全文
    history.push({ role: m.role, content: m.content })
  }
  return history
}

// 项目当前活跃对话(每项目一条):set 覆盖,get 无则 null。
export function setActiveConversation(db, projectId, conversationId) {
  db.prepare('UPDATE workbench_projects SET activeConversationId=? WHERE id=?').run(conversationId, projectId)
}

export function getActiveConversationId(db, projectId) {
  return db.prepare('SELECT activeConversationId FROM workbench_projects WHERE id=?').get(projectId)?.activeConversationId ?? null
}
