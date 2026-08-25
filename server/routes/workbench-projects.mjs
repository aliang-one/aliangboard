// 工作台项目 CRUD + 搜索 + 台账 + 蒸馏 + reconcile HTTP 端点从 server/index.mjs 抽出。
// handler/dispatcher 模式。零行为变更:端点块逐字搬迁,仅依赖引用改走 deps 注入。
import { join } from 'node:path'
import {
  listProjects, createProject, getProject,
  getLastReconcile, getPendingDistill, clearPendingDistill, setLastDistill,
  getActiveConversationId,
} from '../workbench-projects.mjs'
import {
  initRepo, hasRepo, writeFile as wbWriteFile,
  readFile as wbReadFile, listFiles as wbListFiles, commit as wbCommit,
  recentCommits as wbRecentCommits, readManifests as wbReadManifests,
  deleteFile as wbDeleteFile,
} from '../workbench-repos.mjs'
import { verifiedAt } from '../workbench-ledger.mjs'
import { computeStorageInfo } from '../storage-info.mjs'
import { runDistill } from '../distill.mjs'
import { reconcileProject } from '../reconcile.mjs'
import { msg } from '../messages.mjs'

export function createWorkbenchProjectRoutes(deps) {
  const {
    db, sendJson, readBody, requirePlatform, requireAdmin,
    WORKBENCH_DIR, dbPath, getLlmConfig, createLlmClient,
    buildCallContext, requestKubernetes, applyYamlPartial,
    bootstrapLedgerForCluster,
  } = deps

  // 匹配工作台非对话路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {

    // GET /api/workbench/records — 工作台「记录」页:跨项目对话记录 + 计数 + 存储信息(admin)。
    // 对话/消息在 SQLite;项目文件与台账是 git 仓库;AI 工具调用在审计链(audit_log
    // source=workbench,明细由前端经 /api/admin/audit-log?source=workbench 取,此处只给计数)。
    if (url.pathname === '/api/workbench/records' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const conversations = db.prepare(`
          SELECT c.id, c.status, c.steps, c.title, c.userMessage, c.error, c.createdAt, c.updatedAt,
                 p.id AS projectId, p.name AS projectName,
                 (SELECT count(*) FROM workbench_messages m WHERE m.conversationId = c.id) AS messageCount
          FROM workbench_conversations c JOIN workbench_projects p ON c.projectId = p.id
          ORDER BY c.updatedAt DESC LIMIT 200`).all()
        const counts = {
          projects: db.prepare('SELECT count(*) c FROM workbench_projects').get().c,
          conversations: db.prepare('SELECT count(*) c FROM workbench_conversations').get().c,
          messages: db.prepare('SELECT count(*) c FROM workbench_messages').get().c,
          aiToolCalls: db.prepare("SELECT count(*) c FROM audit_log WHERE source='workbench'").get().c,
        }
        const storage = await computeStorageInfo({ dbPath, workbenchDir: WORKBENCH_DIR, db })
        sendJson(res, 200, { conversations, counts, storage })
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'wbp.recordsReadFailed') }); return true }
      return true
    }

    // ====== 项目 CRUD(W2)。requirePlatform + ownership(ownerId==userId || admin)======
    if (url.pathname.startsWith('/api/workbench/projects')) {
      const ps = requirePlatform(req, res); if (!ps) return true
      const clusterNameOf = cid => db.prepare('SELECT name FROM clusters WHERE id=?').get(cid)?.name || (cid ? cid.slice(0, 8) : '-')
      // 解析:/api/workbench/projects[/<id>[/files/<path>|/commit]]
      const seg = url.pathname.slice('/api/workbench/projects'.length).split('/').filter(Boolean)
      const id = seg[0]

      if (!id) {
        // 列表 / 创建
        if (req.method === 'GET') {
          const projects = listProjects(db, { userId: ps.userId, role: ps.role }).map(p => ({ ...p, clusterName: clusterNameOf(p.clusterId) }))
          sendJson(res, 200, { projects }); return true
        }
        if (req.method === 'POST') {
          try {
            const input = await readBody(req)
            if (!input.name || !input.clusterId) { sendJson(res, 400, { message: msg(req, 'wbp.nameClusterRequired') }); return true }
            if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(input.clusterId)) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
            const p = createProject(db, { name: input.name, clusterId: input.clusterId, ownerId: ps.userId })
            const repo = join(WORKBENCH_DIR, p.clusterId, 'projects', p.id)
            await initRepo(repo)
            await wbWriteFile(repo, 'project.md', `# ${p.name}\n\n> aliangboard 工作台项目。\n`)
            await wbCommit(repo, `初始化项目 ${p.name}`)
            sendJson(res, 200, { project: { ...p, clusterName: clusterNameOf(p.clusterId) } })
            return true
          } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.createFailed') }); return true }
        }
        sendJson(res, 405, { message: msg(req, 'wbp.methodNotAllowed') }); return true
      }

      // 以下均需项目 + ownership
      const p = getProject(db, id)
      if (!p) { sendJson(res, 404, { message: msg(req, 'wbp.projectNotFound') }); return true }
      if (p.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbp.noProjectAccess') }); return true }
      const repo = join(WORKBENCH_DIR, p.clusterId, 'projects', p.id)

      // 详情:文件树 + 最近提交
      if (req.method === 'GET' && seg.length === 1) {
        let files = [], commits = []
        try { files = await wbListFiles(repo); commits = await wbRecentCommits(repo, 20) } catch { /* repo 未初始化 */ }
        sendJson(res, 200, { project: { ...p, clusterName: clusterNameOf(p.clusterId) }, files, commits, lastReconcile: getLastReconcile(db, id), activeConversationId: getActiveConversationId(db, id) })
        return true
      }

      // 文件读写 :id/files/<path>
      if (seg[1] === 'files') {
        const relPath = decodeURIComponent(seg.slice(2).join('/'))
        if (!relPath) { sendJson(res, 400, { message: msg(req, 'wbp.filePathRequired') }); return true }
        try {
          if (req.method === 'GET') { sendJson(res, 200, { path: relPath, content: await wbReadFile(repo, relPath) }); return true }
          if (req.method === 'PUT') {
            const input = await readBody(req)
            await wbWriteFile(repo, relPath, input.content ?? '') // wbWriteFile 内置路径禁闭
            sendJson(res, 200, { ok: true }); return true
          }
          if (req.method === 'DELETE') {
            await wbDeleteFile(repo, relPath) // 路径禁闭同 writeFile;删除进 commit 历史
            sendJson(res, 200, { ok: true, path: relPath }); return true
          }
        } catch (e) { sendJson(res, 400, { message: e?.message || msg(req, 'wbp.fileOpFailed') }); return true }
        sendJson(res, 405, { message: msg(req, 'wbp.methodNotAllowed') }); return true
      }

      // 提交 :id/commit
      if (seg[1] === 'commit' && req.method === 'POST') {
        try {
          const input = await readBody(req)
          const r = await wbCommit(repo, input.message || 'update')
          sendJson(res, 200, r)
          return true
        } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.commitFailed') }); return true }
      }

      // reconcile :id/reconcile(第 4 阶段 R2):幂等再 apply manifests,集群对齐 repo(声明字段作用域)
      if (seg[1] === 'reconcile' && req.method === 'POST') {
        try {
          const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(p.clusterId)
          if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.boundClusterNotFound') }); return true }
          const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
          const r = await reconcileProject({ db, projectId: p.id, readManifests: () => wbReadManifests(repo), applyYaml: (yaml) => applyYamlPartial(k8sSession, yaml) })
          sendJson(res, 200, r)
          return true
        } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.reconcileFailed') }); return true }
      }

      sendJson(res, 404, { message: msg(req, 'wbp.unknownRoute') })
      return true
    }

    // ====== 项目集群资源搜索(P3 @-mention)。GET /api/workbench/search?projectId=X&kind=pod&q=nginx ======
    if (url.pathname === '/api/workbench/search' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const projectId = url.searchParams.get('projectId')
      const kind = url.searchParams.get('kind') || 'pods'
      const q = (url.searchParams.get('q') || '').toLowerCase()
      if (!projectId) { sendJson(res, 400, { message: msg(req, 'wbp.projectIdRequired') }); return true }
      const p = db.prepare('SELECT * FROM workbench_projects WHERE id=?').get(projectId)
      if (!p) { sendJson(res, 404, { message: msg(req, 'wbp.projectNotFound') }); return true }
      if (!p.clusterId) { sendJson(res, 400, { message: msg(req, 'wbp.noBoundCluster') }); return true }
      const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(p.clusterId)
      if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.boundClusterNotFound') }); return true }

      // kind → K8s list path
      const KIND_PATH = {
        pods: '/api/v1/pods', services: '/api/v1/services', configmaps: '/api/v1/configmaps',
        secrets: '/api/v1/secrets', namespaces: '/api/v1/namespaces',
        deployments: '/apis/apps/v1/deployments', statefulsets: '/apis/apps/v1/statefulsets', daemonsets: '/apis/apps/v1/daemonsets',
        ingresses: '/apis/networking.k8s.io/v1/ingresses',
        // SP3 扩展:集群级 + 存储 + 网络 + 身份
        nodes: '/api/v1/nodes', persistentvolumes: '/api/v1/persistentvolumes',
        persistentvolumeclaims: '/api/v1/persistentvolumeclaims', storageclasses: '/apis/storage.k8s.io/v1/storageclasses',
        networkpolicies: '/apis/networking.k8s.io/v1/networkpolicies', serviceaccounts: '/api/v1/serviceaccounts',
      }
      const listPath = KIND_PATH[kind]
      if (!listPath) { sendJson(res, 400, { message: msg(req, 'wbp.kindUnsupported', { kind }) }); return true }

      try {
        const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
        const resp = await requestKubernetes(k8sSession, listPath)
        const items = (resp?.body?.items || []).map(it => ({
          name: it.metadata?.name || '',
          namespace: it.metadata?.namespace || '',
          kind,
        }))
        const filtered = q ? items.filter(it => it.name.toLowerCase().includes(q)) : items
        sendJson(res, 200, { items: filtered.slice(0, 50) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.searchFailed') }); return true }
    }

    // ====== 集群台账(W3)。cluster-context repo,每集群一份。======
    if (url.pathname === '/api/workbench/ledger' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const clusterId = url.searchParams.get('clusterId')
      if (!clusterId) { sendJson(res, 400, { message: msg(req, 'wbp.clusterIdRequired') }); return true }
      const repo = join(WORKBENCH_DIR, clusterId, 'cluster-context')
      let files = [], index = null, learnings = null
      if (await hasRepo(repo)) {
        files = await wbListFiles(repo)
        try { index = await wbReadFile(repo, 'INDEX.md') } catch { index = null }
        try { learnings = await wbReadFile(repo, 'learnings.md') } catch { learnings = null }
      }
      sendJson(res, 200, { exists: !!index, files, index, learnings, pending: getPendingDistill(db, clusterId) })
      return true
    }
    if (url.pathname === '/api/workbench/ledger/bootstrap' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(input.clusterId)
        if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
        const r = await bootstrapLedgerForCluster(cluster)
        sendJson(res, 200, { index: r.index, files: r.files })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.bootstrapFailed') }); return true }
    }

    // ====== 台账 distill(D2,自我学习;admin)======
    if (url.pathname === '/api/workbench/distill' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(input.clusterId)
        if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 503, { message: msg(req, 'wbp.llmNotConfiguredDistill') }); return true }
        const llmClient = createLlmClient(cfg)
        const ledgerRepo = join(WORKBENCH_DIR, cluster.id, 'cluster-context')
        const out = await runDistill({ llmClient, db, clusterId: cluster.id, ledgerRepo, clusterName: cluster.name })
        setLastDistill(db, cluster.id, out.stats) // 手动蒸馏也落水位:调度器不会立刻重跑同料(pending 不写——手动结果就地审阅,原行为)
        sendJson(res, 200, { proposed: out.proposed, current: out.material.currentLearnings, summary: out.summary, stats: out.stats })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.distillFailed') }); return true }
    }
    if (url.pathname === '/api/workbench/distill/apply' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(input.clusterId)
        if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
        const repo = join(WORKBENCH_DIR, cluster.id, 'cluster-context')
        if (!(await hasRepo(repo))) await initRepo(repo)
        await wbWriteFile(repo, 'learnings.md', input.learnings || '')
        await wbCommit(repo, `蒸馏 learnings · ${verifiedAt()}`)
        clearPendingDistill(db, input.clusterId)
        sendJson(res, 200, { ok: true, files: await wbListFiles(repo) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.applyFailed') }); return true }
    }
    if (url.pathname === '/api/workbench/distill/dismiss' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        clearPendingDistill(db, input.clusterId)
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'wbp.dismissFailed') }); return true }
    }

    return false // 无匹配
  }

  return { handle }
}
