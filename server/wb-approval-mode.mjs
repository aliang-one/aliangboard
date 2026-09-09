// 工作台 AI 对话审批三档模式(2026-09-09 VSCode 风格设计):
//   ask(默认)= 完全现状——静态 requiresApproval + SSH 服务器策略放宽,零行为变化;
//   writes   = 写类自动放行、命令执行(wb_exec)仍人审;
//   auto     = 模式管辖工具全部放行。
// 组合不变式:wb_ssh_* 工具(含 job 桥)恒由服务器 aiApprovalPolicy 裁决,模式不放宽
// (更严者胜——服务器策略是注册时的治理决定,用户模式只在其上放宽自己这层);
// write_server_notes 是平台台账写(非服务器命令),归模式管辖。
// 白名单枚举 = fail-closed:未来新加入 requiringApproval 的工具不进名单 → 任何模式下仍人审。
export const WB_APPROVAL_MODES = ['ask', 'writes', 'auto']

// writes 档自动放行的写类(9 个);auto 档管辖全集 = 此名单 + wb_exec(10 个)。
const WRITES_AUTO_TOOLS = new Set([
  'write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
  'wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'write_server_notes',
])
const AUTO_TOOLS = new Set([...WRITES_AUTO_TOOLS, 'wb_exec'])

// 纯函数:该 (mode, tool) 组合是否免人审直执行。SSH 前缀工具永不在名单里(恒 false)。
export function modeAutoPasses(mode, name) {
  if (mode === 'writes') return WRITES_AUTO_TOOLS.has(name)
  if (mode === 'auto') return AUTO_TOOLS.has(name)
  return false // ask / 未知模式 / 未成名工具一律不放行
}

// 读用户(platform_users.prefs JSON)的审批模式;缺用户/缺键/垃圾 JSON/垃圾值一律归 'ask'。
// 每次 needsApproval 判定时现读(与 disabledTools 同款「权限语义即时生效」)。
export function readUserApprovalMode(db, userId) {
  try {
    const row = db.prepare('SELECT prefs FROM platform_users WHERE id=?').get(userId)
    if (!row?.prefs) return 'ask'
    const prefs = JSON.parse(row.prefs)
    return WB_APPROVAL_MODES.includes(prefs?.workbenchApprovalMode) ? prefs.workbenchApprovalMode : 'ask'
  } catch { return 'ask' }
}
