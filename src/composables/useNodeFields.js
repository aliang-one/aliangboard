// 从 K8s Node 对象抽取 mapNode 未覆盖的「丰富节点信息」字段。
// 纯函数、无 Vue/Pinia 依赖，故可被零依赖测试运行器 scripts/test.mjs 直接 import；
// stores/cluster.js 的 mapNode 会展开 ...extractNodeExtra(item) 复用同一份逻辑。

// 容器运行时短名：去掉 'containerd://' / 'docker://' / 'cri-o://' 等 scheme 前缀
export function shortenRuntime(raw) {
  if (raw == null) return null
  const s = String(raw)
  const i = s.indexOf('://')
  return i >= 0 ? s.slice(i + 3) : s
}

// 归一化 taints 为 {key,value,effect}；缺 value 视为空串
export function normalizeTaints(taints) {
  if (!Array.isArray(taints)) return []
  return taints.map(t => ({ key: t.key ?? '', value: t.value ?? '', effect: t.effect ?? '' }))
}

const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null }

// 抽取 mapNode 未覆盖的额外字段；任何缺失字段降级为 null / []，由视图自行降级展示
export function extractNodeExtra(item) {
  const info = item?.status?.nodeInfo || {}
  const addresses = item?.status?.addresses || []
  const findAddr = type => addresses.find(a => a?.type === type)?.address || null
  const taints = normalizeTaints(item?.spec?.taints)
  return {
    externalIp: findAddr('ExternalIP'),
    containerRuntime: info.containerRuntimeVersion || null,
    containerRuntimeShort: shortenRuntime(info.containerRuntimeVersion),
    arch: info.architecture || null,
    osType: info.operatingSystem || null,
    taints,
    taintCount: taints.length,
    podCapacity: toInt(item?.status?.capacity?.pods),
    podAllocatable: toInt(item?.status?.allocatable?.pods),
    podCIDR: item?.spec?.podCIDR || null,
  }
}
