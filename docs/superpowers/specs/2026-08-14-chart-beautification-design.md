# 图表美化(ECharts 接入 + MD3 主题 + 状态可视化升级)

> 状态:设计已与用户逐节确认(方案 A:薄封装 + 按图表类型重建组件;ECharts;MD3 一致 + 渐变动画;四类图表全覆盖)。待写实现计划。
> 日期:2026-08-14。分支:`worktree-feat-chart-beautification`(自 main `179a3ad`)。
> 依赖裁决:`echarts` 新增为 runtime 例外,登记 CLAUDE.md 例外表。

## 1. 背景与动机

用户反馈:图表(pod 运行状态、集群概览等)视觉单调。现状盘点:

- **全部可视化 100% 自研**:MiniChart(纯 SVG 折线,3 处使用)、ClusterOverview 手画环形表盘、ProgressBar(纯 CSS)、StatusChip(色点徽章)。
- **无 tooltip、无平滑曲线、无入场/过渡动画、无交互**——朴素到单调。

探索中发现一个**隐藏 bug,是「单调」的重要元凶**:

> `var(--md-sys-color-primary)` 等 CSS 变量在全仓 **18 处被使用、0 处被定义**(src/styles/main.css、index.html 均无)。MiniChart 的折线色与渐变色实际是无效值,浏览器解析失败后回落为黑/无色,图表一直不是设计色(翡翠绿/琥珀)。同批受影响:`DataTable.vue`、`ColumnManager.vue`。

用户裁决(2026-08-14 会话):
- 范围:MiniChart 折线、Pod/资源状态可视化、集群概览仪表盘、ProgressBar——**全覆盖**。
- 路线:**引入 Apache ECharts**(放弃纯自研增强;放弃 Chart.js/ApexCharts)。
- 风格:**MD3 一致 + 渐变动画**(放弃监控大屏风/保守微调)。
- 架构:**方案 A**——薄封装基座 + 按图表类型建业务组件;ProgressBar/StatusChip 保留 CSS 实现只做视觉增强。

## 2. 目标 / 非目标

**目标**
- 三类图表升级为 ECharts:折线面积图(AreaLineChart)、状态环形分布(StatusSummaryCard/DonutChart)、环形表盘(RingGauge)——平滑曲线、渐变、hover tooltip、过渡动画。
- MD3 色板单一来源化(`md-palette.js`),并**修复 18 处 var() 未定义 bug**。
- ProgressBar CSS 视觉增强(渐变/过渡/高危斜纹)。
- 视图数据流**零改动**(session 采样逻辑留在视图层)。
- 按需引入控制包体(gzip 增量 ≈100KB 量级,build 后验证)。

**非目标**
- 不加新数据、新指标、新页面(只美化既有展示)。
- 不动 StatusChip(已够好)。
- 不做暗色主题切换(只保证将来换肤 = 改一个 palette 文件)。
- 不把 ProgressBar/StatusChip 换成 ECharts(列表页几十个实例不划算,且丢 Tailwind 主题一致性)。
- 不引入 vue-echarts 封装库(自写 ~80 行薄基座,少一个依赖)。

## 3. 架构

### 3.1 依赖与注册入口

- 新增 `echarts`(dependencies,^6)。**只按需引入**,唯一注册入口 `src/lib/echarts.js`:
  - `echarts/core` + `LineChart` / `PieChart` / `GaugeChart`
  - `TooltipComponent` / `GridComponent` / `MarkLineComponent`(refLines 用;不引 LegendComponent——图例走 HTML)
  - **`SVGRenderer`**(数据 ≤30 点,SVG 更清晰、小尺寸不糊、happy-dom 可测;不用默认 Canvas)
  - `echarts.registerTheme('md3', …)`:字体栈、tooltip 样式(surface-container 底、圆角、阴影)、轴线/splitLine 色(outline-variant 低透明度)、动画时长与缓动。
- 所有图表组件**只从 `@/lib/echarts` import**,保证 tree-shaking 生效。

### 3.2 基座组件 `EChart.vue`(src/components/common/,~80 行)

- props:`option`(Object)、`height`(px,必填,容器无默认高度)。
- 生命周期:`onMounted` → `echarts.init(el, 'md3', { renderer: 'svg' })`;`ResizeObserver` 自适应;`onUnmounted` → `dispose`。
- `watch(option)` → `setOption(option)`(默认 merge 模式,series 带 `id`)——滚动窗口更新时 ECharts 自动做数据过渡动画,而非整图重绘。
- 容器 0 尺寸(集群切换/隐藏)安全:resize 静默。

### 3.3 MD3 色板单一来源 + bug 修复

- 新建 `src/styles/md-palette.js`:导出 MD3 全套 token→hex(surface 系、primary 系、secondary 系、tertiary 系、error 系、status 系)。**全仓唯一 hex 来源**。
- `tailwind.config.js` 改为 import 该模块展开 `colors`(precedent:该文件已 import `code-theme.js`)。**行为等价重构**——色值不变,只是来源归一。
- 启动时(main.js 或 styles 模块)把 palette 注入 `:root` 的 `--md-sys-color-*` CSS 变量(~10 行代码生成 `<style>`)→ **18 处既有 var() 引用全部立即修复**(含 DataTable/ColumnManager)。
- 风险:修好后这两个组件的颜色从「回落色」变为设计色,需目检其所在页面(表格全站都有)。

### 3.4 业务图表组件 + 纯函数 option builder

option 构建逻辑抽为 `src/lib/chart-options.js` 纯函数(**零依赖可测,走自研运行器**);组件只是壳(props → builder → EChart)。

| 组件 | 替代/用途 | 关键能力 |
|---|---|---|
| `AreaLineChart.vue` | MiniChart 三处(ClusterOverview 128px 两张 / MonitoringCenter 48px sparkline 两张 / NsWorkloadDetail 72px 两张带 refLines) | props:`series: number[]`、`color`、`unit`、`height`、`refLines: [{label,value,color}]`、`spark`(true=无网格无 refLine 的 KPI 模式)、`smooth`(默认 true)、`sampleIntervalSec`(默认 10,三视图采样间隔一致)。平滑曲线 + 面积渐变(ECharts LinearGradient,色值→同色 0.02)+ hover tooltip(x 轴为相对时间标签,由 sampleIntervalSec 推出 `-120s`…`0s`,**语言中立免 i18n**)+ refLines 用 markLine 虚线,**图例 footer 沿用 MiniChart 现有 HTML 形式**;series<2 显示空态占位 |
| `StatusSummaryCard.vue`(内含 donut) | NsPods 状态摘要栏(4 格卡片) | 左:环形分布图(PieChart,`borderRadius` 圆角扇区,中心 HTML 叠加总数);右:图例列表(Total/Running/Pending/Failed,色点+计数,**点击过滤=等价保留现有交互**,选中态高亮 ring)。数据:Running/Pending/Failed + 其余归 Other |
| `RingGauge.vue` | ClusterOverview 节点 CPU 环(6 个/页) | GaugeChart 进度环:渐变 itemStyle、数值变化过渡动画;tooltip 关闭、`pointer-events: none`(卡片本身是 router-link);**中心 %/CPU 文字保持现有 HTML 叠加**;`value==null` 空态画灰环 |

### 3.5 ProgressBar CSS 增强(不用 ECharts)

- 填充加纵向渐变:按阈值档位三套渐变(primary/tertiary/error 各自 `X → X-container` 方向),色值 import `md-palette.js`,以**内联 style `linear-gradient`** 实现(避免新增 CSS 工具类)。
- 宽度过渡升级:`duration-500` → `duration-700 ease-out`。
- `>80%`(error 档)加**斜纹滚动动画**(repeating-linear-gradient + keyframes,复用 tailwind `animation` 配置位),视觉示警。
- 阈值逻辑(>80 error / >60 tertiary / 其余 primary)**不变**。

## 4. 视图改造(数据流不动,只换展示层)

| 视图 | 改动 |
|---|---|
| `ClusterOverview.vue` | 两张 128px MiniChart → AreaLineChart;节点卡 SVG 环(180-194 行)+ `gaugeClass` → RingGauge;内存 ProgressBar 不动(自动获得增强);采样 timer/`tick()` 不动 |
| `MonitoringCenter.vue` | KPI 卡两张 48px MiniChart → AreaLineChart `spark` 模式 |
| `NsWorkloadDetail.vue` | 1516/1526 行两张 MiniChart → AreaLineChart,**refLines(requests/limits)与图例 footer 完整保留** |
| `NsPods.vue` | 140-161 行 4 格状态栏 → StatusSummaryCard(点击过滤行为等价;`statusFilter` 状态与 select 过滤器联动不变) |
| `MiniChart.vue` | 3 处引用迁移完**删除** |

## 5. 边界与错误处理

- **空数据/指标不可用**:沿用视图现有门控(`metricsAvailable` 徽章、`—` 占位);图表自身 series<2 → 空态(淡字「暂无数据」,i18n 键若已有则复用,无则新增 `common.noData`)。
- **集群切换**:EChart dispose/重建由组件生命周期兜住;容器 0 尺寸 resize 静默。
- **性能**:单页 ECharts 实例上限 ≈ 10(ClusterOverview 2+6、Monitoring 2),SVG 渲染器无压力;滚动窗口 merge 更新避免整图重绘。
- **回归风险**:palette 注入修复 var() 后 DataTable/ColumnManager 颜色会「变对」,目检确认无违和。

## 6. 测试

- **`src/lib/chart-options.js` 纯 builder** → `npm test`(自研零依赖运行器,符合仓库约定):断言渐变 stop、markLine 数量/虚线、smooth/spark 开关、空态分支、donut 数据归并(Other)、gauge 阈值色。
- **`EChart.vue` 生命周期** → vitest + `vi.mock('@/lib/echarts')`:init(theme='md3')/setOption/resize/dispose 调用序与 watch 触发。
- **业务组件 mount** → vitest:props→option 传递、StatusSummaryCard 点击 emit 过滤事件、空态渲染分支。
- **回归**:`npm run typecheck` + `npm run build`(vue 模板)+ Playwright 截图目检(重点:DataTable/ColumnManager 页面、四张改动的视图)。

## 7. 交付物清单

新增:`src/lib/echarts.js`、`src/lib/chart-options.js`、`src/styles/md-palette.js`、`src/components/common/EChart.vue`、`AreaLineChart.vue`、`StatusSummaryCard.vue`、`RingGauge.vue`(+ 各自测试)。
修改:`tailwind.config.js`(色板来源归一)、`src/main.js`(palette 注入)、`ProgressBar.vue`、四视图、`CLAUDE.md`(echarts 例外登记)、i18n 文件(空态键,如需)。
删除:`MiniChart.vue`。
