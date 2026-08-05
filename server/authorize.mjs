// 授权策略层(T5):单一 authorize chokepoint + tier→toolset + withPolicy 工厂。
// 这是底座的安全心脏:每个原语必须经 withPolicy 包裹,authorize 是唯一策略决策点。
// 重要(codex #4):authorize 是「策略层」决策(tier / 工具 / 吊销),**不是 RBAC enforcement**;
// 真 RBAC = 用 SA token 实发请求时由 apiserver 判。can_i = 策略 AND rbac 的合取(仅 UX,给 AI 自检)。

// 风险分级(eng-review):有界/可逆类 vs 无界/破坏/交互类。MCP 只挂第一类;第二类仅 agent(+人审)。
export const BOUNDED_TOOLS = ['list_resources', 'get_resource', 'get_pod_logs', 'get_events', 'can_i', 'get_resource_yaml', 'scale', 'restart']
export const DANGEROUS_TOOLS = ['exec_pod', 'attach', 'browse_files', 'read_file', 'upload_file', 'port_forward', 'kubectl_debug', 'rollout_undo', 'apply_yaml', 'delete_resource', 'update_image']
const OPERATOR_EXTRA = ['scale', 'restart']            // operator 在 read 基础上加这两个有界写
const READ_TOOLS = BOUNDED_TOOLS.filter(t => !OPERATOR_EXTRA.includes(t))  // read = 有界只读

// tier → 允许的工具集。未知 tier → 空(fail-closed,默认全拒)。
export function tierTools(tier) {
  if (tier === 'read') return READ_TOOLS
  if (tier === 'operator') return BOUNDED_TOOLS
  if (tier === 'admin') return [...BOUNDED_TOOLS, ...DANGEROUS_TOOLS]
  return []
}

// 策略决策:(keyRow, tool) → { allowed, reason? }。纯函数,无副作用。
// reason: 'revoked'(无 key 或已吊销)| 'policy'(tier 不含该工具)。
export function authorize(keyRow, tool) {
  if (!keyRow || keyRow.revokedAt) return { allowed: false, reason: 'revoked' }
  return tierTools(keyRow.tier).includes(tool)
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
