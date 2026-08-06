// 工具注册表(W4):统一 agent 工具的 metadata + 分派路由。单一源。
// 两族工具,两个 principal,一个 registry(双-principal 桥 = registry 本身):
//   - K8s 工具(principal:'k8s',有 minTier):exec 包底座 callTool(keyRow+SA+审计);按 tier 过滤。
//   - 工作台工具(principal:'platform',无 minTier):exec 用 ctx.wb.{readLedger,readFile,writeFile};
//     不走 K8s tier(forTier 因 minTier 缺失自动排除);write_project_file 走人审。
// agent-runner 按 ctx 里有什么(keyRow / workbench)决定 offering;execTool 经 registry.get(name).exec(ctx,args) 分派。

const RANK = { read: 0, operator: 1, admin: 2 }
const rank = t => RANK[t] ?? 99 // 工作台工具无 minTier → rank 99 → 自动排除出 forTier/toolDefsForTier

// 6 个已实现 K8s 工具。minTier = 最低可用档;requiresApproval = agent 调用时走 checkpoint 人审。
const K8S = [
  { name: 'get_pod_logs', minTier: 'read', requiresApproval: false,
    description: '获取 pod 日志(有界 tail,非 follow)。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, pod: { type: 'string' }, container: { type: 'string' }, tail: { type: 'number' } }, required: ['namespace', 'pod'] } },
  { name: 'list_resources', minTier: 'read', requiresApproval: false,
    description: '列出 namespace 内某 kind 的资源(slim 名单)。kind: pods/services/configmaps/deployments/statefulsets/daemonsets。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string' } }, required: ['namespace'] } },
  { name: 'get_resource', minTier: 'read', requiresApproval: false,
    description: '获取单个资源完整对象(去 managedFields)。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' } }, required: ['namespace', 'kind', 'name'] } },
  { name: 'get_events', minTier: 'read', requiresApproval: false,
    description: '列出 namespace 事件(可按资源 name 过滤)。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, name: { type: 'string' } }, required: ['namespace'] } },
  { name: 'scale', minTier: 'operator', requiresApproval: true,
    description: '扩缩容(operator+ 档)。replicas 会被钳到 1..20(禁止 scale 到 0)。kind: deployments/statefulsets。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string', enum: ['deployments', 'statefulsets'] }, name: { type: 'string' }, replicas: { type: 'number' } }, required: ['namespace', 'kind', 'name', 'replicas'] } },
  { name: 'restart', minTier: 'operator', requiresApproval: true,
    description: 'rollout restart(operator+ 档)。kind: deployments/statefulsets/daemonsets。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string', enum: ['deployments', 'statefulsets', 'daemonsets'] }, name: { type: 'string' } }, required: ['namespace', 'kind', 'name'] } },
].map(t => ({ ...t, principal: 'k8s', exec: (ctx, args) => ctx.apiKeyTools.callTool(ctx.keyRow, ctx.cluster, t.name, args) }))

// 工作台工具(principal:'platform')。exec 用 ctx.wb.{readLedger,readFile,writeFile}(端点注入闭包)。
const WB = [
  { name: 'read_ledger', requiresApproval: false,
    description: '读取集群台账 INDEX.md(平台 survey 的事实层:namespaces/工作负载/入口/存储)。agent 据此复用已知能力,避免从零摸集群。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    exec: async (ctx) => { try { return await ctx.wb.readLedger() } catch (e) { return `读台账失败: ${e.message}` } } },
  { name: 'read_project_file', requiresApproval: false,
    description: '读取项目 repo 内某文件(如 manifests/ 下已写的 yaml 或 notes/)。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '相对路径,如 manifests/deploy.yaml' } }, required: ['path'] },
    exec: async (ctx, args) => { try { return await ctx.wb.readFile(args.path) } catch (e) { return `读文件失败: ${e.message}` } } },
  { name: 'write_project_file', requiresApproval: true,
    description: '写/覆盖项目 repo 内某文件(如写 manifests/deploy.yaml)。需人审;批准后落盘(未自动 commit)。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    exec: async (ctx, args) => { await ctx.wb.writeFile(args.path, args.content); return { ok: true, path: args.path } } },
  { name: 'apply_project_manifests', requiresApproval: true,
    description: '把项目 manifests/ 下所有 yaml server-side apply 到集群(逐资源,部分失败上报 {applied,failed})。需人审。apply 走平台 apply 路径(审计),不走 API key 的 SA。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    exec: async (ctx) => { const yaml = await ctx.wb.readManifests(); if (!yaml || !yaml.trim()) return { error: 'manifests/ 为空,先 write_project_file 写 yaml 再 apply' }; return ctx.wb.applyManifests(yaml) } },
  { name: 'propose_learning', requiresApproval: true,
    description: '记一条团队习惯/踩坑/决策到台账 learnings.md(如"Go 服务走 goproxy.internal")。需人审,原样批准(追加)。',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    exec: async (ctx, args) => { await ctx.wb.appendLearning(args.content); return { ok: true } } },
  { name: 'bootstrap_ledger', requiresApproval: true,
    description: '重新 survey 绑定集群(namespaces/节点/IngressClass/StorageClass/工作负载)→ 重写台账 INDEX.md(verified_at 刷新),回摘要。用于:台账为空/过时、用户问"集群有什么能力/资源"或"更新台账"时先调它,再 read_ledger 看详情。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    exec: async (ctx) => ctx.wb.bootstrapLedger() },
].map(t => ({ ...t, principal: 'platform', exec: t.exec }))

const ENTRIES = [...K8S, ...WB]

const toDef = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })

export const registry = {
  get: name => ENTRIES.find(t => t.name === name) || null,
  // K8s 工具按 tier(WB 工具 minTier 缺失 → rank 99 → 自动排除)
  forTier: tier => ENTRIES.filter(t => rank(t.minTier) <= rank(tier)).map(t => t.name),
  toolDefsForTier: tier => ENTRIES.filter(t => rank(t.minTier) <= rank(tier)).map(toDef),
  // 工作台工具(无 tier)
  workbenchToolDefs: () => WB.map(toDef),
  // 所有需人审的(K8s scale/restart + WB write_project_file);runner 用 offering 交集判定
  requiringApproval: () => ENTRIES.filter(t => t.requiresApproval).map(t => t.name),
  toMeta: () => Object.fromEntries(ENTRIES.map(t => [t.name, { description: t.description, inputSchema: t.inputSchema }])),
  all: () => ENTRIES,
}
