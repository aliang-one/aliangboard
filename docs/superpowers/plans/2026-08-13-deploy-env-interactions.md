# DeployApp 环境变量交互修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复创建 workload 向导环境变量区块的 7 个交互问题:重复 env 名校验、换资源清 key、空行跳过、ns 漂移警示、envFrom 优先级提示、combobox 键盘导航、query key 响应式化。

**Architecture:** 校验逻辑抽成纯函数(`src/utils/envRows.js`,node:test 覆盖)供 `DeployApp.vue` 的 `validate()` 调用;交互增强集中在 `EnvSourceField.vue`(用户事件驱动,程序化赋值不受影响);query key 全库改为传 ref。工作分支 `fix/deploy-env-interactions`(基于 main `35ca3f0`,spec 已提交 `68008a4`)。

**Tech Stack:** Vue 3 SFC(`<script setup>`)、Tailwind(MD3 token)、vue-i18n(嵌套 JSON,`src/locales/{zh,en}.json`)、@tanstack/vue-query v5(支持 key 内 ref)、node:test(.mjs 纯逻辑)+ vitest(.js 组件)。

## Global Constraints

- 仓库默认**不新增外部依赖**。
- i18n 新键必须 **zh.json 与 en.json 同步**,`npm run i18n:check` 通过;消息值里字面 `@` 须转义 `{'@'}`(本次 3 键均不含 `@`)。
- 纯逻辑测试走 node:test:`.test.mjs` 文件(vitest 只收 `.js`),且必须在 `package.json` 的 `test:server` 链显式注册。
- 组件测试放 `__tests__/` 目录、相对导入组件(惯例见 `src/components/__tests__/CodeViewer.test.js`)。
- 不改 YAML 生成逻辑、不动 envFrom「单 CM + 单 Secret」结构、不动 ports 等其他区块。
- 每个任务收尾跑:`npm run typecheck` + `npm run build` + `npm run i18n:check`(Task 1 无 i18n 改动可跳过 i18n:check)。
- 验证命令输出以实际运行为准,不许臆断通过。

---

## File Structure

- **Create** `src/utils/envRows.js` — 环境变量行级判定纯函数(Task 1)
- **Create** `src/utils/envRows.test.mjs` — node:test 单测(Task 1)
- **Modify** `package.json` — `test:server` 链注册(Task 1)
- **Modify** `src/views/DeployApp.vue` — validate() 接线 + envFrom hint(Task 2)
- **Modify** `src/locales/zh.json`、`src/locales/en.json` — 3 个新键(Task 2)
- **Modify** `src/components/common/EnvSourceField.vue` — ②清 key/④警示/⑥键盘(Task 3)
- **Create** `src/components/__tests__/EnvSourceField.test.js` — vitest 组件测试(Task 3)
- **Modify** `src/components/common/TagInput.vue`、`CreatePvcDialog.vue`、`src/components/layout/TopNavBar.vue` 等 — query key 传 ref(Task 4,grep 全量清点)

---

## Task 1: envRows 纯函数(TDD)

**Files:**
- Create: `src/utils/envRows.js`
- Create: `src/utils/envRows.test.mjs`
- Modify: `package.json`(`test:server` 脚本,约 14 行)

**Interfaces:**
- Produces(后续任务依赖,签名精确):
  - `isEmptyEnvRow(row, fields)` — `row: Object|null`,`fields: string[]`;所有字段均为空串/whitespace/undefined/null 时返回 `true`。
  - `firstDuplicateEnvName(envVars, envCMKeys, envSecretKeys)` — 三个数组,元素分别含 `key` / `name` / `name` 字段;返回第一个重复的非空名(trim 后比较),无重复返回 `null`。

- [ ] **Step 1: 写失败测试**

创建 `src/utils/envRows.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyEnvRow, firstDuplicateEnvName } from './envRows.js'

test('isEmptyEnvRow: 全空行 → true', () => {
  assert.equal(isEmptyEnvRow({ key: '', value: '' }, ['key', 'value']), true)
  assert.equal(isEmptyEnvRow({ name: '', cmName: '', key: '' }, ['name', 'cmName', 'key']), true)
  assert.equal(isEmptyEnvRow({ name: '  ', cmName: '', key: '' }, ['name', 'cmName', 'key']), true)
})

test('isEmptyEnvRow: 半填或全填 → false', () => {
  assert.equal(isEmptyEnvRow({ key: '', value: 'x' }, ['key', 'value']), false)
  assert.equal(isEmptyEnvRow({ name: 'A', cmName: '', key: '' }, ['name', 'cmName', 'key']), false)
  assert.equal(isEmptyEnvRow({ name: 'A', cmName: 'cm', key: 'k' }, ['name', 'cmName', 'key']), false)
})

test('isEmptyEnvRow: null 或缺字段 → true', () => {
  assert.equal(isEmptyEnvRow(null, ['key']), true)
  assert.equal(isEmptyEnvRow({}, ['key', 'value']), true)
})

test('firstDuplicateEnvName: 跨三处重复 → 返回该名', () => {
  assert.equal(
    firstDuplicateEnvName([{ key: 'FOO', value: '1' }], [{ name: 'FOO', cmName: 'cm', key: 'k' }], []),
    'FOO',
  )
  assert.equal(
    firstDuplicateEnvName([], [{ name: 'BAR', cmName: 'cm', key: 'k' }], [{ name: 'BAR', secretName: 's', key: 'k' }]),
    'BAR',
  )
})

test('firstDuplicateEnvName: 单处内部重复 → 返回该名', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }, { key: 'A' }], [], []), 'A')
  assert.equal(firstDuplicateEnvName([], [], [{ name: 'B' }, { name: 'B' }]), 'B')
})

test('firstDuplicateEnvName: trim 后同名也算重复', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }], [{ name: ' A' }], []), 'A')
})

test('firstDuplicateEnvName: 无重复或全空名 → null', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }], [{ name: 'B' }], [{ name: 'C' }]), null)
  assert.equal(firstDuplicateEnvName([{ key: '' }, { key: ' ' }], [], []), null)
  assert.equal(firstDuplicateEnvName(), null)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/utils/envRows.test.mjs`
Expected: FAIL(`Cannot find module .../envRows.js`)。

- [ ] **Step 3: 最小实现**

创建 `src/utils/envRows.js`:

```js
// DeployApp 环境变量三区块(envVars / envCMKeys / envSecretKeys)共用的行级判定纯函数。
// 校验端(validate)与 YAML 生成端共用语义:整行全空 → 跳过;跨区块收集名 → 查重(K8s 拒绝重复 env 名)。

export function isEmptyEnvRow(row, fields) {
  if (!row) return true
  return fields.every(f => {
    const v = row[f]
    return v === undefined || v === null || String(v).trim() === ''
  })
}

export function firstDuplicateEnvName(envVars = [], envCMKeys = [], envSecretKeys = []) {
  const names = [
    ...(envVars || []).map(e => e?.key),
    ...(envCMKeys || []).map(e => e?.name),
    ...(envSecretKeys || []).map(e => e?.name),
  ]
  const seen = new Set()
  for (const n of names) {
    const k = (n ?? '').trim()
    if (!k) continue
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/utils/envRows.test.mjs`
Expected: PASS(全部用例)。

- [ ] **Step 5: 注册进 test:server**

`package.json` 的 `"test:server"` 脚本(约 14 行)是一条长 `&&` 链,以 `node --test scripts/i18n-check.test.mjs",` 结尾。把它改为以 `... && node --test scripts/i18n-check.test.mjs && node --test src/utils/envRows.test.mjs",` 结尾(即在闭引号前追加一段,注意保留行尾逗号)。

- [ ] **Step 6: 全链验证**

Run: `npm run test:server`
Expected: PASS(原有全绿 + 新增 envRows 用例)。

- [ ] **Step 7: Commit**

```bash
git add src/utils/envRows.js src/utils/envRows.test.mjs package.json
git commit -m "$(cat <<'EOF'
feat(deploy): envRows 纯函数(空行判定 + 跨区块重复名检测)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: validate() 接线 + envFrom hint + i18n 键(①③⑤)

**Files:**
- Modify: `src/views/DeployApp.vue`(imports 区 ~L9;validate() ~L671-673;envFrom 区块 ~L1020-1031)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`deploy` 对象内 2 键 + 新顶层 `envSource` 对象 1 键)

**Interfaces:**
- Consumes: Task 1 的 `isEmptyEnvRow(row, fields)` 与 `firstDuplicateEnvName(envVars, envCMKeys, envSecretKeys)`(`import ... from '@/utils/envRows'`)。
- Produces: i18n 键 `envSource.nsMissing`(Task 3 的组件渲染用)。

- [ ] **Step 1: DeployApp.vue 加 import**

在 `import { PERF_GROUPS, buildIngressAnnotations } from '@/composables/useIngressPerf'`(约 L9)之后加一行:

```js
import { isEmptyEnvRow, firstDuplicateEnvName } from '@/utils/envRows'
```

- [ ] **Step 2: 替换 validate() 的三行 env 校验**

先 Read `src/views/DeployApp.vue` 定位(行号可能漂移,按内容匹配)。找到这三行:

```js
  f.envVars.forEach((e, i) => { if (!e.key) errs.push({ step: 1, msg: t('deploy.envMissingKey', { idx: i + 1 }) }) })
  f.envCMKeys.forEach(e => { if (!e.name || !e.cmName || !e.key) errs.push({ step: 1, msg: t('deploy.envCmMissing', { name: e.name || '—' }) }) })
  f.envSecretKeys.forEach(e => { if (!e.name || !e.secretName || !e.key) errs.push({ step: 1, msg: t('deploy.envSecretMissing', { name: e.name || '—' }) }) })
```

替换为(空行跳过 + 重复名检查):

```js
  f.envVars.forEach((e, i) => { if (!isEmptyEnvRow(e, ['key', 'value']) && !e.key) errs.push({ step: 1, msg: t('deploy.envMissingKey', { idx: i + 1 }) }) })
  f.envCMKeys.forEach(e => { if (!isEmptyEnvRow(e, ['name', 'cmName', 'key']) && (!e.name || !e.cmName || !e.key)) errs.push({ step: 1, msg: t('deploy.envCmMissing', { name: e.name || '—' }) }) })
  f.envSecretKeys.forEach(e => { if (!isEmptyEnvRow(e, ['name', 'secretName', 'key']) && (!e.name || !e.secretName || !e.key)) errs.push({ step: 1, msg: t('deploy.envSecretMissing', { name: e.name || '—' }) }) })
  const dupEnvName = firstDuplicateEnvName(f.envVars, f.envCMKeys, f.envSecretKeys)
  if (dupEnvName) errs.push({ step: 1, msg: t('deploy.envDuplicateName', { name: dupEnvName }) })
```

- [ ] **Step 3: envFrom 区块下加 hint**

定位「整体引用(envFrom)」区块:结构为 `<h4>…{{ $t('deploy.envFrom') }}</h4>` + `<div class="grid grid-cols-2 gap-sm mb-md">`(内含 fromConfigMap / fromSecret 两个 EnvSourceField)。在该 grid 的闭合 `</div>` 之后插入:

```html
        <p class="text-xs text-on-surface-variant/80 -mt-sm mb-md">{{ $t('deploy.envFromHint') }}</p>
```

(插入后的局部:`…v-model:name="form.envFromSecret" />\n          </div>\n        </div>\n        <p class="text-xs …envFromHint…</p>`)

- [ ] **Step 4: 加 i18n 键(zh + en 同步)**

`src/locales/zh.json`:在 `"deploy"` 对象内(建议紧挨现有 `envCmMissing` 键之后)加:

```json
"envDuplicateName": "环境变量 {name} 重复:同一容器内 env 名字必须唯一",
"envFromHint": "同名时:独立环境变量优先于整体引用;ConfigMap 与 Secret 含同名 key 时 Secret 生效",
```

并在 zh.json 顶层新建对象:

```json
"envSource": {
  "nsMissing": "当前命名空间未找到该资源(可跨命名空间手输)"
},
```

`src/locales/en.json` 对应位置:

```json
"envDuplicateName": "Env var {name} is duplicated — env names must be unique within a container",
"envFromHint": "On collisions: individual env vars override envFrom; Secret wins over ConfigMap for the same key",
```

顶层:

```json
"envSource": {
  "nsMissing": "Resource not found in the current namespace (cross-namespace manual input allowed)"
},
```

注意 JSON 逗号(加在对象末尾需给前一键补逗号;放中间则自身带逗号)。改完用 `node -e "JSON.parse(require('fs').readFileSync('src/locales/zh.json'));JSON.parse(require('fs').readFileSync('src/locales/en.json'));console.log('json ok')"` 验证。

- [ ] **Step 5: 全量门禁**

Run: `npm run typecheck && npm run build && npm run i18n:check && npm run test:server`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/views/DeployApp.vue src/locales/zh.json src/locales/en.json
git commit -m "$(cat <<'EOF'
feat(deploy): 校验空行跳过+重复 env 名;envFrom 优先级提示

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: EnvSourceField 交互(②④⑥)+ 组件测试

**Files:**
- Modify: `src/components/common/EnvSourceField.vue`(整文件 ~92 行,改动:script 加 i18n/清 key/警示/键盘导航,template 加事件与警示行)
- Create: `src/components/__tests__/EnvSourceField.test.js`

**Interfaces:**
- Consumes: i18n 键 `envSource.nsMissing`(Task 2 已加)。
- Produces: 无(叶子组件)。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/EnvSourceField.test.js`:

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import EnvSourceField from '../common/EnvSourceField.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'c1', fetchConfigMaps: vi.fn(), fetchSecrets: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', async () => {
  const { ref } = await import('vue')
  const mk = items => ({ data: ref(items), isSuccess: ref(true) })
  return {
    useResourceList: ({ key }) => String(key).includes('secrets')
      ? mk([{ namespace: 'default', name: 'sec-a', data: { tok: 'x' } }])
      : mk([{ namespace: 'default', name: 'cm-a', data: { foo: '1', bar: '2' } }]),
  }
})

const mountField = (props = {}) => mount(EnvSourceField, {
  props: { kind: 'configmap', namespace: 'default', withKey: true, ...props },
})

test('② 用户键入资源名 → dataKey 被清空', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.find('input').setValue('cm-b') // setValue 触发原生 input 事件
  expect(w.emitted('update:dataKey')?.at(-1)).toEqual([''])
})

test('② 程序化改 name(prop)→ dataKey 不清(复制 workload 回填场景)', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.setProps({ name: 'cm-b' })
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('② withKey=false(envFrom 场景)→ 键入不产生 update:dataKey', async () => {
  const w = mountField({ withKey: false, name: 'cm-a' })
  await w.find('input').setValue('cm-b')
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('④ name 不在当前 ns 列表 → 显 nsMissing;匹配 → 不显', async () => {
  const miss = mountField({ name: 'ghost-cm', withKey: false })
  expect(miss.html()).toContain('envSource.nsMissing')
  const hit = mountField({ name: 'cm-a', withKey: false })
  expect(hit.html()).not.toContain('envSource.nsMissing')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/__tests__/EnvSourceField.test.js`
Expected: FAIL(键入清 key / nsMissing 断言失败;程序化赋值那条可能已过,无妨)。

- [ ] **Step 3: 改 EnvSourceField.vue**

**Script 段**(先 Read 全文件再改;`defineModel`/props/store/useResourceList 部分不动):

imports 改为:

```js
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
```

在 `const dataKey = defineModel('dataKey', { default: '' })` 之后加:

```js
const { t } = useI18n()
```

在 `const keyOptions = ...` 之后加:

```js
// ④ ns 漂移警示:name 非空 && 列表已成功加载 && 当前 ns 无精确匹配(不拦提交,尊重跨 ns 手输)
const listLoaded = computed(() => (props.kind === 'secret' ? _secQ.isSuccess.value : _cmQ.isSuccess.value))
const nsMissing = computed(() => Boolean(name.value && name.value.trim()) && listLoaded.value && !selected.value)
```

键盘导航状态与处理函数(放在 `pickName`/`pickKey` 定义之前):

```js
const activeName = ref(-1)
const activeKey = ref(-1)
```

`pickName` 改为(加清 key):

```js
function pickName(o) { name.value = o; openName.value = false; clearDataKey() }
```

在 `pickKey` 之后加:

```js
// ② 用户换资源(键入或下拉重选)→ 清空 key;程序化赋值(复制 workload 回填)不触发 input 事件,不受影响
function clearDataKey() { if (props.withKey) dataKey.value = '' }

// ⑥ 键盘导航:↑/↓ 高亮、Enter 选中、Esc 关闭;失焦关闭(下拉选项 mousedown.prevent 保焦,不触发 blur)
function onNameFocus() { openName.value = true; activeName.value = -1 }
function onNameBlur() { openName.value = false }
function onNameKeydown(e) {
  const opts = filterName.value
  if (e.key === 'Escape') { openName.value = false; return }
  if (!openName.value || !opts.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); activeName.value = (activeName.value + 1) % opts.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeName.value = (activeName.value - 1 + opts.length) % opts.length }
  else if (e.key === 'Enter') { e.preventDefault(); const o = opts[activeName.value]; if (o) pickName(o) }
}
function onKeyFocus() { openKey.value = true; activeKey.value = -1 }
function onKeyBlur() { openKey.value = false }
function onKeyKeydown(e) {
  const opts = filterKey.value
  if (e.key === 'Escape') { openKey.value = false; return }
  if (!openKey.value || !opts.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); activeKey.value = (activeKey.value + 1) % opts.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeKey.value = (activeKey.value - 1 + opts.length) % opts.length }
  else if (e.key === 'Enter') { e.preventDefault(); const o = opts[activeKey.value]; if (o) pickKey(o) }
}
```

**Template 段**整体替换为:

```html
<template>
  <div class="min-w-0 w-full">
    <div class="flex gap-xs min-w-0">
      <!-- 资源名 combobox -->
      <div ref="nameWrap" class="relative flex-1 min-w-0">
        <input
          v-model="name" :class="inputClass"
          @focus="onNameFocus"
          @input="clearDataKey"
          @keydown="onNameKeydown"
          @blur="onNameBlur"
          :placeholder="kind === 'secret' ? 'Secret' : 'ConfigMap'"
        />
        <div v-if="openName && filterName.length" :class="panelClass">
          <button type="button" v-for="(o, i) in filterName" :key="o" @mousedown.prevent="pickName(o)" :class="[optClass, i === activeName ? 'bg-primary-container/40' : '']" :title="o">{{ o }}</button>
        </div>
      </div>
      <!-- key combobox -->
      <div v-if="withKey" ref="keyWrap" class="relative flex-1 min-w-0">
        <input
          v-model="dataKey" :class="inputClass"
          @focus="onKeyFocus"
          @keydown="onKeyKeydown"
          @blur="onKeyBlur"
          placeholder="key"
        />
        <div v-if="openKey && filterKey.length" :class="panelClass">
          <button type="button" v-for="(o, i) in filterKey" :key="o" @mousedown.prevent="pickKey(o)" :class="[optClass, i === activeKey ? 'bg-primary-container/40' : '']" :title="o">{{ o }}</button>
        </div>
      </div>
    </div>
    <!-- ④ ns 漂移警示 -->
    <div v-if="nsMissing" class="mt-xs text-xs text-error/80">{{ t('envSource.nsMissing') }}</div>
  </div>
</template>
```

要点:根节点从 `flex` 换成块级包裹(内部保留原 flex 行),外部父级给的 `flex-1`/`class` 落在新根上语义不变;name 输入框 `@input="clearDataKey"` 只在用户键入时触发。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/__tests__/EnvSourceField.test.js`
Expected: PASS(4 条全过)。

- [ ] **Step 5: 全量门禁**

Run: `npm run typecheck && npm run build && npm run test:unit`
Expected: 全 PASS(63+1 文件,无回归;`_allViewsMount` 等不受影响)。

- [ ] **Step 6: Commit**

```bash
git add src/components/common/EnvSourceField.vue src/components/__tests__/EnvSourceField.test.js
git commit -m "$(cat <<'EOF'
feat(deploy): EnvSourceField 换资源清 key + ns 漂移警示 + 键盘导航

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: query key 响应式化(⑦)

**Files:**
- Modify: `src/components/common/EnvSourceField.vue:26-27`、`src/components/common/TagInput.vue:22`、`src/components/common/CreatePvcDialog.vue:19`、`src/components/layout/TopNavBar.vue:21-29`,及 grep 清点出的其余调用点

**Interfaces:** 无(纯 key 构造方式变化;@tanstack/vue-query v5 支持 key 数组内 ref,响应式解包)。

- [ ] **Step 1: 全量清点**

Run: `grep -rn "useResourceList({ key:\|useResourceDetail({ key:" src/ | grep "\.value"`
记录每一处(预期 ≥ 12 处:EnvSourceField×2、TagInput×1、CreatePvcDialog×1、TopNavBar×8±)。同时跑 `grep -rn "key: \['cluster'" src/ | grep "\.value"` 兜底其他写法。

- [ ] **Step 2: 逐处改 `.value` → 传 ref 本体**

每处形如:

```js
const _cmQ = useResourceList({ key: ['cluster', _cid.value, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
```

改为:

```js
const _cmQ = useResourceList({ key: ['cluster', _cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
```

只删 key 数组里的 `.value`,其余(fetcher/options)一律不动。TopNavBar 的 `cid.value` 同理改 `cid`。

- [ ] **Step 3: grep 验证清零**

Run: `grep -rn "useResourceList({ key:\|useResourceDetail({ key:" src/ | grep "\.value"; grep -rn "key: \['cluster'" src/ | grep "\.value"`
Expected: 两条均无输出(退出码 1)。

- [ ] **Step 4: 全量门禁**

Run: `npm run typecheck && npm run build && npm run test:unit && npm run test:server`
Expected: 全 PASS(vue-query 对含 ref 的 key 响应式解包,集群不变时零行为差异)。

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "$(cat <<'EOF'
refactor(query): query key 传 ref 本体,切集群时 key 正确跟随

setup 时快照 cid.value 会在切集群后错位缓存;vue-query v5 支持
key 内 ref 响应式解包。集群不变时零行为差异。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review(写完后自检)

1. **Spec 覆盖**:①→Task 1+2;②→Task 3;③→Task 1+2;④→Task 3;⑤→Task 2;⑥→Task 3;⑦→Task 4;i18n→Task 2;测试策略(node:test + vitest + 门禁)→各任务步骤。无遗漏。
2. **占位符扫描**:所有代码步骤均给出完整代码;无 TBD/TODO/"适当处理"。
3. **命名一致**:`isEmptyEnvRow`/`firstDuplicateEnvName` 在 Task 1 定义、Task 2 消费签名一致;`envSource.nsMissing` Task 2 加键、Task 3 渲染一致;`clearDataKey`/`onNameKeydown` 等定义与模板引用一致。
