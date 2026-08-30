// @server 引用注入块(2026-08-30 spec §5):脱敏由「构造时不取 host/username」保证——
// 行对象虽带这些列,这里只挑白名单字段;名称寻址(wb_ssh_exec 按 server=name),AI 无需 IP。
import { formatRefBlock } from '../ref-context.mjs'

export function buildServerRefBlock(label, rows, ref) {
  const s = rows.find(r => r.name === ref.name) || rows.find(r => r.id === ref.name)
  if (!s) return `${label}: (not found / 已不可用)`
  const body = {
    name: s.name,
    description: s.description || '',
    clusterRef: s.clusterRef || '',
    os: s.osName || s.osId || '',
    status: s.status || '',
    approvalPolicy: s.aiApprovalPolicy || 'always',
    capabilities: ['wb_ssh_exec(按服务器策略审批)', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes'],
  }
  return formatRefBlock(label, JSON.stringify(body, null, 2))
}
