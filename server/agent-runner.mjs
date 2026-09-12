// 把 agent 核心接到工具(W4:K8s 工具 + 工作台工具,双-principal 经 registry 分派)。
// 双-principal 桥 = registry 本身:K8s 工具 exec 包 callTool(keyRow+SA+审计),
// 工作台工具 exec 用 ctx.wb.{readLedger,readFile,writeFile}(端点注入,平台侧 git)。
// 按 ctx 里有什么决定 offering:有 keyRow → K8s 工具(按 effectiveTools:tier ∪ per-key tool_overrides 覆盖);有 workbench → 工作台工具。
import { createAgent } from './agent.mjs'
import { registry } from './tool-registry.mjs'
import { effectiveTools } from './authorize.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { modeAutoPasses } from './wb-approval-mode.mjs'

// 工作台审计:wb_* 工具(用项目绑定集群凭据直连)不走 API key 的 callTool 审计,
// 此处在 execTool 补一条 reserve/finalize 进 audit_log(source='workbench'),让 AI 驱动的集群变更可追溯。
// 仅当传入 audit={db,owner,clusterId} 时启用(workbench 路径);API key 路径不传 → 不重复审计。
const WRITE_TOOLS = new Set(['wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'wb_exec', 'wb_ssh_exec', 'write_server_notes', 'write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
  'wb_ssh_run', 'wb_ssh_job_write', 'wb_ssh_job_kill'])
function wbAuditIntent(audit, name, args) {
  let resource = null
  if (args?.server) resource = args.server === '__global__' ? 'SshLedger/__global__' : `SshServer/${args.server}`
  else if (args?.credential) resource = `Credential/${args.credential}`
  else if (name === 'write_server_notes') resource = `SshLedger/${args?.scope || 'unknown'}`          // SSH 工具(2026-08-28):按服务器归因
  else if (args?.kind && args?.name) resource = `${args.kind}/${args.name}`
  else if (args?.pod) resource = `Pod/${args.pod}`
  else if (args?.name) resource = args.name
  else if (args?.path) resource = args.path
  let summary = null
  try { summary = JSON.stringify(args).slice(0, 120) } catch { /* 忽略不可序列化 */ }
  return {
    owner: audit.owner, clusterId: audit.clusterId,
    namespace: args?.namespace || null,
    verb: WRITE_TOOLS.has(name) ? 'write' : 'read',
    resource, tool: name, source: 'workbench', requestSummary: summary,
  }
}

// OpenAI tools 格式:buildToolDefs(tier) 仅测试用;运行时 offering 用 registry.toolDefsFor(effectiveTools(keyRow))(per-key 覆盖)。
export function buildToolDefs(tier) {
  return registry.toolDefsForTier(tier)
}

// 工厂:注入 llmClient + (apiKeyTools,keyRow,cluster) 和/或 workbench。返回 { run, toolDefs }。
// workbench = { readLedger, readFile, writeFile }(端点注入的闭包,操作项目/台账 repo)。
// audit = { db, owner, clusterId }(可选,workbench 路径传):wb_* 工具执行进 audit_log。
// maxSteps(可选):透传 createAgent;缺省用 agent.mjs 的 MAX_STEPS=8;0 = 不限制(须 != null 判定,0 是合法值)。
// disabledTools(可选,2026-08-25):工作台工具禁用名单(即时生效,权限收紧语义)。
// dynamicApproval(可选,2026-08-28 SSH):async (name, args) => bool——静态 requiresApproval 命中时
//   再问钩子(true=需人审),SSH 按服务器策略(always/readonly/none)放宽/收紧;缺省保持旧行为(恒 true)。
// excludeTools(可选,2026-08-28 SSH):Set<string> 从合并后的 toolDefs 剔除(零暴露时隐藏 SSH 工具)。
// shouldAbort(可选,2026-09-06 审计#3):() => bool | Promise<bool>——透传 createAgent 的轻量
//   取消检查点(workbench-agent 注入「读对话状态 === cancelled」闭包);缺省零行为变化。
// signal(可选,2026-09-07 审计批次三 agent-loop-05):AbortSignal 透传 llmClient.chatStream
// (用户取消 → cancelConversation 主动 abort 在途 fetch;与 shouldAbort 分工:shouldAbort 拦
// 「下一个工具/下一轮」,signal 断「在途流」)。只对流式路径生效(chat 非流式自有 timeoutMs
// 总限);缺省零行为变化(API key agent 路径不传)。
// approvalMode(可选,2026-09-09 审批三档模式):() => 'ask'|'writes'|'auto'(同步现读,
// workbench 路径注入 owner 的 prefs)——needsApproval 静态命中后先问模式层(modeAutoPasses
// 白名单),命中放行直接 false(不 checkpoint、不进 SSH 路由);放行的执行行审计
// requestSummary 追加 ' approval:auto' 标记(截断后追加,长 args 不吞标记)。SSH 工具恒不
// 放宽(服务器策略更严者胜,见 wb-approval-mode.mjs);缺省零行为变化。
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster, workbench, audit, maxSteps, disabledTools, budgetChars, dynamicApproval, excludeTools, shouldAbort, signal, approvalMode }) {
  const toolDefs = [
    ...(keyRow ? registry.toolDefsFor(effectiveTools(keyRow)) : []),
    ...(workbench ? registry.workbenchToolDefs(disabledTools) : []),
  ].filter(d => !(excludeTools && excludeTools.has(d.function.name)))
  const offered = new Set(toolDefs.map(t => t.function.name))
  const requiringApproval = new Set(registry.requiringApproval())
  const ctx = { apiKeyTools, keyRow, cluster, wb: workbench, ssh: workbench?.ssh || null, sshJobs: workbench?.sshJobs || null, creds: workbench?.creds || null }
  const execTool = async (name, args) => {
    const t = registry.get(name)
    if (!t) throw new Error(`未知工具: ${name}`)
    // 未 offered 的工具拒绝执行(2026-08-29 审计):disabledTools/excludeTools 只滤 toolDefs,
    // LLM 自拟/幻觉调用被剔除的工具名时,若此处不拦,人审门(offered 交集)也会同步跳过。
    if (!offered.has(name)) throw new Error(`工具 ${name} 未在本次会话提供(已被禁用或未授权)`)
    if (!audit) return t.exec(ctx, args) // registry 分派:K8s→callTool(自带审计);工作台无 audit→不审计
    // workbench 路径:reserve → 执行 → finalize(成功/失败都落链)
    const intent = wbAuditIntent(audit, name, args)
    // 模式放行标记(2026-09-09):链上区分「人批」(wb_approval approve 行)vs「模式放行」。
    // (mode, name) 纯函数重判——与门同一输入;mid-run 切档的毫秒级窗口内标记可能滞后于门,
    // 可接受(标记是溯源注记,门的裁决才是权威)。截断后追加,长 args 不吞标记。
    if (approvalMode && modeAutoPasses(approvalMode(), name)) {
      intent.requestSummary = intent.requestSummary ? `${intent.requestSummary} approval:auto` : 'approval:auto'
    }
    reserveAudit(audit.db, intent)
    try {
      const r = await t.exec(ctx, args)
      finalizeAudit(audit.db, intent, r?.error ? { result: 'error', reason: String(r.error?.message || r.error).slice(0, 80) } : { result: 'ok' })
      return r
    } catch (e) {
      finalizeAudit(audit.db, intent, { result: 'error', reason: String(e?.message || e).slice(0, 80) })
      throw e
    }
  }
  const chat = (messages, tools, opts) =>
    (opts?.onDelta || opts?.onReasoning) ? llmClient.chatStream({ messages, tools }, { onDelta: opts.onDelta, onReasoning: opts.onReasoning, ...(signal ? { signal } : {}) })
                  : llmClient.chat({ messages, tools })
  // 只对「本次 offered 的写工具」要求人审;K8s tier 够不上的写工具不 offered → 直接不调。
  // 静态命中才问模式层(2026-09-09 三档:writes/auto 白名单放行,SSH 工具恒不在名单);
  // 再问 dynamicApproval(SSH 按服务器策略放宽/收紧);无钩子保持旧行为。
  const needsApprovalFn = async (n, args) => {
    if (!requiringApproval.has(n) || !offered.has(n)) return false
    if (approvalMode && modeAutoPasses(approvalMode(), n)) return false
    if (dynamicApproval) return !!(await dynamicApproval(n, args))
    return true
  }
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: needsApprovalFn, ...(maxSteps != null ? { maxSteps } : {}), ...(budgetChars ? { budgetChars } : {}), ...(shouldAbort ? { shouldAbort } : {}) })
  return { run: agent.run, toolDefs }
}
