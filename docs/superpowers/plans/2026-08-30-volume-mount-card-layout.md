# VolumeMountCard 布局重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 卷挂载卡片三区块错误文案合并为全宽问题区(根除同行输入框错位),defaultMode 从独占行收编进键映射头行。

**Architecture:** 纯呈现层重构,只动 `VolumeMountCard.vue` 模板与其测试。校验器 `volumeMountValidation.js`、组件 props/事件、两个消费方(DeployApp/NsWorkloadDetail)零变化。新增 computed 按区块过滤 `props.issues`,模板按 spec §2.2 挂 testid 问题区。

**Tech Stack:** Vue 3 `<script setup>` + vitest + happy-dom + @vue/test-utils(既有栈,零新增依赖)。

**Spec:** `docs/superpowers/specs/2026-08-30-volume-mount-card-layout-design.md`

## Global Constraints

- 零外部依赖政策(CLAUDE.md):本计划不新增任何 package。
- 校验逻辑零改动:`src/logic/volumeMountValidation.js` 与 `src/logic/__tests__/volumeMountValidation.test.js` 不许碰,须保持绿。
- i18n 零新增键:文案全复用 `ISSUE_KEYS` 既有映射与 `component.volumeMount.*` 既有键。
- `itemsPath:<i>` 行级文案维持行内显示(spec §2.1 裁决:行级定位需要,且 item 行无错位问题)。
- 字段级红/黄框(`issueCls` / `fldErr` / `ariaInvalid`)与头部状态灯(`cardLevel`/`status-dot`)全部保留。
- 提交作者恒 `aliangone`,禁止 `Co-Authored-By: Claude` 尾注; worktree 分支 `worktree-feat-volume-card-layout`(已建,基于 main)。
- happy-dom 测不出真实 rect——对齐性验收靠 spec §5.2 手测矩阵,单测只锚 DOM 结构。

## 产出 testid 清单(跨任务契约)

| testid | 区块 | 收编 field |
|--------|------|-----------|
| `issues-source-row` | 顶行(挂到容器\|来源) | `target` `source` `hostPath` `nfsPath` |
| `issues-items` | 键映射区(含权限/预览) | `items` `defaultMode` |
| `issues-mount-row` | 底行(挂载到\|subPath\|只读) | `mountPath` `subPath` `readOnly` |
| `default-mode` | 键映射头行权限 select(Task 2) | — |

注意:`targetInvalid` **没有** `ISSUE_KEYS` 映射(`issueMsg` 会回退渲染裸 code),测试选 issue 必须用有映射的 code(如 `sourceNotFound`/`mountPathRoot`/`subPathNotInVolume`/`itemsIncomplete`/`defaultModeInvalid`/`readOnlySuggested`)。

---

### Task 1: 三区块合并问题区

**Files:**
- Modify: `src/components/common/VolumeMountCard.vue`(script 区块过滤 computed + 模板三处收编/三处删除)
- Test: `src/components/common/__tests__/VolumeMountCard.test.js`

**Interfaces:**
- Consumes: `props.issues`(`{code,field,level,params?}[]`,不变)、既有 `issueMsg`/`issueTextCls`/`issueCls`。
- Produces: 三个 computed `topBlockIssues`/`itemsBlockIssues`/`mountBlockIssues`(数组,过滤规则见下)与三个问题区 testid(见上表)。Task 2 依赖 `itemsBlockIssues` 已收编 `defaultMode` 文案。

- [ ] **Step 1: 写失败测试**

在 `src/components/common/__tests__/VolumeMountCard.test.js` 末尾追加两个测试:

```js
test('VolumeMountCard: 三区块合并问题区——顶行/底行文案进区块问题区,字段红框保留', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: entry, pvcs: [], namespace: 'default',
      issues: [
        { code: 'sourceNotFound', field: 'source', level: 'error' },
        { code: 'mountPathRoot', field: 'mountPath', level: 'error' },
        { code: 'subPathNotInVolume', field: 'subPath', level: 'warn' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const top = wrapper.find('[data-testid="issues-source-row"]')
  expect(top.exists()).toBe(true)
  expect(top.text()).toContain(i18n.global.t('component.volumeMount.issue.sourceNotFound'))
  const mountRow = wrapper.find('[data-testid="issues-mount-row"]')
  expect(mountRow.text()).toContain(i18n.global.t('component.volumeMount.issue.mountPathRoot'))
  expect(mountRow.text()).toContain(i18n.global.t('component.volumeMount.issue.subPathNotInVolume'))
  // 字段级红框仍在(问题区只管文案,框定位字段)
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput.classes().join(' ')).toContain('!border-error')
  wrapper.unmount()
})

test('VolumeMountCard: 键映射问题区收编 items/defaultMode;itemsPath 行级文案仍在行内;无问题零渲染', () => {
  const cm = makeEntry(); cm.type = 'configMap'; cm.cmName = 'cm'
  cm.items = [{ key: 'k1', path: '' }]
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: cm, pvcs: [], namespace: 'default',
      issues: [
        { code: 'itemsIncomplete', field: 'items', level: 'error' },
        { code: 'itemPathInvalid', field: 'itemsPath:0', level: 'error' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const itemsBlock = wrapper.find('[data-testid="issues-items"]')
  expect(itemsBlock.exists()).toBe(true)
  expect(itemsBlock.text()).toContain(i18n.global.t('component.volumeMount.issue.itemsIncomplete'))
  expect(itemsBlock.text()).not.toContain(i18n.global.t('component.volumeMount.issue.itemPathInvalid'))
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.itemPathInvalid')) // 行内仍在
  wrapper.unmount()

  const clean = mount(VolumeMountCard, {
    props: { modelValue: makeEntry(), pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  expect(clean.find('[data-testid="issues-source-row"]').exists()).toBe(false)
  expect(clean.find('[data-testid="issues-mount-row"]').exists()).toBe(false)
  clean.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 新增 2 个测试 FAIL(`issues-source-row` 等 testid 不存在),既有测试全绿。

- [ ] **Step 3: script 加区块过滤 computed**

`VolumeMountCard.vue` script 中 `rowIssues` 定义之后加:

```js
// 区块问题区(spec §2.2):顶行/键映射/底行各一条全宽问题区,字段级红框仍由 issueCls 负责;
// itemsPath:<i> 行级文案不收编(行定位需要,且 item 行纵向独立块无错位问题)。
const blockIssues = fields => props.issues.filter(i => fields.includes(i.field))
const topBlockIssues = computed(() => blockIssues(['target', 'source', 'hostPath', 'nfsPath']))
const itemsBlockIssues = computed(() => blockIssues(['items', 'defaultMode']))
const mountBlockIssues = computed(() => blockIssues(['mountPath', 'subPath', 'readOnly']))
```

(文件顶部已 import `computed`,勿重复导入。)

- [ ] **Step 4: 模板三处收编**

4a. 顶行:删除来源 cell 内的 `issuesFor('source')...` 整块(现 179-181 行 `<template v-if="issuesFor('source').length || ...">...</template>`),在顶行 grid(`grid grid-cols-2 gap-xs`)闭合标签之后插入:

```html
    <div v-if="topBlockIssues.length" data-testid="issues-source-row" class="flex flex-col">
      <p v-for="(i, ii) in topBlockIssues" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
    </div>
```

4b. 键映射区:删除「键映射」提示下方的 `issuesFor('items')` 块(现 192-194 行)与 defaultMode 行下方的 `issuesFor('defaultMode')` 块(现 220-222 行);`rowIssues(idx)` 行内 `<p>`(现 205 行)**保留不动**。在落点预览块(`data-testid="mount-preview"`)闭合之后、键映射区最后一个 `</div>` 之前插入:

```html
      <div v-if="itemsBlockIssues.length" data-testid="issues-items" class="flex flex-col">
        <p v-for="(i, ii) in itemsBlockIssues" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </div>
```

4c. 底行:删除 mountPath/subPath 输入框下方的两个 `issuesFor('mountPath')`/`issuesFor('subPath')` `<p>` 循环(现 253、258 行)与只读 label 内的 `issuesFor('readOnly')` 行内块(现 262-264 行);在底行 grid(`grid-cols-[1fr_1fr_auto]`)闭合之后插入:

```html
    <div v-if="mountBlockIssues.length" data-testid="issues-mount-row" class="flex flex-col">
      <p v-for="(i, ii) in mountBlockIssues" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
    </div>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 全部 PASS(既有测试用 `wrapper.text()`/placeholder 定位,不受文案搬家影响)。

- [ ] **Step 6: 提交**

```bash
git add src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js
git commit -m "refactor(ui): VolumeMountCard 三区块合并问题区——根除同行输入框错位"
```

---

### Task 2: defaultMode 收进键映射头行

**Files:**
- Modify: `src/components/common/VolumeMountCard.vue`(键映射头行 + 删独占权限行)
- Test: `src/components/common/__tests__/VolumeMountCard.test.js`

**Interfaces:**
- Consumes: Task 1 的 `itemsBlockIssues`(defaultMode 文案已进 `issues-items`,本任务只搬控件)、既有 `defaultModeChoice`/`issueCls`/`fld`。
- Produces: `data-testid="default-mode"` 权限 select(键映射头行内);独占权限行删除。

- [ ] **Step 1: 写失败测试**

在测试文件末尾追加:

```js
test('VolumeMountCard: defaultMode 收进键映射头行——与「＋添加」同容器;custom 输入就地展开', async () => {
  const cm = makeEntry(); cm.type = 'configMap'; cm.cmName = 'cm'
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: cm, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const modeSel = wrapper.find('[data-testid="default-mode"]')
  expect(modeSel.exists()).toBe(true)
  // 与「＋添加」按钮同一头行容器(独占行已删除的结构性断言:
  // 按钮的父容器 = 头行右侧 flex,须同时包含权限 select)
  const addBtn = wrapper.findAll('button').find(b => b.text().includes(i18n.global.t('common.add')))
  expect(addBtn).toBeTruthy()
  expect(addBtn.element.parentElement.contains(modeSel.element)).toBe(true)
  await modeSel.setValue('custom')
  const customInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '0444')
  expect(customInput).toBeTruthy()
  await customInput.setValue('0640')
  expect(cm.defaultMode).toBe('0640')
  wrapper.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 新测试 FAIL(`default-mode` testid 不存在),其余全绿。

- [ ] **Step 3: 模板搬移**

3a. 键映射头行(现 `<div class="flex items-center justify-between">` 那块)改为:

```html
      <div class="flex items-center justify-between gap-xs flex-wrap">
        <span class="text-[10px] font-semibold text-on-surface-variant">{{ t('component.volumeMount.keyMapping') }}</span>
        <div class="flex items-center gap-xs">
          <div class="flex items-center gap-0.5">
            <label class="text-[10px] font-medium text-on-surface-variant whitespace-nowrap">{{ t('component.volumeMount.defaultMode') }}</label>
            <select v-model="defaultModeChoice" data-testid="default-mode" :class="[fld, issueCls('defaultMode')]" :aria-invalid="ariaInvalid('defaultMode')" class="!w-auto">
              <option value="">{{ t('component.volumeMount.defaultModeDefault') }}</option>
              <option value="0400">0400</option>
              <option value="0640">0640</option>
              <option value="custom">{{ t('component.volumeMount.defaultModeCustom') }}</option>
            </select>
            <input v-if="defaultModeChoice === 'custom'" v-model="entry.defaultMode" :class="[fld, issueCls('defaultMode')]" :aria-invalid="ariaInvalid('defaultMode')" class="w-16" placeholder="0444" />
          </div>
          <button type="button" @click="entry.items.push({ key: '', path: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>{{ t('common.add') }}</button>
        </div>
      </div>
```

要点:`fld` 自带 `w-full`,头行 select 必须覆写 `!w-auto`(否则把「＋添加」挤换行);custom 输入 `w-16`;外层 `flex-wrap` 兜底窄宽。注意 `issueCls('defaultMode')` 仍会给 select 打红/黄框(问题区文案在 `issues-items`,框/文案分工不变)。

3b. 删除原独占权限行整块(现 `<div class="grid grid-cols-[1fr_auto] gap-xs items-end">` 到其闭合 `</div>`,含其中的 defaultMode label/select/custom input)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 全部 PASS。既有 custom 测试(placeholder `'0444'` + select 按 value 定位)与 hostPathType 测试不依赖旧行结构,无需改动。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js
git commit -m "refactor(ui): VolumeMountCard defaultMode 收进键映射头行——删独占权限行"
```

---

### Task 3: 全量门禁回归

**Files:**
- Modify: 无(纯验证;如有修随修随提交)

**Interfaces:**
- Consumes: Task 1/2 的全部改动。
- Produces: 门禁全绿的工作树(可合并状态)。

- [ ] **Step 1: 全量单测**

Run: `npm run test:unit`
Expected: 全部 PASS(重点:`DeployApp.*` / `NsWorkloadDetail.*` 消费方测试零回归)。

- [ ] **Step 2: 类型/语法 + i18n 门禁**

Run: `npm run typecheck && npm run i18n:check`
Expected: typecheck ✓;i18n:check 中 `ssh.exposeToggleTitle` 重复键为 **main 既有红灯**(修复在 feat/yaml-dialog-maximize 未合回),除此以外零新增问题(本计划零 i18n 改动)。

- [ ] **Step 3: 构建验证(.vue 模板编译)**

Run: `npm run build`
Expected: 构建成功(模板语法由 build 覆盖,typecheck 不查 .vue)。

- [ ] **Step 4: 如有修随提交;无则跳过**

```bash
git add -A && git commit -m "fix(ui): VolumeMountCard 布局重构回归修正"
```

(仅在 Step 1-3 出现需修复的问题时执行;全绿则本任务无提交。)

---

## 交付后:用户手测矩阵(spec §5.2)

真浏览器双入口(创建向导 step2 / NsWorkloadDetail 编辑):

1. CM 卷填不存在 subPath → 黄框在 subPath + `issues-mount-row` 黄字;下一步可点
2. mountPath 填 `/` → 红框 + 红字;挂载到与 subPath **等高**(错位根除验收)
3. 来源不选 → 顶行问题区红字;两控件等高
4. items 行只填 key → `issues-items` 红字
5. 权限选自定义 → 小输入框就地展开;填 999 → 红字在 `issues-items`
6. items 行 key 缺失 → 文案仍在该行下方
7. 编辑弹窗抽查 1/2/5 同表现
8. 弹窗缩窄 ~480px → 头行 flex-wrap 正常,无横向溢出
