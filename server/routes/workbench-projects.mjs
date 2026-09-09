// 工作台项目 CRUD + 搜索 + 台账 + 蒸馏 + reconcile HTTP 端点从 server/index.mjs 抽出。
// handler/dispatcher 模式。零行为变更:端点块逐字搬迁,仅依赖引用改走 deps 注入。
import { join } from 'node:path'
import {
  listProjects, createProject, getProject, projectRepoPath,
  deleteProject, setProjectRecap,
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
import { normalizeKind } from '../kindAlias.mjs'
import { listApiPath } from '../kind-paths.mjs'
import { listSshServers } from '../ssh/store.mjs'
import { wbToolGate, gateApplyNamespaces } from '../authz.mjs' // W2 C+D 终审#5:reconcile 与 wb_apply 同门
import { createApplyYaml } from '../apply-yaml.mjs'

// W2 Phase C(Task 2):导出式 ownership/查询 helper,供本路由与 workbench 对话域
// (records/presence/summary/search 等)单一事实源复用,防各面手写判定漂移。
// 归属判定:项目 owner 或平台 admin。
export function assertProjectOwnership(ps, project) {
  if (!ps?.userId || !project?.ownerId) return false
  return project.ownerId === ps.userId || ps.role === 'admin'
}

// 按 owner 跨项目列对话(JOIN projects WHERE ownerId),updatedAt 倒序。
// 消费方:records(限定 owner 非 admin 全量)/ summary / search 等后续接线。
export function listConversationsByOwner(db, userId) {
  return db.prepare(`
    SELECT c.id, c.projectId, c.status, c.steps, c.title, c.userMessage, c.error, c.createdAt, c.updatedAt,
           p.name AS projectName, p.ownerId AS projectOwnerId,
           (SELECT count(*) FROM workbench_messages m WHERE m.conversationId = c.id) AS messageCount
    FROM workbench_conversations c JOIN workbench_projects p ON c.projectId = p.id
    WHERE p.ownerId = ?
    ORDER BY c.updatedAt DESC`).all(userId)
}

export function createWorkbenchProjectRoutes(deps) {
  const {
    db, sendJson, readBody, requirePlatform, requireAdmin, writeAudit,
    WORKBENCH_DIR, dbPath, getLlmConfig, createLlmClient,
    buildCallContext, requestKubernetes, applyYamlPartial,
    bootstrapLedgerForCluster, listSshSessions,
    wbAgent, busDispose,
  } = deps

  // W2-0 §2.6:项目域集群门——发起者(项目 owner)须仍被分配该集群;admin 豁免;空 clusterId(未绑定)放行。
  // 2026-09-07 审计 F4(authz-entitlement-04):从 projects 块上移工厂域——GET /api/workbench/ledger
  // (全集群 survey 台账,含待审蒸馏稿)原先只有 requirePlatform,补齐同一把门,防各面手写判定漂移。
  const clusterEntitled = (ps0, cid) => {
    if (!cid || ps0.role === 'admin') return true
    return !!db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps0.userId, cid)
  }

  // 匹配工作台非对话路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {

    // GET /api/workbench/records — 工作台「记录」页:跨项目对话记录 + 计数 + 存储信息(admin)。
    // 对话/消息在 SQLite;项目文件与台账是 git 仓库;AI 工具调用在审计链(audit_log
    // source=workbench,明细由前端经 /api/admin/audit-log?source=workbench 取,此处只给计数)。
    if (url.pathname === '/api/workbench/records' && req.method === 'GET') {
      // W2 Phase D(CB-B Task 3):requirePlatform + owner 收口——非 admin 只见自己项目
      // 的对话/计数;全局 storage 统计与 aiToolCalls(审计计数)维持 admin,非 admin 响应
      // 保留形状键但置 null(前端已有 isAdmin 分支)。admin 行为逐字不变。
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const isAdmin = ps.role === 'admin'
        const conversations = isAdmin ? db.prepare(`
          SELECT c.id, c.status, c.steps, c.title, c.userMessage, c.error, c.createdAt, c.updatedAt,
                 p.id AS projectId, p.name AS projectName, p.ownerId AS projectOwnerId,
                 (SELECT count(*) FROM workbench_messages m WHERE m.conversationId = c.id) AS messageCount
          FROM workbench_conversations c JOIN workbench_projects p ON c.projectId = p.id
          ORDER BY c.updatedAt DESC LIMIT 200`).all()
          : listConversationsByOwner(db, ps.userId).slice(0, 200)
        const counts = isAdmin ? {
          projects: db.prepare('SELECT count(*) c FROM workbench_projects').get().c,
          conversations: db.prepare('SELECT count(*) c FROM workbench_conversations').get().c,
          messages: db.prepare('SELECT count(*) c FROM workbench_messages').get().c,
          aiToolCalls: db.prepare("SELECT count(*) c FROM audit_log WHERE source='workbench'").get().c,
        } : {
          projects: db.prepare('SELECT count(*) c FROM workbench_projects WHERE ownerId=?').get(ps.userId).c,
          conversations: db.prepare('SELECT count(*) c FROM workbench_conversations c JOIN workbench_projects p ON c.projectId=p.id WHERE p.ownerId=?').get(ps.userId).c,
          messages: db.prepare('SELECT count(*) c FROM workbench_messages m JOIN workbench_conversations c ON m.conversationId=c.id JOIN workbench_projects p ON c.projectId=p.id WHERE p.ownerId=?').get(ps.userId).c,
          aiToolCalls: null, // 审计明细是平台全局域,owner 收口下不下发
        }
        const storage = isAdmin ? await computeStorageInfo({ dbPath, workbenchDir: WORKBENCH_DIR, db }) : null
        sendJson(res, 200, { conversations, counts, storage })
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'wbp.recordsReadFailed') }); return true }
      return true
    }

    // GET /api/workbench/summary — 顶栏胶囊单一汇总端点(2026-08-30 spec §3):
    // 项目(归属过滤,待办优先排序,截 8)+ 全量计数(运行中/待审批/SSH 按用户)。
    // 待审批=paused + pendingApproval 非空(workbench-agent 暂停落库/resume 清空,持久权威源)。
    if (url.pathname === '/api/workbench/summary' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const projects = listProjects(db, { userId: ps.userId, role: ps.role })
        const clusterNameOf = cid => (cid ? db.prepare('SELECT name FROM clusters WHERE id=?').get(cid)?.name || null : null)
        const byProject = new Map(db.prepare(`
          SELECT projectId,
                 SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS runningConvs,
                 SUM(CASE WHEN status='paused' AND pendingApproval IS NOT NULL THEN 1 ELSE 0 END) AS pendingApprovals,
                 MAX(updatedAt) AS lastActiveAt
          FROM workbench_conversations GROUP BY projectId
        `).all().map(r => [r.projectId, r]))
        const enriched = projects.map(p => {
          const a = byProject.get(p.id)
          return {
            id: p.id, name: p.name, clusterId: p.clusterId || '',
            clusterName: clusterNameOf(p.clusterId),
            lastActiveAt: a?.lastActiveAt || null,
            runningConvs: a?.runningConvs || 0,
            pendingApprovals: a?.pendingApprovals || 0,
          }
        })
        // 待办优先:待审批 ↓ 运行中 ↓ 最近活跃 ↓(并列保 listProjects 的 createdAt DESC 稳定序)
        enriched.sort((a, b) =>
          b.pendingApprovals - a.pendingApprovals ||
          b.runningConvs - a.runningConvs ||
          (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        const totals = {
          projects: enriched.length,
          runningConvs: enriched.reduce((s, r) => s + r.runningConvs, 0),
          pendingApprovals: enriched.reduce((s, r) => s + r.pendingApprovals, 0),
          // 终端注册表 userId 字段实存 username(server/index.mjs TerminalService newTerminal({owner: ps.username})),
          // 属主比对同源;ps.userId 是 platform_users.id(UUID),不可混用。
          // 只计活态(2026-09-05 评审#4):与 /api/ssh/sessions「只回活态」同语义,墓窗残尸不进胶囊计数
          sshSessions: (listSshSessions?.() || []).filter(s => s.userId === ps.username && s.status !== 'CLOSED' && s.status !== 'LOST').length,
        }
        sendJson(res, 200, { projects: enriched.slice(0, 8), totals })
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'wbp.summaryReadFailed') }) }
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
            if (!input.name) { sendJson(res, 400, { message: msg(req, 'wbp.nameClusterRequired') }); return true }
            if (input.clusterId && !db.prepare('SELECT 1 FROM clusters WHERE id=?').get(input.clusterId)) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
            if (!clusterEntitled(ps, input.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
            const p = createProject(db, { name: input.name, clusterId: input.clusterId, ownerId: ps.userId })
            const repo = projectRepoPath(WORKBENCH_DIR, p)
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
      const repo = projectRepoPath(WORKBENCH_DIR, p)

      // 详情:文件树 + 最近提交
      if (req.method === 'GET' && seg.length === 1) {
        let files = [], commits = []
        try { files = await wbListFiles(repo); commits = await wbRecentCommits(repo, 20) } catch { /* repo 未初始化 */ }
        sendJson(res, 200, { project: { ...p, clusterName: clusterNameOf(p.clusterId) }, files, commits, lastReconcile: getLastReconcile(db, id), activeConversationId: getActiveConversationId(db, id) })
        return true
      }

      // 删除项目(2026-08-31 生命周期 spec §5):确认名护栏 + running/paused 对话先取消
      // (P0(F):不等 LLM 轮结束)再级联删。repo 清除失败不阻断(响应带 warning 仍 200)。
      if (req.method === 'DELETE' && seg.length === 1) {
        try {
          const input = await readBody(req)
          // 确认名两侧都 trim(M1):项目名本身可含首尾空白(创建端不强制 trim),只 trim 输入侧
          // 会让这类项目永远删不掉(逐字比对恒不等)。
          if (String(input.confirmName ?? '').trim() !== p.name.trim()) {
            sendJson(res, 400, { message: msg(req, 'wbp.confirmNameMismatch') }); return true
          }
          const convs = db.prepare("SELECT id, status FROM workbench_conversations WHERE projectId=?").all(id)
          const active = convs.filter(c => c.status === 'running' || c.status === 'paused')
          for (const c of active) {
            try { wbAgent?.cancelConversation(c.id) } catch { /* agent 不在内存=无需取消 */ }
            try { busDispose?.(c.id) } catch { /* 总线订阅已清 */ }
          }
          const r = deleteProject(db, { workbenchDir: WORKBENCH_DIR, projectId: id })
          if (!r.ok) { sendJson(res, r.status || 500, { message: r.error || msg(req, 'wbp.deleteFailed') }); return true }
          writeAudit?.(db, {
            owner: ps.username, verb: 'write', tool: 'project_delete', result: 'ok',
            requestSummary: `name=${p.name} conversations=${convs.length}`, source: 'platform',
          })
          sendJson(res, 200, { ok: true, removedConversations: r.removedConversations, repoRemoved: r.repoRemoved,
            ...(r.repoError ? { warning: r.repoError } : {}) })
        } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.deleteFailed') }) }
        return true
      }

      // PATCH 项目(2026-08-31 生命周期 spec §5):改名(name ≤80)+ 人工 recap
      // (空串=清空并归零水位)。两字段全缺 → 400。
      // M4:①recap: null 视为未提供(前端「没改记忆」不得静默清空既有记忆)
      //     ②name+recap 单事务——recap 写一半失败不许只落半截(改名成功/记忆丢失的撕裂态)。
      if (req.method === 'PATCH' && seg.length === 1) {
        try {
          const input = await readBody(req)
          const hasName = input.name !== undefined
          const hasRecap = input.recap !== undefined && input.recap !== null
          if (!hasName && !hasRecap) { sendJson(res, 400, { message: msg(req, 'wbp.patchFieldRequired') }); return true }
          let name
          if (hasName) {
            name = String(input.name).trim()
            if (!name || name.length > 80) { sendJson(res, 400, { message: msg(req, 'wbp.nameInvalid') }); return true }
          }
          // context-assembly-03(PT4 fix round 1 Minor#5):setProjectRecap 超长由 400 拒绝改为
          // clamp 64KB 落库后恒 {ok:true},旧 recapRejected→400 分支成死代码,已删(wbp.recapTooLong
          // 键随删)。name+recap 单事务结构不变(M4②)。
          db.exec('BEGIN')
          try {
            if (hasRecap) setProjectRecap(db, id, input.recap)
            if (hasName) db.prepare('UPDATE workbench_projects SET name=? WHERE id=?').run(name, id)
            db.exec('COMMIT')
          } catch (e) { db.exec('ROLLBACK'); throw e }
          writeAudit?.(db, {
            owner: ps.username, verb: 'write', tool: 'project_update', result: 'ok',
            requestSummary: `project=${id}${hasName ? ` name=${name}` : ''}${hasRecap ? ' recap' : ''}`, source: 'platform',
          })
          sendJson(res, 200, { ok: true, project: { ...getProject(db, id), clusterName: clusterNameOf(p.clusterId) } })
        } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.updateFailed') }) }
        return true
      }

      // 绑定/解绑集群(2026-08-30 spec §4):仅改 clusterId 一列;''=解绑;不动 manifests/repo。
      // gap3-03(2026-09-07 审计批次三):换绑/解绑与在途对话协调——clusterId **实际变化**时,
      // 该项目 running 对话 epoch 中止(bump+abort,终态 failed+error=「项目集群已变更」,迟到
      // 产出静默丢弃——k8sSession 是旧集群的,任何迟到写入都是串味数据)、paused 对话
      // pendingApproval 失效(拒绝语义:审批快照锚定旧集群 gap3-02,续跑即越权)。同值重放
      // (绑同一个集群)零失效:幂等不误杀在途对话。顺序=先查+失效后审计?不——审计是
      // durable 权威源(PT5 deny 同序),先于终态翻转落账;查询/失效/审计零 await 同步块
      // (node:sqlite 同步),无 TOCTOU 窗口。invalidateConversation 返回 ok:false(对话恰好
      // 自然终态)时该行不计入也不误报。wbAgent 可选链兼容旧测试桩;失效计数回带响应。
      if (seg[1] === 'cluster' && req.method === 'PUT') {
        const input = await readBody(req)
        const cid = input.clusterId ?? ''
        if (cid && !db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) { sendJson(res, 404, { message: msg(req, 'wbp.clusterNotFound') }); return true }
        if (cid && !clusterEntitled(ps, cid)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
        db.prepare('UPDATE workbench_projects SET clusterId=? WHERE id=?').run(cid, id)
        let invalidatedConversations = 0
        if (cid !== p.clusterId) {
          const reason = msg(req, 'wbp.clusterChanged')
          const active = db.prepare("SELECT id FROM workbench_conversations WHERE projectId=? AND status IN ('running','paused')").all(id)
          for (const c of active) {
            writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'wb_conv', result: 'ok', requestSummary: `conv=${c.id} invalidate cluster=${p.clusterId || '(unbound)'}→${cid || '(unbound)'}`, source: 'platform' })
            if (wbAgent?.invalidateConversation?.(c.id, reason)?.ok) invalidatedConversations++
          }
        }
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'workbench_project_cluster', result: 'ok', requestSummary: `project=${id} clusterId=${cid || '(unbound)'}`, source: 'platform' })
        sendJson(res, 200, { ok: true, project: { ...getProject(db, id), clusterName: clusterNameOf(cid) }, invalidatedConversations })
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
          if (!clusterEntitled(ps, p.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
          const input = await readBody(req)
          const r = await wbCommit(repo, input.message || 'update')
          sendJson(res, 200, r)
          return true
        } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbp.commitFailed') }); return true }
      }

      // reconcile :id/reconcile(第 4 阶段 R2):幂等再 apply manifests,集群对齐 repo(声明字段作用域)
      if (seg[1] === 'reconcile' && req.method === 'POST') {
        try {
          if (!clusterEntitled(ps, p.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
          const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(p.clusterId)
          if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.boundClusterNotFound') }); return true }
          const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now(), userId: ps.userId, clusterId: p.clusterId }
          // W2 C+D 终审#5:reconcile 与 wb_apply 同门——逐文档 ns 过 operate;集群级 kind 走
          // null-ns 门(allowlist 非 admin 拒);不可发现(null)→ 拒(审计 P1-6 2026-09-07
          // fail-closed,gateApplyNamespaces 内统一执法)。否则项目 owner 可经 reconcile 按钮写未授权 ns
          //(同一 manifests 走 AI wb_apply 却被拒的 parity 缺口)。manifests 为空零门(reconcile 幂等空跑)。
          const { resolveApplyNamespaces } = createApplyYaml({ requestKubernetes })
          const manifestsYaml = await wbReadManifests(repo)
          if (manifestsYaml && manifestsYaml.trim()) {
            let docNss = []
            try { docNss = await resolveApplyNamespaces(k8sSession, manifestsYaml, undefined) } catch { /* 解析失败走 reconcile 原语义 */ }
            try { gateApplyNamespaces(wbToolGate(db, { userId: ps.userId, role: ps.role }, p.clusterId), docNss, 'reconcile') }
            catch (e) { sendJson(res, 403, { message: msg(req, 'api.nsForbidden') }); return true }
          }
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
      const ps = requirePlatform(req, res); if (!ps) return true
      const projectId = url.searchParams.get('projectId')
      const kindRaw = (url.searchParams.get('kind') || '').toLowerCase()
      const q = (url.searchParams.get('q') || '').toLowerCase()
      if (!projectId) { sendJson(res, 400, { message: msg(req, 'wbp.projectIdRequired') }); return true }
      const p = db.prepare('SELECT * FROM workbench_projects WHERE id=?').get(projectId)
      if (!p) { sendJson(res, 404, { message: msg(req, 'wbp.projectNotFound') }); return true }
      // server 分支(2026-08-30 @server spec §3):与集群无关;exposedOnly 单一事实源。
      // W2 Phase D(CB-B Task 3 + merge 2026-09-06 裁决):Phase D 已把对话域降门为 platform+owner,
      // main 审计#7 的「对话域恒 admin」前提随之失效——取 ownership 语义(项目须为发起者所有,
      // admin 豁免),替代审计#7 的 requireAdmin 收紧;host 仅 admin 响应携带(下方既有语义)。
      if (kindRaw === 'server') {
        if (!assertProjectOwnership(ps, p)) { sendJson(res, 403, { message: msg(req, 'wbp.noProjectAccess') }); return true }
        // refs-injection-04(2026-09-07 审计批次三):q 只匹 name/description——host 参与模糊
        // 匹配是脱敏 oracle(host 字段按角色脱敏不下发,但 q=host 子串的命中/不命中逐位二分
        // 即可还原完整 host,命中结果行还会原样带出 host)。host 过滤需求改由独立 host 查询
        // 参数承担,且为**等值**比对:要过滤必须已知完整 host,无子串探测面(前端当前不传
        // 该参数,留作 API 消费方的精确选择通道;非 admin 无 host 字段回传,等值过滤对其
        // 仍不可当 oracle 用——不知完整 host 就恒零命中)。
        const hostEq = (url.searchParams.get('host') || '').trim()
        const items = listSshServers(db, { exposedOnly: true })
          .filter(s => (!q || s.name.toLowerCase().includes(q) || String(s.description || '').toLowerCase().includes(q))
            && (!hostEq || String(s.host || '') === hostEq))
          .slice(0, 50)
          .map(s => ({ kind: 'server', name: s.name, description: s.description || '', clusterRef: s.clusterRef || '', ...(ps.role === 'admin' ? { host: s.host } : {}) }))
        sendJson(res, 200, { items })
        return true
      }
      // W2 审计 P1-4(2026-09-07):K8s 分支此前仅 requireAdmin(无 ownership/entitlement/ns
      // 过滤)——既是普通用户 @mention K8s 搜索恒拒的功能缺口,也是「降门即成洞」的第二份
      // 集群级 list。与 server 分支同门(spec §6.2 E/§6.3):ownership(owner/admin)+
      // clusterEntitled;候选集来自已授权查询——wbToolGate.namespaces() 结果过滤(admin/
      // open → null 不限;无 ns 的集群级条目对受限用户不可见,同 wb_list_resources 语义)。
      if (!assertProjectOwnership(ps, p)) { sendJson(res, 403, { message: msg(req, 'wbp.noProjectAccess') }); return true }
      if (!p.clusterId) { sendJson(res, 400, { message: msg(req, 'wbp.noBoundCluster') }); return true }
      if (!clusterEntitled(ps, p.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
      const kind = normalizeKind(kindRaw) || 'pods'
      const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(p.clusterId)
      if (!cluster) { sendJson(res, 404, { message: msg(req, 'wbp.boundClusterNotFound') }); return true }

      // kind → K8s list path:统一从 kind-paths.mjs 派生(本路由曾持 15-kind 私有表,已删)。
      // 集群级列表 + 服务端按授权 ns 过滤(枚举源原则)+ 前端客户端过滤 name。
      const listPath = listApiPath(kind, '')
      if (!listPath) { sendJson(res, 400, { message: msg(req, 'wbp.kindUnsupported', { kind }) }); return true }

      try {
        const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
        const resp = await requestKubernetes(k8sSession, listPath)
        const nsScope = wbToolGate(db, ps, p.clusterId).namespaces()
        const items = (resp?.body?.items || [])
          .filter(it => !nsScope || (it.metadata?.namespace && nsScope.has(it.metadata.namespace)))
          .map(it => ({
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
      // 2026-09-07 审计 F4:全集群 survey 台账(含待审蒸馏稿 pending)不得对无授权平台用户
      // 开放——与兄弟端点(POST 创建/PUT cluster/commit/reconcile)同一把 clusterEntitled 门。
      if (!clusterEntitled(ps, clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
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
