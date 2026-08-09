# 顶栏去重：设置/通知下沉到侧边栏底部 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除顶栏与侧边栏重复的「通知/活动记录」和「设置」图标，把活动记录入口并入侧边栏底部，审计日志最终只在一处出现，并腾出顶栏空间。

**Architecture:** 纯展示层调整，无数据/路由逻辑变更。三处改动：(1) `SideNavBar.vue` 把审计日志从「集群管理」分组移除、在底部新增「活动记录」入口（含 active 高亮）、分组标题改名；(2) `TopNavBar.vue` 删除通知+设置两个图标按钮；(3) 清理 i18n 中去重后未用的键。

**Tech Stack:** Vue 3 (SFC) + Vite + Pinia + vue-router；vitest + @vue/test-utils + happy-dom（前端单测）；自研 `scripts/i18n-check.mjs`（残存中文 / zh-en 键对齐 / 引用键缺失三合一门禁）。

## Global Constraints

- **分支**：当前在 `main`；实现前必须切到新分支 `feat/topbar-dedup-settings-notifications`，全程勿直接提交 `main`。每次提交前 `git branch --show-current` 自检。
- **i18n**：组件内不得出现裸用户可见中文（`npm run i18n:check` 残存中文门禁会失败）；新增/改名键必须在 `src/locales/en.json` 与 `src/locales/zh.json` 两边同步，保持键对齐；被 `$t()` 引用的键必须在 locale 中存在（否则「引用键缺失」门禁失败）。
- **类型/语法基线**：`npm run typecheck`（`node --check` 全 .js/.mjs）+ `npm run build`（覆盖 .vue 编译）须通过。`.vue` 改动靠 build 校验。
- **依赖**：本任务不新增任何外部依赖。
- **提交信息**：末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **TDD**：每个有逻辑/结构语义的任务先写失败测试，再实现，再跑绿。

## File Structure

| 文件 | 职责 | 本任务动作 |
|---|---|---|
| `src/components/layout/SideNavBar.vue` | 左侧导航 + 底部工具区 | 改：移除分组 Audit Logs、底部加活动记录入口、active 高亮、子标题改名 |
| `src/components/layout/TopNavBar.vue` | 顶栏（搜索/集群/ns 切换 + 右侧动作） | 改：删除通知+设置两个图标按钮 |
| `src/locales/en.json` / `src/locales/zh.json` | i18n 文案 | 改：新增 `nav.multiCluster`；删除未用的 `nav.auditLogs`、`nav.auditAndMultiCluster` |
| `src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js` | SideNavBar 去重/active 回归 | 新建 |
| `src/components/layout/__tests__/TopNavBar.dedup.test.js` | TopNavBar 去重回归 | 新建 |

---

## Task 1: SideNavBar — 审计日志下沉到底部 + active 高亮 + 分组改名

**Files:**
- Modify: `src/components/layout/SideNavBar.vue:41`（移除分组项）、`:309`（子标题改名）、`:346-349`（底部 Settings `<a>` 替换为 Activity+Settings）
- Modify: `src/locales/en.json`、`src/locales/zh.json`（新增 `nav.multiCluster`）
- Test: `src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js`（新建）

**Interfaces:**
- Consumes: `isGlobalActive(path)`（SideNavBar 已定义，行 ~138，对 `/audit-logs`、`/settings` 走精确匹配）；i18n 键 `nav.activityLog`（已存在）、`nav.multiCluster`（本任务新增）。
- Produces: 底部常驻一个 `data-test="bottom-activity"` 链接（click → `/audit-logs`，含 active `:class` 绑定）；分组 `clusterOtherNav` 仅剩 Clusters。

- [ ] **Step 1: 切分支**

```bash
git branch --show-current   # 确认当前分支(应非 main；若在 main 执行下行)
git checkout -b feat/topbar-dedup-settings-notifications
```

- [ ] **Step 2: 写失败测试 `src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js`**

```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 回归:审计日志入口从「集群管理分组」迁到底部「活动记录」,且只此一处。
const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))
let currentPath = '/cluster'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: '', // 不选 ns:底部仅常驻项;集群管理分组自动展开(v-show="clusterNavOpen || !currentNs")
    namespaceList: [],
    cluster: { name: 'test', version: 'v1' },
    setNamespace: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: currentPath, params: {}, name: '' }),
  useRouter: () => ({ push: pushSpy }),
}))

import SideNavBar from '../SideNavBar.vue'

const mountIt = () => mount(SideNavBar, { global: { mocks: { $t: (k) => k } } })

describe('SideNavBar 审计日志去重 + 底部 active 高亮', () => {
  it('底部存在「活动记录」入口,点击 → /audit-logs', async () => {
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    await activity.trigger('click')
    expect(pushSpy).toHaveBeenCalledWith('/audit-logs')
  })

  it('集群管理分组不再渲染 Audit Logs', () => {
    const w = mountIt()
    const auditEntries = w.findAll('a').filter(a => a.text().includes('nav.auditLogs'))
    expect(auditEntries).toHaveLength(0)
  })

  it('位于 /audit-logs 时活动记录项高亮', () => {
    currentPath = '/audit-logs'
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    expect(activity.classes()).toContain('bg-primary-container')
  })

  it('位于其它页时活动记录项不高亮', () => {
    currentPath = '/cluster'
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    expect(activity.classes()).not.toContain('bg-primary-container')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js`
Expected: 前 3 个用例 FAIL（`bottom-activity` 不存在 → push 未调用 / `.classes()` 无 active 类）；「其它页不高亮」可能 vacuously 通过。

- [ ] **Step 4: 移除分组里的 Audit Logs（`SideNavBar.vue:40-43`）**

把：
```js
const clusterOtherNav = [
  { icon: 'history', labelKey: 'nav.auditLogs', route: '/audit-logs' },
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
```
改为：
```js
const clusterOtherNav = [
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
```

- [ ] **Step 5: 分组子标题改名（`SideNavBar.vue:309`）**

把：
```html
          <p class="text-xs text-on-surface-variant opacity-50 px-md pt-sm pb-xs">{{ $t('nav.auditAndMultiCluster') }}</p>
```
改为：
```html
          <p class="text-xs text-on-surface-variant opacity-50 px-md pt-sm pb-xs">{{ $t('nav.multiCluster') }}</p>
```

- [ ] **Step 6: 新增 i18n 键 `nav.multiCluster`**

`src/locales/en.json`，把：
```json
    "auditAndMultiCluster": "Audit / Multi-Cluster",
```
改为：
```json
    "auditAndMultiCluster": "Audit / Multi-Cluster",
    "multiCluster": "Multi-Cluster",
```

`src/locales/zh.json`，把：
```json
    "auditAndMultiCluster": "审计 / 多集群",
```
改为：
```json
    "auditAndMultiCluster": "审计 / 多集群",
    "multiCluster": "多集群",
```

> 注：本步只新增 `multiCluster`，暂不删 `auditAndMultiCluster`（其引用已在 Step 5 移除，但键留着不报错；Task 3 统一清理）。`nav.auditLogs` 键同理暂留（引用已在 Step 4 移除）。

- [ ] **Step 7: 底部新增「活动记录」入口 + 给 Settings 加 active 高亮（`SideNavBar.vue:346-349`）**

把现有 Settings `<a>`：
```html
      <a @click="router.push('/settings')" class="flex items-center gap-md text-on-surface-variant hover:bg-surface-container rounded-lg px-md py-sm transition-all duration-200 cursor-pointer">
        <span class="material-symbols-outlined text-lg">tune</span>
        <span class="text-body-sm">{{ $t('nav.settings') }}</span>
      </a>
```
替换为（Activity 在上、Settings 在下，两者均带 active `:class`，沿用主导航 active 配色）：
```html
      <a data-test="bottom-activity" @click="router.push('/audit-logs')"
        class="flex items-center gap-md rounded-lg px-md py-sm transition-all duration-200 cursor-pointer"
        :class="isGlobalActive('/audit-logs') ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
        <span class="material-symbols-outlined text-lg">notifications</span>
        <span class="text-body-sm">{{ $t('nav.activityLog') }}</span>
      </a>
      <a data-test="bottom-settings" @click="router.push('/settings')"
        class="flex items-center gap-md rounded-lg px-md py-sm transition-all duration-200 cursor-pointer"
        :class="isGlobalActive('/settings') ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
        <span class="material-symbols-outlined text-lg">tune</span>
        <span class="text-body-sm">{{ $t('nav.settings') }}</span>
      </a>
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js`
Expected: 4 个用例全 PASS。

- [ ] **Step 9: i18n + 类型/构建门禁**

Run:
```bash
npm run i18n:check    # 残存中文=0、键对齐✓、引用键缺失=0(含新 nav.multiCluster)
npm run typecheck     # node --check 全 .js/.mjs
npm run build         # 覆盖 .vue 编译
```
Expected: 全部通过（`auditAndMultiCluster`/`auditLogs` 此时为未用键，门禁不报）。

- [ ] **Step 10: 提交**

```bash
git branch --show-current   # 确认在 feat/topbar-dedup-settings-notifications
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js src/locales/en.json src/locales/zh.json
git commit -m "$(cat <<'EOF'
feat(sidenav): 审计日志入口下沉到底部+移除分组重复项+active高亮

- 底部新增「活动记录」入口(notifications→/audit-logs),与 Settings 并列
- 底部 Activity/Settings 加 active 高亮(isGlobalActive)
- 集群管理分组移除 Audit Logs(与底部去重),子标题改名 multiCluster
- 新增 i18n nav.multiCluster(en/zh)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TopNavBar — 删除通知 + 设置图标按钮

**Files:**
- Modify: `src/components/layout/TopNavBar.vue:271-276`（删除两个 `<button>`）
- Test: `src/components/layout/__tests__/TopNavBar.dedup.test.js`（新建）

**Interfaces:**
- Consumes: 无新增依赖；沿用现有 store/router/composable（测试中以 vi.mock 桩化）。
- Produces: 顶栏右侧仅剩刷新按钮 + 分隔线 + 用户/登出。

- [ ] **Step 1: 写失败测试 `src/components/layout/__tests__/TopNavBar.dedup.test.js`**

```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 回归:顶栏去重,仅保留刷新;通知/设置图标移除(与侧边栏重复)。
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    remoteMode: false,
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
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/cluster', params: {}, name: '' }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/composables/usePageRefresh', () => ({
  usePageRefresh: () => ({ bump: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/api/client', () => ({ api: {}, clearSession: vi.fn() }))

import TopNavBar from '../TopNavBar.vue'

const mountIt = () => mount(TopNavBar, { global: { mocks: { $t: (k) => k } } })

describe('TopNavBar 去重:仅留刷新', () => {
  it('已移除通知(活动记录)图标按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.activityLog"]').exists()).toBe(false)
  })

  it('已移除设置图标按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.settings"]').exists()).toBe(false)
  })

  it('仍保留刷新按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.refreshPage"]').exists()).toBe(true)
  })
})
```

> 提示：若 mount 抛错提示某 store 字段缺失，把该字段补进上面的 `useClusterStore`/`useAuthStore` 桩即可（TopNavBar setup 引用较多 store 字段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.dedup.test.js`
Expected: 前两个用例 FAIL（通知/设置按钮当前存在 → `exists()` 为 true → 期望 false 失败）；「仍保留刷新」PASS。

- [ ] **Step 3: 删除通知 + 设置两个按钮（`TopNavBar.vue:271-276`）**

删除这两个 `<button>` 块（位于刷新按钮之后、分隔线之前）：
```html
      <button @click="router.push('/audit-logs')" :aria-label="$t('nav.activityLog')" :title="$t('nav.activityLog')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">notifications</span>
      </button>
      <button @click="router.push('/settings')" :aria-label="$t('nav.settings')" :title="$t('nav.settings')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">settings</span>
      </button>
```

保留其前的刷新按钮（`:268-270`）与后的分隔线（`:277` `<div class="h-8 w-px bg-outline-variant mx-2"></div>`)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.dedup.test.js`
Expected: 3 个用例全 PASS。

- [ ] **Step 5: i18n + 类型/构建门禁**

Run:
```bash
npm run i18n:check
npm run typecheck
npm run build
```
Expected: 全部通过（删除按钮不引入裸中文/缺键）。

- [ ] **Step 6: 提交**

```bash
git branch --show-current
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.dedup.test.js
git commit -m "$(cat <<'EOF'
feat(topbar): 移除通知/设置图标(与侧边栏入口重复)

- 删除顶栏通知(/audit-logs)与设置(/settings)两个图标按钮
- 两者已在侧边栏可达;刷新按钮保留

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: i18n 清理 — 删除去重后未用的键

**Files:**
- Modify: `src/locales/en.json`、`src/locales/zh.json`（删除 `nav.auditLogs`、`nav.auditAndMultiCluster`）

**Interfaces:**
- Consumes: Task 1 已移除这两个键的全部引用（`auditLogs` ← 原 SideNavBar:41 分组项；`auditAndMultiCluster` ← 原 SideNavBar:309 子标题，已改 `multiCluster`）。
- Produces: locale 不再含无引用键；zh/en 保持对齐。

> 此任务为数据/配置清理，无单元测试；以 `npm run i18n:check`（引用键缺失 + 键对齐）作为门禁。

- [ ] **Step 1: 确认两键已无引用**

Run:
```bash
grep -rn "nav\.auditLogs\|nav\.auditAndMultiCluster" src --include=*.vue --include=*.js --include=*.mjs | grep -v locales
```
Expected: 无输出（引用已在 Task 1 移除；仅 locale 定义行被 `-v locales` 排除）。若有命中说明 Task 1 漏改，先回去修。

- [ ] **Step 2: 删除 `nav.auditLogs` 行**

`src/locales/en.json` 删除整行（约 :248）：
```json
    "auditLogs": "Audit Logs",
```
`src/locales/zh.json` 删除整行（约 :248）：
```json
    "auditLogs": "Audit Logs",
```

> 该行带尾逗号且非 nav 末键（其后有 `activityLog` 等），删除整行不影响 JSON 合法性。删除后仍需 Step 4 校验。

- [ ] **Step 3: 删除 `nav.auditAndMultiCluster` 行**

`src/locales/en.json` 删除整行（约 :267）：
```json
    "auditAndMultiCluster": "Audit / Multi-Cluster",
```
`src/locales/zh.json` 删除整行（约 :267）：
```json
    "auditAndMultiCluster": "审计 / 多集群",
```

> 该行紧邻本任务 Task 1 新增的 `multiCluster` 行之前；删除后 `multiCluster` 仍在。非 nav 末键，删除整行安全。

- [ ] **Step 4: i18n 门禁 + JSON 合法性**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/zh.json','utf8')); console.log('JSON ok')"
npm run i18n:check    # 残存中文=0、键对齐✓、引用键缺失=0
```
Expected: `JSON ok`；i18n:check 通过（删除未用键不影响引用；zh/en 同步删除保持对齐）。

- [ ] **Step 5: 全量回归**

Run:
```bash
npm run test:unit     # 含本特性两个新测试文件 + 既有用例
npm run typecheck
npm run build
```
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git branch --show-current
git add src/locales/en.json src/locales/zh.json
git commit -m "$(cat <<'EOF'
chore(i18n): 删除去重后未用的 nav.auditLogs / auditAndMultiCluster 键

- auditLogs:审计日志入口已统一为底部「活动记录」(nav.activityLog)
- auditAndMultiCluster:分组仅剩 Clusters,子标题改用 nav.multiCluster
- en/zh 同步删除,保持键对齐

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 验收手测清单（实现完成后）

1. 顶栏右侧只剩 🔄 刷新 + 用户/登出；腾出宽度被左侧搜索/集群/ns 控件吸收。
2. 侧边栏底部出现「活动记录」+「设置」；点击分别进入 `/audit-logs`、`/settings`。
3. 处于 `/audit-logs` 时底部活动记录项高亮；处于 `/settings` 时底部设置项高亮。
4. 集群管理分组内不再有 Audit Logs；分组标题显示「Multi-Cluster / 多集群」；Clusters 仍可进入。
5. 审计日志全局只有一个入口（底部活动记录）。
