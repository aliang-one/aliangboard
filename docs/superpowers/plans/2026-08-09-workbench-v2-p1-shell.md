# 工作台 V2 P1 — Shell + 项目卡片网格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作台升级为一个 shell(右上角入口 + 项目/配置/全局 3 tab),项目列表升级为卡片网格。

**Architecture:** 新建 `WorkbenchShell.vue`(tab 容器)替代 `WorkbenchList.vue` 的路由角色;`WorkbenchProjects.vue`(卡片网格,从 WorkbenchList 逻辑提取)、`WorkbenchConfig.vue`(只读信息)、全局 tab 复用 `WorkbenchLedger`。TopNavBar 加入口,SideNavBar 移除旧入口。

**Tech Stack:** Vue 3 + vue-router + vue-i18n + Tailwind。零新依赖。

## Global Constraints

- **零新依赖**;`npm run build` + `npm run i18n:check` + `npm run typecheck`。
- **i18n 门禁**:所有新文案经 `$t`/`t`,zh/en 对齐;`npm run i18n:check` 必过。
- **不改 WorkbenchDetail**(`/workbench/:id` 路由 + 组件不变,P2 范围)。
- **commit 风格**:`feat(workbench): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **测试**:无新 unit test(UI 重构,build + i18n:check 是门禁);手测验证 tab 切换 + 卡片点击。

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/views/WorkbenchShell.vue`(新) | shell 容器(tab 栏 + 3 个内容区) | 新建 |
| `src/views/WorkbenchProjects.vue`(新) | 项目卡片网格(从 WorkbenchList 逻辑提取) | 新建 |
| `src/views/WorkbenchConfig.vue`(新) | 配置 tab(只读:集群/路径/distill) | 新建 |
| `src/views/WorkbenchList.vue` | 旧列表页 | 保留(向后兼容;或后续删) |
| `src/views/WorkbenchLedger.vue` | 台账 | 不改(shell 内嵌) |
| `src/components/layout/TopNavBar.vue` | 顶栏 | +「工作台」按钮 |
| `src/components/layout/SideNavBar.vue` | 侧栏 | -「工作台」入口 |
| `src/router/index.js` | 路由 | `/workbench` → WorkbenchShell |
| `src/locales/zh.json` / `en.json` | i18n | +`workbench.shell.*` / `workbench.card.*` |

---

### Task 1: WorkbenchShell.vue + 路由 + TopNavBar/SideNavBar 入口

**Files:**
- Create: `src/views/WorkbenchShell.vue`
- Modify: `src/router/index.js`、`src/components/layout/TopNavBar.vue`、`src/components/layout/SideNavBar.vue`、`src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Produces: `WorkbenchShell.vue`(props: 无;内部 tab ref;`v-if` 渲染子内容)。
- Consumes: `useRouter`(返回集群)、`useI18n`。

- [ ] **Step 1: i18n 键** — `zh.json` + `en.json` 加(workbench 段):
```jsonc
// zh.json
"shell": {
  "title": "工作台",
  "backToCluster": "返回集群",
  "tabProjects": "项目",
  "tabConfig": "配置",
  "tabGlobal": "全局"
},
"card": {
  "noProjects": "还没有项目,点击「新建」创建第一个",
  "ns": "命名空间",
  "manifests": "manifests",
  "reconciled": "上次 reconcile",
  "neverReconciled": "未 reconcile",
  "openProject": "打开项目",
  "create": "新建项目"
},
"config": {
  "title": "工作台配置",
  "cluster": "绑定集群",
  "projectRoot": "项目根目录",
  "distillStatus": "蒸馏状态"
}
```
```jsonc
// en.json 同结构英文值
"shell": {
  "title": "Workbench",
  "backToCluster": "Back to Cluster",
  "tabProjects": "Projects",
  "tabConfig": "Config",
  "tabGlobal": "Global"
},
"card": {
  "noProjects": "No projects yet. Click \"Create\" to make one.",
  "ns": "Namespace",
  "manifests": "manifests",
  "reconciled": "Last reconcile",
  "neverReconciled": "Not reconciled",
  "openProject": "Open Project",
  "create": "New Project"
},
"config": {
  "title": "Workbench Configuration",
  "cluster": "Bound Cluster",
  "projectRoot": "Project Root",
  "distillStatus": "Distill Status"
}
```

- [ ] **Step 2: 创建 WorkbenchShell.vue** — `src/views/WorkbenchShell.vue`:
```vue
<script setup>
// 工作台 V2 shell(P1):右上角入口 → 全屏 tab(项目/配置/全局)。
// 项目 tab 内嵌 WorkbenchProjects(卡片网格);配置 tab 内嵌 WorkbenchConfig(只读);
// 全局 tab 内嵌 WorkbenchLedger(台账)。
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import WorkbenchProjects from './WorkbenchProjects.vue'
import WorkbenchConfig from './WorkbenchConfig.vue'
import WorkbenchLedger from './WorkbenchLedger.vue'

const router = useRouter()
const { t } = useI18n()
const activeTab = ref('projects')
const tabs = [
  { key: 'projects', label: t('workbench.shell.tabProjects'), icon: 'folder' },
  { key: 'config', label: t('workbench.shell.tabConfig'), icon: 'settings' },
  { key: 'global', label: t('workbench.shell.tabGlobal'), icon: 'public' },
]
</script>

<template>
  <section class="animate-fade-in min-h-screen flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant bg-surface-container-lowest">
      <div class="flex items-center gap-md">
        <button @click="router.push('/cluster')" class="flex items-center gap-xs text-on-surface-variant hover:text-primary transition-colors">
          <span class="material-symbols-outlined text-lg">arrow_back</span>
          <span class="text-body-sm">{{ t('workbench.shell.backToCluster') }}</span>
        </button>
        <span class="text-on-surface-variant/30">|</span>
        <h2 class="text-headline-sm font-bold text-on-surface">{{ t('workbench.shell.title') }}</h2>
      </div>
    </div>
    <!-- Tabs -->
    <div class="flex gap-xs px-md py-sm bg-surface-container-lowest border-b border-outline-variant">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
        :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
        {{ tab.label }}
      </button>
    </div>
    <!-- Content -->
    <div class="flex-1 p-md overflow-y-auto">
      <WorkbenchProjects v-if="activeTab === 'projects'" />
      <WorkbenchConfig v-else-if="activeTab === 'config'" />
      <WorkbenchLedger v-else-if="activeTab === 'global'" />
    </div>
  </section>
</template>
```

- [ ] **Step 3: 路由** — `src/router/index.js` 的 workbench 路由(约 line 432)改为:
```js
        path: 'workbench',
        name: 'Workbench',
        component: () => import('@/views/WorkbenchShell.vue'),
        meta: { titleKey: 'nav.workbench', icon: 'workspaces', scope: 'global' }
```

- [ ] **Step 4: TopNavBar 加入口** — `src/components/layout/TopNavBar.vue` 的 settings 按钮与 avatar 分隔线之间(约 line 275-276)加:
```html
        <button @click="router.push('/workbench')" :aria-label="$t('workbench.shell.title')" :title="$t('workbench.shell.title')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
          <span class="material-symbols-outlined">workspaces</span>
        </button>
```

- [ ] **Step 5: SideNavBar 移除入口** — `src/components/layout/SideNavBar.vue` 删除/注释:
```js
  { icon: 'workspaces', labelKey: 'nav.workbench', route: '/workbench' },
```
(行号约 27;删除该行)

- [ ] **Step 6: 校验** — `npm run i18n:check && npm run build`
Expected: i18n:check 过(0 残存/对齐);build 过(WorkbenchShell 编译;WorkbenchProjects/Config 尚未创建→import 会报错→Step 6 会失败,这是预期的——Task 2/3 创建子组件后通过)。

> **注意**:Step 6 build 会失败(WorkbenchShell imports WorkbenchProjects/WorkbenchConfig which don't exist yet)。这是预期的——本 task **先不 build**,仅 `node --check` 不适用(.vue)。直接 commit(i18n:check + 代码正确性靠人工审查);Task 2/3 创建子组件后 build 自然通过。

替代验证:`npm run i18n:check` 过即可 commit。

- [ ] **Step 7: commit**

```bash
git add src/views/WorkbenchShell.vue src/router/index.js src/components/layout/TopNavBar.vue src/components/layout/SideNavBar.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(workbench): V2 shell(右上角入口 + 项目/配置/全局 tab)+ 路由 + i18n

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: WorkbenchProjects.vue(卡片网格)

**Files:**
- Create: `src/views/WorkbenchProjects.vue`

**Interfaces:**
- Consumes: `workbenchApi.listProjects()`(现有)、`useRouter`。
- Produces: 卡片网格 + 新建按钮;卡片点击 → `/workbench/:id`。

- [ ] **Step 1: 创建 WorkbenchProjects.vue** — 从 `WorkbenchList.vue` 提取逻辑(项目列表 + 新建),渲染改为卡片网格:

```vue
<script setup>
// 项目卡片网格(工作台 V2 P1):替代 WorkbenchList 的列表视图。
// 每张卡显示项目名/简介/ns/manifests/reconcile;点击 → WorkbenchDetail。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { workbenchApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'

const router = useRouter()
const { t } = useI18n()
const projects = ref([])
const clusters = ref([])
const loading = ref(true)
const showCreate = ref(false)
const form = ref({ name: '', clusterId: '' })

const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null

async function load() {
  loading.value = true
  try {
    const [pr, cr] = await Promise.all([workbenchApi.listProjects(), authApi.clusters()])
    projects.value = pr.projects || []
    clusters.value = cr.clusters || []
  } catch (e) { notify('error', e.message || 'Load failed') }
  finally { loading.value = false }
}
onMounted(load)

async function createProject() {
  try {
    await workbenchApi.createProject(form.value)
    showCreate.value = false
    form.value = { name: '', clusterId: '' }
    notify('success', 'Created')
    load()
  } catch (e) { notify('error', e.message || 'Create failed') }
}

const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '-')
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-md">
      <p class="text-on-surface-variant text-body-sm">{{ projects.length }} {{ t('workbench.shell.tabProjects') }}</p>
      <button @click="showCreate = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('workbench.card.create') }}
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant">
      <span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span>
    </div>

    <div v-else-if="!projects.length" class="py-xl text-center">
      <span class="material-symbols-outlined text-4xl text-on-surface-variant/30">folder_off</span>
      <p class="text-on-surface-variant mt-sm">{{ t('workbench.card.noProjects') }}</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
      <div v-for="p in projects" :key="p.id"
        @click="router.push('/workbench/' + p.id)"
        class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md cursor-pointer hover:border-primary/40 hover:shadow-md transition-all group">
        <!-- Name + cluster -->
        <div class="flex items-start justify-between mb-sm">
          <div>
            <h3 class="text-body-md font-bold text-on-surface group-hover:text-primary transition-colors">{{ p.name }}</h3>
            <p class="text-body-xs text-on-surface-variant">{{ clusterName(p.clusterId) }}</p>
          </div>
          <span class="material-symbols-outlined text-on-surface-variant/30 group-hover:text-primary transition-colors">arrow_forward</span>
        </div>
        <!-- Attribute chips -->
        <div class="flex flex-wrap gap-xs mb-sm">
          <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-body-xs font-mono">{{ p.namespace || p.boundSA_namespace || 'default' }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-body-xs">{{ t('workbench.card.manifests') }}: {{ p.manifestCount ?? '?' }}</span>
        </div>
        <!-- Reconcile status -->
        <div class="flex items-center gap-xs text-body-xs text-on-surface-variant">
          <span v-if="p.lastReconcile" class="flex items-center gap-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-status-running"></span>
            {{ t('workbench.card.reconciled') }}: {{ fmt(p.lastReconcile) }}
          </span>
          <span v-else class="flex items-center gap-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-on-surface-variant/30"></span>
            {{ t('workbench.card.neverReconciled') }}
          </span>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <Modal v-model="showCreate" :title="t('workbench.card.create')" width="max-w-md">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.card.create') }}</label>
          <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="my-project" />
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">Cluster</label>
          <select v-model="form.clusterId" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="" disabled>Select cluster</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showCreate = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="createProject" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('common.confirm') }}</button>
      </template>
    </Modal>
  </div>
</template>
```

- [ ] **Step 2: commit**

```bash
git add src/views/WorkbenchProjects.vue
git commit -m "feat(workbench): 项目卡片网格(WorkbenchProjects,属性 chips + reconcile 状态)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: WorkbenchConfig.vue(只读配置 tab)

**Files:**
- Create: `src/views/WorkbenchConfig.vue`

- [ ] **Step 1: 创建 WorkbenchConfig.vue** — 只读信息卡(集群绑定/项目根/distill 状态):

```vue
<script setup>
// 工作台配置 tab(P1 只读):集群绑定 / 项目根目录 / distill 状态。
// P1 不做编辑表单。
import { ref, onMounted } from 'vue'
import { authApi } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'

const { t } = useI18n()
const store = useClusterStore()
const clusters = ref([])

onMounted(async () => {
  try { const r = await authApi.clusters(); clusters.value = r.clusters || [] } catch { /* 静默 */ }
})
</script>

<template>
  <div class="max-w-2xl space-y-md">
    <h3 class="text-body-md font-bold text-on-surface">{{ t('workbench.config.title') }}</h3>

    <!-- 集群绑定 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">cloud</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.cluster') }}</span>
      </div>
      <div v-for="c in clusters" :key="c.id" class="flex justify-between py-xs">
        <span class="text-body-sm text-on-surface">{{ c.name }}</span>
        <span class="font-mono text-body-xs text-on-surface-variant">{{ c.apiServer }}</span>
      </div>
      <p v-if="!clusters.length" class="text-body-xs text-on-surface-variant">—</p>
    </div>

    <!-- 项目根目录 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">folder</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.projectRoot') }}</span>
      </div>
      <code class="text-body-xs font-mono text-on-surface-variant">data/workbench/</code>
    </div>

    <!-- Distill 状态 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">auto_fix_high</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.distillStatus') }}</span>
      </div>
      <p class="text-body-xs text-on-surface-variant">DISTILL_INTERVAL_MS env {{ '=' + (typeof process !== 'undefined' ? 'server-side' : 'check gateway') }}</p>
    </div>
  </div>
</template>
```

- [ ] **Step 2: commit**

```bash
git add src/views/WorkbenchConfig.vue
git commit -m "feat(workbench): 配置 tab(只读:集群/项目根/distill 状态)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全量验证(build + i18n + typecheck)

**Files:** 无代码改动(验证)。

- [ ] **Step 1: 全量验证**

Run: `npm run i18n:check && npm run typecheck && npm run build`
Expected:
- `i18n:check`:0 残存,zh/en 对齐。
- `typecheck`:`node --check` 全过。
- `build`:Vite 构建成功(WorkbenchShell + Projects + Config + Ledger 编译)。

- [ ] **Step 2: commit(若有调整则一并;否则跳过)**

---

## Self-Review(写完后自查)

**1. Spec 覆盖:**
- 入口(TopNavBar 右上角 + SideNavBar 移除)→ Task 1 ✓
- Shell(3 tab)→ Task 1 ✓
- 项目卡片网格 → Task 2 ✓
- 配置 tab(只读)→ Task 3 ✓
- 全局 tab(WorkbenchLedger 嵌入)→ Task 1(shell 里 `<WorkbenchLedger />`)✓
- 路由(/workbench → Shell)→ Task 1 ✓
- i18n → Task 1 ✓
- 全量验证 → Task 4 ✓
- WorkbenchDetail 不改 → 非目标,无 task ✓

**2. 类型一致:** WorkbenchShell import 3 个子组件(WorkbenchProjects/Config/Ledger),名称在 Task 1-3 一致 ✓。

**3. 无占位:** 各步含完整 .vue 代码;i18n 键完整。

**4. 已知简化:**
- WorkbenchList.vue 保留(不删,避免破坏向后兼容;后续可删)。
- 配置 tab 只读(P1;编辑表单 P2+)。
- tab 状态不走路由 query(组件 ref;P1 简单)。
- 项目卡片的 `manifestCount` / `lastReconcile` 字段依赖 listProjects API 返回的数据;若 API 不返这些字段,卡片显示 '?' / '未 reconcile'(降级)。
