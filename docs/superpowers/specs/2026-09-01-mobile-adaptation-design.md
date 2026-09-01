# 手机端(窄屏)全量适配设计——应急运维优先

日期:2026-09-01
分支:worktree-feat-mobile-adaptation
状态:设计定稿(用户已确认全量适配+手机原生习语+分期波次)

## 1. 背景与目标

平台当前只有 1 个响应式断点(≤1023.98px,iPad 界限:侧栏收 72px 图标栏),无任何手机级断点。
手机(<640px)上:顶栏按钮不收缩、46 个视图的 Modal 超宽、32 个视图的 DataTable 只能横向滚、
hover 依赖的动作/浮层触屏点不到——紧急线上修复场景几乎无法操作。

**目标**:全量适配 74 个视图;手机原生习语(表格→卡片、Modal 全屏、下拉→bottom sheet、
hover→常显);应急修复闭环(找负载→看日志→止血动作→AI 审批)在手机上全程可完成、且打磨最深。

**非目标**:不做独立移动端路由族(/m/);不做手势导航/下拉刷新/PWA;不改桌面端既有交互
(<640 之外的一切行为不变,包括 iPad 1023.98px 既有收缩档)。

## 2. 断点与响应式架构(单一事实源)

- 采用 tailwind 3.4 默认断点:`sm=640 / md=768 / lg=1024`。
  - 手机主战场:`<640`(tailwind `max-sm:` / JS `isPhone`)
  - 既有 1023.98px 侧栏收缩档保留(=lg),行为不变
- **扩展现有 `useBreakpoint`**(`src/composables/useBreakpoint.js`,收编既有调用方,不另起 composable):
  - 新增常量 `MQ_BELOW_SM = '(max-width: 639.98px)'`(与 tailwind sm=640 对齐,1023.98 同款避整数像素边界抖动);
  - 新增 `useIsPhone()`:`useBreakpoint(MQ_BELOW_SM).matches` 的语义化薄封装;
  - 职责边界:结构性切换(表格↔卡片、下拉↔bottom sheet、图标栏↔抽屉、Modal 全屏)用 `v-if="isPhone"`
    ——同一份列 slot 不得双渲染;纯视觉收缩(按钮 padding、字号、隐藏次要项)用 tailwind `max-sm:` 类。
- CSS 变量沿用 `--sb-width` 模式,AppLayout 媒体查询追加手机档。
- 浮层层级一律从 `src/styles/zScale.js` 取值(新浮层禁止裸 z-index,issue#4 既定裁决)。

## 3. 壳层(AppLayout)

- **侧栏**:
  - `≥640`:现有 72px 图标栏(含停靠坞/ns 按钮)**零改动**;
  - `<640`:抽屉 overlay——顶栏汉堡按钮开合;内容=导航项+ns 切换坞;遮罩点击/路由跳转后关闭;
    层级走 zScale(popover 档);焦点管理:开抽屉聚焦首项、Esc 关闭(可达性顺手,不做完整焦点陷阱)。
- **顶栏**:保留既有三级收缩,追加手机档:
  - 集群/ns chip **保留为可点徽标**(已按 overflow-guard V1 治理截断,手机档不隐藏——集群切换
    在手机上必须直达;其下拉面板的手机优化归 1b bottom sheet 波次);新增汉堡按钮(仅手机档)
    开合侧栏抽屉;
  - 搜索入口、用户菜单保留,触控目标 ≥40px;
  - 遵循 `063845c` 溢出治理配方(CLAUDE.md「组件文本溢出治理」节)。
- **安全区**:`padding: env(safe-area-inset-*)` 应用于壳层底部与全屏 Modal 底部动作条;
  viewport meta 已正确(`width=device-width`),index.html 不动。

## 4. 通用组件触屏化(一次改造,全站受益)

| 组件 | 手机档(<640)行为 | 桌面档 |
|------|------------------|--------|
| Modal(46 视图) | 一律全屏:`w-full h-full max-w-none rounded-none`+(底部动作条固定+安全区);`isPhone` 自动生效,**不新增逐页 prop**;现有 `maximizable` 基建复用 | 现状不变 |
| DataTable(32 视图) | 卡片模式(§4.1) | 现状不变 |
| DropdownMenu 及各类下拉 | Teleport + 底部弹出面板(bottom sheet),点击触发,从 zScale 取层 | 现状(absolute 遗留不在本期扩面) |
| hover 显隐动作区 | 常显(`max-sm:` 解除 group-hover 隐藏) | 现状 |
| 触控目标 | 按钮/可点行 ≥40px(padding 阶梯调整,**不改字号体系**) | 现状 |
| FilterBar | 筛选条件收进可展开面板(点击展开) | 现状 |
| SplitButton | 主动作+展开菜单(点击) | 现状 |
| ConfirmDialog | 全屏化(Modal 同款) | 现状 |

### 4.1 DataTable 卡片模式(关键设计)

- 现状:单元格经**作用域 slot**(`#<columnKey>`)渲染,fallback `{{ row[header.key] }}`;
  系统列 selectable/expandable;行点击 `row-click` 事件。
- 卡片模式实现于 **DataTable 内部**,所有消费方零改动:
  - `<640`(`isPhone`):不渲染 `<table>`,每行渲染一张卡片——
    首个**数据**列(系统列除外)的 slot 作卡片标题(加粗);其余列渲染「列名(header.label)+slot 内容」键值行;
    selectable → 卡片右上角 checkbox(`@click.stop`);expandable → 标题行 chevron 展开钮;
    `row-click` 语义保留(点卡片主体=原行点击)。
  - **slot 复用是核心**:卡片里的每个值仍走原视图的列 slot 渲染器(状态 chip/操作按钮/时间格式化原样生效)。
  - 分页 slot 照常渲染在卡片列表底部;空状态复用现有 UI。
- 拒绝方案:CSS 双渲染(同一 slot 内容 DOM 出两份,浪费且交互态易串)。

## 5. 应急闭环页面(第二波,打磨最深)

旅程:找到负载 → 看到异常 → 看日志/进终端定位 → 重启/回滚/伸缩止血 → AI 干活+审批。

| 环节 | 要点 |
|------|------|
| 工作负载列表 | 卡片模式自动生效;「创建/从 YAML」动作收 bottom sheet;危险动作保留二级确认 |
| Pod 详情 | 动作按钮常显大目标;容器切换→bottom sheet |
| 日志查看器 | 全屏化;自动滚动开关;字号调节;换行默认开(排障主战场) |
| 终端(xterm) | 字号/滚动适配+**按键工具条**(Esc/Tab/↑↓/Ctrl/C)——无物理键盘 exec 刚需 |
| 重启/回滚/伸缩 | 详情页 sticky 动作条;ConfirmDialog 全屏;误触防线(审批/确认)不放松 |
| 工作台 AI | ChatModal 全屏;**审批横幅 sticky 底部+大按钮**(单手可批);@-mention/工具 chips 可点不误触 |

## 6. 测试与守卫

- **vitest 组件测试**(结构性切换的主防线,happy-dom):
  - `useViewport`:matchMedia mock 下 isPhone 翻转、单例共享;
  - DataTable:卡片模式渲染(slot 复用/标题列/checkbox.stop/expand/row-click/分页 slot/空态)、
    桌面档不回归;
  - Modal:isPhone 全屏类生效、width prop 在手机档被忽略;
  - 壳层抽屉:开合/遮罩关闭/路由跳转关闭。
- **overflow-guard V3 扩展**(静态,务实范围——只锁可静态判定的):
  - 新增浮层组件必须 Teleport + zScale 取层(禁止裸 z-index 新增);
  - 交互行内禁新增 hover-only 动作类(配对常显类缺失即红)。
  - 几何类问题静态锁不住,诚实交由真机手测(既有教训:单测锁不了几何)。
- **真机手测清单**(每波合并前):375/390/430 三档宽度抽查明暗两主题。

## 7. 波次与交付

| 波次 | 内容 | 交付物 |
|------|------|--------|
| **1a** | 断点体系+useViewport+壳层(抽屉/顶栏/安全区)+Modal 全屏化 | 本 worktree 分支,门禁+真机手测后 `--no-ff` 合 main |
| **1b** | DataTable 卡片模式+下拉 bottom sheet+hover 常显+触控目标 | 同 worktree 接续,独立合并 |
| **2** | 应急闭环页逐页手术:列表/Pod 详情/日志/终端/工作台对话+审批 | 按页拆小合并 |
| **3+** | 长尾按域批量:NS 域 → 存储/网络域 → 管理域 → SSH/工作台服务器知识 | 每域一个 worktree 一合并 |

每波独立过门禁(npm test / test:unit / typecheck / i18n:check)+真机手测,`--no-ff` 合 main(仓库既定流程)。

## 8. 成功标准

1. 手机(<640px)上应急修复闭环全程可完成:找负载→看日志→重启/回滚/伸缩→AI 审批;
2. 触控目标 ≥40px;无横向页面溢出(overflow-guard V3+手测);
3. 无 hover-only 功能(触屏可达);
4. 桌面/iPad 既有行为零回归(既有 1023.98px 档不变);
5. 长尾域按波次逐批清零,最终 74 视图全量覆盖。

## 9. Wave 1a 真机手测清单(375/390/430 三宽 × 明暗两主题)

1. 手机档汉堡出现;点击抽屉平移入场,导航项/ns 坞可点;点遮罩/Esc/跳转路由均收起
2. 抽屉在场时顶栏不可点穿(遮罩盖住);抽屉 zIndex 高于顶栏
3. 内容满宽无左侧空条(--sb-width:0);footer 不被 iPhone 底条遮住(安全区)
4. 任意 Modal(如 创建资源/Scale)手机档全屏、动作条贴底带安全区;桌面档宽度不变
5. iPad 宽度(768/1000)侧栏仍为 72px 图标栏(hover 展开);桌面(≥1280)完整侧栏——零回归
6. 无 #actions 槽的全屏 Modal（ChatModal/ToolCallModal 等）手机档内容滚到贴底缘无安全区——Wave 2 处理,先确认可用性

## 10. Wave 1b 真机手测清单

1. 任一 DataTable 列表页(NsServices/NsWorkloads/NsConfigMaps 等):卡片呈现——首列标题加粗、键值行对齐、状态 chip 正常;点卡片进详情
2. 卡片 checkbox 勾选不误触进详情;批量删除按钮可达
3. 表格行 DropdownMenu:底部弹出面板、菜单项 ≥40px、点遮罩关闭、危险项红色
4. 筛选钮展开/收起;结果计数与重置恒可见
5. SplitButton/确认弹窗:全屏、按钮好按;终端任务栏 chip 的关闭 × 手机可见可点
6. 桌面/iPad:列表仍表格、下拉仍锚定浮层、筛选仍平铺——零回归
