// 把 agent 核心接到底座(W4a:走 tool-registry 单一源;W4b 加工作台工具 + 双-principal 桥)。
// agent = 内部 API-key 消费者:用一把 key 当 K8s principal,复用 callTool 全套(authorize + SA + 审计)。
// 写操作走 checkpoint/resume 人审(见 agent.mjs)。
import { createAgent } from './agent.mjs'
import { registry } from './tool-registry.mjs'

// OpenAI tools 格式:tier 允许的工具(从 registry 按 minTier 过滤)。
export function buildToolDefs(tier) {
  return registry.toolDefsForTier(tier)
}

// 工厂:注入 llmClient + 底座 apiKeyTools + keyRow(cluster)。返回 { run, toolDefs }。
// execTool 经 registry 分派 → 各工具 exec 闭包(持各自 principal)。W4b 加 workbench ctx 后,平台工具自动接入。
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster }) {
  const toolDefs = buildToolDefs(keyRow.tier)
  const requiringApproval = new Set(registry.requiringApproval())
  const allowed = new Set(registry.forTier(keyRow.tier))
  const ctx = { apiKeyTools, keyRow, cluster }
  const execTool = async (name, args) => {
    const t = registry.get(name)
    if (!t) throw new Error(`未知工具: ${name}`)
    return t.exec(ctx, args) // K8s 工具 → callTool(keyRow+SA);W4b 平台工具 → 平台 session
  }
  const chat = (messages, tools) => llmClient.chat({ messages, tools })
  // 只对「该 tier 实际可用的写工具」要求人审;tier 够不上的写工具直接执行(底座 authorize 会拒)
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: n => requiringApproval.has(n) && allowed.has(n) })
  return { run: agent.run, toolDefs }
}
