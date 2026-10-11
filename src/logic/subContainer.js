// Init/sidecar 子容器领域模块:表单模型 <-> K8s 容器 spec 的单一事实源。
// 消费方:DeployApp 创建向导(previewYAML/复制回填)、NsWorkloadDetail 编辑面(spec 重建/回填)、
// ContainerEditorDialog(两面共用 UI)。纯函数、无 Vue 依赖,node:test 零依赖可测。
// 键名统一 cpuRequest/cpuLimit/memoryRequest/memoryLimit(编辑面旧 cpuReq 系随本次迁移废弃)。
import { splitCommandTokens, splitArgLines, joinCommandTokens, joinArgLines } from '../utils/containerTokens.js'
import { sanitizeImageToName } from '../utils/containerNames.js'
import { toMountSpec } from './volumeMountValidation.js'
import { envRowsToSpec, envFromRowsToSpec, envRowsFromSpec, envFromRowsFromSpec, envRowCount, envSectionEmpty } from './envRefs.js'

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
    // cpu/memory 之外的第三资源键(ephemeral-storage/nvidia.com/gpu/resources.claims):
    // 反解携带、重建合并,复制/编辑链不再静默丢弃(2026-10-11 审计 B1/B2)。
    extraResources: null,
    // 行溯源:openEdit/mapSubContainer 回填行 = 原容器名(改名后仍指向原件,base 保真不丢);
    // 用户新建行 = ''(即使重用已删容器名也不复活其第三资源键/未建模字段)。
    origName: '',
    workingDir: '', pullPolicy: '', stdin: false, tty: false,
    envRows: [], envFromRows: [],
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

// resources 里 cpu/memory 之外的键(第三资源键)抽取:复制/编辑反解时携带,
// 重建时经 mergeResources 合并回去——GPU/ephemeral-storage/claims 不再被白名单静默删。
export function pickExtraResources(resources) {
  if (!resources || typeof resources !== 'object') return null
  const out = {}
  let any = false
  for (const [k, v] of Object.entries(resources)) {
    if (k === 'requests' || k === 'limits') {
      const sub = {}
      let subAny = false
      for (const [rk, rv] of Object.entries(v || {})) {
        if (rk === 'cpu' || rk === 'memory') continue
        sub[rk] = rv; subAny = true
      }
      if (subAny) { out[k] = sub; any = true }
    } else { out[k] = v; any = true }
  }
  return any ? out : null
}

// 表单四资源键(权威)与 base(原 resources / 第三键)合并:
// - 有值覆盖,清空删除——base 原有 requests/limits 而表单清空 → null(merge-patch 显式删);
// - base 的第三键(ephemeral-storage/GPU/claims 级)原样保留;
// - 全空且无第三键 → null(整删 resources)。主容器(NsWorkloadDetail)与子容器共用单源。
export function mergeResources(base, res = {}) {
  const r = base ? JSON.parse(JSON.stringify(base)) : {}
  const hadReq = 'requests' in r, hadLim = 'limits' in r
  const req = { ...(r.requests || {}) }; delete req.cpu; delete req.memory
  const lim = { ...(r.limits || {}) }; delete lim.cpu; delete lim.memory
  if (res.cpuRequest) req.cpu = String(res.cpuRequest).trim()
  if (res.memoryRequest) req.memory = String(res.memoryRequest).trim()
  if (res.cpuLimit) lim.cpu = String(res.cpuLimit).trim()
  if (res.memoryLimit) lim.memory = String(res.memoryLimit).trim()
  if (Object.keys(req).length) r.requests = req
  else if (hadReq) r.requests = null
  else delete r.requests
  if (Object.keys(lim).length) r.limits = lim
  else if (hadLim) r.limits = null
  else delete r.limits
  return Object.keys(r).length ? r : null
}

// 表单 → K8s 容器 spec 对象。
// opts.fallbackName:name 空时回退名(调用方决定派生/去重;不传则用 image 清洗或 'container')
// opts.mounts:volumeMounts 对象数组或 null(调用方按 target 过滤好)
// opts.nullAbsent:true = 可选字段空时显式 null(编辑面 merge-patch 删除语义),
//                  stdin/tty 恒发显式布尔;false(默认)= omitempty(创建面 YAML 语义)
// opts.base:原容器 spec(编辑面按 name 匹配传入)——克隆后叠加表单建模字段,
//                  未建模键(terminationMessagePath/resizePolicy/resources 第三键等)保真(2026-10-11 #10)
export function buildSubContainerSpec(c, opts = {}) {
  const fallbackName = opts.fallbackName ?? (sanitizeImageToName(c.image) || 'container')
  const o = opts.base ? JSON.parse(JSON.stringify(opts.base)) : {}
  // 建模字段空值:nullAbsent → null(显式删);否则不落键(base 克隆携带的旧值须删掉)
  const set = (k, v) => {
    const absent = v == null || v === '' || (Array.isArray(v) && !v.length)
    if (!absent) o[k] = v
    else if (opts.nullAbsent) o[k] = null
    else delete o[k]
  }
  const cmd = splitCommandTokens(c.command), args = splitArgLines(c.args)
  o.name = c.name || fallbackName
  o.image = c.image || ''
  set('command', cmd.length ? cmd : null)
  set('args', args.length ? args : null)
  set('workingDir', c.workingDir || null)
  set('imagePullPolicy', c.pullPolicy || null)
  if (c.stdin) o.stdin = true
  else if (opts.nullAbsent || opts.base) o.stdin = false
  else delete o.stdin
  if (c.tty) o.tty = true
  else if (opts.nullAbsent || opts.base) o.tty = false
  else delete o.tty
  // resources:base(编辑面原 resources,含第三键)优先,退 c.extraResources(复制链携带)
  const resBase = opts.base ? (opts.base.resources ?? null) : (c.extraResources || null)
  const res = mergeResources(resBase, c)
  if (res) o.resources = res
  else if (opts.nullAbsent) o.resources = null
  else delete o.resources
  set('ports', (c.ports || []).filter(p => p.containerPort).map(p => ({ containerPort: Number(p.containerPort), protocol: p.protocol || 'TCP' })))
  set('env', envRowsToSpec(c.envRows))
  set('envFrom', envFromRowsToSpec(c.envFromRows))
  for (const k of PROBE_KEYS) set(PROBE_FIELD[k], buildProbeSpec(c[k]))
  const lc = {}
  const ps = splitCommandTokens(c.lifecycle?.postStart), pst = splitCommandTokens(c.lifecycle?.preStop)
  if (ps.length) lc.postStart = { exec: { command: ps } }
  if (pst.length) lc.preStop = { exec: { command: pst } }
  set('lifecycle', mergeLifecycle(opts.base?.lifecycle, lc))
  set('securityContext', mergeScSpec(opts.base?.securityContext, buildScSpec(c.securityContext), c.securityContext?.enabled))
  set('volumeMounts', mergeMounts(opts.base?.volumeMounts, opts.mounts && opts.mounts.length ? opts.mounts : null))
  set('restartPolicy', c.nativeSidecar ? 'Always' : null)
  if (opts.nullAbsent) {
    for (const k of NULLABLE_KEYS) if (!(k in o)) o[k] = null
  }
  return o
}

// 挂载行按 target 过滤 → 容器 volumeMounts(单源 toMountSpec,subPath/readOnly 透传,残行丢弃)
export function mountsForTarget(volumeMounts, target) {
  const ms = (volumeMounts || []).filter(v => v.target === target).map(toMountSpec).filter(Boolean)
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
  n += envRowCount(c.envRows, c.envFromRows)
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
  if (!envSectionEmpty(c.envRows, c.envFromRows)) return false
  if ((c.ports || []).some(p => p.containerPort)) return false
  for (const k of PROBE_KEYS) if (c[k]?.enabled) return false
  if (splitCommandTokens(c.lifecycle?.postStart).length || splitCommandTokens(c.lifecycle?.preStop).length) return false
  if (c.securityContext?.enabled) return false
  return true
}

// lifecycle 子对象级合并(编辑面 base 保真):表单只建模 exec 型 postStart/preStop——
// base 的 exec 钩子被表单清空 = 用户清除(删);非 exec 钩子(httpGet/tcpSocket/sleep)表单
// 从未展示,空值≠用户意图 → 保真。其他顶层键原样。
function mergeLifecycle(baseLc, lc) {
  const src = baseLc && typeof baseLc === 'object' && !Array.isArray(baseLc) ? baseLc : null
  const out = { ...(src || {}) }
  for (const k of ['postStart', 'preStop']) {
    if (lc?.[k]) { out[k] = lc[k]; continue }
    if (out[k] && out[k].exec) delete out[k]
  }
  return Object.keys(out).length ? out : (Object.keys(lc || {}).length ? lc : null)
}

// securityContext 子对象级合并:建模子键(表单可表达)全权交表单重建——用户取消勾选=删;
// 未建模子键(seccompProfile/allowPrivilegeEscalation 等)保真。用户整体关闭(enabled=false)=整删。
const SC_MODELED = ['privileged', 'runAsUser', 'runAsGroup', 'runAsNonRoot', 'readOnlyRootFilesystem', 'capabilities']
function mergeScSpec(baseSc, built, enabled) {
  if (baseSc && typeof baseSc === 'object' && !Array.isArray(baseSc)) {
    if (!enabled) return null
    const out = { ...baseSc }
    for (const k of SC_MODELED) delete out[k]
    const merged = { ...out, ...built }
    return Object.keys(merged).length ? merged : null
  }
  return built
}

// volumeMounts 按名合并:建模子键(name/mountPath/subPath/readOnly)表单权威,
// 未建模子键(mountPropagation 等)从 base 同名挂载保真;列表级表单权威(删行=删挂载)。
const MOUNT_MODELED = ['name', 'mountPath', 'subPath', 'readOnly']
function mergeMounts(baseMounts, mounts) {
  if (!Array.isArray(baseMounts) || !mounts) return mounts
  const byName = new Map()
  for (const m of baseMounts) if (m?.name && !byName.has(m.name)) byName.set(m.name, m)
  return mounts.map(m => {
    const b = byName.get(m.name)
    if (!b || typeof b !== 'object') return m
    const out = { ...b }
    for (const k of MOUNT_MODELED) delete out[k]
    return { ...out, ...m }
  })
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
    extraResources: pickExtraResources(spec.resources),
    origName: spec.name || '',
    workingDir: spec.workingDir || '', pullPolicy: spec.imagePullPolicy || '',
    stdin: !!spec.stdin, tty: !!spec.tty,
    envRows: envRowsFromSpec(spec.env),
    envFromRows: envFromRowsFromSpec(spec.envFrom),
    ports: (spec.ports || []).map(p => ({ containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
    liveness: probeToForm(spec.livenessProbe, 'liveness'),
    readiness: probeToForm(spec.readinessProbe, 'readiness'),
    startup: probeToForm(spec.startupProbe, 'startup'),
    lifecycle: { postStart: joinCommandTokens(spec.lifecycle?.postStart?.exec?.command || []), preStop: joinCommandTokens(spec.lifecycle?.preStop?.exec?.command || []) },
    securityContext: scToForm(spec.securityContext),
    nativeSidecar: spec.restartPolicy === 'Always',
  }
}
