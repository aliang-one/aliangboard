// 把 agent 核心接到工具(W4:K8s 工具 + 工作台工具,双-principal 经 registry 分派)。
// 双-principal 桥 = registry 本身:K8s 工具 exec 包 callTool(keyRow+SA+审计),
// 工作台工具 exec 用 ctx.wb.{readLedger,readFile,writeFile}(端点注入,平台侧 git)。
// 按 ctx 里有什么决定 offering:有 keyRow → K8s 工具(按 tier);有 workbench → 工作台工具。
import { createAgent } from './agent.mjs'
import { registry } from './tool-registry.mjs'

// OpenAI tools 格式:tier 允许的 K8s 工具(从 registry 按 minTier 过滤)。
export function buildToolDefs(tier) {
  return registry.toolDefsForTier(tier)
}

// 工厂:注入 llmClient + (apiKeyTools,keyRow,cluster) 和/或 workbench。返回 { run, toolDefs }。
// workbench = { readLedger, readFile, writeFile }(端点注入的闭包,操作项目/台账 repo)。
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster, workbench }) {
  const toolDefs = [
    ...(keyRow ? registry.toolDefsForTier(keyRow.tier) : []),
    ...(workbench ? registry.workbenchToolDefs() : []),
  ]
  const offered = new Set(toolDefs.map(t => t.function.name))
  const requiringApproval = new Set(registry.requiringApproval())
  const ctx = { apiKeyTools, keyRow, cluster, wb: workbench }
  const execTool = async (name, args) => {
    const t = registry.get(name)
    if (!t) throw new Error(`未知工具: ${name}`)
    return t.exec(ctx, args) // registry 分派:K8s→callTool;工作台→ctx.wb
  }
  const chat = (messages, tools) => llmClient.chat({ messages, tools })
  // 只对「本次 offered 的写工具」要求人审;K8s tier 够不上的写工具不 offered → 直接不调
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: n => requiringApproval.has(n) && offered.has(n) })
  return { run: agent.run, toolDefs }
}
