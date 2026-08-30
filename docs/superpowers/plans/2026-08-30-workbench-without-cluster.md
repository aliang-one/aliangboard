# 工作台无集群可用 + 项目后绑集群 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 没有集群的用户也能建项目用工作台(对话/项目文件草稿/SSH 运维/知识沉淀),项目建后随时绑集群即时解锁全部 K8s 工具。

**Architecture:** 「未绑定」以 `clusterId=''` 哨兵表达(免 NOT NULL 表重建);repo 路径方案由新列 `repoRoot` 在创建时定格(新项目 `projects/<id>` 与集群解耦,存量旧路径不动);`buildWbCtx` 对未绑定项目出 `_platform` learnings 池 + 引导文案;工具可见性经纯函数 `workbenchExcludeTools` per-run 裁剪;绑定端点 `PUT /api/workbench/projects/:id/cluster` 仅改 clusterId 一列。

**Tech Stack:** 零依赖纯逻辑 + node:test(spawn 真网关)、vitest + @vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-08-30-workbench-without-cluster-design.md`

## Global Constraints

- 零新增外部依赖;提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Co-Authored-By 尾注,禁改写已推送历史
- 未绑定哨兵 = `clusterId === ''`(JS falsy,贯通既有降级分支);**禁止**改用 NULL 或重建表
- 存量项目(repoRoot NULL)路径永不变化:`<WORKBENCH_DIR>/<clusterId>/projects/<id>`;新项目恒 `<WORKBENCH_DIR>/projects/<projectId>`,绑/换/解绑都不搬家
- 未绑定项目排除恰 16 个 K8s 依赖工具名(名单见 Task 3,与 SSH 零暴露 4 工具集叠加);工具裁剪 per-run 现算(权限回收语义)
- 绑定端点:admin 或项目 owner;目标集群必须存在;解绑不动 manifests/repo/对话;动作进审计(verb 'write', tool 'workbench_project_cluster')
- 所有 UI 文案 zh/en 双语;`npm run i18n:check` 六项全 0 是门禁
- 每任务红→绿→提交;提交 git add 只点名文件(仓库多会话并行)

---

### Task 1: repoRoot 列 + projectRepoPath 单源 + 建项目 clusterId 可选

**Files:**
- Modify: `server/workbench-projects.mjs`(schema try-ALTER、createProject、新导出 projectRepoPath)
- Modify: `server/routes/workbench-projects.mjs`(POST 校验放宽、两处 repo 路径改走 helper)
- Test: `server/workbench-projects.test.mjs`(既有文件追加;不存在则新建)

**Interfaces:**
- Produces:
  - `projectRepoPath(workbenchDir, project)` → 绝对路径字符串。`project.repoRoot === 'projects'` → `join(workbenchDir,'projects',project.id)`;否则(存量 NULL)→ `join(workbenchDir, project.clusterId, 'projects', project.id)`
  - `createProject(db, { name, clusterId, ownerId })`:clusterId 缺省时写 `''`;新项目恒 `repoRoot='projects'`(INSERT 列表加 repoRoot)
- 消费方(本任务内改):routes POST(建 repo)与 `:id` 分支(第 93 行 `const repo = join(WORKBENCH_DIR, p.clusterId, 'projects', p.id)`)

- [ ] **Step 1: 写失败测试**(追加到 `server/workbench-projects.test.mjs`;若该文件不存在,先看 `server/workbench-projects` 相关既有测试文件名——`grep -l "createProject" server/*.test.mjs`,追加到实际存在的那个;都没有则新建,骨架照 `server/ssh/store.test.mjs`:内存库 `new DatabaseSync(':memory:')` + `createWorkbenchSchema(db)`):

```js
test('projectRepoPath:repoRoot 定格路径方案——新项目绑集群前后同路径,存量走旧路径', () => {
  const dir = '/wb'
  assert.equal(projectRepoPath(dir, { id: 'p1', clusterId: '', repoRoot: 'projects' }), join(dir, 'projects', 'p1'))
  assert.equal(projectRepoPath(dir, { id: 'p1', clusterId: 'ck-9', repoRoot: 'projects' }), join(dir, 'projects', 'p1'))  // 绑集群后不变
  assert.equal(projectRepoPath(dir, { id: 'p2', clusterId: 'ck-9', repoRoot: null }), join(dir, 'ck-9', 'projects', 'p2'))  // 存量
})

test('createProject:clusterId 缺省写哨兵空串;repoRoot 恒 projects;带 clusterId 时照旧', () => {
  const db = new DatabaseSync(':memory:'); createWorkbenchSchema(db)
  const unbound = createProject(db, { name: 'u1', ownerId: 'user-1' })
  assert.equal(unbound.clusterId, '')
  assert.equal(unbound.repoRoot, 'projects')
  const bound = createProject(db, { name: 'b1', clusterId: 'ck-1', ownerId: 'user-1' })
  assert.equal(bound.clusterId, 'ck-1')
  assert.equal(bound.repoRoot, 'projects')
})
```

- [ ] **Step 2: 跑红**:`node --test server/workbench-projects.test.mjs` → FAIL(projectRepoPath 未导出 / repoRoot 无此列)

- [ ] **Step 3: 实现** — `workbench-projects.mjs`:

schema 段加一行 try-ALTER(置于既有 projectRecap/historyWatermark ALTER 之后,守「ALTER 在 CREATE 后」教训):

```js
  // repo 路径方案(2026-08-30 无集群工作台 spec §2.2):'projects'=新方案 <dir>/projects/<id>;NULL=存量旧方案 <dir>/<clusterId>/projects/<id>
  try { db.exec("ALTER TABLE workbench_projects ADD COLUMN repoRoot TEXT DEFAULT NULL") } catch { /* 列已存在 */ }
```

`createProject` 改:

```js
export function createProject(db, { name, clusterId, ownerId }) {
  if (!name || !ownerId) throw new Error('createProject 缺 name / ownerId')
  const id = randomUUID()
  const createdAt = Date.now()
  // clusterId 可空(2026-08-30 spec §2.1):缺省 ''=未绑定哨兵(falsy 贯通既有降级);repoRoot 恒新方案
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt,repoRoot) VALUES (?,?,?,?,?,?)')
    .run(id, name, clusterId || '', ownerId, createdAt, 'projects')
  return getProject(db, id)
}
```

新导出:

```js
// repo 路径唯一事实源(spec §2.2):repoRoot 在创建时定格,绑/换/解绑集群都不动文件
export function projectRepoPath(workbenchDir, project) {
  return project.repoRoot === 'projects'
    ? join(workbenchDir, 'projects', project.id)
    : join(workbenchDir, project.clusterId, 'projects', project.id)
}
```

(`join` 从 'node:path' import;文件若无则加。)

- [ ] **Step 4: 改 routes** — `server/routes/workbench-projects.mjs`:
  - import `projectRepoPath`(从 `../workbench-projects.mjs`)
  - POST 校验行 `if (!input.name || !input.clusterId)` 改 `if (!input.name)`;其下集群存在性校验包进 `if (input.clusterId) { … }`(给了才校验)
  - POST 内 `const repo = join(WORKBENCH_DIR, p.clusterId, 'projects', p.id)` 改 `const repo = projectRepoPath(WORKBENCH_DIR, p)`
  - `:id` 分支(原 93 行)同款替换 `const repo = projectRepoPath(WORKBENCH_DIR, p)`
  - grep 本文件其余 `join(WORKBENCH_DIR` 确认无第三处遗漏

- [ ] **Step 5: 跑绿**:`node --test server/workbench-projects.test.mjs` 全 PASS;`npm run test:server` 全绿(既有 wb spawn 用例证明旧项目路径未破坏)

- [ ] **Step 6: 提交**

```bash
git add server/workbench-projects.mjs server/workbench-projects.test.mjs server/routes/workbench-projects.mjs
git commit -m "feat(workbench): 建项目不再强制集群——clusterId '' 哨兵+repoRoot 定格路径方案,projectRepoPath 单源(存量路径不动)"
```

---

### Task 2: buildWbCtx 无集群语义(learnings 平台池 + 引导文案)

**Files:**
- Modify: `server/workbench-projects.mjs`(新导出 `learningLedgerPath`)
- Modify: `server/index.mjs` `buildWbCtx`(约 1186-1210:repo/ledgerRepo 两行、readLedger/appendLearning 两闭包)
- Test: `server/workbench-projects.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 1 `projectRepoPath`
- Produces:
  - `learningLedgerPath(workbenchDir, project)` → `{ dir, file }`:`project.clusterId` truthy → `{ dir: join(dir, project.clusterId, 'cluster-context'), file: 'learnings.md' }`;否则 `{ dir: join(dir, '_platform'), file: 'learnings.md' }`
  - buildWbCtx 内:`repo = projectRepoPath(WORKBENCH_DIR, project)`;`ledgerRepo = project.clusterId ? join(WORKBENCH_DIR, project.clusterId, 'cluster-context') : join(WORKBENCH_DIR, '_platform')`;`readLedger` 无集群时返回引导文案

- [ ] **Step 1: 写失败测试**(追加):

```js
test('learningLedgerPath:绑定项目落集群 context;未绑定落 _platform 全局池', () => {
  const dir = '/wb'
  assert.deepEqual(learningLedgerPath(dir, { clusterId: 'ck-9' }), { dir: join(dir, 'ck-9', 'cluster-context'), file: 'learnings.md' })
  assert.deepEqual(learningLedgerPath(dir, { clusterId: '' }), { dir: join(dir, '_platform'), file: 'learnings.md' })
})
```

- [ ] **Step 2: 跑红**:`node --test server/workbench-projects.test.mjs` → FAIL

- [ ] **Step 3: 实现** — `learningLedgerPath` 导出(紧邻 projectRepoPath):

```js
// 台账 learnings 落点(spec §2.3):绑定项目归集群 cluster-context;未绑定归平台级 _platform 全局池(历史不搬迁)
export function learningLedgerPath(workbenchDir, project) {
  return project.clusterId
    ? { dir: join(workbenchDir, project.clusterId, 'cluster-context'), file: 'learnings.md' }
    : { dir: join(workbenchDir, '_platform'), file: 'learnings.md' }
}
```

`server/index.mjs` buildWbCtx 内:

- `const repo = join(WORKBENCH_DIR, project.clusterId, 'projects', project.id)` → `const repo = projectRepoPath(WORKBENCH_DIR, project)`(import 加 `projectRepoPath, learningLedgerPath`,从 './workbench-projects.mjs')
- `const ledgerRepo = join(WORKBENCH_DIR, project.clusterId, 'cluster-context')` →

```js
    const learn = learningLedgerPath(WORKBENCH_DIR, project)
    const ledgerRepo = project.clusterId ? join(WORKBENCH_DIR, project.clusterId, 'cluster-context') : learn.dir
```

- `readLedger` 闭包首行加未绑定短路(在两个 try 之前):

```js
        readLedger: async () => {
          if (!project.clusterId) return '(项目未绑定集群:可写 manifests 草稿、SSH 服务器运维;绑定集群后此处为集群能力台账)'
          let out = ''
```

(纵深兜底:`read_ledger` 工具在未绑定项目已被 excludeTools 裁剪,正常路径调不到——spec §2.3。)
- `appendLearning` 闭包:未绑定写平台池。现实现读改 `ledgerRepo`;改为:

```js
        appendLearning: async (content) => {
          const learn = learningLedgerPath(WORKBENCH_DIR, project)
          let prev = ''; try { prev = await wbReadFile(learn.dir, learn.file) } catch {}
          await wbWriteFile(learn.dir, learn.file, (prev && prev.trim() ? prev.trimEnd() + '\n' : '# Learnings\n\n') + `- ${content}\n`)
        },
```

(若 wbWriteFile 自动建目录则直接用;若不建,在调用前 `mkdirSync(learn.dir, { recursive: true })`——以 wbWriteFile 实际行为为准,实现者核验。)

- [ ] **Step 4: 跑绿**:`node --test server/workbench-projects.test.mjs` 全 PASS;`npm run test:server` 全绿

- [ ] **Step 5: 提交**

```bash
git add server/workbench-projects.mjs server/workbench-projects.test.mjs server/index.mjs
git commit -m "feat(workbench): buildWbCtx 无集群语义——repo 走单源,learnings 未绑定落 _platform 全局池,readLedger 引导文案兜底"
```

---

### Task 3: workbenchExcludeTools 纯函数 + runConversation 接线

**Files:**
- Modify: `server/tool-registry.mjs`(新导出)
- Modify: `server/workbench-agent.mjs`(runConversation 的 excludeTools,约 165 行)
- Test: `server/tool-registry.test.mjs`(若文件名不同,`grep -l "workbenchToolDefs" server/*.test.mjs` 找实际宿主追加)

**Interfaces:**
- Produces: `workbenchExcludeTools({ hasCluster, sshExposedCount })` → `Set<string> | null`(null=不排除);`hasCluster=false` → 并入 16 工具名:`wb_list_resources, wb_get_pod_logs, wb_describe_resource, wb_get_resource, wb_get_events, wb_rollout_status, wb_read_pod_file, wb_top, wb_scale, wb_restart, wb_update_image, wb_rollout_undo, wb_exec, bootstrap_ledger, apply_project_manifests, read_ledger`;`sshExposedCount === 0` → 并入 `wb_ssh_exec, wb_ssh_read_file, read_server_ledger, write_server_notes`;两条件都不中 → `null`
- 消费方:workbench-agent.mjs 现行 `excludeTools: exposedCount === 0 ? new Set(['wb_ssh_exec', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes']) : null` 整体替换

- [ ] **Step 1: 写失败测试**(追加到 registry 测试宿主文件):

```js
test('workbenchExcludeTools:未绑定裁 16 个 K8s 依赖工具;SSH 零暴露叠 4 个;两条件全无 → null', () => {
  const unbound = workbenchExcludeTools({ hasCluster: false, sshExposedCount: 2 })
  for (const n of ['wb_list_resources', 'wb_get_pod_logs', 'wb_describe_resource', 'wb_get_resource', 'wb_get_events',
    'wb_rollout_status', 'wb_read_pod_file', 'wb_top', 'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo',
    'wb_exec', 'bootstrap_ledger', 'apply_project_manifests', 'read_ledger']) {
    assert.ok(unbound.has(n), n)
  }
  assert.equal(unbound.size, 16)
  const noSsh = workbenchExcludeTools({ hasCluster: true, sshExposedCount: 0 })
  assert.deepEqual([...noSsh].sort(), ['read_server_ledger', 'wb_ssh_exec', 'wb_ssh_read_file', 'write_server_notes'])
  assert.equal(workbenchExcludeTools({ hasCluster: true, sshExposedCount: 2 }), null)
  // 双条件叠加:并集 20 个
  assert.equal(workbenchExcludeTools({ hasCluster: false, sshExposedCount: 0 }).size, 20)
  // 被裁的都是注册表在册工具(防名单漂移出死名字)
  const all = new Set(registry.all().map(t => t.name))
  for (const n of unbound) assert.ok(all.has(n), n)
})
```

- [ ] **Step 2: 跑红** → FAIL(未导出)

- [ ] **Step 3: 实现** — `tool-registry.mjs`:

```js
// 未绑定集群的项目裁掉全部 K8s 依赖工具;SSH 零暴露裁掉 SSH 4 工具;并集语义,无需排除时返 null
// (2026-08-30 无集群工作台 spec §3;名单必须逐个是注册表在册工具,测试有守卫)
const UNCLUSTERED_TOOLS = ['wb_list_resources', 'wb_get_pod_logs', 'wb_describe_resource', 'wb_get_resource', 'wb_get_events',
  'wb_rollout_status', 'wb_read_pod_file', 'wb_top', 'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo',
  'wb_exec', 'bootstrap_ledger', 'apply_project_manifests', 'read_ledger']
const SSH_HIDDEN_TOOLS = ['wb_ssh_exec', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes']
export function workbenchExcludeTools({ hasCluster, sshExposedCount }) {
  const names = []
  if (!hasCluster) names.push(...UNCLUSTERED_TOOLS)
  if (sshExposedCount === 0) names.push(...SSH_HIDDEN_TOOLS)
  return names.length ? new Set(names) : null
}
```

`workbench-agent.mjs` runConversation 内替换(164-165 行区域):

```js
        excludeTools: workbenchExcludeTools({ hasCluster: !!project.clusterId, sshExposedCount: exposedCount }),
```

(import `workbenchExcludeTools` 自 './tool-registry.mjs';原三目整体删除。)

- [ ] **Step 4: 跑绿**:registry 测试全 PASS;`npm run test:server` 全绿(wb-approval-roundtrip 等 spawn 用例证明接线不破既有路径)

- [ ] **Step 5: 提交**

```bash
git add server/tool-registry.mjs server/tool-registry.test.mjs server/workbench-agent.mjs
git commit -m "feat(workbench): 工具可见性随绑定状态伸缩——workbenchExcludeTools 纯函数(未绑定裁 16 K8s 工具,与 SSH 零暴露叠加)"
```

---

### Task 4: 绑定/解绑端点 + spawn 测试

**Files:**
- Modify: `server/routes/workbench-projects.mjs`(`:id` 分支、`seg[1] === 'cluster'`)
- Modify: `server/messages/wbp.*`(wbp 消息表宿主:`grep -l "wbp.nameClusterRequired" server/messages/` 定位文件,加两键)
- Test: Create `server/wb-project-cluster.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `''` 哨兵与 projectRepoPath
- Produces: `PUT /api/workbench/projects/:id/cluster`,body `{ clusterId: "<id>" | '' }`(`''`=解绑;响应 `{ ok: true, project: {...p, clusterName} }`);校验:目标集群存在(404)、admin/owner 之外 403(复用 `:id` 分支已有的 ownership 检查——本端点写在 ownership 检查之后自然获得);审计 `verb:'write', tool:'workbench_project_cluster'`

- [ ] **Step 1: 写失败测试** `server/wb-project-cluster.test.mjs`(spawn 骨架逐字照 `server/ssh/routes.test.mjs`:PORT `53000 + Math.floor(Math.random() * 2000)`(避开既有 spawn 端口带)、ALIANG_DB/ALIANG_STATIC_DIR/ALIANG_WORKBENCH_DIR 指 mkdtemp、ADMIN_USERNAME=admin、ADMIN_PASSWORD=`'x'.repeat(12)`、waitUp、cleanup SIGKILL+rmSync)。用例:

```js
test('项目后绑集群:未绑定建项目→404 防呆→插集群行→绑定→解绑;他人 403', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 未绑定建项目(clusterId 缺省)
  const created = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'no-cluster-p' }) })).json()
  assert.equal(created.project.clusterId, '')
  const pid = created.project.id

  // 绑定不存在的集群 → 404
  const nf = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'no-such' }) })
  assert.equal(nf.status, 404)

  // 测试直接往网关库插一条集群行(node:sqlite 打开同一 ALIANG_DB),再绑定
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  db.prepare('INSERT INTO clusters (id, name, apiServer, authHeader, ca, cert, key, insecure, version, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('ck-t1', '测试集群', 'https://127.0.0.1:6443', 'Basic eDp5', '', '', '', 0, 'v1.29', Date.now())
  db.close()
  // clusters 表列名以 server/index.mjs 的建表语句为准——实现者先 grep 'CREATE TABLE IF NOT EXISTS clusters' 逐列核对再写 INSERT
  const bind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'ck-t1' }) })).json()
  assert.equal(bind.project.clusterId, 'ck-t1')
  assert.equal(bind.project.clusterName, '测试集群')

  // 解绑('' 哨兵)→ 恢复未绑定
  const unbind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: '' }) })).json()
  assert.equal(unbind.project.clusterId, '')

  // 他人(非 owner 非 admin)→ 403:建普通用户并登录
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const forbidden = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-platform-token': plogin.token }, body: JSON.stringify({ clusterId: 'ck-t1' }) })
  assert.equal(forbidden.status, 403)

  // 审计落账
  const db2 = new DatabaseSync(join(DIR, 'wb.db'))
  const row = db2.prepare("SELECT count(*) c FROM audit_log WHERE tool='workbench_project_cluster'").get()
  assert.ok(row.c >= 2)  // 绑定 + 解绑
  db2.close()
})
```

(实现者注意:①admin 建 user 的端点/字段名先 grep `server/routes/admin.mjs` 的 users 段核对;②clusters 建表列以实际为准;③若普通用户默认无平台登录资格,改用第二个 admin 建 owner 不同的项目再验证 403——以实际权限模型为准,断言意图不变。)

- [ ] **Step 2: 跑红**:`node --test server/wb-project-cluster.test.mjs` → FAIL(PUT 404/405)

- [ ] **Step 3: 实现** — `server/routes/workbench-projects.mjs` 的 `:id` 分支内(ownership 检查之后、`seg[1] === 'files'` 之前)插入:

```js
      // 绑定/解绑集群(2026-08-30 spec §4):仅改 clusterId 一列;''=解绑;不动 manifests/repo/对话
      if (seg[1] === 'cluster' && req.method === 'PUT') {
        const input = await readBody(req)
        const cid = input.clusterId ?? ''
        if (cid && !db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
        db.prepare('UPDATE workbench_projects SET clusterId=? WHERE id=?').run(cid, id)
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'workbench_project_cluster', result: 'ok', requestSummary: `project=${id} clusterId=${cid || '(unbound)'}`, source: 'platform' })
        sendJson(res, 200, { ok: true, project: { ...getProject(db, id), clusterName: clusterNameOf(cid) } })
        return true
      }
```

(deps destructure 若无 `writeAudit` 则补;`clusterNameOf` 已在该分支上方定义。)

- [ ] **Step 4: 跑绿**:`node --test server/wb-project-cluster.test.mjs` 全 PASS;`node --test server/route-auth-map.test.mjs` PASS(`/api/workbench/` 前缀覆盖);`npm run test:server` 全绿

- [ ] **Step 5: 提交**

```bash
git add server/routes/workbench-projects.mjs server/messages/wbp.mjs server/wb-project-cluster.test.mjs
git commit -m "feat(workbench): PUT projects/:id/cluster 绑定/解绑——''哨兵+权限矩阵+审计,下一轮对话即时生效"
```

(messages 文件名以 grep 实际为准。)

---

### Task 5: 前端(建项目可选集群 + 徽章 + 换绑 + 能力提示条 + i18n)

**Files:**
- Modify: `src/views/WorkbenchProjects.vue`(建项目表单集群改可选、项目卡徽章、换绑下拉)
- Modify: `src/views/WorkbenchDetail.vue`(顶部能力提示条 + 绑定入口)
- Modify: `src/api/client.js`(workbenchApi 若无 `updateProjectCluster` 则加:`(id, clusterId) => platformHttp.request(…/cluster, PUT)`)
- Modify: `src/locales/zh.json` / `src/locales/en.json`
- Test: Create `src/views/__tests__/WorkbenchProjects.unbound.test.js`

**Interfaces:**
- Consumes: Task 4 端点;既有 `workbenchApi`
- Produces: UI 契约——未绑定项目徽章(data-test="unbound-badge")、chat/详情页提示条(data-test="bind-cluster-banner")、建项目确认不再因未选集群禁用

- [ ] **Step 1: 写失败测试**(mock 形态照 `src/views/__tests__/Settings.ssh-policy.test.js`:vi.mock cluster store/preferences 类顶层依赖按该文件现状;workbenchApi 用 vi.spyOn):

```js
test('未绑定项目:徽章可见 + 换绑下拉列出集群并可提交', async () => {
  vi.spyOn(workbenchApi, 'listProjects').mockResolvedValue({ projects: [{ id: 'p1', name: 'P1', clusterId: '', repoRoot: 'projects', ownerId: 'u' }] })
  vi.spyOn(workbenchApi, 'listClusters').mockResolvedValue({ clusters: [{ id: 'c1', name: 'CK' }] })
  const upd = vi.spyOn(workbenchApi, 'updateProjectCluster').mockResolvedValue({ ok: true, project: { clusterId: 'c1', clusterName: 'CK' } })
  const w = await mountProjectsAsAdmin()
  await flushPromises()
  expect(w.find('[data-test="unbound-badge"]').exists()).toBe(true)
  const bind = w.find('[data-test="bind-cluster"]')
  await bind.setValue('c1')
  expect(upd).toHaveBeenCalledWith('p1', 'c1')
})
```

(注:`listProjects/listClusters` 的既有 api 方法名先 grep `src/api/client.js` 的 workbenchApi 段核对,已有则 spy,缺哪补哪;mount 辅助函数按该目录既有 workbench 视图测试的 mock 骨架,没有就仿 Settings 测试自建。)

- [ ] **Step 2: 跑红**:`npx vitest run src/views/__tests__/WorkbenchProjects.unbound.test.js` → FAIL

- [ ] **Step 3: 实现 WorkbenchProjects.vue**:
  - 建项目确认按钮 `:disabled` 去掉 `|| !form.clusterId`;集群 select 保留但加「不绑定,稍后再说」空选项(`<option value="">`)
  - 项目卡 clusterName 行:未绑定(`!p.clusterId`)时显示 `<span data-test="unbound-badge" class="…text-warning…">{{ t('workbench.unboundBadge') }}</span>`,否则原 clusterName
  - 卡上加绑定下拉(data-test="bind-cluster",选项=全部集群 + 「未绑定」空值),change → `workbenchApi.updateProjectCluster(p.id, $event.target.value)` 后刷新列表
  - `clusterName('')` 展示逻辑同步(空 → 不显示 '-' 而显示徽章,与上一条合并处理)

- [ ] **Step 4: 实现 WorkbenchDetail.vue**:项目 header 区(未绑定时)加:

```html
      <div v-if="!project?.clusterId" data-test="bind-cluster-banner" class="flex items-center gap-sm px-md py-xs rounded-lg bg-warning/10 border border-warning/30 text-body-xs">
        <span class="material-symbols-outlined text-warning text-sm">info</span>
        <span class="flex-1">{{ t('workbench.unboundBanner') }}</span>
        <select data-test="bind-cluster" class="bg-surface-container-low border border-outline-variant rounded px-xs py-0.5" @change="bindCluster($event.target.value)">
          <option value="">{{ t('workbench.bindClusterPlaceholder') }}</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
```

(脚本侧:`clusters` 从既有集群列表 api 拉;`bindCluster(v)` 调 `updateProjectCluster(project.id, v)` 后重拉 project;若 WorkbenchDetail 无 clusters 数据源,按页内既有 api 调用风格补一个 onMounted 拉取。)

- [ ] **Step 5: i18n 双语**(zh/en 对齐;命名空间按现有 workbench 段归置):

```json
"unboundBadge": "未绑定集群" | "No cluster",
"unboundBanner": "当前未绑定集群:可写 manifests 草稿、SSH 服务器运维;绑定集群后可调查资源与 apply,已写好的草稿直接生效" | "No cluster bound: draft manifests and manage SSH servers now; bind a cluster to unlock resource investigation and apply — existing drafts apply as-is",
"bindClusterPlaceholder": "绑定集群…" | "Bind a cluster…",
"bindClusterSaved": "已更新项目集群绑定" | "Project cluster binding updated"
```

- [ ] **Step 6: 跑绿**:组件测试 PASS;`npm run i18n:check` 六项全 0;`npx vitest run src/views/__tests__` 目录回归不破

- [ ] **Step 7: 提交**

```bash
git add src/views/WorkbenchProjects.vue src/views/WorkbenchDetail.vue src/api/client.js src/locales/zh.json src/locales/en.json src/views/__tests__/WorkbenchProjects.unbound.test.js
git commit -m "feat(workbench): 无集群项目前端——建项目集群可选/未绑定徽章/换绑下拉/详情页能力提示条"
```

---

### Task 6: 全量门禁 + 终审 + 手测清单落档

- [ ] **Step 1:** `npm test` + `npm run i18n:check` + `npm run typecheck` 全绿(worktree 分支上跑)
- [ ] **Step 2:** 全分支终审(最强可用模型),范围=本特性 merge-base..HEAD
- [ ] **Step 3:** 手测 7 项待真机:①无集群建项目→项目卡「未绑定集群」徽章;②对话写 manifests 草稿(write_project_file 人审);③SSH 服务器运维对话正常(工具清单无 K8s 工具);④绑定集群→下一轮对话能 wb_list_resources;⑤已写草稿 apply_project_manifests 走通;⑥解绑→K8s 工具消失、草稿文件仍在;⑦存量项目路径/行为零变化(回归)
