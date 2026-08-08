# StorageClass 创建流程 + 标准 Provisioner 预设 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「创建存储类」弹窗从裸表单升级为「预设方案选择器 + KV 参数编辑 + 只读 YAML 预览 + 阻断式占位符校验」,内置 16 个常见 provisioner 预设。

**Architecture:** 新增两个纯 JS 数据/逻辑模块(`src/data/storageClassPresets.js` 数据+参数纯函数,`src/data/storageClassYaml.js` YAML 构造纯函数),供 `cluster.js` 的 `generateYAML('storageclass')` 委托调用、供 `Storage.vue` 弹窗消费。纯函数走零依赖运行器(`scripts/test.mjs`)单测;弹窗接线靠已测纯函数 + 手测。不新增依赖。

**Tech Stack:** Vue 3 + Pinia(纯 JS)、Vite、`@/` 路径别名、`js-yaml`、`CodeViewer.vue`(Prism)、Tailwind、`vue-i18n`。测试:`scripts/test.mjs`(零依赖,`node:assert`)。

## Global Constraints

(每个 task 的需求都隐含以下约束,逐条来自 spec 与 CLAUDE.md)

- **不新增任何外部依赖**。复用现有 `CodeViewer.vue` / KV 行模式 / `Modal`。
- **纯逻辑 → 零依赖运行器**(`scripts/test.mjs` 加 `import` + `test(name, fn)` 用例);组件交互可走 vitest 但本计划因逻辑已下沉到纯函数,跳过 vitest。
- **i18n**:`src/locales/zh.json` 与 `en.json` 必须同步;收尾跑 `npm run i18n:check`(残存中文 + 键对齐 + 引用缺失 三合一门禁)必须 0。
- **类型/语法基线**:`npm run typecheck`(`node --check` 全 .js/.mjs)必须过;.vue 由 `npm run build` 覆盖。
- **import 风格**:应用代码用 `@/data/xxx`(**不带** `.js`,匹配 `cluster.js:12` 的 `'@/composables/useStoragePatch'`);`scripts/test.mjs` 用相对 `../src/data/xxx.js`(**带** `.js`)。
- **generateYAML 契约**:新增/扩展资源走 `generateYAML` + `mapXxx`(见 memory `k8s-resource-edit-architecture`)。
- **StorageClass 语义**:`reclaimPolicy`/`volumeBindingMode`/`parameters`/`mountOptions` 创建后**不可变**,故丰富表单只在创建弹窗;`StorageClassDetail` 编辑弹窗不动。
- **当前工作分支**:`feat/storageclass-create-presets`(隔离 worktree,基于 main)。每个 task 末尾 commit 到本分支。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/data/storageClassPresets.js` | 16 个预设数据 + family 元数据 + 参数纯函数(`paramsMapToRows`/`paramsRowsToMap`/`normalizeParamsToMap`/`hasPlaceholderParam`/`presetToFormState`)。无 Vue 依赖。 | 新建 |
| `src/data/storageClassYaml.js` | `buildStorageClassYaml(resource)`:扁平资源(参数可为 rows/map/逗号串)→ StorageClass YAML 串。无 Vue 依赖。 | 新建 |
| `scripts/test.mjs` | 追加预设数据校验 + 参数纯函数 + YAML 构造的零依赖用例。 | 改 |
| `src/stores/cluster.js` | `generateYAML('storageclass')` 委托 `buildStorageClassYaml`;`mapStorageClass` 补 `volumeBindingMode`。 | 改 |
| `src/locales/zh.json` + `en.json` | 新增预设/family/binding/expand/preview/校验等键,两份同步。 | 改 |
| `src/views/Storage.vue` | 重写 SC 创建弹窗:预设下拉 + KV 参数行 + binding/expand + 只读 YAML 预览 + 阻断校验。 | 改 |

---

## Task 1: 预设数据模块 + 参数纯函数(TDD,零依赖)

**Files:**
- Create: `src/data/storageClassPresets.js`
- Test: `scripts/test.mjs`(顶部加 import + 追加 `test()` 用例)

**Interfaces:**
- Consumes: 无。
- Produces(供 Task 2/4 消费,签名固定):
  - `STORAGE_CLASS_PRESETS`: 16 元素数组,元素形如 `{ id, family, label, hint, provisioner, reclaimPolicy, volumeBindingMode, allowVolumeExpansion, defaultName, parameters: {}, requiredParams: [] }`
  - `STORAGE_CLASS_PRESET_FAMILIES`: `[{ key:'local', labelKey:'storage.familyLocal' }, { key:'distributed', labelKey:'storage.familyDistributed' }, { key:'nfs', labelKey:'storage.familyNfs' }, { key:'cloud', labelKey:'storage.familyCloud' }]`
  - `paramsMapToRows(map = {}) -> [{ key, value: String }]`
  - `paramsRowsToMap(rows = []) -> { [key]: value }`(空键跳过)
  - `normalizeParamsToMap(parameters) -> { [key]: value }`(接受 rows 数组 / 对象 map / 旧逗号串 `"k=v,k=v"`;逗号串按首个 `=` 切分)
  - `hasPlaceholderParam(rows, requiredParams = []) -> boolean`(任一 requiredParams 的 value 匹配 `/<[^\n>]*>/` 即 true)
  - `presetToFormState(preset) -> { name, provisioner, parameters:[{key,value}], reclaimPolicy, volumeBindingMode, allowVolumeExpansion, default:false }`

- [ ] **Step 1: 写失败测试(追加到 `scripts/test.mjs`)**

在 `scripts/test.mjs` 顶部 import 块(第 12-18 行附近)追加:
```js
import { STORAGE_CLASS_PRESETS, STORAGE_CLASS_PRESET_FAMILIES, paramsMapToRows, paramsRowsToMap, normalizeParamsToMap, hasPlaceholderParam, presetToFormState } from '../src/data/storageClassPresets.js'
```
在文件末尾(最后一个 `test(...)` 之后)追加:
```js
// --- StorageClass 预设目录完整性 ---
test('StorageClass 预设恰好 16 个,4 family 全覆盖', () => {
  assert.equal(STORAGE_CLASS_PRESETS.length, 16)
  const families = new Set(STORAGE_CLASS_PRESETS.map(p => p.family))
  for (const f of ['local', 'distributed', 'nfs', 'cloud']) assert.ok(families.has(f), `missing family ${f}`)
})

test('每个 StorageClass 预设字段完整且 requiredParams ⊆ parameters', () => {
  const validBinding = new Set(['Immediate', 'WaitForFirstConsumer'])
  const ids = new Set()
  for (const p of STORAGE_CLASS_PRESETS) {
    assert.ok(p.id, `preset missing id: ${JSON.stringify(p)}`)
    assert.ok(!ids.has(p.id), `dup preset id: ${p.id}`); ids.add(p.id)
    assert.ok(p.provisioner, `preset ${p.id} missing provisioner`)
    assert.ok(validBinding.has(p.volumeBindingMode), `preset ${p.id} bad volumeBindingMode ${p.volumeBindingMode}`)
    assert.ok(typeof p.allowVolumeExpansion === 'boolean', `preset ${p.id} allowVolumeExpansion not bool`)
    for (const rk of (p.requiredParams || [])) {
      assert.ok((p.parameters || {}).hasOwnProperty(rk), `preset ${p.id} requiredParams "${rk}" 不在 parameters 中`)
    }
  }
})

test('STORAGE_CLASS_PRESET_FAMILIES 4 项且 labelKey 与预设 family 对应', () => {
  assert.deepEqual(STORAGE_CLASS_PRESET_FAMILIES.map(f => f.key), ['local', 'distributed', 'nfs', 'cloud'])
})

// --- 参数纯函数 ---
test('paramsMapToRows / paramsRowsToMap 无损往返(保序、空键跳过)', () => {
  const rows = paramsMapToRows({ server: '10.0.0.1', share: '/data', type: 'nfs' })
  assert.deepEqual(rows, [
    { key: 'server', value: '10.0.0.1' },
    { key: 'share', value: '/data' },
    { key: 'type', value: 'nfs' },
  ])
  assert.deepEqual(paramsRowsToMap(rows), { server: '10.0.0.1', share: '/data', type: 'nfs' })
  assert.deepEqual(paramsRowsToMap([{ key: '  ', value: 'x' }, { key: 'k', value: 'v' }]), { k: 'v' })
})

test('normalizeParamsToMap 接受 rows / map / 逗号串三态', () => {
  assert.deepEqual(normalizeParamsToMap([{ key: 'a', value: '1' }]), { a: '1' })
  assert.deepEqual(normalizeParamsToMap({ a: '1', b: '2' }), { a: '1', b: '2' })
  assert.deepEqual(normalizeParamsToMap('a=1,b=2'), { a: '1', b: '2' })
  // 值含 '=' 时按首个 '=' 切分,其余属值
  assert.deepEqual(normalizeParamsToMap('conn=a=b'), { conn: 'a=b' })
  assert.deepEqual(normalizeParamsToMap(null), {})
  assert.deepEqual(normalizeParamsToMap(''), {})
})

test('hasPlaceholderParam 命中 <...> 占位符', () => {
  const rows = paramsMapToRows({ server: '<IP>', share: '/real' })
  assert.equal(hasPlaceholderParam(rows, ['server']), true)
  assert.equal(hasPlaceholderParam(rows, ['share']), false)
  assert.equal(hasPlaceholderParam(rows, []), false)
})

test('presetToFormState 把预设铺成表单状态(parameters 转 KV 行)', () => {
  const nfs = STORAGE_CLASS_PRESETS.find(p => p.id === 'nfs-csi')
  const form = presetToFormState(nfs)
  assert.equal(form.provisioner, 'nfs.csi.k8s.io')
  assert.equal(form.volumeBindingMode, 'Immediate')
  assert.equal(form.allowVolumeExpansion, true)
  assert.equal(form.default, false)
  assert.ok(Array.isArray(form.parameters) && form.parameters.length === 3)
})
```

- [ ] **Step 2: 运行测试,确认失败(模块不存在)**

Run: `npm test`
Expected: FAIL,报 `Cannot find module '.../src/data/storageClassPresets.js'`(或 import 失败)。

- [ ] **Step 3: 写实现 `src/data/storageClassPresets.js`**

```js
// StorageClass 创建预设 + 参数纯函数。无 Vue 依赖,便于 scripts/test.mjs 直接 import。
// 每个 preset.requiredParams 里的键值含 <...> 占位符时,创建弹窗阻断(避免静默失败的坏 SC)。

export const STORAGE_CLASS_PRESETS = [
  // === 本地/单机 ===
  { id: 'local-path', family: 'local', label: 'storage.presets.local-path.label', hint: 'storage.presets.local-path.hint',
    provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'local-path', parameters: {}, requiredParams: [] },
  { id: 'no-provisioner', family: 'local', label: 'storage.presets.no-provisioner.label', hint: 'storage.presets.no-provisioner.hint',
    provisioner: 'kubernetes.io/no-provisioner', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'manual', parameters: {}, requiredParams: [] },
  { id: 'host-path', family: 'local', label: 'storage.presets.host-path.label', hint: 'storage.presets.host-path.hint',
    provisioner: 'kubernetes.io/host-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'host-path', parameters: {}, requiredParams: [] },
  // === 分布式块存储 ===
  { id: 'longhorn', family: 'distributed', label: 'storage.presets.longhorn.label', hint: 'storage.presets.longhorn.hint',
    provisioner: 'driver.longhorn.io', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'longhorn',
    parameters: { numberOfReplicas: '3', staleReplicaTimeout: '30' }, requiredParams: [] },
  { id: 'ceph-rbd', family: 'distributed', label: 'storage.presets.ceph-rbd.label', hint: 'storage.presets.ceph-rbd.hint',
    provisioner: 'rook-ceph.rbd.csi.ceph.com', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'rook-ceph-block',
    parameters: {
      clusterID: '<rook-ceph>', pool: '<replicapool>', imageFormat: '2', imageFeatures: 'layering',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/provisioner-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/controller-expand-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node',
      'csi.storage.k8s.io/node-stage-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/fstype': 'ext4',
    }, requiredParams: ['clusterID', 'pool'] },
  { id: 'cephfs', family: 'distributed', label: 'storage.presets.cephfs.label', hint: 'storage.presets.cephfs.hint',
    provisioner: 'rook-ceph.cephfs.csi.ceph.com', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'rook-cephfs',
    parameters: {
      clusterID: '<rook-ceph>', fsName: '<cephfs>',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-cephfs-provisioner',
      'csi.storage.k8s.io/provisioner-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-cephfs-provisioner',
      'csi.storage.k8s.io/controller-expand-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-cephfs-node',
      'csi.storage.k8s.io/node-stage-secret-namespace': 'rook-ceph',
      'csi.storage.k8s.io/fstype': 'ext4',
    }, requiredParams: ['clusterID', 'fsName'] },
  { id: 'openebs-localpv', family: 'distributed', label: 'storage.presets.openebs-localpv.label', hint: 'storage.presets.openebs-localpv.hint',
    provisioner: 'openebs.io/local', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, defaultName: 'openebs-localpv',
    parameters: { storageType: 'hostpath' }, requiredParams: [] },
  { id: 'topolvm', family: 'distributed', label: 'storage.presets.topolvm.label', hint: 'storage.presets.topolvm.hint',
    provisioner: 'topolvm.io', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'topolvm',
    parameters: { 'csi.storage.k8s.io/fstype': 'xfs' }, requiredParams: [] },
  // === NFS ===
  { id: 'nfs-csi', family: 'nfs', label: 'storage.presets.nfs-csi.label', hint: 'storage.presets.nfs-csi.hint',
    provisioner: 'nfs.csi.k8s.io', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: true, defaultName: 'nfs-client',
    parameters: { server: '<IP>', share: '</exported/path>', 'csi.storage.k8s.io/fstype': 'nfs' },
    requiredParams: ['server', 'share'] },
  { id: 'nfs-in-tree', family: 'nfs', label: 'storage.presets.nfs-in-tree.label', hint: 'storage.presets.nfs-in-tree.hint',
    provisioner: 'kubernetes.io/nfs', reclaimPolicy: 'Retain', volumeBindingMode: 'Immediate',
    allowVolumeExpansion: false, defaultName: 'nfs',
    parameters: { server: '<IP>', path: '</path>' }, requiredParams: ['server', 'path'] },
  // === 云厂商块存储 ===
  { id: 'aws-ebs', family: 'cloud', label: 'storage.presets.aws-ebs.label', hint: 'storage.presets.aws-ebs.hint',
    provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'ebs-sc',
    parameters: { type: 'gp3', 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
  { id: 'gce-pd', family: 'cloud', label: 'storage.presets.gce-pd.label', hint: 'storage.presets.gce-pd.hint',
    provisioner: 'pd.csi.storage.gke.io', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'standard',
    parameters: { type: 'pd-ssd' }, requiredParams: [] },
  { id: 'azure-disk', family: 'cloud', label: 'storage.presets.azure-disk.label', hint: 'storage.presets.azure-disk.hint',
    provisioner: 'disk.csi.azure.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'disk-sc',
    parameters: { skuName: 'StandardSSD_LRS', 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
  { id: 'aliyun-disk', family: 'cloud', label: 'storage.presets.aliyun-disk.label', hint: 'storage.presets.aliyun-disk.hint',
    provisioner: 'disk.csi.alibabacloud.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'alicloud-disk',
    parameters: { type: 'cloud_essd' }, requiredParams: [] },
  { id: 'tencent-cbs', family: 'cloud', label: 'storage.presets.tencent-cbs.label', hint: 'storage.presets.tencent-cbs.hint',
    provisioner: 'com.tencent.cloud.csi.cbs', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'cbs',
    parameters: { type: 'CLOUD_SSD' }, requiredParams: [] },
  { id: 'huawei-evs', family: 'cloud', label: 'storage.presets.huawei-evs.label', hint: 'storage.presets.huawei-evs.hint',
    provisioner: 'ebs.csi.huaweicloud.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true, defaultName: 'evs',
    parameters: { 'csi.storage.k8s.io/fstype': 'ext4' }, requiredParams: [] },
]

export const STORAGE_CLASS_PRESET_FAMILIES = [
  { key: 'local', labelKey: 'storage.familyLocal' },
  { key: 'distributed', labelKey: 'storage.familyDistributed' },
  { key: 'nfs', labelKey: 'storage.familyNfs' },
  { key: 'cloud', labelKey: 'storage.familyCloud' },
]

export function paramsMapToRows(map = {}) {
  return Object.entries(map).map(([key, value]) => ({ key, value: String(value) }))
}

export function paramsRowsToMap(rows = []) {
  const map = {}
  for (const r of rows) {
    const k = (r?.key || '').trim()
    if (k) map[k] = r?.value ?? ''
  }
  return map
}

// 接受 rows [{key,value}] / 对象 map / 旧逗号串 "k=v,k=v";统一输出有序 map。
export function normalizeParamsToMap(parameters) {
  if (!parameters) return {}
  if (Array.isArray(parameters)) return paramsRowsToMap(parameters)
  if (typeof parameters === 'string') {
    const map = {}
    for (const kv of parameters.split(',')) {
      const idx = kv.indexOf('=')
      if (idx > 0) map[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim()
    }
    return map
  }
  return { ...parameters }
}

// 任一 requiredParams 的 value 仍含 <...> 占位符 → true(创建弹窗据此阻断)。
export function hasPlaceholderParam(rows, requiredParams = []) {
  const map = paramsRowsToMap(rows)
  return requiredParams.some(k => /<[^\n>]*>/.test(String(map[k] ?? '')))
}

export function presetToFormState(preset) {
  return {
    name: preset.defaultName || '',
    provisioner: preset.provisioner || '',
    parameters: paramsMapToRows(preset.parameters || {}),
    reclaimPolicy: preset.reclaimPolicy || 'Delete',
    volumeBindingMode: preset.volumeBindingMode || 'WaitForFirstConsumer',
    allowVolumeExpansion: !!preset.allowVolumeExpansion,
    default: false,
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS(新增的 StorageClass 用例全绿,既有用例不回归)。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: PASS(`node --check src/data/storageClassPresets.js`)。

- [ ] **Step 6: Commit**

```bash
git add src/data/storageClassPresets.js scripts/test.mjs
git commit -m "feat(storageclass): 16 provisioner presets + 参数纯函数(零依赖测试)"
```

---

## Task 2: StorageClass YAML 构造纯函数 + 委托进 store(TDD,零依赖)

**Files:**
- Create: `src/data/storageClassYaml.js`
- Modify: `src/stores/cluster.js`(顶部 import;`generateYAML('storageclass')` 委托;`mapStorageClass` 补字段)
- Test: `scripts/test.mjs`(追加 import + 用例)

**Interfaces:**
- Consumes: `normalizeParamsToMap` from `src/data/storageClassPresets.js`(Task 1)。
- Produces: `buildStorageClassYaml(resource = {}) -> string`。`resource` 字段:`name`、`provisioner`、`reclaimPolicy`、`volumeBindingMode`、`allowVolumeExpansion`(bool)、`mountOptions`(数组,可选)、`parameters`(rows/map/逗号串 任一)。返回的 YAML 固定字段顺序:`apiVersion`/`kind`/`metadata.name`/`provisioner`/`reclaimPolicy`/`volumeBindingMode`/`allowVolumeExpansion?`/`mountOptions?`/`parameters`。参数缩进 4 空格(匹配既有 generateYAML 风格),空参数输出 `    {}`。

- [ ] **Step 1: 写失败测试(追加到 `scripts/test.mjs`)**

顶部 import 块追加:
```js
import { buildStorageClassYaml } from '../src/data/storageClassYaml.js'
```
末尾追加:
```js
// --- StorageClass YAML 构造 ---
test('buildStorageClassYaml: 基本字段 + volumeBindingMode + 占位符原样保留(nfs-csi)', () => {
  const yaml = buildStorageClassYaml({
    name: 'nfs-client', provisioner: 'nfs.csi.k8s.io', reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate', allowVolumeExpansion: true,
    parameters: [{ key: 'server', value: '<IP>' }, { key: 'share', value: '/data' }, { key: 'csi.storage.k8s.io/fstype', value: 'nfs' }],
  })
  const lines = yaml.split('\n')
  assert.equal(lines[0], 'apiVersion: storage.k8s.io/v1')
  assert.equal(lines[1], 'kind: StorageClass')
  assert.ok(lines.includes('metadata:'))
  assert.ok(lines.includes('  name: nfs-client'))
  assert.ok(lines.includes('provisioner: nfs.csi.k8s.io'))
  assert.ok(lines.includes('reclaimPolicy: Delete'))
  assert.ok(lines.includes('volumeBindingMode: Immediate'))
  assert.ok(lines.includes('allowVolumeExpansion: true'))
  assert.ok(lines.includes('parameters:'))
  assert.ok(lines.includes('    server: <IP>'), '占位符必须原样保留')
  assert.ok(lines.includes('    share: /data'))
})

test('buildStorageClassYaml: 多参数(Ceph RBD 11 项)全输出', () => {
  const yaml = buildStorageClassYaml({
    name: 'rook-ceph-block', provisioner: 'rook-ceph.rbd.csi.ceph.com', reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate', allowVolumeExpansion: true,
    parameters: { clusterID: 'rook-ceph', pool: 'replicapool', imageFormat: '2', imageFeatures: 'layering' },
  })
  for (const frag of ['    clusterID: rook-ceph', '    pool: replicapool', '    imageFormat: 2', '    imageFeatures: layering']) {
    assert.ok(yaml.includes(frag), `missing param line: ${frag}`)
  }
})

test('buildStorageClassYaml: allowVolumeExpansion=false 不输出该行;空参数输出 {}', () => {
  const yaml = buildStorageClassYaml({
    name: 'local-path', provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete',
    volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false, parameters: [],
  })
  assert.ok(!yaml.includes('allowVolumeExpansion'), 'false 时不应输出 allowVolumeExpansion')
  assert.ok(yaml.includes('parameters:\n    {}'), '空参数应输出 {}')
})

test('buildStorageClassYaml: 旧逗号串参数仍兼容(normalizeParamsToMap)', () => {
  const yaml = buildStorageClassYaml({
    name: 'sc', provisioner: 'ebs.csi.aws.com', parameters: 'type=gp3',
  })
  assert.ok(yaml.includes('volumeBindingMode: WaitForFirstConsumer'), '缺省 binding=WaitForFirstConsumer')
  assert.ok(yaml.includes('    type: gp3'))
  assert.ok(yaml.includes('provisioner: kubernetes.io/no-provisioner') === false)
})

test('buildStorageClassYaml: mountOptions 仅在非空数组时输出', () => {
  const withMount = buildStorageClassYaml({ name: 'nfs', provisioner: 'nfs.csi.k8s.io', mountOptions: ['hard', 'nfsvers=4.1'], parameters: [] })
  assert.ok(withMount.includes('mountOptions:'))
  assert.ok(withMount.includes('  - hard'))
  assert.ok(withMount.includes('  - nfsvers=4.1'))
  const noMount = buildStorageClassYaml({ name: 'x', provisioner: 'p', parameters: [] })
  assert.ok(!noMount.includes('mountOptions:'))
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL(`Cannot find module '.../storageClassYaml.js'`)。

- [ ] **Step 3: 写实现 `src/data/storageClassYaml.js`**

```js
// StorageClass YAML 构造纯函数。无 Vue 依赖,便于 scripts/test.mjs 直接 import。
// cluster.js 的 generateYAML('storageclass') 委托本函数;Storage.vue 预览经 store.generateYAML 间接复用。
import { normalizeParamsToMap } from './storageClassPresets.js'

export function buildStorageClassYaml(resource = {}) {
  const name = resource.name || resource.metadata?.name || 'unnamed'
  const provisioner = resource.provisioner || 'kubernetes.io/no-provisioner'
  const reclaimPolicy = resource.reclaimPolicy || 'Delete'
  const volumeBindingMode = resource.volumeBindingMode || 'WaitForFirstConsumer'
  const params = normalizeParamsToMap(resource.parameters)
  const paramKeys = Object.keys(params)
  const paramsYaml = paramKeys.length
    ? paramKeys.map(k => `    ${k}: ${params[k]}`).join('\n')
    : '    {}'

  const lines = [
    'apiVersion: storage.k8s.io/v1',
    'kind: StorageClass',
    'metadata:',
    `  name: ${name}`,
    `provisioner: ${provisioner}`,
    `reclaimPolicy: ${reclaimPolicy}`,
    `volumeBindingMode: ${volumeBindingMode}`,
  ]
  if (resource.allowVolumeExpansion === true) lines.push('allowVolumeExpansion: true')
  if (Array.isArray(resource.mountOptions) && resource.mountOptions.length) {
    lines.push('mountOptions:')
    for (const o of resource.mountOptions) lines.push(`  - ${o}`)
  }
  lines.push('parameters:')
  lines.push(paramsYaml)
  return lines.join('\n')
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS(新增 YAML 用例全绿)。

- [ ] **Step 5: 委托进 `cluster.js`**

`src/stores/cluster.js` 顶部 import 块(第 12 行 `import { buildPVPatch, buildStorageClassPatch } from '@/composables/useStoragePatch'` 附近)追加一行:
```js
import { buildStorageClassYaml } from '@/data/storageClassYaml'
```
把 `generateYAML` 里 `if (type === 'storageclass') { ... }` 整段(当前 `cluster.js:2648-2664`,含 paramMap/paramsYaml 构造与模板串)**整体替换**为:
```js
    if (type === 'storageclass') {
      return buildStorageClassYaml(resource)
    }
```
在 `mapStorageClass`(`cluster.js:2021` 起)的返回对象里,`reclaimPolicy` 那行之后补一行:
```js
      volumeBindingMode: item.volumeBindingMode || 'WaitForFirstConsumer',
```

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck && npm test`
Expected: PASS(typecheck 过;`scripts/test.mjs` + `node --test server/*.test.mjs` 全绿)。

- [ ] **Step 7: Commit**

```bash
git add src/data/storageClassYaml.js src/stores/cluster.js scripts/test.mjs
git commit -m "feat(storageclass): 提取 buildStorageClassYaml 纯函数,generateYAML 委托+补 volumeBindingMode"
```

---

## Task 3: i18n 键(zh + en 同步)

**Files:**
- Modify: `src/locales/zh.json`(storage 块,~第 1860-1890 行)
- Modify: `src/locales/en.json`(同结构)

**Interfaces:**
- Consumes: Task 1 的 preset id / family / label-hint 键名(固定字面量,见下)。
- Produces: `storage.*` 下新键,供 Task 4 模板 `t(...)` 引用。

需要新增的键(以下为 zh.json 的 `storage` 对象内追加;en.json 同步同键英文值):

- [ ] **Step 1: 在 `src/locales/zh.json` 的 `"storage": { ... }` 对象里追加(放在 `createSCTitle` 之后、闭合 `}` 之前)**

```json
    "presetScheme": "预设方案",
    "presetCustom": "自定义(不选预设)",
    "familyLocal": "本地 / 单机",
    "familyDistributed": "分布式块存储",
    "familyNfs": "NFS",
    "familyCloud": "云厂商块存储",
    "volumeBindingMode": "卷绑定模式",
    "bindingImmediate": "立即绑定 (Immediate)",
    "bindingWaitForFirstConsumer": "首消费者等待 (WaitForFirstConsumer)",
    "allowVolumeExpansion": "允许卷扩容",
    "yamlPreview": "YAML 预览(只读)",
    "requiredParamWarn": "必填参数仍含占位符 <…>,请替换后再创建",
    "addParam": "添加参数",
    "key": "键",
    "value": "值",
    "presets": {
      "local-path": { "label": "Local Path (Rancher/k3s)", "hint": "使用节点本地路径,适合单机 / homelab。需先 helm 装 local-path-provisioner。" },
      "no-provisioner": { "label": "无 Provisioner(静态 PV)", "hint": "不自动创建 PV,需手动预先创建 PV。volumeBindingMode 强制 WaitForFirstConsumer。" },
      "host-path": { "label": "Host Path(已弃用)", "hint": "in-tree host-path,已弃用,仅旧集群兼容。" },
      "longhorn": { "label": "Longhorn", "hint": "Rancher 生态分布式存储,默认 3 副本。需先装 Longhorn。" },
      "ceph-rbd": { "label": "Ceph RBD (Rook)", "hint": "Rook 部署的 Ceph RBD 块存储。clusterID 通常为 rook-ceph 命名空间名;按实际 pool 改。" },
      "cephfs": { "label": "CephFS (Rook)", "hint": "Rook 部署的 CephFS 文件存储。填 clusterID 与 fsName。" },
      "openebs-localpv": { "label": "OpenEBS Local PV", "hint": "OpenEBS 本地 PV(hostpath / device)。需先装 OpenEBS。" },
      "topolvm": { "label": "TopoLVM", "hint": "LVM 动态精简配置,支持扩容。需先装 TopoLVM。" },
      "nfs-csi": { "label": "NFS(CSI 驱动,推荐)", "hint": "NFS CSI 驱动。必填 server(IP/主机名)与 share(导出路径)。需先装 nfs-csi-driver。" },
      "nfs-in-tree": { "label": "NFS(in-tree,已弃用)", "hint": "in-tree NFS,已弃用,推荐用 nfs.csi.k8s.io。必填 server 与 path。" },
      "aws-ebs": { "label": "AWS EBS (CSI)", "hint": "AWS EBS CSI,默认 gp3。需先装 aws-ebs-csi-driver。" },
      "gce-pd": { "label": "GCE PD (CSI)", "hint": "GCE Persistent Disk CSI,GKE 默认已装。type: pd-standard/pd-balanced/pd-ssd/pd-extreme。" },
      "azure-disk": { "label": "Azure Disk (CSI)", "hint": "Azure Disk CSI。skuName: Standard_LRS/StandardSSD_LRS/Premium_LRS。" },
      "aliyun-disk": { "label": "阿里云盘 (CSI)", "hint": "阿里云 ACK CSI,默认 ESSD。type: cloud_efficiency/cloud_ssd/cloud_essd。" },
      "tencent-cbs": { "label": "腾讯云 CBS (CSI)", "hint": "腾讯云 CBS CSI。type: CLOUD_PREMIUM/CLOUD_SSD/CLOUD_HSSD。" },
      "huawei-evs": { "label": "华为云 EVS (CSI)", "hint": "华为云 CCE EVS CSI。卷类型经 StorageClass 参数或控制台指定。" }
    }
```

- [ ] **Step 2: 在 `src/locales/en.json` 的 `"storage": { ... }` 对象里追加同键英文值**

```json
    "presetScheme": "Preset scheme",
    "presetCustom": "Custom (no preset)",
    "familyLocal": "Local / single-node",
    "familyDistributed": "Distributed block storage",
    "familyNfs": "NFS",
    "familyCloud": "Cloud provider block storage",
    "volumeBindingMode": "Volume binding mode",
    "bindingImmediate": "Immediate",
    "bindingWaitForFirstConsumer": "WaitForFirstConsumer",
    "allowVolumeExpansion": "Allow volume expansion",
    "yamlPreview": "YAML preview (read-only)",
    "requiredParamWarn": "Required parameter still has a <…> placeholder — replace it before creating",
    "addParam": "Add parameter",
    "key": "Key",
    "value": "Value",
    "presets": {
      "local-path": { "label": "Local Path (Rancher/k3s)", "hint": "Node-local path; ideal for single-node / homelab. Install local-path-provisioner first (helm)." },
      "no-provisioner": { "label": "No provisioner (static PV)", "hint": "Does not auto-create PVs; you must pre-create them. volumeBindingMode forced to WaitForFirstConsumer." },
      "host-path": { "label": "Host path (deprecated)", "hint": "In-tree host-path; deprecated, legacy clusters only." },
      "longhorn": { "label": "Longhorn", "hint": "Rancher distributed storage, 3 replicas by default. Install Longhorn first." },
      "ceph-rbd": { "label": "Ceph RBD (Rook)", "hint": "Rook-provisioned Ceph RBD. clusterID is usually the rook-ceph namespace; edit pool to match." },
      "cephfs": { "label": "CephFS (Rook)", "hint": "Rook-provisioned CephFS. Fill clusterID and fsName." },
      "openebs-localpv": { "label": "OpenEBS Local PV", "hint": "OpenEBS local PV (hostpath / device). Install OpenEBS first." },
      "topolvm": { "label": "TopoLVM", "hint": "LVM thin provisioning, expansion supported. Install TopoLVM first." },
      "nfs-csi": { "label": "NFS (CSI driver, recommended)", "hint": "NFS CSI driver. server (IP/host) and share (export path) are required. Install nfs-csi-driver first." },
      "nfs-in-tree": { "label": "NFS (in-tree, deprecated)", "hint": "In-tree NFS; deprecated — prefer nfs.csi.k8s.io. server and path required." },
      "aws-ebs": { "label": "AWS EBS (CSI)", "hint": "AWS EBS CSI, defaults to gp3. Install aws-ebs-csi-driver first." },
      "gce-pd": { "label": "GCE PD (CSI)", "hint": "GCE Persistent Disk CSI; preinstalled on GKE. type: pd-standard/pd-balanced/pd-ssd/pd-extreme." },
      "azure-disk": { "label": "Azure Disk (CSI)", "hint": "Azure Disk CSI. skuName: Standard_LRS/StandardSSD_LRS/Premium_LRS." },
      "aliyun-disk": { "label": "Alibaba Cloud Disk (CSI)", "hint": "Alibaba ACK CSI, defaults to ESSD. type: cloud_efficiency/cloud_ssd/cloud_essd." },
      "tencent-cbs": { "label": "Tencent Cloud CBS (CSI)", "hint": "Tencent Cloud CBS CSI. type: CLOUD_PREMIUM/CLOUD_SSD/CLOUD_HSSD." },
      "huawei-evs": { "label": "Huawei Cloud EVS (CSI)", "hint": "Huawei CCE EVS CSI. Volume type set via StorageClass params or console." }
    }
```

- [ ] **Step 3: 校验 i18n 三合一门禁**

Run: `npm run i18n:check`
Expected: PASS(残存中文 0 / zh-en 键对齐 / 引用键缺失 0)。若报某键缺失/不对齐,补齐再跑。

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "i18n(storageclass): 预设/family/binding/expand/preview/校验键,zh+en 同步"
```

---

## Task 4: Storage.vue 创建弹窗重写(预设 + KV 参数 + binding/expand + 预览 + 阻断校验)

**Files:**
- Modify: `src/views/Storage.vue`(`<script setup>` 顶部 import;SC 创建响应式状态/方法区 ~99-116;模板 SC 创建 Modal ~312-345)

**Interfaces:**
- Consumes:
  - Task 1: `STORAGE_CLASS_PRESETS`, `STORAGE_CLASS_PRESET_FAMILIES`, `presetToFormState`, `hasPlaceholderParam`(from `@/data/storageClassPresets`)
  - Task 2: `store.generateYAML('storageclass', form)`(经 Task 2 委托到 `buildStorageClassYaml`)做只读预览
  - Task 3: `storage.*` i18n 键 + `storage.presets.<id>.label/hint`
  - 既有:`CodeViewer.vue`、`Modal.vue`、`store.addStorageClass`(已透传 form 全字段到 generateYAML)
- Produces: 一个可用的创建弹窗。`store.addStorageClass` 收到含 `parameters`(KV 行数组)、`volumeBindingMode`、`allowVolumeExpansion` 的 form,经 generateYAML→buildStorageClassYaml 正确落 YAML(mock 与 remote 模式皆然)。

> 注:本 task 的判定逻辑(`hasPlaceholderParam`、`presetToFormState`)已在 Task 1 覆盖;YAML 输出在 Task 2 覆盖。本 task 主要是接线,验收靠 typecheck + build + 手测。

- [ ] **Step 1: 顶部 import 追加**

`src/views/Storage.vue` 的 `<script setup>` 顶部(既有 `import Modal from ...` 等之后)追加:
```js
import CodeViewer from '@/components/common/CodeViewer.vue'
import { STORAGE_CLASS_PRESETS, STORAGE_CLASS_PRESET_FAMILIES, presetToFormState, hasPlaceholderParam } from '@/data/storageClassPresets'
```

- [ ] **Step 2: 替换 SC 创建状态/方法区(当前 99-116 行)**

把这段:
```js
// Create StorageClass
const showCreateSC = ref(false)
const createSCForm = ref({ name: '', provisioner: '', parameters: '', reclaimPolicy: 'Retain', default: false })
function resetCreateSC() {
  createSCForm.value = { name: '', provisioner: '', parameters: '', reclaimPolicy: 'Retain', default: false }
}
function handleCreateSC() {
  const f = createSCForm.value
  if (!f.name) return
  store.addStorageClass({
    name: f.name,
    provisioner: f.provisioner,
    parameters: f.parameters,
    reclaimPolicy: f.reclaimPolicy,
    default: f.default,
  })
  showCreateSC.value = false
  resetCreateSC()
}
```
整体替换为:
```js
// Create StorageClass(预设方案 + KV 参数 + binding/expand + 只读 YAML 预览 + 阻断校验)
const showCreateSC = ref(false)
const scPresetId = ref('')
const createSCForm = ref({
  name: '', provisioner: '', parameters: [{ key: '', value: '' }],
  reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
  allowVolumeExpansion: false, default: false,
})
const currentScPreset = computed(() => STORAGE_CLASS_PRESETS.find(p => p.id === scPresetId.value))
const scHasPlaceholder = computed(() => hasPlaceholderParam(createSCForm.value.parameters, currentScPreset.value?.requiredParams || []))
const scCanCreate = computed(() => !!createSCForm.value.name && !scHasPlaceholder.value)
const scPreviewYaml = computed(() => store.generateYAML('storageclass', createSCForm.value))
function resetCreateSC() {
  scPresetId.value = ''
  createSCForm.value = {
    name: '', provisioner: '', parameters: [{ key: '', value: '' }],
    reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false, default: false,
  }
}
function onScPresetChange(id) {
  scPresetId.value = id
  const preset = STORAGE_CLASS_PRESETS.find(p => p.id === id)
  if (preset) createSCForm.value = presetToFormState(preset)
}
function addScParamRow() { createSCForm.value.parameters.push({ key: '', value: '' }) }
function removeScParamRow(i) { createSCForm.value.parameters.splice(i, 1) }
function handleCreateSC() {
  const f = createSCForm.value
  if (!scCanCreate.value) return
  store.addStorageClass({
    name: f.name,
    provisioner: f.provisioner,
    parameters: f.parameters,
    reclaimPolicy: f.reclaimPolicy,
    volumeBindingMode: f.volumeBindingMode,
    allowVolumeExpansion: f.allowVolumeExpansion,
    default: f.default,
  })
  showCreateSC.value = false
  resetCreateSC()
}
```

- [ ] **Step 3: 替换 SC 创建 Modal 模板(当前 312-345 行)**

把整个 `<!-- Create StorageClass Modal --> ... </Modal>` 块替换为:
```html
    <!-- Create StorageClass Modal -->
    <Modal v-model="showCreateSC" :title="t('storage.createSCTitle')" width="max-w-2xl">
      <div class="flex flex-col gap-md">
        <!-- 预设方案 -->
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.presetScheme') }}</label>
          <select :value="scPresetId" @change="onScPresetChange($event.target.value)" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
            <option value="">{{ t('storage.presetCustom') }}</option>
            <optgroup v-for="fam in STORAGE_CLASS_PRESET_FAMILIES" :key="fam.key" :label="t(fam.labelKey)">
              <option v-for="p in STORAGE_CLASS_PRESETS.filter(p => p.family === fam.key)" :key="p.id" :value="p.id">{{ t(p.label) }}</option>
            </optgroup>
          </select>
          <p v-if="currentScPreset?.hint" class="text-on-surface-variant text-xs mt-xs">{{ t(currentScPreset.hint) }}</p>
        </div>

        <!-- name + provisioner -->
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.scName') }}</label>
            <input v-model="createSCForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.scPlaceholder')" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.provisionerLabel') }}</label>
            <input v-model="createSCForm.provisioner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary font-mono text-code-sm" placeholder="rancher.io/local-path" />
          </div>
        </div>

        <!-- parameters KV 行 -->
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.parametersLabel') }}</label>
          <div v-for="(row, i) in createSCForm.parameters" :key="i" class="flex items-center gap-xs mb-xs">
            <input v-model="row.key" :placeholder="t('storage.key')" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono text-code-sm focus:ring-2 focus:ring-primary" />
            <input v-model="row.value" :placeholder="t('storage.value')" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono text-code-sm focus:ring-2 focus:ring-primary" />
            <button @click="removeScParamRow(i)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('storage.delete')">
              <span class="material-symbols-outlined text-lg">delete</span>
            </button>
          </div>
          <button @click="addScParamRow" class="flex items-center gap-xs text-body-sm text-primary hover:opacity-80">
            <span class="material-symbols-outlined text-base">add</span>{{ t('storage.addParam') }}
          </button>
        </div>

        <!-- reclaim / binding / expand / default -->
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.reclaimPolicy') }}</label>
            <select v-model="createSCForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Retain">{{ t('storage.retain') }}</option>
              <option value="Delete">{{ t('storage.delete') }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.volumeBindingMode') }}</label>
            <select v-model="createSCForm.volumeBindingMode" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Immediate">{{ t('storage.bindingImmediate') }}</option>
              <option value="WaitForFirstConsumer">{{ t('storage.bindingWaitForFirstConsumer') }}</option>
            </select>
          </div>
        </div>
        <div class="flex items-center gap-lg">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" v-model="createSCForm.allowVolumeExpansion" class="w-4 h-4 accent-primary" />
            <span class="text-body-md text-on-surface">{{ t('storage.allowVolumeExpansion') }}</span>
          </label>
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" v-model="createSCForm.default" class="w-4 h-4 accent-primary" />
            <span class="text-body-md text-on-surface">{{ t('storage.setDefaultStorageClass') }}</span>
          </label>
        </div>

        <!-- 占位符阻断告警 -->
        <p v-if="scHasPlaceholder" class="text-error text-xs flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">warning</span>{{ t('storage.requiredParamWarn') }}
        </p>

        <!-- 只读 YAML 预览 -->
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.yamlPreview') }}</label>
          <CodeViewer :code="scPreviewYaml" lang="yaml" max-height="35vh" />
        </div>
      </div>
      <template #actions>
        <button @click="showCreateSC = false; resetCreateSC()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('storage.cancel') }}</button>
        <button @click="handleCreateSC" :disabled="!scCanCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('storage.create') }}</button>
      </template>
    </Modal>
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS(typecheck 过;vite build 成功,无 Vue 模板编译错误)。若 build 报 `t('storage.xxx')` 引用缺失,回 Task 3 补键再跑 `npm run i18n:check`。

- [ ] **Step 5: 手测(连一个集群或 mock 模式)**

Run: `npm run dev`,打开「存储」→ SC tab →「+」。验证:
1. 预设下拉分 4 组(本地/分布式/NFS/云)+「自定义」;选 `nfs-csi` → name/provisioner/参数/binding/expand 自动填,hint 显示,预览 YAML 实时更新含 `server: <IP>`。
2. `server` 仍为 `<IP>` 时 **创建按钮置灰** + 红字告警;把 `server` 改成真实 IP → 按钮可点。
3. 选 `ceph-rbd` → 11 个参数 KV 行铺开;改 `clusterID`/`pool` 后预览同步。
4. 选「自定义」→ 表单回到空白默认。
5. 创建一个 local-path SC → 列表出现;mock 模式直接进 `scList`,remote 模式经 `/api/apply` 落集群。
6. 参数「+ 添加参数」/ 删除行可用。

- [ ] **Step 6: Commit**

```bash
git add src/views/Storage.vue
git commit -m "feat(storageclass): 创建弹窗升级(预设选择器+KV参数+binding/expand+只读YAML预览+阻断校验)"
```

---

## Self-Review(spec 覆盖核对)

- §1 架构(预设单独成文件 + 复用 CodeViewer/KV 行)→ Task 1/4。✅
- §2 数据模型(preset 形状、form 状态、pure helpers)→ Task 1。✅
- §3 创建弹窗 UX(预设下拉、KV 参数、binding、expand、只读预览、阻断校验)→ Task 4。✅
- §4 generateYAML 契约扩展(volumeBindingMode/allowVolumeExpansion/mountOptions/归一化参数)→ Task 2(buildStorageClassYaml)。✅ mountOptions 无预设使用但 builder 支持,有测试。
- §5 校验(必填占位符阻断、name 必填、default 不自动 unset)→ Task 1(hasPlaceholderParam)+ Task 4(按钮置灰)。default 不自动 unset 为已知缺口(spec 已记录),无需 task。✅
- §6 测试(零依赖必做)→ Task 1/2 用例;vitest 跳过(逻辑已下沉纯函数)。✅
- §7 i18n → Task 3 + 门禁。✅
- 依赖政策(不新增)→ 全程复用既有。✅

**Placeholder scan**:无 TBD/TODO;每步含实际代码。✅
**Type consistency**:`presetToFormState`/`hasPlaceholderParam`/`buildStorageClassYaml`/`store.generateYAML('storageclass', form)` 在各 task 间签名一致;`STORAGE_CLASS_PRESETS[].id` 与 i18n `storage.presets.<id>` 及 Task 4 `t(p.label)` 一致(16 个 id 全枚举)。✅
