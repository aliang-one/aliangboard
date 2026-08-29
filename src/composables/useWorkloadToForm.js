// 反向映射:K8s workload 对象 → DeployApp 向导表单(best-effort)。
// 纯函数,不引 Vue,可被 scripts/test.mjs 零依赖运行器测试。
// 仅映射向导已建模字段;多容器:主容器完整 + 其余/子容器全量反解(mapSubContainer,与编辑面单源);
// 复杂 affinity/自定义 strategy 不映射;未知 volume 类型原样透传(raw),卷回填与编辑面单源(logic/volumeBackfill)。
// command/args 的文本切分约定见 src/utils/containerTokens.js:command 空格 join,args 每条一行。
import { joinCommandTokens, joinArgLines } from '../utils/containerTokens.js'
import { SYSTEM_ANNOTATIONS } from '../utils/systemMeta.js'
import { mapSubContainer } from '../logic/subContainer.js'
import { backfillVolumes, splitContainers } from '../logic/volumeBackfill.js'

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
    command: joinCommandTokens(c?.command),
    args: joinArgLines(c?.args),
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

function mapPairs(map) {
  if (!map) return []
  // pod-template-hash 是控制器指纹;系统注解(revision/last-applied 等)是控制器/平台管理的字段,
  // 复制进新负载语义错误(2026-08-16:revision 裸拼成数字还触发 SSA 类型拒绝),一并剔除。
  const SKIP = new Set(['pod-template-hash', ...SYSTEM_ANNOTATIONS])
  return Object.entries(map)
    .filter(([k]) => !SKIP.has(k) && !k.endsWith('pod-template-hash'))
    .map(([k, v]) => ({ key: k, value: String(v) }))
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
  const { plainInits, plainSidecars, nativeSidecars } = splitContainers(pod)
  out.extraContainers = [...plainSidecars, ...nativeSidecars].map(mapSubContainer)
  out.initContainers = plainInits.map(mapSubContainer)
  out.nodeSelectors = Object.entries(pod.nodeSelector || {}).map(([k, v]) => ({ key: k, value: String(v) }))
  out.tolerations = (pod.tolerations || []).map(tl => ({
    key: tl.key || '',
    operator: tl.operator || (tl.value ? 'Equal' : 'Exists'),
    value: tl.value || '',
    effect: tl.effect || '',
  }))
  out.volumeMounts = backfillVolumes(pod)
  return out
}
