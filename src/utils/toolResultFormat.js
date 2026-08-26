// 工具调用结果的智能格式化(纯函数,零组件依赖):ToolTrace chips 与 ToolCallModal 共享。
// 行为与 2026-08-25 前 ToolTrace.vue 内联版逐字一致(搬迁,非重写)。

export function fmtResult(ev) {
  if (!ev || ev.result == null) return ''
  const name = ev.name || ''
  const r = ev.result
  if (typeof r === 'string') return r
  if (name.includes('pod_logs') || name === 'wb_get_pod_logs') {
    return r.logs || r.raw || JSON.stringify(r, null, 2)
  }
  if (name.includes('describe') || name === 'wb_describe_resource') {
    return fmtDescribe(r)
  }
  if (name.includes('get_resource') || name === 'wb_get_resource') {
    return fmtDescribe({ resource: r.resource })
  }
  if (name.includes('list') || name === 'wb_list_resources') {
    return fmtList(r)
  }
  if (name.includes('rollout_status') || name === 'wb_rollout_status') {
    return fmtRollout(r)
  }
  if (name === 'wb_exec') {
    return fmtExec(r)
  }
  if (name === 'wb_read_pod_file') {
    return fmtPodFile(r)
  }
  if (name === 'wb_top') {
    return fmtTop(r)
  }
  return JSON.stringify(r, null, 2)
}

export function fmtDescribe(r) {
  const res = r.resource || {}
  const md = res.metadata || {}
  const st = res.status || {}
  const sp = res.spec || {}
  const L = []
  L.push(`${res.kind || '?'}/${md.name || '?'} (${md.namespace || 'cluster-scoped'})`)
  if (st.phase) L.push(`phase: ${st.phase}`)
  if (st.conditions?.length) {
    L.push('conditions:')
    for (const c of st.conditions.slice(0, 10)) L.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (st.replicas !== undefined) L.push(`replicas: desired=${st.replicas ?? 0} ready=${st.readyReplicas ?? 0} updated=${st.updatedReplicas ?? 0}`)
  if (st.containerStatuses?.length) {
    L.push('containers:')
    for (const c of st.containerStatuses.slice(0, 5)) L.push(`  ${c.name}: ready=${c.ready} restarts=${c.restartCount ?? 0} image=${(c.image||'').slice(0, 50)}`)
  }
  if (sp.containers?.length) {
    L.push('images:')
    for (const c of sp.containers.slice(0, 5)) L.push(`  ${c.image || '?'}`)
  }
  if (r.events?.items?.length) {
    L.push(`events (${r.events.count || r.events.items.length}):`)
    for (const e of r.events.items.slice(0, 8)) L.push(`  [${e.type}] ${e.reason || ''}: ${e.message || ''}${e.last ? ` @${e.last}` : ''}`)
  }
  return L.join('\n')
}

export function fmtList(r) {
  const items = r.items || []
  const L = [`${r.kind || 'resources'} (${r.count ?? items.length} total, showing ${items.length}):`]
  for (const it of items.slice(0, 30)) {
    L.push(`  ${it.namespace ? it.namespace + '/' : ''}${it.name}`)
  }
  if (items.length > 30) L.push(`  ... +${items.length - 30} more`)
  return L.join('\n')
}

export function fmtRollout(r) {
  const L = [`${r.name}: ${r.summary}`]
  if (r.replicas) L.push(`desired=${r.replicas.desired} ready=${r.replicas.ready} updated=${r.replicas.updated} available=${r.replicas.available} unavailable=${r.replicas.unavailable}`)
  if (r.conditions?.length) {
    L.push('conditions:')
    for (const c of r.conditions.slice(0, 5)) L.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
  }
  return L.join('\n')
}

// exec 退出码归一(2026-08-26 exit=[object Object] bug 的存量兜底):数字直用;
// 存量 trace(服务端修复前)的 exitCode 是 V1Status 对象——Success→0,非零码在
// details.causes[reason=ExitCode].message。语义与 server/exec-bounds.mjs
// k8sStatusToExitCode 同源(前后端分仓,前端持副本);无码 → null(显示 '?')。
function exitCodeOf(v) {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v !== 'object') return null
  if (v.status === 'Success') return 0
  const cause = (v.details?.causes || []).find(c => c.reason === 'ExitCode')
  const n = Number(cause?.message ?? cause?.value)
  return Number.isFinite(n) ? n : null
}

export function fmtExec(r) {
  const code = exitCodeOf(r.exitCode)
  const L = [`exit=${code ?? '?'}${r.timedOut ? ' · timed out' : ''}${r.truncated ? ' · truncated' : ''}`]
  if (r.stdout) L.push('--- stdout ---', r.stdout)
  if (r.stderr) L.push('--- stderr ---', r.stderr)
  if (r.hint) L.push(r.hint)
  if (!r.stdout && !r.stderr) L.push('(no output)')
  return L.join('\n')
}

export function fmtPodFile(r) {
  return [`${r.pod}:${r.path}${r.truncated ? ' (truncated)' : ''}`, r.content || '(empty)'].join('\n')
}

// 用量行:百分比 > 80% 标 ⚠(一眼看出 OOM 前兆/CPU 打满);null = 无 limit/不可算,不显示假数
export function fmtTop(r) {
  const bar = (label, pct) => pct == null ? '' : `${label} ${pct}%${pct >= 80 ? ' ⚠' : ''}`
  const L = []
  if (r.scope === 'nodes') {
    L.push(`nodes (${r.count ?? (r.items || []).length}):`)
    for (const n of (r.items || [])) {
      const parts = [bar('cpu', n.cpuPct), bar('mem', n.memoryPct)].filter(Boolean).join(' ')
      L.push(`  ${n.name}  ${n.cpu} cpu / ${n.memory}${parts ? `  (${parts})` : ''}`)
    }
  } else {
    L.push(`pods in ${r.namespace || '?'} (${r.count ?? (r.items || []).length}):`)
    for (const p of (r.items || [])) {
      for (const c of (p.containers || [])) {
        const parts = [bar('cpu', c.cpuPct), bar('mem', c.memoryPct)].filter(Boolean).join(' ')
        L.push(`  ${p.name}/${c.name}  ${c.cpu} cpu / ${c.memory}${c.cpuLimit || c.memoryLimit ? ` (limits ${c.cpuLimit || '∞'}/${c.memoryLimit || '∞'})` : ''}${parts ? `  [${parts}]` : ''}`)
      }
    }
  }
  return L.join('\n')
}

// 历史事件时间戳兜底:2026-08-25 之前的事件没记 ts(详情 Modal 显示 —)。
// 用该轮 assistant 消息的 createdAt(轮次完成时刻)作为近似时间就地补上;已有 ts 不动。
// 重建路径每次 JSON.parse 出新数组,就地改写安全。
export function applyLegacyTs(events, fallbackTs) {
  if (!Array.isArray(events) || !fallbackTs) return events || []
  for (const ev of events) if (ev && typeof ev === 'object' && ev.ts == null) ev.ts = fallbackTs
  return events
}
