# NetworkPolicy 创建向导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个全功能结构化向导替代 `NsNetworkPolicies.vue` 的 3 字段创建弹窗,覆盖 NetworkPolicy 全特性、实时可见 deny-all 后果、双向可编辑 YAML,并根治非原子创建。

**Architecture:** form model 直接是原生 K8s NetworkPolicy 对象(`apiVersion/kind/metadata/spec`),不造中间层;model↔YAML 走 js-yaml dump/load;提交统一走 `applyResourceYaml`(await + toast + invalidate)。5 个叶子编辑器组件 + 1 个纯逻辑模块,自底向上构建。

**Tech Stack:** Vue 3 (`<script setup>`,纯 JS) · Pinia · `@tanstack/vue-query` · js-yaml(已是依赖) · vitest + @vue/test-utils + happy-dom(组件测试) · 自研零依赖运行器 `scripts/test.mjs`(纯逻辑)

## Global Constraints

- **不新增外部依赖**(见 CLAUDE.md「依赖政策」)。js-yaml / vitest / @vue/test-utils / happy-dom 均已登记为例外。
- **i18n 门禁**:`npm run i18n:check` 三合一(残存中文 + zh/en 键对齐 + 引用键缺失)。所有用户可见文案走 i18n 键,zh.json 与 en.json 必须对齐。新增键全部放 `ns.netpolCreate.*`。
- **测试分工**:纯逻辑(`src/logic/networkPolicy.js`)→ 追加到 `scripts/test.mjs`(自研零依赖运行器,`node:assert` + 内联 `test(name, fn)`);组件 → vitest,文件放 `src/<area>/__tests__/<Name>.test.js`,模板见 `src/components/common/__tests__/CopyWorkloadDialog.test.js`。
- **运行命令**:`npm run test:server`(含 `scripts/test.mjs`)、`npm run test:unit`(vitest run)、`npm test`(两者)、`npm run typecheck`(`node --check` 全 .js/.mjs;.vue 由 `npm run build` 覆盖)、`npm run i18n:check`。
- **提交**:每个 Task 末尾 commit,信息用约定式 + scope,如 `feat(networkpolicy): ...`,结尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。分支 `feat/networkpolicy-create-wizard`(已建)。
- **不碰** `NsNetworkPolicyDetail.vue`(详情页编辑入口 v1 不改)、不删旧 `store.addNetworkPolicy` / `generateYAML('networkpolicy')`(暂留)。

## Contracts(全计划共用,后续 Task 引用此处签名)

`src/logic/networkPolicy.js` 导出:

| 函数 | 签名 |
|------|------|
| `emptySelector()` | → `{ matchLabels: {}, matchExpressions: [] }` |
| `emptyPeer()` | → `{ podSelector: { matchLabels: {}, matchExpressions: [] } }` |
| `emptyPort()` | → `{ protocol: 'TCP', port: '' }` |
| `emptyIngressRule()` | → `{ from: [], ports: [] }` |
| `emptyEgressRule()` | → `{ to: [], ports: [] }` |
| `defaultModel(namespace)` | → 完整 NetworkPolicy 对象(放行起步,见 Task 1) |
| `consequence(spec, dir)` | `dir ∈ 'ingress'\|'egress'` → `{ state: 'none'\|'denyAll'\|'allowAll'\|'scoped', rules, peers, ports }` |
| `isDenyAll(spec)` | → `boolean`(任一受管方向为 denyAll) |
| `modelToYaml(model)` | → YAML 字符串 |
| `parseAndValidate(yamlStr)` | → `{ ok: true, model }` 或 `{ ok: false, code: 'parseError'\|'notNetworkPolicy'\|'nameRequired', detail }` |

model 形状(K8s 原生):
```
{ apiVersion:'networking.k8s.io/v1', kind:'NetworkPolicy',
  metadata:{ name, namespace },          // labels/annotations 可选
  spec:{ podSelector:{matchLabels,matchExpressions},
         policyTypes:['Ingress','Egress'], // 子集
         ingress:[{from:[peer], ports:[port]}],
         egress:[{to:[peer], ports:[port]}] } }
peer: {podSelector?} | {namespaceSelector?} | {podSelector?,namespaceSelector?} | {ipBlock:{cidr,except?:[]}}
port: {protocol:'TCP'|'UDP'|'SCTP', port:number|string, endPort?:number}   // port 缺省/空=全部端口
```

---

### Task 1: 纯逻辑 — 默认模型 / 后果判定 / denyAll

**Files:**
- Create: `src/logic/networkPolicy.js`
- Modify: `scripts/test.mjs`(顶部 import + 末尾追加 test 用例)

**Interfaces:**
- Produces: `emptySelector` / `emptyPeer` / `emptyPort` / `emptyIngressRule` / `emptyEgressRule` / `defaultModel` / `consequence` / `isDenyAll`(后续 Task 与组件消费)

- [ ] **Step 1: 在 `scripts/test.mjs` 顶部加 import**

在现有 `import { buildStorageClassYaml } ...` 之后追加一行:
```js
import { emptySelector, emptyPeer, emptyPort, emptyIngressRule, emptyEgressRule, defaultModel, consequence, isDenyAll } from '../src/logic/networkPolicy.js'
```

- [ ] **Step 2: 在 `scripts/test.mjs` 末尾(`results` 汇总之前)追加失败用例**

```js
// --- NetworkPolicy 创建向导:默认模型 / 后果 / denyAll ---
test('defaultModel 放行起步:每方向一条未限定源规则 → allowAll', () => {
  const m = defaultModel('default')
  assert.equal(m.kind, 'NetworkPolicy')
  assert.equal(m.apiVersion, 'networking.k8s.io/v1')
  assert.equal(m.metadata.namespace, 'default')
  assert.deepEqual(m.spec.policyTypes.sort(), ['Egress', 'Ingress'])
  assert.equal(m.spec.ingress.length, 1)
  assert.equal(m.spec.egress.length, 1)
  assert.deepEqual(m.spec.ingress[0], { from: [], ports: [] })
  assert.equal(consequence(m.spec, 'ingress').state, 'allowAll')
  assert.equal(consequence(m.spec, 'egress').state, 'allowAll')
  assert.equal(isDenyAll(m.spec), false)
})

test('consequence:四态判定', () => {
  // none:policyTypes 不含该方向
  const none = { policyTypes: ['Egress'], ingress: [], egress: [{ to: [{ podSelector: { matchLabels: {} } }], ports: [] }] }
  assert.equal(consequence(none, 'ingress').state, 'none')
  // denyAll:受管方向但无规则
  const deny = { policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [{ to: [], ports: [] }] }
  assert.equal(consequence(deny, 'ingress').state, 'denyAll')
  assert.equal(isDenyAll(deny), true)
  // allowAll:存在「无 peer」的规则(from/to 为空)
  const allow = { policyTypes: ['Ingress'], ingress: [{ from: [], ports: [] }], egress: [] }
  assert.equal(consequence(allow, 'ingress').state, 'allowAll')
  // scoped:所有规则都有具体 peer
  const scoped = { policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: { matchLabels: { app: 'x' } } }], ports: [{ protocol: 'TCP', port: 80 }] }], egress: [] }
  const c = consequence(scoped, 'ingress')
  assert.equal(c.state, 'scoped')
  assert.equal(c.peers, 1)
  assert.equal(c.ports, 1)
  assert.equal(isDenyAll(scoped), false)
})

test('工厂函数形状稳定', () => {
  assert.deepEqual(emptySelector(), { matchLabels: {}, matchExpressions: [] })
  assert.deepEqual(emptyPort(), { protocol: 'TCP', port: '' })
  assert.deepEqual(emptyIngressRule(), { from: [], ports: [] })
  assert.deepEqual(emptyEgressRule(), { to: [], ports: [] })
  assert.deepEqual(emptyPeer(), { podSelector: { matchLabels: {}, matchExpressions: [] } })
})
```

- [ ] **Step 3: 运行验证失败**

Run: `node scripts/test.mjs`
Expected: 出现 FAIL,报 `Cannot find module '../src/logic/networkPolicy.js'`(文件尚未建)。

- [ ] **Step 4: 实现 `src/logic/networkPolicy.js`**

```js
// NetworkPolicy 创建向导纯逻辑:无 Vue 依赖,可被 scripts/test.mjs(Node)与组件共同 import。
// model 直接是 K8s 原生 NetworkPolicy 对象 —— 不造中间 app-model。

export function emptySelector() {
  return { matchLabels: {}, matchExpressions: [] }
}

export function emptyPeer() {
  // 新增 peer 默认给一个空 Pod 选择器(用户可在编辑器里切 namespace/ipBlock/组合)
  return { podSelector: emptySelector() }
}

export function emptyPort() {
  // port 为 ''/缺省 = 全部端口
  return { protocol: 'TCP', port: '' }
}

export function emptyIngressRule() {
  return { from: [], ports: [] }
}

export function emptyEgressRule() {
  return { to: [], ports: [] }
}

export function defaultModel(namespace) {
  // 放行起步:每方向一条「未限定源」规则(allowAll),对生产最安全。
  // denyAll 只有用户手动删光规则才会出现。
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: '', namespace: namespace || 'default' },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [emptyIngressRule()],
      egress: [emptyEgressRule()],
    },
  }
}

// 方向后果四态:none(不管控)/ denyAll(受管但无规则)/ allowAll(存在无 peer 的规则)/ scoped(全部规则有具体 peer)
export function consequence(spec, direction) {
  const typeName = direction === 'ingress' ? 'Ingress' : 'Egress'
  const peersKey = direction === 'ingress' ? 'from' : 'to'
  if (!(spec.policyTypes || []).includes(typeName)) {
    return { state: 'none', rules: 0, peers: 0, ports: 0 }
  }
  const rules = spec[direction] || []
  let peers = 0
  let ports = 0
  for (const r of rules) {
    peers += (r[peersKey] || []).length
    ports += (r.ports || []).length
  }
  if (rules.length === 0) return { state: 'denyAll', rules: 0, peers: 0, ports: 0 }
  // 规则间是 OR:任一规则「无 peer」即等于放行所有源
  const hasUnrestricted = rules.some(r => (r[peersKey] || []).length === 0)
  if (hasUnrestricted) return { state: 'allowAll', rules: rules.length, peers, ports }
  return { state: 'scoped', rules: rules.length, peers, ports }
}

export function isDenyAll(spec) {
  return consequence(spec, 'ingress').state === 'denyAll' || consequence(spec, 'egress').state === 'denyAll'
}
```

- [ ] **Step 5: 运行验证通过**

Run: `node scripts/test.mjs`
Expected: 全部 PASS(含旧用例)。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: PASS(`node --check src/logic/networkPolicy.js`)。

- [ ] **Step 7: Commit**

```bash
git add src/logic/networkPolicy.js scripts/test.mjs
git commit -m "feat(networkpolicy): 向导纯逻辑 — 默认模型/后果判定/denyAll

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 纯逻辑 — YAML 编解码

**Files:**
- Modify: `src/logic/networkPolicy.js`(追加 `modelToYaml` / `parseAndValidate`)
- Modify: `scripts/test.mjs`(import 补 `modelToYaml, parseAndValidate` + 追加用例)

**Interfaces:**
- Produces: `modelToYaml(model)` → string;`parseAndValidate(yamlStr)` → `{ok,model}`|`{ok:false,code,detail}`
- Consumes: Task 1 的工厂/defaultModel

- [ ] **Step 1: 补 import**

把 Task 1 加的 import 行扩展为:
```js
import { emptySelector, emptyPeer, emptyPort, emptyIngressRule, emptyEgressRule, defaultModel, consequence, isDenyAll, modelToYaml, parseAndValidate } from '../src/logic/networkPolicy.js'
```

- [ ] **Step 2: 追加失败用例**

```js
test('modelToYaml/parseAndValidate 语义往返深相等(含进阶特性)', () => {
  const model = {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'p1', namespace: 'default' },
    spec: {
      podSelector: { matchLabels: { app: 'web' }, matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'staging'] }] },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [
          { podSelector: { matchLabels: { role: 'api' } }, namespaceSelector: { matchLabels: { tier: 'be' } } },
          { ipBlock: { cidr: '10.0.0.0/8', except: ['10.0.1.0/24'] } },
        ],
        ports: [{ protocol: 'TCP', port: 80, endPort: 90 }, { protocol: 'TCP', port: 'https' }],
      }],
      egress: [],
    },
  }
  const yaml = modelToYaml(model)
  const res = parseAndValidate(yaml)
  assert.ok(res.ok, '合法 YAML 应解析成功')
  assert.deepEqual(res.model, model)
})

test('parseAndValidate 错误码', () => {
  assert.equal(parseAndValidate('apiVersion: v1\nkind: Pod\nmetadata: {name: x}').code, 'notNetworkPolicy')
  assert.equal(parseAndValidate('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {}\nspec: {}').code, 'nameRequired')
  assert.equal(parseAndValidate(':::not yaml:::').code, 'parseError')
})
```

- [ ] **Step 3: 运行验证失败**

Run: `node scripts/test.mjs`
Expected: FAIL(`modelToYaml` 未导出)。

- [ ] **Step 4: 追加实现到 `src/logic/networkPolicy.js`**

文件顶部加 import:
```js
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
```
末尾追加:
```js
export function modelToYaml(model) {
  // 规范化:补全 apiVersion/kind,保留 model 其余字段(metadata/spec)
  const doc = {
    apiVersion: model.apiVersion || 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { ...(model.metadata || {}) },
    spec: model.spec || {},
  }
  return yamlDump(doc, { lineWidth: -1, noRefs: true })
}

export function parseAndValidate(yamlStr) {
  let doc
  try {
    doc = yamlLoad(yamlStr)
  } catch (e) {
    return { ok: false, code: 'parseError', detail: e?.message || String(e) }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, code: 'parseError', detail: 'empty document' }
  if (doc.kind !== 'NetworkPolicy') return { ok: false, code: 'notNetworkPolicy', detail: `kind=${doc.kind}` }
  if (!doc.metadata?.name) return { ok: false, code: 'nameRequired', detail: 'metadata.name missing' }
  return { ok: true, model: doc }
}
```

- [ ] **Step 5: 运行验证通过**

Run: `node scripts/test.mjs`
Expected: PASS(注意:`port: 'https'` 命名端口经 dump→load 保持字符串;`endPort` 数字保持;deepEqual 通过)。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/logic/networkPolicy.js scripts/test.mjs
git commit -m "feat(networkpolicy): 向导纯逻辑 — YAML 编解码 + 往返

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: applyResourceYaml NetworkPolicy mock 模式 upsert

**背景**:`src/stores/cluster.js:2620` 的 `case 'NetworkPolicy'` 在 mock 模式调 `updateNetworkPolicy`(找不到 early-return),demo 模式建不出来。改 upsert(找不到则 add),贴合 kubectl apply 语义。

**Files:**
- Modify: `src/stores/cluster.js`(`case 'NetworkPolicy'` 分支,约 2620-2625 行)

**Interfaces:**
- Consumes: 既有 `updateNetworkPolicy` / `addNetworkPolicy` / `mapNetworkPolicy` / store 内 `networkPolicyList`

- [ ] **Step 1: 定位现状**

Run: `sed -n '2620,2626p' src/stores/cluster.js`
确认看到:
```js
      case 'NetworkPolicy':
        updates.podSelector = spec.podSelector?.matchLabels || {}
        if (Array.isArray(spec.policyTypes)) updates.policyTypes = spec.policyTypes
        updates.ingressRules = (spec.ingress || []).map(r => ({ from: (r.from || []).map(toPeer), ports: r.ports || [] }))
        updates.egressRules = (spec.egress || []).map(r => ({ to: (r.to || []).map(toPeer), ports: r.ports || [] }))
        updateNetworkPolicy(name, ns, updates)
        break
```

- [ ] **Step 2: 改为 upsert**

把 `updateNetworkPolicy(name, ns, updates)` 一行替换为:
```js
        // upsert(kubectl apply 语义):mock 模式下找不到则新增,否则更新
        if (networkPolicyList.value.some(n => n.name === name && n.namespace === ns)) {
          updateNetworkPolicy(name, ns, updates)
        } else {
          addNetworkPolicy({ name, namespace: ns, ...updates, age: 'Just now' })
        }
```

- [ ] **Step 3: 运行服务端 + 纯逻辑测试,确保无回归**

Run: `npm run test:server`
Expected: PASS(本改动在 mock 分支,不影响 remote;现有断言不覆盖此处,但需保证 store 语法 `node --check` 通过 → 已含在 typecheck)。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/stores/cluster.js
git commit -m "fix(networkpolicy): applyResourceYaml mock 模式改 upsert,修 demo 建不出来

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: YamlEditor 增发 edit-start 事件

**背景**:向导需要知道用户进入 YAML 编辑,以暂停表单(避免表单改动 clobber 未保存的 YAML)。`YamlEditor` 现有 `@save`/`@discard`,缺「进入编辑」事件。补一个向后兼容的事件。

**Files:**
- Modify: `src/components/common/YamlEditor.vue`
- Create: `src/components/common/__tests__/YamlEditor.test.js`

**Interfaces:**
- Produces: `YamlEditor` 新增 `edit-start` 事件(进入编辑模式时触发)

- [ ] **Step 1: 写失败测试**

`src/components/common/__tests__/YamlEditor.test.js`:
```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import YamlEditor from '@/components/common/YamlEditor.vue'

test('YamlEditor: 点 Edit 触发 edit-start 事件', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: NetworkPolicy\n', readonly: false },
  })
  await wrapper.find('button').trigger('click') // 工具栏首个按钮(Edit)
  expect(wrapper.emitted('edit-start')).toBeTruthy()
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/components/common/__tests__/YamlEditor.test.js`
Expected: FAIL(`edit-start` 未触发)。

- [ ] **Step 3: 实现**

`YamlEditor.vue` 的 `defineEmits` 加 `'edit-start'`;`startEdit` 末尾 emit:
```js
const emit = defineEmits(['update:modelValue', 'save', 'discard', 'edit-start'])
// ...
function startEdit() {
  editableContent.value = props.modelValue
  isEditing.value = true
  emit('edit-start')
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/components/common/__tests__/YamlEditor.test.js`
Expected: PASS。

- [ ] **Step 5: 确认未破坏既有用法**

Run: `npx vitest run src/components/common/__tests__/`
Expected: 全 PASS(新增事件不影响 SplitButton/CopyWorkloadDialog 等邻接测试)。

- [ ] **Step 6: Commit**

```bash
git add src/components/common/YamlEditor.vue src/components/common/__tests__/YamlEditor.test.js
git commit -m "feat(yamleditor): 增发 edit-start 事件供向导暂停表单

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: NpSelectorEditor(matchLabels + matchExpressions)

**Files:**
- Create: `src/components/networkpolicy/NpSelectorEditor.vue`
- Create: `src/components/networkpolicy/__tests__/NpSelectorEditor.test.js`

**Interfaces:**
- Props: `modelValue: { matchLabels: {}, matchExpressions: [] }`
- Emits: `update:modelValue`(整体新对象)
- Consumes: `emptySelector()`(Task 1)
- 会被 `NpPeerEditor`(Task 7)与容器顶层 podSelector 复用

**实现要点**:内部维护 `labels`([{key,value}])与 `expressions`([{key,operator,values}])两份本地 ref,`watch(() => props.modelValue)` 同步;任一改动 → `emit` 重建后的 `{matchLabels, matchExpressions}`。`values` 用逗号分隔输入框,emit 时 `split(',')`。

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpSelectorEditor from '@/components/networkpolicy/NpSelectorEditor.vue'

test('NpSelectorEditor: 增一个 label → emit 含 matchLabels', async () => {
  const wrapper = mount(NpSelectorEditor, { props: { modelValue: { matchLabels: {}, matchExpressions: [] } } })
  // 首个 label 行的 key/value 输入(data-test 区分)
  const inputs = wrapper.findAll('input[data-test="lbl-key"]')
  await inputs[0].setValue('app')
  await wrapper.findAll('input[data-test="lbl-val"]')[0].setValue('web')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchLabels).toEqual({ app: 'web' })
})

test('NpSelectorEditor: 增一个 matchExpression → emit 含 matchExpressions', async () => {
  const wrapper = mount(NpSelectorEditor, { props: { modelValue: { matchLabels: {}, matchExpressions: [] } } })
  await wrapper.find('button[data-test="add-expr"]').trigger('click')
  await wrapper.find('input[data-test="expr-key"]').setValue('env')
  await wrapper.find('select[data-test="expr-op"]').setValue('In')
  await wrapper.find('input[data-test="expr-values"]').setValue('prod, staging')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchExpressions).toEqual([{ key: 'env', operator: 'In', values: ['prod', 'staging'] }])
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpSelectorEditor.test.js`
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 实现组件**

```vue
<script setup>
import { ref, watch } from 'vue'
import { emptySelector } from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Object, default: () => emptySelector() },
})
const emit = defineEmits(['update:modelValue'])

const labels = ref([])
const expressions = ref([])

function syncFromProps() {
  labels.value = Object.entries(props.modelValue.matchLabels || {}).map(([key, value]) => ({ key, value }))
  expressions.value = (props.modelValue.matchExpressions || []).map(e => ({ key: e.key, operator: e.operator, values: (e.values || []).join(', ') }))
}
watch(() => props.modelValue, syncFromProps, { immediate: true, deep: true })

function emitUp() {
  const matchLabels = {}
  for (const l of labels.value) if (l.key.trim()) matchLabels[l.key.trim()] = l.value
  const matchExpressions = expressions.value
    .filter(e => e.key.trim())
    .map(e => ({ key: e.key.trim(), operator: e.operator || 'In', values: e.values.split(',').map(s => s.trim()).filter(Boolean) }))
  emit('update:modelValue', { matchLabels, matchExpressions })
}

function addLabel() { labels.value.push({ key: '', value: '' }) }
function removeLabel(i) { labels.value.splice(i, 1); emitUp() }
function addExpr() { expressions.value.push({ key: '', operator: 'In', values: '' }) }
function removeExpr(i) { expressions.value.splice(i, 1); emitUp() }
</script>

<template>
  <div class="flex flex-col gap-sm">
    <!-- matchLabels -->
    <div v-for="(l, i) in labels" :key="'l'+i" class="flex items-center gap-sm">
      <input v-model="l.key" data-test="lbl-key" placeholder="key" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <span class="text-on-surface-variant">=</span>
      <input v-model="l.value" data-test="lbl-val" placeholder="value" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <button @click="removeLabel(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">remove</span></button>
    </div>
    <button @click="addLabel" data-test="add-label" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">+ label</button>

    <!-- matchExpressions -->
    <div class="text-label-caps text-on-surface-variant mt-xs">matchExpressions</div>
    <div v-for="(e, i) in expressions" :key="'e'+i" class="flex items-center gap-sm">
      <input v-model="e.key" data-test="expr-key" placeholder="key" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <select v-model="e.operator" data-test="expr-op" @change="emitUp"
        class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm">
        <option v-for="op in ['In','NotIn','Exists','DoesNotExist']" :key="op">{{ op }}</option>
      </select>
      <input v-model="e.values" data-test="expr-values" placeholder="值, 逗号分隔(Exists/DoesNotExist 留空)" @input="emitUp"
        class="flex-[2] bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <button @click="removeExpr(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">remove</span></button>
    </div>
    <button @click="addExpr" data-test="add-expr" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">+ expression</button>
  </div>
</template>
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpSelectorEditor.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/networkpolicy/
git commit -m "feat(networkpolicy): NpSelectorEditor(matchLabels + matchExpressions)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: NpPortEditor

**Files:**
- Create: `src/components/networkpolicy/NpPortEditor.vue`
- Create: `src/components/networkpolicy/__tests__/NpPortEditor.test.js`

**Interfaces:**
- Props: `modelValue: { protocol, port, endPort? }`(`port` 空 = 全部端口)
- Emits: `update:modelValue`

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpPortEditor from '@/components/networkpolicy/NpPortEditor.vue'

test('NpPortEditor: 数字端口 + 协议 + endPort', async () => {
  const wrapper = mount(NpPortEditor, { props: { modelValue: { protocol: 'TCP', port: '' } } })
  await wrapper.find('input[data-test="port"]').setValue('80')
  await wrapper.find('input[data-test="endport"]').setValue('90')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted).toEqual({ protocol: 'TCP', port: 80, endPort: 90 })
})

test('NpPortEditor: 命名端口(字符串)不显示 endPort 控件语义 — port 为字符串时 endPort 不 emit', async () => {
  const wrapper = mount(NpPortEditor, { props: { modelValue: { protocol: 'TCP', port: '' } } })
  await wrapper.find('input[data-test="port"]').setValue('https')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.port).toBe('https')
  expect(emitted.endPort).toBeUndefined()
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpPortEditor.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

```vue
<script setup>
import { computed } from 'vue'
const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const isNumeric = computed(() => typeof props.modelValue.port === 'number' || /^\d+$/.test(String(props.modelValue.port || '')))
function patch(p) {
  const out = { ...props.modelValue, ...p }
  // 命名端口或空端口不带 endPort
  if (!isNumeric.value) delete out.endPort
  emit('update:modelValue', out)
}
function onPortInput(e) {
  const raw = e.target.value
  patch({ port: raw === '' ? '' : (isNumeric.value ? Number(raw) : raw) })
}
</script>
<template>
  <div class="flex items-center gap-sm">
    <select :value="modelValue.protocol" @change="patch({ protocol: $event.target.value })"
      class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm">
      <option v-for="p in ['TCP','UDP','SCTP']" :key="p">{{ p }}</option>
    </select>
    <input :value="modelValue.port" data-test="port" @input="onPortInput" placeholder="端口(空=全部)"
      class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
    <input v-if="isNumeric" :value="modelValue.endPort ?? ''" data-test="endport" @input="patch({ endPort: Number($event.target.value) })" placeholder="endPort"
      class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
  </div>
</template>
```
注:`onPortInput(e)` 由 `@input="onPortInput"` 隐式收 `$event`,函数内 `e.target.value` 正确;两处内联表达式用 `$event.target.value`。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpPortEditor.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/networkpolicy/NpPortEditor.vue src/components/networkpolicy/__tests__/NpPortEditor.test.js
git commit -m "feat(networkpolicy): NpPortEditor(协议/数字/命名端口/endPort)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: NpPeerEditor(podSelector / namespaceSelector / 组合 / ipBlock)

**Files:**
- Create: `src/components/networkpolicy/NpPeerEditor.vue`
- Create: `src/components/networkpolicy/__tests__/NpPeerEditor.test.js`

**Interfaces:**
- Props: `modelValue: peer 对象`
- Emits: `update:modelValue`
- Consumes: `NpSelectorEditor`(Task 5)、`emptySelector()`(Task 1)

**实现要点**:peer 可同时含 podSelector 与 namespaceSelector(组合 = AND)。用 4 个 checkbox 决定显示哪些段:`hasPod` / `hasNs` / `hasIp`。勾选时若字段缺则注入 `emptySelector()` / `{ cidr: '', except: [] }`;取消勾选时 `delete` 该键。任一变动 emit 整个 peer。

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpPeerEditor from '@/components/networkpolicy/NpPeerEditor.vue'
import { emptyPeer } from '@/logic/networkPolicy'

test('NpPeerEditor: 勾 ipBlock 并填 cidr → emit ipBlock', async () => {
  const wrapper = mount(NpPeerEditor, { props: { modelValue: emptyPeer() } })
  await wrapper.find('input[data-test="has-ip"]').setValue(true)
  await wrapper.find('input[data-test="cidr"]').setValue('10.0.0.0/8')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ipBlock.cidr).toBe('10.0.0.0/8')
})

test('NpPeerEditor: 默认含 podSelector(来自 emptyPeer)', () => {
  const wrapper = mount(NpPeerEditor, { props: { modelValue: emptyPeer() } })
  expect(wrapper.find('input[data-test="has-pod"]').element.checked).toBe(true)
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpPeerEditor.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

```vue
<script setup>
import { computed } from 'vue'
import NpSelectorEditor from './NpSelectorEditor.vue'
import { emptySelector } from '@/logic/networkPolicy'

const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])

const hasPod = computed(() => !!props.modelValue.podSelector)
const hasNs = computed(() => !!props.modelValue.namespaceSelector)
const hasIp = computed(() => !!props.modelValue.ipBlock)

function clone() { return JSON.parse(JSON.stringify(props.modelValue)) }

function togglePod(v) { const p = clone(); v.target.checked ? (p.podSelector = emptySelector()) : (delete p.podSelector); emit('update:modelValue', p) }
function toggleNs(v) { const p = clone(); v.target.checked ? (p.namespaceSelector = emptySelector()) : (delete p.namespaceSelector); emit('update:modelValue', p) }
function toggleIp(v) { const p = clone(); v.target.checked ? (p.ipBlock = { cidr: '', except: [] }) : (delete p.ipBlock); emit('update:modelValue', p) }

function setPod(sel) { const p = clone(); p.podSelector = sel; emit('update:modelValue', p) }
function setNs(sel) { const p = clone(); p.namespaceSelector = sel; emit('update:modelValue', p) }
function setCidr(v) { const p = clone(); p.ipBlock = { ...p.ipBlock, cidr: v.target.value }; emit('update:modelValue', p) }
function setExcept(v) { const p = clone(); p.ipBlock = { ...p.ipBlock, except: v.target.value.split(',').map(s => s.trim()).filter(Boolean) }; emit('update:modelValue', p) }
</script>

<template>
  <div class="border border-outline-variant rounded-lg p-md flex flex-col gap-sm bg-surface-container-low/40">
    <div class="flex flex-wrap gap-md text-body-sm">
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-pod" :checked="hasPod" @change="togglePod"> Pod 选择器</label>
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-ns" :checked="hasNs" @change="toggleNs"> Namespace 选择器</label>
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-ip" :checked="hasIp" @change="toggleIp"> ipBlock</label>
    </div>
    <NpSelectorEditor v-if="hasPod" :model-value="modelValue.podSelector" @update:model-value="setPod" />
    <NpSelectorEditor v-if="hasNs" :model-value="modelValue.namespaceSelector" @update:model-value="setNs" />
    <div v-if="hasIp" class="flex items-center gap-sm">
      <input :value="modelValue.ipBlock.cidr" data-test="cidr" @input="setCidr" placeholder="CIDR 如 10.0.0.0/8"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <input :value="(modelValue.ipBlock.except || []).join(', ')" data-test="except" @input="setExcept" placeholder="排除 CIDR, 逗号分隔"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpPeerEditor.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/networkpolicy/NpPeerEditor.vue src/components/networkpolicy/__tests__/NpPeerEditor.test.js
git commit -m "feat(networkpolicy): NpPeerEditor(Pod/Namespace/组合/ipBlock+except)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: NpRuleEditor(一条 ingress/egress 规则)

**Files:**
- Create: `src/components/networkpolicy/NpRuleEditor.vue`
- Create: `src/components/networkpolicy/__tests__/NpRuleEditor.test.js`

**Interfaces:**
- Props: `modelValue: { from|to: [peer], ports: [port] }`、`direction: 'ingress'|'egress'`
- Emits: `update:modelValue`
- Consumes: `NpPeerEditor`(Task 7)、`NpPortEditor`(Task 6)、`emptyPeer/emptyPort/emptyIngressRule/emptyEgressRule`

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpRuleEditor from '@/components/networkpolicy/NpRuleEditor.vue'
import { emptyIngressRule, emptyEgressRule, emptyPeer } from '@/logic/networkPolicy'

test('NpRuleEditor ingress: 增一个 peer → emit.from 长度 2', async () => {
  const wrapper = mount(NpRuleEditor, { props: { modelValue: emptyIngressRule(), direction: 'ingress' } })
  await wrapper.find('button[data-test="add-peer"]').trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.from.length).toBe(1) // 起始 from:[],加 1 → 1
})

test('NpRuleEditor egress 用 to 而非 from', () => {
  const wrapper = mount(NpRuleEditor, { props: { modelValue: emptyEgressRule(), direction: 'egress' } })
  expect(wrapper.find('button[data-test="add-peer"]').exists()).toBe(true)
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpRuleEditor.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

```vue
<script setup>
import { computed } from 'vue'
import NpPeerEditor from './NpPeerEditor.vue'
import NpPortEditor from './NpPortEditor.vue'
import { emptyPeer, emptyPort } from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Object, required: true },
  direction: { type: String, required: true }, // 'ingress' | 'egress'
})
const emit = defineEmits(['update:modelValue'])
const peersKey = computed(() => props.direction === 'ingress' ? 'from' : 'to')
const peers = computed(() => props.modelValue[peersKey.value] || [])
const ports = computed(() => props.modelValue.ports || [])

function clone() { return JSON.parse(JSON.stringify(props.modelValue)) }
function addPeer() { const r = clone(); r[peersKey.value] = [...peers.value, emptyPeer()]; emit('update:modelValue', r) }
function setPeer(i, p) { const r = clone(); r[peersKey.value] = peers.value.map((x, idx) => idx === i ? p : x); emit('update:modelValue', r) }
function removePeer(i) { const r = clone(); r[peersKey.value] = peers.value.filter((_, idx) => idx !== i); emit('update:modelValue', r) }
function addPort() { const r = clone(); r.ports = [...ports.value, emptyPort()]; emit('update:modelValue', r) }
function setPort(i, p) { const r = clone(); r.ports = ports.value.map((x, idx) => idx === i ? p : x); emit('update:modelValue', r) }
function removePort(i) { const r = clone(); r.ports = ports.value.filter((_, idx) => idx !== i); emit('update:modelValue', r) }
</script>

<template>
  <div class="flex flex-col gap-sm border-l-2 border-primary/30 pl-md">
    <div class="text-label-caps text-on-surface-variant">{{ direction === 'ingress' ? '源 (from)' : '目标 (to)' }}</div>
    <div v-for="(p, i) in peers" :key="'p'+i" class="flex items-start gap-sm">
      <div class="flex-1"><NpPeerEditor :model-value="p" @update:model-value="setPeer(i, $event)" /></div>
      <button @click="removePeer(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
    </div>
    <button @click="addPeer" data-test="add-peer" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">+ 源/目标</button>

    <div class="text-label-caps text-on-surface-variant mt-xs">端口</div>
    <div v-for="(p, i) in ports" :key="'port'+i" class="flex items-center gap-sm">
      <NpPortEditor :model-value="p" @update:model-value="setPort(i, $event)" />
      <button @click="removePort(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
    </div>
    <button @click="addPort" data-test="add-port" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">+ 端口</button>
  </div>
</template>
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/components/networkpolicy/__tests__/NpRuleEditor.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/networkpolicy/NpRuleEditor.vue src/components/networkpolicy/__tests__/NpRuleEditor.test.js
git commit -m "feat(networkpolicy): NpRuleEditor(peers + ports)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: NetworkPolicyEditor 容器(组装 + 后果标签 + denyAll 守卫 + YAML 双向 + 提交)

**Files:**
- Create: `src/components/networkpolicy/NetworkPolicyEditor.vue`
- Create: `src/components/networkpolicy/__tests__/NetworkPolicyEditor.test.js`

**Interfaces:**
- Props: `modelValue: Boolean`(显隐)、`namespace: String`
- Emits: `update:modelValue`、`applied`(成功创建后)
- Consumes: `NpSelectorEditor`、`NpRuleEditor`、`YamlEditor`、`Modal`、`useResourceApply().applyYaml`、`defaultModel/consequence/isDenyAll/modelToYaml/parseAndValidate`、i18n(`ns.netpolCreate.*`,Task 10 先加键或本 Task 内联英文占位再由 Task 10 替换 — **务必 Task 10 在前**;为避免依赖循环,本 Task 用 i18n 键,Task 10 提供键)
- **顺序约束**:Task 10(i18n 键)须在本 Task 之前完成。执行时先做 Task 10。

**关键行为**:
- `model = ref(defaultModel(props.namespace))`,`watch(namespace)` 重置。
- 左栏:名字(DNS-1123 校验)、命名空间(只读)、顶层 podSelector(`NpSelectorEditor`)、policyTypes 两个 checkbox、ingress 规则列表(`NpRuleEditor direction="ingress"`)、egress 规则列表。
- 每方向渲染后果标签(基于 `consequence`)。
- 右栏:`YamlEditor :model-value="yamlText"`(`yamlText = computed(() => modelToYaml(model.value))`),`@edit-start="yamlEditing=true"`、`@save="onYamlSave"`、`@discard="onYamlDiscard"`。
- `yamlEditing=true` 时左栏 `pointer-events-none opacity-50` + 提示。
- `onYamlSave(text)`:`parseAndValidate(text)` → ok:`model.value = res.model; yamlError=''`、fail:`yamlError = t('ns.netpolCreate.err.'+res.code)`;无论成败 `yamlEditing=false`。
- denyAll 守卫:`canCreate = nameValid && (!isDenyAll(spec) || ackDenyAll)`;`denyAll` 时显示警告 + checkbox。
- 提交:`async submit()` → `creating=true; const res = await applyYaml(modelToYaml(model.value)); creating=false; if (res.ok) { emit('applied'); emit('update:modelValue', false) } else { yamlError = res.error }`。applyYaml 已自带 toast。

- [ ] **Step 1: 先做 Task 10(i18n 键)**

见 Task 10。完成后再回这里(组件依赖 `ns.netpolCreate.*`)。

- [ ] **Step 2: 写失败测试**

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const applyYamlMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import NetworkPolicyEditor from '@/components/networkpolicy/NetworkPolicyEditor.vue'

function mountIt(props = {}) {
  return mount(NetworkPolicyEditor, {
    props: { modelValue: true, namespace: 'default', ...props },
    global: { plugins: [createPinia(), i18n] },
  })
}

test('默认放行起步:两方向显示 allowAll 标签,Create 可点', () => {
  const w = mountIs()
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.consequenceAllowAll'))
})

test('删光 ingress 规则 → denyAll,Create 禁用;勾确认后可点', async () => {
  const w = mountIs()
  // 删除唯一 ingress 规则
  await w.find('button[data-test="rm-ingress-rule-0"]').trigger('click')
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.consequenceDenyAll'))
  const createBtn = w.find('button[data-test="create"]')
  expect(createBtn.attributes('disabled')).toBeDefined()
  await w.find('input[data-test="ack-denyall"]').setValue(true)
  expect(w.find('button[data-test="create"]').attributes('disabled')).toBeUndefined()
})

test('YAML save 合法 → 回填 model;非法 → 显示错误', async () => {
  const w = mountIs()
  // 通过找真实 YamlEditor 触发 save 事件 → 走 onYamlSave
  const yaml = w.findComponent({ name: 'YamlEditor' })
  // 合法:onYamlSave 把 model 替换为解析结果,名字输入框随之更新
  yaml.vm.$emit('save', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: fromyaml\n  namespace: default\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n  ingress: [{}]\n')
  await w.vm.$nextTick()
  expect(w.find('input[data-test="name-input"]').element.value).toBe('fromyaml')
  // 非法:显示解析错误
  yaml.vm.$emit('save', ':::bad:::')
  await w.vm.$nextTick()
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.err.parseError'))
})

function mountIs() { return mountIt() }
```

- [ ] **Step 3: 运行验证失败**

Run: `npx vitest run src/components/networkpolicy/__tests__/NetworkPolicyEditor.test.js`
Expected: FAIL(组件不存在)。

- [ ] **Step 4: 实现容器**

```vue
<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import NpSelectorEditor from './NpSelectorEditor.vue'
import NpRuleEditor from './NpRuleEditor.vue'
import { useResourceApply } from '@/composables/useResourceApply'
import {
  defaultModel, consequence, isDenyAll, modelToYaml, parseAndValidate,
  emptyIngressRule, emptyEgressRule,
} from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: 'default' },
})
const emit = defineEmits(['update:modelValue', 'applied'])
const { t } = useI18n()
const { applyYaml } = useResourceApply()

const model = ref(defaultModel(props.namespace))
watch(() => props.namespace, ns => { model.value = defaultModel(ns) })
watch(() => props.modelValue, v => { if (v) { model.value = defaultModel(props.namespace); yamlError.value = ''; ackDenyAll.value = false } })

const spec = computed(() => model.value.spec)
const yamlText = computed(() => modelToYaml(model.value))

const nameRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const nameValid = computed(() => nameRegex.test(model.value.metadata.name || ''))
const yamlEditing = ref(false)
const yamlError = ref('')
const ackDenyAll = ref(false)
const creating = ref(false)
const denyAll = computed(() => isDenyAll(spec.value))
const canCreate = computed(() => nameValid.value && (!denyAll.value || ackDenyAll.value))

const ingressCsq = computed(() => consequence(spec.value, 'ingress'))
const egressCsq = computed(() => consequence(spec.value, 'egress'))

function toggleType(type) {
  const arr = spec.value.policyTypes
  const i = arr.indexOf(type)
  if (i >= 0) arr.splice(i, 1); else arr.push(type)
}
function addIngressRule() { spec.value.ingress.push(emptyIngressRule()) }
function addEgressRule() { spec.value.egress.push(emptyEgressRule()) }
function setIngressRule(i, r) { spec.value.ingress[i] = r }
function setEgressRule(i, r) { spec.value.egress[i] = r }

function onYamlSave(text) {
  yamlEditing.value = false
  const res = parseAndValidate(text)
  if (res.ok) { model.value = res.model; yamlError.value = '' }
  else { yamlError.value = t('ns.netpolCreate.err.' + res.code) }
}
function onYamlDiscard() { yamlEditing.value = false; yamlError.value = '' }

async function submit() {
  if (!canCreate.value || creating.value) return
  creating.value = true
  const res = await applyYaml(modelToYaml(model.value))
  creating.value = false
  if (res.ok) { emit('applied', res); emit('update:modelValue', false) }
  else { yamlError.value = res.error }
}

function csqStateMeta(state) {
  return {
    none: { icon: 'remove', cls: 'text-on-surface-variant', key: 'consequenceNone' },
    denyAll: { icon: 'block', cls: 'text-error', key: 'consequenceDenyAll' },
    allowAll: { icon: 'warning', cls: 'text-tertiary', key: 'consequenceAllowAll' },
    scoped: { icon: 'check_circle', cls: 'text-primary', key: 'consequenceScoped' },
  }[state]
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('ns.netpolCreate.title')" width="max-w-6xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-lg">
      <!-- 左:表单 -->
      <div :class="yamlEditing ? 'opacity-50 pointer-events-none' : ''" class="flex flex-col gap-md">
        <div v-if="yamlEditing" class="text-body-sm text-tertiary">{{ t('ns.netpolCreate.yamlEditingHint') }}</div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.name') }} *</label>
          <input v-model="model.metadata.name" data-test="name-input" placeholder="my-policy"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-mono" />
          <p v-if="!nameValid && model.metadata.name" class="text-body-sm text-error mt-xs">{{ t('ns.netpolCreate.nameInvalid') }}</p>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.podSelector') }}</label>
          <NpSelectorEditor :model-value="spec.podSelector" @update:model-value="spec.podSelector = $event" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.policyTypes') }}</label>
          <div class="flex gap-md">
            <label class="flex items-center gap-xs"><input type="checkbox" :checked="spec.policyTypes.includes('Ingress')" @change="toggleType('Ingress')"> Ingress</label>
            <label class="flex items-center gap-xs"><input type="checkbox" :checked="spec.policyTypes.includes('Egress')" @change="toggleType('Egress')"> Egress</label>
          </div>
        </div>

        <!-- Ingress -->
        <div>
          <div class="flex items-center justify-between mb-xs">
            <span :class="csqStateMeta(ingressCsq.state).cls" class="flex items-center gap-xs text-body-sm font-medium">
              <span class="material-symbols-outlined text-sm">{{ csqStateMeta(ingressCsq.state).icon }}</span>
              {{ t('ns.netpolCreate.' + csqStateMeta(ingressCsq.state).key) }}
            </span>
            <button @click="addIngressRule" class="text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">{{ t('ns.netpolCreate.addIngressRule') }}</button>
          </div>
          <div v-for="(r, i) in spec.ingress" :key="'in'+i" class="flex items-start gap-sm">
            <div class="flex-1"><NpRuleEditor :model-value="r" direction="ingress" @update:model-value="setIngressRule(i, $event)" /></div>
            <button :data-test="`rm-ingress-rule-${i}`" @click="spec.ingress.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
          </div>
        </div>

        <!-- Egress -->
        <div>
          <div class="flex items-center justify-between mb-xs">
            <span :class="csqStateMeta(egressCsq.state).cls" class="flex items-center gap-xs text-body-sm font-medium">
              <span class="material-symbols-outlined text-sm">{{ csqStateMeta(egressCsq.state).icon }}</span>
              {{ t('ns.netpolCreate.' + csqStateMeta(egressCsq.state).key) }}
            </span>
            <button @click="addEgressRule" class="text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">{{ t('ns.netpolCreate.addEgressRule') }}</button>
          </div>
          <div v-for="(r, i) in spec.egress" :key="'eg'+i" class="flex items-center gap-sm">
            <div class="flex-1"><NpRuleEditor :model-value="r" direction="egress" @update:model-value="setEgressRule(i, $event)" /></div>
            <button @click="spec.egress.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
          </div>
        </div>
      </div>

      <!-- 右:YAML -->
      <div class="flex flex-col gap-sm">
        <YamlEditor :model-value="yamlText" :readonly="false" height="560px"
          @edit-start="yamlEditing = true" @save="onYamlSave" @discard="onYamlDiscard" />
        <p v-if="yamlError" class="text-body-sm text-error">{{ yamlError }}</p>
        <p v-if="denyAll" class="text-body-sm text-error">{{ t('ns.netpolCreate.denyAllWarn') }}</p>
      </div>
    </div>

    <template #actions>
      <label v-if="denyAll" class="flex items-center gap-xs text-body-sm text-error mr-auto">
        <input type="checkbox" data-test="ack-denyall" v-model="ackDenyAll" /> {{ t('ns.netpolCreate.denyAllConfirm') }}
      </label>
      <button @click="emit('update:modelValue', false)" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
      <button data-test="create" :disabled="!canCreate || creating" @click="submit"
        class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('ns.netpolCreate.create') }}</button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 5: 运行验证通过**

Run: `npx vitest run src/components/networkpolicy/__tests__/NetworkPolicyEditor.test.js`
Expected: PASS(`findComponent({name:'YamlEditor'})` 命中深层挂载的真实 YamlEditor;若 happy-dom 下 CodeViewer 高亮报错,给 YamlEditor 加 `global.stubs` 或 `shallowMount` 容器并 stub YamlEditor —— 执行时按实际报错调整,测试断言不变)。

- [ ] **Step 6: Commit**

```bash
git add src/components/networkpolicy/NetworkPolicyEditor.vue src/components/networkpolicy/__tests__/NetworkPolicyEditor.test.js
git commit -m "feat(networkpolicy): NetworkPolicyEditor 容器 — 后果标签/denyAll 守卫/YAML 双向/统一提交

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: i18n 键(zh + en 对齐)

**Files:**
- Modify: `src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Produces: `ns.netpolCreate.*` 全套键(供 Task 9 容器与未来 edit 复用);需与 `ns.netpolDetail` 同级

**执行顺序**:此 Task 须在 Task 9 之前(见 Task 9 Step 1)。

- [ ] **Step 1: 在 zh.json 的 `ns` 对象内,与 `netpolDetail` 同级,新增 `netpolCreate` 对象**

```json
"netpolCreate": {
  "title": "创建网络策略",
  "name": "名称",
  "nameInvalid": "名称需符合 DNS-1123(小写字母数字与 -. ,首尾为字母数字)",
  "podSelector": "Pod 选择器",
  "policyTypes": "策略类型",
  "addIngressRule": "+ 入站规则",
  "addEgressRule": "+ 出站规则",
  "consequenceNone": "不管控",
  "consequenceDenyAll": "⛔ 拒绝全部",
  "consequenceAllowAll": "⚠ 放行全部",
  "consequenceScoped": "✅ 仅放行",
  "denyAllWarn": "当前策略会阻断受管方向的所有流量",
  "denyAllConfirm": "我知这将阻断该方向所有流量",
  "yamlEditingHint": "正在编辑 YAML,表单已暂停 —— Save 应用 / Discard 还原",
  "create": "创建",
  "addLabel": "+ 标签",
  "matchExpressions": "matchExpressions",
  "exprValuesPlaceholder": "值,逗号分隔(Exists/DoesNotExist 留空)",
  "addExpression": "+ 表达式",
  "portPlaceholder": "端口(空=全部)",
  "peerPod": "Pod 选择器",
  "peerNamespace": "Namespace 选择器",
  "cidrPlaceholder": "CIDR 如 10.0.0.0/8",
  "exceptPlaceholder": "排除 CIDR,逗号分隔",
  "sourceFrom": "源 (from)",
  "targetTo": "目标 (to)",
  "ports": "端口",
  "addPeer": "+ 源/目标",
  "addPort": "+ 端口",
  "err": {
    "parseError": "YAML 解析失败",
    "notNetworkPolicy": "kind 不是 NetworkPolicy",
    "nameRequired": "metadata.name 必填"
  }
}
```

- [ ] **Step 2: en.json 同结构英文**

```json
"netpolCreate": {
  "title": "Create NetworkPolicy",
  "name": "Name",
  "nameInvalid": "Name must be DNS-1123 (lowercase alphanumerics and -. , alnum start/end)",
  "podSelector": "Pod Selector",
  "policyTypes": "Policy Types",
  "addIngressRule": "+ Ingress rule",
  "addEgressRule": "+ Egress rule",
  "consequenceNone": "Not governed",
  "consequenceDenyAll": "⛔ Deny all",
  "consequenceAllowAll": "⚠ Allow all",
  "consequenceScoped": "✅ Scoped allow",
  "denyAllWarn": "This policy will block all traffic on governed directions",
  "denyAllConfirm": "I understand this blocks all traffic on that direction",
  "yamlEditingHint": "Editing YAML — form paused. Save to apply / Discard to revert",
  "create": "Create",
  "addLabel": "+ label",
  "matchExpressions": "matchExpressions",
  "exprValuesPlaceholder": "values, comma-separated (empty for Exists/DoesNotExist)",
  "addExpression": "+ expression",
  "portPlaceholder": "port (empty = all)",
  "peerPod": "Pod selector",
  "peerNamespace": "Namespace selector",
  "cidrPlaceholder": "CIDR e.g. 10.0.0.0/8",
  "exceptPlaceholder": "exclude CIDR, comma-separated",
  "sourceFrom": "Source (from)",
  "targetTo": "Target (to)",
  "ports": "Ports",
  "addPeer": "+ peer",
  "addPort": "+ port",
  "err": {
    "parseError": "YAML parse failed",
    "notNetworkPolicy": "kind is not NetworkPolicy",
    "nameRequired": "metadata.name is required"
  }
}
```

- [ ] **Step 3: 校验对齐 + 无残存**

Run: `npm run i18n:check`
Expected: PASS(0 残存 / 键对齐 / 无引用缺失)。若报某键缺失,补齐 zh/en。

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "feat(i18n): ns.netpolCreate 键(zh/en 对齐)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 接入 NsNetworkPolicies.vue(换按钮 + 删旧创建弹窗)

**Files:**
- Modify: `src/views/NsNetworkPolicies.vue`

**Interfaces:**
- Consumes: `NetworkPolicyEditor`(Task 9)

- [ ] **Step 1: 删除旧创建逻辑**

删除 `<script setup>` 中:`showCreateModal`、`createForm`、`resetCreate`、`togglePolicyType`、`handleCreate`(约 58-97 行)。

- [ ] **Step 2: 加新状态 + 引用**

`<script setup>` 顶部 import 区加:
```js
import NetworkPolicyEditor from '@/components/networkpolicy/NetworkPolicyEditor.vue'
```
在 `handleDelete` 之前加:
```js
const showCreate = ref(false)
function onApplied() {
  // applyResourceYaml 内部已 invalidate cluster 查询;这里显式再刷一次本页 key 保险。
  queryClient.invalidateQueries({ queryKey: networkpoliciesKey })
}
```

- [ ] **Step 3: 换按钮 + 挂载向导**

模板里两个 `@click="showCreateModal = true"`(顶部 Create 按钮约 127 行、空状态按钮约 224 行)都改为 `@click="showCreate = true"`。

把模板末尾的 `<!-- Create NetworkPolicy Modal -->...`(约 228-261 行整块 Modal)替换为:
```html
  <!-- 创建向导 -->
  <NetworkPolicyEditor v-model="showCreate" :namespace="route.params.namespace" @applied="onApplied" />
```

- [ ] **Step 4: 校验 i18n + 类型**

Run: `npm run i18n:check && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 构建确认 .vue 可编译**

Run: `npm run build`
Expected: 构建成功(覆盖 .vue 模板编译检查)。

- [ ] **Step 6: Commit**

```bash
git add src/views/NsNetworkPolicies.vue
git commit -m "feat(networkpolicy): NsNetworkPolicies 创建入口换成结构化向导

- 移除 3 字段创建弹窗 + 死三元 handleCreate
- 接 NetworkPolicyEditor(后果标签/denyAll 守卫/YAML 双向)
- 创建统一走 applyResourceYaml(await+toast),根治非原子

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 全量验证 + 收尾

**Files:** 无新增(只跑命令 + 必要微调)

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: test:server(scripts/test.mjs 含 NetworkPolicy 纯逻辑)与 test:unit(全部 vitest,含新 6 个组件/编辑器测试)全 PASS。

- [ ] **Step 2: 类型 + i18n + 构建**

Run: `npm run typecheck && npm run i18n:check && npm run build`
Expected: 全 PASS。

- [ ] **Step 3: 手测清单(需真实或 mock 集群)**

- 打开 NetworkPolicies →「创建网络策略」→ 默认两方向 allowAll,YAML 实时可见,Create 可点。
- 删光 ingress 规则 → ⛔ 标签 + Create 禁用 → 勾确认 → 可点 → 创建成功 toast,列表出现。
- 名字填 `My Pol` → 校验提示 + Create 禁用。
- 点 YAML Edit → 改 `metadata.name` → Apply Changes → 表单回填;故意写坏 → Save → 错误提示,表单恢复可编辑。
- mock 模式创建能落库(验证 Task 3 upsert)。

- [ ] **Step 4: 若有微调则补提交,否则结束**

```bash
git status   # 确认干净
git log --oneline main..HEAD   # 查看本分支提交序列
```

---

## Self-Review(写计划后自查)

**Spec 覆盖**:
- 完整规则向导(决策1)→ Task 5-9 ✓
- 单页 + 实时 YAML(决策2)→ Task 9 容器双栏 + computed yamlText ✓
- 可编辑双向同步 + 优雅降级(决策3)→ Task 4(edit-start)+ Task 9(onYamlSave/parseAndValidate,失败显示错误、表单暂停)✓
- 放行起步(决策4)→ Task 1 defaultModel ✓
- 完整覆盖含进阶(决策5)→ matchExpressions(Task 5)、ipBlock.except(Task 7)、endPort(Task 6)✓
- 单按钮不 SplitButton(决策6)→ Task 11 ✓
- mock upsert 补丁(子决策3)→ Task 3 ✓
- 提交统一 applyResourceYaml 根治非原子 → Task 9 submit + Task 11 ✓
- 修复清单(await / 死三元 / DNS-1123 / 裸插值)→ Task 11 删旧 handleCreate + Task 9 nameValid + Task 2 js-yaml dump ✓

**类型/命名一致性**:`consequence` 返回 `{state,rules,peers,ports}` 在 Task 1/9 一致;`parseAndValidate` 返回 `{ok,model}`/`{ok:false,code,detail}` 在 Task 2/9 一致;工厂函数名 Task 1 定义、Task 6/7/8 消费一致;data-test 选择器与测试一致。

**已知执行期风险(已在对应 Task 标注)**:Task 6 内联事件 `e` 需用 `$event`;Task 9 容器测试在 happy-dom 下若 CodeViewer 高亮报错需 stub YamlEditor(断言不变)。
