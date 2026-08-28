# 工作台顶栏品牌胶囊入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TopNavBar 右侧的灰色 icon-only 工作台按钮升级为带文字的品牌描边胶囊（方案 C3），置于右侧区第一位（刷新之前），`/workbench*` 路由激活态。

**Architecture:** 单组件改动（`src/components/layout/TopNavBar.vue`）+ 一个新 vitest 测试文件。无路由/i18n/依赖改动。TDD：先写测试（确认失败）→ 改组件（通过）→ 全量门禁 → 单次提交。

**Tech Stack:** Vue 3 `<script setup>` SFC、Tailwind（Material token）、vitest 4 + @vue/test-utils + happy-dom。

**Spec:** `docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md`（commit `cbe1cbf`）

## Global Constraints

- 提交作者恒为 `aliangone <aliangone@gmail.com>`；**禁止** `Co-Authored-By: Claude` 尾注（CLAUDE.md 明文）。
- 禁止改写已推送历史 / force push；本计划所有提交只落在新分支 `feat/workbench-pill-entry` 上。
- 不新增任何外部依赖（仓库依赖政策）。
- 样式只用现有 Tailwind/Material token（`primary` / `primary-container` / `on-primary-container` 系），**不硬编码色值**（TopNavBar 现有按钮全 token 化，跟随主题）。
- **不新增任何动画**（reduced-motion 政策天然满足）；仅沿用 `transition-colors` hover 反馈。
- i18n 零改动：只用既有键 `nav.workbench`（zh「工作台」zh.json:460 / en「Workbench」均已存在）；不用旧键 `workbench.shell.title`。
- 测试 mock 风格仿 `src/components/layout/__tests__/TopNavBar.dedup.test.js`；可变路由状态用 `vi.hoisted`（vitest 4，仓库已有先例如 `SideNavBar.test.js`）。
- 所有命令在 worktree 目录内执行；worktree 的 node_modules 向上解析到主仓（既有工作流，70+ 先例）。

---

### Task 1: 创建隔离 worktree 并验证基线

**Files:**
- 无代码文件改动；只创建工作区并验证工具链基线。

**Interfaces:**
- Consumes: main 分支 HEAD（含 spec 提交 `cbe1cbf`）。
- Produces: 分支 `feat/workbench-pill-entry` 的隔离 worktree（路径 `.claude/worktrees/wb-pill-entry`），Task 2 全部在其中进行。

- [ ] **Step 1: 用 worktree 技能创建隔离工作区**

REQUIRED SUB-SKILL: superpowers:using-git-worktrees，分支名 `feat/workbench-pill-entry`。

技能不可用时的等价回退命令（仓库既有约定路径，`.claude/` 已 gitignore）：

```bash
cd /home/liang/MyProgram/AiProject/aliangboard
git worktree add .claude/worktrees/wb-pill-entry -b feat/workbench-pill-entry
cd .claude/worktrees/wb-pill-entry
```

- [ ] **Step 2: 验证分支与基点**

Run: `git branch --show-current && git log --oneline -1`
Expected: 第一行 `feat/workbench-pill-entry`；第二行含 `cbe1cbf`（spec 提交）。

- [ ] **Step 3: 验证改动前工具链基线（防止把既有红当成自己引入的）**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js`
Expected: 两个文件全部 PASS（溢出收缩链 2 例 + 去重 3 例）。若此处已红，先停下排查环境，不得继续 Task 2。

---

### Task 2: TDD 实现工作台品牌胶囊

**Files:**
- Create: `src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`
- Modify: `src/components/layout/TopNavBar.vue`（script 第 3 行 import、第 10 行附近加 route/computed；template 第 270-275 行按钮区）

**Interfaces:**
- Consumes: 既有 i18n 键 `nav.workbench`；既有路由 `/workbench`（name `Workbench`）；TopNavBar 现有 `router`/`refreshPage`。
- Produces: header 内 `aria-label="nav.workbench"` 的胶囊按钮——`router.push('/workbench')`、`/workbench*` 前缀时含 `bg-primary-container` 激活类。无其它消费方（终端 UI 改动）。

- [ ] **Step 1: 写失败测试**

创建 `src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`，内容如下（完整文件）：

```js
// src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
// 工作台入口品牌胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md):
// 有文字标签(非 icon-only)、右区第一位(刷新之前)、点击直达 /workbench、/workbench* 前缀激活态。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

// 可变路由状态:vi.hoisted 保证 vi.mock 工厂引用时不踩 TDZ(工厂懒执行于模块 import 期)
const state = vi.hoisted(() => ({
  path: '/cluster',
  pushSpy: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: state.path, params: {}, name: '' }),
  useRouter: () => ({ push: state.pushSpy }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'test',
    cluster: { name: 'test', apiServer: 'https://x', version: 'v1' },
    clusterList: [],
    clusterHealth: { severity: 'ok', reasons: [] },
    currentNamespace: '',
    namespaceList: [],
    getCurrentCluster: () => ({ name: 'test' }),
    setNamespace: vi.fn(),
    switchCluster: vi.fn(),
    stopPodWatch: vi.fn(),
    stopEventWatch: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { username: 'tester' }, isAdmin: false, logout: vi.fn() }),
}))
vi.mock('@/composables/usePageRefresh', () => ({
  usePageRefresh: () => ({ bump: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/api/client', () => ({ api: {}, clearSession: vi.fn(), getSession: () => false }))

import TopNavBar from '../TopNavBar.vue'

const mountIt = () => mount(TopNavBar, { global: { mocks: { $t: (k) => k } } })
const findPill = (w) =>
  w.findAll('header button').find(b => b.attributes('aria-label') === 'nav.workbench')

describe('TopNavBar 工作台品牌胶囊', () => {
  beforeEach(() => {
    state.path = '/cluster'
    state.pushSpy.mockClear()
  })

  it('胶囊存在且有文字标签(非 icon-only)', () => {
    const w = mountIt()
    const pill = findPill(w)
    expect(pill).toBeTruthy()
    expect(pill.text()).toContain('nav.workbench')
    expect(pill.find('.material-symbols-outlined').text()).toBe('workspaces')
  })

  it('位于刷新按钮之前(右区第一位)', () => {
    const w = mountIt()
    const buttons = w.findAll('header button')
    const pillIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.workbench')
    const refreshIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.refreshPage')
    expect(pillIdx).toBeGreaterThan(-1)
    expect(refreshIdx).toBeGreaterThan(-1)
    expect(pillIdx).toBeLessThan(refreshIdx)
  })

  it('点击直达 /workbench', async () => {
    const w = mountIt()
    await findPill(w).trigger('click')
    expect(state.pushSpy).toHaveBeenCalledWith('/workbench')
  })

  it('非工作台路由:描边浅底默认态,无激活填充', () => {
    state.path = '/cluster'
    const w = mountIt()
    const pill = findPill(w)
    expect(pill.classes()).toContain('border-primary/40')
    expect(pill.classes()).not.toContain('bg-primary-container')
  })

  it('工作台路由(含项目详情子路径):激活态填充', () => {
    state.path = '/workbench/p1'
    const w = mountIt()
    const pill = findPill(w)
    expect(pill.classes()).toContain('bg-primary-container')
    expect(pill.classes()).toContain('border-primary')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`
Expected: **FAIL**，5 例全红——`findPill` 找不到（现按钮 aria-label 是 `workbench.shell.title` 而非 `nav.workbench`），`expect(pill).toBeTruthy()` 失败。若出现的是 import/编译错误而非断言失败，先修测试自身。

- [ ] **Step 3: 改 TopNavBar.vue——script 部分**

3a. 第 3 行，引入 `useRoute`：

```js
// 旧:
import { useRouter } from 'vue-router'
// 新:
import { useRoute, useRouter } from 'vue-router'
```

3b. 第 10 行 `const router = useRouter()` 之后紧跟加两行（`computed` 已在第 2 行 import，勿重复）：

```js
const route = useRoute()
// 工作台胶囊激活态:/workbench 前缀覆盖 shell、台账、项目详情
// (docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md)
const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))
```

- [ ] **Step 4: 改 TopNavBar.vue——template 部分**

右侧区当前为「刷新按钮 → 工作台图标按钮」两块相连（约 270-275 行）。用一次替换实现「胶囊在前、刷新在后、删旧按钮」——old_string 为连续 6 行：

```html
      <button @click="refreshPage" :disabled="refreshing" :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')" class="p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50">
        <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
      </button>
      <button @click="router.push('/workbench')" :aria-label="$t('workbench.shell.title')" :title="$t('workbench.shell.title')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">workspaces</span>
      </button>
```

new_string 为：

```html
      <!-- 工作台入口:品牌描边胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md)
           ——导航级入口排工具按钮前;shrink-0 使溢出压力全部由左侧搜索收缩链吸收(issue #3 契约) -->
      <button
        @click="router.push('/workbench')"
        :aria-label="$t('nav.workbench')"
        :title="$t('nav.workbench')"
        class="flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold shrink-0"
        :class="isWorkbenchActive
          ? 'border-primary bg-primary-container text-on-primary-container'
          : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10'"
      >
        <span class="material-symbols-outlined text-lg">workspaces</span>
        {{ $t('nav.workbench') }}
      </button>
      <button @click="refreshPage" :disabled="refreshing" :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')" class="p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50">
        <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
      </button>
```

（刷新按钮原样保留，仅位置移到胶囊之后；旧 icon-only 工作台按钮被删除。）

- [ ] **Step 5: 跑新测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`
Expected: PASS，5/5。

- [ ] **Step 6: 全量门禁（回归门槛）**

Run（worktree 内依次执行）:
```bash
npm run test:unit     # 全部单测绿,含 TopNavBar.test.js(溢出收缩链)与 TopNavBar.dedup.test.js(去重原则)
npm run typecheck     # node --check 基线
npm run build         # vite 构建,.vue 编译覆盖
```
Expected: 三条全绿。特别关注 `TopNavBar.test.js` 的两条收缩链断言（搜索框 `min-w-0`、集群/ns 包裹层 `shrink-0`）——本次改动只在右侧区，不应触碰它们；若红，说明误改了左侧结构，回查 Step 4。

- [ ] **Step 7: 提交**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
git commit -m "feat(ui): 工作台入口升级品牌胶囊——右区第一位/描边浅底三态/workbench 前缀激活"
```

（禁止 Co-Authored-By 尾注；作者为仓库配置的 aliangone。）

- [ ] **Step 8: 人工视觉验收（可选但建议）**

在 worktree 内 `npm run dev` + `npm run server` 起本地环境，浏览器确认：默认态描边浅底、hover 加深、进入工作台后填充激活、返回后复原。完成后停掉进程。

---

## 完成后

- 分支合并方式（merge / PR / 留在本地）由 superpowers:finishing-a-development-branch 流程与用户确认；**禁止**未经确认 push。
- 范围外护栏（spec §6）：侧边栏、底部 dock、ChatPresence、WorkbenchShell 内部、移动端响应式——若发现自己在改这些文件，说明跑偏了，停。
