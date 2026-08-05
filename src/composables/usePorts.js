// 端口聚合纯函数：从工作负载列表提取所有 containerPort，去重并升序。
// 无外部依赖，便于 scripts/test.mjs 直接 import；stores/cluster.js 的 nsContainerPorts 复用本函数。
// 输入结构对齐 mapWorkload 产物（workload.raw.spec.template.spec.containers[].ports[].containerPort）。
export function extractContainerPorts(workloads = []) {
  const set = new Set()
  for (const w of workloads || []) {
    const containers = w?.raw?.spec?.template?.spec?.containers || []
    for (const c of containers) {
      for (const p of c.ports || []) {
        const port = p?.containerPort
        if (port !== null && port !== undefined && port !== '') set.add(Number(port))
      }
    }
  }
  return [...set].sort((a, b) => a - b)
}

// 按 workload 聚合容器端口：返回 [{name, type, ports:[{port, container, name}]}]，
// 保留端口来源（哪个工作负载 / 哪个容器），供 PortSelect 分组展示与「优先匹配工作负载」。
export function extractContainerPortsGrouped(workloads = []) {
  const groups = []
  for (const w of workloads || []) {
    const containers = w?.raw?.spec?.template?.spec?.containers || []
    const ports = []
    for (const c of containers) {
      for (const p of c.ports || []) {
        const port = p?.containerPort
        if (port === null || port === undefined || port === '') continue
        ports.push({ port: Number(port), container: c.name || '', name: p.name || '' })
      }
    }
    if (ports.length) groups.push({ name: w.name, type: w.type || 'Deployment', ports })
  }
  return groups
}
