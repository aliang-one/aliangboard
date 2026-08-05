// Pod 展示相关的纯函数（无 Vue 依赖）：健康度、生命周期 conditions、容器、镜像拆分、资源占用、名称拆分。
// 单一事实源：PodCard 组件与各详情页（NsWorkloadDetail 右列、NsServiceDetail 等）共用，避免各处复制。

// 镜像拆 base / tag（去掉 digest）
export function imgBase(image) {
  if (!image) return ''
  const noDigest = String(image).split('@')[0]
  const i = noDigest.lastIndexOf(':')
  return i > noDigest.lastIndexOf('/') ? noDigest.slice(0, i) : noDigest
}
export function imgTag(image) {
  if (!image) return ''
  const noDigest = String(image).split('@')[0]
  const i = noDigest.lastIndexOf(':')
  return i > noDigest.lastIndexOf('/') ? noDigest.slice(i + 1) : ''
}

// 资源占用百分比：优先用数值字段（usedCpu/reqCpu 等），缺失时回退解析 "used/total"
export function pctRatio(str) {
  if (!str || str === '0/0') return 0
  const parts = String(str).split('/')
  if (parts.length !== 2) return 0
  const used = parseFloat(parts[0]), total = parseFloat(parts[1])
  return total ? Math.min(100, Math.round((used / total) * 100)) : 0
}
export function podCpuPct(pod) {
  if (pod?.usedCpu != null && pod?.reqCpu) return Math.min(100, Math.round(pod.usedCpu / pod.reqCpu * 100))
  return pctRatio(pod?.cpu)
}
export function podMemPct(pod) {
  if (pod?.usedMem != null && pod?.reqMem) return Math.min(100, Math.round(pod.usedMem / pod.reqMem * 100))
  return pctRatio(pod?.memory)
}

// Pod 健康度：综合 phase + Ready condition + restarts → level + 颜色 + 标签
export function podHealth(p) {
  if (!p) return { level: 'none', text: 'text-on-surface-variant', dot: 'bg-on-surface-variant/40', label: '—' }
  if (p.status === 'Failed') return { level: 'danger', text: 'text-error', dot: 'bg-error', label: '异常' }
  if (p.status === 'Pending' || p.status === 'Unknown') return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '启动中' }
  const conds = p.raw?.status?.conditions || []
  const ready = conds.find(c => c.type === 'Ready')
  if (ready?.status === 'True' && p.restarts === 0) return { level: 'ok', text: 'text-primary', dot: 'bg-primary', label: '健康' }
  if (p.restarts > 3) return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '重启多' }
  if (ready?.status !== 'True') return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '未就绪' }
  return { level: 'ok', text: 'text-primary', dot: 'bg-primary', label: '健康' }
}

// Pod 卡片配色（边框 + hover 轻底色），按健康度
export function podCardClass(p) {
  const map = {
    ok: 'border-primary/30 hover:border-primary/60 hover:bg-primary/5',
    warn: 'border-tertiary-container/40 hover:border-tertiary-container/70 hover:bg-tertiary-container/5',
    danger: 'border-error/40 hover:border-error/70 hover:bg-error/5',
    none: 'border-outline-variant hover:bg-surface-container-low/40',
  }
  return map[podHealth(p).level]
}

// Pod 名拆分：base=应用名（如 deployment 名），suffix=实例哈希（淡化）。
// baseName 不传则整名作为 base（Service/Endpoints 场景无 deployment 上下文）。
export function podNameDisplay(p, baseName = '') {
  const name = p?.name || ''
  if (baseName && name.startsWith(baseName + '-') && name.length > baseName.length + 1) {
    return { base: name.slice(0, baseName.length), suffix: name.slice(baseName.length) }
  }
  return { base: name, suffix: '' }
}

// 生命周期 conditions（从 raw.status.conditions 提取）
export function podConditions(p) {
  const raw = p?.raw
  if (!raw) return null
  const conds = raw.status?.conditions || []
  const get = t => conds.find(c => c.type === t)
  return {
    scheduled: get('PodScheduled'),
    initialized: get('Initialized'),
    containersReady: get('ContainersReady'),
    podReady: get('Ready'),
  }
}
export function condChip(c) {
  if (!c) return { text: '—', ok: false }
  return { text: c.status === 'True' ? '✓' : c.status === 'False' ? '✗' : '?', ok: c.status === 'True', reason: c.reason || '' }
}

// 容器列表（spec + status 合并）
export function podContainers(p) {
  const raw = p?.raw
  if (!raw) return []
  const specs = raw.spec?.containers || []
  const statuses = raw.status?.containerStatuses || []
  return specs.map(s => {
    const st = statuses.find(x => x.name === s.name) || {}
    return {
      name: s.name,
      image: s.image,
      pullPolicy: s.imagePullPolicy || 'IfNotPresent',
      state: st.state || {},
      ready: st.ready,
      restartCount: st.restartCount || 0,
      started: st.started,
      startTime: st.state?.running?.startedAt || st.state?.terminated?.finishedAt || '',
      ports: (s.ports || []).map(p => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', '),
    }
  })
}

// Pod 当前最值得关注的"原因"：优先容器 waiting/terminated reason
// （ImagePullBackOff / ErrImagePull / CrashLoopBackOff / ContainerCreating / CreateContainerConfigError 等），
// 回退 Pod phase.message。正常运行（Running/Succeeded）返回 null。用于在卡片上一眼看出"为什么没就绪"。
export function podReason(p) {
  const raw = p?.raw
  const statusList = raw?.status?.containerStatuses || raw?.status?.initContainerStatuses || []
  for (const cs of statusList) {
    const w = cs.state?.waiting
    if (w?.reason) return { reason: w.reason, message: w.message || '', kind: 'waiting' }
    const t = cs.state?.terminated
    if (t?.reason) return { reason: t.reason, message: t.message || `exit ${t.exitCode ?? '?'}`, kind: 'terminated' }
  }
  const phase = raw?.status?.phase
  if (phase && phase !== 'Running' && phase !== 'Succeeded' && raw?.status?.message) {
    return { reason: phase, message: raw.status.message, kind: 'phase' }
  }
  return null
}
