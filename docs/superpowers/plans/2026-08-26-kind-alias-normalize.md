# kind 归一化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `normalizeKind` 单一事实源(单数/Kind 名/kubectl 缩写 → 规范复数),接入全部 5 个 kind 分发点 + 工具 schema 词表提示,根治「不支持的 kind: service」。

**Architecture:** 新 `server/kindAlias.mjs` 纯函数;5 消费点(index.mjs×3 函数、api-key-tools×2、wbp 搜索×1——实际接线函数 7 个:listResources/getResource/describeResource/list_resources/get_resource/describe_resource/search)换用;tool-registry 3 个 kind 参数补 description。

**Tech Stack:** Node ESM 服务端 + node --test。

**Spec:** `docs/superpowers/specs/2026-08-26-kind-alias-normalize-design.md`

## Global Constraints

- 开工先 EnterWorktree(分支 `worktree-fix-kind-alias`);commit 前 `git branch --show-current`
- 不新增依赖;**验证以退出码为准,勿用 grep 管道接 && 放行**(本会话教训)
- server 测试跑法:`node --test server/kind-alias.test.mjs`(全量归 `npm run test:server`)
- docs/ 提交 `git add -f`

---

### Task 1: kindAlias 纯函数 + 接线 + schema(TDD)

**Files:**
- Create: `server/kindAlias.mjs` + `server/kind-alias.test.mjs`
- Modify: `server/index.mjs`(import + listResources/getResource/describeResource 三处 kind 行)
- Modify: `server/api-key-tools.mjs`(import + list_resources/get_resource/describe_resource 三处 kind 行)
- Modify: `server/routes/workbench-projects.mjs`(import + 搜索端点 kind 行)
- Modify: `server/tool-registry.mjs`(3 个 wb 工具 kind 参数 description)

**Interfaces:**
- Produces: `normalizeKind(input) → string | null`(规范复数键;15 kind 并集)

- [ ] **Step 1: 写失败测试**

```js
// server/kind-alias.test.mjs
// kind 归一化:LLM 传单数/Kind 名/缩写不再被「不支持的 kind」拒(2026-08-26 wb_get_resource 报障)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKind } from './kindAlias.mjs'

test('规范复数直通', () => {
  for (const k of ['pods', 'services', 'configmaps', 'secrets', 'namespaces', 'deployments', 'statefulsets', 'daemonsets', 'ingresses', 'nodes', 'persistentvolumes', 'persistentvolumeclaims', 'storageclasses', 'networkpolicies', 'serviceaccounts']) {
    assert.equal(normalizeKind(k), k)
  }
})

test('单数名归一(报障场景:service)', () => {
  assert.equal(normalizeKind('service'), 'services')
  assert.equal(normalizeKind('pod'), 'pods')
  assert.equal(normalizeKind('ingress'), 'ingresses')
  assert.equal(normalizeKind('networkpolicy'), 'networkpolicies')
  assert.equal(normalizeKind('persistentvolumeclaim'), 'persistentvolumeclaims')
  assert.equal(normalizeKind('storageclass'), 'storageclasses')
  assert.equal(normalizeKind('serviceaccount'), 'serviceaccounts')
})

test('Kind 大写名与空白容忍', () => {
  assert.equal(normalizeKind('Service'), 'services')
  assert.equal(normalizeKind('Deployment'), 'deployments')
  assert.equal(normalizeKind('  PersistentVolume  '), 'persistentvolumes')
})

test('kubectl 缩写归一', () => {
  assert.equal(normalizeKind('svc'), 'services')
  assert.equal(normalizeKind('po'), 'pods')
  assert.equal(normalizeKind('cm'), 'configmaps')
  assert.equal(normalizeKind('ns'), 'namespaces')
  assert.equal(normalizeKind('deploy'), 'deployments')
  assert.equal(normalizeKind('sts'), 'statefulsets')
  assert.equal(normalizeKind('ds'), 'daemonsets')
  assert.equal(normalizeKind('ing'), 'ingresses')
  assert.equal(normalizeKind('pv'), 'persistentvolumes')
  assert.equal(normalizeKind('pvc'), 'persistentvolumeclaims')
  assert.equal(normalizeKind('sc'), 'storageclasses')
  assert.equal(normalizeKind('netpol'), 'networkpolicies')
  assert.equal(normalizeKind('sa'), 'serviceaccounts')
})

test('未知名/空输入 → null', () => {
  assert.equal(normalizeKind('widget'), null)
  assert.equal(normalizeKind(''), null)
  assert.equal(normalizeKind(null), null)
  assert.equal(normalizeKind(undefined), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/kind-alias.test.mjs`
Expected: FAIL(模块不存在,exit≠0)

- [ ] **Step 3: 实现**

```js
// server/kindAlias.mjs
// kind 归一化单一事实源:LLM 常传 K8s Kind 自然名(Service/Pod)或 kubectl 缩写(svc/po),
// 而各分发表只收小写复数——曾致「不支持的 kind: service」(2026-08-26 wb_get_resource 报障)。
// 全部 kind 分发点(WB list/get、api-key list/get、@-mention 搜索)统一经此归一。
export const CANONICAL_KINDS = [
  'pods', 'services', 'configmaps', 'secrets', 'namespaces',
  'deployments', 'statefulsets', 'daemonsets', 'ingresses',
  'nodes', 'persistentvolumes', 'persistentvolumeclaims', 'storageclasses',
  'networkpolicies', 'serviceaccounts',
]

const ALIAS = {}
for (const k of CANONICAL_KINDS) {
  // 去尾 s / es / ies 的单数近似:pods→pod, services→service, ingresses→ingress,
  // networkpolicies→networkpolic(y 补回), statefulsets→statefulset ...
  let s = k.replace(/ies$/, 'y').replace(/(ses|xes|zes|ches|shes)$/, 's').replace(/s$/, '')
  if (s !== k) ALIAS[s] = k
}
// 去尾 s 的近似会把 storageclasses→storageclasse(ses 规则先命中已正确);兜底显式别名:
Object.assign(ALIAS, {
  storageclass: 'storageclasses',
  // kubectl 风格缩写
  po: 'pods', svc: 'services', cm: 'configmaps', ns: 'namespaces',
  deploy: 'deployments', sts: 'statefulsets', ds: 'daemonsets', ing: 'ingresses',
  no: 'nodes', pv: 'persistentvolumes', pvc: 'persistentvolumeclaims',
  sc: 'storageclasses', netpol: 'networkpolicies', sa: 'serviceaccounts',
})

// 任意输入(复数/单数/Kind 大写/缩写)→ 规范复数键;无法识别 → null
export function normalizeKind(input) {
  const k = String(input ?? '').trim().toLowerCase()
  if (CANONICAL_KINDS.includes(k)) return k
  return ALIAS[k] || null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/kind-alias.test.mjs`
Expected: PASS 5/5(exit 0)

- [ ] **Step 5: 接线 7 个消费点**

各文件 import 区加 `import { normalizeKind, CANONICAL_KINDS } from './kindAlias.mjs'`(workbench-projects 路径为 `'../kindAlias.mjs'`)。每个分发点把

```
const k = String(kind || 'pods').toLowerCase()      // 或 const kind = String(a.kind || 'pods').toLowerCase()
```

改为:

```
const k = normalizeKind(kind) || 'pods'             // get/list 缺省 pods,与原 default 一致
```

并在「不支持的 kind」错误 detail 后追加清单(具体每处):

- `server/index.mjs` :1119(listResources)、:1154(describeResource)、:1167(getResource):`throw new Error(msg(req, 'api.unsupportedKind', { k: `${k}(支持:${CANONICAL_KINDS.join('/')},单数/缩写自动归一)` }))`(原样保留 msg 键,详情进 k 参数)
- `server/api-key-tools.mjs` :177(list_resources)、:189(get_resource)、:225(describe_resource):detail 同上拼接清单
- `server/routes/workbench-projects.mjs` :169-171(搜索端点):`const kind = normalizeKind(url.searchParams.get('kind')) || 'pods'`(前端已传复数,归一兜底;kindUnsupported 分支保留)

注意:归一后 k 可能与原变量后续用途(namespace 注入 replace 链 :1122 用复数名)一致——替换链以复数为锚,归一输出正是复数,兼容。

- [ ] **Step 6: tool-registry schema 词表**

`server/tool-registry.mjs` 中 `wb_list_resources`/`wb_get_resource`/`wb_describe_resource` 的 `kind: { type: 'string' }` 改为:

```js
kind: { type: 'string', description: '资源类别,复数形式:pods/services/configmaps/secrets/namespaces/deployments/statefulsets/daemonsets/ingresses/nodes/persistentvolumes/persistentvolumeclaims/storageclasses/networkpolicies/serviceaccounts;单数/Kind 名/缩写(svc/po 等)自动归一' }
```

- [ ] **Step 7: 验证(退出码为准)**

Run: `node --test server/kind-alias.test.mjs && node --test server/api-key-tools.test.mjs 2>/dev/null; ls server/*.test.mjs | head -3 && npm run test:server`
Expected: 新测试 5/5 + 全量 server 套件 exit 0(若 api-key-tools 无测试文件名,以 test:server 全量为准)

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add server/kindAlias.mjs server/kind-alias.test.mjs server/index.mjs server/api-key-tools.mjs server/routes/workbench-projects.mjs server/tool-registry.mjs
git commit -m "fix(wb): kind 归一化单一事实源——单数/Kind 名/kubectl 缩写自动映射规范复数,根治「不支持的 kind: service」(7 分发点接线+schema 词表)"
```

---

### Task 2: 门禁+终审+合并推送(控制器执行)

- [ ] Step 1: `npm run test:unit`(退出码)→ `npm test` → `npm run typecheck` → `npm run build`
- [ ] Step 2: 全分支终审(SDD review-package)
- [ ] Step 3: main ff-only 合并+push(main 被推进则查重叠→零重叠 merge→定向 sanity→ff)
- [ ] Step 4: 手测交付:工作台问「看 help-friends 的 babycare-svc 服务」→ kind=service 也取到

## Self-Review 记录

- 覆盖:spec 纯函数→Step 1-4;5 消费点(7 函数)→Step 5;schema→Step 6;验证→Task 2 ✓
- 占位:无;类型一致:`normalizeKind(input)→string|null` 全文一致 ✓
- 单数近似正则的边界(ses/xes 规则)在 Step 3 有注释与显式兜底 ✓
