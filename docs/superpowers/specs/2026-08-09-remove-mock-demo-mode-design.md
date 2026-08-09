# 移除 Demo/Mock 模式 — 设计文档

- **日期**:2026-08-09
- **状态**:已批准(待写实施计划)
- **范围**:严格 — 只拆 demo/mock 机制,**不**触碰 store `xxxList` refs 的去留(那是独立的 Vue Query 迁移 P2-B)

## 1. 背景与动机

项目存在一套**双模式(demo / remote)架构**:

- `src/mock/cluster.js`(98KB / 814 行 / 30 类资源种子)在 store init 时灌进所有 `xxxList` ref。
- `remoteMode` 标志默认 `false`(demo 模式);`useResourceList({ mock, mockMode: !store.remoteMode })` 在 demo 模式返回种子(`staleTime: Infinity`,不发网络请求)。
- 连接真实集群时 `setConnectedCluster`/`switchCluster` → `remoteMode=true` + `clearMockSeeds()` → 回填真实数据。

**关键事实:生产流程根本到不了 demo 模式。** `router/index.js` 的 `beforeEach` 守卫要求——无平台 token → Login;无 K8s session → 自动连接失败则 → SelectCluster;session 有效 → `setConnectedCluster` + `remoteMode=true`。**任何 app 页面渲染前必然已连接真实集群**,`remoteMode` 在可达代码里恒为 `true`。

因此整套 mock 数据 + demo 分支是**死路径**:仅在被绕过守卫时(如挂载测试)可见。它是 cruft,且让 `remoteMode` 在 ~70 个文件被读取数百次、几乎全是取 `true` 分支的死条件。本设计彻底移除之。

## 2. 范围

### In scope
- 删除 mock 数据本体。
- 拆除 `remoteMode` 标志及其所有读取点(全折叠到「已连接」分支)。
- 拆除 `useResourceList`/`useResourceDetail`/`useLiveYaml` 的 mock 相关形参。
- 拆除 store 内 69 处 `if (remoteMode.value)` 双分支,只留 remote 路径。
- 删除 demo-only UI(模拟日志提示、demoComponents、「未连接」兜底块等)。
- 调整挂载测试,使其在无 mock 种子下仍能跑。

### Out of scope(严格边界,明确不做)
- **不删 store 的 30 个 `xxxList` ref**——保留(改 `ref([])`)。它们在 remote 模式本就空,由 Vue Query 驱动;去留属 P2-B 数据层迁移,独立成项。
- **不删 view 里 `?? store.xxxList` 回退**——同上,留待 P2-B。
- 不改路由连接逻辑、不改 gateway/server。

## 3. 改动地图

### §1 删除数据本体
- 删 `src/mock/cluster.js`。

### §2 store 重写(`src/stores/cluster.js`)
- 删 `import { ... } from '@/mock/cluster'`。
- 30 个 `xxxList = ref(<mockSeed>)` → `ref([])`(保留 ref)。
- 删 `remoteMode` ref(声明于 line ~104)+ `clearMockSeeds()` 函数 + 其 2 处调用点(`switchCluster`/`setConnectedCluster`)。
- 69 处 `if (remoteMode.value) { await remoteXxx(...); return ... }` + 紧随的 mock 分支(`list.value.push/splice` 等)→ **仅保留 remote 路径,去掉 guard 与 mock 分支**。
- 导出的 `remoteMode` 字段(line ~127 getter)删除;若有外部依赖改为不存在(见 §4 折叠后无外部读)。

### §3 composable 简化
- `src/composables/useK8sQuery.js`:`useResourceList`/`useResourceDetail` 删除 `mock`、`mockMode` 形参;5 个 `mockMode ? A : B` 三元回归 `B`(纯 fetcher:`queryFn: fetcher`、`staleTime: options.staleTime ?? 15_000`、`gcTime`、`refetchOnWindowFocus`、`retry`、`refetchInterval`)。
- `src/composables/useLiveYaml.js`:删除 `mockFn` 形参与 `if (!store.remoteMode) { yaml.value = mockFn ? mockFn() : ''; ...; return }` 短路;`load()` 直接走远端 `api.k8s(pathFn())`。

### §4 view/component 批量改写(~70 文件,确定性模式变换)
四类同款模式,按模式批量改写:

| 模式 | 改前 | 改后 |
|------|------|------|
| cid 计算 | `computed(() => store.remoteMode ? (store.currentCluster \|\| 'cluster') : 'demo')` | `computed(() => store.currentCluster \|\| 'cluster')` |
| useResourceList 入参 | `mock: store.xxxList, mockMode: !store.remoteMode,` | (两参删除) |
| refetchInterval | `refetchInterval: store.remoteMode ? N : false` | `refetchInterval: N` |
| 控制流/UI(~15 处) | `if (!store.remoteMode) ...` / `v-if="!store.remoteMode"` | 折叠到已连接分支或删除 demo-only 块 |

控制流/UI 逐个手改,涉及:`AppLayout.vue`(hydrate 守卫)、`InteractiveTerminal.vue`(连接门+demo 提示)、`PortForwardPanel.vue`、`TopNavBar.vue`、`Nodes.vue`(loading 计算)、`MonitoringCenter.vue`(未连接块)、`Settings.vue`(demoComponents)、`PodDetail.vue`(真日志 vs 模拟、export/debug/topology 门)、`NsWorkloadDetail.vue`(metrics/refresh 门)、`NsServiceDetail.vue`、`NsServices.vue`、`NsPods.vue`、`Clusters.vue`/`Namespaces.vue`/`NamespaceDetail.vue`(sync early-return)、`CrdDetail.vue`(`enabled` 计算)、`DeployApp.vue`(create 分支)、`AuditLogs.vue`/`NsEvents.vue`(eventWatch 门)。

### §5 入口/路由
- `src/router/index.js`:删 3 处 `store.remoteMode = true` 赋值(line 527/535 等);守卫的连接逻辑(`tryAutoConnect`/`api.session`/`setConnectedCluster`)保留不变。
- `src/views/TerminalPopup.vue`:删 `store.remoteMode = true`(line 26)。
- `src/components/layout/AppLayout.vue`:`if (store.remoteMode) store.hydrateCriticalResources(...)` → 无条件 `store.hydrateCriticalResources(...)`(守卫已保证已连接)。

### §6 测试
- `src/views/__tests__/_allViewsMount.test.js`:增加 `vi.mock('@/api/client', ...)` 把 `api` 桩成返回空数组/空对象,避免移除 `mockMode` 后每个挂载 view 的 fetcher 打空后端。其余桩(router/localStorage)不变。
- 其余 view 测试(`NsHPA.create-await` 等)已自带 stub 数据,不动。
- `src/__tests__/fixtures/i18n/sample.vue` 等正当测试夹具不动。

## 4. 数据流(改后)

```
路由守卫 → setConnectedCluster → hydrateCriticalResources(namespaces+nodes)
view setup → useResourceList({ key, fetcher: () => store.fetchXxx(), options })
           → Vue Query 调 fetcher → @/api/client → gateway → K8s
           → staleTime/refetchInterval 控制新鲜度(原 remoteMode 三元已折叠为常量)
```

无集群 → 守卫挡在 SelectCluster/Login,不进入任何 view,故 view 内不再需要「未连接」分支。

## 5. 风险与对策

| 风险 | 对策 |
|------|------|
| 批量正则改写误伤(cid/refetchInterval 模式) | 按模式分批,每批后 `npm run typecheck` + `npm run test:unit`;折叠是行为保持的(都取原 true 分支) |
| 控制流折叠遗漏/语义错(~15 处) | 逐个手改 + 复核 diff;依赖挂载套件与 build 兜底 |
| 移除 mockMode 后挂载测试打空后端/同步抛错 | `vi.mock('@/api/client')` 桩空数据;跑 `_allViewsMount` 抓 setup 崩溃 |
| store ref 改 `ref([])` 后某 view 直读 `store.xxxList`(非 fetcher)落空 | 生产中这些 ref 连接后本就空(已被 clearMockSeeds 清掉),故行为保持;任何「依赖 mock 种子直读」的代码是既有 bug,测试会暴露 |
| 改动量大 | 独立分支;分批提交(数据/store → composable → view 批量 → 控制流 → 测试) |

## 6. 验证

- `npm run typecheck`(全 .js/.mjs `node --check`)
- `npm run test:unit`(vitest + happy-dom,含 `_allViewsMount`)
- `npm run build`(覆盖 .vue 编译)
- `npm test`(server + 纯逻辑,确认无回归)
- 全仓 grep 复核:`remoteMode` / `mockMode` / `mockFn` / `@/mock` / `'demo'`(cid 兜底)应为零残留

## 7. 非目标(显式声明)

- 不动 store `xxxList` ref 去留 → P2-B。
- 不动 view `?? store.xxxList` 回退 → P2-B。
- 不重构 fetcher 链路、不引入新依赖(遵循 CLAUDE.md 依赖政策)。
