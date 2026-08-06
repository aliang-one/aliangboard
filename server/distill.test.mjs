// distill 核心测试:gather / buildPrompt / runDistill(内存 db + 临时 ledger repo + mock llmClient)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { createWorkbenchSchema, createProject, appendHistory } from './workbench-projects.mjs'
import { initRepo, writeFile } from './workbench-repos.mjs'
import { gatherDistillMaterial, buildDistillPrompt, runDistill } from './distill.mjs'

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
