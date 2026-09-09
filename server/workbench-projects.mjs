// 工作台项目存储(W2):workbench_projects 表 + CRUD。
// 纯函数、db 注入(无全局状态),便于单测传临时 db。repo 路径由 index.mjs 按 clusterId+id 派生,git 操作走 workbench-repos。
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildRecapInjection } from './workbench-prompt.mjs'
import { deriveSalvageContent } from './salvage-content.mjs'

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
  // 项目记忆(2026-08-29 spec §3.1):滚动摘要 + history 水位
  try { db.exec('ALTER TABLE workbench_projects ADD COLUMN projectRecap TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE workbench_projects ADD COLUMN historyWatermark INTEGER DEFAULT 0') } catch { /* 列已存在 */ }
  // repo 路径方案(2026-08-30 无集群工作台 spec §2.2):'projects'=新方案 <dir>/projects/<id>;NULL=存量旧方案 <dir>/<clusterId>/projects/<id>
  try { db.exec("ALTER TABLE workbench_projects ADD COLUMN repoRoot TEXT DEFAULT NULL") } catch { /* 列已存在 */ }
  // recapRev(gap2-02,2026-09-07 审计):人工写 recap 的乐观锁版本号——setProjectRecap 两分支
  // 递增;maybeSummarizeProject 快照读取、条件写比对,人工清空/精编不被在途摘要器复活/覆盖
  // (清空会归零水位,既有水位守卫此时反而放行,必须靠 rev 拦截)。
  try { db.exec('ALTER TABLE workbench_projects ADD COLUMN recapRev INTEGER NOT NULL DEFAULT 0') } catch { /* 列已存在 */ }
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
  // reasoning(思考过程)持久化(R1):conv 级=流式检查点(轮询回放/启动抢救用),
  // 消息级=终值(重建 turns 回看 thinking 用)。此前 reasoning 只走 SSE 内存,刷新即蒸发。
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN reasoning TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE workbench_messages ADD COLUMN reasoning TEXT') } catch { /* 列已存在 */ }
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
  // conv-lifecycle-09(2026-09-07 审计批次三):列表 SELECT 剔除 content——全文(可达 64KB+)
  // 随 10s 活刷新全量回传是纯带宽浪费,单条全文走 GET /:id。userMessage 刻意保留:唯一列表
  // 消费方 WorkbenchDetail 侧栏以 title||userMessage 为无标题回退(3 处消费,grep 核对在案)。
  return db.prepare(`SELECT id,status,steps,userMessage,title,error,createdAt,updatedAt
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
// conv-lifecycle-11(2026-09-07 审计批次三):ownerId(非 null 时)在 SQL 内先过滤再 LIMIT
// ——旧实现全局 Top-N 后才由路由按 owner 过滤,他人 10 条 running 可把非 admin 自己的
// running/paused 整体挤出 cap(活跃入口失明)。null = 不过滤(admin/全量),旧语义。
export function listActiveConversations(db, { now = Date.now(), windowMs = 30 * 60 * 1000, cap = 5, ownerId = null } = {}) {
  const ownerClause = ownerId ? 'AND p.ownerId = ?' : ''
  const params = ownerId ? [now - windowMs, ownerId, cap] : [now - windowMs, cap]
  return db.prepare(`SELECT c.id, c.projectId, p.name AS projectName, p.ownerId AS projectOwnerId, c.title, c.status, c.updatedAt
    FROM workbench_conversations c JOIN workbench_projects p ON p.id = c.projectId
    WHERE (c.status IN ('running','paused')
       OR (c.status IN ('done','failed','cancelled') AND c.updatedAt > ?))
       ${ownerClause}
    ORDER BY c.updatedAt DESC LIMIT ?`).all(...params)
}

// conv.trace 滚动上限(2026-09-06 审计#12a;对抗审查修订):防长对话无界增长(生产实测
// 328KB)。截断只许丢【旧轮】事件(ts ≤ lastMsgTs)——resume 路径的消息级 trace(done/
// salvage/cancelled 落库)与降级轮询/SSE 重连的 live 视图都从 conv.trace 按 ts>lastMsgTs
// 切片派生,丢当前轮头部事件 = workbench_messages.trace 持久缺早期工具事件,不可恢复
// (「消息级 trace 才是持久完整记录」在 resume 路径恰不成立——它派生自本字段)。
// 当前轮超限时接受软上限:单事件体积已被 clampTraceStep 32KB 钳制,且 done 落库后
// append/regenerate/edit 三入口均复位 trace——单轮大体积只在轮内存在。
const TRACE_CAP_BYTES = 256 * 1024
export function appendTrace(db, id, step) {
  const row = db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(id)
  if (!row) throw new Error(`appendTrace: conversation ${id} not found`)
  let trace = []
  try { trace = JSON.parse(row.trace || '[]') } catch {
    // A7(salvage-gap 审计 2026-09-08):现值损坏时不再以 [] 覆写——旧实现 catch 后照常
    // push+落库,等于把全对话 trace 静默清零(当前轮事件唯一副本随之蒸发)。跳过本次追加,
    // 原值保留待诊断;调用方(makeOnStep)不消费返回值,零影响。
    console.error(`[workbench-projects] appendTrace: conversation ${id} trace 损坏,跳过追加(原值保留)`)
    return []
  }
  trace.push(step)
  // 收缩单遍完成(对抗审查性能发现):逐条丢弃×全量重序列化是 O(drops×cap),存量数千
  // 事件超限行(无上限时代遗留)首 append 实测 2-4s 同步停摆——单进程不变式下全进程冻结。
  // 前缀和一次定位丢弃下标:JSON 数组序列化 = '[' + join(',') + ']',各元素序列化字节
  // 精确可加,无需反复试序列化。
  let json = JSON.stringify(trace)
  if (Buffer.byteLength(json) > TRACE_CAP_BYTES && trace.length > 1) {
    let lastMsgTs = 0
    try { lastMsgTs = db.prepare('SELECT MAX(createdAt) AS m FROM workbench_messages WHERE conversationId=?').get(id)?.m || 0 } catch { lastMsgTs = 0 }
    const sizes = trace.map(e => Buffer.byteLength(JSON.stringify(e)))
    let acc = 2 + Math.max(0, trace.length - 1) + sizes.reduce((a, b) => a + b, 0) // 括号 + 逗号
    let start = 0
    while (acc > TRACE_CAP_BYTES && start < trace.length - 1 && (trace[start].ts || 0) <= lastMsgTs) {
      acc -= sizes[start] + 1
      start++
    }
    if (start > 0) {
      trace = trace.slice(start)
      json = JSON.stringify(trace)
    }
    // 头部已是当前轮:接受软上限(见上);至少保留最后一条(=本次 append 的事件)
  }
  db.prepare('UPDATE workbench_conversations SET trace=?, updatedAt=? WHERE id=?')
    .run(json, Date.now(), id)
  return trace
}

export function createProject(db, { name, clusterId, ownerId }) {
  if (!name || !ownerId) throw new Error('createProject 缺 name / ownerId')
  const id = randomUUID()
  const createdAt = Date.now()
  // clusterId 可空(2026-08-30 spec §2.1):缺省 ''=未绑定哨兵(falsy 贯通既有降级);repoRoot 恒新方案
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt,repoRoot) VALUES (?,?,?,?,?,?)')
    .run(id, name, clusterId || '', ownerId, createdAt, 'projects')
  return getProject(db, id)
}

// repo 路径唯一事实源(spec §2.2):repoRoot 在创建时定格,绑/换/解绑集群都不动文件
export function projectRepoPath(workbenchDir, project) {
  return project.repoRoot === 'projects'
    ? join(workbenchDir, 'projects', project.id)
    : join(workbenchDir, project.clusterId, 'projects', project.id)
}

// 台账 learnings 落点(spec §2.3):绑定项目归集群 cluster-context;未绑定归平台级 _platform 全局池(历史不搬迁)
export function learningLedgerPath(workbenchDir, project) {
  return project.clusterId
    ? { dir: join(workbenchDir, project.clusterId, 'cluster-context'), file: 'learnings.md' }
    : { dir: join(workbenchDir, '_platform'), file: 'learnings.md' }
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
// context-assembly-07(2026-09-07 审计批次三)去重:同角色最近一行同文本不再落——done 链路每轮
// append user(conv.userMessage)+assistant 两行,regenerate 重答同问(userMessage 不变)会把同一
// 提问再落一行,项目摘要输入读成 Q/A1/Q/A2。比对锚=最近一条同角色行(紧邻重复);隔了新内容后
// 同文本再问照常落(提问历史不丢,只去 regenerate 形态的紧邻重复)。
export function appendHistory(db, projectId, role, content) {
  const text = String(content ?? '')
  const dup = db.prepare('SELECT content FROM workbench_history WHERE projectId=? AND role=? ORDER BY ts DESC, rowid DESC LIMIT 1').get(projectId, role)
  if (dup && dup.content === text) return
  db.prepare('INSERT INTO workbench_history (projectId,role,content,ts) VALUES (?,?,?,?)').run(projectId, role, text, Date.now())
}
// 未并入项目摘要的 history(ts >= 水位,升序)——条数判定与摘要输入共用(项目记忆 T1)。
// context-assembly-08(含 gap2-03,2026-09-07 审计批次三):旧 `ts >` 把与水位同毫秒的迟并行
// (竞态窗口内 append 的行)永久排除——done 链路 appendHistory(user)+appendHistory(assistant)
// 同毫秒是常态。`>=` 读法把边界毫秒行重新纳入;「已摘行不重摘」由 workbench-summarize 的
// in-memory 已摘 rowid 上限守住(单进程不变式),故 SELECT 带 rowid(AS rid)供该防线消费。
export function unsummarizedProjectHistory(db, projectId) {
  const wm = db.prepare('SELECT historyWatermark FROM workbench_projects WHERE id=?').get(projectId)?.historyWatermark ?? 0
  return db.prepare('SELECT rowid AS rid, role, content, ts FROM workbench_history WHERE projectId=? AND ts>=? ORDER BY ts ASC, rowid ASC').all(projectId, wm)
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
// node:sqlite 拒绝 undefined 绑定 → refs/trace/reasoning 显式落 null(不传 undefined)。
export function appendMessage(db, { conversationId, role, content, refs, trace, reasoning, seq }) {
  const finalSeq = seq ?? (getMaxSeq(db, conversationId) + 1)
  const id = randomUUID()
  db.prepare(`INSERT INTO workbench_messages (id,conversationId,role,content,refs,trace,reasoning,seq,createdAt) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, conversationId, role, content ?? '', refs ? JSON.stringify(refs) : null, trace ?? null, reasoning ?? null, finalSeq, Date.now())
  return db.prepare('SELECT * FROM workbench_messages WHERE id=?').get(id)
}

export function listMessages(db, conversationId) {
  return db.prepare('SELECT * FROM workbench_messages WHERE conversationId=? ORDER BY seq ASC').all(conversationId)
}

// 重新生成(P1):删掉最后一条 user 消息之后的全部消息(即待重跑的 assistant 回复),
// 该 user 消息保留——runConversation 以 buildHistory(=剩余消息)重跑即重答此轮。
// 返回 { removed, lastUserSeq };无 user 消息返回 { removed: 0, lastUserSeq: 0 }。调用方
// (regenerate 路由)按 lastUserSeq 判 400 而非 removed——removed=0 但 user 仍在
// (失败/取消轮零 assistant 产出)须放行重跑,见 contracts-02(2026-09-07 审计)。
export function truncateAfterLastUser(db, conversationId) {
  const lastUser = db.prepare("SELECT seq FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq DESC LIMIT 1").get(conversationId)
  if (!lastUser) return { removed: 0, lastUserSeq: 0 }
  const removed = db.prepare('DELETE FROM workbench_messages WHERE conversationId=? AND seq>?').run(conversationId, lastUser.seq).changes
  return { removed, lastUserSeq: lastUser.seq }
}

// 启动抢救(2026-08-17 意外中断内容保全):上次运行中的对话标记 failed('Server restarted');
// 若流式检查点已写过 conv.content 而末条消息不是该内容(中断轮的答案从未 append),补录为
// assistant 消息——否则重开对话时,用户亲眼看着流出来的答案会"蒸发"(重建只吃 messages)。
// 病根A·启动抢救变体(salvage-gap 审计 2026-09-08):run 在后续轮死亡时,轮间清零已把
// conv.content 写空,旧判据 c.content 恒假 → 不补录,本轮已流出文本/工具只活在 conv.trace
// 对消息层不可见。契约:content 空但「末条消息之后」的 trace 切片非空 → 照样补录
// (content 空 + 切片,交错渲染可见);contentSaved 路径保持旧形状(整包 trace)不变。
// 返回补录条数。
export function salvageInterrupted(db, { now = Date.now() } = {}) {
  const running = db.prepare("SELECT id, content, reasoning, trace FROM workbench_conversations WHERE status='running'").all()
  let salvaged = 0
  for (const c of running) {
    const msgs = listMessages(db, c.id)
    const last = msgs[msgs.length - 1]
    const contentSaved = c.content && !(last && last.role === 'assistant' && last.content === c.content)
    // 切片只在 contentSaved 不成立时计算(两判据互斥:content 路径走旧形状;已录过同文 →
    // 末条 assistant 行 createdAt 晚于本轮 trace 事件 ts,切片自然为空,不会重复补录)。
    let slice = []
    if (!contentSaved) {
      try {
        const lastTs = last?.createdAt || 0
        slice = (JSON.parse(c.trace || '[]'))
          .filter(e => e && (e.ts || 0) > lastTs && e.type !== 'tool_start')
          .map(e => e?.type === 'assistant' ? { type: 'assistant', content: e.message?.content ?? e.content ?? '', ts: e.ts } : e)
      } catch { slice = [] }
    }
    if (contentSaved || slice.length) {
      appendMessage(db, { conversationId: c.id, role: 'assistant', content: deriveSalvageContent(c.content || '', slice), reasoning: c.reasoning || null, trace: contentSaved ? (c.trace || null) : JSON.stringify(slice) })
      salvaged++
    }
    db.prepare("UPDATE workbench_conversations SET status='failed', error='Server restarted', updatedAt=? WHERE id=?").run(now, c.id)
  }
  return salvaged
}

// 编辑重发(2026-08-28 spec §3.2):按消息锚截断——删该消息及其后全部(seq >= 锚.seq),
// 供 edit 路由换新内容重跑。keptMinSeq=剩余前缀最小 seq(截到空为 null),供摘要水位钳制。
// 锚不存在或非 user 消息返回 null(调用方 400)。
export function truncateFromMessage(db, conversationId, messageId) {
  const row = db.prepare('SELECT seq, role FROM workbench_messages WHERE id=? AND conversationId=?').get(messageId, conversationId)
  if (!row || row.role !== 'user') return null
  const removed = db.prepare('DELETE FROM workbench_messages WHERE conversationId=? AND seq>=?').run(conversationId, row.seq).changes
  const kept = db.prepare('SELECT MIN(seq) AS m FROM workbench_messages WHERE conversationId=?').get(conversationId)
  return { removed, fromSeq: row.seq, keptMinSeq: kept?.m ?? null }
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
  // recap 注入单源(context-assembly-02,2026-09-07 审计):头注 caveat + 尾部作废护栏一律来自
  // workbench-prompt.buildRecapInjection——此前这里只内联了头注,毒 recap 护栏漏盖会话级注入点
  // (头注挡不住正文,护栏必须落在正文之后);静态守卫防回潮(不得再内联字面)。
  const recapInj = buildRecapInjection(conv.recap)
  if (recapInj) history.push({ role: 'system', content: recapInj })
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

// 项目删除(2026-08-31 生命周期):四表级联(conversations/messages/history/last_reconcile)+ 项目行
// + repo 目录清除,单事务。last_reconcile 以 projectId 为键(:36),不级联就成了删除后查不到、
// 也永不覆写的永久孤儿行(终审 I1)。
// agent 取消/事件总线回收是路由层职责(Task 2),数据层只管数据与目录。
// repo 路径逃逸防线:resolve 后必须落在 workbenchDir(resolve)内——repoRoot/clusterId
// 是落库字段,手工改库可把 rmSync 指向任意路径,删除是破坏性操作必须先验。
// removeDir 仅测试注入(rmSync 失败注入不可移植:root 下 chmod 不拦截),生产恒为 rmSync。
export function deleteProject(db, { workbenchDir, projectId, removeDir = rmSync }) {
  const project = getProject(db, projectId)
  if (!project) return { ok: false, status: 404 }
  const wbAbs = resolve(workbenchDir)
  const repo = resolve(projectRepoPath(workbenchDir, project))
  if (repo !== wbAbs && !repo.startsWith(wbAbs + '/')) {
    return { ok: false, status: 400, error: 'repo path escape' }
  }
  let removedConversations = 0
  let removedMessages = 0
  try {
    db.exec('BEGIN')
    removedMessages = db.prepare('DELETE FROM workbench_messages WHERE conversationId IN (SELECT id FROM workbench_conversations WHERE projectId=?)').run(projectId).changes
    removedConversations = db.prepare('DELETE FROM workbench_conversations WHERE projectId=?').run(projectId).changes
    db.prepare('DELETE FROM workbench_history WHERE projectId=?').run(projectId)
    db.prepare('DELETE FROM last_reconcile WHERE projectId=?').run(projectId)   // 终审 I1:孤儿 reconcile 结果一并清
    db.prepare('DELETE FROM workbench_projects WHERE id=?').run(projectId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // 目录清除在事务提交后:失败只置 repoError,不回滚数据(孤儿目录比数据复活可接受)。
  // 失败必须落 stderr(终审 I2):ops 文档承诺「日志有记录」,静默则孤儿目录永远无人跟进。
  let repoRemoved = true
  let repoError
  try {
    removeDir(repo, { recursive: true, force: true })
  } catch (e) {
    repoRemoved = false
    repoError = String(e?.message || e)
    console.error('[workbench] 项目 repo 目录删除失败:', repoError)
  }
  return { ok: true, removedConversations, removedMessages, repoRemoved, repoError }
}

// recap 存储 64KB 硬钳单一事实源(context-assembly-03,2026-09-07 审计批次三):三写点
// (setProjectRecap 人工写 / maybeSummarize 轮次追加 / compactConversation 整体替换)统一
// clamp——LLM 不服从「不超过 N 字」时不能无界落库(recap 每轮全量注入,无界=上下文放大器)。
// 人工超长输入由 400 整单拒绝改为截断落库(与摘要写点同语义:recap 是喂给 LLM 的记忆,截断
// 优于拒绝;边界值恰好 65536 原样通过不加标记)。
export const RECAP_MAX_CHARS = 65536
export function clampRecap(text) {
  const s = String(text ?? '')
  return s.length > RECAP_MAX_CHARS ? s.slice(0, RECAP_MAX_CHARS) + '…(截断)' : s
}

// 项目 recap 人工写(2026-08-31 生命周期):非空覆写不动水位(自动摘要继续增量);
// 空串=清空并归零 historyWatermark(下次蒸馏从头吞全量)。超长 clamp 64KB(clampRecap 单源)。
// 两分支均推进 recapRev(gap2-02 乐观锁):在途摘要器按快照 rev 条件写,changes=0 丢弃——
// 人工清空的毒 recap 不被迟到摘要复活、人工精编不被静默覆盖(清空归零水位后,摘要器的
// 水位守卫「< maxTs」反而放行,rev 是唯一拦截线)。COALESCE 兜底裸库手插的 NULL 行。
export function setProjectRecap(db, projectId, recap) {
  const text = clampRecap(recap)
  if (text === '') {
    db.prepare('UPDATE workbench_projects SET projectRecap=NULL, historyWatermark=0, recapRev=COALESCE(recapRev,0)+1 WHERE id=?').run(projectId)
  } else {
    db.prepare('UPDATE workbench_projects SET projectRecap=?, recapRev=COALESCE(recapRev,0)+1 WHERE id=?').run(text, projectId)
  }
  return { ok: true }
}
