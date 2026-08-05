// 把 agent 核心接到底座(切片 1+2 + 3b 人审)。
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
// 写操作走 checkpoint/resume 人审(见 agent.mjs):循环遇写工具返回 pending_approval,
// 客户端审批后回传 resume 续跑。resume 时 execTool 仍走 callTool 全链——审批只放行意图,RBAC 由底座兜。
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster }) {
  const toolDefs = buildToolDefs(keyRow.tier)
  const allowed = new Set(tierTools(keyRow.tier))
  const execTool = async (name, args) => apiKeyTools.callTool(keyRow, cluster, name, args) // 复用底座全套
  const chat = (messages, tools) => llmClient.chat({ messages, tools })
  // 只对「该 tier 实际可用的写工具」要求人审;tier 够不上的写工具直接执行(底座 authorize 会拒)
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: n => WRITE_TOOLS.has(n) && allowed.has(n) })
  return { run: agent.run, toolDefs }
}
