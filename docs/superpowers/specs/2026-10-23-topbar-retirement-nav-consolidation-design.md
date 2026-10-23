# 顶栏退役 · 导航单源收敛 设计

- 日期:2026-10-23
- 状态:已批准(方案 A,用户 2026-10-23 裁决)
- 背景:顶栏(TopNavBar)的「工作台」胶囊与工作台模块(项目/服务器/凭据 + 知识/记录)重复;用户裁决删除整个顶栏,导航逻辑提取单源,顶栏每项功能逐个安置,无入口的找新家(设置页优先)。

## 1. 现状盘点(删除前审计)

顶栏(TopNavBar.vue)承载的全部能力与去向:

| # | 能力 | 现状其他入口 | 去向(本设计) |
|---|------|--------------|----------------|
| 1 | 全局搜索(⌘K;页面 + 20 类资源惰性查询;≥lg 内联框 / <lg 弹层) | 无(全站唯一) | 侧栏顶部搜索框(§4.2) |
| 2 | 手机汉堡(开抽屉,`shell.toggleDrawer`) | 无 | footer 左端(§5) |
| 3 | 手机上下文胶囊(ns 主/集群副 + ns bottom sheet) | 抽屉内集群头部 + ns 坞(等价) | **删除**(§6) |
| 4 | 告警铃铛(AlertBell:events+证书告警,未读红点) | 无 | 侧栏底部行 / 手机 footer(§4.4、§5) |
| 5 | 刷新当前页(bumpRefresh + invalidateAllClusterQueries) | 无 | footer 右段(§5) |
| 6 | 工作台入口胶囊(summary 30s 轮询 + 统计条 + 悬停项目面板) | 工作台模块本身 | 侧栏「工作台」段(§4.3) |
| 7 | 头像菜单(主题/语言快捷切换、个人中心、登出) | 主题:/profile 与本菜单;语言:设置页与本菜单 | 侧栏头像行;主题/语言归设置页(§4.5) |
| 8 | 身份舷板(容器视觉:wbActive W 轨着色/回声线/发丝线) | — | 随顶栏退役;W 轨职责移至侧栏工作台段(§7) |

发现的无导航入口页面(全局搜索可达、侧栏没有):`/workloads` `/network` `/configuration` `/rbac`(跨 ns 视图)与 `/rbac/can-i`(权限模拟器);平台管理 7 页不在搜索页面表。安置见 §6。

## 2. 目标与非目标

**目标**
1. 顶栏组件及其测试整体退役;AppLayout 内容列 = 集群健康横幅 → 更新横幅 → main。
2. 导航逻辑单源化:新建 `src/logic/navConfig.js`,侧栏全部导航(集群管理三组 + 新跨 ns 组、平台管理、ns 五组 + NS_ROUTE_MAP、工作台入口)声明为数据,SideNavBar 只渲染。
3. `globalSearch.PAGE_ENTRIES` 从 navConfig 派生(path/labelKey/icon 单源),keywords/同义词留 globalSearch;补平台管理 7 页。
4. 顶栏 8 项能力按 §1 表全部有新家;每个路由页面至少一个导航入口(§6 审计表)。
5. 三断点(≥lg / rail 640–1023 / 手机 <640)全档可用;i18n 双语、五类守卫测试全绿。

**非目标**
- 不改工作台模块内部(WbStage/tab 结构)、设置页既有 tab 结构(仅 general 加主题行)、集群切换面板、UpdateBanner。
- 不引入底部 tab 导航(用户裁决:保持侧栏+footer)。
- 不做 K 轨/W 轨语言重划(维持 2026-09-05 双轨 spec)。

## 3. navConfig 单源(`src/logic/navConfig.js`,新文件)

```js
// 每项:{ icon, labelKey?, label?, route } / ns 组沿用现结构 { labelKey, icon, items:[{icon,labelKey?,label?,routeKey}] }
export const CLUSTER_PRIMARY_NAV    // 总览/节点/命名空间/存储/监控(自 SideNavBar 迁入,原样)
export const CLUSTER_CROSS_NS_NAV   // 新:工作负载/workloads、网络/network、配置/configuration、RBAC/rbac
export const CLUSTER_RESOURCES_NAV  // CRDs…证书(原样)
export const CLUSTER_OTHER_NAV      // 多集群(原样)
export const PLATFORM_ADMIN_NAV     // 用户/组/集群管理/API密钥/AI行为/LLM配置/审计(原样)
export const NS_NAV_GROUPS          // ns 五组(原样)
export const NS_ROUTE_MAP           // routeKey→路由名(原样)
export const WORKBENCH_NAV          // { route:'/workbench', icon:'workspaces', labelKey:'nav.workbench' }
```

- SideNavBar 现有五个内联数组 + nsRouteMap 全部改为消费 navConfig;渲染逻辑(激活态判定、drill 转场)不动。
- globalSearch.js:`PAGE_ENTRIES` 改为「navConfig 全量(集群四组+跨 ns 组+平台管理+WORKBENCH_NAV)+ 固定补充(/settings /audit-logs)」派生,keywords 表保留在 globalSearch(可按 path 覆写)。
- 守护:新增静态测试 `scripts` 侧不动,由 vitest 侧 `navConfig` 单测覆盖——PAGE_ENTRIES 与 navConfig 派生一致性、每条 route 在 router 中存在(防手滑路径)。

## 4. 侧栏改版(SideNavBar.vue)

自上而下八段;标注「不动」的段零行为变化:

1. **集群头部**(不动):三态容器 + ClusterSwitchPanel 通道照旧。
2. **搜索框**(新,顶栏迁入):
   - ≥lg:内联输入框(复用 `nav.searchPlaceholder`),结果面板 Teleport body + fixed 锚定(顶栏 placeDropdown 配方或 useDropdownPanel,宽度 ~288px);SearchResults 组件原样复用。
   - 惰性查询(20 类)与 `searchEnabled`(开框才 enabled)随迁;`nsEnabled` 语义保留(namespaces 常驻查询);无 K8s session 时行为与现顶栏一致(页面搜索可用,资源搜索 401 静默)。
   - ⌘K 全局快捷键随迁(含「焦点在 input/textarea/contentEditable 不抢」守卫;焦点目标是侧栏搜索框)。
   - rail 档(<lg):输入框隐藏、显示搜索图标;点击打开**搜索弹层**(现 <lg modal 整体迁入,rail 专用)。
   - 手机抽屉档(<640):搜索框作为抽屉第一段(集群头部之下);结果面板手机档走贴底 sheet 样式(Z.popover,与 ns bottom sheet 同配方)。
3. **NAMESPACE 坞**(不动)。
4. **滚动导航**(数据源换 navConfig,渲染不动):ns 态 nsNavGroups;集群态 集群管理(主组 + 新「跨命名空间」子组 + 集群资源组 + 多集群组);无集群态仅 CTA 卡。
5. **工作台段**(新;ns/集群/无集群三态恒显——工作台 `requiresCluster:false`):
   - 行形态:品牌渐变瓷砖(workspaces,与今日 pill/门面同配方)+ label + 待审批红数角标;激活态沿用舷板 wbActive 语言(primary-container 填充 + 瓷砖 sheen 一次性扫过)。
   - 悬停面板(≥lg 且指针设备):完整拆迁 WorkbenchEntryPill 面板——汇总 chips / 项目行(≤8)/ 快捷动作(新建/台账/记录)/ stale 降级细字;`isPhone` 禁开守卫保留;新组件 **`WorkbenchNavItem.vue`**(WorkbenchEntryPill 改名重定位,summary 查询、30s 轮询、placePanel 钳制全部随迁)。
   - 手机/rail:无面板,行点击即跳转。
6. **平台管理**(不动,数据源换 navConfig)。
7. **底部行**:
   - 集群态:[活动][告警][设置] 三颗等宽(新增告警 = AlertBell 图标钮形态复用,红点保留);**告警颗 `v-if="!belowSm"`**——手机抽屉打开时抽屉内底部行与 footer 同屏,双挂载即双轮询,手机档告警统一由 footer 承担(§5 互斥规则的另一半)。
   - ns 态 dock:图标行 [设置][事件][活动][告警] 改 grid-cols-4;部署宽条、集群 slab 不动。
   - 无集群态:整行隐藏(现状);**头像行不受此门控**(见下)。
8. **头像行**(新;**三态恒显**——登出/个人中心必须无集群可达):
   - 形态:头像 28px + 显示名 + 角色小字(列向 truncate 元素自带 `w-full`,过 overflow-guard);点击开菜单。
   - 菜单:Teleport body + `useDropdownPanel`(已支持下方放不下自动向上翻,零新代码);内容 = 用户信息头(头像/名/username)+ 个人中心(`/profile`)+ 登出(ConfirmDialog 二次确认,`doLogout` 停 watch 逻辑保留)。
   - **主题/语言快捷切换删除**;设置页 general tab 新增「主题」行(亮/暗/随系统三钮,与语言行同款交互;`preferences.setTheme` 单写路径)。

### UserMenu.vue
文件名保留,内容重写为「头像行 + 向上菜单」;`useAvatar` 共享单例、登出确认流原样保留;UserMenu.test.js 相应重写。

## 5. Footer 改版(AppLayout.vue)

- 桌面(≥640):`[状态文字 flex-1] | [刷新钮] [最后更新 HH:MM:SS] [版本 chip]`。刷新钮插右段最前(**全断点可见**);逻辑自 TopNavBar 随迁(bumpRefresh + `invalidateAllClusterQueries` + 700ms 自旋),AppLayout 已消费 `usePageRefresh().tick`。
- 手机(<640):`[汉堡][告警] [状态文字 truncate] [刷新]`。
  - 汉堡:`shell.toggleDrawer()`,仅 belowSm 渲染。
  - 告警:`v-if="belowSm"` 挂 footer,与侧栏底部行告警颗(`v-if="!belowSm"`,§4.7)**互斥单挂载**,杜绝双实例双轮询;手机抽屉打开时 footer 被抽屉盖住,关抽屉即达。
- 终端任务栏(TerminalTaskbar)与 footer 相邻关系、safe-area padding 不变。

## 6. 导航完备性(每个页面都有入口)

| 页面 | 入口安置 |
|------|----------|
| /workloads /network /configuration /rbac | navConfig「跨命名空间」子组 → 侧栏集群管理板块 |
| /rbac/can-i | 保持搜索可达 + RBAC 页内入口核对(实现时确认,若无则 RBAC 页加链接) |
| /deploy | ns 态 dock「部署」已有;集群态不设(需 ns 上下文) |
| /audit-logs /settings | 底部行已覆盖;/profile 头像行覆盖 |
| 平台管理 7 页 | navConfig 派生后自动进搜索页面表 |

## 7. 双轨 UI 合规

侧栏整体保持 K 轨;工作台段是「K 壳上的 W 舷板」(先例:今日顶栏身份舱),W 词汇(品牌瓷砖/sheen/激活脉冲)限定在该段行内,不向侧栏其他段扩散。`meta.module='workbench'` 白名单、fullHeight 双必备、ui-language-guard 语义均不变。

## 8. 组件生死清单

- **删除**:`TopNavBar.vue`;`WorkbenchEntryPill.vue`(逻辑迁 `WorkbenchNavItem.vue`);搜索 <lg 弹层保留但归侧栏(rail 专用)。
- **重写**:`UserMenu.vue`(头像行);`SideNavBar.vue`(搜索段/工作台段/底部行/头像行/rail+抽屉样式);`AppLayout.vue`(去顶栏,footer 改版)。
- **原样复用**:`SearchResults.vue`、`AlertBell.vue`(换挂载点)、`ClusterSwitchPanel.vue`、`UpdateBanner.vue`、`usePageRefresh`、`useDropdownPanel`、`useAvatar`。
- **注释级清理**:`zScale.js`、`client.js`、`useClusterHealth.js`、`usePageRefresh.js`、`resourceNavigation.js`、`shell.js`、`FloatingWindow.vue`、`TerminalTaskbar.vue` 中提及顶栏的注释更新;`shell-width-guard.test.js` 文件清单去掉 TopNavBar.vue。

## 9. 测试策略

- **删除**:`TopNavBar.test.js` / `TopNavBar.dedup.test.js` / `TopNavBar.workbench-entry.test.js`。
- **重写**:`UserMenu.test.js`(头像行菜单);`WorkbenchNavItem` 测试(承 WorkbenchEntryPill.test.js:角标/面板/轮询/isPhone 禁开)。
- **扩展**:`SideNavBar.*` 系列(搜索框惰性启用、⌘K 守卫、工作台段三态恒显+激活态、底部行告警、头像行无集群恒显、rail 图标、抽屉搜索);AppLayout(footer 刷新、手机汉堡/告警互斥挂载);navConfig 单测(派生一致性 + 路由存在性)。
- **守护全绿**:overflow-guard(头像行/工作台行列向 truncate 带 `w-full`)、mobile-guard、ui-language-guard、shell-width-guard、i18n:check(zh/en 同步新增键:主题行、跨命名空间组、搜索框 aria 等)。
- **手动验证**:本地实例(网关 8899 + vite 5199,devadmin)三断点截图对比;`npm test` + `npm run test:unit` + `npm run build`。

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 手机告警可见性下降(顶栏→footer) | footer 常驻红点;面板 Teleport 配方不变 |
| 搜索迁移丢 ⌘K / 惰性查询语义 | 查询键与 enabled 逻辑逐行随迁;SideNavBar 测试覆盖 enabled 门控 |
| 侧栏纵向空间膨胀(搜索+工作台段+头像行) | 搜索框紧凑单行;工作台段一行;头像行 36px;滚动区本可滚 |
| rail/touch 双 hover 策略破坏 | 新段沿用现有 `.rail:not(:hover)` / `.rail` 双块声明模式(overflow/显隐规则成对写) |
| 双实例告警双轮询 | v-if 互斥单挂载(§5) |
| 无集群态登出不可达回归 | 头像行不受 noCluster 门控,测试钉死 |

## 11. 验收清单

- [ ] 顶栏组件与三个测试文件从仓库消失;grep `TopNavBar` 仅剩历史文档
- [ ] 8 项顶栏能力全部在新家可用(§1 表逐项点验)
- [ ] 每个路由页面 ≥1 个导航入口(§6)
- [ ] 三断点手测:桌面搜索/⌘K/铃铛/头像菜单/刷新;iPad rail 搜索弹层;手机抽屉搜索/footer 汉堡·告警·刷新
- [ ] `npm test`、`npm run test:unit`、`npm run build`、`npm run i18n:check` 全绿
