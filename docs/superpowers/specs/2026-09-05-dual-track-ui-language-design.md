# 双轨 UI 语言宪章(K 轨 × W 轨)(2026-09-05)

> 本文是项目级设计宪法,由 workbench 模块身份设计
> (2026-09-05-workbench-module-identity-design.md)升华而来。它回答一个问题:
> **为什么有些界面长得像「管理面板」,有些像「独立应用」——以及边界在哪。**
> 执行层入口:CLAUDE.md 架构约束「双轨 UI 语言」条;守卫:`scripts/ui-language-guard.test.mjs`。

## 1. 双轨定义

| | **K 轨——平台通用语** | **W 轨——模块自有语** |
|---|---|---|
| 服务对象 | K8s 资源的映射与操作(Namespace/Workload/网络/存储/配置/RBAC…) | 平台自研概念(workbench:AI 项目/服务器/知识/记录/chat agent) |
| 空间形态 | **全幅平铺**:内容即页面,与视口同宽流动 | **有界空间**:氛围画布上的圆角舞台(`WbStage`),平台是地板,模块是房间 |
| 表面 | 中性 M3 面(surface 族),条带式 chrome(border-b 分段) | 舞台浮起面 + 回声线;chrome 弱化为舞台内部分隔(/40) |
| 滚动 | 文档式(main 滚动) | 应用式(fullHeight,内容区自管滚动) |
| 氛围 | 无。信息密度优先 | 有。绿雾+辉光+点阵三层画布(`wb-atmosphere`) |
| 动效 | 通用转场(fade) | 专属动效词汇:wb-enter(方向性入场)/ wb-rise(stagger 落位)/ wb-pulse(激活脉冲)/ sheen(门面高光) |
| 门面 | 无模块门面;顶栏是全局导航 | 舞台标题栏 = 模块 logo(32px 品牌瓷砖+一次性 sheen) |

**一句话:平台是平的,模块是空间。**

## 2. 归属判定(一条判断句)

> **这个界面服务的是「K8s 资源的映射与操作」,还是「平台自研的概念」?**
> 前者 → K 轨;后者 → W 轨。

边界案例与既定裁决:
- **集群台账(WorkbenchLedger)**:内容是 K8s 资源知识,但它是 workbench 概念的知识域产物 → **W 轨**(双重消费裁决:舞台归页壳 `WorkbenchLedgerPage.vue`,内容组件 `WorkbenchLedger.vue` 保持纯净、以 `chromeless` prop 适配宿主——被 Shell 知识 tab 内嵌时不带舞台只带内容标题)。
- **SSH 终端/日志弹窗(SshTerminalPopup/log-popup)**:workbench 域的产物但自身已是独立窗口形态(无 AppLayout chrome)→ **两轨之外**,不加氛围不加舞台。
- **未来可能的自研概念**(审计中心、巡检中心等):按判定句入 W 轨,走 §6 接入清单;**不要**因为「也是管理功能」而留在 K 轨——K 轨的通用性是给「K8s 资源」的,不是给「管理类功能」的。

## 3. K 轨语汇(平台通用语,现状固化)

- 页面:全幅、`bg-surface`、文档式滚动;列表/表格/详情沿用既有 DataTable/FilterBar 语汇。
- chrome:条带式(border-b 分段),无圆角容器包裹。
- 转场:统一 `fade`(workbench 方向性入场是 W 轨专属)。
- **禁**:氛围层、舞台容器、模块门面、wb-* 动效词汇。

## 4. W 轨语汇(模块自有语,已实现机制与文件指针)

| 机制 | 文件 | 说明 |
|---|---|---|
| 路由标记 | `src/router/index.js` | `meta.module = 'workbench'` + `fullHeight: true`(缺一不可,守卫强制) |
| 氛围画布 | `src/styles/main.css` 的 `.wb-atmosphere`(AppLayout main 按 meta 挂类) | 三层:绿雾(main 本体渐变)/ 辉光(`::before`,原点 92% 0%=舷板方位,入场 `wb-glow-in` bloom)/ 点阵(`::after`,24px 网格);两伪元素 pointer-events-none |
| 舞台 | `src/components/workbench/WbStage.vue` | 圆角容器+描边+回声线(inset 3px、rounded-[13px]=16-3 同心);slots:`titleBar`(可选)/ default(flex-1 min-h-0);根 h-full 依赖 fullHeight 契约 |
| 门面 | 各页 titleBar | 32px 品牌瓷砖(from-primary to-primary-container + 内高光,双绿纪律)+ 一次性 sheen + 标题 + ghost 返回钮 |
| 动效 token | `tailwind.config.js` | `panel-in` / `wb-pulse` / `wb-rise` / `breathe` / `sheen`;转场 `wb-enter`(main.css) |
| 页面骨架 | `section.h-full.min-h-0.p-md` → WbStage → 内容区 `flex-1 min-h-0 overflow-y-auto` | 高度链契约:chat 输入框贴底不悬空;见任一舞台页现例 |

## 5. 交叉禁区(两轨不得互相污染)

1. **K → W 禁**:K8s 页面禁挂氛围/舞台/门面/wb-* 动效;K8s 路由禁打 `meta.module`(守卫白名单强制)。
2. **W → K 禁**:W 轨页面禁引入 K 轨的条带式 chrome 语言(border-b 实色分段条)做顶层结构——舞台内的分隔线一律 /40 弱化。
3. **共享组件适配律**:同一内容组件被「舞台页」与「tab 内嵌」双重消费时,舞台归**页壳**,内容组件保持纯净并以 props 适配宿主(先例:`WorkbenchLedger` 的 `chromeless`)。禁止在内容组件里探测环境或双形态硬编码。
4. **品牌纪律两轨通用**:品牌色只走 primary 族(禁橘令);透明度落 5 的倍数刻度;新动画必须 motion-reduce 兜底且静止态=自然态。

## 6. 新自研模块接入清单(W 轨 onboarding,五步)

1. `src/router/index.js`:路由 meta 加 `module: '<模块名>'` + `fullHeight: true`;并把模块名加进 `scripts/ui-language-guard.test.mjs` 白名单。
2. 氛围:复用 `wb-atmosphere` 起步(现由 `module==='workbench'` 条件驱动;第二个模块出现时把条件改为集合成员判断,并评估是否需要模块差异化氛围——届时再抽象,**不要提前**)。
3. 舞台:复用 `WbStage`,页面骨架照 §4 高度链契约。
4. 门面:titleBar 放模块门面(可复用品牌瓷砖配方);动效只用既有 token,新增 token 须入 `tailwind.config.js` 并带 reduced-motion 兜底。
5. 契约测试:meta 守卫自动覆盖;页面 motion/结构契约仿 `WorkbenchShell.motion.test.js`。

## 7. 守卫与演进

- 守卫:`scripts/ui-language-guard.test.mjs`(npm test 链内)——①`meta.module` 值白名单;②凡打 module 标记的路由 meta 必须含 `fullHeight: true`。
- 演进规则:双轨语汇的任何变更(新 token、氛围参数、舞台形态)先改本宪章再改码;宪章与代码不一致时,以「补宪章或修代码」收口,不允许静默漂移。
- 抽象门槛:第二个 W 轨模块落地前,禁止把氛围/门面抽象成配置系统(YAGNI)。
