# 侧边栏 Namespace 按钮停靠坞风格重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `SideNavBar.vue` 顶部 Namespace 选择器重设计为停靠坞设计语言(方案 B:浅坞+绿 chip),并为集群态/ns 态提供明确的「可点击+去向」提示。

**Architecture:** 纯前端单组件改造 + 双语 locale 键 + 新增 vitest 行为契约测试。不引入 Vue `<Transition>`(插入动画走 CSS keyframes,与坞块同法);不引入 `useI18n()`(会破只 mock `$t` 的既有测试)。设计文档:`docs/superpowers/specs/2026-08-18-ns-button-dock-style-design.md`(本计划与其同仓提交)。

**Tech Stack:** Vue 3 `<script setup>` + Tailwind(既有)+ scoped CSS(坞块先例)+ vue-i18n + vitest/happy-dom(@vue/test-utils)。

## Global Constraints

- 工作分支:`worktree-ns-button-dock-style`(worktree 路径 `.claude/worktrees/ns-button-dock-style`,下称「工作目录」;所有命令在其根执行)。
- 测试契约必须保持:`data-test="ns-home"`(点击 → push `NamespaceOverview`)、`data-test="ns-enter"` 仅集群态存在、`cluster-anchor` 不动。既有测试文件(`SideNavBar.test.js`、`SideNavBar.home.test.js`、`SideNavBar.bottom-*.test.js` 等)**零修改**且必须全绿。
- 门禁命令(每个 Task 收尾必跑):`npm run test:unit`、`npm run typecheck`、`npm run i18n:check`(Task 3 追加 `npm run build`)。
- 动效必须带 `prefers-reduced-motion: reduce` 禁用分支。
- 禁止新增外部依赖;字号用任意值 px(如 `font-size:12px`),勿臆造 Tailwind token(幽灵类静默 no-op)。
- i18n 消息值不含 `@`、不含 HTML,不需要转义/v-html。
- 提交信息用仓库惯例中文 subject;每 Task 一次提交,结尾空行 + `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: i18n 键落地(zh/en 各 8 个 nav.* 键)

**Files:**
- Modify: `src/locales/zh.json`(nav 区块,约 302 行 `"backToCluster": "返回集群",` 之后)
- Modify: `src/locales/en.json`(同位置 nav 区块)

**Interfaces:**
- Consumes: 无
- Produces: `nav.selectNamespace` / `nav.nsHere` / `nav.nsNotEntered` / `nav.enterNamespace` / `nav.backToNsOverview` / `nav.switchNamespace` / `nav.filterNamespaces` / `nav.noMatchingNamespaces`(Task 2 模板引用;zh 值也是 Task 2 测试的断言文本)

- [ ] **Step 1: zh.json 的 nav 区块追加 8 键**

在 `"backToCluster": "返回集群",` 行后插入:

```json
    "selectNamespace": "选择命名空间",
    "nsHere": "命名空间 · 当前所在",
    "nsNotEntered": "命名空间 · 未进入",
    "enterNamespace": "进入命名空间",
    "backToNsOverview": "↩ 回拓扑总览",
    "switchNamespace": "切换命名空间",
    "filterNamespaces": "筛选命名空间…",
    "noMatchingNamespaces": "没有匹配的命名空间",
```

注意:zh.json 约 2891 行处另有嵌套的 `"backToCluster"`,**只改 nav 区块**(约 302 行处,其邻居是 `"clusterOverview"` / `"settings"` / `"deploy"` 等)。

- [ ] **Step 2: en.json 的 nav 区块追加同样 8 键**

```json
    "selectNamespace": "Select namespace",
    "nsHere": "Namespace · current",
    "nsNotEntered": "Namespace · not entered",
    "enterNamespace": "Enter namespace",
    "backToNsOverview": "↩ Topology overview",
    "switchNamespace": "Switch namespace",
    "filterNamespaces": "Filter namespaces…",
    "noMatchingNamespaces": "No matching namespaces",
```

- [ ] **Step 3: 跑 i18n 门禁验证键对齐**

Run: `npm run i18n:check`
Expected: 通过(无键不对齐/缺失;新增键尚无引用不影响)

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "feat(i18n): nav 新增 ns 按钮两态提示 8 键(选择/进入/回总览/切换/筛选/无匹配)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 模板重构 + 行为契约(TDD)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(script 追加 `onNsHomeClick`;template 223-280 的 Namespace Selector 区块整体替换)
- Create: `src/components/layout/__tests__/SideNavBar.nsband.test.js`

**Interfaces:**
- Consumes: Task 1 的 8 个 i18n 键;既有 `currentNs`/`isClusterMode`/`showNsDropdown`/`nsSearch`/`filteredNamespaces`/`selectNamespace`/`nsStatusColor`。
- Produces: DOM 契约(Task 3 CSS 与测试都依赖)——容器 `.ns-band.ns-band--cluster|.ns-band--ns`;主按钮 `[data-test="ns-home"].ns-main`;chip `.ns-chip` 内两图标 `.ns-ci--folder`/`.ns-ci--hub`;副标签 `.ns-sub` > `.ns-t--def`/`.ns-t--hov`(按态 v-if 只渲染一对);箭头 `[data-test="ns-enter"].ns-arr`;瓦片 `.ns-tile`(aria-expanded);下拉 `.ns-drop` > `.ns-search`/`.ns-row`(`.ns-row--cur` 当前项)。

- [ ] **Step 1: 写失败测试(新文件全文)**

```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

// 与 SideNavBar.test.js 同法:reactive route/store 供逐用例改写;真实 i18n 插件(断言翻译文案)
const { _routeObj, pushMock, _store } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, path: '/cluster', params: {} },
  pushMock: vi.fn(),
  _store: {
    cluster: { name: 'prod-cluster', version: 'v1.28.2' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
  },
}))
const routeRef = reactive(_routeObj)
const storeMock = reactive(_store)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => storeMock }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: storeMock.namespaceList }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '../SideNavBar.vue'

function setMode(scope, path) {
  routeRef.meta.scope = scope
  routeRef.path = path
}

describe('SideNavBar ns-band 两态契约', () => {
  it('集群态:band 挂 ns-band--cluster,ns-enter 存在,只渲染未进入/进入对', () => {
    setMode('global', '/cluster')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const band = w.find('.ns-band')
    expect(band.exists()).toBe(true)
    expect(band.classes()).toContain('ns-band--cluster')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(true)
    expect(band.text()).toContain('命名空间 · 未进入')
    expect(band.text()).toContain('进入命名空间')
    expect(band.text()).not.toContain('当前所在')
    expect(band.text()).not.toContain('回拓扑总览')
  })

  it('ns 态:band 挂 ns-band--ns,ns-enter 不存在,只渲染当前所在/回总览对', () => {
    setMode('namespace', '/ns/default')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const band = w.find('.ns-band')
    expect(band.classes()).toContain('ns-band--ns')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(false)
    expect(band.text()).toContain('命名空间 · 当前所在')
    expect(band.text()).toContain('↩ 回拓扑总览')
    expect(band.text()).not.toContain('未进入')
  })

  it('空态:名称=选择命名空间、无箭头,点 ns-home 开下拉且不跳转', async () => {
    setMode('global', '/cluster')
    storeMock.currentNamespace = null
    pushMock.mockClear()
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const home = w.find('[data-test="ns-home"]')
    expect(home.text()).toContain('选择命名空间')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(false)
    await home.trigger('click')
    expect(pushMock).not.toHaveBeenCalled()
    expect(w.find('.ns-drop').exists()).toBe(true)
    storeMock.currentNamespace = 'default'
  })

  it('瓦片点击开/关下拉,aria-expanded 跟随', async () => {
    setMode('namespace', '/ns/default')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const tile = w.find('.ns-tile')
    expect(tile.attributes('aria-expanded')).toBe('false')
    await tile.trigger('click')
    expect(w.find('.ns-drop').exists()).toBe(true)
    expect(tile.attributes('aria-expanded')).toBe('true')
    await tile.trigger('click')
    expect(w.find('.ns-drop').exists()).toBe(false)
    expect(tile.attributes('aria-expanded')).toBe('false')
  })

  it('下拉行点击 → setNamespace + push NamespaceOverview + 关闭', async () => {
    setMode('namespace', '/ns/default')
    storeMock.namespaceList.splice(0, storeMock.namespaceList.length, { name: 'staging', status: 'Active', pods: 3 })
    storeMock.setNamespace.mockClear()
    pushMock.mockClear()
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    await w.find('.ns-tile').trigger('click')
    const row = w.find('.ns-row')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('staging')
    await row.trigger('click')
    expect(storeMock.setNamespace).toHaveBeenCalledWith('staging')
    expect(pushMock).toHaveBeenCalledWith({ name: 'NamespaceOverview', params: { namespace: 'staging' } })
    expect(w.find('.ns-drop').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试验证全红**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.nsband.test.js`
Expected: 5 个用例 FAIL(`.ns-band` 不存在 / 空态点击跳转了 / `.ns-tile` 不存在等)

- [ ] **Step 3: SideNavBar.vue script 追加 onNsHomeClick**

在 `function goNsRoute(routeKey)` 之前插入:

```js
// ns 主按钮:空态开下拉(不跳转);否则进/回 NamespaceOverview(集群态=进入,ns态=回总览)
function onNsHomeClick() {
  if (!currentNs.value) { showNsDropdown.value = true; return }
  router.push({ name: 'NamespaceOverview', params: { namespace: currentNs.value } })
}
```

- [ ] **Step 4: 替换 template 的 Namespace Selector 区块**

把 `<!-- Namespace Selector -->` 到其闭合 `</div>`(原 223-280 行,即 `px-md pt-md pb-sm` 那个整块)替换为:

```html
    <!-- Namespace Selector:浅坞 band(方案 B,docs/superpowers/specs/2026-08-18-ns-button-dock-style-design.md) -->
    <div class="px-md pt-md pb-sm shrink-0">
      <p class="text-label-caps text-on-surface-variant mb-xs px-sm">NAMESPACE</p>
      <div class="relative">
        <div class="ns-band" :class="isClusterMode ? 'ns-band--cluster' : 'ns-band--ns'">
          <button
            data-test="ns-home"
            class="ns-main"
            :title="!currentNs ? $t('nav.selectNamespace') : (isClusterMode ? $t('nav.enterNamespace') : $t('nav.backToNsOverview'))"
            :aria-label="!currentNs ? $t('nav.selectNamespace') : (isClusterMode ? $t('nav.enterNamespace') : $t('nav.backToNsOverview'))"
            @click="onNsHomeClick"
          >
            <span class="ns-chip">
              <span class="material-symbols-outlined ns-ci ns-ci--folder">folder_open</span>
              <span class="material-symbols-outlined ns-ci ns-ci--hub">hub</span>
            </span>
            <span class="ns-txt">
              <b class="ns-name" :class="{ 'ns-name--empty': !currentNs }">{{ currentNs || $t('nav.selectNamespace') }}</b>
              <span v-if="currentNs" class="ns-sub">
                <template v-if="isClusterMode">
                  <span class="ns-t ns-t--def">{{ $t('nav.nsNotEntered') }}</span>
                  <span class="ns-t ns-t--hov">{{ $t('nav.enterNamespace') }}</span>
                </template>
                <template v-else>
                  <span class="ns-t ns-t--def">{{ $t('nav.nsHere') }}</span>
                  <span class="ns-t ns-t--hov">{{ $t('nav.backToNsOverview') }}</span>
                </template>
              </span>
            </span>
            <span v-if="isClusterMode && currentNs" data-test="ns-enter" aria-hidden="true" class="ns-arr material-symbols-outlined">arrow_forward</span>
          </button>
          <button
            class="ns-tile"
            :title="$t('nav.switchNamespace')"
            :aria-label="$t('nav.switchNamespace')"
            :aria-expanded="showNsDropdown ? 'true' : 'false'"
            @click="showNsDropdown = !showNsDropdown"
          >
            <span class="material-symbols-outlined transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
          </button>
        </div>
        <!-- Dropdown:坞语言化面板 -->
        <div v-if="showNsDropdown" class="ns-drop">
          <div class="p-1.5 border-b border-outline-variant">
            <div class="ns-search">
              <span class="material-symbols-outlined ns-search__ic">search</span>
              <input v-model="nsSearch" :placeholder="$t('nav.filterNamespaces')" />
            </div>
          </div>
          <div class="max-h-56 overflow-y-auto p-1.5">
            <div
              v-for="ns in filteredNamespaces"
              :key="ns.name"
              class="ns-row"
              :class="currentNs === ns.name ? 'ns-row--cur' : ''"
              @click="selectNamespace(ns.name)"
            >
              <span class="w-2 h-2 rounded-full shrink-0" :class="nsStatusColor(ns.status)"></span>
              <span class="ns-row__name">{{ ns.name }}</span>
              <span class="ns-row__pods">{{ ns.pods }} pods</span>
            </div>
            <p v-if="!filteredNamespaces.length" class="text-body-sm text-on-surface-variant text-center py-md">{{ $t('nav.noMatchingNamespaces') }}</p>
          </div>
        </div>
      </div>
    </div>
```

替换后自查:原区块里的 `selectNamespace`/`filteredNamespaces`/`nsStatusColor` 引用全部保留;`showNsDropdown` 点击外关闭 overlay(组件尾部既有)不动。

- [ ] **Step 5: 跑新测试验证全绿**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.nsband.test.js`
Expected: 5 passed

- [ ] **Step 6: 跑全量单测 + 门禁,确认既有零回归**

Run: `npm run test:unit && npm run typecheck && npm run i18n:check`
Expected: 全绿(含未修改的 SideNavBar.test.js / home.test.js;typecheck 顺带验证 .js 语法)

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.nsband.test.js
git commit -m "feat(sidenav): ns 按钮两态契约——band 类/副标签按态对/空态开下拉/瓦片 aria/行点击回归

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 坞语言样式落地 + 全门禁

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(scoped `<style>` 追加 ns-* 块;并入 reduce 分支)

**Interfaces:**
- Consumes: Task 2 的 DOM 契约(`.ns-band`/`.ns-chip`/`.ns-ci--*`/`.ns-sub`/`.ns-t--*`/`.ns-arr`/`.ns-tile`/`.ns-drop`/`.ns-search`/`.ns-row*`)。
- Produces: 最终视觉(设计文档 §3-§6 的全部数值);无下游依赖。

- [ ] **Step 1: 在 scoped style 的停靠坞注释块之前插入 ns 样式块**

插到 `/* ===== 停靠坞:集群 hero + 部署 + 3 图标同块成组 ===== */` 之前:

```css
/* ===== Namespace band:浅坞 + 绿 chip(方案 B,docs/superpowers/specs/2026-08-18) ===== */
.ns-band{display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:18px 9px 9px 14px;
  background:linear-gradient(160deg,#f4f8f5,#e9efeb);border:1px solid #d9e3dc;
  box-shadow:0 5px 14px rgba(0,60,35,.10);
  transition:transform .18s cubic-bezier(.2,.7,.3,1),box-shadow .18s,border-color .18s;cursor:pointer}
.ns-band:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,60,35,.16);border-color:#b3d4c3}
.ns-band:active{transform:translateY(0) scale(.985)}
.ns-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0;border:0;background:none;
  text-align:left;cursor:pointer;font:inherit;color:inherit}
.ns-chip{width:26px;height:26px;border-radius:9px;position:relative;flex:none;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(120deg,#0ba874,#00835b);color:#fff;
  box-shadow:0 3px 10px rgba(0,108,73,.30),inset 0 1px 0 rgba(255,255,255,.26);
  transition:background .3s,box-shadow .3s,border-color .3s}
.ns-band--cluster .ns-chip{background:#fff;border:1px solid #bbcabf;color:#006c49;
  box-shadow:0 3px 8px rgba(0,60,35,.12),inset 0 1px 0 #fff}
/* chip 图标:ns 态 hover folder↔hub(拓扑)交叉淡入;集群态不换 */
.ns-ci{position:absolute;font-size:15px;transition:opacity .18s,transform .18s}
.ns-ci--hub{opacity:0;transform:scale(.6)}
.ns-band--ns .ns-main:hover .ns-ci--folder{opacity:0;transform:scale(.6)}
.ns-band--ns .ns-main:hover .ns-ci--hub{opacity:1;transform:scale(1)}
.ns-txt{flex:1;min-width:0}
.ns-name{display:block;font-size:12px;font-weight:700;color:#0b1c30;line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-name--empty{color:#6c7a71;font-weight:600}
/* 副标签:默认/hover 同一行盒(高13px/行高13px,左上对齐)交叉淡入——严格同位不叠印 */
.ns-sub{position:relative;display:block;height:13px;font-size:9px;white-space:nowrap}
.ns-t{position:absolute;left:0;top:0;line-height:13px;color:#6c7a71;transition:opacity .18s}
.ns-t--hov{color:#006c49;font-weight:700;opacity:0}
.ns-main:hover .ns-t--def{opacity:0}
.ns-main:hover .ns-t--hov{opacity:1}
/* 集群态箭头:入场滑入一次 + 2.4s 缓动轻推循环(坞 LED 同节奏);hover 停循环再滑 3px */
.ns-arr{flex:none;color:#006c49;font-size:15px;margin-left:2px;
  animation:ns-arr-in .25s cubic-bezier(.2,.7,.3,1) backwards,ns-arr-nudge 2.4s .4s ease-in-out infinite}
.ns-main:hover .ns-arr{animation:none;transform:translateX(3px)}
@keyframes ns-arr-in{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:translateX(0)}}
@keyframes ns-arr-nudge{0%,55%,100%{transform:translateX(0)}65%{transform:translateX(2.5px)}78%{transform:translateX(0)}}
/* 下拉入口瓦片:dock-ig__sq 同款 */
.ns-tile{width:28px;height:28px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:#fff;border:1px solid #bbcabf;color:#3c4a42;
  box-shadow:0 3px 8px rgba(0,60,35,.12),inset 0 1px 0 #fff;
  transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .16s,color .16s}
.ns-tile:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(0,60,35,.18);color:#006c49}
.ns-tile:active{transform:translateY(0) scale(.95)}
/* 下拉面板:白底 + 右下小角(呼应坞) + 加深投影;v-if 插入自动播一次入场 */
.ns-drop{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:50;overflow:hidden;
  background:#fff;border:1px solid #d9e3dc;border-radius:12px 12px 12px 5px;
  box-shadow:0 10px 24px rgba(0,60,35,.14);
  animation:ns-drop-in .22s cubic-bezier(.2,.7,.3,1)}
@keyframes ns-drop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.ns-search{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:9px;background:#fff;
  border:1px solid #bbcabf;color:#6c7a71;transition:border-color .15s,box-shadow .15s}
.ns-search:focus-within{border-color:#006c49;box-shadow:0 0 0 2px rgba(0,108,73,.12)}
.ns-search input{flex:1;min-width:0;border:0;outline:0;font-size:12px;font-family:inherit;color:#0b1c30;background:none}
.ns-search input::placeholder{color:#6c7a71}
.ns-search__ic{font-size:14px}
.ns-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;font-size:12.5px;color:#0b1c30;
  cursor:pointer;transition:background .15s}
.ns-row:hover{background:#eaf3ee}
.ns-row--cur{background:#d7e8df;color:#006c49;font-weight:700}
.ns-row__name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-row__pods{margin-left:auto;font-size:10px;color:#6c7a71}
```

- [ ] **Step 2: 并入 prefers-reduced-motion 禁用分支**

在既有 `@media (prefers-reduced-motion: reduce)` 块(停靠坞那条,约文件尾部)的花括号内追加:

```css
  .ns-band,.ns-chip,.ns-ci,.ns-t,.ns-tile,.ns-row,.ns-search{transition:none !important}
  .ns-arr,.ns-drop{animation:none !important}
```

- [ ] **Step 3: 全门禁(含 build 覆盖 .vue 编译)**

Run: `npm run test:unit && npm run typecheck && npm run i18n:check && npm run build`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/SideNavBar.vue
git commit -m "feat(sidenav): ns 按钮坞语言样式——浅坞 band/绿chip/两态hover揭示/箭头轻推/下拉坞化+reduce分支

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 交付后手测清单(需集群环境,不阻塞合并)

1. 集群态:chip 白底绿 folder、名称尾随绿箭头 2.4s 轻推、hover 揭示「进入命名空间」;点击进入 ns。
2. ns 态:chip 绿渐变、hover 图标换 hub + 「↩ 回拓扑总览」;点击回拓扑总览。
3. 两态切换 morph(chip 底色过渡、箭头 keyframes 滑入)。
4. 下拉:搜索 focus 绿环、行 hover/当前行高亮、点外关闭;空态点主按钮直接开下拉。
5. 超长 ns 名 ellipsis 不撑破 band;260px 侧栏与底部坞同屏协调。
6. 系统开启「减少动态效果」后无动画。

## 终审延后项(2026-08-18 整分支终审裁决 Ready to merge,以下 Minor 延后)

1. pods 文案 i18n:`{{ ns.pods }} pods` 硬编码英文(沿自旧代码),后续可加 `nav.podsCount` 键。
2. 下拉行键盘不可达:`.ns-row` 为 div+@click,无 tabindex/role/回车支持(沿自旧代码,a11y follow-up)。
3. hover 揭示未覆盖 `:focus-visible`:键盘用户看不到「进入/回总览」去向提示(a11y follow-up,加并列选择器即可)。
4. `SideNavBar.nsband.test.js` 文件内顺序依赖:空态用例尾部还原 currentNamespace、行点击用例注入的 namespaceList 未清;建议 beforeEach 重置。
5. 卫生:`.ns-band{cursor:pointer}` 冗余(可点击的是子按钮);`.ns-tile` 可补 `type="button"`。
