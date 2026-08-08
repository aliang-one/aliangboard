// 反向映射:K8s workload 对象 → DeployApp 向导表单(best-effort)。
// 纯函数,不引 Vue,可被 scripts/test.mjs 零依赖运行器测试。
// 仅映射向导已建模字段;多容器:主容器完整 + 其余进 extraContainers(窄)、init 进 initContainers(窄);
// 复杂 affinity/自定义 strategy/未知 volume 类型等不映射或降级。

function podSpecOf(obj, kind) {
  if (kind === 'CronJob') return obj?.spec?.jobTemplate?.spec?.template?.spec
  return obj?.spec?.template?.spec
}

function mapProbe(probe) {
  const base = { enabled: false, type: 'http', httpPath: '/', port: 8080, execCommand: '', initialDelaySeconds: 30, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 }
  if (!probe) return base
  let type = 'http', httpPath = '/', port = 8080, execCommand = ''
  if (probe.httpGet) { type = 'http'; httpPath = probe.httpGet.path || '/'; port = probe.httpGet.port || 8080 }
  else if (probe.tcpSocket) { type = 'tcp'; port = probe.tcpSocket.port || 8080 }
  else if (probe.exec) { type = 'exec'; execCommand = (probe.exec.command || []).join(' ') }
  return { ...base, enabled: true, type, httpPath, port, execCommand,
    initialDelaySeconds: probe.initialDelaySeconds ?? 30,
    periodSeconds: probe.periodSeconds ?? 10,
    timeoutSeconds: probe.timeoutSeconds ?? 1,
    failureThreshold: probe.failureThreshold ?? 3,
    successThreshold: probe.successThreshold ?? 1 }
}

function mapMainContainer(c) {
  const r = c?.resources || {}
  return {
    containerName: c?.name || '',
    image: c?.image || '',
    pullPolicy: c?.imagePullPolicy || 'IfNotPresent',
    command: Array.isArray(c?.command) ? c.command.join(' ') : '',
    args: Array.isArray(c?.args) ? c.args.join(' ') : '',
    workingDir: c?.workingDir || '',
    cpuRequest: r.requests?.cpu || '250m',
    cpuLimit: r.limits?.cpu || '500m',
    memoryRequest: r.requests?.memory || '256Mi',
    memoryLimit: r.limits?.memory || '512Mi',
    envVars: (c?.env || []).filter(e => e && e.value != null && !e.valueFrom).map(e => ({ key: e.name, value: String(e.value) })),
    ports: (c?.ports || []).map(p => ({ containerPort: p?.containerPort != null ? String(p.containerPort) : '', protocol: p?.protocol || 'TCP' })),
    liveness: mapProbe(c?.livenessProbe),
    readiness: mapProbe(c?.readinessProbe),
    startup: mapProbe(c?.startupProbe),
  }
}

function mapSidecar(c) {
  const r = c?.resources || {}
  return {
    name: c?.name || '',
    image: c?.image || '',
    command: Array.isArray(c?.command) ? c.command.join(' ') : '',
    cpuRequest: r.requests?.cpu || '100m',
    cpuLimit: r.limits?.cpu || '250m',
    memoryRequest: r.requests?.memory || '128Mi',
    memoryLimit: r.limits?.memory || '256Mi',
  }
}

function mapInit(c) {
  const s = mapSidecar(c)
  s.args = Array.isArray(c?.args) ? c.args.join(' ') : ''
  return s
}

function mapPairs(map) {
  if (!map) return []
  const SKIP = new Set(['pod-template-hash'])
  return Object.entries(map)
    .filter(([k]) => !SKIP.has(k) && !k.endsWith('pod-template-hash'))
    .map(([k, v]) => ({ key: k, value: String(v) }))
}

function detectVolume(vol) {
  // 字段名以 VolumeMountCard.vue 实测为准(Step 1)。下方为推断默认。
  if (vol?.persistentVolumeClaim) return { type: 'pvc', pvcName: vol.persistentVolumeClaim.claimName || '' }
  if (vol?.emptyDir) return { type: 'emptyDir' }
  if (vol?.hostPath) return { type: 'hostPath', hostPath: vol.hostPath.path || '' }
  if (vol?.configMap) return { type: 'configMap', cmName: vol.configMap.name || '' }
  if (vol?.secret) return { type: 'secret', secretName: vol.secret.secretName || '' }
  return { type: 'emptyDir' } // 未知类型降级为 emptyDir(仅保留 name/mountPath)
}

function mapVolumeMounts(mainContainer, volumes) {
  if (!mainContainer) return []
  const volByName = new Map((volumes || []).map(v => [v.name, v]))
  return (mainContainer.volumeMounts || []).map(m => {
    const vol = volByName.get(m.name)
    return { target: 'main', name: m.name || '', mountPath: m.mountPath || '', subPath: m.subPath || '', readOnly: !!m.readOnly, ...(vol ? detectVolume(vol) : {}) }
  })
}

export function workloadToForm(obj, kind) {
  if (!obj || !kind) return null
  const pod = podSpecOf(obj, kind) || {}
  const containers = pod.containers || []
  const out = {}

  out.workloadType = kind
  out.name = obj.metadata?.name || ''
  out.namespace = obj.metadata?.namespace || ''
  out.labels = mapPairs(obj.metadata?.labels)
  out.annotations = mapPairs(obj.metadata?.annotations)

  if (kind === 'Deployment' || kind === 'StatefulSet') {
    out.replicas = obj.spec?.replicas ?? 1
  } else if (kind === 'Job') {
    out.jobConfig = { completions: obj.spec?.completions ?? 1, parallelism: obj.spec?.parallelism ?? 1, backoffLimit: obj.spec?.backoffLimit ?? 6, activeDeadlineSeconds: obj.spec?.activeDeadlineSeconds || '' }
  } else if (kind === 'CronJob') {
    out.cronConfig = { schedule: obj.spec?.schedule || '*/5 * * * *', concurrencyPolicy: obj.spec?.concurrencyPolicy || 'Allow', suspend: !!obj.spec?.suspend, successfulJobsHistoryLimit: obj.spec?.successfulJobsHistoryLimit ?? 3, failedJobsHistoryLimit: obj.spec?.failedJobsHistoryLimit ?? 1 }
    const jt = obj.spec?.jobTemplate?.spec
    if (jt) out.jobConfig = { completions: jt.completions ?? 1, parallelism: jt.parallelism ?? 1, backoffLimit: jt.backoffLimit ?? 6, activeDeadlineSeconds: jt.activeDeadlineSeconds || '' }
  }

  if (containers[0]) Object.assign(out, mapMainContainer(containers[0]))
  else { out.image = ''; out.containerName = ''; out.envVars = []; out.ports = []; out.liveness = mapProbe(null); out.readiness = mapProbe(null); out.startup = mapProbe(null) }
  out.extraContainers = containers.slice(1).map(mapSidecar)
  out.initContainers = (pod.initContainers || []).map(mapInit)
  out.nodeSelectors = Object.entries(pod.nodeSelector || {}).map(([k, v]) => ({ key: k, value: String(v) }))
  out.tolerations = (pod.tolerations || []).map(tl => ({ key: tl.key || '', value: tl.value || '', effect: tl.effect || '' }))
  out.volumeMounts = mapVolumeMounts(containers[0], pod.volumes)
  return out
}
