// 部署向导 step2(存储)门禁纯函数:每个卷条目必须「来源完整 + mountPath 合法 + target 有效」。
// 背景:mountsForTarget 与 pod 级 volumesYaml 都静默过滤不完整条目——未映射的卷在
// 生成 YAML 里整个消失,用户无感知(2026-08-25 用户报障)。单一事实源,无 Vue 依赖。
const SOURCE_FIELD = { pvc: 'pvcName', hostPath: 'hostPath', nfs: 'server', configMap: 'cmName', secret: 'secretName' }

// 返回首个坏条目 { key, n }(n 为 1-based 序号,供 i18n 提示);全部合法 → null
export function firstVolumeMountError(volumeMounts, validTargets) {
  for (let i = 0; i < (volumeMounts || []).length; i++) {
    const v = volumeMounts[i]
    const src = SOURCE_FIELD[v.type]
    if (src && !v[src]) return { key: 'deploy.volumeSourceRequired', n: i + 1 }
    if (!v.mountPath || !String(v.mountPath).startsWith('/')) return { key: 'deploy.volumeMountRequired', n: i + 1 }
    if (!(validTargets || []).includes(v.target)) return { key: 'deploy.volumeTargetInvalid', n: i + 1 }
    if (volumeItemsIncomplete(v)) return { key: 'deploy.volumeItemsIncomplete', n: i + 1 }
  }
  return null
}

// items 键映射半填:key/path 须成对;全空行忽略(与 YAML 生成 it.key 过滤的「整行空=跳过」语义一致)
export function volumeItemsIncomplete(entry) {
  return (entry?.items || []).some(it => (it.key || it.path) && !(it.key && it.path))
}
