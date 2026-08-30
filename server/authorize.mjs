// 授权策略层(T5):单一 authorize chokepoint + tier→toolset + withPolicy 工厂。
// 这是底座的安全心脏:每个原语必须经 withPolicy 包裹,authorize 是唯一策略决策点。
// 重要(codex #4):authorize 是「策略层」决策(tier / 工具 / 吊销),**不是 RBAC enforcement**;
// 真 RBAC = 用 SA token 实发请求时由 apiserver 判。can_i = 策略 AND rbac 的合取(仅 UX,给 AI 自检)。

// 风险分级(eng-review):有界/可逆类 vs 无界/破坏/交互类。MCP 只挂第一类;第二类仅 agent(+人审)。
// 宇宙必须与 tool-registry.mjs 的 k8s 工具同步(authorize.test.mjs 双向守卫;2026-08-14 审计曾发现
// describe_resource/rollout_status 漏登记 → 全 tier 死工具 + agent 提示词教 LLM 用却必被拒)。
export const BOUNDED_TOOLS = ['list_resources', 'get_resource', 'describe_resource', 'get_pod_logs', 'get_events', 'can_i', 'get_resource_yaml', 'rollout_history', 'rollout_status', 'scale', 'restart']
// DANGEROUS 工具现状分两类(原注释误称全部「未实现」,订正):
//   已实现且对 admin 档广告 —— exec_pod/browse_files/read_file/kubectl_debug/rollout_undo/apply_yaml/delete_resource/update_image:
//     进 apiKeyTools.listTools();MCP tools/list 再按 effectiveTools(tier∪override)过滤,仅 admin 档(或 override 放行)看得见。
//   仍延后接通(对 stateless MCP 价值低/风险高,见 docs/superpowers/specs/2026-08-06-mcp-rollout-and-per-tool-override-design.md「显式延后」):
//     attach(streaming)、port_forward(网关主机 TCP 监听,外部 AI 拿到不可达 localhost)、upload_file(exec 写文件,转义/注入面大)。
//   未实现的不进 apiKeyTools.listTools() → tools/list 自然不广告;但名都留在 DANGEROUS_TOOLS 以保持 tier 组合的完整性(unknown tier → fail-closed)。
export const DANGEROUS_TOOLS = ['exec_pod', 'attach', 'browse_files', 'read_file', 'upload_file', 'port_forward', 'kubectl_debug', 'rollout_undo', 'apply_yaml', 'delete_resource', 'update_image']
// 显式延后(有登记、无实现):DANGEROUS_TOOLS 里的这 3 个名仅为 tier 组合完整性保留。
// 导出成机器可查常量,守卫测试据此放行(宇宙 ⊆ 注册表 ∪ DEFERRED)。
export const DEFERRED_TOOLS = ['attach', 'port_forward', 'upload_file']
const OPERATOR_EXTRA = ['scale', 'restart']            // operator 在 read 基础上加这两个有界写
const READ_TOOLS = BOUNDED_TOOLS.filter(t => !OPERATOR_EXTRA.includes(t))  // read = 有界只读

// tier → 允许的工具集。未知 tier → 空(fail-closed,默认全拒)。
export function tierTools(tier) {
  if (tier === 'read') return READ_TOOLS
  if (tier === 'operator') return BOUNDED_TOOLS
  if (tier === 'admin') return [...BOUNDED_TOOLS, ...DANGEROUS_TOOLS]
  return []
}

// 运行时有效工具集:lenient。损坏/缺 override → 回退 tier(fail-open 到 tier,不锁死 key)。
// keyRow.tool_overrides 来自 DB(TEXT 串)或内存对象,两者都兼容。
// per-key SSH 服务器访问(2026-08-29,开源从简:布尔授予):授予即并入 MCP 面三个只读/受限工具。
// 注意:write_server_notes 不对 key 开放(台账写仅工作台 AI,带人审)。可见性仍由服务器 exposeToAi 双重把关。
// T7(2026-08-30)扩容:异步任务三工具入列(run=启动即返 jobId 的后台任务;out/list 只读轮询)。
// write/kill 恒不入:keyMode 无人审,应答/终止仅工作台 AI(桥内也 fail-closed 双保险)。
export const SSH_KEY_TOOLS = ['read_server_ledger', 'wb_ssh_exec', 'wb_ssh_read_file', 'wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_list']
export function effectiveTools(keyRow) {
  const set = new Set(tierTools(keyRow?.tier))
  if (keyRow?.sshAccess) for (const t of SSH_KEY_TOOLS) set.add(t)
  const raw = keyRow?.tool_overrides
  if (!raw) return set
  let ov
  try { ov = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return set }
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) return set
  if (Array.isArray(ov.allow)) for (const t of ov.allow) if (typeof t === 'string') set.add(t)
  if (Array.isArray(ov.deny)) for (const t of ov.deny) if (typeof t === 'string') set.delete(t)
  return set
}

// mint/update 用:strict。坏形状/未知名/allow∩deny → 抛。返回存库的规范 JSON 串(空→null)。
// 已知工具宇宙 = BOUNDED ∪ DANGEROUS(恰好 K8s 工具全集;工作台工具不受覆盖管辖)。
export function normalizeToolOverrides(raw) {
  if (raw == null) return null
  const ov = typeof raw === 'string' ? JSON.parse(raw) : raw  // 坏串让 JSON.parse 抛
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) throw new Error('tool_overrides 必须是 {allow?,deny?} 对象')
  const allow = Array.isArray(ov.allow) ? ov.allow : (ov.allow == null ? [] : null)
  const deny = Array.isArray(ov.deny) ? ov.deny : (ov.deny == null ? [] : null)
  if (!allow || !deny) throw new Error('tool_overrides allow/deny 必须是字符串数组')
  const known = new Set([...BOUNDED_TOOLS, ...DANGEROUS_TOOLS])
  for (const t of [...allow, ...deny]) if (!known.has(t)) throw new Error(`tool_overrides 含未知工具: ${t}`)
  const both = allow.filter(t => deny.includes(t))
  if (both.length) throw new Error(`tool_overrides 工具不能同时 allow 与 deny: ${both.join(',')}`)
  const out = {}
  if (allow.length) out.allow = allow
  if (deny.length) out.deny = deny
  return Object.keys(out).length ? JSON.stringify(out) : null
}

// 运行时有效 namespace 集:lenient。损坏/缺 → 回退 [boundSA_namespace](fail-open,不锁死)。
// boundSA_namespace 永远在;allowed_namespaces 只存额外 ns。
export function effectiveNamespaces(keyRow) {
  const set = new Set([keyRow?.boundSA_namespace])
  const raw = keyRow?.allowed_namespaces
  if (!raw) return set
  let arr
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return set }
  if (Array.isArray(arr)) for (const ns of arr) if (typeof ns === 'string' && ns) set.add(ns)
  return set
}

// mint/PATCH 用:strict。ns 名 dns-label 校验;boundNS 运行时自动并入 → 不重复存。坏→抛。返 JSON 串或 null。
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/  // K8s RFC1123 label
export function normalizeAllowedNamespaces(raw, boundNs) {
  if (raw == null) return null
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null)  // 坏串让 JSON.parse 抛
  if (!arr) throw new Error('allowed_namespaces 必须是字符串数组')
  const out = []
  for (const ns of arr) {
    if (typeof ns !== 'string') throw new Error('allowed_namespaces 必须是字符串数组')
    if (!NS_NAME.test(ns) || ns.length > 63) throw new Error(`非法 namespace 名(需 dns-label,≤63): ${ns}`)
    if (ns !== boundNs && !out.includes(ns)) out.push(ns)  // boundNS 运行时自动并入,不重复存;dedup
  }
  return out.length ? JSON.stringify(out) : null
}

// 策略决策:(keyRow, tool) → { allowed, reason? }。纯函数,无副作用。
// reason: 'revoked'(无 key 或已吊销)| 'policy'(tier 不含该工具)。
export function authorize(keyRow, tool) {
  if (!keyRow || keyRow.revokedAt) return { allowed: false, reason: 'revoked' }
  return effectiveTools(keyRow).has(tool)
    ? { allowed: true }
    : { allowed: false, reason: 'policy' }
}

// 统一拒绝错误 shape(eng-review:让 AI 能区分"没权限"vs"被限流",减少无脑重试)。
// reason: policy | rbac | ratelimited | revoked
export class PermissionDeniedError extends Error {
  constructor(reason, extra = {}) {
    super(`PERMISSION_DENIED: ${reason}`)
    this.code = 'PERMISSION_DENIED'
    this.reason = reason
    Object.assign(this, extra)
  }
}

// can_i = 策略 AND rbac 的合取(codex #4:SSAR 仅 UX;真授权看实发请求)。
// policyAllowed 来自 authorize;rbacAllowed 来自 SSAR(用 SA token 发,由 can_i 工具调)。
export function canIDecision(policyAllowed, rbacAllowed) {
  return { allowed: policyAllowed && rbacAllowed, policy: !!policyAllowed, rbac: !!rbacAllowed }
}

// withPolicy 工厂:每个原语经它注册 → authorize 是唯一决策点,无法绕过。
// ctx 须带 keyRow(由 API-key 中间件解析后挂上)。拒绝 → 抛 PermissionDeniedError(带 reason + tool);
// 路由 catch 后审计(T7)+ 返回 403。
// 结构性 enforcement(codex #6):handler 只拿 ctx(含 scoped dispatcher),tool 模块不 import 原始 db/dispatcher。
export function withPolicy(tool, handler) {
  return async (ctx, params) => {
    const decision = authorize(ctx.keyRow, tool)
    if (!decision.allowed) throw new PermissionDeniedError(decision.reason, { tool })
    return handler(ctx, params)
  }
}
