// 工作台集群台账(W3):cluster-context repo 的 INDEX.md 生成。
// 纯函数(可单测):formatIndexMd 把 survey 数据(来自底座 requestKubernetes)格式成事实型 markdown。
// bootstrap 不走 LLM —— 平台直连集群凭据 survey,生成"有什么"的事实层 + verified_at;
// 语义/能力解读(意味着什么/怎么用)由 agent 在使用中补充到 capabilities/(W4/W5 propose_ledger_update)。

// verified_at:YYYY-MM-DD(用于防 drift;agent apply 前对引用的能力做 list 复核)
export function verifiedAt(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function names(items) {
  return (items || []).map(i => i.metadata?.name).filter(Boolean)
}

// 把 cluster-wide 的 deployments/services/ingresses 按 namespace 分组(纯)
export function groupWorkloads(deployments = [], services = [], ingresses = []) {
  const byNs = {}
  const push = (ns, kind, val) => { if (!val) return; (byNs[ns] ??= {})[kind] ??= []; byNs[ns][kind].push(val) }
  for (const d of deployments) push(d.metadata?.namespace || '-', 'deployments', d.metadata?.name)
  for (const s of services) push(s.metadata?.namespace || '-', 'services', s.metadata?.name)
  for (const i of ingresses) {
    const ns = i.metadata?.namespace || '-'
    const hosts = (i.spec?.rules || []).map(r => r.host).filter(Boolean).join(',')
    push(ns, 'ingresses', hosts || i.metadata?.name)
  }
  return byNs
}

// 生成 INDEX.md(markdown 字符串)。任一 survey 项可为 null(该集群无此资源/survey 失败)。
export function formatIndexMd({ clusterName, apiServer, verifiedAt: vat, namespaces, nodes, ingressClasses, storageClasses, deployments, services, ingresses } = {}) {
  const L = []
  L.push(`# ${clusterName || '集群'} 能力地图`)
  L.push('')
  L.push('> 集群台账:平台 survey 生成的事实层(集群有什么)。语义/能力解读(意味着什么、怎么用)由 agent 在使用中补充到 capabilities/。')
  L.push('')
  L.push(`verified_at: ${vat || verifiedAt()}`)
  if (apiServer) L.push(`cluster: ${apiServer}`)
  L.push('')

  const nsNames = namespaces ? names(namespaces) : null
  L.push(`## Namespaces${nsNames ? ` (${nsNames.length})` : ''}`)
  L.push(nsNames && nsNames.length ? nsNames.map(n => `- ${n}`).join('\n') : '_(survey 不可用或无)_')
  L.push('')

  if (nodes) {
    L.push(`## 节点 (${nodes.length})`)
    L.push((nodes.length ? names(nodes) : []).map(n => `- ${n}`).join('\n') || '_(无)_')
    L.push('')
  }
  if (ingressClasses) {
    L.push('## 入口 IngressClasses')
    L.push(names(ingressClasses).map(n => `- ${n}`).join('\n') || '_(无)_')
    L.push('')
  }
  if (storageClasses) {
    L.push('## 存储 StorageClasses')
    L.push(names(storageClasses).map(n => `- ${n}`).join('\n') || '_(无)_')
    L.push('')
  }

  const wl = groupWorkloads(deployments, services, ingresses)
  const wlNss = Object.keys(wl).sort()
  L.push(`## 工作负载概览(按 namespace,${wlNss.length} 个有工作负载)`)
  if (!wlNss.length) L.push('_(无)_')
  for (const ns of wlNss) {
    L.push(`### ${ns}`)
    if (wl[ns].deployments?.length) L.push(`- Deployments: ${wl[ns].deployments.join(', ')}`)
    if (wl[ns].services?.length) L.push(`- Services: ${wl[ns].services.join(', ')}`)
    if (wl[ns].ingresses?.length) L.push(`- Ingresses: ${wl[ns].ingresses.join(', ')}`)
    L.push('')
  }
  return L.join('\n').trimEnd() + '\n'
}
