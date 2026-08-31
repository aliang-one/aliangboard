// W2 项目存储测试:建表 + createProject / listProjects(归属过滤)/ getProject。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { createWorkbenchSchema, createProject, listProjects, getProject, projectRepoPath, appendHistory, recentHistory, setPendingDistill, getPendingDistill, clearPendingDistill, createConversation, getConversation, updateConversation, listConversations, appendMessage, listMessages, getMaxSeq, buildHistory, setActiveConversation, getActiveConversationId, salvageInterrupted, truncateFromMessage, learningLedgerPath } from './workbench-projects.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  return db
}

test('createProject + getProject:写入可读回,字段齐全', () => {
  const db = makeDb()
  const p = createProject(db, { name: 'ci-cd-system', clusterId: 'c1', ownerId: 'u1' })
  assert.equal(p.name, 'ci-cd-system')
  assert.equal(p.clusterId, 'c1')
  assert.equal(p.ownerId, 'u1')
  assert.ok(p.id && p.createdAt > 0)
  assert.equal(getProject(db, p.id).name, 'ci-cd-system')
  assert.equal(getProject(db, 'nope'), null)
})

test('createProject:缺 name/ownerId 抛错(clusterId 2026-08-30 起可缺省)', () => {
  const db = makeDb()
  assert.throws(() => createProject(db, { clusterId: 'c1', ownerId: 'u1' }), /缺/)
  assert.throws(() => createProject(db, { name: 'x', clusterId: 'c1' }), /缺/)
})

test('projectRepoPath:repoRoot 定格路径方案——新项目绑集群前后同路径,存量走旧路径', () => {
  const dir = '/wb'
  assert.equal(projectRepoPath(dir, { id: 'p1', clusterId: '', repoRoot: 'projects' }), join(dir, 'projects', 'p1'))
  assert.equal(projectRepoPath(dir, { id: 'p1', clusterId: 'ck-9', repoRoot: 'projects' }), join(dir, 'projects', 'p1'))  // 绑集群后不变
  assert.equal(projectRepoPath(dir, { id: 'p2', clusterId: 'ck-9', repoRoot: null }), join(dir, 'ck-9', 'projects', 'p2'))  // 存量
})

test('createProject:clusterId 缺省写哨兵空串;repoRoot 恒 projects;带 clusterId 时照旧', () => {
  const db = makeDb()
  const unbound = createProject(db, { name: 'u1', ownerId: 'user-1' })
  assert.equal(unbound.clusterId, '')
  assert.equal(unbound.repoRoot, 'projects')
  const bound = createProject(db, { name: 'b1', clusterId: 'ck-1', ownerId: 'user-1' })
  assert.equal(bound.clusterId, 'ck-1')
  assert.equal(bound.repoRoot, 'projects')
})

test('listProjects:归属过滤——admin 见全部,普通用户只见自己的', () => {
  const db = makeDb()
  createProject(db, { name: 'a', clusterId: 'c1', ownerId: 'u1' })
  createProject(db, { name: 'b', clusterId: 'c1', ownerId: 'u2' })
  createProject(db, { name: 'c', clusterId: 'c2', ownerId: 'u1' })
  const adminSee = listProjects(db, { userId: 'u1', role: 'admin' })
  assert.equal(adminSee.length, 3)
  const u1See = listProjects(db, { userId: 'u1', role: 'user' })
  assert.equal(u1See.length, 2)
  assert.ok(u1See.every(p => p.ownerId === 'u1'))
  const u2See = listProjects(db, { userId: 'u2', role: 'user' })
  assert.equal(u2See.length, 1)
  assert.equal(u2See[0].name, 'b')
})

test('appendHistory + recentHistory:跨会话历史,最旧在前,按项目隔离', () => {
  const db = makeDb()
  appendHistory(db, 'p1', 'user', 'hello')
  appendHistory(db, 'p1', 'assistant', 'hi there')
  appendHistory(db, 'p1', 'user', '再做一件事')
  appendHistory(db, 'p2', 'user', '别的项目')
  const p1 = recentHistory(db, 'p1')
  assert.equal(p1.length, 3)
  assert.equal(p1[0].role, 'user')       // 最旧在前
  assert.equal(p1[0].content, 'hello')
  assert.equal(p1[2].content, '再做一件事')
  const p2 = recentHistory(db, 'p2')
  assert.equal(p2.length, 1)             // 项目隔离
  assert.equal(p2[0].content, '别的项目')
  // n 限制
  const last1 = recentHistory(db, 'p1', 1)
  assert.equal(last1.length, 1)
  assert.equal(last1[0].content, '再做一件事')
})

test('pending_distills:set/get/clear(每集群一条,最新覆盖,stats JSON)', () => {
  const db = makeDb()
  assert.equal(getPendingDistill(db, 'c1'), null)
  setPendingDistill(db, 'c1', { proposed: '# v1', current: '', summary: '1 条', stats: { audit: 3 } })
  let p = getPendingDistill(db, 'c1')
  assert.equal(p.proposed, '# v1')
  assert.equal(p.stats.audit, 3, 'stats 反序列化')
  assert.ok(p.ts > 0)
  // 覆盖
  setPendingDistill(db, 'c1', { proposed: '# v2', summary: '2 条', stats: { audit: 5 } })
  assert.equal(getPendingDistill(db, 'c1').proposed, '# v2')
  // 隔离
  setPendingDistill(db, 'c2', { proposed: '别的' })
  assert.equal(getPendingDistill(db, 'c2').proposed, '别的')
  assert.equal(getPendingDistill(db, 'c1').proposed, '# v2')
  // 清
  clearPendingDistill(db, 'c1')
  assert.equal(getPendingDistill(db, 'c1'), null)
  assert.equal(getPendingDistill(db, 'c2').proposed, '别的', '清 c1 不影响 c2')
})

test('appendMessage/listMessages/getMaxSeq: seq 单调递增,按序返回', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'first' })
  const conv = listConversations(db, proj.id)[0]
  const u = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
  const a = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'yo' })
  assert.equal(u.seq, 1); assert.equal(a.seq, 2)
  assert.equal(getMaxSeq(db, conv.id), 2)
  const all = listMessages(db, conv.id)
  assert.equal(all.length, 2); assert.equal(all[0].role, 'user'); assert.equal(all[1].content, 'yo')
})

test('activeConversation: setActive/get 一 project 一活跃', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  setActiveConversation(db, proj.id, 'c1')
  assert.equal(getActiveConversationId(db, proj.id), 'c1')
  setActiveConversation(db, proj.id, 'c2')
  assert.equal(getActiveConversationId(db, proj.id), 'c2')
})

test('迁移:conversation 有 recap/summarizedUpTo 列', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'x' })
  const conv = listConversations(db, proj.id)[0]
  // 列存在 + 默认值
  const row = db.prepare('SELECT recap, summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.summarizedUpTo, 0); assert.equal(row.recap, null)
})

test('buildHistory: recap 在前 + summarizedUpTo 之后的全文消息', () => {
  const db = makeDb()
  createConversation(db, { projectId: 'p1', system: '', userMessage: 'x' })
  const conv = listConversations(db, 'p1')[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'old-q' })      // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old-a' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'new-q' })      // seq3
  // 设 recap 覆盖 seq1-2
  db.prepare('UPDATE workbench_conversations SET recap=?, summarizedUpTo=? WHERE id=?').run('老对话摘要', 2, conv.id)
  const conv2 = getConversation(db, conv.id)
  const h = buildHistory(db, conv2)
  assert.equal(h[0].role, 'system'); assert.match(h[0].content, /老对话摘要/)
  // 毒记忆事故加固(2026-08-31):recap 注入头带 caveat,以本轮实际工具/能力为准
  assert.ok(
    h[0].content.startsWith('Earlier in this conversation (summary; historical context only — trust current tools/capabilities over this):'),
    '注入头带 caveat',
  )
  assert.equal(h[1].role, 'user'); assert.equal(h[1].content, 'new-q')  // 只剩 seq3 全文
  assert.equal(h.length, 2)
})

// ── reasoning 持久化(R1:thinking 刷新/重进不丢)──
// 两表幂等加列(conv 级=流式检查点,消息级=终值);appendMessage 往返;启动抢救连 thinking 一起救。
test('reasoning 列:两表幂等迁移(重复建 schema 不抛)', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createWorkbenchSchema(db), '重复执行幂等')
  const convCol = db.prepare("SELECT name FROM pragma_table_info('workbench_conversations') WHERE name='reasoning'").get()
  const msgCol = db.prepare("SELECT name FROM pragma_table_info('workbench_messages') WHERE name='reasoning'").get()
  assert.ok(convCol, 'workbench_conversations.reasoning 列存在')
  assert.ok(msgCol, 'workbench_messages.reasoning 列存在')
})

test('appendMessage:reasoning 落库可读回;不传 → null(旧行为)', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  const conv = listConversations(db, proj.id)[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '答', reasoning: '思考过程' })
  const msgs = listMessages(db, conv.id)
  assert.equal(msgs[0].reasoning, null, 'user 消息无 reasoning')
  assert.equal(msgs[1].reasoning, '思考过程', 'assistant 消息 reasoning 读回')
})

test('salvageInterrupted:检查点含 reasoning → 补录消息连 thinking 一起救回', () => {
  const db = makeDb()
  createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
  const proj = db.prepare("SELECT id FROM workbench_projects WHERE name='p'").get()
  const c = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  appendMessage(db, { conversationId: c.id, role: 'user', content: 'q' })
  updateConversation(db, c.id, { content: '部分答案', reasoning: '部分思考' })
  salvageInterrupted(db)
  const last = listMessages(db, c.id).at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '部分答案')
  assert.equal(last.reasoning, '部分思考', 'thinking 随抢救保留')
})

// 启动抢救(2026-08-17 意外中断内容保全):网关重启时 running→failed,若流式检查点已写了
// conv.content 而末条消息不是 assistant(中断轮答案从未 append),补录为 assistant 消息——
// 否则重开对话时用户看着流出来的答案蒸发。
test('salvageInterrupted:有检查点内容且末条非 assistant → 补录;空内容/已录过 → 不动', () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
  const proj = db.prepare("SELECT id FROM workbench_projects WHERE name='p'").get()

  // 场景1:running + content 检查点 + 只有 user 消息 → failed + 补录 assistant
  const c1 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  appendMessage(db, { conversationId: c1.id, role: 'user', content: 'q' })
  updateConversation(db, c1.id, { content: '检查点救回的部分答案' })
  const salvaged = salvageInterrupted(db)
  const row1 = getConversation(db, c1.id)
  assert.equal(row1.status, 'failed', '标记失败')
  assert.match(row1.error, /Server restarted/)
  const msgs1 = listMessages(db, c1.id)
  assert.equal(msgs1.at(-1).role, 'assistant')
  assert.equal(msgs1.at(-1).content, '检查点救回的部分答案')
  assert.equal(salvaged, 1)

  // 场景2:running + 无 content(还没流出来就死了)→ 只标失败,不补录
  const c2 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q2' })
  appendMessage(db, { conversationId: c2.id, role: 'user', content: 'q2' })
  salvageInterrupted(db)
  assert.equal(listMessages(db, c2.id).length, 1, '无内容不补录')

  // 场景3:末条已是同内容 assistant(done 轮次遗留)→ 不重复补录
  const c3 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q3' })
  appendMessage(db, { conversationId: c3.id, role: 'user', content: 'q3' })
  updateConversation(db, c3.id, { content: '完整答案' })
  appendMessage(db, { conversationId: c3.id, role: 'assistant', content: '完整答案' })
  salvageInterrupted(db)
  assert.equal(listMessages(db, c3.id).length, 2, '已录过不重复')

  // 场景4:非 running 不碰
  const c4 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q4' })
  updateConversation(db, c4.id, { status: 'done', content: 'x' })
  const before4 = listMessages(db, c4.id).length
  salvageInterrupted(db)
  assert.equal(getConversation(db, c4.id).status, 'done')
  assert.equal(listMessages(db, c4.id).length, before4)
})

// ── 编辑重发 T1:按消息锚截断(spec §3.2)──
test('truncateFromMessage:中间锚点删其后全部(含后续 user/assistant),前缀保留', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'first' })
  const conv = listConversations(db, proj.id)[0]
  const m1 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
  const m3 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a2' })
  const r = truncateFromMessage(db, conv.id, m3.id)
  assert.equal(r.removed, 2, 'q2+a2 被删')
  assert.equal(r.fromSeq, m3.seq)
  const msgs = db.prepare('SELECT content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.deepEqual(msgs.map(m => m.content), ['q1', 'a1'], '前缀保留')
  assert.equal(r.keptMinSeq, m1.seq)
})

test('truncateFromMessage:首条锚全删 → keptMinSeq null;不存在/非 user → null', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'first' })
  const conv = listConversations(db, proj.id)[0]
  const m1 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
  const r = truncateFromMessage(db, conv.id, m1.id)
  assert.equal(r.removed, 2); assert.equal(r.keptMinSeq, null)
  assert.equal(truncateFromMessage(db, conv.id, 'no-such-id'), null)
  const a = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'x' })
  assert.equal(truncateFromMessage(db, conv.id, a.id), null, 'assistant 锚拒绝')
})

test('learningLedgerPath:绑定项目落集群 context;未绑定落 _platform 全局池', () => {
  const dir = '/wb'
  assert.deepEqual(learningLedgerPath(dir, { clusterId: 'ck-9' }), { dir: join(dir, 'ck-9', 'cluster-context'), file: 'learnings.md' })
  assert.deepEqual(learningLedgerPath(dir, { clusterId: '' }), { dir: join(dir, '_platform'), file: 'learnings.md' })
})

// ===== Task 1(2026-08-31 项目生命周期):deleteProject + setProjectRecap =====
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deleteProject, setProjectRecap, setLastReconcile, getLastReconcile } from './workbench-projects.mjs'

function makeWbDir() { return mkdtempSync(join(tmpdir(), 'wb-proj-del-')) }
// 带容器的 wbDir:逃逸目标可控落在 wbDir 之外、容器之内(不污染 /tmp 根)。
function makeWbDirContained() {
  const container = mkdtempSync(join(tmpdir(), 'wb-proj-del-ctl-'))
  const wbDir = join(container, 'wb')
  mkdirSync(wbDir)
  return { container, wbDir }
}

function seedProject(db, wbDir, { clusterId = 'c1' } = {}) {
  const p = createProject(db, { name: 'demo', clusterId, ownerId: 'u1' })
  const repo = projectRepoPath(wbDir, p)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'sentinel.txt'), 'keep')
  return { p, repo }
}

test('deleteProject:404(项目不存在)', () => {
  const db = makeDb()
  const r = deleteProject(db, { workbenchDir: makeWbDir(), projectId: 'nope' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
})

test('deleteProject:repo 路径逃逸拒绝 400,行与文件均在', () => {
  const db = makeDb()
  const { container, wbDir } = makeWbDirContained()
  try {
    const { p } = seedProject(db, wbDir)
    // repoRoot 非 'projects' 时路径走 legacy 分支(由 clusterId 派生)——clusterId 是落库字段,
    // 手工改库可把它指到 wbDir 之外;repoRoot 同步改成越界值覆盖双字段都被污染的形态。
    db.prepare("UPDATE workbench_projects SET repoRoot='../../escape', clusterId='../escape' WHERE id=?").run(p.id)
    const outside = resolve(wbDir, '../escape')   // = container/escape,在 wbDir 外、容器内
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'sentinel.txt'), 'x')
    const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
    assert.equal(r.ok, false)
    assert.equal(r.status, 400)
    assert.match(r.error, /escape/)
    assert.equal(getProject(db, p.id)?.id, p.id)           // 行未删
    assert.ok(existsSync(join(outside, 'sentinel.txt')))   // 外部文件未动
  } finally {
    rmSync(container, { recursive: true, force: true })
  }
})

test('deleteProject:双形态(新方案 projects/ 与存量 legacy)级联完整,目录删除', () => {
  for (const repoRoot of ['projects', null]) {
    const db = makeDb()
    const wbDir = makeWbDir()
    const { p, repo } = seedProject(db, wbDir, { clusterId: 'ck-1' })
    if (repoRoot === null) db.prepare('UPDATE workbench_projects SET repoRoot=NULL WHERE id=?').run(p.id)
    const legacyRepo = projectRepoPath(wbDir, getProject(db, p.id))
    if (repoRoot === null) { mkdirSync(legacyRepo, { recursive: true }); writeFileSync(join(legacyRepo, 'sentinel.txt'), 'x') }
    const target = repoRoot === null ? legacyRepo : repo
    const c1 = createConversation(db, { projectId: p.id, userMessage: 'q1' })
    const c2 = createConversation(db, { projectId: p.id, userMessage: 'q2' })
    appendMessage(db, { conversationId: c1.id, role: 'user', content: 'm1' })
    appendMessage(db, { conversationId: c1.id, role: 'assistant', content: 'a1' })
    appendMessage(db, { conversationId: c2.id, role: 'user', content: 'm2' })
    appendMessage(db, { conversationId: c2.id, role: 'assistant', content: 'a2' })
    appendHistory(db, p.id, 'user', 'h1')
    const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
    assert.equal(r.ok, true)
    assert.equal(r.removedConversations, 2)   // 对话数(2 对话,精确断言:计数语义=对话行)
    assert.equal(r.removedMessages, 4)        // 消息数另出字段(2 对话各 2 消息)
    assert.equal(r.repoRemoved, true)
    assert.equal(getProject(db, p.id), null)
    assert.equal(getConversation(db, c1.id), null)
    assert.equal(getConversation(db, c2.id), null)
    assert.equal(listMessages(db, c1.id).length, 0)
    assert.equal(recentHistory(db, p.id).length, 0)   // history 一并清
    assert.ok(!existsSync(target))
  }
})

test('deleteProject:running 状态对话行也被删', () => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p } = seedProject(db, wbDir)
  const c = createConversation(db, { projectId: p.id, userMessage: 'run' })
  assert.equal(getConversation(db, c.id).status, 'running')
  const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
  assert.equal(r.ok, true)
  assert.equal(getConversation(db, c.id), null)
})

test('deleteProject:rmSync 失败置 repoError 但 ok 仍真(事务不回滚)', () => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p, repo } = seedProject(db, wbDir)
  const c = createConversation(db, { projectId: p.id, userMessage: 'x' })
  // 可移植失败注入:repo 内含哨兵文件 + 目录本身 chmod 0500 → 非 root 下 rmSync 抛 EACCES。
  // (CI/Docker 走非 root;本机 root 跑测试时 chmod 不拦截,退化为 repoRemoved=true,同样断言 ok。)
  chmodSync(repo, 0o500)
  let r
  try {
    r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
  } finally {
    try { chmodSync(repo, 0o700) } catch { /* 已被删 */ }
    rmSync(repo, { recursive: true, force: true })
  }
  assert.equal(r.ok, true)                       // fs 失败不影响 ok
  assert.equal(getProject(db, p.id), null)       // 事务已提交,不回滚
  assert.equal(getConversation(db, c.id), null)
  if (existsSync(repo)) {                        // rmSync 确实失败的分支(root 下跳过)
    assert.ok(r.repoError, 'repoError 必须携带失败原因')
    assert.equal(r.repoRemoved, false)
  }
})

test('deleteProject:repo 目录本就不存在(已被人手删)→ force 静默,ok=true', () => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p, repo } = seedProject(db, wbDir)
  rmSync(repo, { recursive: true, force: true })
  const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
  assert.equal(r.ok, true)
  assert.equal(getProject(db, p.id), null)
})

test('setProjectRecap:空串清空归零水位;非空覆写不动水位;超长 400', () => {
  const db = makeDb()
  const p = createProject(db, { name: 'r', clusterId: 'c1', ownerId: 'u1' })
  db.prepare('UPDATE workbench_projects SET historyWatermark=42 WHERE id=?').run(p.id)
  assert.equal(setProjectRecap(db, p.id, '人工摘要 v1').ok, true)
  assert.equal(getProject(db, p.id).projectRecap, '人工摘要 v1')
  assert.equal(getProject(db, p.id).historyWatermark, 42)   // 覆写不动水位
  assert.equal(setProjectRecap(db, p.id, '').ok, true)
  const after = getProject(db, p.id)
  assert.equal(after.projectRecap, null)
  assert.equal(after.historyWatermark, 0)                   // 清空归零
  const too = setProjectRecap(db, p.id, 'x'.repeat(65537))
  assert.equal(too.ok, false)
  assert.equal(too.status, 400)
  assert.equal(setProjectRecap(db, p.id, 'x'.repeat(65536)).ok, true)  // 边界值恰好通过
})

// 终审 I1:last_reconcile 以 projectId 为键,不级联 → 删除后成永久孤儿行
test('deleteProject:级联含 last_reconcile——项目行删除后无孤儿,他项目行不动', () => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p } = seedProject(db, wbDir)
  const other = createProject(db, { name: 'keep-me', clusterId: 'c1', ownerId: 'u1' })
  setLastReconcile(db, p.id, { ok: true, applied: 3 })
  setLastReconcile(db, other.id, { ok: false })
  assert.equal(getLastReconcile(db, p.id).result.applied, 3, '播种成功')

  const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
  assert.equal(r.ok, true)
  assert.equal(getLastReconcile(db, p.id), null, '被删项目的 last_reconcile 一并清')
  assert.ok(getLastReconcile(db, other.id), '他项目的 last_reconcile 不受影响')
})

// 终审 I2:rmSync 失败必须落 stderr(ops 文档承诺「日志有记录」),不许全静默。
// removeDir 注入 = 可移植失败注入(chmod 方案在 root 下退化为不失败,断言不到日志)。
test('deleteProject:repo 目录删除失败 → console.error 落日志 + repoError 仍透传 + ok 真', (t) => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p } = seedProject(db, wbDir)
  const logs = []
  const errMock = t.mock.method(console, 'error', (...a) => logs.push(a.map(String).join(' ')))

  const r = deleteProject(db, {
    workbenchDir: wbDir, projectId: p.id,
    removeDir: () => { throw new Error('EBUSY: resource busy') },
  })

  assert.equal(r.ok, true)                                  // fs 失败不影响 ok(数据已提交)
  assert.match(r.repoError, /EBUSY/)
  assert.equal(r.repoRemoved, false)
  assert.equal(errMock.mock.callCount(), 1, '恰好一条 error 日志')
  assert.match(logs[0], /\[workbench\] 项目 repo 目录删除失败/, '带定位前缀')
  assert.match(logs[0], /EBUSY/, '日志含失败原因(运维可据此跟进孤儿目录)')
})

// removeDir 注入默认值=rmSync(生产路径零变化):不注入时目录确实被删
test('deleteProject:默认 removeDir 走 rmSync,目录被清除', () => {
  const db = makeDb()
  const wbDir = makeWbDir()
  const { p, repo } = seedProject(db, wbDir)
  const r = deleteProject(db, { workbenchDir: wbDir, projectId: p.id })
  assert.equal(r.ok, true)
  assert.equal(r.repoRemoved, true)
  assert.ok(!existsSync(repo))
})
