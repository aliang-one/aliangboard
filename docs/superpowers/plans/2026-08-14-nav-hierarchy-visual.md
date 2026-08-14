# 命名空间态层级可视化(底部入口 + 钻入动效)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把命名空间态的「返回上层」从顶部响亮的返回按钮降级为底部安静链接,并用模式切换时的钻入动效表达集群↔命名空间的上下层关系。

**Architecture:** 纯视觉增量,叠加在已合并的 nav-scoped 特性上。改 `SideNavBar.vue`:ns 态移除顶部集群头、`cluster-home` 迁移到底部安静链接(保留 testid+点击行为→现有测试继续通过);`<nav>` 内 ns/cluster 分组用 `<Transition name="nav-drill">` 包裹按 `navMode` 切换,加 240ms 钻入 CSS + reduced-motion。不改路由/store/逻辑/依赖/i18n。

**Tech Stack:** Vue 3 + vue-router + vue-i18n(纯 JS);vitest + @vue/test-utils + happy-dom(组件测试);`npm run typecheck` / `npm run test:unit` / `npm run build` 门禁。

## Global Constraints

(每个任务的隐含前置,值逐字取自 spec)

- **不新增文件、不加依赖、无 i18n 改动**(返回链接文案复用已有 `nav.clusterOverview`)。
- 组件测试用 **vitest + @vue/test-utils + happy-dom**(`npx vitest run <file>`);testid 约定 `data-test="..."`。
- 门禁:`npm run typecheck`(`node --check` 全 .js/.mjs;.vue 由 `npm run build` 覆盖)、`npm run test:unit`、`npm run build`。
- commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 分支:`worktree-feat-ns-scoped-nav`(已快进到 main `944eb64`,含合并后的 nav-scoped 代码与 `SideNavBar.test.js`)。
- **不破坏** nav-scoped 既有契约:`cluster-home` testid 与「点击 → `router.push('/cluster')`」行为保留(只是位置从顶部移到底部);ns/cluster 分组仍按 `isNsMode`/`isClusterMode` 互斥。

## File Structure

| 文件 | 责任 | 任务 |
|------|------|------|
| `src/components/layout/SideNavBar.vue` | Header 重构(ns 态去头、集群态加 `cluster-brand` testid);底部加返回链接;`<Transition name="nav-drill">` 包裹分组切换;`<style scoped>` 钻入动效 + reduced-motion | Task 1、2 |
| `src/components/__tests__/SideNavBar.test.js` | 复用既有 `mountSideNavBar` helper;新增「cluster-home 在底部」「ns 态无 cluster-brand」「集群态有 cluster-brand」断言 | Task 1 |

不动:路由、store、`useNavMode`、TopNavBar、各资源视图、`SideNavBar.bottom-row.test.js`、i18n。

---

## Task 1: 返回入口去强调(移到底部链接 + ns 态去顶部集群头)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(Header 块 ~190-216;Bottom Actions 块 ~347-380)
- Modify: `src/components/__tests__/SideNavBar.test.js`(追加 2 个用例)

**Interfaces:**
- Consumes: nav-scoped 特性的 `isNsMode`/`isClusterMode`(已存在于 `SideNavBar.vue` script)、既有 `mountSideNavBar()` helper 与 `routeRef`/`pushMock`(在 `SideNavBar.test.js`)。
- Produces: ns 态顶部无集群头;`data-test="cluster-home"` 位于底部 `data-test="bottom-actions"` 内;集群态顶部头部带 `data-test="cluster-brand"`。

- [ ] **Step 1: 追加 failing 测试**

在 `src/components/__tests__/SideNavBar.test.js` 末尾追加:
```js
test('ns mode: cluster-home 在底部 + 顶部无集群头', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  // 返回链接迁到底部区
  expect(w.find('[data-test="bottom-actions"] [data-test="cluster-home"]').exists()).toBe(true)
  // ns 态顶部不再有集群头品牌块
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(false)
})

test('cluster mode: 顶部有 cluster-brand + 底部无返回链接', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-actions"] [data-test="cluster-home"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: 新增 2 用例 FAIL —— `bottom-actions` testid 与 `cluster-brand` testid 都还不存在;且 `cluster-home` 当前在顶部不在底部区。

- [ ] **Step 3: 改 Header 块——ns 态去头,集群态加 testid**

把 Cluster Header 块(原 `<button v-if="isNsMode" data-test="cluster-home">…</button>` + `<div v-else>…</div>`)整体替换为**仅集群态**的静态头:
```html
    <!-- Cluster Header:仅集群态展示(ns 态顶部让给 ns,返回走底部链接) -->
    <div v-if="isClusterMode" data-test="cluster-brand" class="flex items-center gap-md p-md px-lg shrink-0">
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
      </div>
    </div>
```
(即:删除原 ns 态 `<button>` 整块;原 `<div v-else>` 改为 `v-if="isClusterMode"` 并加 `data-test="cluster-brand"`。)

- [ ] **Step 4: 底部加返回链接 + 给 Bottom Actions 容器加 testid**

给 Bottom Actions 容器 `<div class="shrink-0 px-md pb-md pt-sm border-t border-outline-variant/50">` 加 testid:
```html
    <div data-test="bottom-actions" class="shrink-0 px-md pb-md pt-sm border-t border-outline-variant/50">
```
在该容器内、既有图标行 `<div class="flex items-stretch gap-xs">…</div>` **之后**追加返回链接:
```html
      <!-- 返回上层(仅 ns 态):安静链接,非响亮按钮 -->
      <a
        v-if="isNsMode"
        data-test="cluster-home"
        @click="router.push('/cluster')"
        :title="$t('nav.clusterOverview')"
        :aria-label="$t('nav.clusterOverview')"
        class="mt-sm -mb-xs flex items-center gap-xs px-sm py-sm rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors cursor-pointer text-body-sm"
      >
        <span class="material-symbols-outlined text-base">arrow_back</span>
        <span>{{ $t('nav.clusterOverview') }}</span>
      </a>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: PASS(全部用例,含既有的「ns 态 cluster-home 存在 + 点击 → `/cluster`」「集群态无 cluster-home」与新加 2 个)。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck`。
```bash
git add src/components/layout/SideNavBar.vue src/components/__tests__/SideNavBar.test.js
git commit -m "feat(nav): 返回入口去强调——移到底部安静链接,ns 态去顶部集群头

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 钻入/钻出动效 + reduced-motion

> 说明:CSS 过渡是视觉感受,happy-dom 无法断言动画;Task 2 用 typecheck + build(确保 `<Transition>` 与 `<style>` 编译通过)+ 手测验证。结构正确性已由 Task 1 的组件测试覆盖(分组按 mode 渲染)。

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(`<nav>` 内分组包裹 `<Transition>`;末尾 `<style scoped>`)

**Interfaces:**
- Consumes: Task 1 的 `isNsMode`/`isClusterMode`、`navMode`(来自 `useNavMode`,script 内已有 `const { isNsMode, isClusterMode } = useNavMode()`;若 script 未解构 `navMode`,本任务加上)。
- Produces:模式切换时分组钻入动效(240ms);`prefers-reduced-motion` 下瞬切。

- [ ] **Step 1: script 解构出 navMode(若缺)**

在 `SideNavBar.vue` script 的 `const { isNsMode, isClusterMode } = useNavMode()` 处,补 `navMode`(用作 Transition key):
```js
const { navMode, isNsMode, isClusterMode } = useNavMode()
```

- [ ] **Step 2: `<nav>` 内用 `<Transition name="nav-drill">` 包裹分组切换**

找到 `<nav>` 内的「命名空间资源组(`<div v-if="isNsMode" data-test="ns-nav-section">…`)」与「集群导航组(`<div v-if="isClusterMode" data-test="cluster-nav-section">…`)」两块。**保留这两块各自不变**,用一个带 `:key="navMode"` 的包装 `<div>` 把它们一起包进 `<Transition>`;平台管理(`<div v-if="authStore.isAdmin">`)**留在 Transition 外**(它两态都有,无需动画):
```html
      <Transition name="nav-drill">
        <div :key="navMode">
          <!-- 命名空间资源组(原样) -->
          <div v-if="isNsMode" data-test="ns-nav-section" class="animate-fade-in mb-md">
            …原有内容不动…
          </div>
          <!-- 集群导航组(原样) -->
          <div v-if="isClusterMode" data-test="cluster-nav-section" class="flex flex-col gap-xs">
            …原有内容不动…
          </div>
        </div>
      </Transition>
```
给 `<nav>` 容器加 `relative`(供离场绝对定位参照):原 `<nav class="flex-1 overflow-y-auto px-md pb-md">` 改为 `<nav class="relative flex-1 overflow-y-auto px-md pb-md">`。

- [ ] **Step 3: 加 `<style scoped>` 钻入动效 + reduced-motion**

在 `SideNavBar.vue` 末尾(`</template>` 之后)新增(当前文件无 `<style>`,直接加) :
```html
<style scoped>
.nav-drill-enter-from,
.nav-drill-leave-to { opacity: 0; transform: translateY(8px); }
.nav-drill-enter-active,
.nav-drill-leave-active {
  transition: opacity .24s cubic-bezier(.2,.7,.3,1), transform .24s cubic-bezier(.2,.7,.3,1);
}
.nav-drill-leave-active { position: absolute; left: 0; right: 0; top: 0; }
@media (prefers-reduced-motion: reduce) {
  .nav-drill-enter-active,
  .nav-drill-leave-active { transition: none; }
}
</style>
```
(离场元素绝对定位以与进场元素短暂重叠,表达「向上收 + 从下钻入」的垂直运动;`<nav>` 的 `relative` 作参照。)

- [ ] **Step 4: 编译 + 全量组件测试**

Run: `npm run build`(确保 `<Transition>` 与 `<style scoped>` 编译通过,.vue 无语法错)
Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: build 成功;测试全绿(Task 1 用例不受影响——`data-test` 节点仍在 Transition 内可被 `find` 命中)。

- [ ] **Step 5: 手测验证(动效是视觉感受)**

`npm run dev` 后:
1. 集群态(`/cluster`)选 ns → 集群组向上收、ns 组从下钻入,~240ms 顺滑,无高度跳动。
2. ns 态点底部「← 集群概览」→ 回 `/cluster`,反向动效。
3. 系统设「减少动态效果」(reduced-motion)→ 瞬切,无位移。
4. ns 态:顶部无集群头,底部有安静返回链接,ns 选中项仍最亮。

- [ ] **Step 6: commit**

```bash
git add src/components/layout/SideNavBar.vue
git commit -m "feat(nav): 模式切换钻入动效 + reduced-motion(命名空间态层级可视化)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾:全量门禁

- [ ] `npm run test:unit`(含 Task 1 新断言,全绿)
- [ ] `npm run typecheck`
- [ ] `npm run build`(.vue 编译)
- [ ] 手测清单(spec §6):① 选 ns 钻入顺滑;② 点底部链接回集群态反向动效;③ reduced-motion 瞬切;④ ns 态顶部无集群头、底部有安静链接、ns 选中项最亮。
