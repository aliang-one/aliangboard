# Init/Sidecar 容器编辑弹窗 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeployApp 向导步骤 2 的每个 init/sidecar 容器卡片加「完整编辑」图标,弹出 modal 大排版编辑现有 8 字段,实时校验+确认拦截,校验与提交路径单源。

**Architecture:** 独立弹窗组件 `ContainerEditorDialog.vue` 复用共享 `Modal.vue` 壳;校验纯函数 `src/logic/containerValidation.js`(弹窗实时 + 提交 validate() 共用);镜像名清洗抽 `src/utils/containerNames.js` 单源(YAML 生成/弹窗预览共用);顺修派生名去重播种漏显式名的既有 bug。

**Tech Stack:** Vue 3 `<script setup>` 纯 JS、vue-i18n、vitest + happy-dom(组件)、node:test 零依赖(纯逻辑)。

**Spec:** `docs/superpowers/specs/2026-08-25-container-editor-dialog-design.md`

## Global Constraints

- 仓库不新增外部依赖(CLAUDE.md 依赖政策)。
- 纯 JS(.js/.vue),无 TypeScript 语法。
- i18n:en.json + zh.json 双语同步,新增键过 `npm run i18n:check`;消息值禁 `@`(须 `{'@'}` 转义)、禁 HTML 标签。
- 纯逻辑测试 = node:test 零依赖,co-located `*.test.mjs`,并注册进 `package.json` 的 `test:server` 脚本;组件测试 = vitest `.test.js`(vitest 只收 `.js`,`.mjs` 归 node:test,见 vitest.config.js 注释)。
- 样式 token:字号用既有阶梯(text-xs/text-body-sm 等,幽灵 class 静默 no-op);图标用 `material-symbols-outlined`。
- 在 worktree 分支 `worktree-feat-container-editor-dialog` 上开发,不动 main;`docs/superpowers/` 下文件提交须 `git add -f`。
- 提交信息风格:`feat(ui): 中文描述`(conventional + 中文,参照 git log)。
- 现有 `data-testid`(`init-command-input` 等)不得改动/移除。

## 关键现状锚点(执行者必读)

- `src/views/DeployApp.vue`(行号基于 origin/main 9ea4dba,可能有 ±2 漂移,以内容定位):
  - L203-206 `addExtraContainer/addInitContainer/removeXxx`
  - L416-427 `previewYAML` computed 内 `usedContainerNames` + `derivedContainerName`(本次重构+修 bug)
  - L679-707 `validate()`;L694-695 init/sidecar missing-image 两条(本次被单源校验替代)
  - L1092-1121 init 卡片区、L1123-1152 sidecar 卡片区(本次只在每张卡片头部插一行)
- 容器对象形状(8 字段全字符串):`{ name, image, command, args, cpuRequest, cpuLimit, memoryRequest, memoryLimit }`,默认值见 L205:`{ name:'', image:'', command:'', args:'', cpuRequest:'100m', cpuLimit:'250m', memoryRequest:'128Mi', memoryLimit:'256Mi' }`。
- `src/composables/useResourceQuantity.js`:`parseQuantity(str, kind)` → `{num, unit}`;cpu 单位 `''`(cores)/`'m'`,memory `Ki/Mi/Gi/Ti`;解析失败 `num:''`。
- `src/components/common/Modal.vue`:props `modelValue/title/width`,emits `update:modelValue/confirm/cancel`;`$slots.actions` 存在时用调用方按钮替换默认底栏;ESC/遮罩 = close(发 `update:modelValue:false` + `cancel`)。
- `src/components/common/ResourceInput.vue`:props `modelValue/kind/placeholder`,数字框+单位下拉,`@input` 即 emit 规范串。
- DeployApp 现有 vitest 骨架(mock `@/api/client`/`@/stores/cluster`/`vue-router`,见 `src/views/__tests__/DeployApp.container-names.test.js`);`w.vm.form`/`w.vm.previewYAML`/`w.vm.validate` 可直接访问。
- en.json/zh.json deploy 段锚点:`"addSidecarContainer"` 键(zh L1395 / en L1395 附近)后插入新键;`deploy.imageUrl`("Image URL *"/"镜像地址 *")复用为镜像 label;`deploy.containerName`/`deploy.command`/`deploy.args`/`deploy.argsHint` 已存在。

---

### Task 1: 镜像名清洗纯函数 `containerNames.js`

**Files:**
- Create: `src/utils/containerNames.js`
- Create: `src/utils/containerNames.test.mjs`
- Modify: `package.json`(test:server 脚本追加一行注册)

**Interfaces:**
- Consumes: 无(纯函数)
- Produces: `sanitizeImageToName(image) -> string`(DNS-1123 清洗后的基名,可能为空串;fallback 与去重后缀由调用方决定)。Task 2/5 依赖此签名。

- [ ] **Step 1: 写失败测试**

`src/utils/containerNames.test.mjs`:

```js
// sanitizeImageToName:镜像串 → DNS-1123 容器名基名(纯变换,无 fallback/去重)。
// 从 DeployApp derivedContainerName 抽出单源:YAML 生成与「完整编辑」弹窗自动命名预览共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeImageToName } from './containerNames.js'

test('sanitizeImageToName: registry 前缀/tag/大写/下划线/点 → DNS-1123', () => {
  assert.equal(sanitizeImageToName('ghcr.io/Org/My_App:v1.2'), 'my-app')
  assert.equal(sanitizeImageToName('nginx'), 'nginx')
  assert.equal(sanitizeImageToName('docker.io/library/app:1'), 'app')
})

test('sanitizeImageToName: 空串/null/全非法 → 空串(fallback 由调用方)', () => {
  assert.equal(sanitizeImageToName(''), '')
  assert.equal(sanitizeImageToName(null), '')
  assert.equal(sanitizeImageToName('???'), '')
})

test('sanitizeImageToName: 首尾连字符修剪 + 63 截断 + 尾连字符再修剪', () => {
  assert.equal(sanitizeImageToName('-nginx-'), 'nginx')
  assert.equal(sanitizeImageToName('a'.repeat(80)).length, 63)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/containerNames.test.mjs`
Expected: FAIL(`Cannot find module .../containerNames.js`)

- [ ] **Step 3: 最小实现**

`src/utils/containerNames.js`(变换链与 DeployApp 原 L419-423 逐字符一致,保证行为等价):

```js
// 镜像串 → DNS-1123 容器名基名(纯字符串变换)。单一事实源:
// DeployApp YAML 生成 derivedContainerName 与 ContainerEditorDialog「自动命名预览」共用。
// K8s 容器名 ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$——registry 前缀/大写/下划线/点会被拒,
// 故取最后一段路径去掉 :tag,小写化,非法字符折叠成 '-',去首尾与重复 '-',截 63。
// 返回值可能为空串(image 为空/全非法)——fallback 与撞名去重(-2/-3)由调用方决定。
export function sanitizeImageToName(image) {
  return String(image || '')
    .split('/').pop().split(':')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/containerNames.test.mjs`
Expected: PASS 3 tests

- [ ] **Step 5: 注册进 test:server**

`package.json` `scripts.test:server` 末尾追加 ` && node --test src/utils/containerNames.test.mjs`。

- [ ] **Step 6: 验证注册**

Run: `npm run test:server`
Expected: 全绿(含新文件 3 tests)

- [ ] **Step 7: 提交**

```bash
git add src/utils/containerNames.js src/utils/containerNames.test.mjs package.json
git commit -m "feat(deploy): 镜像名清洗抽 containerNames 单源(弹窗预览/YAML 生成共用)"
```

---

### Task 2: DeployApp 派生名重构 + 显式名播种修复

**Files:**
- Modify: `src/views/DeployApp.vue`(imports 区 + `previewYAML` 内 L416-427)
- Test: `src/views/__tests__/DeployApp.container-names.test.js`(追加回归例)

**Interfaces:**
- Consumes: Task 1 `sanitizeImageToName(image) -> string`
- Produces: DeployApp YAML 生成行为——派生名去重集合播种 = 主容器有效名 + 全部显式名(后续 Task 5 弹窗预览的「冲突自动去重」注释依赖此语义)。

- [ ] **Step 1: 写失败测试(追加到 DeployApp.container-names.test.js 末尾)**

```js
test('显式名入播种集:显式 nginx + 另一容器镜像 nginx → 派生 nginx-2(原 bug:撞车)', async () => {
  // 原 bug:usedContainerNames 只播种主容器名 → 派生名与显式名撞车 → K8s 拒绝。
  // extraContainers 的派生在 previewYAML 中先于 initContainers 求值。
  const pod = await podWith({
    initContainers: [{ ...C('nginx'), name: 'nginx' }],
    extraContainers: [C('nginx')],
  })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'nginx-2'])
  expect(pod.initContainers[0].name).toBe('nginx')
})
```

注意:`podWith`/`C` 已在该文件顶部定义(C(image) 默认 name:'')。断言核心:sidecar 派生名因显式 nginx 占位而变 `nginx-2`,不再与显式名撞车。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/DeployApp.container-names.test.js`
Expected: 新例 FAIL(实际得到 `['app', 'nginx']`——派生名与显式名撞车);存量 4 例 PASS。

- [ ] **Step 3: 实现**

DeployApp.vue imports 区(L13 `containerTokens` import 旁)加:

```js
import { sanitizeImageToName } from '@/utils/containerNames'
```

`previewYAML` 内(L416-427)整块替换为:

```js
  // init/sidecar 自动派生容器名:image 前缀清洗成 DNS-1123(纯变换单源 utils/containerNames,
  // 弹窗「自动命名预览」共用);与已用名撞车追加 -2/-3 去重。
  // 播种 = 主容器有效名 + 全部显式名(2026-08-25 修复:原只播主容器名,
  // 派生名可能与显式名撞车被 K8s 硬拒)。
  // 用户显式填写的 name 不经此函数(原样透传,不做静默改写)。
  const usedContainerNames = new Set([
    f.containerName || f.name,
    ...f.initContainers.map(c => c.name).filter(Boolean),
    ...f.extraContainers.map(c => c.name).filter(Boolean),
  ])
  function derivedContainerName(image, fallback) {
    const s = sanitizeImageToName(image) || fallback
    let name = s, n = 1
    while (usedContainerNames.has(name)) name = `${s}-${++n}`
    usedContainerNames.add(name)
    return name
  }
```

- [ ] **Step 4: 跑测试确认通过(含存量回归)**

Run: `npx vitest run src/views/__tests__/DeployApp.container-names.test.js`
Expected: 全 PASS(存量 4 例 + 新例)

- [ ] **Step 5: 提交**

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.container-names.test.js
git commit -m "fix(deploy): 派生容器名去重播种补显式名(撞车被 K8s 拒)+清洗抽单源"
```

---

### Task 3: 校验纯函数 `containerValidation.js`

**Files:**
- Create: `src/logic/containerValidation.js`
- Create: `src/logic/containerValidation.test.mjs`
- Modify: `package.json`(test:server 再追加注册)

**Interfaces:**
- Consumes: `parseQuantity(str, kind)`(`../composables/useResourceQuantity.js`,纯函数无依赖,node:test 相对导入可用)
- Produces(Task 5/7 依赖,签名精确):
  - `compareQuantity(a, b, kind) -> -1|0|1|null`(任一侧解析失败/空 → null)
  - `validateContainerFields(c, otherNames = []) -> [{ field: 'image'|'name'|'cpu'|'memory', msgKey, params }]`(空数组=通过;msgKey 均为 `deploy.containerFv.*`)
  - 契约:调用方负责空行跳过(`isEmptyEnvRow`);本函数假定容器「存在」,image 必填无条件检查。

- [ ] **Step 1: 写失败测试**

`src/logic/containerValidation.test.mjs`:

```js
// Deploy 向导 init/sidecar 容器字段校验单源:弹窗实时校验与提交 validate() 共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareQuantity, quantityValue, validateContainerFields } from './containerValidation.js'

const C = () => ({ name: '', image: 'nginx', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

test('compareQuantity: cpu cores/m 归一毫核比较', () => {
  assert.equal(compareQuantity('0.5', '500m', 'cpu'), 0)
  assert.equal(compareQuantity('600m', '0.5', 'cpu'), 1)
  assert.equal(compareQuantity('100m', '0.5', 'cpu'), -1)
})

test('compareQuantity: 内存 Ki/Mi/Gi 归一 Ki 比较', () => {
  assert.equal(compareQuantity('1Gi', '1024Mi', 'memory'), 0)
  assert.equal(compareQuantity('2Gi', '1Gi', 'memory'), 1)
  assert.equal(compareQuantity('512Ki', '1Mi', 'memory'), -1)
})

test('compareQuantity: 空/脏串任一侧 → null(规则跳过)', () => {
  assert.equal(compareQuantity('', '100m', 'cpu'), null)
  assert.equal(compareQuantity('abc', '100m', 'cpu'), null)
})

test('quantityValue: 归一数值', () => {
  assert.equal(quantityValue('0.5', 'cpu'), 500)
  assert.equal(quantityValue('4000m', 'cpu'), 4000)
  assert.equal(quantityValue('1Gi', 'memory'), 1024 * 1024)
})

test('validateContainerFields: 合法容器 → []', () => {
  assert.deepEqual(validateContainerFields({ ...C(), name: 'my-init' }, ['app', 'other']), [])
})

test('validateContainerFields: image 空 → imageRequired', () => {
  const errs = validateContainerFields({ ...C(), image: '' })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].field, 'image')
  assert.equal(errs[0].msgKey, 'deploy.containerFv.imageRequired')
})

test('validateContainerFields: name 非 DNS-1123 → namePattern;与 otherNames 撞 → nameDuplicate(各一条)', () => {
  const bad = validateContainerFields({ ...C(), name: 'Bad_Name' })
  assert.equal(bad[0].field, 'name')
  assert.equal(bad[0].msgKey, 'deploy.containerFv.namePattern')
  const dup = validateContainerFields({ ...C(), name: 'app' }, ['app'])
  assert.equal(dup[0].msgKey, 'deploy.containerFv.nameDuplicate')
  assert.deepEqual(dup[0].params, { name: 'app' })
})

test('validateContainerFields: req > lim → cpuOverLimit / memoryOverLimit(带 req/lim 参数)', () => {
  const errs = validateContainerFields({ ...C(), cpuRequest: '1', cpuLimit: '500m' })
  assert.equal(errs[0].field, 'cpu')
  assert.equal(errs[0].msgKey, 'deploy.containerFv.cpuOverLimit')
  assert.deepEqual(errs[0].params, { req: '1', lim: '500m' })
  const errs2 = validateContainerFields({ ...C(), memoryRequest: '1Gi', memoryLimit: '512Mi' })
  assert.equal(errs2[0].msgKey, 'deploy.containerFv.memoryOverLimit')
})

test('validateContainerFields: lim 为空(未填) → 不比较不报错', () => {
  assert.deepEqual(validateContainerFields({ ...C(), cpuLimit: '', memoryLimit: '' }), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/containerValidation.test.mjs`
Expected: FAIL(module not found)

- [ ] **Step 3: 实现**

`src/logic/containerValidation.js`:

```js
// Deploy 向导 init/sidecar 容器字段校验(纯函数,无 Vue 依赖,node:test 零依赖可测)。
// 单一事实源:ContainerEditorDialog 实时校验与 DeployApp 提交 validate() 共用——
// 两条编辑入口(原地小卡片/弹窗)规则永远一致。
// 契约:调用方负责「空行整体跳过」(isEmptyEnvRow,与 YAML 生成一致);
// 本函数假定容器存在 → image 必填无条件检查。
import { parseQuantity } from '../composables/useResourceQuantity.js'

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const CPU_FACTOR = { '': 1000, m: 1 }                     // cores → 毫核
const MEM_FACTOR = { Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3 } // → Ki

// 规范串 → 归一数值;空/解析失败 → null(不参与比较)
export function quantityValue(str, kind) {
  const { num, unit } = parseQuantity(str, kind)
  if (num === '') return null
  const factor = (kind === 'cpu' ? CPU_FACTOR : MEM_FACTOR)[unit]
  if (factor == null) return null
  return Number(num) * factor
}

// a<b → -1;a>b → 1;相等 → 0;任一侧无效 → null
export function compareQuantity(a, b, kind) {
  const va = quantityValue(a, kind), vb = quantityValue(b, kind)
  if (va == null || vb == null) return null
  return va < vb ? -1 : va > vb ? 1 : 0
}

// 字段校验。c: 8 字符串字段容器对象;otherNames: 除本容器外的名字集合
// (主容器有效名 + 其他容器显式名,自身重复由调用方组集合时按下标排除)。
// 返回 [{ field, msgKey, params }],msgKey 均在 locales deploy.containerFv 下。
export function validateContainerFields(c, otherNames = []) {
  const errs = []
  if (!c.image) errs.push({ field: 'image', msgKey: 'deploy.containerFv.imageRequired', params: {} })
  if (c.name && !DNS1123.test(c.name)) errs.push({ field: 'name', msgKey: 'deploy.containerFv.namePattern', params: {} })
  if (c.name && otherNames.includes(c.name)) errs.push({ field: 'name', msgKey: 'deploy.containerFv.nameDuplicate', params: { name: c.name } })
  if (compareQuantity(c.cpuRequest, c.cpuLimit, 'cpu') === 1) errs.push({ field: 'cpu', msgKey: 'deploy.containerFv.cpuOverLimit', params: { req: c.cpuRequest, lim: c.cpuLimit } })
  if (compareQuantity(c.memoryRequest, c.memoryLimit, 'memory') === 1) errs.push({ field: 'memory', msgKey: 'deploy.containerFv.memoryOverLimit', params: { req: c.memoryRequest, lim: c.memoryLimit } })
  return errs
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/logic/containerValidation.test.mjs`
Expected: PASS 9 tests

- [ ] **Step 5: 注册 + 提交**

`package.json` `test:server` 末尾再追加 ` && node --test src/logic/containerValidation.test.mjs`,跑 `npm run test:server` 全绿后:

```bash
git add src/logic/containerValidation.js src/logic/containerValidation.test.mjs package.json
git commit -m "feat(deploy): init/sidecar 容器字段校验纯函数(单源,弹窗/提交共用)"
```

---

### Task 4: i18n 键(en/zh 双语)

**Files:**
- Modify: `src/locales/en.json`、`src/locales/zh.json`(deploy 段,`"addSidecarContainer"` 键后插入)

**Interfaces:**
- Consumes: 无
- Produces: Task 5/6/7 使用的键(全部 `deploy.*`;嵌套对象 `containerFv`):`editInitContainer` `editSidecarContainer` `editContainerExpand` `containerBadge` `commandHint` `containerSectionBasic` `containerSectionCommand` `containerSectionResources` `cpuRequestLabel` `cpuLimitLabel` `memoryRequestLabel` `memoryLimitLabel` + `containerFv.{imageRequired,namePattern,nameDuplicate,cpuOverLimit,memoryOverLimit,autoNamePreview,autoNameDedupeNote,confirmDisabledHint}`

- [ ] **Step 1: en.json 插入(`"addSidecarContainer": "Add Sidecar Container",` 之后)**

```json
    "editInitContainer": "Edit Init Container",
    "editSidecarContainer": "Edit Sidecar Container",
    "editContainerExpand": "Open full editor",
    "containerBadge": "Container #{n}",
    "commandHint": "Shell token semantics: whitespace splits, quotes keep together",
    "containerSectionBasic": "Basic",
    "containerSectionCommand": "Command",
    "containerSectionResources": "Resources",
    "cpuRequestLabel": "CPU Request",
    "cpuLimitLabel": "CPU Limit",
    "memoryRequestLabel": "Memory Request",
    "memoryLimitLabel": "Memory Limit",
    "containerFv": {
      "imageRequired": "Image is required",
      "namePattern": "Name must be DNS-1123 (lowercase alphanumerics, '-' inside)",
      "nameDuplicate": "Name conflicts with an existing container: {name}",
      "cpuOverLimit": "CPU request ({req}) exceeds limit ({lim})",
      "memoryOverLimit": "Memory request ({req}) exceeds limit ({lim})",
      "autoNamePreview": "Auto-named when left empty: {name}",
      "autoNameDedupeNote": "Conflicts with an existing name; a suffix will be added (e.g. {name}-2)",
      "confirmDisabledHint": "Fix the errors above to confirm"
    },
```

- [ ] **Step 2: zh.json 插入(`"addSidecarContainer": "添加 Sidecar Container",` 之后,键序与 en 完全一致)**

```json
    "editInitContainer": "编辑 Init 容器",
    "editSidecarContainer": "编辑 Sidecar 容器",
    "editContainerExpand": "完整编辑",
    "containerBadge": "容器 #{n}",
    "commandHint": "Shell token 语义：空白切分，引号内不切",
    "containerSectionBasic": "基本信息",
    "containerSectionCommand": "启动命令",
    "containerSectionResources": "资源配置",
    "cpuRequestLabel": "CPU 请求",
    "cpuLimitLabel": "CPU 上限",
    "memoryRequestLabel": "内存请求",
    "memoryLimitLabel": "内存上限",
    "containerFv": {
      "imageRequired": "镜像不能为空",
      "namePattern": "名称须为 DNS-1123（小写字母数字，内部可有 '-'）",
      "nameDuplicate": "名称与已有容器重复：{name}",
      "cpuOverLimit": "CPU 请求（{req}）超过上限（{lim}）",
      "memoryOverLimit": "内存请求（{req}）超过上限（{lim}）",
      "autoNamePreview": "留空将自动命名：{name}",
      "autoNameDedupeNote": "与现有名冲突，生成时将自动追加序号（如 {name}-2）",
      "confirmDisabledHint": "请先修正上方错误再确认"
    },
```

约束自查:消息值无 `@`、无 HTML 标签 ✓(vue-i18n 运行时两坑规避)。

- [ ] **Step 3: 验证**

Run: `npm run i18n:check`
Expected: 通过(无残存中文/键对齐/引用键缺失报错)

- [ ] **Step 4: 提交**

```bash
git add src/locales/en.json src/locales/zh.json
git commit -m "feat(i18n): 容器编辑弹窗新键(en/zh 对齐)"
```

---

### Task 5: `ContainerEditorDialog.vue` 组件 + 单测

**Files:**
- Create: `src/components/common/ContainerEditorDialog.vue`
- Create: `src/components/common/__tests__/ContainerEditorDialog.test.js`

**Interfaces:**
- Consumes: Task 1 `sanitizeImageToName`、Task 3 `validateContainerFields`、Task 4 全部 i18n 键、共享 `Modal.vue`(props `modelValue/title/width`,slots default+actions)、`ResourceInput.vue`、既有键 `deploy.containerName/deploy.imageUrl/deploy.command/deploy.args/deploy.argsHint/component.modal.cancel/component.modal.confirm`
- Produces(Task 6 依赖):
  - Props:`modelValue:Boolean` `container:Object` `kind:'init'|'sidecar'` `index:Number` `otherNames:String[]`
  - Emits:`update:modelValue(Boolean)`、`confirm(payload:Object)`(合法时;payload 为 8 字段完整副本)
  - 行为契约:打开重置 draft=`{...container}`;取消/X/ESC/遮罩只关不回写;确认非法禁用。

- [ ] **Step 1: 写失败测试**

`src/components/common/__tests__/ContainerEditorDialog.test.js`:

```js
// 容器「完整编辑」弹窗:回显/实时校验(blur 后显错)/确认拦截/取消丢弃/自动命名预览。
// Modal Teleport 到 body → 一律 document.body 查询(与 CopyWorkloadDialog 测试同法);
// 事件交互用原生 dispatchEvent(happy-dom 支持,触发 v-model 的 input/blur)。
import { test, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'

const C = () => ({ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

let wrapper
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })

function mountDialog(props = {}) {
  wrapper = mount(ContainerEditorDialog, {
    props: { modelValue: true, container: C(), kind: 'init', index: 0, otherNames: [], ...props },
    global: { plugins: [i18n] },
  })
  return wrapper
}
const $ = tid => document.body.querySelector(`[data-testid="${tid}"]`)
const setInput = (tid, v) => { const el = $(tid); el.value = v; el.dispatchEvent(new Event('input')) }
const blur = tid => $(tid).dispatchEvent(new Event('blur'))

test('打开:回显字段;合法容器确认可点,点击 emit confirm(完整副本)+关闭', async () => {
  mountDialog({ container: { ...C(), name: 'my-init', image: 'busybox' } })
  expect($('ced-name-input').value).toBe('my-init')
  expect($('ced-image-input').value).toBe('busybox')
  expect($('ced-confirm-btn').disabled).toBe(false)
  $('ced-confirm-btn').click()
  expect(wrapper.emitted('confirm')[0][0]).toEqual({ ...C(), name: 'my-init', image: 'busybox' })
  expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
})

test('空镜像:确认禁用;blur 后显错;补填后错误消失且确认可点', async () => {
  mountDialog()
  expect($('ced-confirm-btn').disabled).toBe(true)
  expect($('ced-image-error')).toBeNull()          // blur 前不显错
  blur('ced-image-input')
  expect($('ced-image-error').textContent).toContain(i18n.global.t('deploy.containerFv.imageRequired'))
  setInput('ced-image-input', 'nginx')
  expect($('ced-image-error')).toBeNull()
  expect($('ced-confirm-btn').disabled).toBe(false)
})

test('name 非法/重复:blur 后各显对应错误', async () => {
  mountDialog({ otherNames: ['app'] })
  setInput('ced-name-input', 'Bad_Name')
  blur('ced-name-input')
  expect($('ced-name-error').textContent).toContain(i18n.global.t('deploy.containerFv.namePattern'))
  setInput('ced-name-input', 'app')
  expect($('ced-name-error').textContent).toContain(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'app' }))
})

test('CPU 请求超上限:ResourceInput 改数后显错且确认禁用', async () => {
  mountDialog({ container: { ...C(), image: 'nginx' } })
  const num = $('ced-cpu-request').querySelector('input')   // ResourceInput 内部数字框(默认单位 cores)
  num.value = '1'; num.dispatchEvent(new Event('input'))
  $('ced-cpu-request').dispatchEvent(new Event('focusout')) // 触发 markTouched('cpu')
  expect($('ced-cpu-error').textContent).toContain(i18n.global.t('deploy.containerFv.cpuOverLimit', { req: '1', lim: '250m' }))
  expect($('ced-confirm-btn').disabled).toBe(true)
})

test('取消:emit update:modelValue(false) 且无 confirm', async () => {
  mountDialog({ container: { ...C(), image: 'nginx' } })
  $('ced-cancel-btn').click()
  expect(wrapper.emitted('confirm')).toBeUndefined()
  expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
})

test('自动命名预览:image 清洗基名;与现有名冲突显示去重注释', async () => {
  mountDialog({ container: { ...C(), image: 'ghcr.io/Org/My_App' } })
  expect($('ced-auto-name-preview').textContent).toContain('my-app')
  wrapper.unmount()                                    // 先卸载,避免两个 teleport 残留串查询
  mountDialog({ container: { ...C(), image: 'nginx' }, otherNames: ['nginx'] })
  expect($('ced-auto-name-preview').textContent).toContain(i18n.global.t('deploy.containerFv.autoNameDedupeNote', { name: 'nginx' }))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/ContainerEditorDialog.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现组件**

`src/components/common/ContainerEditorDialog.vue`:

```vue
<script setup>
// Init/Sidecar 容器「完整编辑」弹窗:复用 Modal 壳(z 层/ESC/遮罩)。draft 副本编辑,
// 确认(合法才可点)emit('confirm', {...draft}),父组件 Object.assign 写回原槽位
// (数组身份不变 → 卷挂载 init:idx/sidecar:idx target 稳定);取消/ESC/遮罩丢弃 draft。
// 校验单源 logic/containerValidation。显错规则 = 字段 blur 过才显示
// (确认按钮非法即禁用,故无需「点确认后」分支,避免新容器一打开满屏红)。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import ResourceInput from '@/components/common/ResourceInput.vue'
import { validateContainerFields } from '@/logic/containerValidation'
import { sanitizeImageToName } from '@/utils/containerNames'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  container: { type: Object, required: true },
  kind: { type: String, default: 'init' },          // 'init' | 'sidecar'
  index: { type: Number, default: 0 },
  otherNames: { type: Array, default: () => [] },   // 主容器有效名 + 其他容器显式名(查重)
})
const emit = defineEmits(['update:modelValue', 'confirm'])
const { t } = useI18n()

// 打开即重置 draft(8 字段全字符串,浅拷贝即深拷贝)与 touched
const draft = ref({ ...props.container })
const touched = ref({})
watch(() => props.modelValue, open => {
  if (open) { draft.value = { ...props.container }; touched.value = {} }
})

const errors = computed(() => validateContainerFields(draft.value, props.otherNames))
const errorsByField = computed(() => {
  const m = {}
  for (const e of errors.value) if (!m[e.field]) m[e.field] = e
  return m
})
function showErr(field) { return touched.value[field] ? errorsByField.value[field] : null }
function markTouched(field) { touched.value[field] = true }

const title = computed(() => t(props.kind === 'init' ? 'deploy.editInitContainer' : 'deploy.editSidecarContainer'))

// name 留空 → 自动派生名预览(与 YAML 生成同源清洗;撞名时 YAML 端会自动加 -2 序号)
const autoName = computed(() => {
  const base = sanitizeImageToName(draft.value.image) || `${props.kind}-${props.index + 1}`
  return { base, conflict: props.otherNames.includes(base) }
})

function onConfirm() {
  if (errors.value.length) return
  emit('confirm', { ...draft.value })
  emit('update:modelValue', false)
}
</script>

<template>
  <Modal :model-value="modelValue" :title="title" width="max-w-2xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionBasic') }}</h4>
        <div>
          <label for="ced-name" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.containerName') }}</label>
          <input id="ced-name" data-testid="ced-name-input" v-model="draft.name" @blur="markTouched('name')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('name') ? 'border-error' : 'border-outline-variant'" placeholder="init name" />
          <p v-if="showErr('name')" data-testid="ced-name-error" class="text-xs text-error mt-xs">{{ t(showErr('name').msgKey, showErr('name').params) }}</p>
          <p v-else-if="!draft.name" data-testid="ced-auto-name-preview" class="text-xs text-on-surface-variant mt-xs">
            {{ autoName.conflict ? t('deploy.containerFv.autoNameDedupeNote', { name: autoName.base }) : t('deploy.containerFv.autoNamePreview', { name: autoName.base }) }}
          </p>
        </div>
        <div>
          <label for="ced-image" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.imageUrl') }}</label>
          <input id="ced-image" data-testid="ced-image-input" v-model="draft.image" @blur="markTouched('image')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('image') ? 'border-error' : 'border-outline-variant'" placeholder="image" />
          <p v-if="showErr('image')" data-testid="ced-image-error" class="text-xs text-error mt-xs">{{ t(showErr('image').msgKey, showErr('image').params) }}</p>
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionCommand') }}</h4>
        <div>
          <label for="ced-command" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.command') }}</label>
          <input id="ced-command" data-testid="ced-command-input" v-model="draft.command"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="sh -c" />
          <p class="text-xs text-on-surface-variant mt-xs">{{ t('deploy.commandHint') }}</p>
        </div>
        <div>
          <label for="ced-args" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.args') }}<span class="ml-xs font-normal text-on-surface-variant/70">{{ t('deploy.argsHint') }}</span></label>
          <textarea id="ced-args" data-testid="ced-args-input" v-model="draft.args" rows="6"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono resize-y" />
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionResources') }}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <div data-testid="ced-cpu-request" @focusout="markTouched('cpu')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuRequestLabel') }}</label>
            <ResourceInput v-model="draft.cpuRequest" kind="cpu" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuLimitLabel') }}</label>
            <ResourceInput v-model="draft.cpuLimit" kind="cpu" />
          </div>
          <div data-testid="ced-memory-request" @focusout="markTouched('memory')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryRequestLabel') }}</label>
            <ResourceInput v-model="draft.memoryRequest" kind="memory" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryLimitLabel') }}</label>
            <ResourceInput v-model="draft.memoryLimit" kind="memory" />
          </div>
        </div>
        <p v-if="showErr('cpu')" data-testid="ced-cpu-error" class="text-xs text-error">{{ t(showErr('cpu').msgKey, showErr('cpu').params) }}</p>
        <p v-if="showErr('memory')" data-testid="ced-memory-error" class="text-xs text-error">{{ t(showErr('memory').msgKey, showErr('memory').params) }}</p>
      </section>
    </div>

    <template #actions>
      <span v-if="errors.length" class="mr-auto text-xs text-on-surface-variant self-center">{{ t('deploy.containerFv.confirmDisabledHint') }}</span>
      <button data-testid="ced-cancel-btn" @click="emit('update:modelValue', false)"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.modal.cancel') }}</button>
      <button data-testid="ced-confirm-btn" :disabled="errors.length" @click="onConfirm"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-40">{{ t('component.modal.confirm') }}</button>
    </template>
  </Modal>
</template>
```

实现注意:
- `Modal` 内置默认 confirm 会无条件关闭,故必须用 `#actions` 插槽自管按钮(禁用态)。
- cpu 显错绑在「请求」格的 `@focusout`(事件冒泡覆盖内部 input/select 的 blur);内存同。
- draft 通过 `v-model="draft.xxx"` 直接改(ref 在模板自动解包)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/ContainerEditorDialog.test.js`
Expected: 6 tests PASS

若 `focusout` 不冒泡触发(happy-dom 差异),改用 `@focusout` 换 `@focusin` 计数或对 `ced-cpu-request` 内 `querySelector('input,select')` 直接 dispatch `blur`(两处:测试与组件保持配对),以实际运行为准。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/ContainerEditorDialog.vue src/components/common/__tests__/ContainerEditorDialog.test.js
git commit -m "feat(deploy): ContainerEditorDialog 完整编辑弹窗(实时校验+确认拦截)"
```

---

### Task 6: DeployApp 接线(图标入口 + 弹窗 + 写回)

**Files:**
- Modify: `src/views/DeployApp.vue`(import、状态/处理器、init/sidecar 卡片模板、模板尾接弹窗)
- Create: `src/views/__tests__/DeployApp.container-editor.test.js`

**Interfaces:**
- Consumes: Task 5 组件全契约;Task 4 `deploy.editContainerExpand/containerBadge`
- Produces: `openContainerEditor(kind, index)` 行为——`editing = { kind, index }`;确认 `Object.assign` 写回同索引槽位(身份不变)。

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/DeployApp.container-editor.test.js`(mock 骨架逐行复制自 `DeployApp.container-names.test.js` 的 import + 三个 vi.mock + mountApp;唯一差异:stubs 保留原样,`ContainerEditorDialog` **不 stub**——用 `findComponent` emit 级驱动):

```js
// 「完整编辑」入口接线:图标打开弹窗拿到正确容器/查重集合;确认写回同索引槽位
// (数组身份不变 → 卷挂载 target 稳定);关闭丢弃。emit 级驱动(Modal 已 stub,UI 细节
// 由 ContainerEditorDialog.test.js 覆盖)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

const C = image => ({ name: '', image, command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

test('init 卡片有最大化图标;点击 → 弹窗拿到该容器与查重集合(主名+其他显式名,不含自身)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', initContainers: [{ ...C('busybox'), name: 'i0' }, C('initx')], extraContainers: [{ ...C('nginx'), name: 's0' }] } })
  await flushPromises()
  const btns = w.findAll('[data-testid="init-expand-btn"]')
  expect(btns.length).toBe(2)
  await btns[1].trigger('click')                       // 编辑第二个 init(initx,无显式名)
  const dlg = w.findComponent(ContainerEditorDialog)
  expect(dlg.props('kind')).toBe('init')
  expect(dlg.props('index')).toBe(1)
  expect(dlg.props('container')).toMatchObject({ image: 'initx' })
  expect(dlg.props('otherNames')).toEqual(['app', 'i0', 's0'])   // 主容器有效名 + 其余显式名
})

test('确认 → Object.assign 写回同索引槽位;数组槽位身份不变(卷挂载 target 稳定)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', initContainers: [C('busybox')] } })
  await flushPromises()
  const slot0 = w.vm.form.initContainers[0]
  await w.findAll('[data-testid="init-expand-btn"]')[0].trigger('click')
  const dlg = w.findComponent(ContainerEditorDialog)
  dlg.vm.$emit('confirm', { ...C('busybox'), name: 'my-init', command: 'sh -c "ls"' })
  await flushPromises()
  expect(w.vm.form.initContainers[0].name).toBe('my-init')
  expect(w.vm.form.initContainers[0].command).toBe('sh -c "ls"')
  expect(w.vm.form.initContainers[0]).toBe(slot0)      // 身份未变
  expect(w.findComponent(ContainerEditorDialog).exists()).toBe(false)   // 确认后关闭
})

test('sidecar 图标同样接线;ESC/取消(editing 置空)后不再写回', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', extraContainers: [C('nginx')] } })
  await flushPromises()
  await w.findAll('[data-testid="sidecar-expand-btn"]')[0].trigger('click')
  const dlg = w.findComponent(ContainerEditorDialog)
  expect(dlg.props('kind')).toBe('sidecar')
  dlg.vm.$emit('update:modelValue', false)             // 取消/ESC/遮罩路径
  await flushPromises()
  expect(w.vm.form.extraContainers[0].name).toBe('')   // 未写回
  expect(w.findComponent(ContainerEditorDialog).exists()).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/DeployApp.container-editor.test.js`
Expected: FAIL(找不到 `[data-testid="init-expand-btn"]`)

- [ ] **Step 3: 实现 DeployApp 三处**

(a) imports 区(Task 2 的 containerNames import 旁):

```js
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'
```

(b) L203-206 `addInitContainer` 一组函数后加状态与处理器:

```js
// 「完整编辑」弹窗:editing 指向目标槽位;确认 Object.assign 写回同槽(数组身份不变,
// 卷挂载 init:idx/sidecar:idx target 稳定);取消/ESC/遮罩丢弃 draft。
const editing = ref(null) // { kind: 'init'|'sidecar', index } | null
const editingListKey = computed(() => (editing.value?.kind === 'sidecar' ? 'extraContainers' : 'initContainers'))
const editingContainer = computed(() => (editing.value ? form.value[editingListKey.value][editing.value.index] : {}))
// 查重集合 = 主容器有效名 + 其他容器显式名(按下标排除自身,保留他处同名 → 双方都报)
const editingOtherNames = computed(() => {
  const f = form.value, cur = editing.value
  if (!cur) return []
  const names = []
  const main = f.containerName || f.name
  if (main) names.push(main)
  f.initContainers.forEach((c, i) => { if (c.name && !(cur.kind === 'init' && i === cur.index)) names.push(c.name) })
  f.extraContainers.forEach((c, i) => { if (c.name && !(cur.kind === 'sidecar' && i === cur.index)) names.push(c.name) })
  return names
})
function openContainerEditor(kind, index) { editing.value = { kind, index } }
function closeContainerEditor() { editing.value = null }
function onContainerEdited(payload) {
  if (!editing.value) return
  Object.assign(form.value[editingListKey.value][editing.value.index], payload)
  editing.value = null
}
```

(c) init 卡片:`v-for` 的 `<div ... class="border border-outline-variant rounded-lg p-sm">`(L1100)内,**name/image grid 之前**插:

```html
                <div class="flex items-center justify-between mb-xs">
                  <span class="text-xs text-on-surface-variant font-mono">{{ $t('deploy.containerBadge', { n: idx + 1 }) }}</span>
                  <button type="button" data-testid="init-expand-btn" :title="$t('deploy.editContainerExpand')" :aria-label="$t('deploy.editContainerExpand')"
                    @click="openContainerEditor('init', idx)"
                    class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
                    <span class="material-symbols-outlined text-base">open_in_full</span>
                  </button>
                </div>
```

sidecar 卡片(L1131)同位置插同样一段,仅两处不同:`data-testid="sidecar-expand-btn"`、`@click="openContainerEditor('sidecar', idx)"`。

(d) 模板:初始化/额外容器 grid 结束标签(L1153 `</div>` 之后)插弹窗:

```html
        <ContainerEditorDialog v-if="editing" :model-value="true" :container="editingContainer"
          :kind="editing.kind" :index="editing.index" :other-names="editingOtherNames"
          @update:model-value="closeContainerEditor" @confirm="onContainerEdited" />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/DeployApp.container-editor.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: 存量回归 + 提交**

Run: `npx vitest run src/views/__tests__/ && npm run typecheck`
Expected: 全绿

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.container-editor.test.js
git commit -m "feat(deploy): init/sidecar 卡片接「完整编辑」弹窗(图标入口+写回同槽)"
```

---

### Task 7: 提交 validate() 接入单源校验

**Files:**
- Modify: `src/views/DeployApp.vue`(L694-695 替换;imports 加 validateContainerFields)
- Modify: `src/locales/en.json`、`src/locales/zh.json`(删 `deploy.initContainerMissingImage`/`deploy.sidecarMissingImage` 两键——已被单源消息替代,grep 确认仅 DeployApp 使用)
- Create: `src/views/__tests__/DeployApp.container-validation.test.js`

**Interfaces:**
- Consumes: Task 3 `validateContainerFields(c, otherNames)`;Task 4 `deploy.containerFv.*`、`deploy.initContainers/sidecarContainers`
- Produces: `validate()` 对 init/sidecar 的错误消息形态 `{ step: 1, msg: "<init/sidecar 标签> <名|#序号>: <字段错误>" }`(既有跳步+toast 消费不变)。

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/DeployApp.container-validation.test.js`(mock 骨架与 Task 6 的 import + 三个 vi.mock + mountApp 完全一致,复制之;`w.vm.validate()` 可直接调用):

```js
// 提交校验接入单源 containerValidation:覆盖原地小卡片编辑路径(弹窗路径同函数)。
// 消息形态:「<init/sidecar 标签> <名|#序号>: <字段错误>」,step=1(现有跳步逻辑不变)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

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

const C = () => ({ name: '', image: 'nginx', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

async function validateWith(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx', ...extraForm } })
  await flushPromises()
  return w.vm.validate().filter(e => e.step === 1)
}

const initLabel = () => i18n.global.t('deploy.initContainers')

test('空行容器整体跳过(不报错)', async () => {
  const errs = await validateWith({ initContainers: [{ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' }] })
  expect(errs).toEqual([])
})

test('缺镜像 → 带标签的 imageRequired', async () => {
  const errs = await validateWith({ initContainers: [{ ...C(), image: '' }] })
  expect(errs.some(e => e.msg.includes(initLabel()) && e.msg.includes(i18n.global.t('deploy.containerFv.imageRequired')))).toBe(true)
})

test('name 非 DNS-1123 → namePattern;两个同名显式容器 → 双方各报 nameDuplicate', async () => {
  const errs = await validateWith({
    initContainers: [{ ...C(), name: 'Bad_Name' }],
    extraContainers: [{ ...C(), name: 'dup' }, { ...C('busybox'), name: 'dup' }],
  })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.namePattern')))).toBe(true)
  const dups = errs.filter(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'dup' })))
  expect(dups.length).toBe(2)
})

test('显式名撞主容器有效名 → nameDuplicate', async () => {
  const errs = await validateWith({ extraContainers: [{ ...C(), name: 'app' }] })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'app' })))).toBe(true)
})

test('req > lim → cpu/memory OverLimit;合法容器不报 step-1 容器错', async () => {
  const errs = await validateWith({
    initContainers: [{ ...C(), cpuRequest: '1', cpuLimit: '500m' }],
    extraContainers: [{ ...C('busybox'), memoryRequest: '1Gi', memoryLimit: '512Mi' }],
  })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.cpuOverLimit', { req: '1', lim: '500m' })))).toBe(true)
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.memoryOverLimit', { req: '1Gi', lim: '512Mi' })))).toBe(true)
  const clean = await validateWith({ initContainers: [{ ...C('busybox'), name: 'ok-init' }] })
  expect(clean).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/DeployApp.container-validation.test.js`
Expected: FAIL(空行例通过外,其余找不到新消息;实际 validate() 只报旧 missing-image 文案)

- [ ] **Step 3: 实现**

(a) DeployApp imports 加(Task 3 键名):

```js
import { validateContainerFields } from '@/logic/containerValidation'
```

(b) `validate()` 内 L694-695 两行**整段替换**为:

```js
  // init/sidecar 字段校验与弹窗单源(logic/containerValidation):image 必填/名 DNS-1123/
  // 资源 req≤lim/显式名查重(主容器有效名 + 其他容器显式名,按下标排除自身)。
  // 空行整体跳过(isEmptyEnvRow,与 YAML 生成一致)。替代旧 missing-image 两条。
  const mainName = f.containerName || f.name
  const initNames = f.initContainers.map(c => c.name).filter(Boolean)
  const sideNames = f.extraContainers.map(c => c.name).filter(Boolean)
  const othersFor = (kind, idx) => {
    const names = mainName ? [mainName] : []
    if (kind === 'init') names.push(...initNames.filter((_, i) => i !== idx), ...sideNames)
    else names.push(...initNames, ...sideNames.filter((_, i) => i !== idx))
    return names
  }
  const pushContainerErrs = (list, kind, labelKey) => list.forEach((c, i) => {
    if (isEmptyEnvRow(c, ['name', 'image', 'command', 'args'])) return
    const label = `${t(labelKey)} ${c.name || '#' + (i + 1)}`
    for (const e of validateContainerFields(c, othersFor(kind, i)))
      errs.push({ step: 1, msg: `${label}: ${t(e.msgKey, e.params)}` })
  })
  pushContainerErrs(f.initContainers, 'init', 'deploy.initContainers')
  pushContainerErrs(f.extraContainers, 'sidecar', 'deploy.sidecarContainers')
```

(c) 删除死键:先 `grep -rn "initContainerMissingImage\|sidecarMissingImage" src/` 确认仅 locales 与 DeployApp 旧两行(已删);然后 en.json/zh.json 的 deploy 段各删 `"initContainerMissingImage"` 与 `"sidecarMissingImage"` 两键(NsWorkloadDetail 用的是 `workload.validation.*` 命名空间,不受影响)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/DeployApp.container-validation.test.js`
Expected: 5 tests PASS

- [ ] **Step 5: 全量门禁**

Run: `npm run test:server && npm run test:unit && npm run typecheck && npm run i18n:check`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/views/DeployApp.vue src/views/__tests__/DeployApp.container-validation.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(deploy): 提交校验接入容器字段单源(名格式/req≤lim/查重),删旧 missing-image 键"
```

---

## 收尾(全部 Task 完成后)

- [ ] `npm run test && npm run typecheck && npm run i18n:check` 全绿
- [ ] `npm run build` 过(vue SFC 语法兜底,CLAUDE.md:typecheck 不覆盖 .vue)
- [ ] 手测清单转交用户:① 点图标弹窗打开/回显 ② 实时校验三种规则 ③ 确认写回小卡片 ④ 取消不回写 ⑤ 提交时原地编辑路径报错跳步 ⑥ 卷挂载 target 指向 init:0 的容器改完后挂载关系不变
