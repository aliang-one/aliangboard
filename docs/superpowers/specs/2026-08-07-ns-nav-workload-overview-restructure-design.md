# 导航栏优化:Workload Overview 与 Workloads 定位梳理

- 日期:2026-08-07
- 状态:已 review,实现中

## 背景

左侧导航(ns 作用域)中存在两个易混淆的入口:

- 「概览」组的 **Namespace Overview**(`src/views/NamespaceOverview.vue`):实际是**分层拓扑视图**——把 workloads 按监控层 / 业务层 / 持久层 / 存储层 / 中间件层组织,并关联 service/ingress。
- 「工作负载」组的 **Workloads**(`src/views/NsWorkloads.vue`):**平铺列表**,按 Deployment/StatefulSet/DaemonSet/Job/CronJob 类型筛选与操作。

两者功能本质不同,但都展示 workloads,且「概览 / 工作负载」分组叠加,用户反馈"看起来一样"、定位不清。

## 目标

通过**重新定位 + 命名**(不合并页面),让"分层拓扑"与"工作负载列表"的区别一目了然,导航业务逻辑更清晰,保留两个页面各自的价值。

## 设计

### 1. 导航结构调整(`src/components/layout/SideNavBar.vue` 的 `nsNavGroups`)

- **移除「概览」组**:其中的 "Namespace Overview" 变为 ns 默认首页、不再占导航项;"Events" 移走(见下)。
- **Events 移到侧边栏底部 actions 区**:与 Settings 并列的次要位置(不起眼但可访问)。
- **「工作负载」组**:「工作负载列表」(原 Workloads,改名)、Pods、HPA —— 结构不变。
- 网络 / 存储配置 / 安全 / 策略 —— 不变。

调整后 ns 作用域导航:
```
NAMESPACE: default        ← 可点击回首页(见 3)
工作负载
  ├ 工作负载列表  (原 Workloads)
  ├ Pods
  └ HPA
网络 / 存储配置 / 安全 / 策略
────── (底部 actions) ──────
Deploy   事件(Events)   设置
```

### 2. 分层拓扑 = ns 默认首页

- 路由 `ns/:namespace` → `NamespaceOverview.vue`(**不变**,进入 ns 默认看拓扑)。
- 页面 h1 从单纯 ns 名改为体现定位:`{namespace} · 分层拓扑`。

### 3. 回首页机制(解决"分层拓扑不占导航项后如何回首页")

- 侧边栏顶部「NAMESPACE: 当前ns名」区域做成**可点击 → 回当前 ns 的拓扑首页**。
- 右侧下拉箭头单独负责"切换 namespace"。
- 即:**ns 名 = 首页入口,箭头 = 切换 ns**。首页入口固定可见,不占导航项。

### 4. 命名(i18n,zh / en)

| 位置 | 现 | 改后(zh / en) |
|------|-----|----------------|
| 导航·工作负载组 | Workloads | 工作负载列表 / Workloads |
| 拓扑首页 h1 | (仅 ns 名) | {ns} · 分层拓扑 / {ns} · Topology |
| 底部 Events | Events | 事件 / Events |

## 影响文件

- `src/components/layout/SideNavBar.vue`:`nsNavGroups` 移除「概览」组、Workloads 改名;顶部 ns 名区域加点击回首页(与下拉切 ns 分离);Events 移到底部 actions 区。
- `src/views/NamespaceOverview.vue`:h1 标题加"· 分层拓扑"。
- `src/locales/zh.json` / `src/locales/en.json`:新增/调整命名 key。
- `src/router/index.js`:**不变**(路由结构保持)。

## 不在范围

- 其余 5 个分组(工作负载组的 Pods/HPA、网络、存储配置、安全、策略)不动。
- 集群级导航(`clusterPrimaryNav` 等)与平台管理区不动。
- 不合并页面、不改路由、不改 nsRouteMap 的 routeKey 语义(仅导航显示调整)。

## 验证

- `npm run i18n:check`:命名 key 对齐、无残留问题。
- `npm run build`:`.vue` 编译通过。
- 手测:进入 ns 默认看到分层拓扑;点 ns 名回首页;箭头切 ns;底部 Events 可访问且不起眼;「工作负载列表」命名正确;原有各 ns 子页面跳转不受影响。

## 实现分支

`worktree-nav-restructure`(基于 `main` `02c82ff`)。
