# 容器环境变量编辑器重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 环境变量域单源化——统一行模型(五类型)+ envFrom 多行数组,一个纯逻辑模块 + 一个共享组件收编五个消费面,根治 3 个静默丢数据缺陷与「假单选框」交互混乱。

**Architecture:** 新 `src/logic/envRefs.js`(零依赖纯函数,模型/序列化/反解/校验/计数,往返无损)+ 新 `src/components/common/ContainerEnvEditor.vue`(统一行列表 + envFrom 小节,复用 EnvSourceField);五个消费面(DeployApp 向导、ContainerEditorDialog、subContainer.js、NsWorkloadDetail 编辑壳、useWorkloadToForm)逐一迁移。

**Tech Stack:** Vue 3 `<script setup>` + defineModel(纯 JS)、node:test 零依赖运行器(纯逻辑)、vitest + happy-dom(组件)、vue-i18n、js-yaml(已有依赖,不新增)。

**Spec:** `docs/superpowers/specs/2026-09-05-container-env-editor-design.md`(计划从 spec 出发,执行者两份都读)

## Global Constraints

- 仓库不新增任何外部依赖(js-yaml/vue-i18n 均为既有依赖)。
- 提交作者恒为 `aliang-one <aliangdone@gmail.com>`(提交命令带 `-c user.name=aliang-one -c user.email=aliangdone@gmail.com`,提交后 `git show -s --format='%an %ae' HEAD` 核验);**提交信息英文、禁止 Co-Authored-By 尾注**。
- 所有编辑必须用 worktree 绝对路径:`/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat-container-env-editor/`(下文以 `WS/` 代指)。
- `src/` 禁中文字面量;新键必须 zh+en 双语对齐(`npm run i18n:check` 三合一门禁)。
- 新模板必须过 overflow-guard 静态扫(flex 链 `min-w-0`、列向 truncate 带 `w-full`);触屏命中区伪元素四件套(after:* 含 content-[''])。
- 每个任务结束:任务内测试绿 + `git branch --show-current` 核验在 `worktree-feat-container-env-editor` 分支。
- 工作目录:`cd /home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat-container-env-editor`。

## 对 spec 的一处显式细化(实现时以此为准)

spec §3 的 `envFromErrors`:envFrom 行唯一必填字段就是 name,「空行」与「半行」重合。裁决:**name 为空的 envFrom 行 = 未填行,序列化跳过、不报错**(与 Kite filter-on-serialize 一致,避免「加了行没填就提交被拦」)。因此 API 不含独立 `envFromErrors` 函数;env 行(5 字段)仍严格「空行跳过、半行报错」。

---

### Task 1: envRefs 纯逻辑模块(TDD)

**Files:**
- Create: `WS/src/logic/envRefs.js`
- Create: `WS/src/logic/envRefs.test.mjs`
- Modify: `WS/package.json`(test:server 注册新测试文件)

**Interfaces(Produces,后续所有任务依赖):**
```js
ENV_ROW_TYPES // ['value','configMapKeyRef','secretKeyRef','fieldRef','resourceFieldRef']
makeEnvRow(type)  // { name:'', type, <类型字段>, passthrough: undefined }
makeEnvFromRow(kind) // { kind:'configmap'|'secret', name:'', passthrough: undefined }
envRowsToSpec(rows)         // → K8s env 数组(无名/不完整行跳过;passthrough 回吐;保序)
envRowsFromSpec(envArr)     // → 行数组(五类型全识别;未建模子字段→row.passthrough;未知 valueFrom→passthrough.valueFrom 整体保真)
envFromRowsToSpec(rows)     // → K8s envFrom 数组(passthrough 行原样回吐;空名跳过)
envFromRowsFromSpec(arr)    // → 行数组(全数组、保序;条目级剩余键如 prefix→passthrough)
envRefErrors(rows)          // → [{ index, name, type, missing: ['name'|字段...] }](空行跳过)
duplicateEnvNames(rows)     // → 首个重复名(trim 后比较,空名跳过)或 null
envRowCount(rows, fromRows) // → 已填 name 的行数(badge 用)
envSectionEmpty(rows, fromRows) // → 任一行任一字段非空则 false
rowNonEmpty(row)            // 单行是否碰过任何字段
ENV_TYPE_LABEL_KEYS         // { value: 'deploy.envType.value', ... } 全字面量键表(i18n 门禁禁拼接键)
ENV_FIELD_LABEL_KEYS        // { name: 'deploy.envRowName', cmName: 'deploy.envField.cmName', ... }
```
行形状:`{ name, type, value? | cmName,key? | secretName,key? | fieldPath? | resource,containerName,divisor?, passthrough? }`。

- [ ] **Step 1: 写失败测试** `WS/src/logic/envRefs.test.mjs`:

```js
// 环境变量域单源:统一行模型 <-> K8s env/envFrom 的往返与校验。
// spec: docs/superpowers/specs/2026-09-05-container-env-editor-design.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENV_ROW_TYPES, makeEnvRow, makeEnvFromRow,
  envRowsToSpec, envRowsFromSpec, envFromRowsToSpec, envFromRowsFromSpec,
  envRefErrors, duplicateEnvNames, envRowCount, envSectionEmpty, rowNonEmpty,
  ENV_TYPE_LABEL_KEYS, ENV_FIELD_LABEL_KEYS,
} from './envRefs.js'
import { readFileSync } from 'node:fs'

test('i18n 标签键表:每个键在 zh/en locale 均存在(门禁 dangling 防线)', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [p + k])
  const zh = new Set(flat(JSON.parse(readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'))))
  const en = new Set(flat(JSON.parse(readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'))))
  for (const key of [...Object.values(ENV_TYPE_LABEL_KEYS), ...Object.values(ENV_FIELD_LABEL_KEYS)]) {
    assert.ok(zh.has(key), `zh 缺 ${key}`)
    assert.ok(en.has(key), `en 缺 ${key}`)
  }
})

test('makeEnvRow: 五类型字段形状', () => {
  assert.deepEqual(makeEnvRow('value'), { name: '', type: 'value', value: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('configMapKeyRef'), { name: '', type: 'configMapKeyRef', cmName: '', key: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('secretKeyRef'), { name: '', type: 'secretKeyRef', secretName: '', key: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('fieldRef'), { name: '', type: 'fieldRef', fieldPath: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('resourceFieldRef'), { name: '', type: 'resourceFieldRef', resource: '', containerName: '', divisor: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('nonsense'), makeEnvRow('value'))
})

test('envRowsToSpec: 五类型 → K8s env,保序,无名/不完整行跳过', () => {
  const rows = [
    { name: 'A', type: 'value', value: 'plain' },
    { name: '', type: 'value', value: 'no-name' },          // 无名跳过
    { name: 'B', type: 'configMapKeyRef', cmName: 'cm1', key: 'k1' },
    { name: 'C', type: 'configMapKeyRef', cmName: '', key: 'k2' }, // 不完整跳过
    { name: 'D', type: 'secretKeyRef', secretName: 's1', key: 'sk' },
    { name: 'E', type: 'fieldRef', fieldPath: 'metadata.name' },
    { name: 'F', type: 'resourceFieldRef', resource: 'requests.cpu' },
    { name: 'G', type: 'resourceFieldRef', resource: 'limits.memory', containerName: 'main', divisor: '1m' },
  ]
  assert.deepEqual(envRowsToSpec(rows), [
    { name: 'A', value: 'plain' },
    { name: 'B', valueFrom: { configMapKeyRef: { name: 'cm1', key: 'k1' } } },
    { name: 'D', valueFrom: { secretKeyRef: { name: 's1', key: 'sk' } } },
    { name: 'E', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'F', valueFrom: { resourceFieldRef: { resource: 'requests.cpu' } } },
    { name: 'G', valueFrom: { resourceFieldRef: { resource: 'limits.memory', containerName: 'main', divisor: '1m' } } },
  ])
})

test('envRowsToSpec: 直填空串显式产出(value: "")', () => {
  assert.deepEqual(envRowsToSpec([{ name: 'EMPTY', type: 'value', value: '' }]), [{ name: 'EMPTY', value: '' }])
})

test('往返无损:全类型 spec → rows → spec 恒等(含顺序)', () => {
  const env = [
    { name: 'A', value: 'x' },
    { name: 'B', valueFrom: { configMapKeyRef: { name: 'cm', key: 'k' } } },
    { name: 'C', valueFrom: { secretKeyRef: { name: 's', key: 'k', optional: true } } },
    { name: 'D', valueFrom: { fieldRef: { fieldPath: 'status.podIP', apiVersion: 'v1' } } },
    { name: 'E', valueFrom: { resourceFieldRef: { resource: 'requests.cpu', divisor: '1m' } } },
  ]
  assert.deepEqual(envRowsToSpec(envRowsFromSpec(env)), env)
})

test('往返无损:未知 valueFrom 形态整体透传', () => {
  const env = [{ name: 'X', valueFrom: { futureRef: { thing: 1 } } }]
  assert.deepEqual(envRowsToSpec(envRowsFromSpec(env)), env)
  const rows = envRowsFromSpec(env)
  assert.equal(rows[0].type, 'value')
  assert.deepEqual(rows[0].passthrough, { valueFrom: { futureRef: { thing: 1 } } })
})

test('envFrom: 多行保序往返 + prefix 条目级剩余键保留 + 未知形态透传', () => {
  const arr = [
    { prefix: 'MY_', configMapRef: { name: 'cm1' } },
    { secretRef: { name: 's1' } },
    { configMapRef: { name: 'cm2' } },
  ]
  const rows = envFromRowsFromSpec(arr)
  assert.deepEqual(rows[0], { kind: 'configmap', name: 'cm1', passthrough: { prefix: 'MY_' } })
  assert.equal(rows[1].kind, 'secret')
  assert.deepEqual(envFromRowsToSpec(rows), arr)
  const weird = [{ unknownRef: { x: 1 } }]
  assert.deepEqual(envFromRowsToSpec(envFromRowsFromSpec(weird)), weird)
})

test('envFrom: 空名行跳过、kind 归一', () => {
  assert.deepEqual(envFromRowsToSpec([
    { kind: 'configmap', name: '' },
    { kind: 'secret', name: ' s2 ' },
    { kind: 'weird', name: 'w1' }, // 未知 kind 按 configMapRef 兜底
  ]), [{ secretRef: { name: 's2' } }, { configMapRef: { name: 'w1' } }])
})

test('envRefErrors: 空行跳过、半行报 missing(name 缺失排首位)', () => {
  const errs = envRefErrors([
    { name: '', type: 'value', value: '' },                                    // 空行
    { name: 'OK', type: 'value', value: '' },                                  // 直填允许空值
    { name: 'H1', type: 'value', value: 'v' },
    { name: '', type: 'configMapKeyRef', cmName: 'cm', key: 'k' },             // 缺 name
    { name: 'H2', type: 'secretKeyRef', secretName: 's', key: '' },            // 缺 key
    { name: 'H3', type: 'fieldRef', fieldPath: '' },                           // 缺 fieldPath
    { name: '', type: 'resourceFieldRef', resource: '', containerName: '' },   // 缺 name+resource
  ])
  assert.deepEqual(errs, [
    { index: 3, name: '', type: 'configMapKeyRef', missing: ['name'] },
    { index: 4, name: 'H2', type: 'secretKeyRef', missing: ['key'] },
    { index: 5, name: 'H3', type: 'fieldRef', missing: ['fieldPath'] },
    { index: 6, name: '', type: 'resourceFieldRef', missing: ['name', 'resource'] },
  ])
})

test('duplicateEnvNames / 计数 / 空判', () => {
  assert.equal(duplicateEnvNames([{ name: 'A' }, { name: ' a ' }, { name: 'B' }]), 'A')
  assert.equal(duplicateEnvNames([{ name: '' }, { name: 'B' }]), null)
  assert.equal(envRowCount([{ name: 'A' }, { name: '' }, { name: 'C' }], [{ kind: 'configmap', name: 'cm' }]), 3)
  assert.equal(envSectionEmpty([], []), true)
  assert.equal(envSectionEmpty([{ name: '', type: 'value', value: '' }], []), true)
  assert.equal(envSectionEmpty([{ name: '', type: 'value', value: 'v' }], []), false)
  assert.equal(envSectionEmpty([], [{ kind: 'configmap', name: '' }]), true)
  assert.equal(rowNonEmpty(null), false)
})
```

- [ ] **Step 2: 跑测试确认失败**:`cd WS && node --test src/logic/envRefs.test.mjs` → FAIL(模块不存在)。
- [ ] **Step 3: 实现** `WS/src/logic/envRefs.js`:

```js
// 环境变量域模块:统一行模型 <-> K8s env/envFrom 的单一事实源。
// 设计:docs/superpowers/specs/2026-09-05-container-env-editor-design.md
// 类型是行属性(直填/CM Key/Secret Key/字段引用/容器资源);envFrom 是有序多行数组。
// 铁律:往返无损——反解未建模的子字段/形态收进 row.passthrough,序列化原样回吐,
// 从机制上杜绝「编辑保存静默丢配置」(曾致 fieldRef/多 envFrom 丢失,2026-09-05)。
// 空行跳过、半行报错(env 行);envFrom 行唯一字段即 name,空行直接跳过。
// 纯函数、无 Vue 依赖,node:test 零依赖可测。

export const ENV_ROW_TYPES = ['value', 'configMapKeyRef', 'secretKeyRef', 'fieldRef', 'resourceFieldRef']

// 每类型的表单字段与必填集(value 的 value 允许空串,故 required 不含 value)
const TYPE_FIELDS = {
  value:            { fields: ['value'], required: [] },
  configMapKeyRef:  { fields: ['cmName', 'key'], required: ['cmName', 'key'] },
  secretKeyRef:     { fields: ['secretName', 'key'], required: ['secretName', 'key'] },
  fieldRef:         { fields: ['fieldPath'], required: ['fieldPath'] },
  resourceFieldRef: { fields: ['resource', 'containerName', 'divisor'], required: ['resource'] },
}
// source 内已建模键;其余(如 optional/apiVersion)走 passthrough
const SOURCE_MODELED = {
  configMapKeyRef: ['name', 'key'],
  secretKeyRef: ['name', 'key'],
  fieldRef: ['fieldPath'],
  resourceFieldRef: ['resource', 'containerName', 'divisor'],
}
const s = v => (v == null ? '' : String(v))
const nonEmpty = v => s(v).trim() !== ''
const clone = o => JSON.parse(JSON.stringify(o))

export function makeEnvRow(type = 'value') {
  const spec = TYPE_FIELDS[type] || TYPE_FIELDS.value
  const row = { name: '', type: TYPE_FIELDS[type] ? type : 'value', passthrough: undefined }
  for (const f of spec.fields) row[f] = ''
  return row
}

export function makeEnvFromRow(kind = 'configmap') {
  return { kind: kind === 'secret' ? 'secret' : 'configmap', name: '', passthrough: undefined }
}

export function envRowsToSpec(rows = []) {
  const out = []
  for (const r of rows || []) {
    if (!r || !nonEmpty(r.name)) continue
    const name = s(r.name).trim()
    const known = ENV_ROW_TYPES.includes(r.type) && r.type !== 'value'
    if (!known) {
      const entry = { name, value: s(r.value) }
      if (r.passthrough?.valueFrom) entry.valueFrom = clone(r.passthrough.valueFrom)
      out.push(entry)
      continue
    }
    const required = TYPE_FIELDS[r.type].required
    if (!required.every(f => nonEmpty(r[f]))) continue // 序列化只收完整行(校验是第一道)
    const src = {}
    for (const f of SOURCE_MODELED[r.type]) if (nonEmpty(r[f])) src[f] = s(r[f]).trim()
    if (r.passthrough && !r.passthrough.valueFrom) Object.assign(src, clone(r.passthrough))
    out.push({ name, valueFrom: { [r.type]: src } })
  }
  return out
}

function rowFromSource(srcKey, src) {
  const modeled = SOURCE_MODELED[srcKey]
  const row = { type: srcKey }
  for (const f of modeled) row[f] = s(src[f])
  const rest = Object.fromEntries(Object.entries(src).filter(([k]) => !modeled.includes(k)))
  if (Object.keys(rest).length) row.passthrough = rest
  return row
}

export function envRowsFromSpec(envArr = []) {
  return (envArr || []).map(e => {
    e = e || {}
    const vf = e.valueFrom
    if (vf && typeof vf === 'object' && !Array.isArray(vf)) {
      const srcKey = Object.keys(SOURCE_MODELED).find(k => vf[k] && typeof vf[k] === 'object')
      if (srcKey) {
        const row = { name: s(e.name), ...rowFromSource(srcKey, vf[srcKey]) }
        const restVf = Object.fromEntries(Object.entries(vf).filter(([k]) => k !== srcKey))
        if (Object.keys(restVf).length) row.passthrough = { ...(row.passthrough || {}), ...restVf }
        return row
      }
      return { name: s(e.name), type: 'value', value: s(e.value), passthrough: { valueFrom: vf } }
    }
    return { name: s(e.name), type: 'value', value: s(e.value) }
  })
}

export function envFromRowsToSpec(rows = []) {
  const out = []
  for (const r of rows || []) {
    if (!r) continue
    if (!nonEmpty(r.name)) {
      if (r.passthrough) out.push(clone(r.passthrough)) // 未知形态透传行
      continue
    }
    const refKey = r.kind === 'secret' ? 'secretRef' : 'configMapRef'
    const entry = { [refKey]: { name: s(r.name).trim() } }
    if (r.passthrough && Object.keys(r.passthrough).length) Object.assign(entry, clone(r.passthrough))
    out.push(entry)
  }
  return out
}

export function envFromRowsFromSpec(arr = []) {
  return (arr || []).map(e => {
    e = e || {}
    if (e.configMapRef || e.secretRef) {
      const kind = e.configMapRef ? 'configmap' : 'secret'
      const refKey = kind === 'configmap' ? 'configMapRef' : 'secretRef'
      const row = { kind, name: s(e[refKey]?.name) }
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k !== refKey))
      if (Object.keys(rest).length) row.passthrough = rest
      return row
    }
    return { kind: 'configmap', name: '', passthrough: clone(e) } // 未知形态整体透传
  })
}

export function envRefErrors(rows = []) {
  const errs = []
  ;(rows || []).forEach((r, index) => {
    if (!r) return
    const type = TYPE_FIELDS[r.type] ? r.type : 'value'
    const spec = TYPE_FIELDS[type]
    const all = ['name', ...spec.fields]
    if (all.every(f => !nonEmpty(r[f]))) return // 整行空 → 跳过
    const missing = spec.required.filter(f => !nonEmpty(r[f]))
    if (!nonEmpty(r.name)) missing.unshift('name')
    if (missing.length) errs.push({ index, name: s(r.name), type, missing })
  })
  return errs
}

export function duplicateEnvNames(rows = []) {
  const seen = new Set()
  for (const r of rows || []) {
    const k = s(r?.name).trim()
    if (!k) continue
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}

export function rowNonEmpty(r) {
  if (!r) return false
  const type = TYPE_FIELDS[r.type] ? r.type : 'value'
  return ['name', ...TYPE_FIELDS[type].fields].some(f => nonEmpty(r[f]))
}

export function envRowCount(rows = [], fromRows = []) {
  return (rows || []).filter(r => nonEmpty(r?.name)).length + (fromRows || []).filter(r => nonEmpty(r?.name)).length
}

export function envSectionEmpty(rows = [], fromRows = []) {
  if ((rows || []).some(rowNonEmpty)) return false
  if ((fromRows || []).some(r => nonEmpty(r?.name))) return false
  return true
}

// i18n 全字面量键表(i18n:check 门禁禁拼接键,曾致 'xxx.' + var 被 dangling 判红):
// 消费方以 t(ENV_TYPE_LABEL_KEYS[type]) / t(ENV_FIELD_LABEL_KEYS[f]) 取文案。
export const ENV_TYPE_LABEL_KEYS = {
  value: 'deploy.envType.value',
  configMapKeyRef: 'deploy.envType.configMapKeyRef',
  secretKeyRef: 'deploy.envType.secretKeyRef',
  fieldRef: 'deploy.envType.fieldRef',
  resourceFieldRef: 'deploy.envType.resourceFieldRef',
}
export const ENV_FIELD_LABEL_KEYS = {
  name: 'deploy.envRowName',
  cmName: 'deploy.envField.cmName',
  secretName: 'deploy.envField.secretName',
  key: 'deploy.envField.key',
  fieldPath: 'deploy.envField.fieldPath',
  resource: 'deploy.envField.resource',
  containerName: 'deploy.envField.containerName',
  divisor: 'deploy.envField.divisor',
}
```

- [ ] **Step 4: 跑测试确认通过**:`node --test src/logic/envRefs.test.mjs` → 全 PASS。
- [ ] **Step 5: 注册进 test:server**。`WS/package.json:14` 的 `test:server` 值中,在 `&& node --test src/logic/subContainer.test.mjs` 之后追加 `&& node --test src/logic/envRefs.test.mjs`。
- [ ] **Step 6: 门禁**:`npm run test:server` → 全绿(其余任务同理,凡门禁失败先修再走)。
- [ ] **Step 7: 提交**:

```bash
git add src/logic/envRefs.js src/logic/envRefs.test.mjs package.json
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "feat(env): envRefs pure logic module — unified env row model (5 valueFrom types), ordered envFrom rows, lossless round-trip with passthrough"
git show -s --format='%an %ae' HEAD
```

---

### Task 2: ContainerEnvEditor 共享组件 + 组件测试 + i18n 键

**Files:**
- Create: `WS/src/components/common/ContainerEnvEditor.vue`
- Create: `WS/src/components/__tests__/ContainerEnvEditor.test.js`
- Modify: `WS/src/locales/zh.json` + `WS/src/locales/en.json`(deploy 组内追加键)
- Check: `WS/src/components/__tests__/_allComponentsMount.test.js`(若为清单制,登记新组件)

**Interfaces:**
- Consumes: Task 1 全部 API;既有 `EnvSourceField`(props `kind/namespace/withKey/size`,`v-model:name`、`v-model:dataKey`)。
- Produces: `<ContainerEnvEditor v-model:env="rows" v-model:env-from="fromRows" :namespace="ns" size="sm|md" />`;行对象直接以 Task 1 形状就地变异(父级传响应式数组,与 CED draft 同模式)。

- [ ] **Step 1: 加 i18n 键(zh.json 的 `"deploy"` 组内、`"envDuplicateName"` 附近插入;en.json 同位对齐)**:

zh:
```json
"envRowsGroup": "环境变量",
"envRowsAdd": "添加变量",
"envRowName": "变量名",
"envRowType": "类型",
"envRowNamePh": "变量名",
"envType": {
  "value": "直填值",
  "configMapKeyRef": "ConfigMap Key",
  "secretKeyRef": "Secret Key",
  "fieldRef": "字段引用",
  "resourceFieldRef": "容器资源"
},
"envField": {
  "cmName": "ConfigMap 名",
  "secretName": "Secret 名",
  "key": "Key",
  "fieldPath": "字段路径",
  "resource": "资源名",
  "containerName": "容器名",
  "divisor": "除数"
},
"envFieldPathPh": "如 metadata.name",
"envResourcePh": "如 requests.cpu",
"envRowMissing": "环境变量 {name}：缺少 {fields}",
"envFromRowsGroup": "整批导入 envFrom",
"envFromRowsHint": "资源的全部 KEY 会成为同名环境变量，无需逐个填变量名",
"envFromRowsAdd": "添加来源",
```
en:
```json
"envRowsGroup": "Environment Variables",
"envRowsAdd": "Add Variable",
"envRowName": "Variable name",
"envRowType": "Type",
"envRowNamePh": "variable name",
"envType": {
  "value": "Direct value",
  "configMapKeyRef": "ConfigMap Key",
  "secretKeyRef": "Secret Key",
  "fieldRef": "Field reference",
  "resourceFieldRef": "Container resource"
},
"envField": {
  "cmName": "ConfigMap name",
  "secretName": "Secret name",
  "key": "Key",
  "fieldPath": "Field path",
  "resource": "Resource",
  "containerName": "Container name",
  "divisor": "Divisor"
},
"envFieldPathPh": "e.g. metadata.name",
"envResourcePh": "e.g. requests.cpu",
"envRowMissing": "Env {name}: missing {fields}",
"envFromRowsGroup": "Bulk import (envFrom)",
"envFromRowsHint": "Every KEY of the resource becomes an env variable of the same name — no per-key names needed",
"envFromRowsAdd": "Add Source",
```

- [ ] **Step 2: 写失败组件测试** `WS/src/components/__tests__/ContainerEnvEditor.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ContainerEnvEditor from '../common/ContainerEnvEditor.vue'

const mountIt = (env = [], envFrom = []) => mount(ContainerEnvEditor, {
  props: { env, envFrom, namespace: 'ns1', size: 'md' },
  global: { stubs: { EnvSourceField: { template: '<div class="esf-stub" />' } } },
})

describe('ContainerEnvEditor', () => {
  it('加行:默认直填行入列并可删', async () => {
    const w = mountIt()
    await w.find('[data-testid="ceed-add-env"]').trigger('click')
    expect(w.props('env')).toHaveLength(1)
    expect(w.props('env')[0].type).toBe('value')
    await w.find('[data-testid="ceed-del-env-0"]').trigger('click')
    expect(w.props('env')).toHaveLength(0)
  })

  it('切类型:保留 name、其余字段重置为新类型形状', async () => {
    const env = [{ name: 'DB', type: 'value', value: 'x', passthrough: undefined }]
    const w = mountIt(env)
    await w.find('[data-testid="ceed-type-0"]').setValue('secretKeyRef')
    expect(w.props('env')[0].name).toBe('DB')
    expect(w.props('env')[0].type).toBe('secretKeyRef')
    expect(w.props('env')[0].secretName).toBe('')
    expect(w.props('env')[0].value).toBeUndefined()
  })

  it('CM/Secret 行渲染 EnvSourceField(kind 正确)', async () => {
    const env = [
      { name: 'A', type: 'configMapKeyRef', cmName: 'cm', key: 'k' },
      { name: 'B', type: 'secretKeyRef', secretName: 's', key: 'k' },
    ]
    const w = mountIt(env)
    const stubs = w.findAll('.esf-stub')
    expect(stubs.length).toBeGreaterThanOrEqual(2)
  })

  it('envFrom:加行默认 configmap,可切 secret,可删', async () => {
    const w = mountIt()
    await w.find('[data-testid="ceed-add-from"]').trigger('click')
    expect(w.props('envFrom')[0].kind).toBe('configmap')
    await w.find('[data-testid="ceed-from-kind-0"]').setValue('secret')
    expect(w.props('envFrom')[0].kind).toBe('secret')
    await w.find('[data-testid="ceed-del-from-0"]').trigger('click')
    expect(w.props('envFrom')).toHaveLength(0)
  })

  it('fieldRef/resourceFieldRef 行渲染对应输入', async () => {
    const env = [
      { name: 'P', type: 'fieldRef', fieldPath: 'metadata.name' },
      { name: 'R', type: 'resourceFieldRef', resource: 'requests.cpu', containerName: '', divisor: '' },
    ]
    const w = mountIt(env)
    expect(w.find('[data-testid="ceed-fieldpath-0"]').exists()).toBe(true)
    expect(w.find('[data-testid="ceed-resref-resource-1"]').exists()).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**:`npx vitest run src/components/__tests__/ContainerEnvEditor.test.js` → FAIL(组件不存在)。
- [ ] **Step 4: 实现组件** `WS/src/components/common/ContainerEnvEditor.vue`:

```vue
<script setup>
// 容器环境变量统一编辑器(五消费面共享):统一行列表(类型是行属性)+ 整批导入 envFrom 多行数组。
// 设计:docs/superpowers/specs/2026-09-05-container-env-editor-design.md;行模型/校验在 logic/envRefs.js。
// 资源名/key 选择复用 EnvSourceField;type 切换保留 name、重置类型字段(与 Kite 行为一致)。
import { useI18n } from 'vue-i18n'
import EnvSourceField from './EnvSourceField.vue'
import { makeEnvRow, makeEnvFromRow, ENV_ROW_TYPES, ENV_TYPE_LABEL_KEYS } from '@/logic/envRefs'

const props = defineProps({
  namespace: { type: String, default: '' },
  size: { type: String, default: 'md' }, // 'sm'(CED/编辑壳) | 'md'(创建向导)
})
const env = defineModel('env', { type: Array, default: () => [] })
const envFrom = defineModel('envFrom', { type: Array, default: () => [] })
const { t } = useI18n()

const md = props.size === 'md'
const inputCls = md
  ? 'bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono'
  : 'bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono'
const selectCls = inputCls

function addEnvRow() { env.value.push(makeEnvRow('value')) }
function delEnvRow(i) { env.value.splice(i, 1) }
function addFromRow() { envFrom.value.push(makeEnvFromRow('configmap')) }
function delFromRow(i) { envFrom.value.splice(i, 1) }

// 切类型:保留 name,清掉旧类型字段与 passthrough(用户主动改型=放弃旧值)
function onTypeChange(row, ev) {
  const next = makeEnvRow(ev.target.value)
  const name = row.name
  Object.keys(row).forEach(k => delete row[k])
  Object.assign(row, next, { name })
}
</script>

<template>
  <div class="flex flex-col gap-sm min-w-0">
    <!-- 环境变量(统一行列表) -->
    <div class="flex items-center gap-sm min-w-0">
      <span class="text-xs font-semibold text-on-surface-variant truncate">{{ $t('deploy.envRowsGroup') }}</span>
      <button type="button" data-testid="ceed-add-env" @click="addEnvRow"
        class="ml-auto flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg shrink-0">
        <span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.envRowsAdd') }}
      </button>
    </div>
    <div v-for="(row, i) in env" :key="'er' + i"
      class="rounded-lg border border-outline-variant/60 bg-surface-container-low/30 p-sm flex flex-col gap-xs min-w-0">
      <div class="flex gap-sm items-center min-w-0 flex-wrap">
        <input v-model="row.name" :data-testid="'ceed-name-' + i" :class="inputCls"
          class="w-40 flex-shrink-0 min-w-0" :placeholder="$t('deploy.envRowNamePh')" />
        <select :value="ENV_ROW_TYPES.includes(row.type) ? row.type : 'value'" :data-testid="'ceed-type-' + i"
          :class="selectCls" class="flex-shrink-0 min-w-0" @change="onTypeChange(row, $event)">
          <option v-for="(labelKey, tp) in ENV_TYPE_LABEL_KEYS" :key="tp" :value="tp">{{ $t(labelKey) }}</option>
        </select>
        <input v-if="!ENV_ROW_TYPES.includes(row.type) || row.type === 'value'" v-model="row.value"
          :data-testid="'ceed-value-' + i" :class="inputCls" class="flex-1 min-w-0" placeholder="value" />
        <button type="button" :data-testid="'ceed-del-env-' + i" @click="delEnvRow(i)"
          class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-base">delete</span>
        </button>
      </div>
      <div v-if="row.type === 'configMapKeyRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <EnvSourceField kind="configmap" :namespace="namespace" :size="size" class="flex-1 min-w-0"
          v-model:name="row.cmName" v-model:dataKey="row.key" />
      </div>
      <div v-else-if="row.type === 'secretKeyRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <EnvSourceField kind="secret" :namespace="namespace" :size="size" class="flex-1 min-w-0"
          v-model:name="row.secretName" v-model:dataKey="row.key" />
      </div>
      <div v-else-if="row.type === 'fieldRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <input v-model="row.fieldPath" :data-testid="'ceed-fieldpath-' + i" :class="inputCls"
          class="flex-1 min-w-0" :placeholder="$t('deploy.envFieldPathPh')" :aria-label="$t('deploy.envField.fieldPath')" />
      </div>
      <div v-else-if="row.type === 'resourceFieldRef'" class="grid grid-cols-1 sm:grid-cols-3 gap-sm min-w-0 pl-0 sm:pl-6">
        <input v-model="row.resource" :data-testid="'ceed-resref-resource-' + i" :class="inputCls"
          class="min-w-0" :placeholder="$t('deploy.envResourcePh')" :aria-label="$t('deploy.envField.resource')" />
        <input v-model="row.containerName" :data-testid="'ceed-resref-container-' + i" :class="inputCls"
          class="min-w-0" :placeholder="$t('deploy.envField.containerName')" />
        <input v-model="row.divisor" :data-testid="'ceed-resref-divisor-' + i" :class="inputCls"
          class="min-w-0" placeholder="1m" />
      </div>
    </div>

    <!-- 整批导入 envFrom -->
    <div class="flex items-center gap-sm min-w-0 mt-xs">
      <span class="text-xs font-semibold text-on-surface-variant truncate">{{ $t('deploy.envFromRowsGroup') }}</span>
      <span class="text-xs text-on-surface-variant/70 truncate hidden sm:inline">{{ $t('deploy.envFromRowsHint') }}</span>
      <button type="button" data-testid="ceed-add-from" @click="addFromRow"
        class="ml-auto flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg shrink-0">
        <span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.envFromRowsAdd') }}
      </button>
    </div>
    <p class="text-xs text-on-surface-variant/70 sm:hidden">{{ $t('deploy.envFromRowsHint') }}</p>
    <div v-for="(row, i) in envFrom" :key="'fr' + i" class="flex gap-sm items-center min-w-0 flex-wrap">
      <select v-model="row.kind" :data-testid="'ceed-from-kind-' + i" :class="selectCls" class="flex-shrink-0 min-w-0">
        <option value="configmap">ConfigMap</option>
        <option value="secret">Secret</option>
      </select>
      <EnvSourceField :kind="row.kind === 'secret' ? 'secret' : 'configmap'" :namespace="namespace" :with-key="false"
        :size="size" class="flex-1 min-w-0" v-model:name="row.name" />
      <button type="button" :data-testid="'ceed-del-from-' + i" @click="delFromRow(i)"
        class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 跑组件测试通过**:`npx vitest run src/components/__tests__/ContainerEnvEditor.test.js` → PASS。若 `_allComponentsMount.test.js` 为组件清单制(grep `ContainerEditorDialog` 确认),按同文件模式登记 `ContainerEnvEditor`。
- [ ] **Step 6: i18n 门禁**:`npm run i18n:check` → 绿。
- [ ] **Step 7: 提交**:

```bash
git add src/components/common/ContainerEnvEditor.vue src/components/__tests__/ContainerEnvEditor.test.js src/components/__tests__/_allComponentsMount.test.js src/locales/zh.json src/locales/en.json
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "feat(env): shared ContainerEnvEditor — unified row list with inline type selector + ordered envFrom section (reuses EnvSourceField)"
git show -s --format='%an %ae' HEAD
```

---

### Task 3: 子容器三件套迁移(subContainer.js + containerValidation.js + ContainerEditorDialog.vue)

**Files:**
- Modify: `WS/src/logic/subContainer.js`(:25-26 模型、:90-96 序列化、:130-141 计数、:145-158 空判、:200-203 回填)
- Modify: `WS/src/logic/containerValidation.js`(:48-60 env 校验段)
- Modify: `WS/src/components/common/ContainerEditorDialog.vue`(:27-45 draft、:54-56 addEnvRow、:188-210 环境小节)
- Modify: `WS/src/logic/subContainer.test.mjs`、`WS/src/logic/containerValidation.test.mjs`、`WS/src/views/__tests__/DeployApp.container-editor.test.js`
- Modify: `WS/src/locales/zh.json` + `en.json`(deploy.containerFv 组加 `envRowMissing`)

**Interfaces:**
- Consumes: Task 1 API;Task 2 组件。
- Produces: `makeSubContainer()` 含 `envRows: []`、`envFromRows: []`(旧五字段移除);`buildSubContainerSpec`/`mapSubContainer`/`advancedCount`/`isSubContainerEmpty` 全部新形状;`validateContainerFields` env 段消费 `draft.envRows`。

- [ ] **Step 1: 更新 subContainer.test.mjs 断言为新形状**(所有涉及 `envVars/envCMKeys/envSecretKeys/envFromConfigMap/envFromSecret` 的夹具改 `envRows/envFromRows`;新增:多 envFrom 往返、fieldRef 子容器进 spec、advancedCount/isSubContainerEmpty 新计数)。示例(替换 env 相关夹具):

```js
const FULL = () => ({
  ...makeSubContainer(),
  name: 'sc', image: 'nginx:1',
  envRows: [
    { name: 'A', type: 'value', value: 'x' },
    { name: 'B', type: 'secretKeyRef', secretName: 's', key: 'k' },
  ],
  envFromRows: [{ kind: 'configmap', name: 'cm1' }, { kind: 'secret', name: 's1' }],
})
```

新增用例:
```js
test('buildSubContainerSpec: env/envFrom 新模型(多 envFrom 保序、fieldRef 进 spec)', () => {
  const spec = buildSubContainerSpec(FULL(), {})
  assert.deepEqual(spec.env, [
    { name: 'A', value: 'x' },
    { name: 'B', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } },
  ])
  assert.deepEqual(spec.envFrom, [{ configMapRef: { name: 'cm1' } }, { secretRef: { name: 's1' } }])
})

test('mapSubContainer: 多 envFrom 与 fieldRef 回填不丢(D1/D2 子容器侧)', () => {
  const spec = { env: [{ name: 'N', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }], envFrom: [{ configMapRef: { name: 'a' } }, { configMapRef: { name: 'b' } }] }
  const form = mapSubContainer(spec)
  assert.equal(form.envRows[0].type, 'fieldRef')
  assert.deepEqual(form.envFromRows.map(r => r.name), ['a', 'b'])
})
```

- [ ] **Step 2: 跑 `node --test src/logic/subContainer.test.mjs` → FAIL**。
- [ ] **Step 3: 改 subContainer.js**:

`makeSubContainer`(:24-26 一段)替换:
```js
    envRows: [], envFromRows: [],
```
(删除 `envVars: [], envFromConfigMap: '', envFromSecret: '', envCMKeys: [], envSecretKeys: [],`)

`buildSubContainerSpec` 的 env/envFrom 段(:89-96)替换:
```js
  const env = envRowsToSpec(c.envRows)
  if (env.length) o.env = env
  const envFrom = envFromRowsToSpec(c.envFromRows)
  if (envFrom.length) o.envFrom = envFrom
```
顶部 import 增加:
```js
import { envRowsToSpec, envFromRowsToSpec, envRowsFromSpec, envFromRowsFromSpec, envRowCount, envSectionEmpty } from './envRefs.js'
```

`advancedCount`(:130-133 一段)替换:
```js
  n += envRowCount(c.envRows, c.envFromRows)
```

`isSubContainerEmpty`(:147-152 的 env 三行)替换:
```js
  if (!envSectionEmpty(c.envRows, c.envFromRows)) return false
```

`mapSubContainer` 的 env 回填(:199-203)替换:
```js
    envRows: envRowsFromSpec(spec.env),
    envFromRows: envFromRowsFromSpec(spec.envFrom),
```

- [ ] **Step 4: 改 containerValidation.js**(env 段 :48-59 整段替换;顶部 `import { envRefErrors } from './envRefs.js'`,删除 `isEmptyEnvRow, firstDuplicateEnvName` 的 env 用法——若 ports 段仍用 isEmptyEnvRow 则保留该 import):

```js
  // env:统一行模型;空行跳过、半行报(CED 语境用精简文案,精确字段清单在创建/编辑主面)
  for (const e of envRefErrors(c.envRows || []))
    errs.push({ field: 'env', msgKey: 'deploy.containerFv.envRowMissing', params: { name: e.name || `#${e.index + 1}` } })
```
(`deploy.containerFv.envMissingKey` 若无他消费方,本任务末尾 grep 后删除。)

- [ ] **Step 5: zh/en 加键** `deploy.containerFv.envRowMissing`:zh `"环境变量 {name}：字段不完整，请补全该行必填项"` / en `"Env {name}: incomplete row — fill in the required fields"`。同法核删 `deploy.containerFv.envMissingKey`。
- [ ] **Step 6: 改 ContainerEditorDialog.vue**:
  - import 区:`import ContainerEnvEditor from './ContainerEnvEditor.vue'`;`addEnvRow` 函数删除(:54-56)。
  - `cloneDraft`(:30-32 三行)替换:
    ```js
    envRows: (c.envRows || []).map(e => ({ ...e })),
    envFromRows: (c.envFromRows || []).map(e => ({ ...e })),
    ```
  - 环境小节(:185-211 的三堆 + envFrom grid 整段)替换为:
    ```vue
    <div v-show="openSect.env" class="flex flex-col gap-sm mt-sm">
      <ContainerEnvEditor v-model:env="draft.envRows" v-model:env-from="draft.envFromRows" :namespace="namespace" size="sm" @focusout.capture="markTouched('env')" />
      <p v-if="showErr('env')" data-testid="ced-env-error" class="text-xs text-error">{{ t(showErr('env').msgKey, showErr('env').params) }}</p>
    </div>
    ```
    (外层 `<div v-show="openSect.env" ...>` 与 `<p v-if=ced-env-error>` 用上面的新块替换,`ced-env-toggle` 折叠头保留。)
- [ ] **Step 7: 迁移测试**:`DeployApp.container-editor.test.js` 中 env 相关 testid(`ced-env-add/ced-env-key-*/ced-envcm-*` 等)改为 ContainerEnvEditor 的 testid 或 stub 断言;`containerValidation.test.mjs` env 段夹具换 `envRows`。
- [ ] **Step 8: 门禁**:`node --test src/logic/subContainer.test.mjs && node --test src/logic/containerValidation.test.mjs && npx vitest run src/views/__tests__/DeployApp.container-editor.test.js && npm run i18n:check` → 全绿。
- [ ] **Step 9: 提交**:

```bash
git add src/logic/subContainer.js src/logic/containerValidation.js src/components/common/ContainerEditorDialog.vue src/logic/subContainer.test.mjs src/logic/containerValidation.test.mjs src/views/__tests__/DeployApp.container-editor.test.js src/locales/zh.json src/locales/en.json
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "refactor(env): subcontainer trio onto unified env model — subContainer model/build/backfill, containerValidation, ContainerEditorDialog swaps in ContainerEnvEditor"
git show -s --format='%an %ae' HEAD
```

---

### Task 4: DeployApp 主容器迁移(模型 + previewYAML + 校验 + UI 合卡)

**Files:**
- Modify: `WS/src/views/DeployApp.vue`(:17-22 import、:88-92 makeForm、:217-222 行操作、:433-452 env YAML 段、:501 DUMP_OPTS 上移、:671-672 拼接、:794-799 校验、:1147-1184 UI 两卡合一)
- Modify: `WS/src/views/__tests__/DeployApp.*.test.js`(grep env 相关断言迁移)

**Interfaces:**
- Consumes: Task 1/2/3 产物;既有 `yamlDump`(js-yaml,:17 已 import)。
- Produces: `form.envRows` / `form.envFromRows`(旧五字段删除);previewYAML 的 env/envFrom 段形状不变(`env:`/`envFrom:` 8 空格缩进)。

- [ ] **Step 1: makeForm(:88-92)替换**:
```js
  envRows: [],
  envFromRows: [],
```
- [ ] **Step 2: 行操作函数删除**(:217-222 的 `addEnvVar/removeEnvVar/addEnvCMKey/removeEnvCMKey/addEnvSecretKey/removeEnvSecretKey` 六个函数整段删除);import 区加 `import ContainerEnvEditor from '@/components/common/ContainerEnvEditor.vue'` 与 `import { envRowsToSpec, envFromRowsToSpec, envRefErrors, duplicateEnvNames } from '@/logic/envRefs'`。
- [ ] **Step 3: previewYAML env 段(:432-452)替换**(DUMP_OPTS 定义上移到本段之前,原 :501 处声明删除):
```js
  // env/envFrom:统一行模型 → spec → js-yaml dump(引号启发式与子容器同源,弃手拼)
  const DUMP_OPTS = { indent: 2, lineWidth: -1 }
  const envSpec = envRowsToSpec(f.envRows)
  const allEnvYaml = envSpec.length
    ? yamlDump(envSpec, DUMP_OPTS).trimEnd().split('\n').map(l => '        ' + l).join('\n')
    : ''
  const envFromSpec = envFromRowsToSpec(f.envFromRows)
  const envFromYaml = envFromSpec.length
    ? yamlDump(envFromSpec, DUMP_OPTS).trimEnd().split('\n').map(l => '        ' + l).join('\n')
    : ''
```
(:671-672 拼接处不变:`if (allEnvYaml) yaml += ...`、`if (envFromYaml.length) ...`——envFromYaml 由数组改字符串,把 `.join('\n')` 去掉:`if (envFromYaml) yaml += `\n        envFrom:\n${envFromYaml}``。)
- [ ] **Step 4: 校验(:795-799)替换**(import 处补 `ENV_FIELD_LABEL_KEYS`):
```js
  for (const e of envRefErrors(f.envRows)) {
    const fields = e.missing.map(m => t(ENV_FIELD_LABEL_KEYS[m])).join(' / ')
    errs.push({ step: 1, msg: t('deploy.envRowMissing', { name: e.name || `#${e.index + 1}`, fields }) })
  }
  const dupEnvName = duplicateEnvNames(f.envRows)
  if (dupEnvName) errs.push({ step: 1, msg: t('deploy.envDuplicateName', { name: dupEnvName }) })
```
(原 `envMissingKey/envCmMissing/envSecretMissing` 三行与 `firstDuplicateEnvName` 调用删除;`isEmptyEnvRow` 若 ports 行 :794 仍用则保留 import,`firstDuplicateEnvName` import 移除。)
- [ ] **Step 5: UI 合卡(:1147-1184,「环境变量 · 直填」卡与「环境引用」卡整段)替换为一卡**:
```vue
            <!-- 环境变量(统一行列表 + 整批导入) -->
            <div class="rounded-lg border border-outline-variant/60 bg-surface-container-lowest p-md">
              <div class="flex items-center gap-sm mb-sm text-primary">
                <span class="material-symbols-outlined text-base">code</span>
                <span class="text-body-sm font-semibold">{{ $t('deploy.envRowsGroup') }}</span>
              </div>
              <ContainerEnvEditor v-model:env="form.envRows" v-model:env-from="form.envFromRows" :namespace="form.namespace" size="md" />
            </div>
```
- [ ] **Step 6: 测试迁移**:`grep -rn "envVars\|envCMKeys\|envSecretKeys\|envFromConfigMap\|envFromSecret" WS/src/views/__tests__/DeployApp.*` 逐文件迁移(env 夹具换 `envRows/envFromRows`;YAML 断言核对新引号风格——js-yaml 纯安全串不加引号,断言用 parse 后对象而非裸文本)。
- [ ] **Step 7: 门禁**:`npx vitest run src/views/__tests__/DeployApp.` && `npm run test:server` && `npm run i18n:check` → 全绿。
- [ ] **Step 8: 提交**:

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.*.test.js
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "refactor(env): DeployApp wizard main container onto unified env model — single card, yamlDump-generated env/envFrom, per-type validation (fixes fake-radio UX)"
git show -s --format='%an %ae' HEAD
```

---

### Task 5: NsWorkloadDetail 编辑壳迁移(回填 + 校验 + 保存 + UI)——D1/D2 主容器根治

**Files:**
- Modify: `WS/src/views/NsWorkloadDetail.vue`(:846-851 回填、:945-947 校验、:988-996 保存、:1982-2019 UI)
- Modify: `WS/src/views/__tests__/NsWorkloadDetail.edit-shell.test.js`

**Interfaces:**
- Consumes: Task 1/2 产物;`formatEnvError` 逻辑内联(与 Task 4 同式)。
- Produces: `editForm.envRows` / `editForm.envFromRows`;保存后 `c0.env`/`c0.envFrom` 无损重建。

- [ ] **Step 1: 写失败测试**(`NsWorkloadDetail.edit-shell.test.js` 末尾追加;复用文件既有 `state.demoWorkload` 可变夹具 + `mountDetailB` + `openEdit()/saveEdit()/capturedSpec()` 既有通路,见该文件 :142 saveEdit 重建用例):

```js
test('编辑壳:多 envFrom 与 fieldRef 回填并完整保存(D1/D2 根治)', async () => {
  state.demoWorkload = {
    ...demoWorkload,
    raw: {
      metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
      spec: { replicas: 1, selector: { matchLabels: { app: 'demo' } },
        template: { metadata: { labels: { app: 'demo' } }, spec: {
          containers: [{ name: 'main', image: 'nginx',
            env: [
              { name: 'FOO', value: 'bar' },
              { name: 'MY_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name', apiVersion: 'v1' } } },
            ],
            envFrom: [{ prefix: 'MY_', configMapRef: { name: 'cm1' } }, { secretRef: { name: 's1' } }],
          }],
        } } },
    },
  }
  const w = mountDetailB()
  await flushPromises()
  await w.vm.openEdit()
  expect(w.vm.editForm.envRows.map(r => r.name)).toEqual(['FOO', 'MY_NAME'])
  expect(w.vm.editForm.envRows[1].type).toBe('fieldRef')
  expect(w.vm.editForm.envRows[1].passthrough).toEqual({ apiVersion: 'v1' })   // 长尾子字段保全
  expect(w.vm.editForm.envFromRows.map(r => r.name)).toEqual(['cm1', 's1'])    // 多条不取第一个
  expect(w.vm.editForm.envFromRows[0].passthrough).toEqual({ prefix: 'MY_' })
  await w.vm.saveEdit()
  const spec = capturedSpec()
  expect(spec.containers[0].env).toEqual([
    { name: 'FOO', value: 'bar' },
    { name: 'MY_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name', apiVersion: 'v1' } } },
  ])
  expect(spec.containers[0].envFrom).toEqual([
    { prefix: 'MY_', configMapRef: { name: 'cm1' } },
    { secretRef: { name: 's1' } },
  ])
  state.demoWorkload = demoWorkload                                           // 复原文件级夹具
  w.unmount()
  document.body.innerHTML = ''
})
```

- [ ] **Step 2: 跑测试 → FAIL**。
- [ ] **Step 3: 回填(:846-851)替换**:
```js
    envRows: envRowsFromSpec(c0.env),
    envFromRows: envFromRowsFromSpec(c0.envFrom),
```
- [ ] **Step 4: 校验(:945-947)替换**(import 处补 `ENV_FIELD_LABEL_KEYS`):
```js
  for (const e of envRefErrors(f.envRows || [])) {
    const fields = e.missing.map(m => t(ENV_FIELD_LABEL_KEYS[m])).join(' / ')
    errs.push(t('deploy.envRowMissing', { name: e.name || `#${e.index + 1}`, fields }))
  }
```
- [ ] **Step 5: 保存(:988-996)替换**:
```js
      const env = envRowsToSpec(f.envRows)
      c0.env = env.length ? env : null
      const envFrom = envFromRowsToSpec(f.envFromRows)
      c0.envFrom = envFrom.length ? envFrom : null
```
- [ ] **Step 6: UI(:1983-2019 环境小节)替换**:
```vue
        <!-- 环境变量 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-md">
          <div class="flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-lg">key</span><h4 class="text-body-sm font-semibold text-on-surface">{{ $t('deploy.envRowsGroup') }}</h4></div>
          <ContainerEnvEditor v-model:env="editForm.envRows" v-model:env-from="editForm.envFromRows" :namespace="String(route.params.namespace || '')" size="sm" />
        </section>
```
import 区加 `ContainerEnvEditor` 与 envRefs 四函数。
- [ ] **Step 7: 门禁**:`npx vitest run src/views/__tests__/NsWorkloadDetail.` && `npm run i18n:check` → 绿。
- [ ] **Step 8: 提交**:

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.edit-shell.test.js
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "fix(env): workload edit shell preserves multi-entry envFrom and fieldRef env rows on save (D1/D2) via unified env model"
git show -s --format='%an %ae' HEAD
```

---

### Task 6: 复制流补全(useWorkloadToForm)——D3 根治

**Files:**
- Modify: `WS/src/composables/useWorkloadToForm.js`(:44 mapMainContainer)
- Modify: `WS/scripts/test.mjs`(:488 workloadToForm 用例扩展)

**Interfaces:**
- Consumes: Task 1 API。
- Produces: 复制种子主容器含 `envRows`/`envFromRows`。

- [ ] **Step 1: 改 scripts/test.mjs 的 workloadToForm 用例**:
  - 既有 :488 用例中 `assert.deepEqual(f.envVars, [{ key: 'FOO', value: 'bar' }])  // valueFrom 类不映射` 一行**替换**为(env 夹具已含 `{ name: 'REF', valueFrom: { configMapKeyRef: { name: 'cm' } } }`):

    ```js
      assert.deepEqual(f.envRows, [
        { name: 'FOO', type: 'value', value: 'bar' },
        { name: 'REF', type: 'configMapKeyRef', cmName: 'cm', key: '' },   // key 缺失 = 半行,校验层会拦
      ])
      assert.deepEqual(f.envFromRows, [])
    ```
  - 该用例后追加新用例:

    ```js
    test('workloadToForm: 主容器 env 引用/envFrom 全量带入(D3 根治)', () => {
      const obj = { kind: 'Deployment', metadata: { name: 'e', namespace: 'n' }, spec: { template: { spec: { containers: [{ name: 'c', image: 'nginx', env: [{ name: 'FOO', value: 'bar' }, { name: 'N', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }], envFrom: [{ prefix: 'MY_', configMapRef: { name: 'cm1' } }, { secretRef: { name: 's1' } }] }] } } } }
      const f = workloadToForm(obj, 'Deployment')
      assert.equal(f.envRows.length, 2)
      assert.equal(f.envRows[1].type, 'fieldRef')
      assert.deepEqual(f.envFromRows.map(r => r.name), ['cm1', 's1'])
      assert.equal(f.envFromRows[0].passthrough.prefix, 'MY_')
    })
    ```
- [ ] **Step 2: 跑 `node scripts/test.mjs` → 新断言 FAIL**。
- [ ] **Step 3: mapMainContainer(:44 处)追加两行**:
```js
    envRows: envRowsFromSpec(c?.env),
    envFromRows: envFromRowsFromSpec(c?.envFrom),
```
顶部 `import { envRowsFromSpec, envFromRowsFromSpec } from '../logic/envRefs.js'`。(:85 else 分支补 `out.envRows = []; out.envFromRows = []`。)
- [ ] **Step 4: 跑 `node scripts/test.mjs` → 全 PASS**。
- [ ] **Step 5: 提交**:

```bash
git add src/composables/useWorkloadToForm.js scripts/test.mjs
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "fix(env): copy-workload seed carries main-container env refs and envFrom (D3) via envRefs mapping"
git show -s --format='%an %ae' HEAD
```

---

### Task 7: 全仓扫尾 + 孤儿键清理 + 六门禁收官

**Files:**
- Modify: `WS/src/utils/envRows.js`(删 `firstDuplicateEnvName`)、`WS/src/utils/envRows.test.mjs`(同步)
- Modify: `WS/src/locales/zh.json` + `en.json`(删孤儿键)
- 可能:grep 出的漏网消费方

- [ ] **Step 1: 全仓残形扫尾**(必须零命中,命中即迁移):

```bash
cd WS && grep -rn "envCMKeys\|envSecretKeys\|envFromConfigMap\|envFromSecret" src/ scripts/ --include="*.vue" --include="*.js" --include="*.mjs" | grep -v node_modules
```
(`envVars` 另查:`grep -rn "envVars" src/ scripts/`——命中仅允许是本项目其他域或已迁移残留,逐个处理。)
- [ ] **Step 2: 删 `firstDuplicateEnvName`**(utils/envRows.js + envRows.test.mjs 用例;DeployApp/containerValidation 已在 Task 3/4 摘除消费),跑 `node --test src/utils/envRows.test.mjs`。
- [ ] **Step 3: 孤儿 i18n 键清理**(每键删前 grep 全仓,零消费才删):`deploy.envDirectGroup`、`deploy.envRefGroup`、`deploy.envFromHint`、`deploy.addVariable`、`deploy.envMissingKey`、`deploy.envCmMissing`、`deploy.envSecretMissing`、`deploy.ced.envKeyPh/envValPh/envNamePh/addEnvRow`、`workload.edit.envNormal/envCmRef/envSecretRef/envNamePh/addEnv`、`deploy.containerFv.envMissingKey`(Task 3 已核)。zh+en 同步删,`npm run i18n:check` 绿。
- [ ] **Step 4: 六门禁全跑**:

```bash
cd WS && npm run test:server && npm run test:unit && npm run typecheck && npm run i18n:check && npm run build
```
- [ ] **Step 5: 提交**:

```bash
git add -A
git -c user.name=aliang-one -c user.email=aliangdone@gmail.com commit -m "chore(env): sweep legacy env row fields and orphan i18n keys; all gates green"
git show -s --format='%an %ae' HEAD
```

---

## 交付后(spec §10 手测清单,真浏览器 + 集群)

1. 创建 Deployment:直填/CM Key/Secret Key/字段引用各一行 → YAML 预览 env 段正确 → 提交后容器内生效。
2. 整批导入:CM + Secret 各一条 → `envFrom` 两元素保序 → 容器 `echo $KEY` 验证。
3. 手造 workload(2×configMapRef + fieldRef)→ 编辑壳打开不丢行、保存后 `kubectl get -o yaml` 核对无损。
4. 复制 workload:主容器引用行完整带入。
5. 子容器高级弹窗同模型;badge 计数正确。
6. 手机档:行换行不溢出、下拉不裁切。
