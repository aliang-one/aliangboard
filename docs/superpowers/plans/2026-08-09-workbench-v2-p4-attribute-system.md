# 工作台 V2 P4 — 属性系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 建 catalog(6 kind 属性定义)+ getPath 纯函数 + ResourceCard 通用渲染器。

**Architecture:** `resourceCatalog.js`(数据)+ `getPath()`(纯函数提取)+ `ResourceCard.vue`(渲染)。

**Tech Stack:** Vue 3 + Tailwind。零新依赖。

## Global Constraints
- 零新依赖;`npm run build` + `npm run i18n:check`。
- `getPath` 纯函数可单测(`node --test`)。
- commit: `feat(workbench): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: resourceCatalog.js + getPath + 测试

**Files:** Create `src/data/resourceCatalog.js`; Create `src/data/__tests__/resourceCatalog.test.mjs`

- [ ] **Step 1:** 创建 `src/data/resourceCatalog.js`:
  - `export const RESOURCE_CATALOG = { Pod: {...}, Deployment: {...}, Service: {...}, Namespace: {...}, Ingress: {...}, ConfigMap: {...} }`（按 spec 的 catalog 定义，6 kind）。
  - `export const FALLBACK_SPEC = { icon: 'extension', attributes: [...] }`。
  - `export function getPath(obj, attr)`:
    - 按 `attr.path` dot notation 取值（split('.') 逐层取）。
    - 若结果是 array + `attr.extract`：取每个元素的 `extract` 字段；`extract: 'key'` → Object.keys()。
    - `attr.reduce === 'sum'`：数字数组求和。
    - 返回 scalar 或 array。
  - `export function getCardSpec(kind)`: `RESOURCE_CATALOG[kind] || FALLBACK_SPEC`。

- [ ] **Step 2:** 创建 `src/data/__tests__/resourceCatalog.test.mjs`:
  - getPath scalar: `{path:'metadata.name'}` → 'nginx'
  - getPath array extract: `{path:'spec.containers', extract:'image'}` → ['nginx:1.21']
  - getPath sum: `{path:'status.containerStatuses', extract:'restartCount', reduce:'sum'}` → 3
  - getPath object keys: `{path:'data', extract:'key'}` → ['config.yaml', 'env']
  - getPath missing → undefined
  - getCardSpec('Pod') → RESOURCE_CATALOG.Pod; getCardSpec('Unknown') → FALLBACK_SPEC

- [ ] **Step 3:** `node --test src/data/__tests__/resourceCatalog.test.mjs`

- [ ] **Step 4:** commit `feat(workbench): resourceCatalog(6 kind 属性定义)+ getPath 纯函数 + 测试`

### Task 2: ResourceCard.vue

**Files:** Create `src/components/common/ResourceCard.vue`

- [ ] **Step 1:** 创建 `src/components/common/ResourceCard.vue`:
  - props: `{ resource: Object }`
  - script: `import { RESOURCE_CATALOG, FALLBACK_SPEC, getPath, getCardSpec } from '@/data/resourceCatalog'`
  - `const spec = computed(() => getCardSpec(props.resource?.kind))`
  - `const attrs = computed(() => spec.value.attributes.map(a => ({ ...a, value: getPath(props.resource, a) })).filter(a => a.value != null && a.value !== ''))`
  - template: 卡片(border + rounded)→ header(icon + kind badge + name)→ grid(label: value)
  - type 渲染: text/badge/chips/age/code（按 spec 设计）
  - badge 颜色: `attr.badgeMap?.[value]` → ok/warn/err → CSS class
  - age: 相对时间函数

- [ ] **Step 2:** `npm run i18n:check && npm run build`

- [ ] **Step 3:** commit `feat(workbench): ResourceCard 通用渲染器(catalog 驱动,5 种属性类型)`
