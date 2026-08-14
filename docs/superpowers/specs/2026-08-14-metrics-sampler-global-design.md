# 集群指标采样全局化 + localStorage 持久化

> 状态:设计已与用户确认(方案 A:store 承载 + 纯逻辑模块;回看窗口 15 分钟)。待写实现计划。
> 日期:2026-08-14。分支:`worktree-feat-metrics-sampler`(自 main `28af761`)。
> 背景:图表美化(2026-08-14 合入)落地后发现图表首屏空窗 ~20s、数据仅为组件会话内累计、平台零指标历史(调查结论见会话记录;网关 sqlite 无 metrics 表,metrics-server 只供瞬时值)。本特性解决体验层:采样器全局化 + 持久化。**网关侧指标记录为后续独立立项,不在本范围。**

## 1. 目标 / 非目标

**目标**
- ClusterOverview / MonitoringCenter 共享**一个**全局采样器:切页不清零、不双倍轮询。
- 采样窗口持久化到 localStorage(按集群分 key):重进页面/刷新立即带出最近 **15 分钟**历史,图表首屏即有数据。
- 样本带真实时间戳,图表 x 轴改时间轴,tooltip 相对时间准确(跨会话空档真实呈现)。
- 后台标签页暂停采样(document.hidden),恢复可见立即补一轮。

**非目标**
- 不做网关侧记录(后续立项)。
- 不动 Pod 级采样(NsWorkloadDetail 的 useMetricsHistory——按选中 Pod 动态切换,持久化无意义)。
- 不动采样频率(10s)与 refreshMetrics 拉取逻辑本身。
- 不做登出清指标缓存(按集群维度保留)。

## 2. 架构

### 2.1 纯逻辑模块 `src/logic/metricsWindow.js`(node 零依赖可测)

- `pushSample(samples, {t, v}, maxAgeMs)` → 新数组(不可变):append + 丢弃 `t < now - maxAgeMs` 的陈旧样本 + 上限裁剪(按条数 180,防异常时钟写爆)。
- `restoreSamples(raw, now, maxAgeMs)` → 样本数组或 `[]`:解析 localStorage JSON,过滤非 `{t:number, v:number}` 项与陈旧项;任何异常(损坏/空/非对象)返回 `[]`,不抛。
- `persistPayload(cpuSamples, memSamples)` → `{cpu:[{t,v}], mem:[{t,v}]}`(深拷贝序列化用)。
- 常量:`WINDOW_MS = 15 * 60_000`、`MAX_SAMPLES = 180`。
- localStorage key 约定:`aliangboard.metrics.<clusterId>.v1`(clusterId 与 store.currentCluster 同源;读写由 store 侧做,模块只管数据形状)。

### 2.2 cluster store 接线

- 状态:`cpuSamples: Sample[]`、`memSamples: Sample[]`(暴露给视图;`Sample = {t:number, v:number}`)。
- `startMetricsSampling()` / `stopMetricsSampling()`:**引用计数**,每次 start +1、每次 stop -1(clamp 到 ≥0,防视图重复 unmount 打穿);count > 0 时确保 timer(10s)运行,归 0 时清 timer。视图 mount/unmount 严格配对调用。
- tick:`document.hidden` → 跳过本轮;否则 `await refreshMetrics()` → cpu/mem 非 null 时 push 纯模块 → 每 tick 落盘 localStorage(数据量小,不做节流)。
- 立即采样:start 使计数 0→1 时先同步跑一轮(不 await),保证切页回来数据新鲜;另暴露 `sampleNow()` 供手动刷新按钮调用(执行一次 tick 逻辑)。
- 集群切换(store 现有切集群路径):清内存窗口 → 从新 key `restoreSamples` 恢复。
- visibilitychange 监听:恢复可见且 count>0 → 立即 tick(全局单监听,随首个 start 注册、最后一个 stop 移除)。

### 2.3 图表适配(chart-options + AreaLineChart)

- `buildTimeAreaLineOption({ samples, color, unit, height 无关, refLines, smooth })`:
  - x 轴 `type:'time'`,series data 为 `[t, v]` 对;
  - tooltip formatter:相对**最新样本时间**的偏移(`-3m20s`/`0s`,复用/扩展 relTimeLabel 支持分钟档),值+unit;
  - 面积渐变、线色、refLines markLine 语义与 buildAreaLineOption 一致(y 轴 max 同样计入 refLines)。
- `AreaLineChart.vue` 新增可选 prop `samples`(与 `series` 二选一,samples 优先):传入则走 time 版 option;空态条件=有效样本 <2。现有 `series` 路径(pod 图)零改动。

### 2.4 视图改动

- ClusterOverview / MonitoringCenter:删除各自的 `cpuSeries/memSeries/tick/timer/onMounted/onUnmounted` 采样块(~15 行/处),换 `onMounted(() => store.startMetricsSampling())` + `onUnmounted(() => store.stopMetricsSampling())`,图表改传 `:samples="store.cpuSamples"`。
- MonitoringCenter 手动刷新按钮:改调 store 单次采样动作 `sampleNow()`(暴露的轻量方法:手动跑一次 tick 并更新 lastRefresh)。

## 3. 边界与错误处理

- metrics-server 不可用:沿用 `metricsAvailable` 徽章 + tick 静默策略;窗口保留旧样本(会随 15min 窗口自然老化)。
- localStorage 读写异常(隐私模式/配额):try/catch 静默,功能退化为会话内窗口。
- 时钟回拨:push 端不依赖单调性,仅按 maxAge 过滤,不做排序修正(异常时钟属极端,YAGNI)。
- 首次使用(无历史):仍需 ~20s 攒 2 点,诚实空态。
- 多标签页同开:各自采样各自写,后写覆盖先写——可接受(不做跨 tab 广播,YAGNI,记录为已知限制)。

## 4. 测试

- `metricsWindow`(scripts/test.mjs 自研运行器):push 追加+陈旧过滤+条数上限;restore 正常/损坏/陈旧全滤/空;persistPayload 形状。
- `buildTimeAreaLineOption`(同上):time 轴、[t,v] 数据、tooltip 相对时间(含分钟档)、refLines 计入 y max。
- AreaLineChart samples 分支(vitest,沿用 mock echarts 模式):samples 传 setOption 收到 time 轴 option;<2 样本空态。
- store 接线:轻量——引用计数 start×2/stop×2 只跑一个 timer 的行为用 vitest 对 store 直接测(或纳入 AreaLineChart 同文件);视图迁移靠 _allViewsMount 冒烟。
- 回归:`npm test` / `typecheck` / `build` 全绿。

## 5. 交付物

新增:`src/logic/metricsWindow.js`、对应测试追加。
修改:`src/stores/cluster.js`(采样器段)、`src/lib/chart-options.js`(time 版 builder)、`src/components/common/AreaLineChart.vue`(samples prop)、`src/views/ClusterOverview.vue`、`src/views/MonitoringCenter.vue`。
不动:useMetricsHistory、NsWorkloadDetail、EChart、其它图表组件。
