# 移除 Demo/Mock 模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底移除项目的 demo/mock 模式——删 `src/mock/cluster.js`、拆 `remoteMode` 标志及其全部读取点、拆 composable 的 mock 形参、清 demo-only UI,使生产流程(路由守卫保证已连接)成为唯一路径。

**Architecture:** 自底向上、保持每步绿:先给挂载测试桩 API(避免拆 mock 后打空后端)→ 简化 composable(去掉 mock 形参,调用点传的死参被解构忽略,不破)→ 折叠 view 的机械模式(cid/refetchInterval/mockMode 三类)→ 折叠 ~15 处控制流 + 删 demo-only UI → 删外部 `remoteMode` 写入(router/TerminalPopup)→ store 卸掉 mock 数据 → store 删 `remoteMode` 标志 + 折叠 69 处分支。每步以现有测试套件 + typecheck + grep 作 characterization 门禁。

**Tech Stack:** Vue 3 + Pinia + @tanstack/vue-query + vue-router(Vite,纯 JS/.vue);测试 vitest + happy-dom + @vue/test-utils;`node --check` typecheck。

## Global Constraints

- **纯 JS,不引外部依赖**(CLAUDE.md 零依赖政策;vitest/happy-dom/@vue/test-utils 已是登记例外)。不新增任何 dependency/devDependency。
- **不碰 store `xxxList` ref 去留**——只把种子改成 `ref([])`,ref 本身保留;`?? store.xxxList` 回退保留(属 P2-B)。
- **i18n**:删 demo-only UI 会孤立部分键(`monitoring.notConnected`、`*.noSyncNeeded`、`podDetail.simulatedRealTime` 等)——孤立键不报错,但保留的 UI 若引用已删键会被 `npm run i18n:check` 抓。每个改 UI 的任务后跑 i18n:check。
- **验证门禁**(每任务):`npm run typecheck` + `npm run test:unit`;涉及 .vue 模板大改的任务追加 `npm run build`;末任务跑 `npm test`(server + 纯逻辑)全量。
- **分支**:已在 `refactor/remove-mock-demo-mode` 上工作;每任务一次提交。
- **TDD 适配**:这是无新行为的重构,「测试」= 现有套件作 characterization + grep 残留门禁,不为「删除」编造假单测。

## File Structure

| 文件 | 责任 | 本计划动作 |
|------|------|-----------|
| `src/views/__tests__/_allViewsMount.test.js` | 全 view 浅挂载冒烟 | 加 `vi.mock('@/api/client')` |
| `src/composables/useK8sQuery.js` | `useResourceList`/`useResourceDetail` | 删 mock/mockMode 形参 + 折叠三元 |
| `src/composables/useLiveYaml.js` | 详情 YAML 拉取 | 删 mockFn 形参 + 短路 |
| `src/views/**/*.vue`、`src/components/**/*.vue`(~70) | 资源页/组件 | 折叠 cid/refetchInterval/mockMode + 控制流 + demo UI |
| `src/router/index.js` | 路由守卫 | 删 3 处 `store.remoteMode = true` |
| `src/views/TerminalPopup.vue` | 终端弹窗 | 删 `store.remoteMode = true` |
| `src/stores/cluster.js` | 集群 store | 卸 mock 导入/种子 + 删 remoteMode/clearMockSeeds + 折叠 69 分支 |
| `src/mock/cluster.js` | mock 种子数据 | **删除** |

---

### Task 1: 挂载测试桩 API 层(前置)

**Files:**
- Modify: `src/views/__tests__/_allViewsMount.test.js`(在现有 `vi.mock('vue-router', ...)` 之后插入)

**Interfaces:**
- Produces:测试不再依赖 mock 种子;后续任务移除 view 的 `mockMode` 后,fetcher 会跑,被此 mock 拦截返回空值,挂载不崩。

**Why first:** 现在该测试靠 `mockMode: !store.remoteMode`(未连接→true)喂种子、不发请求。一旦 Task 3 折叠 mockMode,fetcher 即跑;必须先有 API 桩,否则每个 view 挂载都打空后端。

- [ ] **Step 1: 加 vi.mock 工厂**

在 `_allViewsMount.test.js` 现有 `vi.mock('vue-router', ...)` 块之后、`import.meta.glob` 之前,插入:

```js
// 桩 API 层:移除 mockMode 后,挂载时各 view 的 fetcher 会跑;
// 用 Proxy 让 api 任意方法都 resolved 空值,避免打真实后端 / 同步抛错。
vi.mock('@/api/client', () => {
  const noop = () => {}
  const api = new Proxy({}, { get: () => () => Promise.resolve({}) })
  return {
    api,
    k8sStream: () => ({ close: noop }),
    portForwardApi: new Proxy({}, { get: () => () => Promise.resolve([]) }),
    registryApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    terminalApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podDebugApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    pvcFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    cronJobApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    resourceTreeApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    workbenchApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    authApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    adminApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    getSessionToken: () => '',
    saveSession: noop,
    clearSession: noop,
    getSession: () => null,
    getPlatformToken: () => '',
    savePlatformToken: noop,
    clearPlatformToken: noop,
    exportYaml: noop,
    getSavedClusters: () => [],
    addSavedCluster: noop,
    removeSavedCluster: noop,
    setActiveToken: noop,
    activeApiServer: () => '',
    execStream: () => ({ close: noop }),
  }
})
```

- [ ] **Step 2: 跑测试,确认仍绿**

Run: `npm run test:unit -- _allViewsMount`
Expected: PASS(此时 view 仍传 mockMode=true 走种子,fetcher 不触发,mock 未被 exercise 但无害)。

- [ ] **Step 3: Commit**

```bash
git add src/views/__tests__/_allViewsMount.test.js
git commit -m "test(views): 桩 @/api/client 为 mock 模式移除做前置"
```

---

### Task 2: 简化 composable(删 mock/mockMode/mockFn 形参)

**Files:**
- Modify: `src/composables/useK8sQuery.js`
- Modify: `src/composables/useLiveYaml.js`

**Interfaces:**
- Consumes:无(首改)。
- Produces:`useResourceList({ key, fetcher, select?, identityKey?, options? })`、`useResourceDetail({ key, fetcher, options? })`——**不再有 `mock`/`mockMode`**;`useLiveYaml({ pathFn, timeoutMs? })`——**不再有 `mockFn`**,恒走远端 `api.k8s(pathFn())`。Task 3 起 view 调用点不再传这些参(传了也被解构忽略,但 Task 3 会清掉)。

**Why safe now:** 解构 `{ key, fetcher, ... }` 不列 `mock`/`mockMode`,调用点多传的键被静默忽略,运行时不破;`node --check` 也不报。`useLiveYaml` 短路删除后恒 fetch,Task 1 的 api 桩在测试里兜底。

- [ ] **Step 1: 改 `useK8sQuery.js`**

`useResourceList` 签名与函数体改为(删 `mock = null, mockMode = false`,5 个三元取非 mock 分支):

```js
export function useResourceList({ key, fetcher, select, identityKey = uidKey, options = {} }) {
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    staleTime: options.staleTime ?? 15_000,
    gcTime: options.gcTime ?? 5 * 60_000,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true,
    retry: options.retry ?? 1,
    refetchInterval: options.refetchInterval ?? false,
    select,
  })
}

export function useResourceDetail({ key, fetcher, options = {} }) {
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    staleTime: options.staleTime ?? 15_000,
    retry: options.retry ?? 1,
    refetchInterval: options.refetchInterval ?? false,
  })
}
```

(保留文件里既有的注释/select/identityKey 用法;若 `select` 原本只在 `useResourceList` 支持,维持原状。先 Read 该文件确认 `useQuery` import 与 `uidKey` 已在,照原结构只删 mock 相关行。)

- [ ] **Step 2: 改 `useLiveYaml.js`**

签名删 `mockFn`:`export function useLiveYaml({ pathFn, timeoutMs = 20000 }) {`。`load()` 删首行短路:

```js
  async function load() {
    ctrl?.abort()
    ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    // ...其余 try/catch 原样保留(api.k8s → yamlDump)
  }
```

(顶部注释里「mock / 演示模式用 mockFn」一句删除/改写。)

- [ ] **Step 3: typecheck + 单测**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS。(`useLiveYaml` 现恒 fetch,被 Task 1 桩兜底;view 仍传 mockMode 死参,被解构忽略。)

- [ ] **Step 4: Commit**

```bash
git add src/composables/useK8sQuery.js src/composables/useLiveYaml.js
git commit -m "refactor(composable): 删 useResourceList/useLiveYaml 的 mock 形参"
```

---

### Task 3: view 机械模式折叠(cid / mock+mockMode 入参 / refetchInterval)

**Files:**
- Modify: `src/views/**/*.vue`、`src/components/**/*.vue` 中所有命中下列模式的文件(~70)。

**Interfaces:**
- Consumes:Task 2 的新 composable 签名(不认 mock/mockMode)。
- Produces:view 不再读 `store.remoteMode` 的三类机械模式;为 Task 4(控制流)清场。

**三类确定性变换(编辑器跨文件正则替换或 perl,逐模式后 grep 门禁):**

- [ ] **Step 1: 折叠 cid 模式**

Find(regex):`store\.remoteMode \? \(store\.currentCluster \|\| 'cluster'\) : 'demo'`
Replace:`store.currentCluster || 'cluster'`
(覆盖 `const cid = computed(...)` 与 `const _cid = computed(...)` 两类变量名,变量名保留。)

Run 门禁:`grep -rn "store.remoteMode ? (store.currentCluster" src/views src/components` → **0 命中**

- [ ] **Step 2: 删除 mock/mockMode 入参**

Find(regex,多行):` ?mock: store\.\w+,\n\s*mockMode: !store\.remoteMode,` → Replace: ``(空)
另处理单行内联写法(如 `NsLayers.vue`):`mock: store.workloadList, mockMode: !store.remoteMode,` 手工删。
另:`NsRoleDetail.vue:37 mockFn: () => store.generateYAML(...)` 入参行删除(useLiveYaml 已不收)。

Run 门禁:
`grep -rn "mockMode: !store.remoteMode" src/views src/components` → **0**
`grep -rnE "^\s*mock: store\." src/views src/components` → **0**

- [ ] **Step 3: 折叠 refetchInterval 三元**

Find(regex):`refetchInterval: store\.remoteMode \? (\d+) : false`
Replace:`refetchInterval: $1`

Run 门禁:`grep -rn "refetchInterval: store.remoteMode" src/views src/components` → **0**

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: PASS。此时 view 残留的 `store.remoteMode` 读取应只剩 Task 4 要处理的控制流/UI(~15 类)。

Run 复核:`grep -rn "store.remoteMode" src/views src/components | wc -l` → 应为控制流残余数(约 30~40 行,集中在 Task 4 清单内的文件)。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(views): 折叠 cid/refetchInterval/mockMode 三类 remoteMode 机械模式"
```

---

### Task 4: view 控制流折叠 + 删 demo-only UI(~15 处)

**Files(逐个手改):**
- `src/components/layout/AppLayout.vue`
- `src/components/common/InteractiveTerminal.vue`、`PortForwardPanel.vue`、`CopyWorkloadDialog.vue`
- `src/components/layout/TopNavBar.vue`、`SideNavBar.vue`(cid 已在 Task 3,此任务看是否还有 `_cid`/控制流残余;`TopNavBar.vue:20 searchEnabled`、`:39 invalidateAllClusterQueries` 守卫折叠)
- `src/views/Nodes.vue`、`MonitoringCenter.vue`、`Settings.vue`、`PodDetail.vue`、`NsWorkloadDetail.vue`、`NsServiceDetail.vue`、`NsServices.vue`、`NsPods.vue`
- `src/views/Clusters.vue`、`Namespaces.vue`、`NamespaceDetail.vue`(sync early-return)
- `src/views/CrdDetail.vue`、`DeployApp.vue`、`AuditLogs.vue`、`NsEvents.vue`、`NsPVCDetail.vue`

**Interfaces:**
- Produces:`grep -rn "store.remoteMode" src/views src/components` → **0**。之后仅 router/TerminalPopup/store 还涉及 `remoteMode`(Task 5/7)。

**折叠原则:** 守卫保证 view 渲染前已连接,故每个 `if (!store.remoteMode) ...` 的 demo 分支删除,保留 connected 分支;`v-if="store.remoteMode"` → 去掉条件(恒真);`v-if="!store.remoteMode"` 的 demo-only 块整块删除。

- [ ] **Step 1: AppLayout hydrate 守卫**

`AppLayout.vue:27` `if (store.remoteMode) store.hydrateCriticalResources({ silent: true }).catch(() => {})` → `store.hydrateCriticalResources({ silent: true }).catch(() => {})`

- [ ] **Step 2: 交互/工具组件**

- `InteractiveTerminal.vue`:删 `:110 if (!store.remoteMode) return`、`:134 onMounted` 里的 `&& store.remoteMode` 条件、`:150 v-if="!store.remoteMode"` demo 提示块、`:159 v-if="store.remoteMode"` → 去条件。
- `PortForwardPanel.vue`:`:36 watch(open, v => { if (v && store.remoteMode) ... })` → `if (v) ...`;`:72 v-if="store.remoteMode"` 去条件。
- `CopyWorkloadDialog.vue:59` `if (store.remoteMode) { ... }` → 去条件保留块体(Read 该处确认块体无 else demo 分支)。

- [ ] **Step 3: 顶栏/布局**

- `TopNavBar.vue:20` `searchEnabled = searchOpen.value && store.remoteMode` → `searchOpen.value`;`:39` `if (store.remoteMode) store.invalidateAllClusterQueries()` → 去条件。

- [ ] **Step 4: 列表/详情控制流**

- `Nodes.vue:35` `loading = nodesQuery.isLoading.value && store.remoteMode` → `nodesQuery.isLoading.value`;`:40` sync handler 删 `if (!store.remoteMode) { notify(...); return }` 守卫,保留后续真实 sync。
- `MonitoringCenter.vue:115` `v-if="!store.remoteMode"` 未连接提示块整块删除。
- `Settings.vue:40` `if (!store.remoteMode) { csState.value='loaded'; return }` 删;`:161 v-if="store.remoteMode"` 去条件;`:169 v-if="!store.remoteMode"` demo 块删;`:175 v-if="store.remoteMode"` 去条件;`:208 (store.remoteMode ? components : demoComponents)` → `components`;`:218 v-if="store.remoteMode && !components.length"` → `v-if="!components.length"`;`demoComponents` 变量及其用法若仅服务 demo 则一并删除(Read 确认无其它引用)。
- `PodDetail.vue`:`:170 if (store.remoteMode) {` 分支去条件;`:189/:195 if (!store.remoteMode) return` 删;`:198 onMounted` 去条件;`:200 allLogs = store.remoteMode ? liveLogs.value : [...]` → `liveLogs.value`;`:253 if (!store.remoteMode) {` 删;`:376/:439/:440/:475/:479/:491/:536 v-if="store.remoteMode"` 去条件;`:439/:440` 三元里 `: $t('podDetail.simulatedRealTime')` / `: 'LIVE'` 分支收敛为 live 文案。
- `NsWorkloadDetail.vue`:`:172/:394/:654 if (!store.remoteMode ...) return` 删/去条件;`:661 onMounted` 去条件。
- `NsServiceDetail.vue`:`:206/:237 if (!store.remoteMode...)` 去条件(`:237` 删 `if (!store.remoteMode) { svcYaml.value = store.generateYAML(...); return }` 整段);`:407 if (store.remoteMode) items.push(...)` 去条件。
- `NsServices.vue:124` `if (store.remoteMode) items.push(...)` 去条件。
- `NsPods.vue:126` `v-if="store.remoteMode"` 去条件。
- `NsPVCDetail.vue:81` `if (!store.remoteMode) { ferror.value=...; return }` 删。

- [ ] **Step 5: sync early-return + 杂项**

- `Clusters.vue:20` `if (!store.remoteMode) { notify('info', t('clusters.demoModeNoSync')); return }` 删,保留 sync。
- `Namespaces.vue:33`、`NamespaceDetail.vue:55` 同款 noSyncNeeded 守卫删除,保留真实 sync(Read 确认守卫后确有 sync 逻辑)。
- `CrdDetail.vue:34` `enabled: !store.remoteMode ? true : (...)` → `enabled: (!!crd.value && !!crd.value._plural)`;`:44 if (!store.remoteMode || !crd.value) return` → `if (!crd.value) return`。
- `DeployApp.vue:689` `if (store.remoteMode) { ... }` 去条件(Read 确认块体为真实 create,无 demo else)。
- `AuditLogs.vue:64`、`NsEvents.vue:41` `onMounted(() => { if (store.remoteMode) store.startEventWatch() })` → `onMounted(() => store.startEventWatch())`。

- [ ] **Step 6: 门禁 + 验证**

Run:`grep -rn "store.remoteMode" src/views src/components` → **0 命中**
Run:`npm run typecheck && npm run test:unit && npm run build && npm run i18n:check`
Expected:PASS(删 demo UI 孤立的键不报错;i18n:check 防漏删被引用键)。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(views): 折叠 remoteMode 控制流 + 删 demo-only UI"
```

---

### Task 5: 删外部 `remoteMode` 写入(router / TerminalPopup)

**Files:**
- Modify: `src/router/index.js`(`:527`、`:535` 两处 `store.remoteMode = true`,以及 `:530 if (!store.remoteMode)` 守卫块)
- Modify: `src/views/TerminalPopup.vue`(`:26 store.remoteMode = true`)

**Interfaces:**
- Produces:无外部代码再写 `store.remoteMode`。store 内部 `setConnectedCluster`/`switchCluster` 的 `remoteMode.value = true`(line ~1518/1564)仍在,由 Task 7 一并删。Task 5 后 `remoteMode` 仍被声明、仍被 store 内部写,但不被外部读写。

- [ ] **Step 1: router 守卫瘦身**

Read `src/router/index.js:505-549`。当前逻辑:
- `:526-527`:自动连接成功 → `setConnectedCluster(...)` + `store.remoteMode = true`。删 `store.remoteMode = true`(`setConnectedCluster` 内部已置)。
- `:530-540`:`if (!store.remoteMode) { try { api.session(); setConnectedCluster(result.cluster); store.remoteMode = true } catch {...} }`。改为:`if (!store.hasSession?.())` 或直接基于 `getSession()`/`api.session()` 判定——但注意此处原意是「已有 session 但 store 未标记 connected」。简化为:去掉 `remoteMode` 判定,改为「若未连接则验证 session 并 setConnectedCluster」。具体:
  - 把 `if (!store.remoteMode) {` 改为以连接态判断:在守卫顶部已 `if (!getSession())` 处理过无 session。此处保留 `try { const result = await api.session(); store.setConnectedCluster(result.cluster) } catch { clearSession(); return { name: 'SelectCluster' } }`,删 `store.remoteMode = true`。
  - (语义保持:有 session → 验证 → setConnectedCluster,后者内部已设连接态。)

- [ ] **Step 2: TerminalPopup**

`TerminalPopup.vue:26 store.remoteMode = true` 删除(Read 上下文确认该行可独立删,若紧邻 `setConnectedCluster` 调用则更该删)。

- [ ] **Step 3: 验证**

Run:`grep -rn "store\.remoteMode\s*=" src/router src/views/TerminalPopup.vue` → **0**
Run:`npm run typecheck && npm run test:unit`
Expected:PASS。

- [ ] **Step 4: Commit**

```bash
git add src/router/index.js src/views/TerminalPopup.vue
git commit -m "refactor(router): 删外部 remoteMode 写入"
```

---

### Task 6: store 卸掉 mock 数据(import + 种子 + 删文件)

**Files:**
- Modify: `src/stores/cluster.js`(`:25` import 块、`:53-102` 共 30 处 `xxxList = ref(<seed>)`、`:1532-1561 clearMockSeeds` 暂留)
- Delete: `src/mock/cluster.js`

**Interfaces:**
- Produces:store 不再 import `@/mock/cluster`;30 个 `xxxList` ref 改 `ref([])`(保留 ref)。`remoteMode` 与 69 分支与 `clearMockSeeds` 仍在(由 Task 7 处理),此时 mock 分支操作空 ref,生产不可达,无害。

- [ ] **Step 1: 删 import 块**

Read `src/stores/cluster.js:1-30`。删除整段 `import { clusterInfo, namespaces, nodes, workloads, pods, ... } from '@/mock/cluster'`(line ~5-25 的多行 import)。确认 `clusterInfo` 等若在 store 内有别处使用——`clusterInfo` 用于 `cluster.value` 初始化,改为内联默认对象(见 Step 2)。

- [ ] **Step 2: 30 个 ref 改空 + cluster 初值内联**

- `:53 nodeList = ref(nodes)` → `ref([])`,同理 workloads/pods/namespaces/events/services/ingresses/endpoints/configMaps/secrets(注意 `:78 secretList = ref(secrets.map(...))` → `ref([])`)/pvs/pvcs/scs/ingressClasses/runtimeClasses/roles/sas/networkPolicies/hpas/resourceQuotas/limitRanges/roleBindings/clusterRoleBindings/pdbs/priorityClasses/auditLogs/crds,全部 `ref([])`。
- `cluster.value` 初始若用 `clusterInfo`,改为内联:`const cluster = ref({ name: '', apiServer: '', version: '', status: 'Unknown' })`(Read 确认 `clusterInfo` 字段,对齐)。
- `clusters`/`savedClusters` 等多集群真数据 ref 不动(它们来自 `getSavedClusters()` 等)。

- [ ] **Step 3: 删 mock 文件**

```bash
git rm src/mock/cluster.js
```

- [ ] **Step 4: 验证**

Run:`npm run typecheck && npm run test:unit && npm run build`
Expected:PASS。(`grep -rn "@/mock" src` → 0。`clearMockSeeds` 把空 ref 再置空,冗余但无害。)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(store): 卸掉 mock 数据导入与种子 + 删 src/mock/cluster.js"
```

---

### Task 7: store 删 `remoteMode` + `clearMockSeeds` + 折叠 69 分支

**Files:**
- Modify: `src/stores/cluster.js`

**Interfaces:**
- Produces:`grep -rn "remoteMode" src` → **0**。store 的 create/update/delete 仅保留 remote(真实 API)路径。

**折叠模式(逐个 Read 上下文处理,69 处分三类):**

- [ ] **Step 1: create 类折叠**

原:
```js
async function createService(s) {
  if (remoteMode.value) {
    await remoteCreate(generateYAML('service', s), `Service/${s.name}`, () => refetch('/api/v1/services', serviceList, mapService))
    return
  }
  serviceList.value.push(s)   // mock 分支
}
```
改:
```js
async function createService(s) {
  await remoteCreate(generateYAML('service', s), `Service/${s.name}`, () => refetch('/api/v1/services', serviceList, mapService))
}
```
(删 `if (remoteMode.value) {` + `return` + 整个 mock 分支,保留 remote 调用。`serviceList` 仍作 `refetch` 的目标 ref 保留——严格范围不动 ref。)

- [ ] **Step 2: update 类折叠**

原:
```js
function updateService(idx, updates) {
  if (remoteMode.value) await remoteUpdate(generateYAML('service', serviceList.value[idx]), 'Service', () => { serviceList.value[idx] = before })
  const before = serviceList.value[idx]
  serviceList.value[idx] = { ...serviceList.value[idx], ...updates }
}
```
改:删 `if (remoteMode.value)` 守卫,保留 `await remoteUpdate(...)`(注意原代码若有 `before` 先声明依赖,调整顺序——Read 每处确认变量声明先后)。若 update 函数体在 remote 分支之外**没有**额外 mock-only 逻辑,则整体只剩 remote 调用。

- [ ] **Step 3: delete / 其它类折叠**

`deleteX`、`toggleX`、`restartX` 等同模式:`if (remoteMode.value) { remoteXxx(...); return }` + mock 分支 → 仅留 `remoteXxx(...)`。逐个 Read 确认有无共享尾随代码。

- [ ] **Step 4: 删 `remoteMode` 声明 + 内部写 + 导出 + `clearMockSeeds`**

- 删 `:104 const remoteMode = ref(false)`。
- 删 `:127` 返回对象里的 `remoteMode: remoteMode.value,`(以及 getter 形式,若有)。
- 删 `:1518`、`:1564` 两处 `remoteMode.value = true`。
- 删 `:1532-1561` 整个 `clearMockSeeds()` 函数 + 其在 `switchCluster`/`setConnectedCluster` 的 2 处调用。

- [ ] **Step 5: 门禁 + 全量验证**

Run:`grep -rn "remoteMode\|clearMockSeeds" src` → **0**
Run:`npm run typecheck && npm run test:unit && npm run build && npm test`
Expected:全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/stores/cluster.js
git commit -m "refactor(store): 删 remoteMode/clearMockSeeds + 折叠 69 处双分支为纯 remote"
```

---

### Task 8: 终审 + 记忆

**Files:** 无代码改动(仅审计 + 记忆更新)。

- [ ] **Step 1: 残留审计**

```bash
echo "remoteMode:"; grep -rn "remoteMode" src server 2>/dev/null | grep -v __tests__
echo "mockMode/mockFn/mock:"; grep -rnE "mockMode|mockFn|mock: store\." src 2>/dev/null | grep -v __tests__
echo "@/mock:"; grep -rn "@/mock" src 2>/dev/null
echo "cid 'demo' 兜底:"; grep -rn ": 'demo'" src/views src/components 2>/dev/null | grep -v __tests__
echo "mock 文件:"; ls src/mock 2>&1 || echo "(已删)"
```
Expected:全部 0 命中 / mock 目录不存在。

- [ ] **Step 2: 全套门禁**

Run:`npm run typecheck && npm run test:unit && npm run build && npm test && npm run i18n:check`
Expected:全 PASS。

- [ ] **Step 3: 更新记忆**

更新 `~/.claude/projects/-home-liang-MyProgram-AiProject-aliangboard/memory/`:在 `frontend-data-layer-refactor.md` 标注「demo/mock 模式已于 2026-08-09 移除(commit XXX);store xxxList refs 改 ref([]) 保留,去留仍属 P2-B」;必要时新增 `mock-demo-mode-removed.md` 一行索引到 MEMORY.md。

- [ ] **Step 4: Commit 记忆(若纳入仓库则一并)**

```bash
# 记忆在 ~/.claude 不在本仓库,无需 git add;此处仅收尾
git log --oneline -8
```

---

## Self-Review

- **Spec coverage**:§1 删 mock 文件 → Task 6 Step 3;§2 store 重写 → Task 6(数据)+ Task 7(remoteMode/分支);§3 composable → Task 2;§4 view 批量 → Task 3(机械)+ Task 4(控制流);§5 router/AppLayout → Task 5 + Task 4 Step 1;§6 测试 → Task 1;§7 风险(分批+grep 门禁)→ 贯穿每任务。✓ 无遗漏。
- **Placeholder scan**:每步含具体文件:行、正则、代码块、命令。无 TBD/「适当处理」。✓
- **Type/签名一致**:Task 2 定义的 `useResourceList({key,fetcher,select?,identityKey?,options?})`/`useLiveYaml({pathFn,timeoutMs?})` 与 Task 3 删参、Task 4 控制流一致;`remoteMode` 在 Task 5(删外部写)→ Task 7(删声明)顺序无悬空引用。✓
