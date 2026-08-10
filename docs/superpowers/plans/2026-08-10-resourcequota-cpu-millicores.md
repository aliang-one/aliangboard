# ResourceQuota CPU 配额改毫核原生 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ResourceQuota 的 `limits.cpu`(`cpuHard`)编辑/创建/回显/百分比全链路按毫核(1=1000m)处理,往返稳定(20000 → `"20000m"` → 回显 20000)。

**Architecture:** 新增 `milliToCpu`(毫核→K8s quantity)与已有 `cpuToMilli` 配对;编辑/创建表单加载走 `cpuToMilli`、保存走 `milliToCpu`;概览/列表的 cpu 百分比改用 `cpuToMilli` 解析(替代忽略 `m` 后缀的 `parseFloat`/`parseNumeric`)。

**Tech Stack:** Vue 3 (SFC) + Vite + Pinia + vue-query;纯函数测试用自研零依赖运行器 `scripts/test.mjs`(`test()`+`assert`);视图测试用 vitest + @vue/test-utils + happy-dom。

## Global Constraints

- **依赖**:不新增外部依赖。
- **测试**:`scripts/test.mjs`(零依赖,`node scripts/test.mjs`)覆盖纯逻辑;`npm run test:unit`(vitest)覆盖视图。`npm run typecheck`(`node --check` 全 .js/.mjs)+ `npm run build`(覆盖 .vue)+ `npm run i18n:check` 须通过。
- **范围**:仅 ResourceQuota `limits.cpu`(`cpuHard`)。不改 `requests.cpu`、memory、LimitRange、工作负载。
- **提交信息**末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。提交前 `git branch --show-current` 自检(在 `feat/cpu-millicores-edit` 上)。

## File Structure

| 文件 | 职责 | 本计划动作 |
|---|---|---|
| `src/composables/useResourceFormat.js` | K8s quantity 解析/格式化(单一数据源,已有 `cpuToMilli`) | 改:新增 `milliToCpu` |
| `scripts/test.mjs` | 零依赖纯逻辑测试(已测 `cpuToMilli`) | 改:import `milliToCpu` + 加往返测试 |
| `src/views/NsResourceQuotaDetail.vue` | ResourceQuota 详情(编辑 + 概览) | 改:cpuHard 加载/保存毫核化 + 概览 cpu 百分比 + 输入提示 |
| `src/views/NsResourceQuotas.vue` | ResourceQuota 列表 + 创建表单 | 改:创建默认值/保存 + 列表 `parseCpu`→`cpuToMilli` + 显示 |
| `src/views/__tests__/NsResourceQuotaDetail.cpu.test.js` | 详情编辑往返回归 | 新建(vitest) |
| `src/views/__tests__/NsResourceQuotas.cpu.test.js` | 创建表单保存回归 | 新建(vitest) |

---

## Task 1: `milliToCpu` helper + 往返测试(纯函数)

**Files:**
- Modify: `src/composables/useResourceFormat.js`(在 `cpuToMilli` 之后新增 `milliToCpu`)
- Test: `scripts/test.mjs`(line 17 import + 新增 test 块)

**Interfaces:**
- Produces: `milliToCpu(m)` — 入参毫核整数(number/string),返回 K8s quantity 字符串(`${m}m`);空值(`null`/`undefined`/`''`)返回 `''`。后续任务保存时调用。

- [ ] **Step 1: 写失败测试(`scripts/test.mjs`)**

先改 import(line 17),把 `milliToCpu` 加进去:
```js
import { cpuToMilli, milliToCpu, memToKi, formatCpu, formatMem } from '../src/composables/useResourceFormat.js'
```
然后在现有 cpu 测试块(约 line 68)之后追加一个新 test:
```js
test('CPU 毫核→K8s quantity(milliToCpu)+ 往返稳定', () => {
  assert.equal(milliToCpu(20000), '20000m')
  assert.equal(milliToCpu(500), '500m')
  assert.equal(milliToCpu(0), '0m')
  assert.equal(milliToCpu(''), '')
  assert.equal(milliToCpu(null), '')
  assert.equal(milliToCpu(undefined), '')
  // 往返:毫核 → quantity → 毫核
  assert.equal(cpuToMilli(milliToCpu(20000)), 20000)
  assert.equal(cpuToMilli(milliToCpu(500)), 500)
  // K8s 规范化("20" cores 或 "20000m")都能还原为同一毫核值
  assert.equal(cpuToMilli('20'), 20000)
  assert.equal(cpuToMilli('20000m'), 20000)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL —— `milliToCpu is not defined`(尚未导出)。

- [ ] **Step 3: 实现 `milliToCpu`(`src/composables/useResourceFormat.js`)**

在 `cpuToMilli` 函数之后(`memToKi` 之前)新增:
```js
// 毫核整数 → K8s quantity 字符串（保存/下发时用）。空值返回 ''，由调用方决定是否带该字段。
export const milliToCpu = m => (m == null || m === '' ? '' : `${m}m`)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test.mjs`
Expected: `[test] ✓ ... 用例全部通过。`(含新用例)。

- [ ] **Step 5: 提交**

```bash
git branch --show-current   # feat/cpu-millicores-edit
git add src/composables/useResourceFormat.js scripts/test.mjs
git commit -m "$(cat <<'EOF'
feat(format): 新增 milliToCpu(毫核→K8s quantity),与 cpuToMilli 配对

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `NsResourceQuotaDetail` 编辑毫核化 + 概览 cpu 百分比

**Files:**
- Modify: `src/views/NsResourceQuotaDetail.vue`(`openEditModal` line 44-55、`handleEdit` line 57-69、概览 `quotaEntries` line 76-86、输入框 line 219)
- Test: `src/views/__tests__/NsResourceQuotaDetail.cpu.test.js`(新建,vitest)

**Interfaces:**
- Consumes: `milliToCpu`、`cpuToMilli`(来自 Task 1 / `useResourceFormat.js`)。
- Produces: 详情编辑 `limits.cpu` 加载回显毫核整数、保存发 `"${m}m"`;概览 cpu 百分比按毫核算。

- [ ] **Step 1: 写失败测试 `src/views/__tests__/NsResourceQuotaDetail.cpu.test.js`**

```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 回归:limits.cpu 编辑往返——加载按毫核回显("20"→20000)、保存发 "20000m"。
const updateSpy = vi.fn()
vi.mock('@/composables/useK8sQuery', () => ({
  // 绕过 query,直接喂 rq 数据
  useResourceDetail: () => ({ data: ref({ name: 'rq1', namespace: 'anydoor', hard: { 'limits.cpu': '20' }, used: {} }) }),
}))
vi.mock('@/composables/useLiveYaml', () => ({ useLiveYaml: () => ({ yaml: ref('') }) }))
vi.mock('@/composables/useResourceApply', () => ({ useResourceApply: () => ({ applyYaml: vi.fn() }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c', setNamespace: vi.fn(),
    fetchResourceQuota: vi.fn(), getResourceQuotaByName: () => null,
    updateResourceQuota: updateSpy,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor', name: 'rq1' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import NsResourceQuotaDetail from '../NsResourceQuotaDetail.vue'

// Modal 用 Teleport,stub 成内联渲染 default+actions 槽
const ModalStub = { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }

function mountView() {
  return mount(NsResourceQuotaDetail, {
    global: { mocks: { $t: (k) => k }, stubs: { Modal: ModalStub, Breadcrumbs: true, YamlEditor: true, ProgressBar: true } },
  })
}
const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

describe('NsResourceQuotaDetail CPU 毫核往返', () => {
  it('打开编辑:limits.cpu="20" → 输入框回显 20000', async () => {
    const w = mountView()
    await flush()
    // 点 Edit 按钮(打开编辑弹窗 → openEditModal)
    const editBtn = w.findAll('button').find(b => b.text().toLowerCase().includes('edit'))
    await editBtn.trigger('click')
    const cpuInput = w.find('input[placeholder="20000"]')
    expect(cpuInput.exists()).toBe(true)
    expect(cpuInput.element.value).toBe('20000')
  })

  it('保存:输入 20000 → updateResourceQuota 收到 limits.cpu="20000m"', async () => {
    const w = mountView()
    await flush()
    const editBtn = w.findAll('button').find(b => b.text().toLowerCase().includes('edit'))
    await editBtn.trigger('click')
    const cpuInput = w.find('input[placeholder="20000"]')
    await cpuInput.setValue('20000')
    const saveBtn = w.findAll('button').find(b => b.text().toLowerCase().includes('save'))
    await saveBtn.trigger('click')
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const arg = updateSpy.mock.calls.at(-1)[2]
    expect(arg.hard['limits.cpu']).toBe('20000m')
  })
})
```

> 说明:输入框 `placeholder="20000"` 是 Step 3 改输入框时加的(便于定位 + 单位提示)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsResourceQuotaDetail.cpu.test.js`
Expected: FAIL(输入框找不到 `placeholder="20000"` / 回显是 "20" 而非 "20000" / 保存发的是 "20000" 而非 "20000m")。

- [ ] **Step 3: 改 `NsResourceQuotaDetail.vue`**

(a) 顶部 import 加 `cpuToMilli, milliToCpu`(从 `@/composables/useResourceFormat`):
```js
import { cpuToMilli, milliToCpu } from '@/composables/useResourceFormat'
```

(b) `openEditModal`(line 47)cpuHard 改毫核回显:
```js
    cpuHard: String(cpuToMilli(rq.value.hard?.['limits.cpu']) || ''),
```

(c) `handleEdit`(line 61)cpuHard 改毫核下发:
```js
  if (f.cpuHard) hard['limits.cpu'] = milliToCpu(Number(f.cpuHard))
```

(d) 概览百分比:在 `quotaEntries` 里按 key 选解析器(cpu 走 `cpuToMilli`)。在 `<script setup>` 内、`quotaEntries` 之前加一个 helper:
```js
  // 按 quota key 选量值解析器:cpu→毫核(修 K8s 规范化后 cores/millicores 单位错配);其余沿用 parseNumeric
  const parseQty = (key, val) => key.endsWith('.cpu') ? cpuToMilli(val) : parseNumeric(val)
```
然后改 `quotaEntries`(约 line 81-85)的 percent 计算:
```js
  return Object.entries(hard).map(([key, hardVal]) => {
    const h = parseQty(key, hardVal)
    const u = parseQty(key, used[key] || '0')
    const percent = h ? Math.min(Math.round((u / h) * 100), 100) : 0
    return { key, hard: hardVal, used: used[key] || '0', percent }
  })
```

(e) 输入框(line 219)加 `placeholder="20000"` + 单位提示(在 label 处加 "(millicores, 1=1000m)"):
```html
            <input v-model="editForm.cpuHard" placeholder="20000" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
```
并在该 CPU 字段的 `<label>` 文本后追加 `<span class="text-on-surface-variant text-xs ml-xs">(millicores, 1=1000m)</span>`(找到 cpuHard 对应的 label 行,按周围 label 样式追加)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/NsResourceQuotaDetail.cpu.test.js`
Expected: 2 用例 PASS。

- [ ] **Step 5: 门禁**

Run: `npm run typecheck && npm run build && npm run i18n:check`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git branch --show-current
git add src/views/NsResourceQuotaDetail.vue src/views/__tests__/NsResourceQuotaDetail.cpu.test.js
git commit -m "$(cat <<'EOF'
feat(rq-detail): limits.cpu 编辑毫核化(回显 cpuToMilli/保存 milliToCpu)+ 概览 cpu 百分比按毫核

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `NsResourceQuotas` 创建表单 + 列表毫核化

**Files:**
- Modify: `src/views/NsResourceQuotas.vue`(创建默认值 line 40/47、保存 line 56、`parseCpu` line 90、列表显示 line 145-150)
- Test: `src/views/__tests__/NsResourceQuotas.cpu.test.js`(新建,vitest)

**Interfaces:**
- Consumes: `milliToCpu`、`cpuToMilli`、`formatCpu`(来自 `useResourceFormat.js`)。
- Produces: 创建表单 cpuHard 默认 `'8000'`、保存发 `"8000m"`;列表 cpu hard/used 按毫核显示与算百分比。

- [ ] **Step 1: 写失败测试 `src/views/__tests__/NsResourceQuotas.cpu.test.js`**

```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 回归:创建表单 cpuHard 默认 8000、保存发 "8000m"(毫核)。
const addSpy = vi.fn(async () => {})
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: ref([{ name: 'rq1', namespace: 'anydoor', hard: { 'limits.cpu': '20' }, used: { 'limits.cpu': '5000m' } }]) }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c', setNamespace: vi.fn(), fetchResourceQuotas: vi.fn(),
    addResourceQuota: addSpy,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'anydoor' } }), useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

import NsResourceQuotas from '../NsResourceQuotas.vue'

function mountView() {
  return mount(NsResourceQuotas, {
    global: {
      mocks: { $t: (k) => k },
      stubs: { Breadcrumbs: true, Modal: { name: 'Modal', template: '<div><slot/><slot name="actions"/></div>' }, Pagination: true, ProgressBar: true },
    },
  })
}
const flush = (ms = 80) => new Promise(r => setTimeout(r, ms))

describe('NsResourceQuotas CPU 毫核', () => {
  it('创建表单:填 name+cpuHard=8000 → 保存 addResourceQuota 收到 limits.cpu="8000m"', async () => {
    const w = mountView()
    await flush()
    // 打开创建弹窗
    const openBtn = w.findAll('button').find(b => b.text().toLowerCase().includes('create') || b.text().includes('add'))
    await openBtn.trigger('click')
    await w.find('input[placeholder="rq-name"]').setValue('my-rq')          // name 输入框(见 Step 3 加 placeholder)
    await w.find('input[placeholder="8000"]').setValue('8000')              // cpuHard 输入框
    const saveBtn = w.findAll('button').find(b => b.text().toLowerCase().includes('create') && b.classes().some(c => c.includes('primary')))
    await saveBtn.trigger('click')
    expect(addSpy).toHaveBeenCalledTimes(1)
    const arg = addSpy.mock.calls.at(-1)[0]
    expect(arg.hard['limits.cpu']).toBe('8000m')
  })

  it('列表 cpu 百分比:hard="20"(=20000m)、used="5000m" → 25%', async () => {
    const w = mountView()
    await flush()
    const bars = w.findAllComponents({ name: 'ProgressBar' }).map(c => c.props('value'))
    // hard limits.cpu=20 → cpuToMilli=20000;used=5000m → 5000 → 25%
    expect(bars.some(v => v === 25)).toBe(true)
  })
})
```

> 说明:`input[placeholder="rq-name"]` 与 `input[placeholder="8000"]` 是 Step 3 给创建表单输入框加的 placeholder(便于定位 + 提示)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsResourceQuotas.cpu.test.js`
Expected: FAIL(找不到 placeholder / 保存发的是 "8000" 而非 "8000m" / 百分比不是 25)。

- [ ] **Step 3: 改 `NsResourceQuotas.vue`**

(a) import 加 `cpuToMilli, milliToCpu, formatCpu`:
```js
import { cpuToMilli, milliToCpu, formatCpu } from '@/composables/useResourceFormat'
```

(b) 创建表单默认值 cpuHard `'8'` → `'8000'`(line 40 与 line 47 的 resetCreate 两处):
```js
  cpuHard: '8000',
```

(c) 保存(line 56)`'limits.cpu': f.cpuHard` → 走 milliToCpu:
```js
      'limits.cpu': milliToCpu(Number(f.cpuHard)),
```

(d) `parseCpu`(line 90)由 `parseFloat` 改为 `cpuToMilli`(正确处理 `m`/cores):
```js
function parseCpu(val) {
  return cpuToMilli(val)
}
```

(e) 创建表单输入框(line 198)加 `placeholder="8000"`,name 输入框加 `placeholder="rq-name"`:
```html
            <input v-model="createForm.cpuHard" placeholder="8000" class="..." />
```
(name 输入框同理加 `placeholder="rq-name"`。)

(f) 列表 cpu 显示(line 145)由裸值改为毫核格式化。把:
```html
            <span class="text-on-surface-variant">{{ row.used?.['limits.cpu'] || '0' }} / {{ row.hard?.['limits.cpu'] || '-' }}</span>
```
改为:
```html
            <span class="text-on-surface-variant">{{ formatCpu(cpuToMilli(row.used?.['limits.cpu'])) }} / {{ formatCpu(cpuToMilli(row.hard?.['limits.cpu'])) }}</span>
```
(`formatCpu(null)` 返回 `'—'`,空值安全。)

> 列表百分比(line 146/150)已用 `parseCpu`,Step (d) 把 parseCpu 改成 cpuToMilli 后即按毫核算,无需再改模板。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/NsResourceQuotas.cpu.test.js`
Expected: 2 用例 PASS。

- [ ] **Step 5: 全量门禁**

Run: `npm run typecheck && npm run build && npm run i18n:check && npm run test:unit`
Expected: 全部通过(新测试 + 既有用例)。

- [ ] **Step 6: 提交**

```bash
git branch --show-current
git add src/views/NsResourceQuotas.vue src/views/__tests__/NsResourceQuotas.cpu.test.js
git commit -m "$(cat <<'EOF'
feat(rq-list): 创建表单 cpuHard 默认 8000/保存 milliToCpu + 列表 parseCpu 改 cpuToMilli、按毫核显示

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 验收手测清单(实现完成后)

1. 创建 ResourceQuota:cpuHard 输入 `8000` → 保存 → 列表/详情应显示 `8000m`,百分比合理。
2. 编辑现有 ResourceQuota(`limits.cpu` 为 `20` cores 或 `20000m`):打开编辑 → 输入框回显 `20000`;改成 `20000` 保存 → 重新打开仍回显 `20000`(不再变 20)。
3. 概览/列表百分比:`limits.cpu` 的 used/hard 单位一致后,百分比不再因 cores/millicores 错配而错乱。
