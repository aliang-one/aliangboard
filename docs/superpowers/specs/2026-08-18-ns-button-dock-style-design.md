# 侧边栏 Namespace 按钮 · 停靠坞风格重设计(方案 B)

- 日期:2026-08-18
- 状态:已与用户经可视化 brainstorm 交互定稿(方向 B + 两态交互细化 v3)
- 影响文件:`src/components/layout/SideNavBar.vue`、`src/locales/zh.json`、`src/locales/en.json`、`src/components/layout/__tests__/`(新增/微调)

## 1. 背景与目标

侧边栏底部停靠坞(v3 终稿,78px 单板块:集群 hero slab + 部署宽条 + 3 瓦片)已形成一套设计语言:浅绿渐变坞体、不规则圆角、分层投影、白色小瓦片、缓动编排。而**顶部 Namespace 选择器**仍是朴素输入框样式(细边框 + 常规圆角),与坞完全脱节;且两态点击行为不同却无任何提示:

- 集群态(未进入 ns):点击主按钮 = **进入该 ns**
- ns 态(已在 ns):点击主按钮 = **回 NamespaceOverview 拓扑总览**

用户不知道点了会去哪。本次重设计解决:①样式并入坞语言;②两态各自的「可点击 + 去向」提示。

## 2. 现状与约束

现状(`SideNavBar.vue:223-280`):`NAMESPACE` caps 标签 + 分段按钮(左:folder 图标 + (集群态)arrow_forward + ns 名;右:expand_more 开下拉)。下拉含搜索 + 列表(状态点 + pods 数)。

**硬约束**:

1. 测试契约(必须保持):`data-test="ns-home"`(点击 → push NamespaceOverview)、`data-test="ns-enter"` 仅集群态存在(`SideNavBar.test.js:129`)、`data-test="cluster-anchor"`(不受影响)。
2. i18n 门禁:`npm run i18n:check`(残留中文 + 键对齐 + 引用键缺失)。现块内有硬编码英文 `'Select Namespace'` / `'Filter namespaces...'` / `'No matching namespaces'`,本次一并 i18n 化。
3. 动效政策:所有动效必须带 `prefers-reduced-motion: reduce` 禁用分支(坞块既有先例)。
4. 应用无暗色模式;坞块使用字面量色值,ns 块沿用同法(不引入共享 CSS 变量,避免动坞块引回归)。
5. 字号用任意值 px(坞块先例 `text-[11px]/text-[8px]`),勿用不存在的 token(幽灵 text-xxx 静默 no-op 教训)。

## 3. 设计总览(方案 B:浅坞 + 绿 chip)

按钮本身成为一座**迷你坞**:

```
┌──────────────────────────────────────────┐
│ [chip 26px] ns-name        [tile 28px ▾] │   ← 浅绿渐变坞体,18/9/9/14 不规则圆角
│             └ 副标签(两态配对)          │
└──────────────────────────────────────────┘
```

- **坞体**:浅绿渐变 `linear-gradient(160deg,#f4f8f5,#e9efeb)`、边框 `#d9e3dc`、投影 `0 5px 14px rgba(0,60,35,.10)`、圆角 `18px 9px 9px 14px`。
- **chip**(26px,r9):ns 态 = 绿渐变 `#0ba874→#00835b` + 内高光;集群态/空态 = 白底 + `#bbcabf` 边 + 绿色 folder 图标。底色随态 morph(transition .3s)。
- **主按钮**(flex-1):chip + 名称(`text-[12px]` 粗体 `#0b1c30`)+ 副标签(9px,高/行高 13px 行盒)。
- **瓦片**(28px,r10):白底 `#bbcabf` 边,即 dock 瓦片同款;两态恒为**下拉入口**(位置/动作不变);hover 上浮 -2px 转绿。

## 4. 两态交互装置(核心:「默认灰字陈述状态,hover 动作绿揭示去向」)

| | 集群态 | ns 态 |
|---|---|---|
| chip | 白底绿 folder | 绿渐变白 folder |
| 副标签默认 | 灰 `命名空间 · 未进入` | 灰 `命名空间 · 当前所在` |
| 副标签 hover | 动作绿 `进入命名空间` | 动作绿 `↩ 回拓扑总览` |
| 常态附加信号 | 名称尾随绿色 `arrow_forward`(data-test=ns-enter)+ 2.4s 缓动轻推循环(0/55/100% 停,65% 滑 2.5px,78% 回) | — |
| hover 附加 | 箭头停动画再滑 3px;chip 图标**不**换 | chip 图标 folder↔hub(拓扑)交叉淡入(.18s,scale .6↔1) |
| 公共 hover | 坞体上浮 1px、投影加深 `0 8px 20px rgba(0,60,35,.16)`、边框转 `#b3d4c3` | 同左 |
| 按下 | `translateY(0) scale(.985)` | 同左 |
| title/aria | `进入命名空间` | `回到命名空间拓扑总览` |
| 主按钮点击 | push `NamespaceOverview`(进入 ns) | push `NamespaceOverview`(回总览) |

**副标签重叠防线**(demo v3 踩坑):默认/hover 两版文案均绝对定位于**同一行盒**(容器高 13px、行高 13px、左上对齐);两态各含 def/hov 两条 span 做 opacity 交叉淡入;**按态 `v-if` 只渲染当前态那一对**(DOM 级防叠印,比 CSS 显隐更强)——交叉淡入严格同位,不会上下重叠。

**两态切换 morph**:chip 底色/投影 transition .3s;箭头入场用 CSS keyframes 滑入(v-if 新插入自动播一次,坞块同法;不引入 Vue `<Transition>`,规避测试环境下离场时序脆弱),离场随 v-if 瞬时卸载。

## 5. 空态(无 ns 选中,首装/清库后)

- 名称显示灰字 `$t('nav.selectNamespace')`(选择命名空间),无副标签、无箭头;chip 白底。
- **主按钮点击直接展开下拉**(不跳转)——行为变化,须新增测试。

## 6. 下拉面板(坞语言化)

- 容器:白底、`#d9e3dc` 边、圆角 `12px 12px 12px 5px`(右下小角呼应坞的不规则感)、投影 `0 10px 24px rgba(0,60,35,.14)`;入场 `<Transition name="ns-drop">`(opacity + translateY(-4px),.22s)。
- 搜索框:瓦片化——白底 `#bbcabf` 边 r9,`focus-within` 绿描边 + 柔光环 `0 0 0 2px rgba(0,108,73,.12)`。
- 行(r9):状态点保留(沿用 `nsStatusColor`);hover 浅绿 `#eaf3ee`;当前 ns 行 `#d7e8df` + `#006c49` 粗体(dock 热态 `dock-ig--hot` 同款);pods 数右对齐灰字。
- 点击外部关闭(既有 overlay 行为不变)。

## 7. i18n 新增键(zh / en)

| 键 | zh | en |
|---|---|---|
| `nav.selectNamespace` | 选择命名空间 | Select namespace |
| `nav.nsHere` | 命名空间 · 当前所在 | Namespace · current |
| `nav.nsNotEntered` | 命名空间 · 未进入 | Namespace · not entered |
| `nav.enterNamespace` | 进入命名空间 | Enter namespace |
| `nav.backToNsOverview` | ↩ 回拓扑总览 | ↩ Topology overview |
| `nav.switchNamespace` | 切换命名空间 | Switch namespace |
| `nav.filterNamespaces` | 筛选命名空间… | Filter namespaces… |
| `nav.noMatchingNamespaces` | 没有匹配的命名空间 | No matching namespaces |

`NAMESPACE` caps 标签保留字面量(K8s 术语,双语同形,与 PriorityClasses 等英文 label 先例一致)。文案不含 `@`,无需转义;不含 HTML,不用 v-html。

## 8. 结构与实现要点

模板(替换 223-280 的 selector 区,外层保留 `px-md pt-md pb-sm` 与 `relative` 锚):

```
<div class="ns-band" :class="isClusterMode ? 'ns-band--cluster' : 'ns-band--ns'">
  <button data-test="ns-home" class="ns-main" :title="bandTitle" :aria-label="bandTitle" @click="onNsHomeClick">
    <span class="ns-chip">
      <span class="material-symbols-outlined ns-ci ns-ci--folder">folder_open</span>
      <span class="material-symbols-outlined ns-ci ns-ci--hub">hub</span>
    </span>
    <span class="ns-txt">
      <b class="ns-name">{{ currentNs || $t('nav.selectNamespace') }}</b>
      <span v-if="currentNs" class="ns-sub">…四条按态配对的 ns-t…</span>
    </span>
    <span v-if="isClusterMode && currentNs" data-test="ns-enter" aria-hidden="true" class="ns-arr material-symbols-outlined">arrow_forward</span>
  </button>
  <button class="ns-tile" :title="$t('nav.switchNamespace')" :aria-expanded="showNsDropdown ? 'true' : 'false'" @click="showNsDropdown = !showNsDropdown">
    <span class="material-symbols-outlined transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
  </button>
</div>
<div v-if="showNsDropdown" class="ns-drop"> …下拉(结构同现状,类名换 ns-*)… </div>
```

脚本新增(标题不进 script:`home.test` 只 mock `$t` 不装 i18n 插件,引入 `useI18n()` 会破既有测试,故 title/aria 用模板内三元):

```js
function onNsHomeClick() {
  if (!currentNs.value) { showNsDropdown.value = true; return }   // 空态:开下拉不跳转
  router.push({ name: 'NamespaceOverview', params: { namespace: currentNs.value } })
}
```

样式:scoped `<style>` 内新增 `/* ===== Namespace band:浅坞 + 绿 chip ===== */` 块(值如上,集中在单块带注释);`prefers-reduced-motion` 分支并入现有 reduce 块(禁:箭头轻推、图标淡入、副标签淡入、坞体/瓦片 transition、ns-drop/ns-arr 过渡)。

## 9. 测试计划

新增 `src/components/layout/__tests__/SideNavBar.nsband.test.js`(挂载方式沿用现有:mock cluster/auth/useK8sQuery/vue-router,`$t: k => k`):

1. ns 态:点 `ns-home` → push `NamespaceOverview` 已由既有 `SideNavBar.home.test.js` 覆盖,不重复。
2. 集群态:`ns-band--cluster` 类存在 + 副标签渲染 `nav.nsNotEntered`/`nav.enterNamespace` 对;`ns-enter` 存在。
3. ns 态:`ns-band--ns` 类存在 + 副标签渲染 `nav.nsHere`/`nav.backToNsOverview` 对;`ns-enter` 不存在。(类契约即重叠防线回归:两对文案只能按态出现)
4. 空态(currentNamespace null):`ns-home` 点击 → 不 push、下拉出现;名称显示 `nav.selectNamespace`。
5. 瓦片点击 → 下拉开/关;`aria-expanded` 随之变化。
6. 下拉行点击 → `setNamespace` + push + 下拉关闭(既有行为,补测)。

既有测试预期**零修改**(ns-home/ns-enter 契约保持)。已核验:`SideNavBar.test.js` 的 store mock 带 `currentNamespace: 'default'`,故 `ns-enter` 收紧为 `v-if="isClusterMode && currentNs"` 后,集群态断言仍通过。该文件挂真实 i18n 插件,新键须先落 zh/en 再跑测。

## 10. 验收标准

- `npm run test:unit`、`npm run typecheck`、`npm run i18n:check` 全绿。
- 手测清单(需集群环境,交付时列出):
  1. 集群态视觉(chip 白/箭头轻推/hover 揭示「进入命名空间」)与点击进入 ns;
  2. ns 态视觉(chip 绿渐变/hover 图标换 hub + 「↩ 回拓扑总览」)与点击回总览;
  3. 两态切换 morph(chip 底色过渡、箭头 keyframes 滑入/瞬时卸载);
  4. 下拉:搜索/选中行高亮/点外关闭;空态点击开下拉;
  5. 超长 ns 名截断(ellipsis)不撑破 band;
  6. `prefers-reduced-motion` 下动效全禁;
  7. 与底部坞同屏协调(260px 侧栏)。

## 11. 范围外

- nav 区 `NAMESPACE: xxx` 分组标题行、暗色模式、坞本体(v3)改动、ns 态 LED(刻意不加:LED 属集群 slab 的层级信号)。
