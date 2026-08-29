// 卷回填单源:pod spec volumes × 各容器 volumeMounts → 表单卷条目。
// 消费方:NsWorkloadDetail 编辑回填(原 mergeVolumes 上提)与 useWorkloadToForm 复制回填——两面同一结论。
// target 约定(与两面生成端一致):main / init:<过滤后序> / sidecar:<containers[1:] 原下标 / plain sidecar 之后追加序>。
// unknown 卷类型原样透传(raw),不降级 emptyDir——降级会在保存时破坏原配置(2026-08-29 spec)。
// 纯函数、无 Vue 依赖。

const octalOf = m => (m == null ? '' : Number(m).toString(8).padStart(4, '0'))

// 容器分流:native sidecar = initContainers 中 restartPolicy==='Always'(K8s 原生 sidecar)。
export function splitContainers(podSpec = {}) {
  const containers = podSpec.containers || []
  const inits = podSpec.initContainers || []
  return {
    mainContainer: containers[0] || null,
    plainSidecars: containers.slice(1),
    plainInits: inits.filter(c => c.restartPolicy !== 'Always'),
    nativeSidecars: inits.filter(c => c.restartPolicy === 'Always'),
  }
}

function detectVolume(vol) {
  const d = { type: 'emptyDir', pvcName: '', hostPath: '', hostPathType: '', server: '', nfsPath: '', cmName: '', secretName: '', defaultMode: '', items: (vol?.configMap?.items || vol?.secret?.items || []).map(it => ({ key: it.key || '', path: it.path || '' })), raw: null }
  if (!vol) return d                                                   // 未注册卷名的 mount 回退 emptyDir(raw 无从透传)
  if (vol.persistentVolumeClaim) { d.type = 'pvc'; d.pvcName = vol.persistentVolumeClaim.claimName || '' }
  else if (vol.hostPath) { d.type = 'hostPath'; d.hostPath = vol.hostPath.path || ''; d.hostPathType = vol.hostPath.type || '' }
  else if (vol.nfs) { d.type = 'nfs'; d.server = vol.nfs.server || ''; d.nfsPath = vol.nfs.path || '' }
  else if (vol.configMap) { d.type = 'configMap'; d.cmName = vol.configMap.name || ''; d.defaultMode = octalOf(vol.configMap.defaultMode) }
  else if (vol.secret) { d.type = 'secret'; d.secretName = vol.secret.secretName || ''; d.defaultMode = octalOf(vol.secret.defaultMode) }
  else if (vol.emptyDir) { d.type = 'emptyDir' }
  else { d.type = 'unknown'; d.raw = JSON.parse(JSON.stringify(vol)) }   // 独立副本(K8s spec 为 JSON 源,安全)
  return d
}

const rowOf = (target, m, d) => ({
  name: m.name || '', target, type: d.type, raw: d.raw, mountPath: m.mountPath || '', subPath: m.subPath || '', readOnly: !!m.readOnly,
  pvcName: d.pvcName, hostPath: d.hostPath, hostPathType: d.hostPathType, server: d.server, nfsPath: d.nfsPath, cmName: d.cmName, secretName: d.secretName, defaultMode: d.defaultMode, items: d.items.map(it => ({ ...it })),
})

export function backfillVolumes(podSpec = {}) {
  const { mainContainer, plainSidecars, plainInits, nativeSidecars } = splitContainers(podSpec)
  const byKey = new Map()
  const volDefByName = new Map()
  ;(podSpec.volumes || []).forEach(v => volDefByName.set(v.name, detectVolume(v)))
  const push = (target, m) => byKey.set(`${target}|${m.name}|${m.mountPath || ''}`, rowOf(target, m, volDefByName.get(m.name) || detectVolume(null)))
  ;(mainContainer?.volumeMounts || []).forEach(m => push('main', m))
  plainInits.forEach((c, i) => (c.volumeMounts || []).forEach(m => push(`init:${i}`, m)))
  plainSidecars.forEach((c, i) => (c.volumeMounts || []).forEach(m => push(`sidecar:${i}`, m)))
  nativeSidecars.forEach((c, j) => (c.volumeMounts || []).forEach(m => push(`sidecar:${plainSidecars.length + j}`, m)))
  // 只定义未挂载的卷也保留(挂到主容器占位)
  volDefByName.forEach((d, name) => {
    if (![...byKey.values()].some(e => e.name === name)) byKey.set(`main|${name}|`, rowOf('main', { name }, d))
  })
  return [...byKey.values()]
}
