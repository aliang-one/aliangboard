// 工具注册表(W4):统一 agent/MCP 工具的 metadata + 分派路由。单一源。
// K8s 工具(principal:'k8s')exec 包底座 callTool(keyRow+SA+审计);
// 工作台工具(W4b,principal:'platform')exec 走平台 session + projectId。
// agent-runner 用 registry 决定 toolDefs / 人审 / 分派;双-principal 桥 = registry 本身(每工具 exec 闭包持各自 principal)。
// authorize.mjs 的 tierTools 仍管 MCP /mcp 的 K8s 权限过滤(未改,零回归);本表管 agent 工具面。

const RANK = { read: 0, operator: 1, admin: 2 }
const rank = t => RANK[t] ?? 99

// 6 个已实现 K8s 工具(agent/MCP 面)。minTier = 最低可用档;requiresApproval = agent 调用时走 checkpoint 人审。
const ENTRIES = [
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
].map(t => ({
  ...t,
  principal: 'k8s',
  exec: (ctx, args) => ctx.apiKeyTools.callTool(ctx.keyRow, ctx.cluster, t.name, args), // 复用底座全套
}))

export const registry = {
  get: name => ENTRIES.find(t => t.name === name) || null,
  forTier: tier => ENTRIES.filter(t => rank(t.minTier) <= rank(tier)).map(t => t.name),
  requiringApproval: () => ENTRIES.filter(t => t.requiresApproval).map(t => t.name),
  toolDefsForTier: tier => ENTRIES.filter(t => rank(t.minTier) <= rank(tier)).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
  toMeta: () => Object.fromEntries(ENTRIES.map(t => [t.name, { description: t.description, inputSchema: t.inputSchema }])),
  all: () => ENTRIES,
}
