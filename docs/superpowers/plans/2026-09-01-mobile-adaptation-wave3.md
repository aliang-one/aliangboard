# 手机适配 Wave 3 实施计划(微项收口+xterm 字号+workload 动作条+触控目标细扫清零)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收编 Wave 1/2 全部停靠微项,长尾触控目标按域清零(91 处 p-0.5 图标按钮),收拢 spec 成功标准第 2 条(触控目标 ≥40px)的最后缺口。

**Architecture:** 触控目标细扫用「**命中区扩展**」模式(视觉尺寸不变,`max-sm:p-2 max-sm:-m-2` 把点击区扩到 ~36-40px)——密集行内小按钮(表格 × / undo / 16px 图标)盲目放大 40px 会破坏紧凑布局,负 margin 命中区是本仓 DataTable 卡片已验证的配方;按域拆三批(NS 域/存储+网络域/管理+SSH+工作台域)独立提交独立审查。

**Tech Stack:** Vue 3 `<script setup>` + vitest(happy-dom) + tailwind `max-sm:` + 零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md` §4(触控目标)、§7(波次表 3+)、§8(成功标准 2)。

## Global Constraints

- 禁止新增 npm 依赖;提交作者恒 `aliangone <aliangone@gmail.com>`(提交前 `git config user.name`+`user.email` 双核,提交后 `%an %ae` 自证)、禁止 Co-Authored-By 尾注。
- 触控目标模式(本波统一配方):交互小图标按钮(`p-0.5`/`p-1` + 图标)加 `max-sm:p-2 max-sm:-m-2`——**视觉尺寸零变化,命中区扩到 ~36px+**;只作用于带 `@click` 的交互元素,纯展示 chip/标签不动。
- 域批量任务只加类不动逻辑;每文件改动 diff 必须纯 class 串追加;桌面/iPad 零回归(不加 max-sm 前缀的类不得新增)。
- 浮层 z 一律 zScale;多会话并行期全量 unit 用 `npx vitest run --maxWorkers=2`;docs/superpowers gitignore 需 `-f`。
- 工作分支 `worktree-feat-mobile-3`。

---

### Task 1: 微项收口(pb-20 冗余 + DropdownMenu 遮罩 z 统一)

**Files:**
- Modify: `src/views/PodDetail.vue:219`(根 `max-sm:pb-20` 删除——止血条 sticky 化后已入流,80px 底部填充冗余)
- Modify: `src/components/common/DropdownMenu.vue:94`(遮罩 `z-30` → `:style="{ zIndex: Z.popover - 1 }"`,与 SplitButton 配方统一;:59 注释同步)
- Test: 既有测试回归(两文件均有;DropdownMenu 遮罩类断言若存在需同步)

- [ ] **Step 1: 写失败测试**(DropdownMenu 测试追加——遮罩 zIndex 从 Z 取值)

```js
test('遮罩 zIndex=Z.popover-1(与 SplitButton 配方统一,不再裸 z-30)', async () => {
  const w = await mountMenu()
  await w.find('button').trigger('click')
  await nextTick()
  // 遮罩是面板的兄弟 fixed 层(document.body 内即宿主内)——按宿主内查询
  const mask = w.find('.fixed.inset-0')
  expect(mask.exists()).toBe(true)
  expect(mask.attributes('style')).toContain(String(Z.popover - 1))
  w.unmount(); document.body.innerHTML = ''
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/DropdownMenu.panel.test.js`
Expected: FAIL(遮罩无 style zIndex)

- [ ] **Step 3: 实现**——DropdownMenu.vue 遮罩行改:

```html
    <div v-if="open" class="fixed inset-0" :style="{ zIndex: Z.popover - 1 }" @click.stop="close"></div>
```

:59 注释 `Z.popover(110) 恒高于遮罩 z-30` 改 `Z.popover(110) 恒高于遮罩(popover-1=109),点菜单不触遮罩、点遮罩关菜单`。PodDetail.vue:219 根类删 `max-sm:pb-20`(仅此一处,其它类不动)。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/components/common/__tests__/DropdownMenu.panel.test.js src/views/__tests__/PodDetail.terminal-sid.test.js && node --test scripts/overflow-guard.test.mjs`
Expected: PASS(全绿;overflow-guard V1-V4 无新违规)

- [ ] **Step 5: Commit**

```bash
git add src/views/PodDetail.vue src/components/common/DropdownMenu.vue src/components/common/__tests__/DropdownMenu.panel.test.js
git commit -m "feat(mobile): 微项收口——PodDetail pb-20 冗余删除+DropdownMenu 遮罩 z 统一 Z.popover-1"
```

---

### Task 2: xterm 字号热调

**Files:**
- Modify: `src/components/common/InteractiveTerminal.vue`(按键条追加 A-/A+;`term.options.fontSize` 热调+fit)
- Test: `src/components/common/__tests__/InteractiveTerminal.keys.test.js`(追加)

**Interfaces:**
- Consumes: 既有 `term`(xterm 实例,组件作用域)、`fit`(FitAddon 实例——核对该文件真实变量名)、`isPhone`、按键条容器。
- Produces: 手机档按键条左端 A-/A+ 字号钮(8~20px 钳制,默认=创建值),热调后立即 `fit()` 重排行。

- [ ] **Step 1: 写失败测试**(mount 成本高——字号逻辑抽纯函数直测,同 KEY_BYTES 模式)

```js
import { clampFont, FONT_MIN, FONT_MAX } from '@/components/common/InteractiveTerminal.vue'

test('字号钳制:8~20,默认外值收敛到界内', () => {
  expect(FONT_MIN).toBe(8)
  expect(FONT_MAX).toBe(20)
  expect(clampFont(12)).toBe(12)
  expect(clampFont(4)).toBe(8)
  expect(clampFont(99)).toBe(20)
  expect(clampFont(19)).toBe(19)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/InteractiveTerminal.keys.test.js`
Expected: FAIL(clampFont 未导出)

- [ ] **Step 3: 实现**(InteractiveTerminal.vue,普通 `<script>` 块与 KEY_BYTES 同处)

```js
export const FONT_MIN = 8, FONT_MAX = 20
export const clampFont = n => Math.min(FONT_MAX, Math.max(FONT_MIN, n))
```

`<script setup>`:按键条 v-for 之前插 A-/A+(复用按键钮样式,加 `font-mono font-semibold`);`adjustFont(delta)`:

```js
const termFont = ref(Number(读 term 初始 fontSize)) // 以该文件创建 term 的真实 fontSize 选项为准(若写死 14 则 ref(14))
function adjustFont(delta) {
  termFont.value = clampFont(termFont.value + delta)
  if (term) { term.options.fontSize = termFont.value; fit?.fit() }  // fit=该文件 FitAddon 实例真实变量名
}
```

A± 钮 `@pointerdown.prevent @click="adjustFont(-1)/(1)"`(防焦点转移,同 Task5 配方);`termFont` ref 初值必须等于创建 term 时的实际 fontSize 值(源码核对,勿猜)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/InteractiveTerminal.keys.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/InteractiveTerminal.vue src/components/common/__tests__/InteractiveTerminal.keys.test.js
git commit -m "feat(mobile): 终端字号热调——按键条 A-/A+,8~20 钳制+即时 fit"
```

---

### Task 3: NsWorkloadDetail 手机动作区 + 底部动作条

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(头部 伸缩/重启 按钮区 :1246-1247 换行+触控目标;手机档 sticky 底部动作条)
- Test: `grep -rln "NsWorkloadDetail" src --include=*.test.js` 定位既有测试(该页体量大,允许浅 mount+子组件 stub;既有 mount 方式优先)

**Interfaces:**
- Consumes: 既有 `openScale`/`handleRestart`/`canMutate`(确认流/权限语义零改动——复用,与 PodDetail 止血条同款红线);`useIsPhone()`、`Z`。

- [ ] **Step 1: 写失败测试**

```js
test('手机档:头部动作钮换行+40px;底部动作条(伸缩/重启)在场且走既有确认流', async () => {
  mockViewport(true)
  const w = await mountDetail()   // 照既有 mount(canMutate 场景须为可变更)
  const scaleBtn = w.findAll('button').find(b => b.text() === '伸缩')  // 以真实 i18n 文案定位;或加 data-testid
  expect(scaleBtn.classes().join(' ')).toContain('max-sm:min-h-[40px]')
  const bar = w.find('[data-testid="workload-action-bar"]')
  expect(bar.exists()).toBe(true)
  await bar.findAll('button')[0].trigger('click')
  // 断言走既有确认/弹窗链(照 Task 4 PodDetail 先例:断言 Modal 打开或 openScale 副作用),不直接调 API
  w.unmount()
})

test('桌面档:无底部动作条', async () => {
  mockViewport(false)
  const w = await mountDetail()
  expect(w.find('[data-testid="workload-action-bar"]').exists()).toBe(false)
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <定位到的测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**(NsWorkloadDetail.vue)

① 头部动作钮(:1246 `openScale`、:1247 `handleRestart` 等)类各追加 `max-sm:min-h-[40px]`;其容器追加 `max-sm:flex-wrap`。
② 手机 sticky 底部动作条(照 PodDetail 止血条先例,**sticky 不用 fixed**——该页路由滚动语义先核实,与 PodDetail 同为 main 滚动则同款):

```html
  <div v-if="isPhone && workload" data-testid="workload-action-bar"
    class="sticky bottom-0 flex gap-sm px-md pt-sm bg-surface-container-lowest border-t border-outline-variant"
    :style="{ zIndex: Z.drawer - 1, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }">
    <button v-if="isScalable" @click="openScale" :disabled="!canMutate" class="flex-1 min-h-[44px] flex items-center justify-center gap-sm bg-primary text-on-primary rounded-lg font-semibold active:scale-95 transition-all disabled:opacity-40">
      <span class="material-symbols-outlined text-base">open_in_full</span>{{ $t('workload.scale') }}
    </button>
    <button @click="handleRestart" :disabled="!canMutate" class="flex-1 min-h-[44px] flex items-center justify-center gap-sm border border-outline-variant text-on-surface rounded-lg active:scale-95 transition-all disabled:opacity-40">
      <span class="material-symbols-outlined text-base">restart_alt</span>{{ $t('workload.restart') }}
    </button>
  </div>
```

> 插入位置=根模板流内末尾(与 PodDetail 同款 sticky 生效条件,先核该页路由是否 main 滚动);`workload` 根守卫照该页实际数据变量名;script 引 `useIsPhone`/`Z`;主内容若被条遮挡则手机档补底部 padding(以条实际高度估)。

- [ ] **Step 4: 跑测试确认通过**(该文件全部)

Run: `npx vitest run <定位到的测试文件>`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/NsWorkloadDetail.vue <测试文件>
git commit -m "feat(mobile): NsWorkloadDetail 手机动作区换行+底部动作条(伸缩/重启,复用确认流)"
```

---

### Task 4: 触控目标细扫·NS 域

**Files:**
- Modify: `src/views/Ns*.vue`(命名空间域全部视图)中命中元素
- Test: 无新测试——类追加由 grep 计数清零 + diff 纯 class 审查守护

**Interfaces:**
- Consumes: 本计划 Global Constraints 的「触控目标模式」。
- Produces: NS 域交互小图标按钮命中区全部扩到 ~36px+。

- [ ] **Step 1: 盘点**(精确清单,区分交互/展示)

```bash
grep -rn 'p-0\.5\|"p-1 "\| p-1"' src/views/Ns*.vue src/components/common/*.vue 2>/dev/null | grep -E 'button|@click|<a ' | grep -v test
```

人工复核输出:只保留**交互元素**(button/a/带 @click 的 span);展示性 chip/徽标/装饰剔除。剔除 WorkbenchProjects.vue:187 的 `opacity-60` DropdownMenu 触发钮(设计如此,非本模式对象)。

- [ ] **Step 2: 逐处套用配方**(纯 class 追加,逻辑零改动)

对每个交互元素,在其 class 串**末尾**追加 `max-sm:p-2 max-sm:-m-2`;若元素已有负 margin/相邻紧凑布局会因 -m-2 重叠(如同一 flex 行内多个相邻小钮),改用 `max-sm:p-1.5 max-sm:-m-1.5`(次级配方,命中区 ~30px,报告记明)。

- [ ] **Step 3: 验证**

```bash
grep -rn 'p-0\.5' src/views/Ns*.vue | grep -E 'button|@click' | grep -v 'max-sm:p-2' | wc -l
```
Expected: 0(全部覆盖或显式次级配方;报告中列每处选择)

- [ ] **Step 4: 回归**

Run: `npx vitest run --maxWorkers=2 src/components src/views 2>&1 | tail -3 && node --test scripts/overflow-guard.test.mjs`
Expected: 全绿(类追加不破坏既有断言;overflow-guard V1-V4 绿)

- [ ] **Step 5: Commit**

```bash
git add src/views/ src/components/common/
git commit -m "feat(mobile): NS 域触控目标细扫——交互小钮命中区扩展(配方 max-sm:p-2 -m-2)"
```

---

### Task 5: 触控目标细扫·存储+网络域

**Files:**
- Modify: `src/views/` 下存储/网络域视图(以 `ls src/views/ | grep -iE "pv|storage|ingress|service|network|port"` 实际清单为准)命中元素

**Interfaces:**
- Consumes: 本计划 Global Constraints 的「触控目标模式」与 Task 4 盘点方法。

- [ ] **Step 1: 盘点**

```bash
grep -rn 'p-0\.5\|"p-1 "\| p-1"' src/views/NsPv*.vue src/views/NsStorageClass*.vue src/views/NsIngress*.vue src/views/NsService*.vue src/views/NsNetworkPolic*.vue 2>/dev/null | grep -E 'button|@click|<a ' | grep -v test
```

人工复核:只保留交互元素,展示性 chip/装饰剔除。

- [ ] **Step 2: 逐处套用配方**(同 Task 4 Step 2:主配方 `max-sm:p-2 max-sm:-m-2`,紧凑相邻场景次级 `max-sm:p-1.5 max-sm:-m-1.5` 并报告记明;纯 class 追加)

- [ ] **Step 3: 验证清零**

```bash
grep -rn 'p-0\.5' src/views/NsPv*.vue src/views/NsStorageClass*.vue src/views/NsIngress*.vue src/views/NsService*.vue src/views/NsNetworkPolic*.vue 2>/dev/null | grep -E 'button|@click' | grep -v 'max-sm:p-2\|max-sm:p-1.5' | wc -l
```
Expected: 0

- [ ] **Step 4: 回归**

Run: `npx vitest run --maxWorkers=2 src/components src/views 2>&1 | tail -3 && node --test scripts/overflow-guard.test.mjs`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/views/
git commit -m "feat(mobile): 存储/网络域触控目标细扫——交互小钮命中区扩展"
```

---

### Task 6: 触控目标细扫·管理+SSH+工作台域

**Files:**
- Modify: `src/views/`(Admin*/UserProfile*/Cluster* 等管理域)、`src/components/ssh/`、`src/components/workbench/`(WorkbenchChat.vue 除外——审批钮 44px 已达标)命中元素

**Interfaces:**
- Consumes: 本计划 Global Constraints 的「触控目标模式」与 Task 4 盘点方法。

- [ ] **Step 1: 盘点**

```bash
grep -rn 'p-0\.5\|"p-1 "\| p-1"' src/views/Admin*.vue src/views/UserProfile*.vue src/views/Cluster*.vue src/views/SelectCluster*.vue src/components/ssh/*.vue src/components/workbench/*.vue 2>/dev/null | grep -E 'button|@click|<a ' | grep -v test
```

人工复核:只保留交互元素;workbench 域多触控目标已在前两波达标,本任务只收 p-0.5/p-1 残留。

- [ ] **Step 2: 逐处套用配方**(同 Task 4 Step 2:主配方 `max-sm:p-2 max-sm:-m-2`,紧凑相邻场景次级 `max-sm:p-1.5 max-sm:-m-1.5` 并报告记明;纯 class 追加)

- [ ] **Step 3: 验证清零**

```bash
grep -rn 'p-0\.5' src/views/Admin*.vue src/views/UserProfile*.vue src/views/Cluster*.vue src/components/ssh/*.vue src/components/workbench/*.vue 2>/dev/null | grep -E 'button|@click' | grep -v 'max-sm:p-2\|max-sm:p-1.5' | wc -l
```
Expected: 0

- [ ] **Step 4: 回归**

Run: `npx vitest run --maxWorkers=2 src/components src/views 2>&1 | tail -3 && node --test scripts/overflow-guard.test.mjs`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/views/ src/components/ssh/ src/components/workbench/
git commit -m "feat(mobile): 管理/SSH/工作台域触控目标细扫——交互小钮命中区扩展"
```

---

### Task 7: 全量门禁 + 手测清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(追加 §12)

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && node --test server/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)" && npx vitest run --maxWorkers=2 2>&1 | grep -E "Test Files|Tests " && npm run i18n:check
```
Expected: 四项全绿(基线 1819 只增不减)

- [ ] **Step 2: spec 追加**(逐字)

```markdown

## 12. Wave 3 真机手测清单

1. PodDetail:底部不再有 80px 空白带;滚动到底内容不被止血条遮
2. 终端:按键条 A-/A+ 字号即时变化且终端重排;最小/最大档不再变化
3. NsWorkloadDetail:底部动作条伸缩/重启可用且弹既有确认;头部按钮可点
4. 任一表格行内小钮(× / undo / 图标钮):手机上不瞄准也能点中(命中区扩展生效);视觉尺寸无变化
5. 下拉遮罩(表格行 ⋮):点遮罩关闭正常;多层叠放下拉互不糊化
6. 桌面/iPad:以上全部无观感变化——零回归
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): Wave 3 真机手测清单"
```

---

## Wave 3 完成定义

- Task 1-6 全部 commit 在 `worktree-feat-mobile-3`;Task 7 四门禁绿;
- 真机手测(§12)通过后 `--no-ff` 合 main;
- 长尾遗留(若有):Task 4-6 盘点中被剔除的非交互元素、以及执行中新发现的问题,逐条登记到本计划完成报告,作为 Wave 4 或随版修对象。
