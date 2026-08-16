# Namespace Overview 部署感知自适应轮询(进行中 3s / 常规 30s)

- 日期:2026-08-16
- 状态:已与用户逐节确认(作用页面/提频范围/回落策略/方案选型)
- 分支:`feat/ns-overview-adaptive-polling`(worktree,基于本地 main 715b649)

## 1. 背景与目标

用户场景:workload 处于「正在部署中」(扩缩容/编辑/回滚等 apply 新变化的过程)时,希望 Namespace Overview 页(`/ns/:namespace`)的数据/状态刷新提升到 **3s**;稳定后回落常规 **30s**(现状:页内三查询固定 30s,`NamespaceOverview.vue:29/41/49`)。

核心诉求:不仅感知本 UI 发起的变更(invalidate 已有立即 refetch),也要感知外部(kubectl 等)发起的部署。

## 2. 已确认的决策

1. **作用页面**:仅 Namespace Overview(Cluster Overview 不动)。
2. **提频范围**:页内三查询(workloads/services/ingresses)全部跟随提频。
3. **回落策略**:收敛 + 短保持——全部收敛后再保持约 10s 高频才回 30s(防滚动中瞬时相等造成抖动)。
4. **方案**:A 页级自适应(纯函数判定 + 页内 fastMode + 闭包式动态 refetchInterval)。

## 3. 设计

### 3.1 纯逻辑模块 `src/logic/workloadTransition.js`

```js
export function isWorkloadTransitioning(raw)  // 单个 workload 是否「变更进行中」
export function anyWorkloadTransitioning(list) // 列表任一进行中;空/undefined → false
export function workloadCounts(raw)            // { desired, updated, ready }(按 kind 取数)
```

判定规则(仅 Deployment/StatefulSet/DaemonSet 参与;**Job/CronJob 恒 false**,明确范围外):
- Deployment/StatefulSet:`generation > observedGeneration` 或 `updatedReplicas < desired` 或 `readyReplicas < desired`(desired = `spec.replicas ?? 1`)
- DaemonSet:`generation > observedGeneration` 或 `updatedNumberScheduled < desiredNumberScheduled` 或 `numberReady < desiredNumberScheduled`
- 缩容到 0(desired=0 且 ready=0)→ 收敛,不误报
- kind 缺失/未知 → false

`workloadCounts` 同时供 `NamespaceOverview.healthOf()` 复用,消掉其按 kind 取数的重复逻辑(现 `NamespaceOverview.vue:174-194`),`updating` 级别判定与 `isWorkloadTransitioning` 对齐(补进 generation 维度)。

### 3.2 fastMode(页内状态,含 10s 保持)

`NamespaceOverview` script 内(唯一消费者,不抽独立文件):
- `fastMode = ref(false)`;`watch(workloadsQuery.data)` → `anyWorkloadTransitioning`
  - 检测到进行中 → 立即 `fastMode=true`,取消挂起的回落 timer
  - 检测到收敛 → 起 10s timer,期内再次进行中则取消;到点才 `fastMode=false`
  - 组件卸载 `onScopeDispose` 清 timer
- `pollInterval = computed(() => fastMode.value ? 3000 : 30000)`
- 三查询 `refetchInterval: () => pollInterval.value`(闭包读 ref;vue-query 每周期重求值)
- 声明顺序:先 `fastMode/pollInterval` → 建 workloads 查询 → `watch` 其 data(无循环依赖)

### 3.3 页面可见性反馈

fastMode 激活时,刷新提示处显示徽标:`部署进行中 · 3s` + 呼吸点;回落自动消失。新 i18n 键 `ns.overview.fastPolling`(en: `Deploying · 3s refresh` / zh: `部署进行中 · 3s 刷新`;纯文本,不涉 v-html)。

## 4. 数据流(端到端)

```
本 UI scale/edit/rollback → invalidateResource('workloads')(既有)→ 立即 refetch
外部 kubectl apply → 周期数据捕获
→ 新数据 anyWorkloadTransitioning=true → fastMode=true → 三查询 3s
→ 收敛(含 generation==observedGeneration)→ 10s 保持 → fastMode=false → 30s
```

## 5. 测试(TDD)

- **node --test**(新 `src/logic/workloadTransition.test.mjs`,注册进 package.json test:server 链,仿 useIngressRules.test.mjs 先例):扩容中/滚动中/刚 apply(generation>observedGeneration)/收敛/缩到 0/DaemonSet 三字段/Job 恒 false/空列表;`workloadCounts` 各 kind 取数与默认值
- **vitest**(fake timers):fastMode 上升沿立即;收敛后 10s 保持;保持期内再进行中不回落;卸载清 timer;页面挂载冒烟走既有 `_allViewsMount`

## 6. 边界与约束

- 查询失败(data undefined)→ `anyWorkloadTransitioning` false → 回落 30s,不卡死高频
- 页面不可见时 vue-query 默认不执行 interval 刷新(既有行为,不变)
- 不动 store/server;不新增依赖;不改其他页面
- 范围外:Job/CronJob 进行中检测、Cluster Overview、其他列表页复用(后续按需)

## 7. Self-Review 记录

- 占位符:无 TBD;判定字段与行号均经代码核实(mapWorkload 暴露 `raw`,`NamespaceOverview.vue:29/41/49` 为 30s 轮询)。
- 一致性:§3.1 判定规则与 §3.2 watch 消费、§5 测试用例一一对应;回落策略(收敛+10s)三处表述一致。
- 歧义消解:「进行中」定义=generation 未观测/updated 未达/ready 未达三者其一;「收敛」=全部 workload 三者皆达(缩 0 亦算)。
- 范围:单页+一纯函数模块,一个实施计划可承载。
