// Init/sidecar 子容器领域模块:表单模型 <-> K8s 容器 spec 的单一事实源。
// 消费方:DeployApp 创建向导(previewYAML/复制回填)、NsWorkloadDetail 编辑面(spec 重建/回填)、
// ContainerEditorDialog(两面共用 UI)。纯函数、无 Vue 依赖,node:test 零依赖可测。
// 键名统一 cpuRequest/cpuLimit/memoryRequest/memoryLimit(编辑面旧 cpuReq 系随本次迁移废弃)。
import { splitCommandTokens, splitArgLines, joinCommandTokens, joinArgLines } from '../utils/containerTokens.js'
import { sanitizeImageToName } from '../utils/containerNames.js'

export const PROBE_KEYS = ['liveness', 'readiness', 'startup']
const PROBE_FIELD = { liveness: 'livenessProbe', readiness: 'readinessProbe', startup: 'startupProbe' }
const PROBE_DEFAULTS = {
  liveness:  { enabled: false, type: 'http', httpPath: '/health', port: 8080, execCommand: '', initialDelaySeconds: 30, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  readiness: { enabled: false, type: 'http', httpPath: '/ready', port: 8080, execCommand: '', initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  startup:   { enabled: false, type: 'http', httpPath: '/', port: 8080, execCommand: '', initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
}
// nullAbsent 模式下需要显式置 null 的可选键(编辑面 merge-patch 删除语义)
const NULLABLE_KEYS = ['command', 'args', 'workingDir', 'imagePullPolicy', 'resources', 'ports', 'env', 'envFrom',
  'livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle', 'securityContext', 'volumeMounts', 'restartPolicy']

export function makeSubContainer() {
  return {
    name: '', image: '', command: '', args: '',
    cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi',
    workingDir: '', pullPolicy: '', stdin: false, tty: false,
    envVars: [], envFromConfigMap: '', envFromSecret: '',
    envCMKeys: [], envSecretKeys: [],
    ports: [],
    liveness: { ...PROBE_DEFAULTS.liveness },
    readiness: { ...PROBE_DEFAULTS.readiness },
    startup: { ...PROBE_DEFAULTS.startup },
    lifecycle: { postStart: '', preStop: '' },
    securityContext: { enabled: false, privileged: false, runAsUser: '', runAsGroup: '', runAsNonPrivileged: false, readOnlyRootFilesystem: false, addCaps: '', dropCaps: '' },
    nativeSidecar: false,
  }
}

// 探针表单 → spec(镜像 NsWorkloadDetail 原 buildProbe 语义)
function buildProbeSpec(p) {
  if (!p || !p.enabled) return null
  const o = { initialDelaySeconds: Number(p.initialDelaySeconds) || 0, periodSeconds: Number(p.periodSeconds) || 10, timeoutSeconds: Number(p.timeoutSeconds) || 1, failureThreshold: Number(p.failureThreshold) || 3, successThreshold: Number(p.successThreshold) || 1 }
  if (p.type === 'http') o.httpGet = { path: p.httpPath || '/', port: Number(p.port) || 8080 }
  else if (p.type === 'tcp') o.tcpSocket = { port: Number(p.port) || 8080 }
  else if (p.type === 'exec') o.exec = { command: splitCommandTokens(p.execCommand) }
  return o
}

function splitCaps(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean) }

// 安全上下文表单 → spec(镜像主容器语义;add/drop 并存,修正主容器 else-if 怪癖)
function buildScSpec(sc) {
  if (!sc || !sc.enabled) return null
  const o = {}
  if (sc.privileged) o.privileged = true
  if (sc.runAsUser) o.runAsUser = Number(sc.runAsUser)
  if (sc.runAsGroup) o.runAsGroup = Number(sc.runAsGroup)
  if (sc.runAsNonPrivileged) o.runAsNonRoot = true
  if (sc.readOnlyRootFilesystem) o.readOnlyRootFilesystem = true
  const add = splitCaps(sc.addCaps), drop = splitCaps(sc.dropCaps)
  if (add.length || drop.length) {
    o.capabilities = {}
    if (add.length) o.capabilities.add = add
    if (drop.length) o.capabilities.drop = drop
  }
  return Object.keys(o).length ? o : null
}

// 表单 → K8s 容器 spec 对象。
// opts.fallbackName:name 空时回退名(调用方决定派生/去重;不传则用 image 清洗或 'container')
// opts.mounts:volumeMounts 对象数组或 null(调用方按 target 过滤好)
// opts.nullAbsent:true = 可选字段空时显式 null(编辑面 merge-patch 删除语义),
//                  stdin/tty 恒发显式布尔;false(默认)= omitempty(创建面 YAML 语义)
export function buildSubContainerSpec(c, opts = {}) {
  const fallbackName = opts.fallbackName ?? (sanitizeImageToName(c.image) || 'container')
  const o = { name: c.name || fallbackName, image: c.image || '' }
  const cmd = splitCommandTokens(c.command), args = splitArgLines(c.args)
  if (cmd.length) o.command = cmd
  if (args.length) o.args = args
  if (c.workingDir) o.workingDir = c.workingDir
  if (c.pullPolicy) o.imagePullPolicy = c.pullPolicy
  if (c.stdin) o.stdin = true
  if (c.tty) o.tty = true
  const r = {}
  if (c.cpuRequest || c.memoryRequest) { r.requests = {}; if (c.cpuRequest) r.requests.cpu = c.cpuRequest; if (c.memoryRequest) r.requests.memory = c.memoryRequest }
  if (c.cpuLimit || c.memoryLimit) { r.limits = {}; if (c.cpuLimit) r.limits.cpu = c.cpuLimit; if (c.memoryLimit) r.limits.memory = c.memoryLimit }
  if (Object.keys(r).length) o.resources = r
  const ports = (c.ports || []).filter(p => p.containerPort).map(p => ({ containerPort: Number(p.containerPort), protocol: p.protocol || 'TCP' }))
  if (ports.length) o.ports = ports
  const env = []
  ;(c.envVars || []).filter(e => e.key).forEach(e => env.push({ name: e.key, value: String(e.value ?? '') }))
  ;(c.envCMKeys || []).filter(e => e.name && e.cmName && e.key).forEach(e => env.push({ name: e.name, valueFrom: { configMapKeyRef: { name: e.cmName, key: e.key } } }))
  ;(c.envSecretKeys || []).filter(e => e.name && e.secretName && e.key).forEach(e => env.push({ name: e.name, valueFrom: { secretKeyRef: { name: e.secretName, key: e.key } } }))
  if (env.length) o.env = env
  const envFrom = []
  if (c.envFromConfigMap) envFrom.push({ configMapRef: { name: c.envFromConfigMap } })
  if (c.envFromSecret) envFrom.push({ secretRef: { name: c.envFromSecret } })
  if (envFrom.length) o.envFrom = envFrom
  for (const k of PROBE_KEYS) { const p = buildProbeSpec(c[k]); if (p) o[PROBE_FIELD[k]] = p }
  const lc = {}
  const ps = splitCommandTokens(c.lifecycle?.postStart), pst = splitCommandTokens(c.lifecycle?.preStop)
  if (ps.length) lc.postStart = { exec: { command: ps } }
  if (pst.length) lc.preStop = { exec: { command: pst } }
  if (Object.keys(lc).length) o.lifecycle = lc
  const sc = buildScSpec(c.securityContext)
  if (sc) o.securityContext = sc
  if (opts.mounts && opts.mounts.length) o.volumeMounts = opts.mounts
  if (c.nativeSidecar) o.restartPolicy = 'Always'
  if (opts.nullAbsent) {
    for (const k of NULLABLE_KEYS) if (!(k in o)) o[k] = null
    o.stdin = !!c.stdin
    o.tty = !!c.tty
  }
  return o
}

// 挂载行(两面同形状 {target,name,mountPath,subPath,readOnly})按 target 过滤 → 对象数组
export function mountsForTarget(volumeMounts, target) {
  const ms = (volumeMounts || []).filter(v => v.target === target && v.name && v.mountPath)
    .map(m => { const o = { name: m.name, mountPath: m.mountPath }; if (m.subPath) o.subPath = m.subPath; if (m.readOnly) o.readOnly = true; return o })
  return ms.length ? ms : null
}

// badge 计数:已配置的高级条目数(残行不算)
export function advancedCount(c) {
  if (!c) return 0
  let n = 0
  if (c.workingDir) n++
  if (c.pullPolicy) n++
  if (c.stdin) n++
  if (c.tty) n++
  n += (c.envVars || []).filter(e => e.key).length
  if (c.envFromConfigMap) n++
  if (c.envFromSecret) n++
  n += (c.envCMKeys || []).filter(e => e.name).length
  n += (c.envSecretKeys || []).filter(e => e.name).length
  n += (c.ports || []).filter(p => p.containerPort).length
  for (const k of PROBE_KEYS) if (c[k]?.enabled) n++
  if (splitCommandTokens(c.lifecycle?.postStart).length) n++
  if (splitCommandTokens(c.lifecycle?.preStop).length) n++
  if (c.securityContext?.enabled) n++
  if (c.nativeSidecar) n++
  return n
}

// 空行判定:基础 4 字段与全部高级字段都空才算空行(替代对子容器的 isEmptyEnvRow;
// 4 字段空但配了 env/探针等高级项的行必须参与校验与生成)
export function isSubContainerEmpty(c) {
  if (!c) return true
  if (c.name || c.image || c.command || c.args) return false
  if (c.workingDir || c.pullPolicy || c.stdin || c.tty || c.nativeSidecar) return false
  if (c.envFromConfigMap || c.envFromSecret) return false
  if ((c.envVars || []).some(e => e.key || e.value)) return false
  if ((c.envCMKeys || []).some(e => e.name)) return false
  if ((c.envSecretKeys || []).some(e => e.name)) return false
  if ((c.ports || []).some(p => p.containerPort)) return false
  for (const k of PROBE_KEYS) if (c[k]?.enabled) return false
  if (splitCommandTokens(c.lifecycle?.postStart).length || splitCommandTokens(c.lifecycle?.preStop).length) return false
  if (c.securityContext?.enabled) return false
  return true
}

// 探针 spec → 表单(镜像 NsWorkloadDetail 原 probeToForm;defaults 取 PROBE_DEFAULTS 对应键)
function probeToForm(p, k) {
  const d = PROBE_DEFAULTS[k]
  if (!p) return { ...d }
  const type = p.httpGet ? 'http' : p.tcpSocket ? 'tcp' : 'exec'
  return {
    enabled: true, type,
    httpPath: p.httpGet?.path ?? d.httpPath,
    port: p.httpGet?.port ?? p.tcpSocket?.port ?? d.port,
    execCommand: joinCommandTokens(p.exec?.command || []),
    initialDelaySeconds: p.initialDelaySeconds ?? d.initialDelaySeconds,
    periodSeconds: p.periodSeconds ?? d.periodSeconds,
    timeoutSeconds: p.timeoutSeconds ?? d.timeoutSeconds,
    failureThreshold: p.failureThreshold ?? d.failureThreshold,
    successThreshold: p.successThreshold ?? d.successThreshold,
  }
}

function scToForm(sc) {
  if (!sc) return makeSubContainer().securityContext
  return {
    enabled: true, privileged: !!sc.privileged,
    runAsUser: sc.runAsUser != null ? String(sc.runAsUser) : '', runAsGroup: sc.runAsGroup != null ? String(sc.runAsGroup) : '',
    runAsNonPrivileged: !!sc.runAsNonRoot, readOnlyRootFilesystem: !!sc.readOnlyRootFilesystem,
    addCaps: (sc.capabilities?.add || []).join(','), dropCaps: (sc.capabilities?.drop || []).join(','),
  }
}

// K8s 容器 spec → 表单(全量反解,复制回填与编辑回填共用)。
// 资源缺省回 ''(不补默认值):无 resources 的容器复制/编辑后重建不应凭空长出资源。
export function mapSubContainer(spec = {}) {
  const r = spec.resources || {}
  return {
    name: spec.name || '', image: spec.image || '',
    command: joinCommandTokens(spec.command || []), args: joinArgLines(spec.args || []),
    cpuRequest: r.requests?.cpu || '', cpuLimit: r.limits?.cpu || '',
    memoryRequest: r.requests?.memory || '', memoryLimit: r.limits?.memory || '',
    workingDir: spec.workingDir || '', pullPolicy: spec.imagePullPolicy || '',
    stdin: !!spec.stdin, tty: !!spec.tty,
    envVars: (spec.env || []).filter(e => e.value !== undefined && !e.valueFrom).map(e => ({ key: e.name, value: String(e.value ?? '') })),
    envFromConfigMap: spec.envFrom?.find(e => e.configMapRef)?.configMapRef?.name || '',
    envFromSecret: spec.envFrom?.find(e => e.secretRef)?.secretRef?.name || '',
    envCMKeys: (spec.env || []).filter(e => e.valueFrom?.configMapKeyRef).map(e => ({ name: e.name, cmName: e.valueFrom.configMapKeyRef.name, key: e.valueFrom.configMapKeyRef.key })),
    envSecretKeys: (spec.env || []).filter(e => e.valueFrom?.secretKeyRef).map(e => ({ name: e.name, secretName: e.valueFrom.secretKeyRef.name, key: e.valueFrom.secretKeyRef.key })),
    ports: (spec.ports || []).map(p => ({ containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
    liveness: probeToForm(spec.livenessProbe, 'liveness'),
    readiness: probeToForm(spec.readinessProbe, 'readiness'),
    startup: probeToForm(spec.startupProbe, 'startup'),
    lifecycle: { postStart: joinCommandTokens(spec.lifecycle?.postStart?.exec?.command || []), preStop: joinCommandTokens(spec.lifecycle?.preStop?.exec?.command || []) },
    securityContext: scToForm(spec.securityContext),
    nativeSidecar: spec.restartPolicy === 'Always',
  }
}
