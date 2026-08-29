// SSH 服务器台账生成器(纯函数):结构层每次读取时从 DB 行实时渲染(服务器任何变化
// 自动同步,人与 AI 都不改结构层);自由层(servers[].notes / globalNotes)是人/AI
// 的可编辑区。exposedOnly=true 供 AI 视图——未暴露服务器整个隐去(不泄露 host)。
const line = (label, val) => `- ${label}:${val}`

function serverSection(s, i, { redactHost = false } = {}) {
  const statusText = s.status === 'ok' ? '正常' : s.status === 'fail' ? '异常' : '未测'
  const os = s.osName || (s.osId ? s.osId : 'OS 未探测')
  const policy = s.exposeToAi ? (s.aiApprovalPolicy || 'always') : '未暴露'
  // redactHost(AI 视图,spec 裁决 #6):host/port/username 不进 LLM 上下文;人看路径(REST)不脱敏
  return [
    redactHost ? `### ${s.name}` : `### ${s.name}（${s.host}:${s.port}）`,
    ...(redactHost ? [] : [line('用户', s.username)]),
    line('OS', os),
    line('状态', statusText),
    line('暴露策略', policy),
    s.clusterRef ? line('关联集群', s.clusterRef) : null,
    s.description ? line('描述', s.description) : null,
    '#### 台账备注',
    (s.notes && s.notes.trim()) ? s.notes.trim() : '（暂无备注）',
  ].filter(Boolean).join('\n')
}

export function renderServerLedger(servers, globalNotes = '', { exposedOnly = false, redactHost = false } = {}) {
  const list = (Array.isArray(servers) ? servers : [])
    .filter(s => s && s.name)
    .filter(s => !exposedOnly || s.exposeToAi)
  const head = [
    '# SSH 服务器台账',
    `> 结构段由平台自动生成(读取时实时反映 DB,手工/AI 修改会被覆盖);「台账备注」为可编辑自由层。`,
    `> 生成时间:${new Date().toISOString()}`,
    '',
    '## 全局',
    (globalNotes && globalNotes.trim()) ? globalNotes.trim() : '（暂无全局备注）',
    '',
    `## 服务器（${list.length}）`,
  ]
  const body = list.length
    ? list.map((s, i) => serverSection(s, i, { redactHost })).join('\n\n')
    : '（暂无服务器）'
  return [...head, body].join('\n')
}
