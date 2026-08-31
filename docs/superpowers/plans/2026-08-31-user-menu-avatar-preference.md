# 用户头像菜单优化（两行触发钮 + 快速偏好切换）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顶栏 `UserMenu` 触发钮两行化（角色移到用户名下方小字），下拉菜单新增主题三态/语言两态快速切换。

**Architecture:** 纯前端单组件改造（`src/components/layout/UserMenu.vue`），直接消费 `usePreferencesStore` 现成 `setTheme`/`setLanguage`（即时生效 + localStorage/服务端双写，零新 API）；测试扩展既有 `UserMenu.test.js`。设计文档：`docs/superpowers/specs/2026-08-31-user-menu-avatar-preference-design.md`。

**Tech Stack:** Vue 3 `<script setup>`（纯 JS）+ Tailwind token + vue-i18n + Pinia + vitest + happy-dom + @vue/test-utils。

## Global Constraints

- **实现必须在 git worktree 分支进行**（用户硬约束）：开工先走 superpowers:using-git-worktrees 建分支（建议名 `feat/user-menu-avatar-preference`），完成后 `--no-ff` 合回 main。
- **零新增外部依赖、零新增 i18n 键**——文案全部复用既有键：`admin.users.roleAdmin`（管理员/Admin）、`admin.users.roleUser`（普通用户/User）、`userCenter.theme`（主题外观/Theme）、`userCenter.language`（界面语言/Language）、`userCenter.themeLight/themeDark/themeSystem`（浅色/深色/跟随系统）、`userCenter.langZh/langEn`（中文/English）。
- **提交作者恒为 `aliangone <aliangone@gmail.com>`（repo config 已设），禁止 `Co-Authored-By: Claude` 尾注。**
- **不改任何既有 `data-testid`**（`user-menu-trigger` / `user-menu-dropdown` / `user-menu-profile` / `user-menu-logout`）、不改菜单开合语义（点击开合 + 外部点击关 + ESC 关）、不动登出 ConfirmDialog 链路。
- 测试环境事实（勿重复踩）：happy-dom 下 `fetch` 对相对 URL 会 reject，被 `persist()` 的 `.catch(() => {})` 离线兜底吸收——**无需 mock `@/api/client`**；`i18n` 是模块级单例、localStorage 跨测试持久，`beforeEach` 必须重置（见 Task 1）。
- 间距/字号 token 实值：`xs=4px sm=8px md=16px`，`body-xs=11px`；菜单宽 `w-60`(240px)。
- 运行单测的命令模式：`npx vitest run src/components/layout/__tests__/UserMenu.test.js`（单文件快跑）；全量 `npm run test:unit`。

---

### Task 1: 触发钮两行化（角色行）

**Files:**
- Modify: `src/components/layout/UserMenu.vue`（script 加 `roleLabel` computed；template 触发钮改两行）
- Test: `src/components/layout/__tests__/UserMenu.test.js`

**Interfaces:**
- Consumes: `useAuthStore` 的 `user.role`（`'admin' | 'user'`，可能缺失）；既有 i18n 键 `admin.users.roleAdmin/roleUser`。
- Produces: 触发钮内新元素 `data-testid="user-menu-role"`（角色小字，`role` 缺失时不渲染）——Task 2 与手测依赖此结构；script 侧新增 `const { t } = useI18n()`（Task 2 不冲突）。

- [ ] **Step 1: 更新测试基建 + 写失败测试**

在 `src/components/layout/__tests__/UserMenu.test.js`：

(a) `beforeEach` 加两行重置（localStorage 与 i18n 单例会跨测试泄漏，`点语言→en` 一旦先跑会污染后续断言中文文案）：

```js
beforeEach(() => {
  setActivePinia(createPinia())
  pushMock.mockClear()
  localStorage.clear()
  i18n.global.locale.value = 'zh'
  document.body.innerHTML = ''
})
```

(b) **删除**现有第 6 例 `test('非 admin 用户不显示 ADMIN 徽章', ...)`（被下面三个新例取代），追加：

```js
test('触发钮两行化:admin 用户名下方显示「管理员」小字,横排 ADMIN 徽章消失', async () => {
  seedUser()
  const w = mountMenu()
  const role = w.find('[data-testid="user-menu-role"]')
  expect(role.exists()).toBe(true)
  expect(role.text()).toBe('管理员')
  expect(w.find('[data-testid="user-menu-trigger"]').text()).not.toContain('ADMIN')
  w.unmount()
})

test('非 admin 用户:角色行显示「普通用户」', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u2', username: 'bob', role: 'user', displayName: '' }
  const w = mountMenu()
  expect(w.find('[data-testid="user-menu-role"]').text()).toBe('普通用户')
  w.unmount()
})

test('role 缺失:角色行隐藏', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u3', username: 'carol', displayName: '' }
  const w = mountMenu()
  expect(w.find('[data-testid="user-menu-role"]').exists()).toBe(false)
  w.unmount()
})
```

（测试默认 locale 为 `'zh'`（`src/i18n.js` initial 兜底），故断言中文文案。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: 三个新例 FAIL——`user-menu-role` 不存在（expected `exists()` true, got false / `text()` 为空）。原有 5 例保持 PASS。

- [ ] **Step 3: 实现**

`src/components/layout/UserMenu.vue` script（`computed` 已在既有 import 里，补 `useI18n`）：

```js
import { useI18n } from 'vue-i18n'
```

`const clusterStore = useClusterStore()` 之后加：

```js
const { t } = useI18n()
// 角色小字(2026-08-31 设计 §3):所有用户都显示本地化角色名;role 缺失返回 '' → 模板 v-if 隐藏
const roleLabel = computed(() => {
  const role = authStore.user?.role
  if (!role) return ''
  return t(role === 'admin' ? 'admin.users.roleAdmin' : 'admin.users.roleUser')
})
```

template 触发钮：删除横排 `ADMIN` 徽章那一行

```html
<span v-if="authStore.isAdmin" class="px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">ADMIN</span>
```

用户名 `<span>` 与箭头 `<span>` 之间改为两行结构（用户名 span 移入列容器）：

```html
<div class="flex flex-col items-start min-w-0 leading-tight">
  <span class="text-body-sm font-semibold max-w-[120px] truncate" :title="displayName">{{ displayName }}</span>
  <span v-if="roleLabel" data-testid="user-menu-role" class="text-[10px] text-on-surface-variant max-w-[120px] truncate">{{ roleLabel }}</span>
</div>
```

（头像 div、箭头 span、`user-menu-trigger` 的 class/aria-label 均不动；文本块高 ~30px < 头像 32px，顶栏高度不变。）

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: 8 例全 PASS（原 5 例 + 新 3 例）。

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/UserMenu.vue src/components/layout/__tests__/UserMenu.test.js
git commit -m "feat(usermenu): 触发钮两行化——角色移用户名下方小字(所有用户本地化角色名),移除横排 ADMIN 徽章"
```

---

### Task 2: 下拉快速切换区（主题三态 + 语言两态）

**Files:**
- Modify: `src/components/layout/UserMenu.vue`（script 加 prefs/选项/归一 computed；template 资料卡后插入切换区）
- Test: `src/components/layout/__tests__/UserMenu.test.js`

**Interfaces:**
- Consumes: `usePreferencesStore`（`src/stores/preferences.js`）的 `theme`/`language` ref 与 `setTheme('light'|'dark'|'system')`、`setLanguage('zh'|'en')`——均现成，勿改 store；Task 1 的 `const { t } = useI18n()`。
- Produces: 下拉内 `data-testid="user-menu-theme-<light|dark|system>"` 与 `data-testid="user-menu-lang-<zh|en>"` 五个按钮；高亮态 class 含 `bg-primary`。

- [ ] **Step 1: 写失败测试**

`UserMenu.test.js` 顶部 import 区补：

```js
import { usePreferencesStore } from '@/stores/preferences'
```

文件末尾追加：

```js
test('下拉含主题三态+语言两态分段;null 未设置时高亮归一为 system/zh', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  for (const v of ['light', 'dark', 'system']) {
    expect(w.find(`[data-testid="user-menu-theme-${v}"]`).exists()).toBe(true)
  }
  for (const v of ['zh', 'en']) {
    expect(w.find(`[data-testid="user-menu-lang-${v}"]`).exists()).toBe(true)
  }
  expect(usePreferencesStore().theme).toBeNull()
  expect(usePreferencesStore().language).toBeNull()
  expect(w.find('[data-testid="user-menu-theme-system"]').classes()).toContain('bg-primary')
  expect(w.find('[data-testid="user-menu-lang-zh"]').classes()).toContain('bg-primary')
  w.unmount()
})

test('点主题「深色」:prefs.theme 即时变 dark 且菜单保持打开', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-theme-dark"]').trigger('click')
  expect(usePreferencesStore().theme).toBe('dark')
  expect(w.find('[data-testid="user-menu-theme-dark"]').classes()).toContain('bg-primary')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(true)
  w.unmount()
})

test('点语言「English」:prefs.language=en 且 i18n locale 同步切 en', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-lang-en"]').trigger('click')
  expect(usePreferencesStore().language).toBe('en')
  expect(i18n.global.locale.value).toBe('en')
  w.unmount()
})
```

（「菜单保持打开」成立原因：下拉在 `rootEl` 内，`onDocClick` 的 `contains` 判真不关；分段按钮也不调 `closeMenu`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: 三个新例 FAIL——五个 `user-menu-theme-*`/`user-menu-lang-*` 按钮不存在。既有 8 例 PASS。

- [ ] **Step 3: 实现**

`UserMenu.vue` script 补 import 与 setup（`computed` 已有）：

```js
import { usePreferencesStore } from '@/stores/preferences'
```

`roleLabel` 之后加：

```js
const prefs = usePreferencesStore()
// 快速切换区选项(2026-08-31 设计 §4):文案/图标与用户中心页同源,零新增 i18n 键
const themeOptions = [
  { v: 'light', icon: 'light_mode', key: 'userCenter.themeLight' },
  { v: 'dark', icon: 'dark_mode', key: 'userCenter.themeDark' },
  { v: 'system', icon: 'contrast', key: 'userCenter.themeSystem' },
]
const langOptions = [
  { v: 'zh', key: 'userCenter.langZh' },
  { v: 'en', key: 'userCenter.langEn' },
]
// null 归一:未设置时如实高亮运行时默认(store 注释 null→system;i18n 默认 zh)
const activeTheme = computed(() => prefs.theme || 'system')
const activeLang = computed(() => prefs.language || 'zh')
```

template：资料卡头（`data-testid="user-menu-dropdown"` 内第一个 `border-b` 的 div）之后、「用户中心」按钮之前插入（「用户中心」与「退出登录」之间原有 `border-t` 分隔线保留不动）：

```html
<div class="px-md py-sm border-b border-outline-variant">
  <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.theme') }}</p>
  <div class="flex gap-xs">
    <button v-for="o in themeOptions" :key="o.v" :data-testid="`user-menu-theme-${o.v}`"
      class="flex items-center gap-xs px-sm py-xs rounded-md border text-body-xs transition-colors"
      :class="activeTheme === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'"
      @click="prefs.setTheme(o.v)">
      <span class="material-symbols-outlined text-sm">{{ o.icon }}</span>{{ $t(o.key) }}
    </button>
  </div>
  <p class="text-body-xs text-on-surface-variant mb-xs mt-sm">{{ $t('userCenter.language') }}</p>
  <div class="flex gap-xs">
    <button v-for="o in langOptions" :key="o.v" :data-testid="`user-menu-lang-${o.v}`"
      class="px-sm py-xs rounded-md border text-body-xs transition-colors"
      :class="activeLang === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'"
      @click="prefs.setLanguage(o.v)">{{ $t(o.key) }}</button>
  </div>
</div>
```

（宽度已算：三主题钮最宽 ~198px ≤ 菜单内宽 208px（240 − 两侧 px-md 16×2），不换行。若真机仍见挤压，把三主题钮 `px-sm` 降 `px-xs` 即可，勿动菜单宽。）

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: 11 例全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/UserMenu.vue src/components/layout/__tests__/UserMenu.test.js
git commit -m "feat(usermenu): 下拉新增快速切换区——主题三态/语言两态分段按钮,null 归一高亮,切换不关菜单"
```

---

### Task 3: 全量门禁 + 合并回 main

**Files:**
- 无新改动；只跑门禁与合并。

**Interfaces:**
- Consumes: Task 1/2 在 worktree 分支上的两个提交。
- Produces: main 上的 `--no-ff` 合并提交。

- [ ] **Step 1: 全量门禁（worktree 内）**

```bash
npm run test:unit        # 前端单测全量(不只 UserMenu——确认无连带破坏)
npm run i18n:check       # 三合一门禁:本特性应零 i18n 变更
npm run typecheck        # node --check 基线
```

Expected: 三条全绿。任何一条红 → 修复后重跑全量再继续（修复属本分支新提交）。

- [ ] **Step 2: 核对分支构成后合并**

先核 `git log --oneline main..HEAD` **只含本特性 2 个提交**（多会话并行防混入），再回主 checkout 合并：

```bash
git -C <主checkout路径> merge --no-ff feat/user-menu-avatar-preference -m "Merge branch 'feat/user-menu-avatar-preference'——用户头像菜单优化:触发钮两行化(角色下移小字)+下拉主题三态/语言两态快速切换"
```

（主 checkout 若有并行脏状态，按 [[multi-session-main-editing]] 惯例先与用户确认或临时 worktree 合并。）

- [ ] **Step 3: 合并树复跑门禁**

主 checkout 上重跑 Step 1 三条命令（**合并树 ≠ 分支树，必须重跑**——并行 main 推进的既有教训）。全绿后向用户报告：手测清单如下，需真浏览器——
① 触发钮两行形态（用户名 + 角色小字随语言切换 管理员/Admin、普通用户/User）；
② 主题三态即时切换：浅色/深色立即翻转全站、「跟随系统」恢复系统偏好；
③ 语言两态：中/EN 全站即时生效，刷新页面后保持（服务端双写生效）；
④ 原有能力回归：菜单开合/ESC/外部点击关闭、「用户中心」跳转、登出二次确认。

---

## Self-Review 结论

- **Spec 覆盖**：spec §3（两行化）→ Task 1；§4（切换区）→ Task 2；§5/§6（数据流/边界）→ 两 Task 的 null 归一与 role 兜底；§7（测试计划 4 条）→ Task 1 三例（第 1 条含改写原第 6 例）+ Task 2 三例（第 2/3/4 条）；§8 验收 → Task 3。无缺口。
- **占位符**：无 TBD/「适当处理」类步骤；所有代码步骤给全文。
- **类型/命名一致性**：`roleLabel`/`themeOptions`/`langOptions`/`activeTheme`/`activeLang`/testid 前缀 `user-menu-theme-`/`user-menu-lang-` 在测试与实现两处拼写一致（已逐一核对）。
