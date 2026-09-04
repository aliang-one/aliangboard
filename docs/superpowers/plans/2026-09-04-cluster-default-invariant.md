# 集群默认不变式(cluster-default invariant)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「集群默认」类(IngressClass/StorageClass)必须存在才可在创建流程中被选择;详情页显眼设默认(sweep 保唯一);IngressClass 详情页获得关联 Ingress(端口)可见性。

**Architecture:** 单源纯逻辑(classDefault.js)→ 手术式 patch(useClassPatch.js,merge-patch)→ store 层 promote/demote+sweep(crud.js 手写,不走 makeCrud 有损路径)→ 五个视图消费(三态选项/默认钮/守卫)。sweep 顺序恒「先摘旧后写新」,失败中止防双默认。

**Tech Stack:** Vue 3 SFC + Pinia(store=cluster/crud.js)+ Vue Query(useResourceList/useResourceDetail)+ vitest(happy-dom)+ node:test 零依赖运行器(纯逻辑)。

**Spec:** `docs/superpowers/specs/2026-09-04-cluster-default-invariant-design.md`(计划从 spec 论证,执行者须同读)

## Global Constraints

- 仓库零外部依赖政策:纯逻辑测试用 node:test(`src/logic/*.test.mjs`,须把文件追加进 package.json `test:server` 链,该链是显式枚举不自动发现);组件/store 测试用 vitest。
- 提交作者恒 `aliang-one <aliangdone@gmail.com>`(repo config 已设,提交前核 `git config user.email`);**禁止** `Co-Authored-By: Claude` 尾注;提交信息英文。
- mapper 字段名:IngressClass 默认字段 = `isDefault`;StorageClass 默认字段 = `default`(两域不同,勿混)。
- IC 默认注解键 `ingressclass.kubernetes.io/is-default-class`;SC 摘除需双键 `storageclass.kubernetes.io/is-default-class` + `storageclass.beta.kubernetes.io/is-default-class`。
- i18n:en.json/zh.json 必须同步加键(parity 门禁);zh 值用中文。
- merge-patch 删除语义:注解值置 `null` = 删除键。
- 全部工作在 worktree 分支 `worktree-feat+cluster-default-invariant`(已就绪,基于 main f6a94fb);Edit 用 worktree 绝对路径 `/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+cluster-default-invariant/...`。
- `pickIngressClassName`(src/logic/ingressClass.js)**不改**。
- 每次 `npm run test:unit` 全量跑约 5 分钟;任务内先用 `npx vitest run <file>` 定向,收尾任务才跑全量。

---

### Task 1: classDefault 单源纯逻辑

**Files:**
- Create: `src/logic/classDefault.js`
- Create: `src/logic/classDefault.test.mjs`
- Modify: `package.json:14`(test:server 链末尾追加)

**Interfaces:**
- Produces: `findDefaultClass(classes, key='isDefault')` → 类对象或 null;`canUseClusterDefault(classes, key='isDefault')` → boolean;`resolveClusterDefaultName(classes, key='isDefault')` → string('' 当无默认)。Task 4/6 消费(IC 传默认 key,SC 传 `'default'`)。

- [ ] **Step 1: Write the failing test** — `src/logic/classDefault.test.mjs`(仿 ingressClass.test.mjs 风格,node:test):

```js
// src/logic/classDefault.test.mjs —— 集群默认类单源语义零依赖用例(node --test,进 test:server 链)
// spec §3.1:两域 mapper 字段名不同(IC=isDefault / SC=default)→ key 参数化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDefaultClass, canUseClusterDefault, resolveClusterDefaultName } from './classDefault.js'

test('findDefaultClass: IC 字段 isDefault', () => {
  const classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  assert.equal(findDefaultClass(classes)?.name, 'nginx')
})

test('findDefaultClass: SC 字段 default(key 参数)', () => {
  const classes = [{ name: 'slow' }, { name: 'fast', default: true }]
  assert.equal(findDefaultClass(classes, 'default')?.name, 'fast')
})

test('canUseClusterDefault: 无默认 → false(空列表/undefined 同)', () => {
  assert.equal(canUseClusterDefault([{ name: 'a' }]), false)
  assert.equal(canUseClusterDefault([], 'default'), false)
  assert.equal(canUseClusterDefault(undefined), false)
})

test('resolveClusterDefaultName: 有默认 → 显式名;无默认 → 空串', () => {
  assert.equal(resolveClusterDefaultName([{ name: 'x' }, { name: 'nginx', isDefault: true }]), 'nginx')
  assert.equal(resolveClusterDefaultName([{ name: 'x' }]), '')
  assert.equal(resolveClusterDefaultName(null, 'default'), '')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/logic/classDefault.test.mjs`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation** — `src/logic/classDefault.js`:

```js
// src/logic/classDefault.js —— 集群级「默认类」单源语义(2026-09-04 集群默认不变式,spec §3.1)。
// 不变式:「集群默认」选项仅当集群存在被标记默认的类才可选;落库用显式默认类名,不写空值。
// 两域 mapper 字段名不同:IngressClass=isDefault,StorageClass=default → key 参数化。
export function findDefaultClass(classes, key = 'isDefault') {
  return (classes || []).find(c => c && c[key]) || null
}
export function canUseClusterDefault(classes, key = 'isDefault') {
  return !!findDefaultClass(classes, key)
}
export function resolveClusterDefaultName(classes, key = 'isDefault') {
  return findDefaultClass(classes, key)?.name || ''
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/logic/classDefault.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: 接入 test:server 链** — package.json `test:server` 值末尾(现有最后一项是 `node --test src/logic/ingressClass.test.mjs`)追加 ` && node --test src/logic/classDefault.test.mjs`。

Run: `node --test src/logic/classDefault.test.mjs`(链内同命令已过,此步只改链)
Expected: package.json 仍是合法 JSON(`node -e "JSON.parse(require('fs').readFileSync('package.json'))"`)

- [ ] **Step 6: Commit**

```bash
git add src/logic/classDefault.js src/logic/classDefault.test.mjs package.json
git commit -m "feat(logic): classDefault single-source semantics (default must exist to be selectable)"
```

---

### Task 2: buildIngressClassPatch 手术式 patch

**Files:**
- Create: `src/composables/useClassPatch.js`
- Test: `src/composables/__tests__/useClassPatch.test.js`

**Interfaces:**
- Produces: `buildIngressClassPatch(original, { isDefault })` → null | `{ metadata: { annotations: { [KEY]: 'true' | null } } }`;常量 `INGRESSCLASS_DEFAULT_KEY`。`original` 是 mapIngressClass 输出(含 `isDefault` boolean)。Task 3 的 promote/demote 用它构造 PATCH body。

- [ ] **Step 1: Write the failing test** — `src/composables/__tests__/useClassPatch.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildIngressClassPatch, INGRESSCLASS_DEFAULT_KEY } from '../useClassPatch'

// spec §3.2:IC 单键;设默认写 'true',取消默认走 null 删除(不留 'false' 尸体);无改动返回 null。
describe('buildIngressClassPatch', () => {
  it('设默认:写注解 true', () => {
    const p = buildIngressClassPatch({ name: 'nginx', isDefault: false }, { isDefault: true })
    expect(p).toEqual({ metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: 'true' } } })
  })
  it('取消默认:注解置 null(merge-patch 删除语义)', () => {
    const p = buildIngressClassPatch({ name: 'nginx', isDefault: true }, { isDefault: null })
    expect(p).toEqual({ metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: null } } })
  })
  it('状态未变 → null(不发起空 PATCH)', () => {
    expect(buildIngressClassPatch({ isDefault: true }, { isDefault: true })).toBeNull()
    expect(buildIngressClassPatch({ isDefault: false }, { isDefault: false })).toBeNull()
    expect(buildIngressClassPatch({}, {})).toBeNull()
  })
  it('无默认对象上取消默认(幂等)→ null', () => {
    expect(buildIngressClassPatch({ isDefault: false }, { isDefault: null })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/composables/__tests__/useClassPatch.test.js`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation** — `src/composables/useClassPatch.js`(仿 useStoragePatch.js 头注释风格):

```js
// 构造 IngressClass 编辑的 merge-patch body(手术式:只含改动字段)。
// 与 buildStorageClassPatch 的差异:IC 单注解键;取消默认置 null(删除)而非 'false'。
// 无依赖纯函数;store 的 promoteIngressClassDefault/demoteIngressClassDefault 复用(spec §3.2)。
export const INGRESSCLASS_DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'

export function buildIngressClassPatch(original = {}, { isDefault } = {}) {
  if (isDefault == null) {
    // 取消默认:仅当当前确实是默认才有事可做(幂等)
    if (!original.isDefault) return null
    return { metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: null } } }
  }
  if (!!isDefault === !!original.isDefault) return null
  return { metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: isDefault ? 'true' : null } } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/composables/__tests__/useClassPatch.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useClassPatch.js src/composables/__tests__/useClassPatch.test.js
git commit -m "feat(composables): buildIngressClassPatch surgical merge-patch (set/unset default annotation)"
```

---

### Task 3: store 层 sweep + promote/demote

**Files:**
- Modify: `src/stores/cluster/crud.js`(import 行、updateStorageClass、新函数、return 列表)
- Modify: `src/stores/cluster.js:88-95`(destructure)与 store return 对象(`addIngressClass...` 同款两处)
- Test: `src/stores/__tests__/cluster.class-default.test.js`

**Interfaces:**
- Consumes: Task 2 `buildIngressClassPatch`;现有 `remotePatch(path, patch, label)`({ok} 契约,内部 toast)、`invalidateResource(resource)`、`fetchIngressClasses()`/`fetchStorageClass(name)`(crud.js 已 import 单数,复数需补)、`fetchStorageClasses()`(需补 import)、`notify`/`i18n`(crud.js 已 import)。
- Produces(store 方法,视图在 Task 5/7 消费):
  - `promoteIngressClassDefault(name)` → `{ok:true}` | `{ok:false,error}`——先静默 sweep 其余默认,失败则中止不改目标
  - `demoteIngressClassDefault(name)` → 同契约,摘本类注解(null)
  - `promoteStorageClassDefault(name)` → 同契约,SC 双 beta 键 sweep
  - `updateStorageClass(name, updates)` 行为扩展:`updates.isDefault === true` 时先 sweep 其余 SC 默认,失败中止返回 `{ok:false}`

- [ ] **Step 1: Write the failing test** — `src/stores/__tests__/cluster.class-default.test.js`(桩形状照抄 `cluster.crud-factory.test.js` 头部:api/client 桩 + @/queryClient 桩 + localStorage 垫片 + setActivePinia(createPinia());此处给出差异核心,桩模板从该文件 1-60 行复制):

```js
// ……(从 cluster.crud-factory.test.js 复制:vi.mock('@/api/client') 用同一桩形状、
//  vi.mock('@/queryClient')、localStorage 垫片、beforeAll setActivePinia(createPinia());store = useClusterStore())
// 本文件新增断言:

const IC_KEY = 'ingressclass.kubernetes.io/is-default-class'

test('promoteIngressClassDefault: 先摘旧默认(sweep)再写新默认', async () => {
  fetchIngressClassesImpl = async () => [
    { name: 'old', isDefault: true },
    { name: 'new' },
  ]
  k8s.mockClear()
  const r = await store.promoteIngressClassDefault('new')
  expect(r.ok).toBe(true)
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  expect(patches).toHaveLength(2)
  expect(patches[0][0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/old')
  expect(patches[0][1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: null } } }))
  expect(patches[1][0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/new')
  expect(patches[1][1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: 'true' } } }))
  expect(invalidateQueries).toHaveBeenCalled()
})

test('promoteIngressClassDefault: sweep 失败 → 中止,不写目标(防双默认)', async () => {
  fetchIngressClassesImpl = async () => [{ name: 'old', isDefault: true }, { name: 'new' }]
  k8s.mockImplementation(async (path, opts) => {
    if (opts?.method === 'PATCH' && String(path).endsWith('/old')) throw new Error('403')
    return {}
  })
  k8s.mockClear()
  // 注意 mockImplementation 后仍可计数;先实现再 clear
  const r = await store.promoteIngressClassDefault('new')
  expect(r.ok).toBe(false)
  const targetPatch = k8s.mock.calls.filter(c => String(c[0]).endsWith('/new') && c[1]?.method === 'PATCH')
  expect(targetPatch).toHaveLength(0)
})

test('demoteIngressClassDefault: 摘本类注解(null)', async () => {
  k8s.mockReset()
  k8s.mockImplementation(async () => ({}))
  const r = await store.demoteIngressClassDefault('old')
  expect(r.ok).toBe(true)
  const p = k8s.mock.calls.find(c => c[1]?.method === 'PATCH')
  expect(p[0]).toBe('/apis/networking.k8s.io/v1/ingressclasses/old')
  expect(p[1].body).toBe(JSON.stringify({ metadata: { annotations: { [IC_KEY]: null } } }))
})

test('updateStorageClass(isDefault:true): sweep 其余 SC 默认(双 beta 键 null)', async () => {
  fetchStorageClassesImpl = async () => [
    { name: 'sc-old', default: true },
    { name: 'sc-new' },
  ]
  fetchStorageClassImpl = async () => ({ name: 'sc-new', default: false, labels: {}, annotations: {} })
  k8s.mockClear()
  const r = await store.updateStorageClass('sc-new', { isDefault: true })
  expect(r.ok ?? true).toBeTruthy() // updateStorageClass 无显式 return(现状 undefined),不因返回形状失败
  const patches = k8s.mock.calls.filter(c => c[1]?.method === 'PATCH')
  const sweepPatch = patches.find(c => String(c[0]).endsWith('/sc-old'))
  expect(sweepPatch).toBeTruthy()
  const body = JSON.parse(sweepPatch[1].body)
  expect(body.metadata.annotations['storageclass.kubernetes.io/is-default-class']).toBeNull()
  expect(body.metadata.annotations['storageclass.beta.kubernetes.io/is-default-class']).toBeNull()
})
```

其中 `fetchIngressClassesImpl`/`fetchStorageClassesImpl`/`fetchStorageClassImpl` 是对 `@/composables/useFetchers` 的可变桩(测试顶部 `vi.mock('@/composables/useFetchers', ...)` 把每个导出指到 `let` 变量,默认 `async () => []` / 单数 `async () => null`;`let` 声明必须在 vi.mock 工厂可捕获的模块顶层——用 `vi.hoisted(() => ({ fetchIngressClassesImpl: ... }))` 或直接让桩函数读 `state` 对象属性)。crud-factory 桩未 mock useFetchers——**若 crud.js 从 useFetchers 直接 import,桩按上句实现;若运行发现 crud 经其它模块间接取,以实际 import 链为准调整 mock 目标,断言语义不变**。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/__tests__/cluster.class-default.test.js`
Expected: FAIL(promoteIngressClassDefault is not a function)

- [ ] **Step 3: Implement in crud.js**

3a. import 区(useFetchers 那行)补 `fetchIngressClasses, fetchStorageClasses`(保持既有 import 风格,追加到同一 import 语句)。

3b. `updateStorageClass`(crud.js:257)前插入 sweep,并在文件内新增三个函数(置于 updateStorageClass 之后):

```js
  // === 集群默认不变式(spec §3.3):sweep 先摘旧默认,失败中止防双默认 ===
  const IC_DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'
  const SC_DEFAULT_SWEEP_KEYS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
  const icPath = name => `/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(name)}`
  const scPath = name => `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`
  // 静默定点 PATCH:sweep 批量摘注解用,不带 per-call toast,由调用方聚合提示
  async function patchSilent(path, patch) {
    await api.k8s(path, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch) })
  }

  async function promoteIngressClassDefault(name) {
    const items = await fetchIngressClasses().catch(() => [])
    const others = (items || []).filter(c => c.isDefault && c.name !== name)
    for (const c of others) {
      const patch = buildIngressClassPatch(c, { isDefault: null }) || { metadata: { annotations: { [IC_DEFAULT_KEY]: null } } }
      try { await patchSilent(icPath(c.name), patch) } catch { return { ok: false, error: i18n.global.t('store.defaultSweepFailed', { failed: c.name }) } }
    }
    const r = await remotePatch(icPath(name), { metadata: { annotations: { [IC_DEFAULT_KEY]: 'true' } } }, `IngressClass/${name}`)
    invalidateResource('ingressclasses')
    return r
  }
  async function demoteIngressClassDefault(name) {
    const r = await remotePatch(icPath(name), { metadata: { annotations: { [IC_DEFAULT_KEY]: null } } }, `IngressClass/${name}`)
    invalidateResource('ingressclasses')
    return r
  }
  async function promoteStorageClassDefault(name) {
    const items = await fetchStorageClasses().catch(() => [])
    const others = (items || []).filter(c => c.default && c.name !== name)
    for (const c of others) {
      const ann = Object.fromEntries(SC_DEFAULT_SWEEP_KEYS.map(k => [k, null]))
      try { await patchSilent(scPath(c.name), { metadata: { annotations: ann } }) } catch { return { ok: false, error: i18n.global.t('store.defaultSweepFailed', { failed: c.name }) } }
    }
    const r = await remotePatch(scPath(name), { metadata: { annotations: { [SC_DEFAULT_SWEEP_KEYS[0]]: 'true' } } }, `StorageClass/${name}`)
    invalidateResource('storageclasses')
    return r
  }
```

3c. `updateStorageClass` 函数体首行插入:

```js
    if (updates?.isDefault === true) {
      const items = await fetchStorageClasses().catch(() => [])
      const others = (items || []).filter(c => c.default && c.name !== name)
      for (const c of others) {
        const ann = Object.fromEntries(SC_DEFAULT_SWEEP_KEYS.map(k => [k, null]))
        try { await patchSilent(scPath(c.name), { metadata: { annotations: ann } }) } catch { return { ok: false, error: i18n.global.t('store.defaultSweepFailed', { failed: c.name }) } }
      }
    }
```

注意:常量与辅助函数须声明在 updateStorageClass **之前**(JS const 无提升);`buildIngressClassPatch` 需在 crud.js 顶部 import(from '@/composables/useClassPatch');`i18n`/`notify` crud.js 已有;`api` 已有。

3d. crud.js 末尾 return 对象(363-368 行区)追加 `promoteIngressClassDefault, demoteIngressClassDefault, promoteStorageClassDefault`。

3e. cluster.js:88-95 destructure 追加同名三项;store return 里 `addIngressClass, updateIngressClass, deleteIngressClass, ...`(约 561 行)处追加同名三项。

3f. i18n:`store.defaultSweepFailed` — en `"Failed to unset previous default: {failed} — target unchanged"` / zh `"摘除旧默认失败：{failed}，已中止，未改动目标类"`(en.json/zh.json 的 store 块同步加)。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/__tests__/cluster.class-default.test.js src/stores/__tests__/cluster.crud-factory.test.js`
Expected: PASS(新 4 用例 + 既有工厂用例全绿——updateStorageClass 加 sweep 后,工厂测试若桩了 fetchStorageClasses 需让它返回 `[]`)

- [ ] **Step 5: Commit**

```bash
git add src/stores/cluster/crud.js src/stores/cluster.js src/stores/__tests__/cluster.class-default.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(stores): class-default promote/demote with old-default sweep (abort on sweep failure to prevent double defaults)"
```

---

### Task 4: Ingress 创建「集群默认」选项(NsIngress + DeployApp)

**Files:**
- Modify: `src/views/NsIngress.vue`(select 约 285-289 行区)
- Modify: `src/views/DeployApp.vue`(select 约 1592-1600 行区)
- Modify: `src/locales/en.json` + `src/locales/zh.json`(common 块)
- Test: `src/views/__tests__/NsIngress.cluster-default.test.js`、`src/views/__tests__/DeployApp.cluster-default.test.js`

**Interfaces:**
- Consumes: Task 1 `canUseClusterDefault/resolveClusterDefaultName`;既有 store.fetchIngressClasses 与 `allIngressClasses` computed(两视图已存在)。
- Produces: option `data-testid="ingress-cluster-default-option"`(value=默认类名,disabled 当无默认);hint 元素 `data-testid="ingress-cluster-default-hint"`(仅无默认时渲染)。Task 8 回归断言用。

- [ ] **Step 1: i18n 键(en+zh common 块同步加)**

en:
```json
"clusterDefaultOption": "Cluster default (follows {name})",
"clusterDefaultUnset": "Cluster default (not set)",
"noDefaultIngressClassHint": "No default IngressClass in this cluster — the first available class is preselected. Set one on the IngressClass page.",
"noDefaultStorageClassHint": "No default StorageClass in this cluster — select one explicitly.",
"setAsDefault": "Set as default",
"unsetDefault": "Unset default"
```
zh:
```json
"clusterDefaultOption": "集群默认（跟随 {name}）",
"clusterDefaultUnset": "集群默认（未设置）",
"noDefaultIngressClassHint": "集群当前无默认 IngressClass，已预选第一个可用类；可在 IngressClass 页设为默认",
"noDefaultStorageClassHint": "集群当前无默认 StorageClass，请显式选择",
"setAsDefault": "设为默认",
"unsetDefault": "取消默认"
```

- [ ] **Step 2: Write the failing tests**(两文件同构,挂载桩抄 `NsIngress.class-pick.test.js` 的 harness——先读该文件,store 桩里 `fetchIngressClasses` 返回可控列表):

NsIngress 版核心断言(视角:集群视角可用,与 namespace 无关):

```js
// 有默认:option 可选且 value=默认类名
// store.fetchIngressClasses → [{ name: 'a' }, { name: 'nginx', isDefault: true }]
const opt = w.find('[data-testid="ingress-cluster-default-option"]')
expect(opt.exists()).toBe(true)
expect(opt.attributes('disabled')).toBeUndefined()
expect(opt.element.value).toBe('nginx')
expect(opt.text()).toContain('nginx') // 跟随名可见
// 无默认:option disabled + hint 渲染
// store.fetchIngressClasses → [{ name: 'a' }]
expect(opt.attributes('disabled')).toBeDefined()
expect(w.find('[data-testid="ingress-cluster-default-hint"]').exists()).toBe(true)
// 选中「集群默认」后提交:handleCreate 收到 className='nginx'(有默认态)
// 断言走既存 class-pick 测试同款提交桩(addIngress spy)
```

DeployApp 版同构(testid 相同,挂载桩抄 `DeployApp.class-pick.test.js`)。

- [ ] **Step 3: Run to verify FAIL**,然后改 NsIngress.vue select(285 行区;script 区 import `{ canUseClusterDefault, resolveClusterDefaultName } from '@/logic/classDefault'`):

```html
<select v-model="createForm.className" data-testid="ingress-class-select" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
  <option v-if="!allIngressClasses.length" value="">{{ t('ns.ingress.classNoneAvailable') }}</option>
  <!-- 集群默认(2026-09-04 复活,守卫:有默认才可选;落库=显式默认类名,spec §3.4) -->
  <option v-if="allIngressClasses.length" data-testid="ingress-cluster-default-option"
    :value="resolveClusterDefaultName(allIngressClasses)"
    :disabled="!canUseClusterDefault(allIngressClasses)">
    {{ canUseClusterDefault(allIngressClasses) ? t('common.clusterDefaultOption', { name: resolveClusterDefaultName(allIngressClasses) }) : t('common.clusterDefaultUnset') }}
  </option>
  <option v-for="c in allIngressClasses" :key="c.name" :value="c.name">{{ c.name }}{{ c.isDefault ? t('ns.ingress.defaultClass') : '' }}</option>
</select>
<p v-if="allIngressClasses.length && !canUseClusterDefault(allIngressClasses)" data-testid="ingress-cluster-default-hint" class="text-label-caps text-on-surface-variant mt-xs">{{ t('common.noDefaultIngressClassHint') }}</p>
```

DeployApp.vue 同款(`$t` 风格,hint 放 select 的 div 内末尾)。**不要动**两处 prefill watch(resetCreate/pickIngressClassName 逻辑)。

- [ ] **Step 4: Run to verify PASS**;并跑既有 `npx vitest run src/views/__tests__/NsIngress.class-pick.test.js src/views/__tests__/DeployApp.class-pick.test.js src/views/__tests__/NsIngress.create-validation.test.js`——若有断言 select option 数量/首项的用例,按新选项迁移(预填语义未变,预期只需微调)。

Run: 同上 Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/NsIngress.vue src/views/DeployApp.vue src/views/__tests__/NsIngress.cluster-default.test.js src/views/__tests__/DeployApp.cluster-default.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(views): restore cluster-default option in Ingress creation (selectable only when a default class exists, explicit name on submit)"
```

---

### Task 5: IngressClassDetail 默认钮 + 关联 Ingress 面板

**Files:**
- Modify: `src/views/IngressClassDetail.vue`
- Modify: `src/locales/en.json` + `src/locales/zh.json`(admin.ingressClasses 块)
- Test: `src/views/__tests__/IngressClassDetail.test.js`(扩展)

**Interfaces:**
- Consumes: Task 3 `store.promoteIngressClassDefault/demoteIngressClassDefault`;既有 `useResourceList`(需新增 import)+ `store.fetchIngresses`(集群级列表,Network.vue 同款 key);mapIngress 字段:name/namespace/className/hosts/rules(defaultBackend/tls)。
- Produces: 按钮 `data-testid="promote-default-btn"` / `demote-default-btn`;关联卡 `data-testid="related-ingresses"`;行跳转 NsIngressDetail。

- [ ] **Step 1: Write the failing tests**(扩展既有 IngressClassDetail.test.js——harness 不变,store 桩补 `fetchIngresses`/`promoteIngressClassDefault`/`demoteIngressClassDefault` spies + `useResourceList` 也被 import 须一并 mock 或给真桩;在该测试文件 vi.mock('@/composables/useK8sQuery') 里补 `useResourceList: () => ({ data: ref(RELATED) })`):

```js
// FIXTURE 补充
const RELATED = [
  { name: 'app1', namespace: 'web', className: 'nginx', hosts: 'a.com,b.com', tls: true, tlsSecret: 's', rules: [{ http: { paths: [{ backend: { service: { name: 'svc1', port: { number: 8080 } } } }] } }], defaultBackend: null, age: '1d' },
]
// 新用例:
it('header:非默认显示「设为默认」,点击调 promoteIngressClassDefault', async () => {
  h.promoteIngressClassDefault.mockResolvedValue({ ok: true })
  h.captured.data = ref({ ...FIXTURE, isDefault: false })
  const w = mountView()
  await w.vm.$nextTick()
  await w.find('[data-testid="promote-default-btn"]').trigger('click')
  expect(h.promoteIngressClassDefault).toHaveBeenCalledWith('nginx')
})
it('header:已是默认显示「取消默认」,点击调 demote', async () => {
  h.demoteIngressClassDefault.mockResolvedValue({ ok: true })
  h.captured.data = ref({ ...FIXTURE, isDefault: true })
  const w = mountView()
  await w.vm.$nextTick()
  expect(w.find('[data-testid="demote-default-btn"]').exists()).toBe(true)
  await w.find('[data-testid="demote-default-btn"]').trigger('click')
  expect(h.demoteIngressClassDefault).toHaveBeenCalledWith('nginx')
})
it('关联 Ingress 面板:计数/hosts/443/svc:port/点击跳转', async () => {
  h.captured.data = ref(FIXTURE)
  const w = mountView()
  await w.vm.$nextTick()
  const card = w.find('[data-testid="related-ingresses"]')
  expect(card.text()).toContain('a.com')
  expect(card.text()).toContain('svc1:8080')
  const row = card.find('button')
  await row.trigger('click')
  expect(h.push).toHaveBeenCalledWith({ name: 'NsIngressDetail', params: { namespace: 'web', name: 'app1' } })
})
it('关联 Ingress 空态', async () => { /* useResourceList 桩返回 [] → 断言空态文案键存在渲染 */ })
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement** — IngressClassDetail.vue:

script 增:
```js
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
const ingressesQ = useResourceList({ key: ['cluster', cid, 'ingresses'], fetcher: () => store.fetchIngresses(), options: { refetchInterval: 30000 } })
const related = computed(() => (ingressesQ.data.value || []).filter(i => i.className === ic.value?.name))
// 后端摘要:defaultBackend 映射形 {serviceName,servicePort};rules 内是原生 K8s 形 service:{name,port:{number|name}}
function backendSummary(ing) {
  if (ing.defaultBackend?.serviceName) return `${ing.defaultBackend.serviceName}:${ing.defaultBackend.servicePort}`
  for (const r of ing.rules || []) {
    const s = r?.http?.paths?.[0]?.backend?.service
    if (s?.name) { const p = s.port?.number ?? s.port?.name ?? ''; return p ? `${s.name}:${p}` : s.name }
  }
  return ''
}
async function toggleDefault() {
  if (ic.value.isDefault) await store.demoteIngressClassDefault(ic.value.name)
  else await store.promoteIngressClassDefault(ic.value.name)
}
```

header 按钮组(删除钮左侧插):
```html
<button data-testid="promote-default-btn" v-if="!ic.isDefault" @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold border border-primary/40 text-primary rounded-lg hover:bg-primary-container/10 transition-colors">
  <span class="material-symbols-outlined text-sm">star</span> {{ t('common.setAsDefault') }}
</button>
<button data-testid="demote-default-btn" v-else @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface-variant rounded-lg hover:bg-surface-container transition-colors">
  <span class="material-symbols-outlined text-sm">star</span> {{ t('common.unsetDefault') }}
</button>
```

Overview 区外壳改双栏(现有属性卡包进 `lg:col-span-8`,新增右栏):
```html
<div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
  <div class="lg:col-span-8"><!-- 现有属性卡原样 --></div>
  <div class="lg:col-span-4" data-testid="related-ingresses">
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
      <h3 class="text-headline-sm mb-md">{{ t('admin.ingressClasses.relatedIngresses') }} ({{ related.length }})</h3>
      <div v-if="related.length" class="flex flex-col gap-sm">
        <button v-for="ing in related" :key="ing.namespace + '/' + ing.name" @click="router.push({ name: 'NsIngressDetail', params: { namespace: ing.namespace, name: ing.name } })"
          class="flex flex-col items-start gap-xs px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors text-left">
          <span class="font-mono text-code-sm text-primary truncate max-w-full">{{ ing.namespace }}/{{ ing.name }}</span>
          <span class="text-body-sm text-on-surface-variant truncate max-w-full">{{ ing.hosts || '—' }}</span>
          <span class="flex items-center gap-xs text-label-caps text-on-surface-variant">
            <span v-if="ing.tls" class="flex items-center gap-xs text-secondary"><span class="material-symbols-outlined text-sm">lock</span>443</span>
            <span v-if="backendSummary(ing)" class="font-mono">{{ backendSummary(ing) }}</span>
          </span>
        </button>
      </div>
      <p v-else class="text-body-sm text-on-surface-variant py-md text-center">{{ t('admin.ingressClasses.relatedEmpty') }}</p>
    </div>
  </div>
</div>
```

i18n admin.ingressClasses 块(en/zh):`relatedIngresses` "Referenced Ingresses"/"关联 Ingress";`relatedEmpty` "No Ingress references this class"/"无 Ingress 引用此类"。

溢出安全:truncate 元素宿主是 `flex-col items-start` 行(列向)→ 已带 `truncate max-w-full`(w-full 配方变体,max-w-full 等价钳制);不引入裸 nowrap。

- [ ] **Step 4: Run to verify PASS**(含该文件全部既有用例)

Run: `npx vitest run src/views/__tests__/IngressClassDetail.test.js` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/IngressClassDetail.vue src/views/__tests__/IngressClassDetail.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(views): IngressClassDetail set/unset default action + related Ingresses panel (hosts/TLS/backend ports)"
```

---

### Task 6: PVC 创建守卫(NsStorage + Storage)

**Files:**
- Modify: `src/views/NsStorage.vue`(select 264-265 行区 + hint)
- Modify: `src/views/Storage.vue`(61 行 fallback + 277-280 select + 创建按钮 disabled)
- Test: `src/views/__tests__/NsStorage.default-guard.test.js`、`src/views/__tests__/Storage.pvc-default-guard.test.js`

**Interfaces:**
- Consumes: Task 1 `canUseClusterDefault(classes, 'default')`(SC mapper 字段是 `default`);两视图既有 `allSCs`/`allStorageClasses` computed 与 addPVC 管道(管道不动)。
- Produces: NsStorage option `data-testid="pvc-cluster-default-option"`(value='',disabled 当无默认)+ hint `data-testid="pvc-cluster-default-hint"`;Storage.vue PVC 创建按钮在「无显式选择且无默认」时 disabled(不新增 testid,断言按钮 disabled 属性与 hint 渲染)。

- [ ] **Step 1: Write the failing tests**(挂载桩抄各自既有测试;store 桩 fetchStorageClasses 控制两态):

```js
// NsStorage:有默认 → option 可选,label 含默认名;无默认 → disabled + hint
// Storage.vue:无默认且未选 → 创建按钮 disabled + hint 渲染;有默认 → 预填默认名,按钮可用
// Storage.vue fallback:有默认时 handleCreate 提交 addPVC 收到 storageClass=默认名(不再出现 'standard')
// 现状回归锚:'standard' 字符串在两文件中不再出现(grep 断言交给门禁,不在单测内)
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement NsStorage.vue**(script 加 import + 模板):

```html
<option data-testid="pvc-cluster-default-option" value="" :disabled="!canUseClusterDefault(allSCs, 'default')">
  {{ canUseClusterDefault(allSCs, 'default') ? t('common.clusterDefaultOption', { name: resolveClusterDefaultName(allSCs, 'default') }) : t('common.clusterDefaultUnset') }}
</option>
<option v-for="sc in allSCs" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
```
```html
<p v-if="!canUseClusterDefault(allSCs, 'default')" data-testid="pvc-cluster-default-hint" class="text-label-caps text-on-surface-variant mt-xs">{{ t('common.noDefaultStorageClassHint') }}</p>
```
(原 `<option value="">{{ t('ns.storage.defaultOption') }}</option>` 被上项替换;grep 确认 `ns.storage.defaultOption` 无其它消费后从 en/zh 删除该键,有则保留。)

- [ ] **Step 4: Implement Storage.vue**:

- 61 行 fallback:`storageClass: f.storageClass || resolveClusterDefaultName(allStorageClasses.value, 'default'),`(去 `|| 'standard'`;空串语义=apiserver 默认化,但创建按钮已守卫,见下)
- PVC 创建按钮 `:disabled` 追加 `|| (!createForm.storageClass && !canUseClusterDefault(allStorageClasses, 'default'))`(找到现有 disabled 表达式追加,保持既有条件);select 下方补 hint(同 NsStorage 配方,`v-if="!canUseClusterDefault(allStorageClasses, 'default')"`);select 首位加集群默认 option(同 NsStorage,value='',label 三态)。
- script import `{ canUseClusterDefault, resolveClusterDefaultName } from '@/logic/classDefault'`。

- [ ] **Step 5: Run to verify PASS** + 既有 NsStorage/Storage 相关测试回归。

Run: `npx vitest run src/views/__tests__/NsStorage.default-guard.test.js src/views/__tests__/Storage.pvc-default-guard.test.js` + `npx vitest run src/views/__tests__ -t storage --silent=false 2>/dev/null | head -5`(或按名定向既有 storage 测试) Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/views/NsStorage.vue src/views/Storage.vue src/views/__tests__/NsStorage.default-guard.test.js src/views/__tests__/Storage.pvc-default-guard.test.js src/locales/en.json src/locales/zh.json
git commit -m "fix(views): guard PVC cluster-default option and drop hardcoded 'standard' fallback (PVC must not silently default to nothing)"
```

---

### Task 7: StorageClassDetail 默认钮

**Files:**
- Modify: `src/views/StorageClassDetail.vue`(header 按钮组 94-99 行区)
- Test: `src/views/__tests__/StorageClassDetail.default.test.js`

**Interfaces:**
- Consumes: Task 3 `store.promoteStorageClassDefault`;既有 `store.updateStorageClass(name, { isDefault: false })`(取消默认走既有 patch,'false' 语义,spec §3.6);`sc.default` 字段。
- Produces: `data-testid="promote-default-btn"` / `demote-default-btn`(与 Task 5 同名约定)。

- [ ] **Step 1: Write the failing test**(挂载桩抄 NsResourceQuotaDetail.cpu.test.js 的 composable-mock 配方:mock `useResourceDetail`(data=ref(SC fixture,字段含 name/default/provisioner/labels/annotations/parameters))、`useLiveYaml`、`useResourceApply`、store(updateStorageClass/promoteStorageClassDefault spies)、vue-router):

```js
it('非默认:显示「设为默认」,点击调 promoteStorageClassDefault(name)', ...)
it('已是默认:显示「取消默认」,点击调 updateStorageClass(name, { isDefault: false })', ...)
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**(header 按钮组,edit 钮左侧插,形态同 Task 5):

```html
<button data-testid="promote-default-btn" v-if="!sc.default" @click="promoteDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold border border-primary/40 text-primary rounded-lg hover:bg-primary-container/10 transition-colors">
  <span class="material-symbols-outlined text-sm">star</span> {{ t('common.setAsDefault') }}
</button>
<button data-testid="demote-default-btn" v-else @click="demoteDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface-variant rounded-lg hover:bg-surface-container transition-colors">
  <span class="material-symbols-outlined text-sm">star</span> {{ t('common.unsetDefault') }}
</button>
```
```js
async function promoteDefault() { await store.promoteStorageClassDefault(route.params.name) }
async function demoteDefault() { await store.updateStorageClass(route.params.name, { isDefault: false }) }
```
(edit modal 内 isDefault 开关保留不动——updateStorageClass 已接 sweep。)

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/views/StorageClassDetail.vue src/views/__tests__/StorageClassDetail.default.test.js
git commit -m "feat(views): StorageClassDetail set/unset default header actions (promote sweeps old default)"
```

---

### Task 8: 全门禁 + 合并

**Files:** 无新改动(验证 + 合并)

- [ ] **Step 1: 全门禁**

Run: `npm test && npm run test:unit && node scripts/typecheck.mjs && npm run i18n:check && npm run build`
Expected: 全绿(unit 250+ 文件零失败;typecheck 全过;i18n 四个 0;build 成功——chunk>500kB 警告为存量忽略)

- [ ] **Step 2: 提交身份核验**

Run: `git config user.email` Expected: `aliangdone@gmail.com`(不符则 `git config user.email aliangdone@gmail.com` 修正后重验)

- [ ] **Step 3: 合并回 main(--no-ff)**

```bash
git -C /home/liang/MyProgram/AiProject/aliangboard status --porcelain   # 先核主 checkout 脏状态(并行会话);脏文件与本 diff 无交集才继续
git -C /home/liang/MyProgram/AiProject/aliangboard merge --no-ff worktree-feat+cluster-default-invariant -m "Merge branch 'worktree-feat+cluster-default-invariant' — cluster-default invariant: classDefault single source, promote/demote with old-default sweep (abort on failure), guarded cluster-default options in Ingress/PVC creation, default actions on class detail pages, related-Ingress panel with ports"
```

- [ ] **Step 4: 合并树复验**(main 被并行推进时合并树≠分支树):主 checkout 上重跑 `node scripts/typecheck.mjs` + `npm run i18n:check` + 定向 vitest(Task 2/3/4/5/6/7 的测试文件)。Expected: 全绿。

- [ ] **Step 5: 收尾**:更新记忆(MEMORY.md 索引 + topic 文件);不推送 origin(等用户发版批次)。
