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
