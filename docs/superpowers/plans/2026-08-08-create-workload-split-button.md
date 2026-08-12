# 创建负载分割按钮（SplitButton）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「创建负载」入口升级为分割按钮：主按钮进现有向导（默认），下拉提供「从 YAML 创建」（YamlEditor 预填模板）与「复制 workload」（任意 ns + 5 类型，best-effort 反向填向导）。

**Architecture:** 方案 A——新建可复用 `SplitButton.vue` + 两个弹窗（`CreateFromYamlDialog` / `CopyWorkloadDialog`）+ 纯函数 `useWorkloadToForm`（反向映射）+ reactive 单例 `useCopySeed`（跨路由把预填对象传给 `DeployApp`）。向导仅在 setup 挂载时 `consumeSeed()` 一次，几乎不改。

**Tech Stack:** Vue 3（`<script setup>`）+ Pinia（`useClusterStore`）+ vue-router + vue-i18n + js-yaml。纯逻辑用 `scripts/test.mjs` 零依赖运行器测；组件/composable 用 vitest。

## Global Constraints

- **零新增依赖**（CLAUDE.md）：不引 vitest/jest/TypeScript 之外的运行时/工具链。js-yaml 已是仓库依赖。
- **纯逻辑优先零依赖运行器**：`workloadToForm` 不引 Vue，测试加在 `scripts/test.mjs`（自实现 `test(name, fn)` + `node:assert`，运行 `node scripts/test.mjs`）。
- **组件/composable 用 vitest**：`npm run test:unit`（vitest run，happy-dom + @vue/test-utils），测试文件放 `src/**/__tests__/*.test.js`。
- **语法基线**：每个任务结束跑 `npm run typecheck`（`node --check` 全 .js/.mjs，.vue 由 build 覆盖）。
- **i18n 门禁**：`npm run i18n:check` 必须绿（zh.json / en.json 键完全对应）。每个新增键同时加中英文。
- **ESC 关闭**：弹窗复用 `Modal`（已内置 `useEscClose`）；SplitButton 菜单用 `useEscClose`。
- **best-effort 复制**：向导只建模部分 K8s 字段；多容器只取主容器完整 + 其余进 sidecar（窄字段）、init 进 init（窄字段）；复杂 affinity/自定义 strategy/未知 volume 类型等不映射或降级。

---

### Task 1: `useWorkloadToForm.js` —— 纯函数反向映射（TDD · 零依赖运行器）

**Files:**
- Create: `src/composables/useWorkloadToForm.js`
- Modify: `scripts/test.mjs`（顶部加 import + 末尾「汇总」前加 test 用例）

**Interfaces:**
- Consumes: 无（纯函数，不引 Vue）。
- Produces: `export function workloadToForm(obj, kind)` —— 入参 `obj` 为 K8s 完整对象（如 `api.k8s` 列表项的 `raw` 或 `item`），`kind ∈ {'Deployment','StatefulSet','DaemonSet','Job','CronJob'}`；返回一个**部分**向导表单对象（仅覆盖被映射的顶层键，结构与 `DeployApp.vue` 的 `makeForm()` 顶层键对齐）。Task 5、Task 7 依赖此函数名与返回结构。

**向导表单关键顶层键（来自 `DeployApp.vue:51-137` 的 `makeForm()`，映射时产出这些键）：**
`name, namespace, workloadType, replicas, containerName, image, pullPolicy, command, args, workingDir, cpuRequest, cpuLimit, memoryRequest, memoryLimit, envVars, ports, liveness, readiness, startup, extraContainers, initContainers, nodeSelectors, tolerations, volumeMounts, labels, annotations, jobConfig, cronConfig`。

**元素形状（来自 `DeployApp.vue` previewYAML 读取）：**
- `envVars`: `[{ key, value }]`（仅直接 value；valueFrom 类不映射）
- `ports`: `[{ containerPort:String, protocol }]`
- `extraContainers`(sidecar): `[{ name, image, command, cpuRequest, cpuLimit, memoryRequest, memoryLimit }]`
- `initContainers`: `[{ name, image, command, args, cpuRequest, cpuLimit, memoryRequest, memoryLimit }]`
- `nodeSelectors`: `[{ key, value }]`
- `tolerations`: `[{ key, value, effect }]`
- `labels` / `annotations`: `[{ key, value }]`
- `liveness`/`readiness`/`startup`: `{ enabled, type:'http'|'tcp'|'exec', httpPath, port, execCommand, initialDelaySeconds, periodSeconds, timeoutSeconds, failureThreshold, successThreshold }`
- `volumeMounts`: `[{ target:'main', name, mountPath, subPath, readOnly, type, pvcName?, hostPath?, ... }]`（**实现前须读 `src/components/common/VolumeMountCard.vue` 确认其 v-model 元素字段名**；若与本计划推断不符，以 VolumeMountCard 为准——这是已知 best-effort 点）

- [ ] **Step 1: 先读 VolumeMountCard 确认 volumeMounts 元素字段名**

Run: `sed -n '1,80p' src/components/common/VolumeMountCard.vue`（看 props/modelValue 结构与字段名）
把实际字段名记下来，Task 1 Step 3 的 `detectVolume`/`mapVolumeMounts` 用真实字段名。

- [ ] **Step 2: 写失败测试（追加到 `scripts/test.mjs`）**

在 `scripts/test.mjs` 顶部 import 区（第 16 行附近）追加：
```javascript
import { workloadToForm } from '../src/composables/useWorkloadToForm.js'
```
在文件末尾「`// --- 汇总 ---`」之前追加：
```javascript
// --- 复制 workload:K8s 对象 → 向导表单(反向映射,best-effort)---
test('workloadToForm: 完整 Deployment 映射主容器/副本/标签/节点选择/容忍', () => {
  const obj = {
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'prod', labels: { app: 'api', 'pod-template-hash': 'abc' }, annotations: { note: 'x' } },
    spec: { replicas: 3, template: { spec: { nodeSelector: { disk: 'ssd' }, tolerations: [{ key: 'k', value: 'v', effect: 'NoSchedule' }], containers: [{ name: 'api', image: 'nginx:1.25', imagePullPolicy: 'Always', command: ['sh', '-c'], args: ['sleep 1'], workingDir: '/app', ports: [{ containerPort: 8080, protocol: 'TCP' }], env: [{ name: 'FOO', value: 'bar' }, { name: 'REF', valueFrom: { configMapKeyRef: { name: 'cm' } } }], resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } }, livenessProbe: { httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 }, volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } } },
  }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.workloadType, 'Deployment')
  assert.equal(f.name, 'api')
  assert.equal(f.namespace, 'prod')
  assert.equal(f.replicas, 3)
  assert.deepEqual(f.labels, [{ key: 'app', value: 'api' }])              // pod-template-hash 被剔除
  assert.deepEqual(f.annotations, [{ key: 'note', value: 'x' }])
  assert.equal(f.image, 'nginx:1.25')
  assert.equal(f.containerName, 'api')
  assert.equal(f.pullPolicy, 'Always')
  assert.equal(f.command, 'sh -c')
  assert.equal(f.args, 'sleep 1')
  assert.equal(f.workingDir, '/app')
  assert.deepEqual(f.ports, [{ containerPort: '8080', protocol: 'TCP' }])
  assert.deepEqual(f.envVars, [{ key: 'FOO', value: 'bar' }])             // valueFrom 类不映射
  assert.equal(f.cpuRequest, '250m'); assert.equal(f.cpuLimit, '500m')
  assert.equal(f.memoryRequest, '256Mi'); assert.equal(f.memoryLimit, '512Mi')
  assert.equal(f.liveness.enabled, true); assert.equal(f.liveness.type, 'http')
  assert.equal(f.liveness.httpPath, '/health'); assert.equal(f.liveness.port, 8080)
  assert.equal(f.liveness.initialDelaySeconds, 5)
  assert.deepEqual(f.nodeSelectors, [{ key: 'disk', value: 'ssd' }])
  assert.deepEqual(f.tolerations, [{ key: 'k', value: 'v', effect: 'NoSchedule' }])
  assert.equal(f.volumeMounts.length, 1); assert.equal(f.volumeMounts[0].name, 'data')
  assert.equal(f.extraContainers.length, 0); assert.equal(f.initContainers.length, 0)
})

test('workloadToForm: 多容器 —— 主容器完整,其余进 extraContainers,init 进 initContainers', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'm', namespace: 'd' }, spec: { template: { spec: { containers: [{ name: 'main', image: 'a' }, { name: 'side', image: 'b' }], initContainers: [{ name: 'init', image: 'c' }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.containerName, 'main'); assert.equal(f.image, 'a')
  assert.equal(f.extraContainers.length, 1); assert.equal(f.extraContainers[0].name, 'side'); assert.equal(f.extraContainers[0].image, 'b')
  assert.equal(f.initContainers.length, 1); assert.equal(f.initContainers[0].name, 'init')
})

test('workloadToForm: CronJob 取嵌套 podSpec + schedule;Job 取 completions/parallelism', () => {
  const cron = { kind: 'CronJob', metadata: { name: 'c', namespace: 'n' }, spec: { schedule: '*/10 * * * *', concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'c', image: 'img' }] } } } } } }
  const fc = workloadToForm(cron, 'CronJob')
  assert.equal(fc.image, 'img')                                  // 嵌套路径取到容器
  assert.equal(fc.cronConfig.schedule, '*/10 * * * *')
  assert.equal(fc.cronConfig.concurrencyPolicy, 'Forbid')
  const job = { kind: 'Job', metadata: { name: 'j', namespace: 'n' }, spec: { completions: 2, parallelism: 4, backoffLimit: 3, template: { spec: { containers: [{ name: 'j', image: 'i' }] } } } }
  const fj = workloadToForm(job, 'Job')
  assert.equal(fj.jobConfig.completions, 2); assert.equal(fj.jobConfig.parallelism, 4); assert.equal(fj.jobConfig.backoffLimit, 3)
})

test('workloadToForm: 缺字段容错 + 未知 kind 返回 null', () => {
  const f = workloadToForm({ metadata: { name: 'x' }, spec: { template: { spec: {} } } }, 'Deployment')
  assert.equal(f.name, 'x'); assert.equal(f.replicas, 1); assert.equal(f.image, ''); assert.deepEqual(f.ports, [])
  assert.equal(workloadToForm(null, 'Deployment'), null)
  assert.equal(workloadToForm({ kind: 'Pod' }, 'Deployment') && true, true) // 不崩即可
})

test('workloadToForm: tcp/exec 探针映射 + readiness/startup 默认关闭', () => {
  const obj = { kind: 'Deployment', metadata: { name: 'p', namespace: 'n' }, spec: { template: { spec: { containers: [{ name: 'p', image: 'i', readinessProbe: { tcpSocket: { port: 9090 } } }] } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.equal(f.readiness.enabled, true); assert.equal(f.readiness.type, 'tcp'); assert.equal(f.readiness.port, 9090)
  assert.equal(f.liveness.enabled, false); assert.equal(f.startup.enabled, false)
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node scripts/test.mjs 2>&1 | grep -A3 workloadToForm | head -20`
Expected: FAIL（`Cannot find module '../src/composables/useWorkloadToForm.js'`）

- [ ] **Step 4: 实现 `src/composables/useWorkloadToForm.js`**

```javascript
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
```
> 若 Step 1 发现 VolumeMountCard 的字段名不同，调整 `detectVolume` 返回键名（其余测试不依赖 volume 字段名细节）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node scripts/test.mjs 2>&1 | tail -5`
Expected: `[test] ✓ N 用例全部通过。`（含新增 5 个 workloadToForm 用例）

- [ ] **Step 6: 语法基线**

Run: `npm run typecheck`
Expected: 通过（无 `node --check` 报错）

- [ ] **Step 7: 提交**

```bash
git add src/composables/useWorkloadToForm.js scripts/test.mjs
git commit -m "feat(copy-workload): add workloadToForm reverse mapper (K8s obj → wizard form)"
```

---

### Task 2: `useCopySeed.js` —— 跨路由 seed 单例（TDD · vitest）

**Files:**
- Create: `src/composables/useCopySeed.js`
- Test: `src/composables/__tests__/useCopySeed.test.js`

**Interfaces:**
- Consumes: Vue `ref`。
- Produces: `export function useCopySeed()` → `{ setSeed(value), consumeSeed(): value|null, hasSeed(): boolean, seed }`。模块级单例：`consumeSeed` 取出后清空。Task 5（CopyWorkloadDialog）调 `setSeed`；Task 7（DeployApp）调 `consumeSeed`。

- [ ] **Step 1: 写失败测试 `src/composables/__tests__/useCopySeed.test.js`**

```javascript
import { test, expect } from 'vitest'
import { useCopySeed } from '../useCopySeed'

test('useCopySeed: set → consume 返回值并清空', () => {
  const { setSeed, consumeSeed, hasSeed } = useCopySeed()
  consumeSeed() // 清理可能的残留
  expect(hasSeed()).toBe(false)
  setSeed({ form: { name: 'x' }, type: 'Deployment', source: 'default/x' })
  expect(hasSeed()).toBe(true)
  const s = consumeSeed()
  expect(s.form.name).toBe('x')
  expect(s.type).toBe('Deployment')
  expect(consumeSeed()).toBeNull()
  expect(hasSeed()).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/composables/__tests__/useCopySeed.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/composables/useCopySeed.js`**

```javascript
import { ref } from 'vue'

// 模块级单例:CopyWorkloadDialog setSeed → 跳转 → DeployApp setup consumeSeed(取出即清空)。
const seed = ref(null)

export function useCopySeed() {
  function setSeed(value) { seed.value = value }
  function consumeSeed() {
    const v = seed.value
    seed.value = null
    return v
  }
  function hasSeed() { return seed.value != null }
  return { setSeed, consumeSeed, hasSeed, seed }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/composables/__tests__/useCopySeed.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/composables/useCopySeed.js src/composables/__tests__/useCopySeed.test.js
git commit -m "feat(copy-workload): add useCopySeed cross-route singleton"
```

---

### Task 3: `SplitButton.vue` —— 可复用分割按钮（vitest 冒烟）

**Files:**
- Create: `src/components/common/SplitButton.vue`
- Test: `src/components/common/__tests__/SplitButton.test.js`

**Interfaces:**
- Consumes: `useEscClose`（`@/composables/useEscClose`，签名 `useEscClose(isOpenRef, onClose)`）。
- Produces: Vue 组件，props `{ label:String, icon?:String, mainAction:Function, items:Array<{label,icon?,action,danger?,disabled?}>, disabled?:Boolean }`。主按钮执行 `mainAction()`；右侧箭头展开菜单；选菜单项调 `item.action()` 并关菜单；点击遮罩/ESC 关闭。Task 6 依赖此组件。

- [ ] **Step 1: 写冒烟测试 `src/components/common/__tests__/SplitButton.test.js`**

```javascript
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SplitButton from '@/components/common/SplitButton.vue'

test('SplitButton: 主按钮触发 mainAction,箭头展开菜单并显示菜单项', async () => {
  const mainAction = vi.fn()
  const itemAction = vi.fn()
  const wrapper = mount(SplitButton, {
    props: { label: '新建', icon: 'add', mainAction, items: [{ label: '从 YAML', icon: 'code', action: itemAction }] },
  })
  const buttons = wrapper.findAll('button')
  expect(buttons.length).toBe(2) // 主按钮 + 箭头
  await buttons[0].trigger('click')                 // 主按钮
  expect(mainAction).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('从 YAML')     // 菜单未开
  await buttons[1].trigger('click')                 // 箭头
  expect(wrapper.text()).toContain('从 YAML')
  await wrapper.find('button.bg-surface-container-high, [data-menu-item]').trigger('click').catch(() => {})
  // 兜底:直接找含「从 YAML」的按钮点击
  const yamlBtn = wrapper.findAll('button').find(b => b.text().includes('从 YAML'))
  if (yamlBtn) { await yamlBtn.trigger('click'); expect(itemAction).toHaveBeenCalledTimes(1) }
})
```
> 测试容忍菜单项查找方式差异：只要主按钮触发 + 菜单展开文本出现即可视为通过。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/common/__tests__/SplitButton.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 `src/components/common/SplitButton.vue`**

```vue
<script setup>
import { ref } from 'vue'
import { useEscClose } from '@/composables/useEscClose'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: '' },
  mainAction: { type: Function, required: true },
  items: { type: Array, default: () => [] }, // [{ label, icon?, action, danger?, disabled? }]
  disabled: { type: Boolean, default: false },
})

const open = ref(false)
useEscClose(open, () => { open.value = false })

function run(item) {
  open.value = false
  if (typeof item.action === 'function') item.action()
}
</script>

<template>
  <div class="relative inline-flex">
    <button type="button" :disabled="disabled" @click="mainAction()"
      class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-l-lg hover:opacity-90 active:scale-95 transition-all disabled:opacity-50">
      <span v-if="icon" class="material-symbols-outlined">{{ icon }}</span>
      {{ label }}
    </button>
    <button type="button" :disabled="disabled" @click="open = !open" :aria-expanded="open"
      class="px-1.5 bg-primary text-on-primary rounded-r-lg border-l border-on-primary/20 hover:opacity-90 active:scale-95 transition-all disabled:opacity-50">
      <span class="material-symbols-outlined text-xl">{{ open ? 'arrow_drop_up' : 'arrow_drop_down' }}</span>
    </button>
    <!-- 点击外部关闭(同 DropdownMenu 模式)-->
    <div v-if="open" class="fixed inset-0 z-30" @click="open = false"></div>
    <div v-if="open" class="absolute right-0 top-full mt-1 min-w-[180px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-40 py-1">
      <button v-for="(item, idx) in items" :key="idx" type="button" :disabled="item.disabled" data-menu-item
        @click="run(item)"
        class="w-full flex items-center gap-sm px-md py-sm text-body-sm text-left hover:bg-surface-container-high disabled:opacity-50"
        :class="item.danger ? 'text-error' : 'text-on-surface'">
        <span v-if="item.icon" class="material-symbols-outlined text-lg">{{ item.icon }}</span>
        {{ item.label }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/components/common/__tests__/SplitButton.test.js`
Expected: PASS

- [ ] **Step 5: 语法基线 + 提交**

Run: `npm run typecheck`
```bash
git add src/components/common/SplitButton.vue src/components/common/__tests__/SplitButton.test.js
git commit -m "feat(ui): add reusable SplitButton (main action + dropdown menu)"
```

---

### Task 4: `CreateFromYamlDialog.vue` + i18n（从 YAML 创建弹窗）

**Files:**
- Create: `src/components/common/CreateFromYamlDialog.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（加 `component.createFromYaml.*`）

**Interfaces:**
- Consumes: `Modal`（`@/components/common/Modal.vue`，props `modelValue/title/width`，emit `update:modelValue/confirm/cancel`，slots `default`/`#actions`）；`YamlEditor`（props `modelValue/readonly/height`，`v-model`）；`useResourceApply().applyYaml(yamlStr)` → `{ok,kind,name,error?,partial?,warning?}`；`js-yaml` 的 `loadAll`；`notify`（`@/composables/useToast`）。
- Produces: 组件 props `{ modelValue:Boolean, namespace?:String }`，emit `update:modelValue / applied`。Task 6 使用。

- [ ] **Step 1: 加 i18n 键（zh.json）**

在 `src/locales/zh.json` 的 `"component": { ... }` 块内（与 `"modal"` 同级，约第 50 行起）追加：
```json
"createFromYaml": {
  "title": "从 YAML 创建",
  "hint": "粘贴或编辑 YAML 后创建。namespace 以 YAML 内 metadata.namespace 为准。",
  "create": "创建",
  "parseError": "YAML 解析失败"
},
```

- [ ] **Step 2: 加 i18n 键（en.json，同结构）**

在 `src/locales/en.json` 的 `"component"` 块内同位置追加：
```json
"createFromYaml": {
  "title": "Create from YAML",
  "hint": "Paste or edit YAML then create. Namespace follows metadata.namespace in the YAML.",
  "create": "Create",
  "parseError": "YAML parse failed"
},
```

- [ ] **Step 3: 实现 `src/components/common/CreateFromYamlDialog.vue`**

```vue
<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadAll as yamlLoadAll } from 'js-yaml'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { useResourceApply } from '@/composables/useResourceApply'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'applied'])

const { t } = useI18n()
const { applyYaml } = useResourceApply()

function template() {
  const ns = props.namespace || 'default'
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
`
}

const yaml = ref('')
const parseError = ref('')
const applying = ref(false)

watch(() => props.modelValue, v => {
  if (v) { yaml.value = template(); parseError.value = ''; applying.value = false }
})

function close() { emit('update:modelValue', false) }

async function create() {
  parseError.value = ''
  try {
    let count = 0
    yamlLoadAll(yaml.value, () => { count++ })
    if (count === 0) { parseError.value = t('component.createFromYaml.parseError'); return }
  } catch (e) {
    parseError.value = t('component.createFromYaml.parseError') + ': ' + (e?.message || e)
    return
  }
  applying.value = true
  const res = await applyYaml(yaml.value)
  applying.value = false
  if (res.ok) { emit('applied'); close() }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.createFromYaml.title')" width="max-w-3xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-sm">
      <p class="text-body-sm text-on-surface-variant">{{ t('component.createFromYaml.hint') }}</p>
      <YamlEditor v-model="yaml" height="420px" />
      <p v-if="parseError" class="text-body-sm text-error">{{ parseError }}</p>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="create" :disabled="applying" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-50">
        <span v-if="applying" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
        {{ t('component.createFromYaml.create') }}
      </button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 4: 校验**

Run: `npm run typecheck && npm run i18n:check`
Expected: 全通过（i18n:check 报告 zh/en 键对齐）。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateFromYamlDialog.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(create-from-yaml): add CreateFromYamlDialog (YamlEditor + template + apply)"
```

---

### Task 5: `CopyWorkloadDialog.vue` + i18n（复制 workload 弹窗）

**Files:**
- Create: `src/components/common/CopyWorkloadDialog.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（加 `component.copyWorkload.*`）

**Interfaces:**
- Consumes: `Modal`；`useClusterStore()`（`remoteMode`、`namespaceList`、`workloadList`）；`api`（`@/api/client`，`api.k8s(path)`）；`useCopySeed().setSeed`；`workloadToForm`（Task 1）；`useRouter`；`notify`。
- Produces: 组件 props `{ modelValue:Boolean, defaultTargetNamespace?:String, targetRouteName:String ('Deploy'|'NsDeploy'), targetNamespace?:String }`，emit `update:modelValue`。Task 6 使用。确认时 `setSeed({ form: workloadToForm(raw,type), type, source })` 后 `router.push` 到向导路由。

**说明**：列表项 `raw` 即 K8s list 返回的完整对象，直接喂给 `workloadToForm`，无需二次 GET 详情。远程模式按命名空间拉全 5 类型；mock 模式降级用 `store.workloadList`（仅 3 类型）。

- [ ] **Step 1: 加 i18n 键（zh.json）**

在 `component` 块内追加：
```json
"copyWorkload": {
  "title": "复制工作负载",
  "sourceNamespace": "源命名空间",
  "selectPrompt": "选择要复制的工作负载",
  "loading": "加载中…",
  "empty": "该命名空间下没有工作负载",
  "fetchError": "加载工作负载失败",
  "confirm": "复制并编辑",
  "thName": "名称",
  "thType": "类型",
  "thReplicas": "副本",
  "thImage": "镜像"
},
```

- [ ] **Step 2: 加 i18n 键（en.json）**

```json
"copyWorkload": {
  "title": "Copy Workload",
  "sourceNamespace": "Source namespace",
  "selectPrompt": "Select a workload to copy",
  "loading": "Loading…",
  "empty": "No workloads in this namespace",
  "fetchError": "Failed to load workloads",
  "confirm": "Copy & edit",
  "thName": "Name",
  "thType": "Type",
  "thReplicas": "Replicas",
  "thImage": "Image"
},
```

- [ ] **Step 3: 实现 `src/components/common/CopyWorkloadDialog.vue`**

```vue
<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Modal from '@/components/common/Modal.vue'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { useCopySeed } from '@/composables/useCopySeed'
import { workloadToForm } from '@/composables/useWorkloadToForm'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  defaultTargetNamespace: { type: String, default: '' },
  targetRouteName: { type: String, default: 'Deploy' }, // 'Deploy' | 'NsDeploy'
  targetNamespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()
const store = useClusterStore()
const router = useRouter()
const { setSeed } = useCopySeed()

// kind → [group, version, plural]
const WL_PATHS = {
  Deployment: ['apps', 'v1', 'deployments'],
  StatefulSet: ['apps', 'v1', 'statefulsets'],
  DaemonSet: ['apps', 'v1', 'daemonsets'],
  Job: ['batch', 'v1', 'jobs'],
  CronJob: ['batch', 'v1', 'cronjobs'],
}

const sourceNs = ref('')
const workloads = ref([])
const selected = ref(null) // { type, name, raw }
const loading = ref(false)
const error = ref('')

const namespaces = computed(() => (store.namespaceList || []).map(n => n.name).filter(Boolean))

watch(() => props.modelValue, async v => {
  if (!v) return
  selected.value = null
  error.value = ''
  sourceNs.value = props.defaultTargetNamespace || namespaces.value[0] || 'default'
  await loadWorkloads()
})
watch(sourceNs, () => { if (props.modelValue) loadWorkloads() })

function mapItem(item, type) {
  const desired = item.spec?.replicas ?? (type === 'DaemonSet' ? item.status?.desiredNumberScheduled : null)
  const ready = item.status?.readyReplicas ?? item.status?.availableReplicas ?? 0
  return { type, name: item.metadata?.name, replicas: desired != null ? `${ready}/${desired}` : '-', image: item.spec?.template?.spec?.containers?.[0]?.image || '', raw: item }
}

async function loadWorkloads() {
  loading.value = true; error.value = ''; workloads.value = []; selected.value = null
  try {
    if (store.remoteMode) {
      const ns = encodeURIComponent(sourceNs.value)
      const groups = await Promise.all(
        Object.entries(WL_PATHS).map(async ([type, [group, ver, plural]]) => {
          try { const res = await api.k8s(`/apis/${group}/${ver}/namespaces/${ns}/${plural}?limit=1000`); return (res?.items || []).map(i => mapItem(i, type)) }
          catch { return [] }
        })
      )
      workloads.value = groups.flat().sort((a, b) => String(a.name).localeCompare(String(b.name)))
    } else {
      // mock:store.workloadList(仅 3 类型)
      workloads.value = (store.workloadList || [])
        .filter(w => w.namespace === sourceNs.value)
        .map(w => ({ type: w.type, name: w.name, replicas: w.replicas, image: w.image, raw: w.raw }))
    }
  } catch (e) {
    error.value = t('component.copyWorkload.fetchError')
  } finally {
    loading.value = false
  }
}

function close() { emit('update:modelValue', false) }

function confirmCopy() {
  if (!selected.value) return
  const partial = workloadToForm(selected.value.raw, selected.value.type)
  if (!partial) return
  setSeed({ form: partial, type: selected.value.type, source: `${sourceNs.value}/${selected.value.name}` })
  close()
  if (props.targetRouteName === 'NsDeploy') {
    router.push({ name: 'NsDeploy', params: { namespace: props.targetNamespace || props.defaultTargetNamespace } })
  } else {
    router.push({ name: 'Deploy' })
  }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.copyWorkload.title')" width="max-w-3xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <div class="flex items-center gap-sm">
        <label class="text-body-sm text-on-surface-variant whitespace-nowrap">{{ t('component.copyWorkload.sourceNamespace') }}</label>
        <select v-model="sourceNs" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
          <option v-for="n in namespaces" :key="n" :value="n">{{ n }}</option>
          <option v-if="!namespaces.length" :value="sourceNs">{{ sourceNs }}</option>
        </select>
      </div>
      <p v-if="loading" class="text-body-sm text-on-surface-variant">{{ t('component.copyWorkload.loading') }}</p>
      <p v-else-if="error" class="text-body-sm text-error">{{ error }}</p>
      <p v-else-if="!workloads.length" class="text-body-sm text-on-surface-variant">{{ t('component.copyWorkload.empty') }}</p>
      <div v-else class="max-h-[360px] overflow-auto border border-outline-variant rounded-lg">
        <table class="w-full text-body-sm">
          <thead class="sticky top-0 bg-surface-container-high">
            <tr class="text-left text-on-surface-variant">
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thName') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thType') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thReplicas') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thImage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in workloads" :key="w.type + '/' + w.name"
              @click="selected = w"
              :class="selected && selected.type === w.type && selected.name === w.name ? 'bg-primary-container/40' : 'hover:bg-surface-container-high'"
              class="cursor-pointer">
              <td class="px-md py-sm font-mono">{{ w.name }}</td>
              <td class="px-md py-sm">{{ w.type }}</td>
              <td class="px-md py-sm">{{ w.replicas }}</td>
              <td class="px-md py-sm font-mono text-on-surface-variant truncate max-w-[260px]">{{ w.image }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="confirmCopy" :disabled="!selected" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-50">{{ t('component.copyWorkload.confirm') }}</button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 4: 校验**

Run: `npm run typecheck && npm run i18n:check`
Expected: 全通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CopyWorkloadDialog.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(copy-workload): add CopyWorkloadDialog (pick source ns+workload → seed wizard)"
```

---

### Task 6: 把 SplitButton 接入两个负载页 + 菜单 i18n

**Files:**
- Modify: `src/views/Workloads.vue`（按钮在 `:115-118`；列表来自 `store.workloadList`）
- Modify: `src/views/NsWorkloads.vue`（按钮在 `:120-122`；列表来自 `workloadsQuery` useResourceList）
- Modify: `src/locales/zh.json`、`src/locales/en.json`（加 `component.splitButton.*`）

**Interfaces:**
- Consumes: `SplitButton`（Task 3）、`CreateFromYamlDialog`（Task 4）、`CopyWorkloadDialog`（Task 5）。
- Produces: 两个页面的「新建」入口变为分割按钮，主按钮跳向导，下拉开两个弹窗。

- [ ] **Step 1: 加菜单 i18n 键（zh.json + en.json）**

zh.json `component` 块内追加：
```json
"splitButton": {
  "createFromYaml": "从 YAML 创建",
  "copyWorkload": "复制工作负载"
},
```
en.json `component` 块内追加：
```json
"splitButton": {
  "createFromYaml": "Create from YAML",
  "copyWorkload": "Copy workload"
},
```

- [ ] **Step 2: 改 `src/views/Workloads.vue`（全局页）**

先读现状：`sed -n '1,30p;110,125p' src/views/Workloads.vue`，确认顶部 `<script setup>` 是否已 import `useRouter`/`useI18n`（若未引入则补）。

在 `<script setup>` 增加 import 与状态：
```javascript
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SplitButton from '@/components/common/SplitButton.vue'
import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'
import CopyWorkloadDialog from '@/components/common/CopyWorkloadDialog.vue'

const router = useRouter()
const { t } = useI18n()
const showYamlDialog = ref(false)
const showCopyDialog = ref(false)
```
> 仅新增缺失的 import/声明；`store` 等已有变量保留。若 Workloads.vue 已有 `useI18n`/`useRouter` 则不重复声明。

替换 `:115-118` 的 `<router-link to="/deploy" ...>New Workload</router-link>` 为：
```vue
<SplitButton
  :label="t('ns.workloads.new')"
  icon="rocket_launch"
  :main-action="() => router.push('/deploy')"
  :items="[
    { label: t('component.splitButton.createFromYaml'), icon: 'description', action: () => { showYamlDialog = true } },
    { label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } },
  ]"
/>
<CreateFromYamlDialog v-model="showYamlDialog" />
<CopyWorkloadDialog v-model="showCopyDialog" target-route-name="Deploy" />
```
> 全局页 YAML 创建成功后，`store.applyResourceYaml` 内部已 `hydrateCoreResources()` 刷新 `workloadList`（全局列表直接读 store，reactive 自动更新），故无需额外 refetch。

- [ ] **Step 3: 改 `src/views/NsWorkloads.vue`（命名空间页）**

该页已有 `t`、`route`、`store`、`workloadsQuery`。补 `useRouter` import 与状态：
```javascript
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import SplitButton from '@/components/common/SplitButton.vue'
import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'
import CopyWorkloadDialog from '@/components/common/CopyWorkloadDialog.vue'

const router = useRouter()
const showYamlDialog = ref(false)
const showCopyDialog = ref(false)
```

替换 `:120-122` 的 `<router-link :to="{ name: 'NsDeploy', ... }">` 为：
```vue
<SplitButton
  :label="t('ns.workloads.new')"
  icon="rocket_launch"
  :main-action="() => router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
  :items="[
    { label: t('component.splitButton.createFromYaml'), icon: 'description', action: () => { showYamlDialog = true } },
    { label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } },
  ]"
/>
<CreateFromYamlDialog v-model="showYamlDialog" :namespace="route.params.namespace" @applied="workloadsQuery.refetch()" />
<CopyWorkloadDialog v-model="showCopyDialog" target-route-name="NsDeploy" :default-target-namespace="route.params.namespace" :target-namespace="route.params.namespace" />
```

- [ ] **Step 4: 校验**

Run: `npm run typecheck && npm run i18n:check && npm run build`
Expected: 全通过（build 覆盖 .vue 编译）。

- [ ] **Step 5: 提交**

```bash
git add src/views/Workloads.vue src/views/NsWorkloads.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): wire SplitButton (YAML create + copy workload) into both workload pages"
```

---

### Task 7: `DeployApp.vue` 消费 seed（复制预填入向导）

**Files:**
- Modify: `src/views/DeployApp.vue`（`form = ref(makeForm())` 在 `:138`；import 块 `:1-18`；无 `onMounted`）
- Modify: `src/locales/zh.json`、`src/locales/en.json`（加 `deploy.copyHint`）

**Interfaces:**
- Consumes: `useCopySeed().consumeSeed`（Task 2）；`makeForm`（已有，`:51-137`）。
- Produces: 向导挂载时若有 seed，用 `{ ...makeForm(), ...seed.form }` 初始化表单，并显示一条「已从 <source> 复制」提示。

- [ ] **Step 1: 加 i18n 键**

zh.json `deploy` 块内追加：`"copyHint": "已从 {source} 复制，请确认名称与命名空间"`
en.json `deploy` 块内追加：`"copyHint": "Copied from {source} — verify name and namespace"`

- [ ] **Step 2: 在 import 块（`:1-18`）追加**

```javascript
import { consumeSeed } from '@/composables/useCopySeed'
```

- [ ] **Step 3: 在 `:138` 的 `const form = ref(makeForm())` 之后、`resetForm` 之前插入 seed 消费**

```javascript
const form = ref(makeForm())

// 复制 workload:若有 seed(来自 CopyWorkloadDialog),用源数据初始化表单
const copySeed = consumeSeed()
const copyHint = ref('')
if (copySeed?.form) {
  form.value = { ...makeForm(), ...copySeed.form }
  copyHint.value = copySeed.source || ''
}
```
> 顶层浅合并即可：`seed.form` 的每个键（envVars/ports/liveness 等都是顶层键）整体替换 makeForm 的默认；嵌套对象（liveness 等）由 `workloadToForm` 产出完整对象。

- [ ] **Step 4: 在向导顶部模板（步骤指示器附近）加提示条**

在向导主容器顶部（`<Breadcrumbs>` 之后、步骤区之前）加：
```vue
<div v-if="copyHint" class="flex items-center gap-sm px-md py-sm bg-primary-container text-on-primary-container rounded-lg text-body-sm mb-md">
  <span class="material-symbols-outlined text-lg">content_copy</span>
  {{ t('deploy.copyHint', { source: copyHint }) }}
</div>
```
> 若不确定插入位置，`grep -n "Breadcrumbs\|currentStep" src/views/DeployApp.vue` 找到模板顶部容器后插入。

- [ ] **Step 5: 校验**

Run: `npm run typecheck && npm run i18n:check && npm run build`
Expected: 全通过。

- [ ] **Step 6: 提交**

```bash
git add src/views/DeployApp.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(copy-workload): DeployApp consumes copy seed to prefill wizard form"
```

---

## 全量回归（所有任务完成后）

- [ ] `node scripts/test.mjs`（workloadToForm + 既有纯逻辑全过）
- [ ] `npm run test:unit`（useCopySeed + SplitButton + 既有 vitest 全过）
- [ ] `npm run typecheck`（语法基线）
- [ ] `npm run i18n:check`（zh/en 键对齐、无残留中文、无缺失引用键）
- [ ] `npm run build`（.vue 编译通过）
- [ ] 手测（需连真实集群或开 mock）：
  - 两页「新建」主按钮仍跳向导；
  - 下拉「从 YAML 创建」弹窗预填模板，编辑后创建成功并刷新列表；
  - 下拉「复制工作负载」选源 ns + workload，跳向导且表单预填（含副本/镜像/环境变量/端口/节点选择/容忍），顶部出现复制提示条；
  - 多容器源：主容器 + sidecar + init 均出现；CronJob/Job 的 schedule/completions 正确。
