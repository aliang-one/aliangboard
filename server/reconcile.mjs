// 项目 reconcile(第 4 阶段 R1):幂等再 apply 项目 manifests,让集群对齐 repo。
// 作用域安全:server-side apply 的 fieldManager 只管 aliangboard 声明的字段,不抢别的 manager。
// readManifests / applyYaml 注入(端点接 repo 读 + applyYamlPartial),便于单测。结果存 last_reconcile。
import { setLastReconcile } from './workbench-projects.mjs'

// reconcile 一个项目。返回 { applied, failed, total, ts } 或 { skipped, reason, ts }。
export async function reconcileProject({ db, projectId, readManifests, applyYaml }) {
  const yaml = await readManifests()
  if (!yaml || !yaml.trim()) {
    const r = { skipped: true, reason: 'manifests/ 为空,无声明资源', applied: [], failed: [], total: 0, ts: Date.now() }
    setLastReconcile(db, projectId, r)
    return r
  }
  const res = await applyYaml(yaml) // applyYamlPartial → { applied, failed, total }
  const r = { applied: res.applied || [], failed: res.failed || [], total: res.total ?? 0, ts: Date.now() }
  setLastReconcile(db, projectId, r)
  return r
}
