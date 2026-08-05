// 把 agent 核心接到底座(切片 1+2)。
// 关键:agent = 内部 API-key 消费者——用一把 key 当 principal,复用 callTool 全套(authorize + SA + 审计)。
// 不另造 principal 抽象(MVP);admin 给 agent 选/签一把 key(绑 SA、定 tier),agent 跑该 key 的权限。
import { createAgent } from './agent.mjs'
import { tierTools } from './authorize.mjs'
import { TOOL_META } from './mcp.mjs'

// 这些 tool 经 agent 调用时需人审(写操作不自动执行)。
const WRITE_TOOLS = new Set(['scale', 'restart'])

// OpenAI tools 格式:tier 允许的 tool(从 mcp TOOL_META 按 tierTools 过滤)。
export function buildToolDefs(tier) {
  const allowed = tierTools(tier)
  return Object.entries(TOOL_META)
    .filter(([name]) => allowed.includes(name))
    .map(([name, m]) => ({ type: 'function', function: { name, description: m.description, parameters: m.inputSchema } }))
}

// 工厂:注入 llmClient + 底座 apiKeyTools + keyRow(cluster)。返回 { run, toolDefs }。
// onApproval:写操作人审回调(async → bool);无则写操作自动放行(仅 MVP 调试用,生产必接 UI)。
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster, onApproval }) {
  const toolDefs = buildToolDefs(keyRow.tier)
  const execTool = async (name, args) => apiKeyTools.callTool(keyRow, cluster, name, args) // 复用底座全套
  const chat = (messages, tools) => llmClient.chat({ messages, tools })
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: n => WRITE_TOOLS.has(n), onApproval })
  return { run: agent.run, toolDefs }
}
