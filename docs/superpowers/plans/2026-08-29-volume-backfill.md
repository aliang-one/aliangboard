# 复制回填保真(volume-backfill)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复制/编辑回填保真:卷回填收敛为共享纯函数 `volumeBackfill.js`,补 items/hostPathType/defaultMode 解析与多容器挂载,未知卷类型原样透传,native sidecar 归位。

**Architecture:** 新建零依赖纯函数模块 `src/logic/volumeBackfill.js`(`splitContainers` + `backfillVolumes`,后者为 NsWorkloadDetail.mergeVolumes 的上提增强版);编辑面与复制面两个入口同源;'unknown' 表单类型全链(卡片锁定提示 / toVolumeDef clone(raw) / DeployApp yamlDump 透传)。spec:`docs/superpowers/specs/2026-08-29-volume-backfill-design.md`。

**Tech Stack:** Vue 3 `<script setup>`、vitest(happy-dom)、node:test(`scripts/test.mjs`,workloadToForm 测试主场)、js-yaml(已有依赖,仅 DeployApp 序列化 raw 用)。

## Global Constraints

- **不新增任何外部依赖**(js-yaml 已在 dependencies)。
- **提交作者 `aliangone <aliangone@gmail.com>`,禁止 Co-Authored-By 尾注**。
- **回填保真是不可协商目标**:已知 6 类卷解析 items/hostPathType/defaultMode;unknown 卷 raw 透传;编辑面行为保持(mergeVolumes 上提不改语义,除 unknown 行从「降级 emptyDir」变为「原样透传」)。
- **octalOf 语义**(Task 10 既有):`m == null ? '' : Number(m).toString(8).padStart(4, '0')`。
- 结构化克隆**禁用 `structuredClone`**(entry.raw 可能是 Vue reactive 代理,会抛 DataCloneError)——用 `JSON.parse(JSON.stringify(...))`(K8s spec 是 JSON 源,安全)。
- i18n zh/en 同步;`npm run i18n:check` 全绿。
- 回归四件套:`npm test`(642 全绿基线)+ `npm run test:unit`(1484 passed 基线)+ `npm run typecheck` + `npm run i18n:check`。
- 行号为 2026-08-29 快照,以内容定位为准。

---

### Task 1: `src/logic/volumeBackfill.js` 纯函数模块

**Files:**
- Create: `src/logic/volumeBackfill.js`
- Test: `src/logic/__tests__/volumeBackfill.test.js`(新建)

**Interfaces:**
- Produces(后续任务依赖,签名固定):
  - `splitContainers(podSpec) → { mainContainer, plainSidecars, plainInits, nativeSidecars }`(native = initContainers 中 `restartPolicy === 'Always'`)
  - `backfillVolumes(podSpec) → [行]`;行形状 `{ name, target, type, raw, mountPath, subPath, readOnly, pvcName, hostPath, hostPathType, server, nfsPath, cmName, secretName, defaultMode, items }`
- 逻辑来源:NsWorkloadDetail.vue `mergeVolumes`(872-906)逐字上提 + 三处增强(unknown/raw;其余 Task 10 已在 mergeVolumes 里)。

- [ ] **Step 1: 写失败测试**

```js
// src/logic/__tests__/volumeBackfill.test.js
// 卷回填单源:编辑面(mergeVolumes 上提)与复制面(useWorkloadToForm)共用(spec 2026-08-29 §3.1)
import { test, expect } from 'vitest'
import { splitContainers, backfillVolumes } from '@/logic/volumeBackfill'

const projected = { name: 'proj-1', projected: { sources: [{ configMap: { name: 'cm' } }] } }

test('splitContainers: native sidecar(Always init)归位到 plain sidecar 之外', () => {
  const pod = { containers: [{ name: 'main' }, { name: 'side-a' }], initContainers: [{ name: 'init-a' }, { name: 'nat', restartPolicy: 'Always' }] }
  const s = splitContainers(pod)
  expect(s.mainContainer.name).toBe('main')
  expect(s.plainInits.map(c => c.name)).toEqual(['init-a'])
  expect(s.plainSidecars.map(c => c.name)).toEqual(['side-a'])
  expect(s.nativeSidecars.map(c => c.name)).toEqual(['nat'])
})

test('backfillVolumes: 多容器 target 对齐(native 占 sidecar:plain 数 + 序)', () => {
  const pod = {
    containers: [{ name: 'main', volumeMounts: [{ name: 'v-main', mountPath: '/m' }] }, { name: 'side-a', volumeMounts: [{ name: 'v-side', mountPath: '/s' }] }],
    initContainers: [{ name: 'init-a', volumeMounts: [{ name: 'v-init', mountPath: '/i' }] }, { name: 'nat', restartPolicy: 'Always', volumeMounts: [{ name: 'v-nat', mountPath: '/n' }] }],
    volumes: [{ name: 'v-main', emptyDir: {} }, { name: 'v-side', emptyDir: {} }, { name: 'v-init', emptyDir: {} }, { name: 'v-nat', emptyDir: {} }],
  }
  const rows = backfillVolumes(pod)
  const byMount = Object.fromEntries(rows.map(r => [r.mountPath, r.target]))
  expect(byMount['/m']).toBe('main')
  expect(byMount['/i']).toBe('init:0')
  expect(byMount['/s']).toBe('sidecar:0')
  expect(byMount['/n']).toBe('sidecar:1') // plain 1 个 → native 从 1 起
})

test('backfillVolumes: 解析 items/hostPathType/defaultMode(int→八进制串)', () => {
  const pod = {
    containers: [{ volumeMounts: [{ name: 'cm-v', mountPath: '/c' }, { name: 'hp-v', mountPath: '/h' }, { name: 'sec-v', mountPath: '/s' }] }],
    volumes: [
      { name: 'cm-v', configMap: { name: 'cm1', items: [{ key: 'a', path: 'conf/a.yml' }], defaultMode: 420 } },
      { name: 'hp-v', hostPath: { path: '/h', type: 'Directory' } },
      { name: 'sec-v', secret: { secretName: 's1', defaultMode: 256 } },
    ],
  }
  const rows = backfillVolumes(pod)
  const cm = rows.find(r => r.name === 'cm-v')
  expect(cm.items).toEqual([{ key: 'a', path: 'conf/a.yml' }])
  expect(cm.defaultMode).toBe('0640')
  expect(rows.find(r => r.name === 'hp-v').hostPathType).toBe('Directory')
  expect(rows.find(r => r.name === 'sec-v').defaultMode).toBe('0400')
})

test('backfillVolumes: 未知卷类型 → unknown + raw 原样透传;不降级 emptyDir', () => {
  const pod = { containers: [{ volumeMounts: [{ name: 'proj-1', mountPath: '/p' }] }], volumes: [projected] }
  const rows = backfillVolumes(pod)
  expect(rows[0].type).toBe('unknown')
  expect(rows[0].raw).toEqual(projected)
  expect(rows[0].raw).not.toBe(projected) // 行持有独立副本(非同引用)
  // 卷名未注册的 mount 回退 emptyDir(不是 unknown——raw 为 null 无从透传)
  const orphan = backfillVolumes({ containers: [{ volumeMounts: [{ name: 'ghost', mountPath: '/g' }] }] })
  expect(orphan[0].type).toBe('emptyDir')
})

test('backfillVolumes: 只定义未挂载的卷 → main 占位行', () => {
  const rows = backfillVolumes({ containers: [{}], volumes: [{ name: 'idle', emptyDir: {} }] })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ name: 'idle', target: 'main', mountPath: '' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeBackfill.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**(新文件;逻辑来自 NsWorkloadDetail.vue:872-906 mergeVolumes 的上提,注意三处与旧版的显式差异)

```js
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
  else { d.type = 'unknown'; d.raw = vol }
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
```

与旧 mergeVolumes 的显式差异(其余逐字):①`raw` 字段 + unknown 分支;②`raw: d.raw` 进行;③占位行复用 `rowOf`。旧版 `detectVolume` 分支顺序(pvc→hostPath→nfs→configMap→secret→emptyDir)保持。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/volumeBackfill.test.js`
Expected: PASS(5 组)。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeBackfill.js src/logic/__tests__/volumeBackfill.test.js
git commit -m "feat(backfill): volumeBackfill 单源——splitContainers/backfillVolumes,unknown 卷原样透传"
```

---

### Task 2: NsWorkloadDetail 接单源(删 mergeVolumes 手抄)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(872-906 mergeVolumes 删除;988 调用点;import;孤儿 `octalOf` 清理)

**Interfaces:**
- Consumes: Task 1 `backfillVolumes`。
- 行为保持:除「unknown 行不再降级 emptyDir」外逐字等价。

- [ ] **Step 1: 接线**

1. import 区加 `import { backfillVolumes } from '@/logic/volumeBackfill'`。
2. 872-906 整个 `mergeVolumes` 函数删除;988 行 `volumeMounts: mergeVolumes(tplSpec, c0),` → `volumeMounts: backfillVolumes(tplSpec),`。
3. `grep -n "octalOf" src/views/NsWorkloadDetail.vue`——若仅剩 mergeVolumes 曾用的定义(无其它引用)则删除该局部定义。

- [ ] **Step 2: 验证**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.edit-shell.test.js && npm run test:unit 2>&1 | tail -4 | head -3 && npm run typecheck`
Expected: 全绿(单测数与基线持平或 +0;unknown 行为变化不影响既有用例)。

- [ ] **Step 3: 提交**

```bash
git add src/views/NsWorkloadDetail.vue
git commit -m "refactor(edit): 编辑面卷回填接 volumeBackfill 单源,删除 mergeVolumes 手抄"
```

---

### Task 3: workloadToForm 接入(native 归位 + 卷全字段回填)

**Files:**
- Modify: `src/composables/useWorkloadToForm.js`(61-79 detectVolume/mapVolumeMounts 删除;105-106/114 接单源)
- Test: `scripts/test.mjs`(追加 node:test 用例——该文件是 workloadToForm 的测试主场,486/518 行既有样例)

**Interfaces:**
- Consumes: Task 1 两导出。
- Produces: `workloadToForm` 卷条目 = `backfillVolumes(pod)`(含 raw/items/hostPathType/defaultMode);initContainers 不含 native sidecar,extraContainers = plain + native(尾部)。

- [ ] **Step 1: 写失败测试**(追加到 scripts/test.mjs 既有 workloadToForm 用例之后,风格随文件:`test('...', () => { ... })` + `assert`)

```js
test('workloadToForm: native sidecar(Always init)归位到 extraContainers 尾部', () => {
  const obj = { metadata: { name: 'w', namespace: 'ns' }, spec: { template: { spec: {
    containers: [{ name: 'main', image: 'img' }, { name: 'side-a', image: 'img2' }],
    initContainers: [{ name: 'init-a', image: 'img3' }, { name: 'nat', image: 'img4', restartPolicy: 'Always' }],
  } } } }
  const f = workloadToForm(obj, 'Deployment')
  assert.deepEqual(f.initContainers.map(c => c.name), ['init-a'])
  assert.deepEqual(f.extraContainers.map(c => c.name), ['side-a', 'nat'])
  assert.equal(f.extraContainers[1].nativeSidecar, true)
})

test('workloadToForm: 卷回填走单源——items/未知卷透传/子容器挂载', () => {
  const obj = { metadata: { name: 'w', namespace: 'ns' }, spec: { template: { spec: {
    containers: [
      { name: 'main', image: 'img' },
      { name: 'side-a', image: 'img2', volumeMounts: [{ name: 'proj-1', mountPath: '/p' }] },
    ],
    volumes: [
      { name: 'cm-v', configMap: { name: 'cm1', items: [{ key: 'a', path: 'a.yml' }], defaultMode: 420 } },
      { name: 'proj-1', projected: { sources: [{ configMap: { name: 'cm' } }] } },
    ],
  } } } }
  const f = workloadToForm(obj, 'Deployment')
  const cm = f.volumeMounts.find(r => r.name === 'cm-v')
  assert.deepEqual(cm.items, [{ key: 'a', path: 'a.yml' }])
  assert.equal(cm.defaultMode, '0640')
  const proj = f.volumeMounts.find(r => r.name === 'proj-1')
  assert.equal(proj.type, 'unknown')
  assert.deepEqual(proj.raw, obj.spec.template.spec.volumes[1])
  assert.equal(proj.target, 'sidecar:0')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test 2>&1 | grep -A3 "native sidecar 归位\|卷回填走单源" | head -10`
Expected: 新 2 例 FAIL。

- [ ] **Step 3: 实现**(useWorkloadToForm.js)

```js
import { backfillVolumes, splitContainers } from '../logic/volumeBackfill.js'
```

- 删除 61-79 行的 `detectVolume` 与 `mapVolumeMounts` 两个函数。
- 105-106 行容器映射替换:

```js
  const { plainInits, plainSidecars, nativeSidecars } = splitContainers(pod)
  out.extraContainers = [...plainSidecars, ...nativeSidecars].map(mapSubContainer)
  out.initContainers = plainInits.map(mapSubContainer)
```

- 114 行 `out.volumeMounts = mapVolumeMounts(containers[0], pod.volumes)` → `out.volumeMounts = backfillVolumes(pod)`。
- 文件头注释第 3-4 行的「未知 volume 类型等不映射或降级」改为「未知 volume 类型原样透传(raw),卷回填与编辑面单源(logic/volumeBackfill)」。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npm test 2>&1 | tail -3`
Expected: 644 pass / 0 fail(642 + 新 2)。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useWorkloadToForm.js scripts/test.mjs
git commit -m "feat(copy): workloadToForm 接回填单源——native sidecar 归位,items/未知卷/新字段回填"
```

---

### Task 4: 'unknown' 类型全链(卡片/toVolumeDef/YAML/i18n)

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(toVolumeDef unknown 分支;toVolumeDefYaml unknown 早退)
- Modify: `src/components/common/VolumeMountCard.vue`(unknown 锁定标签 + 来源区提示)
- Modify: `src/views/DeployApp.vue`(volumesYaml unknown 分支)
- Modify: `src/locales/zh.json`、`src/locales/en.json`
- Test: `src/logic/__tests__/volumeMountValidation.test.js`、`src/components/common/__tests__/VolumeMountCard.test.js`

**Interfaces:**
- Consumes: Task 1 的 unknown 行(经复制/编辑回填进入表单)。
- 语义:unknown 卷 mountPath/subPath/readOnly 可编辑;来源与 items/defaultMode 不可编辑;保存时卷 spec 原样透传。

- [ ] **Step 1: 写失败测试**

逻辑测试追加(volumeMountValidation.test.js):

```js
test('toVolumeDef/toVolumeDefYaml: unknown 卷 raw 深拷贝透传;YAML 路径交还调用方(null)', () => {
  const raw = { name: 'proj-1', projected: { sources: [{ configMap: { name: 'cm' } }] } }
  const e = { name: 'proj-1', type: 'unknown', raw, mountPath: '/p', subPath: '', readOnly: false, items: [] }
  const def = toVolumeDef(e)
  expect(def).toEqual(raw)
  expect(def).not.toBe(raw)                     // 克隆,不是同引用
  def.projected.sources.push({ x: 1 })          // 改克隆不影响原 raw
  expect(raw.projected.sources).toHaveLength(1)
  expect(toVolumeDef({ name: 'x', type: 'unknown', raw: null })).toBe(null)
  expect(toVolumeDefYaml(e)).toBe(null)         // YAML 序列化由 DeployApp 用 js-yaml 特判
})
```

卡片测试追加(VolumeMountCard.test.js):

```js
test('VolumeMountCard: unknown 卷——锁定标签+原样保留提示;mountPath 可编辑;items/defaultMode 区不渲染', () => {
  const entry = makeEntry()
  entry.type = 'unknown'
  entry.raw = { name: 'proj-1', projected: { sources: [] } }
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [{ code: 'mountPathRequired', field: 'mountPath', level: 'error' }] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  expect(wrapper.text()).toContain('projected')                        // 锁定标签展示 raw 类型键
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.unknownNotice'))
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput).toBeTruthy()                                          // mountPath 仍可编辑
  expect(wrapper.text()).not.toContain(i18n.global.t('component.volumeMount.keyMapping'))
  wrapper.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 新 2 组 FAIL。

- [ ] **Step 3: 实现**

① `volumeMountValidation.js` `toVolumeDef` switch 加分支(注意 K8s spec 是 JSON 源,用 JSON 克隆兼容 reactive 代理——`structuredClone` 对 Proxy 抛 DataCloneError):

```js
    case 'unknown': return entry.raw ? JSON.parse(JSON.stringify(entry.raw)) : null   // 原样透传(克隆,防 reactive 代理/引用共享)
```

`toVolumeDefYaml` 函数体第一行(`const def = ...` 之前)加:

```js
  if (entry.type === 'unknown') return null   // 任意对象序列化由 DeployApp 用 js-yaml 特判,纯模块不引 YAML 依赖
```

② `DeployApp.vue` `volumesYaml`(现 `const volumesYaml = [...volDefs.values()].map(toVolumeDefYaml).filter(Boolean).join('\n')`)替换:

```js
  // unknown 卷:raw spec 原样透传(js-yaml 序列化;dump 数组项体 2 空格起,统一加 6 空格前缀即对齐手拼缩进)
  const rawVolumeYaml = raw => raw
    ? yamlDump([raw], { indent: 2, lineWidth: -1 }).trimEnd().split('\n').map(l => '      ' + l).join('\n')
    : null
  const volumesYaml = [...volDefs.values()].map(v => (v.type === 'unknown' ? rawVolumeYaml(v.raw) : toVolumeDefYaml(v))).filter(Boolean).join('\n')
```

③ `VolumeMountCard.vue`:

- script 加 `const unknownKind = computed(() => { const r = entry.value.raw || {}; return Object.keys(r).find(k => k !== 'name') || '?' })`。
- 模板类型胶囊行(116-122 行 `<div class="flex flex-wrap gap-xs">...</div>`)改为条件:

```html
    <div v-if="entry.type === 'unknown'" class="flex items-center gap-1 flex-wrap">
      <span class="flex items-center gap-0.5 px-sm py-0.5 rounded-full bg-surface-container-high border border-outline-variant text-on-surface-variant text-xs">
        <span class="material-symbols-outlined text-sm">lock</span>{{ unknownKind }}
      </span>
    </div>
    <div v-else class="flex flex-wrap gap-xs">
      <!-- 原胶囊按钮不动 -->
    </div>
```

- 来源区 v-if 链在 `<p v-else class="text-xs text-on-surface-variant/70 py-1.5">` 之前插一个分支:

```html
        <p v-else-if="entry.type === 'unknown'" class="text-xs text-on-surface-variant/80 py-1.5">{{ t('component.volumeMount.unknownNotice') }}</p>
```

(items/defaultMode 区由 `showItems` 天然排除;mountPath/subPath/readOnly 在区块外天然保留。)

④ locales(zh/en `component.volumeMount` 下):

```json
"unknownNotice": "未知卷类型，已原样保留；如需修改请直接编 YAML",
```
```json
"unknownNotice": "Unknown volume type, preserved as-is; edit YAML directly to modify",
```

- [ ] **Step 4: 跑测试确认通过 + i18n**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js src/components/common/__tests__/VolumeMountCard.test.js && npm run i18n:check > /tmp/bf-i18n.log 2>&1; echo EXIT=$?; tail -2 /tmp/bf-i18n.log`
Expected: 全 PASS;EXIT=0(注意不要把 $? 放在管道后)。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js src/views/DeployApp.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(mount): unknown 卷类型全链——卡片锁定透传提示/toVolumeDef 克隆 raw/YAML js-yaml 序列化"
```

---

### Task 5: 全量回归

**Files:** 无新改动(只验证)。

- [ ] **Step 1: 四件套**

Run: `npm test 2>&1 | tail -3 && npm run test:unit 2>&1 | tail -4 | head -3 && npm run typecheck && npm run i18n:check > /tmp/bf-final.log 2>&1; echo I18N=$?`
Expected: `npm test` 644/644;unit 0 fail;typecheck 0;I18N=0。

- [ ] **Step 2: 手工冒烟(推荐)**

`npm run dev`:任一含 ConfigMap(items 映射)的 workload → 复制 → step3 确认 items 行与落点预览在;若有 projected 卷 → 锁定标签 + 原样保留提示;不改直接走到 step5 检查 YAML 卷段与原对象一致。

- [ ] **Step 3: 如有修复,一并提交;否则跳过**

---

## Self-Review 记录

- **Spec coverage**:§3.1 模块 → Task 1;§3.2 两入口 → Task 2/3;§3.3 unknown 全链 → Task 4;§3.4 i18n → Task 4;§4 测试/验收 → 各任务 + Task 5。
- **Placeholder scan**:无。en 文案仅 1 条,已给全文。
- **Type consistency**:`backfillVolumes(podSpec)` 单参(NsWorkloadDetail 调用点从 `mergeVolumes(tplSpec, c0)` 改为 `backfillVolumes(tplSpec)`);行形状含 `raw`(unknown 为对象、其余 null);`toVolumeDefYaml` unknown 早退防 crash(否则 unknown def 落入 configMap/secret 序列化分支取 undefined 字段)。
- **边界已钉**:orphan mount(卷名未注册)回退 emptyDir 而非 unknown;structuredClone 禁用原因(reactive 代理);yamlDump 前缀缩进推导(2 空格体 + 6 空格前缀 = 8 空格键,与手拼一致)。
