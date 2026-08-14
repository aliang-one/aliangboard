# 钻入入口图标化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ns 态底部集群入口由文字链改为 `dashboard` 图标(图标行变 4 个);集群态命名空间选择器旁加 `arrow_forward` 进入示意。

**Architecture:** 纯 UI 微调,叠加在已合 main 的视觉特性上。仅改 `SideNavBar.vue`(footer 图标行 + 选择器)+ 测试;不改路由/store/动效/依赖/i18n。

**Tech Stack:** Vue 3 + vue-router + vue-i18n(纯 JS);vitest + @vue/test-utils + happy-dom;`npm run typecheck` / `npm run test:unit` / `npm run build` 门禁。

## Global Constraints

- 不加依赖、无 i18n 改动(复用已有 `nav.clusterOverview`)。
- 组件测试用 vitest(`npx vitest run <file>`);testid `data-test`。
- 门禁:`npm run typecheck`、`npm run test:unit`、`npm run build`。
- commit message 末尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 分支 `worktree-feat-ns-nav-icons`(基线 main `8d874de`,含合并后的视觉特性)。
- **保留** `cluster-home` 契约:testid + `@click="router.push('/cluster')"` + `v-if="isNsMode"`,仅形态从文字链变 icon-only。

## File Structure

| 文件 | 改动 |
|------|------|
| `src/components/layout/SideNavBar.vue` | 删 cluster-home 文字链;图标行最左加 `dashboard` 图标按钮(cluster-home);ns-home 内 folder_open 后加 `arrow_forward`(ns-enter,v-if isClusterMode) |
| `src/components/__tests__/SideNavBar.test.js` | 新增 2 断言(cluster-home 为 dashboard icon-only;集群态有 ns-enter、ns 态无) |

---

## Task 1: 钻入入口图标化(集群入口 icon + 命名空间进入箭头)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(ns-home 按钮 ~214-220;Bottom Actions 图标行 ~344-364 + 文字链 ~366-378)
- Modify: `src/components/__tests__/SideNavBar.test.js`(追加 2 用例)

**Interfaces:**
- Consumes: 已有的 `isNsMode`/`isClusterMode`(`useNavMode()`)、`isGlobalActive`、`$t('nav.clusterOverview')`、`SideNavBar.test.js` 的 `mountSideNavBar`/`routeRef`/`pushMock`。
- Produces:ns 态底部 `[dashboard(cluster-home)][events][activity][settings]` 4 图标;集群态 ns-home 内 `data-test="ns-enter"`(arrow_forward)。

- [ ] **Step 1: 追加 failing 测试**

在 `src/components/__tests__/SideNavBar.test.js` 末尾追加:
```js
test('ns mode: cluster-home 是 dashboard 图标、icon-only(无可见「集群概览」文本)', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  const home = w.find('[data-test="bottom-actions"] [data-test="cluster-home"]')
  expect(home.exists()).toBe(true)
  expect(home.find('.material-symbols-outlined').text()).toBe('dashboard')
  expect(home.text()).not.toContain('集群概览')
})

test('集群态: ns-home 内有 ns-enter(进入下层); ns 态无', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  expect(mountSideNavBar().find('[data-test="ns-enter"]').exists()).toBe(true)
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  expect(mountSideNavBar().find('[data-test="ns-enter"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: 2 新用例 FAIL —— `ns-enter` 不存在;cluster-home 当前是 `arrow_back` 文字链(含「集群概览」文本),非 `dashboard` icon-only。

- [ ] **Step 3: 图标行最左加 dashboard 图标按钮(cluster-home)**

在 Bottom Actions 的图标行 `<div class="flex items-stretch gap-xs">` 内、`bottom-events` 按钮**之前**,插入:
```html
        <button v-if="isNsMode" data-test="cluster-home"
          @click="router.push('/cluster')"
          :title="$t('nav.clusterOverview')" :aria-label="$t('nav.clusterOverview')"
          class="flex-1 flex items-center justify-center py-sm rounded-lg transition-colors"
          :class="isGlobalActive('/cluster') ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
          <span class="material-symbols-outlined text-lg">dashboard</span>
        </button>
```

- [ ] **Step 4: 删除原 cluster-home 文字链**

删除 Bottom Actions 内、图标行之后的整个 `<a v-if="isNsMode" data-test="cluster-home" …>arrow_back + 文本</a>` 块(即原「返回上层(仅 ns 态)」注释 + 其下 `<a>...</a>`)。

- [ ] **Step 5: ns-home 内 folder_open 后加 arrow_forward(仅集群态)**

在 `data-test="ns-home"` 按钮内,`<span ...>folder_open</span>` 之后、ns 名 `<span>` 之前,插入:
```html
            <span v-if="isClusterMode" data-test="ns-enter" class="material-symbols-outlined text-base text-on-surface-variant">arrow_forward</span>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: PASS(全部用例,含既有的 cluster-home 契约用例与新加 2 个)。

- [ ] **Step 7: typecheck + build + commit**

Run: `npm run typecheck` && `npm run build`。
```bash
git add src/components/layout/SideNavBar.vue src/components/__tests__/SideNavBar.test.js
git commit -m "feat(nav): 集群入口收成 dashboard 图标(4 icon 行)+ 命名空间进入箭头

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾:全量门禁 + 手测

- [ ] `npm run test:unit`(全绿)
- [ ] `npm run typecheck`、`npm run build`
- [ ] 手测:ns 态底部 4 图标平级、最左 dashboard 点回 `/cluster`;集群态选择器 folder_open 旁有 →、选 ns 进入后(ns 态)消失。
