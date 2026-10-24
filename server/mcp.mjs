// MCP server(T12):把底座 callTool 暴露成 Streamable HTTP MCP,外部 AI 客户端(Claude Code)用 API key 连。
// 传输:无状态 Streamable HTTP(POST-only,JSON 响应;codex #18:同步有界 tool 不需 GET/SSE 流)。
// 鉴权:Authorization: Bearer <apikey>——key 决定 cluster + SA + tier;endpoint /mcp 不含 cluster(eng-review 4A:同进程独立路由)。
import { resolveApiKey } from './api-key-tools.mjs'
import { touchKeyUsage } from './key-usage-touch.mjs'
import { checkRate } from './rate-limit.mjs'
import { effectiveTools, SSH_KEY_TOOLS } from './authorize.mjs'
import { createSshAgentBridge } from './ssh/agent-bridge.mjs'
import { createSshJobBridge } from './ssh/job-bridge.mjs'
import { resolveJobPolicy } from './ssh/job-policy.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { registry } from './tool-registry.mjs'

// 支持的协议版本(按新→旧;最后一个是「自己最新」)。我们只实现 initialize/ping/tools 的
// POST-only 无状态子集,该子集在所列版本间 wire 兼容 → 客户端请求哪个就回显哪个。
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25']
const PROTOCOL = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]

// MCP tool 元数据(描述 + inputSchema):从 tool-registry 派生(单一源,schema 在 tool-registry.mjs)。
// tools/list 按调用者 effectiveTools 过滤(tier ∪ per-key tool_overrides 覆盖;只列能用的,不广告用不了的)。
// cred: 注入广告句剥离(2026-10-24 审计 P2):MCP/API-key 面执行分派绕开 registry exec
// (apiKeyTools.callTool / sshBridge.exec,零 substitute)——占位符在该面按字面落进目标机
// shell。广告「平台执行时注入实际值,你看不到值」对该面是虚假承诺,还会诱导外部 AI 把
// {{cred:}} 字面写进命令。剥离含 {{cred 的整句(以。收口的句子),追加固定说明。
const CRED_AD_SENTENCE_RE = /[^。]*\{\{cred:[^。]*。/g
// 说明文字刻意不带 {{cred: 字面(下游 AI/守卫按「描述含占位符字面=广告注入」判定)
const MCP_CRED_NOTE = '凭据占位符注入仅在工作台会话生效;本面命令按字面执行,不要使用 cred 占位符语法。'
export function stripCredInjectionNote(desc) {
  const s = String(desc ?? '')
  // 判定用 includes 不用 RE.test:g 标志 RE 的 lastIndex 跨调用串扰,test 会漏检
  return s.includes('{{cred:') ? s.replace(CRED_AD_SENTENCE_RE, '') + MCP_CRED_NOTE : s
}
export const TOOL_META = Object.fromEntries(
  Object.entries(registry.toMeta()).map(([name, m]) => [name, { ...m, description: stripCredInjectionNote(m.description) }])
)

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// ── 可发现性(2026-10-15):initialize instructions —— 教 AI 客户端「要不要用、怎么选」。
// 这是 MCP 协议里 server 级使用指南的唯一注入点;不写,AI 只能逐条读工具描述自行猜
// 触发时机。内容=任务→工具映射速查(锚点词与工具描述三件套互为印证)。
export const MCP_INSTRUCTIONS = `AliangBoard K8s 多集群运维工具箱(按 API key 的 namespace/tier 预先收窄,你看到的就是你能用的)。凡涉及 Kubernetes 的任务——排查异常、查状态、改配置、回滚——优先用这些工具完成,不要让用户手动 kubectl,也不要因为「不确定有没有权限」而不尝试:有界拒绝会返回明确原因。

常用路径速查:
· 排查入口:describe_resource(一次返回对象+关联事件)→ get_pod_logs(pod 日志;崩溃重启用 previous=true 看前一容器)→ exec_pod / browse_files(容器内取证)。
· 不知道资源名/namespace 里有什么:先 list_resources(pods/deployments 等常用 kind 直取;CRD/ingress 等任意 kind 用 path 模式)。
· 改动类操作(scale/update_image/restart/apply_yaml/delete_resource/rollout_undo):动手前用 can_i 自查权限;回滚先 rollout_history 取 revision,再 rollout_undo;改完用 rollout_status 验证。
· 权限被拒(PERMISSION_DENIED)时:错误附原因;拿不准能力边界就用 can_i 预查,不要反复盲试。
· SSH 服务器运维(非 K8s pod):先 read_server_ledger 看各服务器职责,再 wb_ssh_exec(短命令)/ wb_ssh_run(长任务,wb_ssh_job_out 轮询输出)。

安全约定:标「admin 档」的工具需要相应权限的 key;所有命令执行与变更都有审计留痕。`

// ── prompts(斜杠工作流剧本):客户端列为 /mcp:aliangboard:<name>,用户一键把整条
// 工具链喂给 AI——对「AI 不知道从哪开始」的强引导。三个剧本覆盖最高频任务域。
const MCP_PROMPTS = [
  {
    name: 'troubleshoot-pod',
    description: '排障剧本:pod 不就绪/CrashLoop/服务异常,按 describe→events→logs→exec 链路走',
    build: args => `集群里 pod ${args?.pod || '<pod>'} (namespace ${args?.namespace || '<ns>'}) 异常,请按以下链路排查并给出结论:
1) describe_resource 看对象现状与关联事件(镜像/探针/调度/OOMKilled 线索);
2) get_pod_logs 取日志(若反复重启,加 previous=true 看崩溃前日志);
3) 需要容器内取证时 exec_pod(只读命令优先);
4) 汇总结象→根因假设→建议动作;涉及变更先 can_i 自查再执行。`,
  },
  {
    name: 'rollback-deployment',
    description: '回滚剧本:发布出问题,查历史→回滚→验证三步走',
    build: args => `deployment ${args?.name || '<name>'} (namespace ${args?.namespace || '<ns>'}) 的最新发布疑似有问题,请:
1) rollout_status 确认当前卡住/异常状态;rollout_history 列出 revisions 定位上一稳定版;
2) rollout_undo 回滚到该 revision(先 can_i 确认权限);
3) rollout_status 验证回滚完成,并 get_events 复核无新告警。`,
  },
  {
    name: 'ssh-ops',
    description: 'SSH 运维剧本:非 K8s 的服务器操作,先读台账再动手',
    build: args => `我要在服务器 ${args?.server || '<server>'} 上做运维操作: ${args?.task || '<任务描述>'}。
请先 read_server_ledger 确认该服务器角色与注意事项,再选择通道:短命令(<30s)wb_ssh_exec;安装/构建/备份等长任务 wb_ssh_run(用 wb_ssh_job_out 增量读输出,勿轮询过频)。输出截断时按 offset 续读。`,
  },
]

// 工具异常 → AI 可读文本([object Object] 家族灭绝,2026-08-27):当前工具链 throw 均为
// Error/PermissionDeniedError(e.message 恒有),但未来新工具 throw 裸对象/字符串时,
// String(obj) 会塌成 [object Object](get_pod_logs previous=true 同族事故的协议层残留点)。
// 契约:Error → message;字符串 → 原文;其它 → JSON 序列化(序列化自身失败才 String 兜底)。
function describeThrow(e) {
  if (e?.message) return String(e.message)
  if (typeof e === 'string') return e
  try { const j = JSON.stringify(e); return j ?? String(e) } catch { return String(e) }
}

// 纯逻辑:处理一条 JSON-RPC 消息 → 响应对象(或 null=notification)。可单测,无 HTTP。
export async function handleMcpMessage(msg, { keyRow, cluster, apiKeyTools, db = null, sshBridgeFor = () => { throw new Error('ssh bridge unavailable') }, sshJobBridgeFor = () => { throw new Error('ssh job bridge unavailable') } }) {
  if (!msg || typeof msg !== 'object') return err(null, -32600, 'invalid request')
  if (Array.isArray(msg)) return err(null, -32600, 'invalid request: batch(JSON-RPC 数组)不支持,请逐条 POST') // 审计 P2:数组曾被当 notification 静默吞成 202
  if (msg.id == null) return null // notification(如 notifications/initialized)→ 无响应
  const { id, method, params } = msg

  if (method === 'ping') return ok(id, {}) // spec 要求 server 响应 ping(空 result);此前 -32601 会让部分客户端断连/重连

  // 版本协商(审计 P2):支持客户端请求的版本就回显,否则回自己最新(由客户端决定是否断开)
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL
    return ok(id, { protocolVersion: negotiated, capabilities: { tools: {}, prompts: {} }, instructions: MCP_INSTRUCTIONS, serverInfo: { name: 'aliangboard', version: '0.1.0' } })
  }

  // prompts(可发现性 2026-10-15):斜杠工作流剧本——把「任务→工具链」直接喂给 AI。
  if (method === 'prompts/list') {
    return ok(id, { prompts: MCP_PROMPTS.map(p => ({ name: p.name, description: p.description })) })
  }
  if (method === 'prompts/get') {
    const p = MCP_PROMPTS.find(x => x.name === params?.name)
    if (!p) return err(id, -32602, `unknown prompt: ${params?.name}`)
    return ok(id, { messages: [{ role: 'user', content: { type: 'text', text: p.build(params?.arguments || {}) } }] })
  }

  if (method === 'tools/list') {
    const allowed = effectiveTools(keyRow)
    const tools = apiKeyTools.listTools().filter(t => allowed.has(t)).map(t => ({ name: t, ...TOOL_META[t] }))
    if (keyRow?.sshAccess) for (const n of SSH_KEY_TOOLS) if (allowed.has(n) && TOOL_META[n]) tools.push({ name: n, ...TOOL_META[n] })
    return ok(id, { tools })
  }

  if (method === 'tools/call') {
    const name = params?.name
    // per-key SSH 工具先于集群守卫分派:SSH 通道不依赖 K8s 集群(key 可只授 SSH 不绑集群)。
    // 曾放反位置 → 「集群不存在」把 SSH 调用全数拦死(2026-08-29 e2e 实测抓出)。
    if (SSH_KEY_TOOLS.includes(name)) {
      if (!effectiveTools(keyRow).has(name)) return err(id, -32603, 'PERMISSION_DENIED(policy): 该 key 未授予 SSH 服务器访问')
      const bridge = sshBridgeFor(keyRow)
      const args = params?.arguments || {}
      const intent = { owner: keyRow.owner || keyRow.prefix || 'key', clusterId: keyRow.clusterId || null,
        verb: (name === 'wb_ssh_exec' || name === 'wb_ssh_run') ? 'write' : 'read',
        resource: args?.server ? `SshServer/${args.server}` : 'SshLedger',
        tool: name, source: 'mcp', requestSummary: JSON.stringify(args).slice(0, 120) }
      reserveAudit(db, intent)
      try {
        const out = name === 'read_server_ledger' ? bridge.readLedger(args)
          : name === 'wb_ssh_read_file' ? await bridge.readFile(args)
          : name === 'wb_ssh_run' ? await sshJobBridgeFor(keyRow).run(args)
          : name === 'wb_ssh_job_out' ? await sshJobBridgeFor(keyRow).jobOut(args)
          : name === 'wb_ssh_job_list' ? await sshJobBridgeFor(keyRow).jobList(args)
          : await bridge.exec(args)
        finalizeAudit(db, intent, out?.error ? { result: 'error', reason: String(out.error?.message || out.error).slice(0, 80) } : { result: 'ok' })
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
      } catch (e) {
        finalizeAudit(db, intent, { result: 'error', reason: String(e?.message || e).slice(0, 80) })
        return ok(id, { isError: true, content: [{ type: 'text', text: describeThrow(e) }] })
      }
    }
    if (!cluster) return ok(id, { isError: true, content: [{ type: 'text', text: '集群不存在(API key 绑定的集群已删除?)' }] })
    try {
      const out = await apiKeyTools.callTool(keyRow, cluster, name, params?.arguments || {}, 'mcp')
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
    } catch (e) {
      // 错误可行动化(2026-10-15):拒/404 附下一步建议——AI 客户端拿到的是「换哪条路」
      // 而非裸失败,避免反复盲试同一工具。
      if (e.code === 'PERMISSION_DENIED') return err(id, -32603, `PERMISSION_DENIED(${e.reason}): ${e.detail || e.message}。建议:用 can_i(namespace, verb, resource) 自查该 key 的能力边界,勿重复盲试`)
      const raw = describeThrow(e)
      if (/\b404\b|not found/i.test(raw)) return ok(id, { isError: true, content: [{ type: 'text', text: `${raw}。建议:先 list_resources 确认资源名/namespace 是否正确(path 类工具从其结果取)` }] })
      return ok(id, { isError: true, content: [{ type: 'text', text: raw }] })
    }
  }

  return err(id, -32601, `method not found: ${method}`)
}

// HTTP 包装:鉴权 + 解析 body + 派发 handleMcpMessage + 写响应(stateless Streamable HTTP)。
export function createMcpServer({ db, apiKeyTools, cryptKey, sshPool, getSetting = () => '', setSetting = () => {}, getJobPolicy }) {
  // key 主体 SSH 桥(2026-08-29 per-key sshAccess):keyMode 策略闸在桥内(always→拒 exec,
  // readonly→仅只读命令,none→放行;台账写恒拒)。每 key 一个懒建桥,actor 记 key 前缀。
  const sshBridges = new Map()
  function sshBridgeFor(keyRow) {
    const id = keyRow.id || keyRow.prefix
    if (!sshBridges.has(id)) sshBridges.set(id, createSshAgentBridge({
      db, key: cryptKey, pool: sshPool, projectId: '__key__', actor: keyRow.prefix || keyRow.owner || 'key',
      getSetting, setSetting, keyMode: true,
    }))
    return sshBridges.get(id)
  }
  // per-key SSH 异步任务桥(T7):keyMode fail-closed 在桥内(write/kill 恒拒、run 按策略);
  // 分派层只负责名单(SSH_KEY_TOOLS 不含 write/kill → 不可列不可调)与路由。
  const sshJobBridges = new Map()
  function sshJobBridgeFor(keyRow) {
    const id = keyRow?.prefix || keyRow?.owner || '__key__'
    if (!sshJobBridges.has(id)) sshJobBridges.set(id, createSshJobBridge({
      db, pool: sshPool, projectId: '__key__', keyMode: true,
      getPolicy: () => getJobPolicy?.() || resolveJobPolicy(getSetting, process.env),
    }))
    return sshJobBridges.get(id)
  }
  async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString('utf8'); return b ? JSON.parse(b) : {} }
  function write(res, obj, status = 200, headers = {}) { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }

  return async function handleMcp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end() } // 会话关闭,stateless:ack
    if (req.method === 'GET') return write(res, err(null, -32000, 'stateless server: 用 POST(同步有界 tool,无 GET 流)'), 405) // codex #18
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }

    const keyRow = resolveApiKey(db, req)
    if (!keyRow) return write(res, err(null, -32001, '无效或已吊销的 API key'), 401)
    touchKeyUsage(db, keyRow, { ip: req.socket?.remoteAddress || null }) // 对齐 index.mjs apikey 闸:MCP-only key 不再「最近使用 —」
    const _rl = checkRate(keyRow.id)
    if (!_rl.allowed) return write(res, err(null, -32002, `RATE_LIMITED,${_rl.retryAfter}s 后重试`), 429, { 'Retry-After': String(_rl.retryAfter) })

    let msg
    try { msg = await readBody(req) } catch { return write(res, err(null, -32700, 'parse error'), 400) }

    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(keyRow.clusterId)
    const resp = await handleMcpMessage(msg, { keyRow, cluster, apiKeyTools, db, sshBridgeFor, sshJobBridgeFor })
    if (resp == null) { res.writeHead(202); return res.end() } // notification
    if (msg.method === 'initialize') return write(res, resp, 200, { 'Mcp-Session-Id': 'mcp-' + String(keyRow.id).slice(0, 8) })
    return write(res, resp)
  }
}
