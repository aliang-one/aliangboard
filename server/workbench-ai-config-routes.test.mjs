// workbench-ai-config 端点契约(admin GET/PUT + 用户 GET;2026-08-25 设计)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import { createWorkbenchSchema, createConversation, getConversation } from './workbench-projects.mjs'

const U = p => new URL(p, 'http://x')

function baseDb(settings = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )')
  for (const [k, v] of Object.entries(settings)) db.prepare('INSERT OR REPLACE INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v), Date.now())
  return db
}

function adminHarness({ settings, body } = {}) {
  const db = baseDb(settings)
  const sent = []
  const routes = createAdminRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => body || {},
    requireAdmin: (rq, rs) => ({ userId: 'u1', username: 't', role: 'admin' }),
    getSetting: k => db.prepare('SELECT value FROM platform_settings WHERE key=?').get(k)?.value ?? null,
    setSetting: (k, v) => db.prepare('INSERT OR REPLACE INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v ?? ''), Date.now()),
    getLlmConfig: () => ({ baseURL: 'http://x', apiKey: '', model: 'm' }),
    createLlmClient: () => { throw new Error('unused') },
    probeReasoningSupport: async () => ({}),
    clusterProber: async () => [], randomUUID: () => 'id',
    parseKubeconfig: () => { throw new Error('unused') }, certMaterial: () => ({}), normalizeServer: s => s,
    buildCallContext: () => ({}), requestKubernetes: async () => ({}), hashPassword: () => 'h',
  })
  return { routes, sent, db }
}

test('admin GET:默认值 + toolCatalog 含 promptHint + effectivePreview 为拼装产物', async () => {
  const { routes, sent } = adminHarness()
  await routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(sent[0].status, 200)
  const j = sent[0].json
  assert.deepEqual(j.disabledTools, [])
  assert.equal(j.additionalInstructions, '')
  assert.ok(j.toolCatalog.some(t => t.name === 'wb_exec' && t.promptHint && t.requiresApproval === true))
  assert.ok(j.effectivePreview.includes('先调查,再行动'))
})

test('admin PUT:合法落库 → GET 读回;预览反映追加指令', async () => {
  const { routes, sent } = adminHarness({ body: { additionalInstructions: '生产谨慎', disabledTools: ['wb_exec'] } })
  await routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(sent[0].status, 200)
  await routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  const j = sent[1].json
  assert.deepEqual(j.disabledTools, ['wb_exec'])
  assert.ok(j.effectivePreview.includes('生产谨慎'))
  assert.ok(!j.effectivePreview.includes('**wb_exec**'))
})

test('admin PUT:未知名 → 400;非数组 → 400', async () => {
  const a = adminHarness({ body: { disabledTools: ['nope'] } })
  await a.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[0].status, 400)
  const b = adminHarness({ body: { disabledTools: 'wb_exec' } })
  await b.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[0].status, 400)
})

function userHarness({ settings, body } = {}) {
  const db = baseDb(settings)
  createWorkbenchSchema(db)
  const sent = []
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => body || {},
    requireAdmin: (rq, rs) => ({ userId: 'u1', username: 't', role: 'user' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {} }, getLlmConfig: () => ({ baseURL: 'http://x', apiKey: 'SECRET', model: 'm7' }),
    createLlmClient: () => ({}), buildCallContext: () => ({}), requestKubernetes: async () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null, busDispose: () => {},
  })
  return { routes, sent, db }
}

test('用户 GET /api/workbench/ai-config:生效提示词 + enabled 标记 + model;不回 baseURL/apiKey', async () => {
  const { routes, sent } = userHarness({ settings: { 'workbench.disabledTools': JSON.stringify(['wb_exec']) } })
  await routes.handle({ method: 'GET' }, null, U('/api/workbench/ai-config'))
  assert.equal(sent[0].status, 200)
  const j = sent[0].json
  assert.ok(j.effectivePrompt.includes('先调查,再行动'))
  assert.ok(!j.effectivePrompt.includes('**wb_exec**'))
  const ex = j.tools.find(t => t.name === 'wb_exec')
  assert.equal(ex.enabled, false); assert.equal(ex.requiresApproval, true)
  assert.equal(j.model, 'm7')
  assert.ok(!('baseURL' in j) && !('apiKey' in j), '不泄漏连接配置')
})

test('GET /:id 出参含 system(逐对话审计)', async () => {
  const { routes, sent, db } = userHarness()
  // 按 brief 注记:workbench_projects 表若外键受限,先插入一行(列以 workbench-projects.mjs 实际建表为准)
  const hasProject = db.prepare('SELECT id FROM workbench_projects LIMIT 1').get()
  if (!hasProject) {
    db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES (?,?,?,?,?)')
      .run('p1', 'test-project', 'c1', 'u1', Date.now())
  }
  const p = db.prepare('SELECT id FROM workbench_projects LIMIT 1').get()
  const conv = createConversation(db, { projectId: p.id, system: 'SYS_PROMPT_SNAPSHOT', userMessage: 'hi' })
  await routes.handle({ method: 'GET' }, null, U(`/api/workbench/conversations/${conv.id}`))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].json.system, 'SYS_PROMPT_SNAPSHOT')
})

test('POST /conversations:创建时烘焙 buildWorkbenchSystemPrompt(getWorkbenchAiConfig) 入 conv.system', async () => {
  const { routes, sent, db } = userHarness({
    settings: {
      'workbench.additionalInstructions': 'SMOKE_EXTRA_MARKER',
      'workbench.disabledTools': JSON.stringify(['wb_exec']),
    },
    body: { projectId: 'p1', message: 'hi' },
  })
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES (?,?,?,?,?)')
    .run('p1', 'smoke-project', 'c1', 'u1', Date.now())
  await routes.handle({ method: 'POST' }, null, U('/api/workbench/conversations'))
  assert.equal(sent[0].status, 200)
  const system = getConversation(db, sent[0].json.id).system
  assert.ok(system.includes('SMOKE_EXTRA_MARKER'), '追加指令烘焙进 system')
  assert.ok(!system.includes('**wb_exec**'), '禁用工具不出现于 system 工具清单')
})

// ===== 最大执行步数(2026-09-03):GET 回显已解析值;PUT 缺省不改/0=不限制/非法 400 =====
test('admin GET:回显 maxSteps(缺省 16)', async () => {
  // 路由内部 getMaxStepsConfig(db) 未传 env → 读真实 process.env.WB_MAX_STEPS;
  // deployment.yaml 教用户设这个 env,设了的机器测试会红 → 本用例内临时摘除并恢复
  const savedEnv = process.env.WB_MAX_STEPS
  delete process.env.WB_MAX_STEPS
  try {
    const { routes, sent } = adminHarness()
    await routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
    assert.equal(sent[0].status, 200)
    assert.equal(sent[0].json.maxSteps, 16)
  } finally {
    if (savedEnv !== undefined) process.env.WB_MAX_STEPS = savedEnv
  }
})

test('admin PUT:maxSteps 30 落库读回;0=不限制读回 0', async () => {
  const a = adminHarness({ body: { maxSteps: 30 } })
  await a.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[0].status, 200)
  await a.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[1].json.maxSteps, 30)

  const b = adminHarness({ body: { maxSteps: 0 } })
  await b.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[0].status, 200)
  await b.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[1].json.maxSteps, 0)
})

test('admin PUT:maxSteps 缺省不修改旧值;非法 → 400 双语文案(zh 无头默认)', async () => {
  const a = adminHarness({ settings: { 'workbench.maxSteps': '30' }, body: { additionalInstructions: 'x' } })
  await a.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[0].status, 200)
  await a.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[1].json.maxSteps, 30, '缺 maxSteps 键 → 不修改')

  const b = adminHarness({ body: { maxSteps: 999 } })
  await b.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[0].status, 400)
  assert.equal(b.sent[0].json.message, '最大执行步数必须是 0-200 的整数(0 = 不限制)')
})
