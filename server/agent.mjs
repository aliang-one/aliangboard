// Agent loop(第二阶段):LLM think → 调底座 tool → 观察结果 → 再 think → 给方案。
// 与具体 LLM / tool 执行解耦:chat 与 execTool 都注入,便于单测。
// 复用底座 callTool(execTool 注入)。写操作(scale/restart)走人审 hook(needsApproval + onApproval)。
const MAX_STEPS = 8 // 防失控循环

export function createAgent({ chat, toolDefs = [], execTool, needsApproval = () => false, onApproval, maxSteps = MAX_STEPS }) {
  // chat: async (messages, toolDefs) => assistantMessage {role, content, tool_calls?}
  // toolDefs: LLM 工具定义(OpenAI tools 格式)
  // execTool: async (name, args) => 结果(string 或对象,转字符串喂回 LLM)
  // needsApproval(name) => bool;onApproval(toolCall) => Promise<bool>(人审;只读无 hook 自动放行)
  async function run({ system, history = [], onStep } = {}) {
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push(...history)
    const denied = []
    let steps = 0
    while (steps < maxSteps) {
      steps++
      const assistant = await chat(messages, toolDefs)
      messages.push(assistant)
      onStep?.({ type: 'assistant', message: assistant })
      const toolCalls = assistant.tool_calls || []
      if (!toolCalls.length) return { content: assistant.content, steps, denied } // 终答
      for (const tc of toolCalls) {
        const name = tc.function?.name
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* LLM 给了坏 JSON,空参 */ }
        if (needsApproval(name)) {
          const approved = onApproval ? await onApproval({ name, args }) : true
          if (!approved) {
            denied.push({ name, args })
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `用户拒绝了该操作(${name})` })
            onStep?.({ type: 'denied', name, args })
            continue
          }
        }
        let result
        try { result = await execTool(name, args) }
        catch (e) { result = `工具执行失败: ${e.message}` }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) })
        onStep?.({ type: 'tool', name, args, result })
      }
    }
    return { content: '(达到最大步数,未给出终答)', steps, denied, truncated: true }
  }
  return { run }
}
