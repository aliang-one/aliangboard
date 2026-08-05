// 网关故障转移辅助纯函数：错误分类 + 当前端点/dispatcher 选取。无副作用，便于单测。

// 是否应触发故障转移（网络错误 / 5xx / 超时；4xx 不触发——重试无意义）
export function isFailoverEligible(error) {
  if (!error) return false
  const code = error.code || ''
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true
  if (error.name === 'AbortError' || /timed out|timeout|aborted/i.test(error.message || '')) return true
  if (typeof error.status === 'number' && error.status >= 500) return true
  return false
}

// 当前活跃端点（故障转移后更新）
export function currentEndpoint(session) {
  if (session.endpoints && session.endpoints.length) return session.endpoints[session.endpointIdx || 0]
  return session.apiServer
}

// 当前端点对应的 dispatcher（原始端点→session.dispatcher；候选→insecureDispatcher）
export function currentDispatcher(session) {
  if (!session.endpointIdx || session.endpointIdx === 0) return session.dispatcher
  return session.insecureDispatcher || session.dispatcher
}
