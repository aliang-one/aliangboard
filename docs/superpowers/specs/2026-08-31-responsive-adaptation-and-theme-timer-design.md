# 响应式适配体系化 + 主题定时自动 设计

- 日期:2026-08-31
- 状态:设计经用户逐节确认(对话内),待实现
- 分支:`worktree-feat-responsive-theme-timer`(worktree,`--no-ff` 合回 main)
- 关联:`docs/superpowers/specs/2026-08-30-workbench-entry-pill-summary-design.md`(WorkbenchEntryPill 的 `lg:` 断点先例)、issue #4 PortSelect Teleport 先例、issue #3 顶栏收缩链先例(8c2a8be)

## 0. 背景与问题

全站 `src/` 内**零响应式断点**:仅有的 2 处 `@media` 均为 `prefers-reduced-motion`。壳层(顶栏/侧栏/底栏)按桌面 ≥1280px 单一形态设计:

- **TopNavBar** 固定宽元素合计 ~900px:集群按钮 ~250px(两行标签 + `max-w-[180px]`)+ 命名空间按钮 ~230px(两行 + `max-w-[160px]`)+ 右区(WorkbenchEntryPill/刷新/分隔线/UserMenu ~370px),而搜索框(`flex-1 min-w-0`)是唯一可收缩项。issue #3(8c2a8be)的「搜索优先收缩」只解决了轻微超宽,吸收不了 iPad 档位的 ~2 倍溢出。
- **SideNavBar** 固定 260px,`AppLayout` 里 `ml-[260px]`(主列)与 `left-[260px]`(加载条)两处硬编码耦合。iPad 竖屏 768px 下内容区仅剩 ~460px。
- **Footer** `justify-between` 长文本无 truncate,iPad 宽度下挤压换行。
- 顶栏集群/命名空间下拉为 `absolute` 定位(`w-80`/`w-72`),窄屏贴边裁切(issue #4 同类)。
- 主题三态 `light/dark/system` 中 system 跟随 `prefers-color-scheme`,用户反馈不正常,要求改为按时间定时自动切换。

另:主题第三态语义替换(用户 2026-08-31 提出「以 7 点为界限自动切换」)并入本期,见 §5。

## 1. 目标 / 非目标

**目标**

1. iPad 竖屏(768–834)与横屏(1024–1366)下壳层完整可用:无横向溢出、无截断、无重叠;桌面(≥1280)形态与现状逐像素一致。
2. 主题第三态改为「定时自动」:07:00–19:00 亮色,19:00–次日 07:00 暗色,到点自动翻转无需刷新。
3. 建立可复用的断点约定与宽度单一事实源,后续视图层适配有章可循。

**非目标**

- 手机竖屏(<768)不做专门设计(图标栏+图标档形态天然继续可用,不保证体验)。
- 66 个视图全面审计——本期只巡检高频页并修「严重溢出」,其余记 backlog。
- 美化性重排、触屏手势优化、iPados 专属分屏适配。

## 2. 断点体系(方案 A:CSS 变量 + Tailwind 默认断点 + 轻量 matchMedia)

裁决:方案 A(机制最少、与 WorkbenchEntryPill 既有 `lg:` 用法同语言)。否决方案 B(集中 layout store,与 CSS 断点双轨)、方案 C(容器查询,Tailwind 3 需插件,收益不值)。

| 档位 | 区间 | 设备 | 形态 |
|------|------|------|------|
| `<lg` | 768–1023px | iPad 竖屏(768/810/820/834) | 侧栏图标栏 72px + 顶栏图标档 |
| `lg` | 1024–1279px | iPad 横屏(1024/1080/1180/1194)+ 小桌面窗口 | 侧栏 260px + 顶栏紧凑档 |
| `≥xl` | ≥1280px | 桌面 | 现状,逐像素不变 |

- 断点一律用 Tailwind 默认值(`lg`=1024、`xl`=1280),**不新增自定义屏幕配置**;时间型变体用 `max-lg:`(Tailwind 3.2+)表达「<lg 时」。
- JS 仅在纯 CSS 表达不了处使用:新增 ~30 行零依赖 `useBreakpoint` composable(matchMedia 封装,查询串可注入供测试),消费方:搜索弹层开关、rail 悬停增强的启用判定。
- 技术红线:壳层组件禁止再出现 `ml-[260px]`/`left-[260px]`/`w-[260px]` 字面量(静态守卫测试强制,见 §7)。

## 3. §1 布局解耦:--sb-width 单一事实源

`AppLayout` 的 `ml-[260px]`(主列 margin-left)与 `left-[260px]`(hydrate 加载条)删除,改消费 CSS 变量;`AppLayout` style 块为唯一定义点(带注释声明唯一来源):

```css
:root { --sb-width: 260px; }
@media (max-width: 1023.98px) { :root { --sb-width: 72px; } }
.shell-main { margin-left: var(--sb-width); }
```

- `SideNavBar` 自身宽度同步读变量(`width: var(--sb-width)`),rail↔完整只动一个变量。
- 纯 CSS 驱动,无 JS 参与;`<768` 时变量维持 72px 不再收缩(侧栏不消失)。

## 4. §2 顶栏三级退化(TopNavBar)

可用宽度 = 视口 − 侧栏(`--sb-width`)− `px-lg`×2(48px)。设计目标预算(实现以真浏览器 DOM 度量复核,数字为目标不是断言):

| 元素 | `≥xl`(现状) | `lg` 紧凑档(固定宽预算 ≤560px) | `<lg` 图标档(固定宽预算 ≤460px) |
|------|------|------|------|
| 全局搜索 | `max-w-md` 常驻 | `max-w-xs` 收窄 | 收成圆形图标按钮 → 点击弹 **Teleport 搜索弹层**(Teleport body + fixed 定位:顶部居中、宽 `min(92vw, 480px)`、贴顶栏下沿,复用现有输入框+结果面板 DOM 与逻辑;Esc/点外/选中后关闭) |
| 集群按钮 | 两行(CLUSTER/名,`max-w-[180px]`) | 去标签行:单行 图标+名(`max-w-[110px]` truncate)+chevron | 同左,名 `max-w-[80px]` |
| 命名空间按钮 | 两行(`max-w-[160px]`) | 同集群紧凑化(`max-w-[110px]`) | 同左(`max-w-[80px]`) |
| WorkbenchEntryPill | 统计条全量 | 统计条断点 `lg:`→`xl:`(该组件内部一处类名;窄档退化到既有徽章形态,已实现) | 徽章形态 |
| 刷新按钮 | 保留 | 保留 | 保留 |
| 竖分隔线 | 保留 | 保留 | 隐藏 |
| UserMenu | 头像+名(`max-w-[120px]`) | 名收 `max-w-[90px]` | 仅头像 |
| 间距 | `gap-lg` | 左区 `gap-md` | 左区 `gap-sm` |

预算校验:`lg` 档固定 ~542px → 1024px 最坏可用 716px,搜索实得 ~174px ✓;`<lg` 档搜索弹层化后固定 ~448px → 768px 竖屏可用 ~648px,余量充足 ✓。

- 搜索弹层开关由 `useBreakpoint` 驱动(`<lg` 才允许弹层化);`≥lg` 恒为内联输入框,行为与现状一致。
- 下拉展开态的既有行为(点外关闭遮罩、选中跳转)不变。

## 5. §3 侧栏图标栏(SideNavBar)

关键前提:侧栏是 `position: fixed`,展开回 260px 时**覆盖在内容上,不推挤布局**,悬停展开因此是纯视觉层行为。

- **宽度**:`--sb-width` 变量驱动(72px / 260px)。
- **内部退化**(全部 `lg:` 前缀,默认=rail、`lg:`=现状):
  - 集群头部:仅 logo(`title` 悬停提示集群名),`lg:` 恢复两行头部;
  - NAMESPACE 坞:`ns-txt` 文字隐藏、`ns-chip` 图标居中,`lg:` 恢复;
  - 导航项:图标 + 下方 9–10px 微标签(图标栏标准型,触屏无 tooltip 也可辨识),`lg:` 恢复横排文字;
  - 底部坞(hero+3 瓦片):收成对应图标钮,`lg:` 恢复。
- **悬停展开**(渐进增强,触屏无 hover 自然跳过):`max-lg` 且 `(hover: hover)` 下 `:hover` 宽度过渡回 260px + 投影;展开态内部渲染与现状完全一致。
- **交互不变**:ns 坞点击语义(进入/返回 ns overview)原样保留,只是 rail 态隐藏文字。

## 6. §4 底栏与浮层

- **Footer**:`<lg` 右组(Last Updated + 版本 chip)`max-lg:hidden`;左组状态摘要 `min-w-0 truncate` 根除挤压;`lg` 起现状。
- **顶栏集群/命名空间下拉**:从 `absolute` 迁移 **Teleport body + fixed 锚定触发元素 rect**(照 `PortSelect.vue` issue #4 先例,zIndex 从 `Z.popover` 取)。iPad 竖屏下拉 `w-80`≈内容区全宽,不迁移必裁切。窗口 resize/滚动时重算或关闭(先例已有做法,沿用)。
- **UpdateBanner**:文本 `min-w-0 truncate` 兜底(一行改动,巡检验证)。

## 7. §5 主题第三态改「定时自动」(theme.js)

- **语义替换**:`'system'` → `'auto'`。规则纯函数:`isScheduledDark(hour) = hour < 7 || hour >= 19`(07:00 含、19:00 不含为亮色)。`isDark = mode==='dark' || (mode==='auto' && isScheduledDark(当前小时))`。**不再读取 `prefers-color-scheme`**,`initTheme` 的 matchMedia 监听与 `systemPrefersDark` 导出删除。
- **到点自动翻转**:模块内 60s interval tick(开销可忽略),边界跨越时 `syncClass` 重翻;启动时立即按当前小时判定。tick 在 `initTheme` 建立,SSR/无 document 环境不建。
- **存量迁移**:localStorage 读到 `'system'` 归一为 `'auto'`(用户无感);light/dark 不受影响。非法值归 `'auto'`(原归 system,语义同步)。
- **首帧双写同步**:`index.html` 内联脚本同步改为同一小时判定(`t==='dark' || (t!=='light' && isScheduledDark(hour))`),否则 19:00–07:00 间刷新先闪白再翻黑。两处以同一注释互相引用,边界常量 `7/19` 字面量保持一致(内联脚本无法 import,靠注释+守卫测试锁一致,见 §9)。
- **UI/i18n**:用户中心(UserProfile)第三选项「跟随系统」→「自动(7:00–19:00 亮色)」,中英双键对齐(`npm run i18n:check` 门禁)。偏好写入链路(preferences store)值域 `'light'|'dark'|'auto'` 同步。
- **可测性**:`isScheduledDark(hour)` 导出纯函数;`applyThemeMode('system')` 归 `'auto'`;测试补 6/7/18/19 四边界 + storage 迁移 + tick 翻转(时钟可注入)。

## 8. §6 高频页巡检与验收

- **档位**:768 / 834 / 1024 / 1280 / 1440 五档(真浏览器 playwright,非 happy-dom)。
- **页面**:ClusterOverview、NamespaceOverview、Pods 列表、NsWorkloadDetail(2524 行,重点)、Workbench、UserProfile、admin clusters。
- **判定**:度量 `scrollWidth vs clientWidth` + 截断/重叠探查;**只修「严重溢出」**(横向滚动/元素被截断/元素重叠),美化性重排与低频页面问题记 backlog 不修。
- **登录前置**:巡检需登录态,执行阶段由用户在自动化浏览器登录一次(或提供测试凭证)。

## 9. 测试策略

吸取既有教训:「单测锁不了几何」「happy-dom 无真 rect」——几何断言只出现在真浏览器层。

1. **纯逻辑 vitest**:`useBreakpoint`(matchMedia 可注入 mock)、`isScheduledDark` 边界(6/7/18/19)、storage `'system'`→`'auto'` 迁移、搜索弹层开关状态机。
2. **组件挂载断言(弱,防断裂)**:rail 微标签类、顶栏 `max-lg:` 关键退化类在 DOM 中存在;搜索弹层 Teleport 到 `document.body`。
3. **静态守卫(node 风格 grep 测试)**:
   - 壳层三文件(AppLayout.vue(含 Footer)/TopNavBar.vue/SideNavBar.vue)禁止 `ml-[260px]`/`left-[260px]`/`w-[260px]` 字面量;
   - `index.html` 内联脚本与 `theme.js` 的边界常量 `7`/`19` 同时存在(防单边修改造成首帧/运行时不一致)。
4. **几何验收(人工执行,真浏览器)**:§8 五档×七页 DOM 度量,结果记入实现计划的手测清单。
5. **既有门禁**:`npm test` / `npm run test:unit` / `npm run typecheck` / `npm run i18n:check` 全绿;注意并行 vitest 串扰偶发(基线已证实 WorkbenchChat 单跑全绿)。

## 10. 风险与权衡

- ~~`max-lg:` 变体依赖 Tailwind ≥3.2~~ **已核实**:本仓 tailwindcss 3.4.19,`max-*`/任意变体完整支持,无需降级路径。
- **rail 悬停展开在触屏上的 sticky-hover**:iPad 点击可能触发 `:hover` 粘滞——已用 `(hover: hover)` media 门控,理论规避,巡检时实测。
- **Teleport 下拉与既有「点外关闭」遮罩交互**:现有 `fixed inset-0 z-30` 遮罩与新浮层层级需按 `zScale` 重排,防止遮罩盖住浮层。
- **主题切换瞬间的图表配色**:`tokenHexR` 响应式取色已存在,tick 翻转走同一 `isDark` computed,无需额外处理。
- **`<768` 无设计**:变量/类在极窄下维持 `<lg` 形态,不做额外保证(非目标)。

## 11. 交付后手测清单(实现计划中展开为逐项)

1. iPad 竖屏(DevTools 768×1024):顶栏图标档、侧栏图标栏、搜索弹层、集群/ns 下拉、Footer。
2. iPad 横屏(1180×820):紧凑档全元素、侧栏 260px、统计条徽章形态。
3. 桌面 1440:与改动前逐像素对照(回归红线)。
4. 主题:19:00/07:00 边界模拟(注入时钟/改系统时间)翻转;刷新无首帧闪烁;存量 'system' 用户迁移。
5. 悬停展开:鼠标 hover 侧栏展开/移出收起;触屏点击直达。
