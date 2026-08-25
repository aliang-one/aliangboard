# Init/Sidecar 容器字段全覆盖扩充 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** init/sidecar 子容器字段对齐主容器全集(env 三机制/ports/三探针/lifecycle/securityContext/workingDir/pullPolicy/stdin/tty + 原生 sidecar),以「一个域模块 + 一个泛化弹窗、创建/编辑两面消费」收敛全部缺口。

**Architecture:** 新 `src/logic/subContainer.js` 纯函数域模块(模型/构建/回填/空行判定/计数),`ContainerEditorDialog.vue` 泛化为两面共用;创建侧 previewYAML 子容器块改 js-yaml 序列化;NsWorkloadDetail 编辑面模型迁移+键名统一+模板手术(测试先行)。

**Tech Stack:** Vue 3 `<script setup>` 纯 JS、vue-i18n、js-yaml(既有依赖)、node:test 零依赖(纯逻辑)、vitest + happy-dom(组件)。

**Spec:** `docs/superpowers/specs/2026-08-25-subcontainer-full-fields-design.md`

**与 spec 的已裁决偏差(机制替换,目标不变):** spec 写「dump 强制全字符串双引号」;实测 js-yaml 5.2.1 默认启发式已把 YAML 1.1 全危险集(`y/yes/off/0755/1_000/3600/true/null/~/日期` 等)正确加引号、roundtrip 无损,故**不传 styles 覆盖**,用 `dump(obj, { indent: 2, lineWidth: -1 })` 默认行为,并以零依赖测试把危险值集钉死(未来升级 js-yaml 若破坏即测试红)。

## Global Constraints

- 仓库不新增外部依赖(js-yaml 为既有 dependencies)。
- 纯 JS(.js/.vue),无 TypeScript 语法。
- i18n:en.json + zh.json 双语同步过 `npm run i18n:check`;消息值禁 `@`、禁 HTML 标签。
- 纯逻辑测试 = node:test 零依赖 co-located `*.test.mjs` + 注册 `package.json` `test:server`;组件测试 = vitest `.test.js`(只收 .js)。
- 现有 `data-testid`(`init-command-input`/`ced-*` 等)不得移除;现有测试保持绿。
- 子容器键名统一 `cpuRequest/cpuLimit/memoryRequest/memoryLimit`(编辑面旧 `cpuReq` 系全数迁移,grep 清点)。
- NsWorkloadDetail 模板手术前必须先有壳测试(T8 先于 T10)。
- 提交信息:`feat(deploy)/feat(workload)/refactor(...)` 中文 conventional。
- 在 worktree 分支 `feat-subcontainer-full-fields` 开发,不动 main;`docs/superpowers/` 提交须 `git add -f`。

## 关键现状锚点(执行者必读;行号会漂,一律以内容定位)

- **DeployApp.vue**(已含容器编辑弹窗):
  - `makeForm()` 中 `extraContainers: []`/`initContainers: []`;`addExtraContainer/addInitContainer` push 8 字段默认对象
  - `previewYAML` 内:`derivedContainerName`(含播种去重)→ `extraContainersYaml`/`initContainersYaml` 手拼字符串块;`mountLines(target)` 产挂载 YAML(主容器也用,保留)
  - `validate()` 内 `pushContainerErrs`(单源校验循环,`isEmptyEnvRow(c, ['name','image','command','args'])` 空行跳过)
  - 步骤 2 init/sidecar 卡片:头部行(容器 #N 徽标 + `init-expand-btn`/`sidecar-expand-btn` 图标)+ 8 字段格
  - `editing/editingOtherNames/openContainerEditor/onContainerEdited` 弹窗接线
- **NsWorkloadDetail.vue**(编辑面,测试现为零):
  - `openEdit()` 组装 `editForm`(主容器完整:`env/envCMKeys/envSecretKeys/envFromConfigMap/envFromSecret/ports/liveness/readiness/startup/securityContext/lifecycle/cpuReq 系`;子容器:`initContainers/extraContainers` 走窄 `containerToForm`)
  - 本地 `probeToForm/scToForm/buildProbe/buildSc/buildResources/mountObjs/buildSubContainer/containerToForm/splitCsv`
  - 编辑校验函数(返回 errs 字符串数组)内两条 `workload.validation.initMissingImage/sidecarMissingImage`
  - `saveEdit()`:`spec.containers = [c0, ...buildSubContainer(sidecar)]`;`spec.initContainers = buildSubContainer(init)`;merge-patch 语义 = 空值显式 null
  - 模板:edit Modal(`max-w-3xl`)内主容器各 section + init/sidecar 两块行内 3 列小表单(`editForm.initContainers.push({...cpuReq 系})`)
  - 挂载行形状(两面一致):`{ target, name, mountPath, subPath, readOnly, ... }`
- **ContainerEditorDialog.vue**:props `modelValue/container/kind/index/otherNames`;8 字段模板;`#actions` 自管确认
- **containerValidation.js**:`validateContainerFields(c, otherNames)` → `[{field,msgKey,params}]`
- **useWorkloadToForm.js**:`mapSidecar/mapInit`(8 字段窄映射)
- en.json/zh.json:deploy 段已有大量主容器 label 键(command/args/argsHint/containerName/imageUrl/pullPolicy/workingDir/ttyLabel/httpPath/execCommand/initialDelay/period/failureThreshold/healthProbes/lifecycleHooks/postStart/preStop/enableSecurityContext/addCapabilities/dropCapabilities/containerPorts/envDirectGroup/envRefGroup/envFromHint/fromConfigMap/fromSecret/port)与上轮新增(containerSectionBasic/Command/Resources、cpuRequestLabel 等、containerFv.*)

---

### Task 1: 域模块核心 `subContainer.js`(模型+构建+挂载+计数+空行)

**Files:**
- Create: `src/logic/subContainer.js`
- Create: `src/logic/subContainer.test.mjs`
- Modify: `package.json`(test:server 追加注册)

**Interfaces:**
- Consumes: `splitCommandTokens/splitArgLines/joinCommandTokens/joinArgLines`(`../utils/containerTokens.js`)、`sanitizeImageToName`(`../utils/containerNames.js`)
- Produces(Task 2/3/5/6/7/9/10 依赖,签名精确):
  - `makeSubContainer() -> Object`(全字段默认)
  - `buildSubContainerSpec(c, opts = {}) -> Object`;`opts = { fallbackName = 'container', mounts = null, nullAbsent = false }`;omitempty 默认,`nullAbsent: true` 时可选字段空值显式 `null`(merge-patch 删除语义),`stdin/tty` 显式布尔;`nativeSidecar: true` → `restartPolicy: 'Always'`
  - `mountsForTarget(volumeMounts, target) -> Array|null`
  - `advancedCount(c) -> Number`
  - `isSubContainerEmpty(c) -> Boolean`

- [ ] **Step 1: 写失败测试**

`src/logic/subContainer.test.mjs`:

```js
// 子容器领域模块:模型默认/表单→spec 构建(omitempty 与 nullAbsent)/挂载过滤/计数/空行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSubContainer, buildSubContainerSpec, mountsForTarget, advancedCount, isSubContainerEmpty } from './subContainer.js'

const FULL = () => ({
  ...makeSubContainer(),
  name: 'sc', image: 'nginx:1', command: 'sh -c "x"', args: 'a\nb',
  workingDir: '/w', pullPolicy: 'Always', stdin: true, tty: true,
  envVars: [{ key: 'K', value: 'V' }],
  envFromConfigMap: 'cm1', envFromSecret: 'sec1',
  envCMKeys: [{ name: 'A', cmName: 'cm2', key: 'k' }],
  envSecretKeys: [{ name: 'B', secretName: 's2', key: 'k' }],
  ports: [{ containerPort: 9090, protocol: 'UDP' }],
  liveness: { enabled: true, type: 'http', httpPath: '/h', port: 8080, execCommand: '', initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  lifecycle: { postStart: 'echo hi', preStop: '' },
  securityContext: { enabled: true, privileged: false, runAsUser: '1000', runAsGroup: '', runAsNonPrivileged: true, readOnlyRootFilesystem: false, addCaps: 'NET_ADMIN', dropCaps: '' },
  nativeSidecar: true,
})

test('makeSubContainer: 全默认形状(资源默认值与现状卡片一致)', () => {
  const c = makeSubContainer()
  assert.equal(c.cpuRequest, '100m'); assert.equal(c.cpuLimit, '250m')
  assert.equal(c.memoryRequest, '128Mi'); assert.equal(c.memoryLimit, '256Mi')
  assert.deepEqual(c.envVars, []); assert.deepEqual(c.ports, [])
  assert.equal(c.liveness.enabled, false); assert.equal(c.liveness.initialDelaySeconds, 30)
  assert.equal(c.readiness.initialDelaySeconds, 5); assert.equal(c.startup.initialDelaySeconds, 0)
  assert.equal(c.securityContext.enabled, false); assert.equal(c.nativeSidecar, false)
})

test('buildSubContainerSpec: 全字段 omitempty 构建正确', () => {
  const o = buildSubContainerSpec(FULL(), { fallbackName: 'fb', mounts: [{ name: 'v', mountPath: '/d' }] })
  assert.equal(o.name, 'sc'); assert.equal(o.image, 'nginx:1')
  assert.deepEqual(o.command, ['sh', '-c', 'x']); assert.deepEqual(o.args, ['a', 'b'])
  assert.equal(o.workingDir, '/w'); assert.equal(o.imagePullPolicy, 'Always')
  assert.equal(o.stdin, true); assert.equal(o.tty, true)
  assert.deepEqual(o.resources, { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '250m', memory: '256Mi' } })
  assert.deepEqual(o.ports, [{ containerPort: 9090, protocol: 'UDP' }])
  assert.deepEqual(o.env, [
    { name: 'K', value: 'V' },
    { name: 'A', valueFrom: { configMapKeyRef: { name: 'cm2', key: 'k' } } },
    { name: 'B', valueFrom: { secretKeyRef: { name: 's2', key: 'k' } } },
  ])
  assert.deepEqual(o.envFrom, [{ configMapRef: { name: 'cm1' } }, { secretRef: { name: 'sec1' } }])
  assert.deepEqual(o.livenessProbe, { initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1, httpGet: { path: '/h', port: 8080 } })
  assert.deepEqual(o.lifecycle, { postStart: { exec: { command: ['echo', 'hi'] } } })
  assert.deepEqual(o.securityContext, { runAsUser: 1000, runAsNonRoot: true, capabilities: { add: ['NET_ADMIN'] } })
  assert.deepEqual(o.volumeMounts, [{ name: 'v', mountPath: '/d' }])
  assert.equal(o.restartPolicy, 'Always')
})

test('buildSubContainerSpec: 空容器 omitempty 只发 name/image(带 fallback;资源默认值清空后)', () => {
  const bare = { ...makeSubContainer(), image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }
  const o = buildSubContainerSpec(bare, { fallbackName: 'fb' })
  assert.deepEqual(Object.keys(o).sort(), ['image', 'name'])
  assert.equal(o.name, 'fb')
})

test('buildSubContainerSpec: nullAbsent 编辑语义——可选空字段显式 null,stdin/tty 显式布尔', () => {
  const cleared = { ...makeSubContainer(), image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }
  const o = buildSubContainerSpec(cleared, { nullAbsent: true })
  for (const k of ['command', 'args', 'workingDir', 'imagePullPolicy', 'resources', 'ports', 'env', 'envFrom', 'livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle', 'securityContext', 'volumeMounts', 'restartPolicy']) {
    assert.ok(k in o, `${k} 应显式存在`); assert.equal(o[k], null, `${k} 应为 null`)
  }
  assert.equal(o.stdin, false); assert.equal(o.tty, false)
  // 全填时 nullAbsent 不覆盖真实值
  const full = buildSubContainerSpec(FULL(), { nullAbsent: true })
  assert.equal(full.workingDir, '/w'); assert.equal(full.restartPolicy, 'Always')
})

test('buildSubContainerSpec: 半填资源只发存在的档位;空行资源不发', () => {
  const o = buildSubContainerSpec({ ...makeSubContainer(), image: 'n', cpuRequest: '', cpuLimit: '1', memoryRequest: '', memoryLimit: '' })
  assert.deepEqual(o.resources, { limits: { cpu: '1' } })
  const bare = buildSubContainerSpec({ ...makeSubContainer(), image: 'n', cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' })
  assert.ok(!('resources' in bare))
})

test('mountsForTarget: 按 target 过滤且丢残行;subPath/readOnly 透传', () => {
  const rows = [
    { target: 'init:0', name: 'a', mountPath: '/a', subPath: 's', readOnly: true },
    { target: 'main', name: 'b', mountPath: '/b' },
    { target: 'init:0', name: '', mountPath: '/c' },
  ]
  assert.deepEqual(mountsForTarget(rows, 'init:0'), [{ name: 'a', mountPath: '/a', subPath: 's', readOnly: true }])
  assert.equal(mountsForTarget(rows, 'sidecar:1'), null)
})

test('advancedCount: 计已配置条目', () => {
  assert.equal(advancedCount(makeSubContainer()), 0)
  const c = FULL()
  // env 1 + cm 1 + secret 1 + envFrom 2 + ports 1 + liveness 1 + postStart 1 + sc 1
  // + workingDir/pullPolicy/stdin/tty/native 各 1 = 14
  assert.equal(advancedCount(c), 14)
})

test('isSubContainerEmpty: 4 基础字段空但高级字段有值 → 非空行', () => {
  assert.equal(isSubContainerEmpty(makeSubContainer()), true)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), name: 'x' }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), envVars: [{ key: '', value: '' }] }), true)   // 残行不算
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), envVars: [{ key: 'K', value: '' }] }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), ports: [{ containerPort: '', protocol: 'TCP' }] }), true)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), ports: [{ containerPort: 80, protocol: 'TCP' }] }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), liveness: { ...makeSubContainer().liveness, enabled: true } }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), nativeSidecar: true }), false)
  assert.equal(isSubContainerEmpty({ ...makeSubContainer(), securityContext: { ...makeSubContainer().securityContext, enabled: true } }), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/subContainer.test.mjs`
Expected: FAIL(module not found)

- [ ] **Step 3: 实现**

`src/logic/subContainer.js`:

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/logic/subContainer.test.mjs`
Expected: PASS 8 tests

- [ ] **Step 5: 注册 + 提交**

`package.json` `test:server` 末尾追加 ` && node --test src/logic/subContainer.test.mjs`,跑 `npm run test:server` 全绿后:

```bash
git add src/logic/subContainer.js src/logic/subContainer.test.mjs package.json
git commit -m "feat(deploy): 子容器域模块单源(模型/构建/挂载/计数/空行判定)"
```

---

### Task 2: `mapSubContainer` 全量回填 + 复制 workload 接线

**Files:**
- Modify: `src/logic/subContainer.js`(追加 mapSubContainer)
- Modify: `src/logic/subContainer.test.mjs`(追加用例)
- Modify: `src/composables/useWorkloadToForm.js`(mapSidecar/mapInit 换 mapSubContainer)

**Interfaces:**
- Consumes: Task 1 全部;`joinCommandTokens/joinArgLines`
- Produces: `mapSubContainer(spec = {}) -> Object`(makeSubContainer 形状,全字段反解;`restartPolicy === 'Always'` → `nativeSidecar: true`;资源缺省为 `''` 而非默认值——无损往返:原 spec 没有的字段回填后重建也不凭空出现)

- [ ] **Step 1: 追加失败测试**

```js
import { mapSubContainer } from './subContainer.js'

const SPEC = () => ({
  name: 'sc', image: 'nginx:1', command: ['sh', '-c', 'x'], args: ['a', 'b'],
  workingDir: '/w', imagePullPolicy: 'Always', stdin: true, tty: true,
  resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
  ports: [{ containerPort: 9090, protocol: 'UDP' }],
  env: [
    { name: 'K', value: 'V' },
    { name: 'A', valueFrom: { configMapKeyRef: { name: 'cm', key: 'k' } } },
    { name: 'B', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } },
  ],
  envFrom: [{ configMapRef: { name: 'cm1' } }, { secretRef: { name: 'sec1' } }],
  livenessProbe: { httpGet: { path: '/h', port: 8080 }, initialDelaySeconds: 3 },
  lifecycle: { preStop: { exec: { command: ['echo', 'bye'] } } },
  securityContext: { runAsUser: 1000, runAsNonRoot: true, capabilities: { add: ['NET_ADMIN'] } },
  volumeMounts: [{ name: 'v', mountPath: '/d' }],
})

test('mapSubContainer: 全字段反解 + buildSubContainerSpec 无损往返', () => {
  const f = mapSubContainer(SPEC())
  assert.equal(f.name, 'sc'); assert.equal(f.command, 'sh -c "x"'); assert.equal(f.args, 'a\nb')
  assert.equal(f.workingDir, '/w'); assert.equal(f.pullPolicy, 'Always'); assert.equal(f.stdin, true)
  assert.equal(f.cpuRequest, '1'); assert.equal(f.memoryLimit, '2Gi')
  assert.deepEqual(f.envVars, [{ key: 'K', value: 'V' }])
  assert.deepEqual(f.envCMKeys, [{ name: 'A', cmName: 'cm', key: 'k' }])
  assert.deepEqual(f.envSecretKeys, [{ name: 'B', secretName: 's', key: 'k' }])
  assert.equal(f.envFromConfigMap, 'cm1'); assert.equal(f.envFromSecret, 'sec1')
  assert.deepEqual(f.ports, [{ containerPort: 9090, protocol: 'UDP' }])
  assert.equal(f.liveness.enabled, true); assert.equal(f.liveness.type, 'http'); assert.equal(f.liveness.initialDelaySeconds, 3)
  assert.equal(f.lifecycle.preStop, 'echo bye')
  assert.equal(f.securityContext.enabled, true); assert.equal(f.securityContext.runAsUser, '1000'); assert.equal(f.securityContext.addCaps, 'NET_ADMIN')
  // 往返:回填→重建(omitempty+显式 mounts 透传)关键字段不丢
  const back = buildSubContainerSpec(f, { mounts: SPEC().volumeMounts })
  assert.equal(back.workingDir, '/w'); assert.deepEqual(back.env, SPEC().env)
  assert.deepEqual(back.securityContext, SPEC().securityContext)
  assert.deepEqual(back.lifecycle, SPEC().lifecycle)
  // 探针数值被构建器补全默认(period/timeout/threshold),断言补全后的完整形状
  assert.deepEqual(back.livenessProbe, { httpGet: { path: '/h', port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 })
})

test('mapSubContainer: 空 spec → 全默认且资源为空串(缺资源不凭空补默认,无损)', () => {
  const f = mapSubContainer({ name: 'x', image: 'nginx' })
  assert.equal(f.cpuRequest, ''); assert.equal(f.cpuLimit, ''); assert.equal(f.memoryRequest, ''); assert.equal(f.memoryLimit, '')
  assert.equal(f.nativeSidecar, false); assert.equal(f.liveness.enabled, false)
  const c = makeSubContainer()
  assert.deepEqual(Object.keys(f).sort(), Object.keys(c).sort())
})

test('mapSubContainer: restartPolicy Always → nativeSidecar(往返归位)', () => {
  const f = mapSubContainer({ name: 'n', image: 'i', restartPolicy: 'Always' })
  assert.equal(f.nativeSidecar, true)
  assert.equal(buildSubContainerSpec(f).restartPolicy, 'Always')
  assert.equal(buildSubContainerSpec(mapSubContainer({ name: 'n', image: 'i' })).restartPolicy, undefined)
})

test('mapSubContainer: tcp/exec 探针形状', () => {
  const f = mapSubContainer({ name: 'x', readinessProbe: { tcpSocket: { port: 9 } } })
  assert.equal(f.readiness.type, 'tcp'); assert.equal(f.readiness.port, 9)
  const e = mapSubContainer({ name: 'x', startupProbe: { exec: { command: ['ls'] } } })
  assert.equal(e.startup.type, 'exec'); assert.equal(e.startup.execCommand, 'ls')
})
```

- [ ] **Step 2: 确认失败**

Run: `node --test src/logic/subContainer.test.mjs`
Expected: 新 4 例 FAIL(mapSubContainer 未导出)

- [ ] **Step 3: 实现(追加到 subContainer.js)**

```js
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
    runAsUser: sc.runAsUser ?? '', runAsGroup: sc.runAsGroup ?? '',
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
```

- [ ] **Step 4: 确认通过**

Run: `node --test src/logic/subContainer.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: useWorkloadToForm 接线**

`src/composables/useWorkloadToForm.js`:删除本地 `mapSidecar`/`mapInit` 两函数,imports 加 `import { mapSubContainer } from '../logic/subContainer.js'`,原两处调用改:

```js
  out.extraContainers = containers.slice(1).map(mapSubContainer)
  out.initContainers = (pod.initContainers || []).map(mapSubContainer)
```

同时文件头注释「多容器:主容器完整 + 其余进 extraContainers(窄)、init 进 initContainers(窄)」改为「多容器:主容器完整 + 其余/子容器全量反解(mapSubContainer,与编辑面单源)」。

**行为变化(有意)**:复制带 restartPolicy Always 的原生 sidecar 时会归入 extraContainers 且 nativeSidecar=true(previewYAML 在 Task 5 接 buildSubContainerSpec 后能正确归位);无 resources 的子容器复制后不再凭空补 100m/250m 默认。

- [ ] **Step 6: 跑存量 + 提交**

Run: `npm run test:server && npx vitest run src/views/__tests__/`
Expected: 全绿(CopyWorkloadDialog 等存量不回归)

```bash
git add src/logic/subContainer.js src/logic/subContainer.test.mjs src/composables/useWorkloadToForm.js
git commit -m "feat(deploy): mapSubContainer 全量回填单源,复制 workload 不再丢子容器字段"
```

---

### Task 3: 校验扩展(ports/env/探针)

**Files:**
- Modify: `src/logic/containerValidation.js`
- Modify: `src/logic/containerValidation.test.mjs`

**Interfaces:**
- Consumes: `splitCommandTokens`、`firstDuplicateEnvName`(`../utils/envRows.js`,签名 `firstDuplicateEnvName(envVars, envCMKeys, envSecretKeys) -> string|undefined`,吃 {key,value} 与 {name} 混合行——实测以 utils/envRows.js 为准,若签名不符则本地实现同名逻辑)
- Produces: `validateContainerFields(c, otherNames)` 返回集扩展字段 `'ports' | 'env' | 'liveness' | 'readiness' | 'startup'`,msgKey 新增:`deploy.containerFv.portRequired` / `portRange` / `protocolInvalid` / `envMissingKey` / `envNameDuplicate` / `probePortRequired` / `probeCommandRequired`(params:port 类带 `{ idx }`,env 重复带 `{ name }`,探针带 `{ probe }`)

- [ ] **Step 1: 追加失败测试**

`containerValidation.test.mjs` 末尾(顶部加 `import { makeSubContainer } from './subContainer.js'`;探针用例的容器形状来自 makeSubContainer——现有 `C()` 无探针字段):

```js
test('ports: 残行跳过;containerPort 非数字/越界/协议非法各报对应错', () => {
  const base = () => ({ ...C(), ports: [] })
  assert.deepEqual(validateContainerFields({ ...base(), ports: [{ containerPort: '', protocol: 'TCP' }] }).filter(e => e.field === 'ports'), [])
  const miss = validateContainerFields({ ...base(), ports: [{ containerPort: 'x', protocol: 'TCP' }] })
  assert.equal(miss[0].msgKey, 'deploy.containerFv.portRequired')
  const range = validateContainerFields({ ...base(), ports: [{ containerPort: 70000, protocol: 'TCP' }] })
  assert.equal(range[0].msgKey, 'deploy.containerFv.portRange')
  const proto = validateContainerFields({ ...base(), ports: [{ containerPort: 80, protocol: 'XXX' }] })
  assert.equal(proto[0].msgKey, 'deploy.containerFv.protocolInvalid')
})

test('env: 残行跳过;缺 key 报 envMissingKey;三机制重名报 envNameDuplicate', () => {
  const base = () => ({ ...C(), envVars: [], envCMKeys: [], envSecretKeys: [] })
  assert.deepEqual(validateContainerFields({ ...base(), envVars: [{ key: '', value: '' }] }).filter(e => e.field === 'env'), [])
  const miss = validateContainerFields({ ...base(), envVars: [{ key: '', value: 'v' }, { key: 'A', value: '' }] })
  assert.equal(miss[0].msgKey, 'deploy.containerFv.envMissingKey')
  const dup = validateContainerFields({ ...base(), envVars: [{ key: 'A', value: '1' }], envCMKeys: [{ name: 'A', cmName: 'c', key: 'k' }] })
  assert.equal(dup[0].msgKey, 'deploy.containerFv.envNameDuplicate')
  assert.deepEqual(dup[0].params, { name: 'A' })
})

test('探针: disabled 不报;http/tcp 缺 port 报 probePortRequired;exec 缺命令报 probeCommandRequired', () => {
  const base = () => makeSubContainer()
  const ok = validateContainerFields({ ...base(), image: 'nginx' })
  assert.deepEqual(ok.filter(e => ['liveness', 'readiness', 'startup'].includes(e.field)), [])
  const c1 = { ...base(), image: 'nginx', liveness: { ...base().liveness, enabled: true, type: 'http', port: '' } }
  const e1 = validateContainerFields(c1).find(e => e.field === 'liveness')
  assert.equal(e1.msgKey, 'deploy.containerFv.probePortRequired')
  assert.deepEqual(e1.params, { probe: 'liveness' })
  const c2 = { ...base(), image: 'nginx', startup: { ...base().startup, enabled: true, type: 'exec', execCommand: '' } }
  assert.equal(validateContainerFields(c2).find(e => e.field === 'startup').msgKey, 'deploy.containerFv.probeCommandRequired')
})
```

**契约敲定**(实现照此,别抄被否掉的中间版):ports 残行 = `containerPort === '' || containerPort == null`;`Number(containerPort)` 非有限或 <1 或 >65535 → `portRange`(`'x'` → NaN → portRequired);protocol ∉ {TCP,UDP,SCTP} → `protocolInvalid`。env 残行 = 三机制各自「行全空」跳过(与主容器 isEmptyEnvRow 语义一致:envVars 查 key/value,envCMKeys 查 name/cmName/key,envSecretKeys 查 name/secretName/key),非空行缺必需键 → envMissingKey(params { idx } 为 1-based 行号);跨机制重名(firstDuplicateEnvName 语义)→ envNameDuplicate(params { name })。探针 enabled 且 type http/tcp 且 `port === '' || isNaN(Number(port))` → probePortRequired(params { probe: 'liveness'|'readiness'|'startup' });type exec 且 splitCommandTokens(execCommand) 为空 → probeCommandRequired(同 params)。

- [ ] **Step 2: 确认失败**

Run: `node --test src/logic/containerValidation.test.mjs`
Expected: 新 3 例 FAIL

- [ ] **Step 3: 实现(containerValidation.js 追加)**

顶部补 import:

```js
import { splitCommandTokens } from '../utils/containerTokens.js'
import { isEmptyEnvRow, firstDuplicateEnvName } from '../utils/envRows.js'
```

(先读 `src/utils/envRows.js` 确认 `firstDuplicateEnvName` 参数形状:若它要求三参 (envVars, envCMKeys, envSecretKeys) 且行形状为 {key,value}/{name,...}——与子容器表单行一致——直接用;若不一致,在 containerValidation.js 内写等价私有实现 `dupEnvName(c)`,勿改 envRows.js。)

`validateContainerFields` 的 `return errs` 前追加:

```js
  // ports:残行(containerPort 空)跳过;非数字→portRequired;越界→portRange;协议→protocolInvalid
  ;(c.ports || []).forEach((p, i) => {
    if (p.containerPort === '' || p.containerPort == null) return
    const n = Number(p.containerPort)
    if (!Number.isFinite(n)) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.portRequired', params: { idx: i + 1 } })
    else if (n < 1 || n > 65535) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.portRange', params: { idx: i + 1 } })
    if (p.protocol && !['TCP', 'UDP', 'SCTP'].includes(p.protocol)) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.protocolInvalid', params: { idx: i + 1 } })
  })
  // env:三机制残行跳过;非空行缺键报;跨机制重名报
  ;(c.envVars || []).forEach((e, i) => {
    if (!isEmptyEnvRow(e, ['key', 'value']) && !e.key) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { idx: i + 1 } })
  })
  ;(c.envCMKeys || []).forEach(e => {
    if (!isEmptyEnvRow(e, ['name', 'cmName', 'key']) && (!e.name || !e.cmName || !e.key)) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { name: e.name || '—' } })
  })
  ;(c.envSecretKeys || []).forEach(e => {
    if (!isEmptyEnvRow(e, ['name', 'secretName', 'key']) && (!e.name || !e.secretName || !e.key)) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { name: e.name || '—' } })
  })
  const dup = firstDuplicateEnvName(c.envVars || [], c.envCMKeys || [], c.envSecretKeys || [])
  if (dup) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envNameDuplicate', params: { name: dup } })
  // 探针:enabled 时 http/tcp 须 port,exec 须命令
  for (const k of ['liveness', 'readiness', 'startup']) {
    const p = c[k]
    if (!p || !p.enabled) continue
    if ((p.type === 'http' || p.type === 'tcp') && (p.port === '' || p.port == null || isNaN(Number(p.port))))
      errs.push({ field: k, msgKey: 'deploy.containerFv.probePortRequired', params: { probe: k } })
    if (p.type === 'exec' && !splitCommandTokens(p.execCommand).length)
      errs.push({ field: k, msgKey: 'deploy.containerFv.probeCommandRequired', params: { probe: k } })
  }
```

- [ ] **Step 4: 确认通过 + 存量**

Run: `node --test src/logic/containerValidation.test.mjs && npm run test:server`
Expected: 全 PASS(存量 DeployApp 校验测试不回归——旧 8 字段容器无新数组字段,新规则不触发)

- [ ] **Step 5: 提交**

```bash
git add src/logic/containerValidation.js src/logic/containerValidation.test.mjs
git commit -m "feat(deploy): 子容器校验扩展(ports/env 三机制/探针必填项)"
```

---

### Task 4: i18n 键(en/zh)

**Files:**
- Modify: `src/locales/en.json`、`src/locales/zh.json`(deploy 段,上轮 `containerFv` 对象后追加 `ced` 对象;`containerFv` 对象内追加 7 个新叶键)

**Interfaces:**
- Produces: Task 6/7/9/10 消费的键(全部 `deploy.ced.*` 与 `deploy.containerFv.*` 新叶;复用既有键清单见下)

- [ ] **Step 1: en.json —— `containerFv` 对象内追加叶键(保持对象闭合)**

```json
      "portRequired": "Port row {idx}: port is required",
      "portRange": "Port row {idx}: must be 1-65535",
      "protocolInvalid": "Port row {idx}: protocol must be TCP/UDP/SCTP",
      "envMissingKey": "Env row incomplete (missing name/key)",
      "envNameDuplicate": "Duplicate env name: {name}",
      "probePortRequired": "{probe} probe requires a port",
      "probeCommandRequired": "{probe} probe requires an exec command"
```

- [ ] **Step 2: en.json —— `containerFv` 对象后追加 `ced` 对象**

```json
    "ced": {
      "advancedBadge": "Advanced ({n})",
      "sectionEnv": "Environment",
      "sectionPorts": "Ports",
      "sectionProbes": "Health Probes",
      "sectionLifecycle": "Lifecycle Hooks",
      "sectionSecurity": "Security Context",
      "addEnvRow": "Add",
      "envKeyPh": "KEY",
      "envValPh": "value",
      "envNamePh": "NAME",
      "envFromCmLabel": "envFrom ConfigMap",
      "envFromSecretLabel": "envFrom Secret",
      "addPortRow": "Add",
      "portNumberPh": "8080",
      "protocolLabel": "Protocol",
      "probeEnable": "Enable",
      "probeTypeHttp": "HTTP",
      "probeTypeTcp": "TCP",
      "probeTypeExec": "Exec",
      "timeoutSeconds": "Timeout (s)",
      "successThreshold": "Success Threshold",
      "stdinLabel": "stdin",
      "privileged": "Privileged",
      "runAsUser": "runAsUser",
      "runAsGroup": "runAsGroup",
      "runAsNonRoot": "runAsNonRoot",
      "readOnlyRootFilesystem": "Read-only rootfs",
      "nativeSidecar": "Native sidecar (k8s ≥1.28)",
      "nativeSidecarHint": "Emits to initContainers with restartPolicy: Always — starts before the main container and terminates in order"
    },
```

- [ ] **Step 3: zh.json 对应两处(键序与 en 完全一致)**

containerFv 追加:

```json
      "portRequired": "端口行 {idx}:端口号必填",
      "portRange": "端口行 {idx}:须在 1-65535",
      "protocolInvalid": "端口行 {idx}:协议须为 TCP/UDP/SCTP",
      "envMissingKey": "环境变量行不完整(缺名称/键)",
      "envNameDuplicate": "环境变量名重复:{name}",
      "probePortRequired": "{probe} 探针须填端口",
      "probeCommandRequired": "{probe} 探针须填 exec 命令"
```

ced 对象:

```json
    "ced": {
      "advancedBadge": "高级配置({n})",
      "sectionEnv": "环境变量",
      "sectionPorts": "容器端口",
      "sectionProbes": "健康探针",
      "sectionLifecycle": "生命周期钩子",
      "sectionSecurity": "安全上下文",
      "addEnvRow": "添加",
      "envKeyPh": "KEY",
      "envValPh": "值",
      "envNamePh": "NAME",
      "envFromCmLabel": "envFrom ConfigMap",
      "envFromSecretLabel": "envFrom Secret",
      "addPortRow": "添加",
      "portNumberPh": "8080",
      "protocolLabel": "协议",
      "probeEnable": "启用",
      "probeTypeHttp": "HTTP",
      "probeTypeTcp": "TCP",
      "probeTypeExec": "Exec",
      "timeoutSeconds": "超时(秒)",
      "successThreshold": "成功阈值",
      "stdinLabel": "stdin",
      "privileged": "特权模式",
      "runAsUser": "runAsUser",
      "runAsGroup": "runAsGroup",
      "runAsNonRoot": "以非 root 运行",
      "readOnlyRootFilesystem": "只读根文件系统",
      "nativeSidecar": "原生 sidecar(k8s ≥1.28)",
      "nativeSidecarHint": "发到 initContainers 且带 restartPolicy: Always——先于主容器启动、按序终止"
    },
```

复用清单(已存在,勿重复添加):`deploy.command/args/argsHint/containerName/imageUrl/pullPolicy/workingDir/ttyLabel/httpPath/execCommand/initialDelay/period/failureThreshold/postStart/preStop/enableSecurityContext/addCapabilities/dropCapabilities/port/envFromHint/fromConfigMap/fromSecret/envDirectGroup/envRefGroup/containerSectionBasic/containerSectionCommand/containerSectionResources/cpuRequestLabel/cpuLimitLabel/memoryRequestLabel/memoryLimitLabel/containerBadge/editInitContainer/editSidecarContainer/editContainerExpand/containerFv.*`。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run i18n:check` 且 `node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('src/locales/zh.json','utf8'));console.log('ok')"`
Expected: 通过

```bash
git add src/locales/en.json src/locales/zh.json
git commit -m "feat(i18n): 子容器弹窗全字段键 deploy.ced.*(en/zh 对齐)"
```

---

### Task 5: 创建侧 previewYAML 子容器块改 js-yaml 序列化

**Files:**
- Modify: `src/views/DeployApp.vue`(imports + previewYAML 两块)
- Create: `src/views/__tests__/DeployApp.subcontainer-yaml.test.js`

**Interfaces:**
- Consumes: Task 1 `buildSubContainerSpec/mountsForTarget`;Task 2 后 useWorkloadToForm 已回填全字段(复制路径本 task 即生效)
- Produces: previewYAML 子容器块由 `dump([buildSubContainerSpec(...)], { indent: 2, lineWidth: -1 })` 生成,每行前缀 6 空格拼接

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/DeployApp.subcontainer-yaml.test.js`(mock 骨架与 `DeployApp.container-editor.test.js` 完全一致——复制其 import 段、三个 vi.mock、mountApp、C 工厂;`C` 此处换 `SC = () => makeSubContainer()`):

```js
// 子容器 YAML 序列化安全 + 全字段落地 + 原生 sidecar 归位:
// dump 默认启发式对 YAML 1.1 危险值加引号(实测钉住),lineWidth:-1 禁折行。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { makeSubContainer } from '@/logic/subContainer'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

async function podWith(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx', ...extraForm } })
  await flushPromises()
  return load(w.vm.previewYAML).spec.template.spec
}

test('子容器 env/探针/安全上下文全落地,YAML 1.1 危险值不变形', async () => {
  const sc = { ...makeSubContainer(), name: 'sc1', image: 'busybox',
    envVars: [{ key: 'A', value: 'on' }, { key: 'B', value: '3600' }, { key: 'C', value: '2026-08-15' }, { key: 'D', value: 'l1\nl2' }],
    liveness: { ...makeSubContainer().liveness, enabled: true, type: 'http' },
    securityContext: { ...makeSubContainer().securityContext, enabled: true, runAsUser: '1000' } }
  const pod = await podWith({ extraContainers: [sc] })
  const side = pod.containers[1]
  expect(side.env.map(e => [e.name, typeof e.value, e.value])).toEqual([
    ['A', 'string', 'on'], ['B', 'string', '3600'], ['C', 'string', '2026-08-15'], ['D', 'string', 'l1\nl2'],
  ])
  expect(side.livenessProbe.httpGet).toEqual({ path: '/health', port: 8080 })
  expect(side.securityContext).toEqual({ runAsUser: 1000 })
})

test('原生 sidecar → initContainers 尾部 + restartPolicy: Always;普通 sidecar 仍在 containers', async () => {
  const pod = await podWith({
    initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox' }],
    extraContainers: [
      { ...makeSubContainer(), name: 'plain', image: 'nginx' },
      { ...makeSubContainer(), name: 'native', image: 'envoy', nativeSidecar: true },
    ],
  })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'plain'])
  expect(pod.initContainers.map(c => c.name)).toEqual(['i0', 'native'])
  expect(pod.initContainers.map(c => c.restartPolicy)).toEqual([undefined, 'Always'])
})

test('子容器挂载按 target 落 volumeMounts(创建面)', async () => {
  const sc = { ...makeSubContainer(), name: 'sc1', image: 'busybox' }
  const pod = await podWith({
    extraContainers: [sc],
    volumeMounts: [
      { name: 'v1', target: 'sidecar:0', type: 'pvc', mountPath: '/data', subPath: 's', readOnly: true, pvcName: 'p1', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
      { name: 'v2', target: 'main', type: 'pvc', mountPath: '/m', subPath: '', readOnly: false, pvcName: 'p2', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
    ],
  })
  expect(pod.containers[1].volumeMounts).toEqual([{ name: 'v1', mountPath: '/data', subPath: 's', readOnly: true }])
})
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/views/__tests__/DeployApp.subcontainer-yaml.test.js`
Expected: FAIL(env 等字段不存在——当前 previewYAML 只发 8 字段)

- [ ] **Step 3: 实现**

DeployApp imports 加:

```js
import { dump as yamlDump } from 'js-yaml'
import { buildSubContainerSpec, mountsForTarget } from '@/logic/subContainer'
```

previewYAML 内,`extraContainersYaml` 与 `initContainersYaml` 两块整体替换为:

```js
  // 子容器 YAML:buildSubContainerSpec → js-yaml dump(默认引号启发式实测覆盖 YAML 1.1
  // 危险值集;lineWidth:-1 禁折行)→ 每行前缀 6 空格(对齐列表项 6/属性 8 缩进)。
  // 丢弃旧手拼(env value 带引号/换行会踩 yamlScalar 系列坑);mountLines 仅主容器继续用。
  // 原生 sidecar 归位:发到 initContainers 尾部(挂载 target 仍按 extraContainers 原索引)。
  const DUMP_OPTS = { indent: 2, lineWidth: -1 }
  const subYaml = (c, target, fallback) => !c.image ? null :
    yamlDump([buildSubContainerSpec(c, { fallbackName: fallback, mounts: mountsForTarget(f.volumeMounts, target) })], DUMP_OPTS)
      .trimEnd().split('\n').map(l => '      ' + l).join('\n')
  const plainSidecars = f.extraContainers.filter(c => !c.nativeSidecar)
  const nativeSidecars = f.extraContainers.filter(c => c.nativeSidecar)
  const extraContainersYaml = plainSidecars
    .map((c) => {
      const idx = f.extraContainers.indexOf(c)
      return subYaml(c, `sidecar:${idx}`, derivedContainerName(c.image, `sidecar-${idx + 1}`))
    })
    .filter(Boolean).join('\n')
  const initContainersYaml = [...f.initContainers, ...nativeSidecars]
    .map((c) => {
      const isInit = f.initContainers.includes(c)
      const idx = isInit ? f.initContainers.indexOf(c) : f.extraContainers.indexOf(c)
      return subYaml(c, isInit ? `init:${idx}` : `sidecar:${idx}`, derivedContainerName(c.image, `${isInit ? 'init' : 'sidecar'}-${idx + 1}`))
    })
    .filter(Boolean).join('\n')
```

注意:`derivedContainerName` 定义必须仍在这些行之前(现况在其上方,保持不动);原两块中 `mountLines(`sidecar:${idx}`)`/`mountLines(`init:${idx}`)` 调用随旧块删除;`mountLines('main')` 主容器调用保留。

- [ ] **Step 4: 确认通过 + 存量回归**

Run: `npx vitest run src/views/__tests__/ && npm run test:server`
Expected: 全绿(container-names 4+1 例、container-editor 3 例、container-validation 6 例不回归)

- [ ] **Step 5: 提交**

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.subcontainer-yaml.test.js
git commit -m "feat(deploy): 创建向学子容器 YAML 全字段序列化(js-yaml,1.1 危险值实测钉住)"
```

---

### Task 6: ContainerEditorDialog 泛化(全字段分节+折叠+原生开关)

**Files:**
- Modify: `src/components/common/ContainerEditorDialog.vue`
- Modify: `src/components/common/__tests__/ContainerEditorDialog.test.js`

**Interfaces:**
- Consumes: Task 1 全部;Task 3 扩展后的 `validateContainerFields`;Task 4 `deploy.ced.*` 键;既有 `EnvSourceField`(props `kind='configmap'|'secret'`、`namespace`、`v-model:name`、`v-model:dataKey`)
- Produces(Task 7/10 依赖):
  - 新 prop:`namespace: { type: String, default: '' }`(EnvSourceField 用)
  - draft 形状 = `makeSubContainer()` 全字段;confirm payload 同
  - 展示不变约束:8 基础字段的 `ced-*` testid 原样;新增 `ced-env-section`/`ced-ports-section`/`ced-probes-section`/`ced-lifecycle-section`/`ced-security-section`(折叠节容器)、`ced-native-toggle`(sidecar 才渲染)、`ced-advanced-badge`(弹窗外卡片用,本 task 只在组件内导出计数展示于标题旁,badge 按钮本体在 Task 7/10 卡片上)

- [ ] **Step 1: 追加失败测试(ContainerEditorDialog.test.js 末尾)**

```js
import { makeSubContainer } from '@/logic/subContainer'

test('全字段:env/ports/探针/原生开关在 draft 中编辑并随 confirm 完整发出', async () => {
  mountDialog({ container: { ...makeSubContainer(), name: 'sc', image: 'nginx' }, kind: 'sidecar', namespace: 'default' })
  // 展开 env 节并加一行
  $('ced-env-section').querySelector('button[data-testid="ced-env-toggle"]').click()
  $('ced-env-add').click()
  const key0 = $('ced-env-section').querySelector('[data-testid="ced-env-key-0"]')
  key0.value = 'K'; key0.dispatchEvent(new Event('input'))
  // 端口节加一行
  $('ced-ports-section').querySelector('button[data-testid="ced-ports-toggle"]').click()
  $('ced-ports-add').click()
  $('ced-ports-section').querySelector('[data-testid="ced-port-0"]').value = '9090'
  $('ced-ports-section').querySelector('[data-testid="ced-port-0"]').dispatchEvent(new Event('input'))
  // 原生开关(仅 sidecar 渲染)
  expect($('ced-native-toggle')).toBeTruthy()
  $('ced-native-toggle').click()
  $('ced-confirm-btn').click()
  const payload = wrapper.emitted('confirm')[0][0]
  expect(payload.envVars).toEqual([{ key: 'K', value: '' }])
  expect(payload.ports).toEqual([{ containerPort: '9090', protocol: 'TCP' }])
  expect(payload.nativeSidecar).toBe(true)
})

test('init 容器不渲染原生 sidecar 开关', async () => {
  mountDialog({ container: { ...makeSubContainer(), image: 'nginx' }, kind: 'init' })
  expect($('ced-native-toggle')).toBeNull()
})

test('新校验:env 缺 key 残值行 blur 显错;探针 enabled 缺端口显错;确认禁用', async () => {
  mountDialog({ container: { ...makeSubContainer(), image: 'nginx' } })
  $('ced-env-section').querySelector('button[data-testid="ced-env-toggle"]').click()
  $('ced-env-add').click()
  const key0 = $('ced-env-section').querySelector('[data-testid="ced-env-key-0"]')
  const val0 = $('ced-env-section').querySelector('[data-testid="ced-env-val-0"]')
  val0.value = 'v'; val0.dispatchEvent(new Event('input'))   // 有 value 无 key → 非残行
  key0.dispatchEvent(new Event('blur'))
  expect($('ced-env-error').textContent).toContain(i18n.global.t('deploy.containerFv.envMissingKey'))
  $('ced-probes-section').querySelector('button[data-testid="ced-probes-toggle"]').click()
  $('ced-probe-enable-liveness').click()
  expect($('ced-liveness-error').textContent).toContain(i18n.global.t('deploy.containerFv.probePortRequired', { probe: 'liveness' }))
  expect($('ced-confirm-btn').disabled).toBe(true)
})
```

(containerPort 输入为 `v-model` 字符串——payload 断言按 `'9090'` 字符串,buildSpec 时才 Number 化。)

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/components/common/__tests__/ContainerEditorDialog.test.js`
Expected: 新 3 例 FAIL(节/开关/字段不存在);存量 6 例 PASS

- [ ] **Step 3: 实现组件改造**

script 部分改动:

```js
import { makeSubContainer, advancedCount } from '@/logic/subContainer'
// props 增加:
  namespace: { type: String, default: '' },
// draft 初始化改为全字段模型(容器对象可能仍是旧 8 字段——兼容混入):
const draft = ref({ ...makeSubContainer(), ...props.container })
watch(() => props.modelValue, open => {
  if (open) { draft.value = { ...makeSubContainer(), ...props.container }; touched.value = {} }
})
// 折叠节状态(默认收起):
const openSect = ref({ env: false, ports: false, probes: false, lifecycle: false, security: false })
const advCount = computed(() => advancedCount(draft.value))
// 显示用:探针键数组
const PROBES = ['liveness', 'readiness', 'startup']
function addEnvRow(list) { draft.value[list].push(list === 'envVars' ? { key: '', value: '' } : list === 'envCMKeys' ? { name: '', cmName: '', key: '' } : { name: '', secretName: '', key: '' }) }
function addPortRow() { draft.value.ports.push({ containerPort: '', protocol: 'TCP' }) }
```

模板:在「资源」节之后追加五个折叠节(结构统一:节标题 + 折叠按钮 + `v-show` 内容;此处给出 env 与 ports 节完整代码,probes/lifecycle/security 节按同样模式,字段与键名按下表):

```html
      <!-- 环境(折叠) -->
      <section data-testid="ced-env-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionEnv') }}</h4>
          <button type="button" data-testid="ced-env-toggle" @click="openSect.env = !openSect.env" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.env ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.env" class="flex flex-col gap-sm mt-sm">
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.envDirectGroup') }}</span>
            <button type="button" data-testid="ced-env-add" @click="addEnvRow('envVars')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envVars" :key="'ev'+i" class="grid grid-cols-2 gap-sm">
            <input :data-testid="'ced-env-key-'+i" v-model="e.key" @blur="markTouched('env')" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.envKeyPh')" />
            <input :data-testid="'ced-env-val-'+i" v-model="e.value" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.envValPh')" />
          </div>
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.fromConfigMap') }}</span>
            <button type="button" @click="addEnvRow('envCMKeys')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envCMKeys" :key="'cm'+i" class="flex gap-sm">
            <input :data-testid="'ced-envcm-name-'+i" v-model="e.name" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono" :placeholder="t('deploy.ced.envNamePh')" />
            <EnvSourceField kind="configmap" :namespace="namespace" class="flex-1" v-model:name="e.cmName" v-model:dataKey="e.key" />
          </div>
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.fromSecret') }}</span>
            <button type="button" @click="addEnvRow('envSecretKeys')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envSecretKeys" :key="'sk'+i" class="flex gap-sm">
            <input :data-testid="'ced-envsk-name-'+i" v-model="e.name" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono" :placeholder="t('deploy.ced.envNamePh')" />
            <EnvSourceField kind="secret" :namespace="namespace" class="flex-1" v-model:name="e.secretName" v-model:dataKey="e.key" />
          </div>
          <div class="grid grid-cols-2 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.envFromCmLabel') }}</label>
              <input v-model="draft.envFromConfigMap" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.envFromSecretLabel') }}</label>
              <input v-model="draft.envFromSecret" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
          </div>
          <p v-if="showErr('env')" data-testid="ced-env-error" class="text-xs text-error">{{ t(showErr('env').msgKey, showErr('env').params) }}</p>
        </div>
      </section>

      <!-- 端口(折叠) -->
      <section data-testid="ced-ports-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionPorts') }}</h4>
          <button type="button" data-testid="ced-ports-toggle" @click="openSect.ports = !openSect.ports" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.ports ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.ports" class="flex flex-col gap-sm mt-sm">
          <button type="button" data-testid="ced-ports-add" @click="addPortRow" class="self-start text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addPortRow') }}</button>
          <div v-for="(p, i) in draft.ports" :key="'pt'+i" class="grid grid-cols-2 gap-sm">
            <input :data-testid="'ced-port-'+i" v-model="p.containerPort" @blur="markTouched('ports')" type="number" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.portNumberPh')" />
            <select v-model="p.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono">
              <option>TCP</option><option>UDP</option><option>SCTP</option>
            </select>
          </div>
          <p v-if="showErr('ports')" data-testid="ced-ports-error" class="text-xs text-error">{{ t(showErr('ports').msgKey, showErr('ports').params) }}</p>
        </div>
      </section>
```

probes / lifecycle / security 三节完整模板(紧随 ports 节之后):

```html
      <!-- 探针(折叠;三探针各一块) -->
      <section data-testid="ced-probes-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionProbes') }}</h4>
          <button type="button" data-testid="ced-probes-toggle" @click="openSect.probes = !openSect.probes" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.probes ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.probes" class="flex flex-col gap-md mt-sm">
          <div v-for="pk in PROBES" :key="pk" class="border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
            <div class="flex items-center gap-sm">
              <label class="flex items-center gap-xs cursor-pointer">
                <input type="checkbox" :data-testid="'ced-probe-enable-' + pk" v-model="draft[pk].enabled" class="h-4 w-4 accent-primary" />
                <span class="text-xs font-semibold">{{ pk }}</span>
              </label>
              <select v-model="draft[pk].type" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono">
                <option value="http">{{ t('deploy.ced.probeTypeHttp') }}</option>
                <option value="tcp">{{ t('deploy.ced.probeTypeTcp') }}</option>
                <option value="exec">{{ t('deploy.ced.probeTypeExec') }}</option>
              </select>
            </div>
            <div v-if="draft[pk].enabled" class="flex flex-col gap-xs">
              <div v-if="draft[pk].type === 'http'" class="grid grid-cols-2 gap-sm">
                <input v-model="draft[pk].httpPath" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.httpPath')" />
                <input v-model="draft[pk].port" type="number" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.port')" />
              </div>
              <div v-else-if="draft[pk].type === 'tcp'">
                <input v-model="draft[pk].port" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.port')" />
              </div>
              <div v-else>
                <input v-model="draft[pk].execCommand" @blur="markTouched(pk)" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.execCommand')" />
              </div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-xs">
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.initialDelay') }}</label><input v-model.number="draft[pk].initialDelaySeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.period') }}</label><input v-model.number="draft[pk].periodSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.timeoutSeconds') }}</label><input v-model.number="draft[pk].timeoutSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.failureThreshold') }}</label><input v-model.number="draft[pk].failureThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.successThreshold') }}</label><input v-model.number="draft[pk].successThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
              </div>
            </div>
            <p v-if="showErr(pk)" :data-testid="'ced-' + pk + '-error'" class="text-xs text-error">{{ t(showErr(pk).msgKey, showErr(pk).params) }}</p>
          </div>
        </div>
      </section>

      <!-- 生命周期(折叠) -->
      <section data-testid="ced-lifecycle-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionLifecycle') }}</h4>
          <button type="button" data-testid="ced-lifecycle-toggle" @click="openSect.lifecycle = !openSect.lifecycle" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.lifecycle ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.lifecycle" class="grid grid-cols-1 md:grid-cols-2 gap-sm mt-sm">
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.postStart') }}</label>
            <input v-model="draft.lifecycle.postStart" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="echo started" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.preStop') }}</label>
            <input v-model="draft.lifecycle.preStop" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="echo stopping" /></div>
        </div>
      </section>

      <!-- 安全上下文(折叠) -->
      <section data-testid="ced-security-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionSecurity') }}</h4>
          <button type="button" data-testid="ced-security-toggle" @click="openSect.security = !openSect.security" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.security ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.security" class="flex flex-col gap-sm mt-sm">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" v-model="draft.securityContext.enabled" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.enableSecurityContext') }}</span>
          </label>
          <div v-if="draft.securityContext.enabled" class="grid grid-cols-2 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.runAsUser') }}</label>
              <input v-model="draft.securityContext.runAsUser" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.runAsGroup') }}</label>
              <input v-model="draft.securityContext.runAsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <label class="flex items-center gap-sm col-span-2 cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.privileged" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.privileged') }}</span>
            </label>
            <label class="flex items-center gap-sm cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.runAsNonPrivileged" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.runAsNonRoot') }}</span>
            </label>
            <label class="flex items-center gap-sm cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.readOnlyRootFilesystem" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.readOnlyRootFilesystem') }}</span>
            </label>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.addCapabilities') }}</label>
              <input v-model="draft.securityContext.addCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="NET_ADMIN" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.dropCapabilities') }}</label>
              <input v-model="draft.securityContext.dropCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="ALL" /></div>
          </div>
        </div>
      </section>
```

原生 sidecar 开关(sidecar 且显示,放在「基本信息」节 name/image 之后):

```html
        <div v-if="kind === 'sidecar'" class="flex flex-col gap-xs">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" data-testid="ced-native-toggle" v-model="draft.nativeSidecar" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.ced.nativeSidecar') }}</span>
          </label>
          <p v-if="draft.nativeSidecar" class="text-xs text-on-surface-variant">{{ t('deploy.ced.nativeSidecarHint') }}</p>
        </div>
```

基本信息节内追加三行(在 image 之后):workingDir 输入(deploy.workingDir)、pullPolicy select(`''`/IfNotPresent/Always/Never,空选项 label「—」)、stdin/tty 复选(ced.stdinLabel + deploy.ttyLabel)。标题旁计数:`<span v-if="advCount" class="text-xs text-on-surface-variant">{{ t('deploy.ced.advancedBadge', { n: advCount }) }}</span>` 置于 Modal 标题下第一行。

- [ ] **Step 4: 确认通过 + 全量组件测试**

Run: `npx vitest run src/components/common/__tests__/ContainerEditorDialog.test.js`
Expected: 存量 6 + 新 3 全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/common/ContainerEditorDialog.vue src/components/common/__tests__/ContainerEditorDialog.test.js
git commit -m "feat(deploy): 容器弹窗泛化全字段(五折叠节+原生 sidecar 开关+namespace)"
```

---

### Task 7: DeployApp 接线(卡片 badge + 默认值 + 空行判定换源)

**Files:**
- Modify: `src/views/DeployApp.vue`
- Modify: `src/views/__tests__/DeployApp.container-editor.test.js`(追加)

**Interfaces:**
- Consumes: Task 1 `makeSubContainer/advancedCount/isSubContainerEmpty`;Task 6 组件新 prop `namespace`
- Produces: 卡片头部 badge(`ced-advanced-badge` testid,计数>0 显示,点击开弹窗);`validate()` 空行判定换 `isSubContainerEmpty`;`add*` 默认值 = `makeSubContainer()`;弹窗传 `:namespace="form.namespace"`

- [ ] **Step 1: 追加失败测试**

`DeployApp.container-editor.test.js` 末尾(顶部 import 加 `import { makeSubContainer } from '@/logic/subContainer'`):

```js
test('卡片高级 badge:高级字段有值才显示且计数正确;点 badge 开弹窗', async () => {
  const w = mountApp()
  await flushPromises()
  // currentStep 是根级状态(容器 grid 在步骤 2 v-if 渲染),与 form 平级传
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app',
    initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox', envVars: [{ key: 'K', value: 'V' }], tty: true }] } })
  await flushPromises()
  const badge = w.find('[data-testid="ced-advanced-badge"]')
  expect(badge.exists()).toBe(true)
  expect(badge.text()).toContain('2')
  await badge.trigger('click')
  expect(w.findComponent(ContainerEditorDialog).props('container')).toMatchObject({ name: 'i0' })
  expect(w.findComponent(ContainerEditorDialog).props('namespace')).toBe(w.vm.form.namespace)
})

test('validate:4 基础字段空但 env 有值的行不再被当空行跳过', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app', image: 'nginx',
    initContainers: [{ ...makeSubContainer(), envVars: [{ key: '', value: 'v' }] }] } })
  await flushPromises()
  const errs = w.vm.validate()
  expect(errs.some(e => e.step === 1 && e.msg.includes(i18n.global.t('deploy.containerFv.envMissingKey')))).toBe(true)
  // 全默认行仍是空行,不报子容器错误
  await w.setData({ form: { ...w.vm.form, initContainers: [makeSubContainer()] } })
  await flushPromises()
  expect(w.vm.validate().filter(e => e.step === 1 && e.msg.includes(i18n.global.t('deploy.initContainers')))).toEqual([])
})
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/views/__tests__/DeployApp.container-editor.test.js`
Expected: 新 2 例 FAIL

- [ ] **Step 3: 实现**

(a) imports 加 `makeSubContainer, advancedCount, isSubContainerEmpty`(来自 `@/logic/subContainer`)。

(b) `addExtraContainer/addInitContainer` 两行替换:

```js
function addExtraContainer() { form.value.extraContainers.push(makeSubContainer()) }
function addInitContainer() { form.value.initContainers.push(makeSubContainer()) }
```

(c) `validate()` 的 `pushContainerErrs` 内,`if (isEmptyEnvRow(c, ['name', 'image', 'command', 'args'])) return` 换成 `if (isSubContainerEmpty(c)) return`。

(d) 弹窗挂载处加 `:namespace="form.namespace"`。

(e) 两卡片头部行(容器 #N 徽标之后、最大化按钮之前)插入 badge:

```html
                  <button v-if="advancedCount(c)" type="button" data-testid="ced-advanced-badge" @click="openContainerEditor('init', idx)"
                    class="px-xs py-0.5 rounded-full bg-secondary-container/40 text-on-surface-variant text-xs hover:bg-secondary-container/70 transition-colors"
                    :title="$t('deploy.editContainerExpand')">
                    {{ $t('deploy.ced.advancedBadge', { n: advancedCount(c) }) }}
                  </button>
```

(sidecar 卡片同款,`openContainerEditor('sidecar', idx)`;头部行 class 由 `flex items-center justify-between` 调整为 `flex items-center gap-sm justify-between`。)

(f) `makeForm()` 的 `extraContainers: []`/`initContainers: []` 保持数组空(默认值在 add 时给);`resetForm` 不变。

- [ ] **Step 4: 确认通过 + 存量**

Run: `npx vitest run src/views/__tests__/ && npm run test:server`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.container-editor.test.js
git commit -m "feat(deploy): 卡片高级 badge+子容器默认值/空行判定单源化"
```

---

### Task 8: NsWorkloadDetail 壳测试先行(锁定现状)

**Files:**
- Create: `src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`

**Interfaces:**
- Consumes: 无(纯锁定现状)
- Produces: 可复用的 mountDetail() 骨架(Task 9/10 测试沿用);锁定断言:编辑 Modal 可开、init/sidecar 行内小表单渲染行、旧键名存在

- [ ] **Step 1: 写测试(直接跑,期望 PASS——这是锁定现状的壳)**

```js
// NsWorkloadDetail 编辑面壳测试(该视图此前零测试):锁定「编辑 Modal 可开 + 子容器行内表单渲染」
// 现状,供 Task 9/10 模型迁移与模板手术的回归网。mock 策略与 DeployApp 系测试一致
// (mock @/api/client 与 @/stores/cluster,真实 i18n + Vue Query)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', setNamespace: () => {}, fetchWorkloads: vi.fn(async () => []) }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: true, Breadcrumbs: true } } })
}

test('视图可挂载(壳)', async () => {
  const w = mountDetail()
  await flushPromises()
  expect(w.exists()).toBe(true)
  w.unmount()
})

test('编辑 Modal 打开后 init/sidecar 行内表单渲染已有行(锁定现状)', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.setData({
    editForm: {
      ...w.vm.editForm,
      initContainers: [{ name: 'i0', image: 'busybox', command: '', args: '', cpuReq: '', cpuLim: '', memReq: '', memLim: '' }],
      extraContainers: [],
    },
    showEditModal: true,
  })
  await flushPromises()
  expect(w.vm.editForm.initContainers[0].name).toBe('i0')
  w.unmount()
})
```

**适配协议**:若挂载因未 mock 的依赖报错(如 useMetricsHistory/useDeployFastPoll 内部再 import 的模块),按报错逐个补 `vi.mock`(工厂返回最小桩,保持与上面风格一致),并在提交信息外的测试文件头注释里列出补 mock 清单。禁止为实现而修改 NsWorkloadDetail.vue 本体;若某个依赖实在无法桩化(如全局副作用),报 BLOCKED 带报错栈,勿硬绕。

- [ ] **Step 2: 跑通**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`
Expected: PASS(壳+锁定)

- [ ] **Step 3: 提交**

```bash
git add src/views/__tests__/NsWorkloadDetail.edit-shell.test.js
git commit -m "test(workload): NsWorkloadDetail 编辑面壳测试先行(锁定子容器现状)"
```

---

### Task 9: NsWorkloadDetail 模型迁移(单源+键名+校验+nullAbsent)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(imports/openEdit/saveEdit/校验/删本地旧函数)
- Modify: `src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`(追加)

**Interfaces:**
- Consumes: Task 1/2 `makeSubContainer/mapSubContainer/buildSubContainerSpec/mountsForTarget`;Task 3 `validateContainerFields`;Task 4 键
- Produces: editForm 子容器键名 = 全字段模型;saveEdit 重建走 buildSubContainerSpec(nullAbsent);编辑校验接入单源;旧 `containerToForm`(子容器用途)/`buildSubContainer` 删除

- [ ] **Step 1: 追加失败测试**

`NsWorkloadDetail.edit-shell.test.js` 顶部改造:文件级捕获桩 + import:

```js
const captured = vi.hoisted(() => [])
// vi.mock('@/stores/cluster') 工厂内补:updateWorkload: (name, ns, updates) => captured.push(updates)
import { makeSubContainer } from '@/logic/subContainer'
function capturedSpec() { return captured.at(-1)?.spec || captured.at(-1) }
```

末尾追加用例:

```js
test('saveEdit 重建:普通 sidecar 进 containers,原生进 initContainers 尾部(带 Always),挂载按原索引', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.setData({
    editForm: {
      ...w.vm.editForm,
      initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox' }],
      extraContainers: [
        { ...makeSubContainer(), name: 'plain', image: 'nginx' },
        { ...makeSubContainer(), name: 'native', image: 'envoy', nativeSidecar: true },
      ],
      volumeMounts: [
        { name: 'v1', target: 'sidecar:0', type: 'pvc', mountPath: '/a', subPath: '', readOnly: false, pvcName: 'p1', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
        { name: 'v2', target: 'sidecar:1', type: 'pvc', mountPath: '/b', subPath: '', readOnly: false, pvcName: 'p2', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
        { name: 'v3', target: 'init:0', type: 'pvc', mountPath: '/c', subPath: '', readOnly: false, pvcName: 'p3', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
      ],
    },
  })
  await flushPromises()
  await w.vm.saveEdit()
  await flushPromises()
  const spec = capturedSpec()
  const pod = spec.template?.spec || spec
  expect(pod.containers.map(c => c.name)).toEqual([pod.containers[0].name, 'plain'])
  expect(pod.initContainers.map(c => c.name)).toEqual(['i0', 'native'])
  expect(pod.initContainers.map(c => c.restartPolicy)).toEqual([null, 'Always'])
  expect(pod.containers.find(c => c.name === 'plain').volumeMounts).toEqual([{ name: 'v1', mountPath: '/a' }])
  expect(pod.initContainers.find(c => c.name === 'native').volumeMounts).toEqual([{ name: 'v2', mountPath: '/b' }])
  expect(pod.initContainers.find(c => c.name === 'i0').volumeMounts).toEqual([{ name: 'v3', mountPath: '/c' }])
})
```

注意:saveEdit 依赖 editForm 的主容器字段(imageRepo 等)——`...w.vm.editForm` 展开的空对象可能让 saveEdit 提前 return 或抛错;若如此,给 editForm 补最小主容器字段(`imageRepo: 'nginx', imageTag: 'latest', cpuReq: '', cpuLim: '', memReq: '', memLim: '', env: [], envCMKeys: [], envSecretKeys: [], ports: [], volumeMounts 同上, labels: {}, strategy: 'RollingUpdate'` 等,以 saveEdit 实际读取为准),并把「captured 捕获到的 updates 形状」用一次临时 `console.log(JSON.stringify(Object.keys(captured.at(-1))))` 核对后落定 capturedSpec 的取值路径(预期 updateWorkload 第三参 updates 含 spec/template 键)。若 saveEdit 里还有非 store 的通知/路由副作用,在 mock 层吸收。

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`
Expected: 新用例 FAIL(旧 buildSubContainer 无 native/全字段行为)

- [ ] **Step 3: 实现 NsWorkloadDetail 迁移**

(a) imports 加:

```js
import { makeSubContainer, mapSubContainer, buildSubContainerSpec, mountsForTarget } from '@/logic/subContainer'
import { validateContainerFields } from '@/logic/containerValidation'
```

(b) `openEdit` 组装处替换两行(mapSubContainer 单源 + 原生 sidecar 分流;Task 10 模板手术前行内模板仍读旧键,故过渡期同时挂旧键别名,Task 10 (d) 删除):

```js
    // 子容器全量反解(单源);原生 sidecar(restartPolicy Always)归 extraContainers。
    // 过渡兼容:Task 10 前行内模板仍读 cpuReq 系旧键——同时挂别名,Task 10 (d) 删。
    const withLegacyKeys = c => ({ ...c, cpuReq: c.cpuRequest, cpuLim: c.cpuLimit, memReq: c.memoryRequest, memLim: c.memoryLimit })
    initContainers: (tplSpec.initContainers || []).filter(c => c.restartPolicy !== 'Always').map(c => withLegacyKeys(mapSubContainer(c))),
    extraContainers: [
      ...(tplSpec.containers || []).slice(1).map(c => withLegacyKeys(mapSubContainer(c))),
      ...(tplSpec.initContainers || []).filter(c => c.restartPolicy === 'Always').map(c => withLegacyKeys(mapSubContainer(c))),
    ],
```

(withLegacyKeys 定义放 openEdit 函数体内、editForm 组装之前。)

(c) 删除本地 `containerToForm` 与 `buildSubContainer` 两函数(先 grep 确认无其他调用点);`buildResources`/`buildProbe`/`mountObjs` 若仅剩主容器调用点则保留原样。

(d) `saveEdit` 重建段替换(spec.containers/spec.initContainers 三行):

```js
      // 多容器重建(单源 buildSubContainerSpec;nullAbsent=true 走 merge-patch 删除语义):
      // 普通 sidecar 进 containers;原生 sidecar(sidecar 且 nativeSidecar)进 initContainers 尾部;
      // 挂载 target 按「原数组索引」定位(native 行占用 extraContainers 索引,不可按过滤后序枚举)。
      const sidecars = f.extraContainers || []
      spec.containers = [c0, ...sidecars.map((c, idx) => (!c.image || c.nativeSidecar) ? null :
        buildSubContainerSpec(c, { mounts: mountsForTarget(f.volumeMounts, `sidecar:${idx}`), nullAbsent: true })).filter(Boolean)]
      const rebuiltInits = [
        ...(f.initContainers || []).map((c, idx) => c.image ?
          buildSubContainerSpec(c, { mounts: mountsForTarget(f.volumeMounts, `init:${idx}`), nullAbsent: true }) : null),
        ...sidecars.map((c, idx) => (c.image && c.nativeSidecar) ?
          buildSubContainerSpec(c, { mounts: mountsForTarget(f.volumeMounts, `sidecar:${idx}`), nullAbsent: true }) : null),
      ].filter(Boolean)
      spec.initContainers = rebuiltInits.length ? rebuiltInits : null
```

(e) 编辑校验两条替换(workload.validation.initMissingImage/sidecarMissingImage 两行删,换;`f` 是 editForm,主容器名取 workload):

```js
  // 子容器校验接入单源(containerValidation);空行判定沿用「image 空即跳过」的旧宽语义?
  // 否——统一 isSubContainerEmpty:仅配了高级字段的行也须校验(与创建面一致)。
  const mainName = workload.value?.name || ''
  const subOthers = (kind, selfIdx) => {
    const initNames = (f.initContainers || []).map(c => c.name).filter(Boolean)
    const sideNames = (f.extraContainers || []).map(c => c.name).filter(Boolean)
    const out = mainName ? [mainName] : []
    if (kind === 'init') out.push(...initNames.filter((_, i) => i !== selfIdx), ...sideNames)
    else out.push(...initNames, ...sideNames.filter((_, i) => i !== selfIdx))
    return out
  }
  const pushSubErrs = (list, kind, labelKey) => list.forEach((c, i) => {
    if (isSubContainerEmpty(c)) return
    for (const e of validateContainerFields(c, subOthers(kind, i)))
      errs.push(`${t(labelKey)} ${c.name || '#' + (i + 1)}: ${t(e.msgKey, e.params)}`)
  })
  pushSubErrs(f.initContainers || [], 'init', 'workload.edit.initContainers')
  pushSubErrs(f.extraContainers || [], 'sidecar', 'workload.edit.sidecarContainers')
```

(imports 同时加 `isSubContainerEmpty`。)`workload.edit.initContainers/sidecarContainers` 键已存在(行内表单标题用)。

(g) 退役键删除:先 `grep -rn "initMissingImage\|sidecarMissingImage" src/` 确认仅剩 NsWorkloadDetail 这两行与 en/zh 的 `workload.validation` 段;然后从 `src/locales/en.json` 与 `src/locales/zh.json` 的 workload.validation 对象中各删 `"initMissingImage"` 与 `"sidecarMissingImage"` 两键(同段其余键保留),跑 `npm run i18n:check` 验证。

(f) 键名核查:`grep -n "cpuReq\|cpuLim\|memReq\|memLim" src/views/NsWorkloadDetail.vue`——本 task 结束时,子容器**模板绑定**仍读旧键(经 (b) 的过渡别名显示正常),但 **saveEdit/校验路径只读新键**;主容器字段的 cpuReq 系(editForm.cpuReq 等)不在本次范围,原样保留。

- [ ] **Step 4: 确认通过**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js && npm run test:server && npx vitest run src/views/__tests__/`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.edit-shell.test.js
git commit -m "refactor(workload): 编辑面子容器模型迁移单源(nullAbsent+原生 sidecar 归位+校验接入)"
```

---

### Task 10: NsWorkloadDetail 模板手术(卡片+badge+弹窗)+ 收尾

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(模板:两块行内小表单换卡片+badge+弹窗;删过渡兼容层)
- Modify: `src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`(追加)

**Interfaces:**
- Consumes: Task 6 泛化弹窗(含 namespace prop);Task 7 同款卡片结构
- Produces: 编辑面 init/sidecar 与创建面同构;`workload.edit.initContainers/sidecarContainers/addInit/addSidecar` 键保留复用

- [ ] **Step 1: 追加失败测试**

文件顶部加挂载变体 B(不 stub Modal——编辑 Modal 的插槽内容必须真实渲染;Teleport 均落 document.body,与 ContainerEditorDialog 测试同法断言):

```js
function mountDetailB() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}
const $$ = sel => document.body.querySelector(sel)
```

末尾追加:

```js
test('编辑面子容器卡片:badge + 点开共享弹窗(嵌套于编辑 Modal 之上)', async () => {
  const w = mountDetailB()
  await flushPromises()
  await w.setData({
    editForm: { ...w.vm.editForm,
      initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox', envVars: [{ key: 'K', value: 'V' }] }] },
    showEditModal: true,
  })
  await flushPromises()
  const badge = document.body.querySelector('[data-testid="ced-advanced-badge"]')
  expect(badge).toBeTruthy()
  expect(badge.textContent).toContain('1')
  badge.click()
  await flushPromises()
  expect($$('[data-testid="ced-name-input"]').value).toBe('i0')       // 共享弹窗回显(在编辑 Modal 之上)
  // 确认写回同槽:
  const nameInput = $$('[data-testid="ced-name-input"]')
  nameInput.value = 'renamed'; nameInput.dispatchEvent(new Event('input'))
  $$('[data-testid="ced-confirm-btn"]').click()
  await flushPromises()
  expect(w.vm.editForm.initContainers[0].name).toBe('renamed')
  expect(w.vm.editForm.initContainers[0].envVars[0].key).toBe('K')    // 未写回字段不丢
  w.unmount(); document.body.innerHTML = ''
})
```

- [ ] **Step 2: 确认失败/现状**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`

- [ ] **Step 3: 实现模板手术**

(a) script 加编辑弹窗状态(与 DeployApp 同款,namespace 取 `route.params.namespace`):

```js
const editing = ref(null)
const editingListKey = computed(() => (editing.value?.kind === 'sidecar' ? 'extraContainers' : 'initContainers'))
const editingContainer = computed(() => (editing.value ? editForm.value[editingListKey.value][editing.value.index] : {}))
const editingOtherNames = computed(() => {
  const f = editForm.value, cur = editing.value
  if (!cur) return []
  const names = []
  const main = workload.value?.name
  if (main) names.push(main)
  ;(f.initContainers || []).forEach((c, i) => { if (c.name && !(cur.kind === 'init' && i === cur.index)) names.push(c.name) })
  ;(f.extraContainers || []).forEach((c, i) => { if (c.name && !(cur.kind === 'sidecar' && i === cur.index)) names.push(c.name) })
  return names
})
function openContainerEditor(kind, index) { editing.value = { kind, index } }
function onContainerEdited(payload) {
  if (!editing.value) return
  Object.assign(editForm.value[editingListKey.value][editing.value.index], payload)
  editing.value = null
}
```

(顶部 `import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'`、`import { advancedCount, makeSubContainer } from '@/logic/subContainer'`、`import { advancedCount as _ac } ...` 不需要——直接 advancedCount。)

(b) 模板:两块 `v-for` 行内小表单各替换为 DeployApp 同款结构(头部行 + 8 字段格 + 移除按钮 + add 按钮 push `makeSubContainer()`),头部行:

```html
          <div v-for="(c, idx) in editForm.initContainers" :key="'ic'+idx" class="border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
            <div class="flex items-center gap-sm justify-between mb-xs">
              <div class="flex items-center gap-sm">
                <span class="text-xs text-on-surface-variant font-mono">#{{ idx + 1 }}</span>
                <button v-if="advancedCount(c)" type="button" data-testid="ced-advanced-badge" @click="openContainerEditor('init', idx)"
                  class="px-xs py-0.5 rounded-full bg-secondary-container/40 text-on-surface-variant text-xs hover:bg-secondary-container/70">
                  {{ $t('deploy.ced.advancedBadge', { n: advancedCount(c) }) }}
                </button>
              </div>
              <button type="button" data-testid="init-expand-btn" :title="$t('deploy.editContainerExpand')" :aria-label="$t('deploy.editContainerExpand')"
                @click="openContainerEditor('init', idx)" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
                <span class="material-symbols-outlined text-base">open_in_full</span>
              </button>
            </div>
            <!-- 8 字段格(与创建面卡片同构,新键名绑定) -->
            <div class="grid grid-cols-2 gap-xs mb-xs">
              <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono" :placeholder="$t('workload.edit.namePlaceholder')" />
              <input v-model="c.image" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono" :placeholder="$t('workload.edit.imagePlaceholder')" />
            </div>
            <div class="grid grid-cols-2 gap-xs mb-xs">
              <input v-model="c.command" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono" placeholder="sh -c" />
              <textarea v-model="c.args" rows="2" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono resize-y" :placeholder="$t('deploy.argsHint')" />
            </div>
            <div class="grid grid-cols-2 gap-xs">
              <ResourceInput v-model="c.cpuRequest" kind="cpu" placeholder="cpu req" />
              <ResourceInput v-model="c.cpuLimit" kind="cpu" placeholder="cpu lim" />
              <ResourceInput v-model="c.memoryRequest" kind="memory" placeholder="mem req" />
              <ResourceInput v-model="c.memoryLimit" kind="memory" placeholder="mem lim" />
            </div>
            <button @click="editForm.initContainers.splice(idx, 1)" class="mt-xs self-start text-xs text-error hover:underline">{{ $t('deploy.removeContainer') }}</button>
          </div>
```

(sidecar 块:v-for 改 `editForm.extraContainers`、`'ec'+idx`;头部两个按钮改 `openContainerEditor('sidecar', idx)` 与 `data-testid="sidecar-expand-btn"`;移除按钮 `editForm.extraContainers.splice(idx, 1)`;8 字段格与上面完全相同,无 kind 相关差异。两区块的 add 按钮分别:`@click="editForm.initContainers.push(makeSubContainer())"` 与 `@click="editForm.extraContainers.push(makeSubContainer())"`,label 复用既有 `workload.edit.addInit`/`workload.edit.addSidecar`。)

(c) 视图根部(编辑 Modal 同级之后)挂弹窗:

```html
  <ContainerEditorDialog v-if="editing" :model-value="true" :container="editingContainer"
    :kind="editing.kind" :index="editing.index" :other-names="editingOtherNames" :namespace="String(route.params.namespace || '')"
    @update:model-value="editing = null" @confirm="onContainerEdited" />
```

嵌套说明:编辑 Modal 与弹窗同用 `Z.modal`,两者都 Teleport 到 body,弹窗后挂载 → DOM 序靠后 → 目于编辑 Modal 之上;ESC 经 useEscClose 栈只关栈顶 ✓。

(d) 删除 Task 9 的过渡兼容层(openEdit 处的 cpuReq 系挂载)。

(e) 全文 grep `cpuReq|cpuLim|memReq|memLim`:仅允许**主容器**字段(editForm.cpuReq 等主容器区)残留——子容器路径必须为零。

- [ ] **Step 4: 确认通过 + 全量门禁**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`,然后收尾全量:

```bash
npm run test:server && npm run test:unit && npm run typecheck && npm run i18n:check && npm run build
```

Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.edit-shell.test.js
git commit -m "feat(workload): 编辑面子容器换卡片+badge+共享弹窗(键名迁移收尾)"
```

---

## 收尾(全部 Task 完成后)

- [ ] `npm run test && npm run typecheck && npm run i18n:check && npm run build` 全绿
- [ ] grep 复核:子容器路径零 `cpuReq` 残留;`containerToForm`/`buildSubContainer`(旧)已删
- [ ] 手测清单转交用户:①创建向导子容器配 env/探针→YAML 预览含全字段 ②复制带高级字段的 workload→回填不丢 ③原生 sidecar 开关→YAML 归 initContainers+Always ④编辑面卡片 badge+弹窗(嵌套 Modal 之上)⑤编辑保存 merge-patch 删字段生效(nullAbsent)⑥探针/env 校验拦截
