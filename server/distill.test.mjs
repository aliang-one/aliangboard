// distill 核心测试:gather / buildPrompt / runDistill(内存 db + 临时 ledger repo + mock llmClient)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { createWorkbenchSchema, createProject, appendHistory, setLastDistill, getLastDistill } from './workbench-projects.mjs'
import { initRepo, writeFile } from './workbench-repos.mjs'
import { gatherDistillMaterial, buildDistillPrompt, runDistill, isNewMaterial } from './distill.mjs'

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), `wb-distill-${Date.now()}-`))
  await initRepo(dir)
  return dir
}
function makeDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  createWorkbenchSchema(db)
  return db
}

test('gatherDistillMaterial:按集群收 audit + history(项目映射)+ 当前台账', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    const p = createProject(db, { name: 'ci', clusterId: 'c1', ownerId: 'u1' })
    appendHistory(db, p.id, 'user', '怎么扩容 nginx')
    appendHistory(db, p.id, 'assistant', '用 scale 工具')
    writeAudit(db, { clusterId: 'c1', tool: 'scale', resource: 'deployments/nginx', namespace: 'default', result: 'ok', requestSummary: 'replicas=3' })
    writeAudit(db, { clusterId: 'c2', tool: 'list_resources', resource: 'pods', namespace: 'other', result: 'ok' }) // 别的集群,不该收
    await writeFile(repo, 'learnings.md', '# Learnings\n- 旧条目\n')
    await writeFile(repo, 'INDEX.md', '# c1 能力地图\n')

    const m = await gatherDistillMaterial(db, 'c1', repo)
    assert.equal(m.audit.length, 1, '只收 c1 的 audit')
    assert.equal(m.audit[0].tool, 'scale')
    assert.equal(m.history.length, 2, '只收 c1 项目的 history')
    assert.ok(m.currentLearnings.includes('旧条目'))
    assert.ok(m.currentIndex.includes('能力地图'))
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('buildDistillPrompt:含集群名 / audit seq / 对话内容 / 当前 learnings', async () => {
  const m = {
    audit: [{ seq: 7, tool: 'scale', resource: 'deployments/x', namespace: 'default', result: 'ok' }],
    history: [{ role: 'user', content: '怎么扩容', projectName: 'ci' }],
    currentLearnings: '# Learnings\n- 旧\n',
    currentIndex: '# idx\n',
  }
  const [sys, user] = buildDistillPrompt(m, 'prod')
  assert.ok(sys.content.includes('绝不发明') && sys.content.includes('证据'), '铁律在 system')
  assert.ok(user.content.includes('prod'), '集群名')
  assert.ok(user.content.includes('#7') && user.content.includes('scale'), 'audit seq + tool')
  assert.ok(user.content.includes('怎么扩容'), '对话内容')
  assert.ok(user.content.includes('旧'), '当前 learnings')
})

test('runDistill:mock LLM 返回 → 剥围栏 → summary/stats', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
    writeAudit(db, { clusterId: 'c1', tool: 'scale', resource: 'deployments/x', namespace: 'default', result: 'ok' })
    const llmClient = { chat: async () => ({ content: '```markdown\n# Learnings\n- 用 scale 扩容 _(证据: audit#1; 置信度: 高)_\n```' }) }
    const out = await runDistill({ llmClient, db, clusterId: 'c1', ledgerRepo: repo, clusterName: 'prod' })
    assert.ok(out.proposed.startsWith('# Learnings'), '围栏已剥')
    assert.ok(out.proposed.includes('audit#1') && out.proposed.includes('置信度'), '带证据')
    assert.ok(!out.proposed.includes('```'), '无残留围栏')
    assert.equal(out.summary, '1 条 learnings')
    assert.equal(out.stats.audit, 1)
    assert.equal(out.stats.learnedLines, 1)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('runDistill:空原料(新集群)也跑通,不抛', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    const llmClient = { chat: async () => ({ content: '# Learnings\n\n(暂无可蒸馏知识)\n' }) }
    const out = await runDistill({ llmClient, db, clusterId: 'c-empty', ledgerRepo: repo, clusterName: 'empty' })
    assert.equal(out.stats.audit, 0)
    assert.equal(out.stats.history, 0)
    assert.equal(out.stats.hadLearnings, false)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('gather:started 行不计(只 finalized);audit 带 source/owner 归因;水位线返回', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    const p = createProject(db, { name: 'ci', clusterId: 'c1', ownerId: 'u1' })
    appendHistory(db, p.id, 'user', 'q1')
    // finalized(workbench) + started(reserve 伴随行) + finalized(mcp)
    const fin1 = writeAudit(db, { clusterId: 'c1', owner: 'admin-liang', tool: 'wb_scale', resource: 'deployments/nginx', result: 'ok', source: 'workbench' })
    writeAudit(db, { clusterId: 'c1', owner: 'admin-liang', tool: 'wb_scale', result: null, source: 'workbench', status: 'started' })
    const fin2 = writeAudit(db, { clusterId: 'c1', owner: 'alice', tool: 'scale', resource: 'deployments/nginx', result: 'denied', reason: 'policy', source: 'mcp' })
    const m = await gatherDistillMaterial(db, 'c1', repo)
    assert.equal(m.audit.length, 2, 'started 行不计,只 2 条 finalized')
    assert.equal(m.watermark.maxAuditSeq, Math.max(Number(fin1.seq), Number(fin2.seq)), '水位=最大 audit seq')
    assert.ok(m.watermark.lastHistoryTs > 0, '水位含最新 history ts')
    const prompt = buildDistillPrompt(m, 'c1')
    assert.ok(prompt[1].content.includes('workbench:admin-liang'), '归因含 source:owner')
    assert.ok(prompt[1].content.includes('mcp:alice'))
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('gather:超长 history 单条截断 + 超长 INDEX 整体截断(learnings 不截)', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    const p = createProject(db, { name: 'ci', clusterId: 'c1', ownerId: 'u1' })
    appendHistory(db, p.id, 'user', '长'.repeat(3000))
    await writeFile(repo, 'INDEX.md', '# idx\n' + 'x'.repeat(20000))
    await writeFile(repo, 'learnings.md', '- ' + '知'.repeat(20000) + '\n')
    const m = await gatherDistillMaterial(db, 'c1', repo)
    assert.ok(m.history[0].content.length <= 810, 'history 单条截断(800+省略号)')
    assert.ok(m.currentIndex.length <= 8100, 'INDEX 截断')
    assert.ok(m.currentIndex.includes('截断'))
    assert.equal(m.currentLearnings.length, '- '.length + 20000 + 1, 'learnings 完整不截(去重要看全)')
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('isNewMaterial:从未蒸馏→true;水位一致→false;新 audit/新对话→true', () => {
  assert.equal(isNewMaterial({ maxAuditSeq: 5, lastHistoryTs: 100 }, null), true, '无 last → 蒸')
  assert.equal(isNewMaterial({ maxAuditSeq: 5, lastHistoryTs: 100 }, { watermark: { maxAuditSeq: 5, lastHistoryTs: 100 } }), false, '水位一致 → 跳过')
  assert.equal(isNewMaterial({ maxAuditSeq: 6, lastHistoryTs: 100 }, { watermark: { maxAuditSeq: 5, lastHistoryTs: 100 } }), true, '新 audit → 蒸')
  assert.equal(isNewMaterial({ maxAuditSeq: 5, lastHistoryTs: 200 }, { watermark: { maxAuditSeq: 5, lastHistoryTs: 100 } }), true, '新对话 → 蒸')
  assert.equal(isNewMaterial({ maxAuditSeq: 0, lastHistoryTs: 0 }, {}), true, 'last 无 watermark 字段 → 蒸')
})

test('runDistill:material 预制传入 → 不再查库(调度器 gather 一次复用)', async () => {
  const db = makeDb()
  const repo = await freshRepo()
  try {
    const material = await gatherDistillMaterial(db, 'c1', repo)
    let llmSawAuditLines = ''
    const llmClient = { chat: async ({ messages }) => { llmSawAuditLines = messages[1].content; return { content: '# Learnings\n- ok _(证据: audit#9; 置信度: 高)_\n' } } }
    await runDistill({ llmClient, db, clusterId: 'c1', clusterName: 'x', material })
    assert.ok(llmSawAuditLines.includes('(无)'), '预制空 material 的 audit 段显示 (无)')
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('last_distills 水位落库/读回(pending 审掉后仍可判跳过)', () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  assert.equal(getLastDistill(db, 'c1'), null, '未蒸馏过 → null')
  setLastDistill(db, 'c1', { learnedLines: 3, watermark: { maxAuditSeq: 9, lastHistoryTs: 100 } })
  const last = getLastDistill(db, 'c1')
  assert.equal(last.stats.watermark.maxAuditSeq, 9)
  assert.ok(last.ts > 0)
  setLastDistill(db, 'c1', { learnedLines: 4, watermark: { maxAuditSeq: 12, lastHistoryTs: 100 } }) // 覆盖
  assert.equal(getLastDistill(db, 'c1').stats.watermark.maxAuditSeq, 12)
})
