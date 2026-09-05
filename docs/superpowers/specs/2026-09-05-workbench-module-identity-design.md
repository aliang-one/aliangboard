# Workbench 模块身份设计:氛围 × 舞台 × 门面(2026-09-05)

> 背景:平台整体围绕 K8s 资源管理(全幅平铺、中性 M3 面),workbench 是自研独立概念
> (AI 项目/服务器/知识/记录 + chat agent)。现状:进 workbench 只有转场不同,内容域的
> 容器结构与 K8s 页面同构——概念独立性缺乏视觉承载。
> 目标:**「平台是平的,工作台是一个空间」**——用氛围、容器、门面三支柱建立模块身份,
> 与 K8s 管理面板形成系统性对比。
> 前置:v4 舷板已合 main(方向性入场 wb-enter、panel-in、sheen、灯珠等动效词汇已就位),
> 本设计是它的空间化延伸。用户裁决记录:概念定位选「氛围+独立舞台」档(弃仅氛围/全域深改)。

## 0. 设计原则(先立规矩)

1. **纯表现层**:零数据层/逻辑改动;WorkbenchDetail(510 行 chat)只做外层包装手术,
   dirty-confirm 等内部逻辑零触碰。
2. **K8s 域零改动**:差异化靠对比成立;K8s 页面保持全幅平铺中性面。
3. **品牌色纪律**(v4.1 禁橘令延续):氛围/舞台只走 primary 族;tertiary 只留语义性小徽章。
4. motion-reduce 全链兜底;动画静止态=自然态(无 fill 依赖),animate-none 恒安全。
5. 透明度一律落 Tailwind 刻度(5 的倍数,overflow-guard V5);main.css 裸 CSS 不受限但同纪律。

## 1. 模域与路由

workbench 内容域 = 3 条路由(AppLayout 内),全部打 `meta.module = 'workbench'`:

| 路由 | 视图 | 现状 meta | 变更 |
|---|---|---|---|
| `/workbench` | WorkbenchShell(四 tab) | fullHeight | + module |
| `/workbench/ledger` | WorkbenchLedger(台账) | 无 fullHeight(文档式) | **+ fullHeight + module**(归队进舞台域) |
| `/workbench/:id` | WorkbenchDetail(项目 chat) | fullHeight | + module |

不含 `SshTerminalPopup` / `log-popup`(AppLayout 之外的独立弹窗页,本身已是「窗口」形态)。

## 2. 氛围画布(wb-atmosphere)——模块的空气

AppLayout `<main>` 在 `route.meta.module === 'workbench'` 时叠加 `wb-atmosphere` 类
(现 fullHeight 分支逻辑不变,只叠加)。**仅 fullHeight 路由进域**(main overflow-hidden,
画布层稳定不随滚动)——ledger 归队后三路由全满足。

三层(全 CSS 渐变,零图片;伪元素层级见下):

| 层 | 载体 | 视觉 | 概念 |
|---|---|---|---|
| 绿雾 | main 自身 background-image | `radial-gradient` primary 极低 alpha(亮 /5、暗 /8)大范围铺满 | 模块的空气 |
| 辉光 | `::before`(absolute inset-0,pointer-events-none) | 右上角集中光斑:`radial-gradient(~520px circle at 92% 0%, primary 亮 /10、暗 /15, transparent 70%)`——**原点=舷板方位** | 光源;模块从入口生长出来;入场 bloom 点亮 |
| 点阵 | `::after`(absolute inset-0,pointer-events-none) | `radial-gradient(circle, outline-variant 亮 /25、暗 /15, 1px, transparent 1px)`,24px 网格 | 「工作台面」肌理——K8s 光滑平面 vs 这里是案台 |

### 绘制层级与指针
- 两个伪元素 `position:absolute; inset:0; pointer-events-none`,树序在内容前 → 内容
  (transition 包裹 div)加 `relative` 后按树序绘制在伪元素之上。
- transition 包裹 div 的 `relative` 对非 workbench 路由无副作用(无 z-index,纯绘制顺序)。

### 入场编排(与既有 wb-enter 同步)
- 辉光层 `wb-glow-in` keyframes:opacity 0→1,600ms `cubic-bezier(0.22,1,0.36,1)`——「灯亮了」。
- 雾/点阵常显(挂类即有;不做动画——一次性入场只有光源是「事件」)。
- reduced-motion:`.wb-glow-in` 类下媒体查询直接 opacity:1 无动画。

### 数值基准(实现时浏览器实测微调)
- 亮色雾 /5 在 #f8f9ff 上可感知但不抢内容;暗色 mint 雾在 #111418 上 ≈1.1:1 属
  「可感知阈值」,实测调至不脏不灭。
- 点阵 24px 网格在 1x 屏避免 moiré;1px 半径抗锯齿正常。

## 3. 独立舞台(WbStage.vue,新共享组件)——模块的空间

单一事实源,三页(Shell/Detail/Ledger)共用:

```
╭ WbStage ─────────────────────────────╮
│ ├ 回声线:inset 3px、rounded-[13px]    │ ← 舷板「双钩边」语言的直角版
│ ├ slot titleBar(可选)——模块门面段     │   同族不同形,模块 DNA 可识别
│ ├ slot default(flex-1 min-h-0)       │
╰──────────────────────────────────────╯
```

- 容器:`h-full flex flex-col rounded-2xl border overflow-hidden relative`
- 底色:亮 `bg-surface-container-lowest/85`(浮起,近白);暗 `bg-surface-container/85`
  (比暗画布亮一档)
- 描边:`border-outline-variant`;亮色加 `shadow-card`,暗色靠描边+回声线(黑影暗底无效)
- 回声线:`data-test="wb-stage-echo"`,`inset-[3px] rounded-[13px] border-outline-variant/40`
  pointer-events-none(3px inset 与 16px 圆角的同心数学:16-3=13)
- **高度链**:`h-full` 起,`min-h-0` 贯通——沿用现有 fullHeight 契约(AppLayout 包裹层
  h-full → 舞台 h-full → default slot flex-1 min-h-0),chat 输入框贴底不悬空
- 画布留白:main 给舞台留 `p-md`(16px)起步——chat 是宽度主消耗区,浏览器实测后可调

## 4. 舞台标题栏(模块门面)

Shell 与 Detail 的头部收编为 WbStage 的 titleBar slot:

- **放大瓷砖(32px)**:与顶栏 pill 瓷砖同配方(双绿渐变 from-primary to-primary-container
  + 内高光 + 底部投影,rounded-[10px]),**挂载即播一次 sheen**——「入口那枚瓷砖 → 模块
  门面」的概念握手(工作台每次进入都重挂,sheen 天然一次性)
- 左:瓷砖 + 「工作台」标题(text-headline-sm);右:返回集群(降为 ghost 钮,
  text-on-surface-variant hover:text-primary,行为不变 router.push('/cluster'))
- 与 tabs 区分隔线弱一档:border-outline-variant/40

## 5. 三幕入场编排(总谱)

```
第一幕 0-600ms  氛围辉光从右上 bloom(wb-glow-in)      灯亮了
第二幕 0-240ms  舞台 wb-enter 从右滑入(AppLayout 现有)  空间进场
第三幕 0/40ms+  舞台内 wb-rise stagger(Shell 现有)      家具落位
```
- 瓷砖 sheen、舷板 wb-pulse 维持现状,不叠加新事件(注意力预算已满)。
- reduced-motion:辉光常显、滑入退化为 100ms 淡入(main.css 既有兜底)、stagger 静止。

## 6. 改动面与批次(每批独立可合并/回退)

### 批次 A:氛围画布
| 文件 | 改动 |
|---|---|
| `src/router/index.js` | 三路由 meta `module: 'workbench'`;ledger 补 `fullHeight` |
| `src/components/layout/AppLayout.vue` | main 按 meta 挂 `wb-atmosphere`;transition 包裹 div 加 `relative` |
| `src/styles/main.css` | wb-atmosphere 三层 + wb-glow-in + reduced-motion 兜底 |
| 测试 | router meta 契约(3 路由断言);main.css 静态断言(三层+辉光);AppLayout 类绑定静态契约 |

### 批次 B:舞台 + Shell 换装
| 文件 | 改动 |
|---|---|
| `src/components/workbench/WbStage.vue`(新) | 舞台容器(描边/回声线/titleBar slot/高度链) |
| `src/views/WorkbenchShell.vue` | 根换 WbStage;header → titleBar(放大瓷砖+sheen+标题+返回钮);tabs/pane wb-rise 保持 |
| 测试 | WbStage 契约新建;WorkbenchShell.motion/tabs 测试迁移 |

### 批次 C:Detail + Ledger 收编
| 文件 | 改动 |
|---|---|
| `src/views/WorkbenchDetail.vue` | 外层套 WbStage,头部收编 titleBar(模板手术,逻辑零触碰) |
| `src/views/WorkbenchLedger.vue` | 文档式 → 舞台式(内部滚动区进 stage default slot) |
| 测试 | 两页既有测试迁移 + 舞台包裹契约 |

## 7. 测试与验收

### 契约测试(TDD,先红后绿)
- router meta:三路由 `module==='workbench'`、ledger `fullHeight===true`。
- WbStage:渲染双 slot;echo 线在案;`rounded-2xl`/`border`/`h-full`/`overflow-hidden` 类。
- Shell motion 测试迁移:根节点断言从 `section` 改为舞台结构;三段 wb-rise stagger 保持。
- main.css 静态断言:wb-atmosphere 双伪元素 + wb-glow-in + reduced-motion 块。

### 浏览器验收(每批亮暗双主题截图)
- A:K8s 页面截图与改前逐像素零差;workbench 三页三层可见(亮不抢、暗不脏);
  辉光 bloom 与滑入同步;点阵无 moiré。
- B:舞台描边+回声线可见;chat 高度链不断(输入框贴底);瓷砖 sheen 恰一次;
  1280px 视口 chat 可用宽度实测。
- C:Detail/Ledger 在舞台内正常滚动;dirty-confirm/删除等逻辑既有测试全绿;
  「返回集群」落点 /cluster 不变。

### 门禁
`test:unit`(全量)、`test:server`(含 overflow-guard V1–V5)、`typecheck`、`build`。
多会话期 unit 用 `--maxWorkers=2`;WorkbenchChat 既有 flaky 隔离复跑判定。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| chat 可用宽度被舞台 padding 挤压 | p-md 起步,1280px 实测;必要时舞台 padding 降到 xs 或只在亮侧留 |
| 高度链断裂(输入框悬空) | WbStage 内部 min-h-0 贯通照抄现有契约;B 批验收第一项 |
| Detail 头部手术伤逻辑 | 只动模板外层;既有测试全绿为合并闸 |
| 暗色氛围可感知度(≈1.1:1) | 实现时实测调值;幽灵类检查前置(V5 教训) |
| ledger 文档式假设(全幅表格) | C 批先读组件结构,内部滚动区接管 |
| 伪元素遮挡交互 | pointer-events-none + 树序绘制在下,B/A 批浏览器点测 |

## 9. 非目标(明确不做,防战线失控)

- chat 内部组件(消息气泡/审批卡)换装——后续独立批次
- 侧栏 workbench 入口换装、滚动条/选区色定制——「全域深改」档未选
- View Transition API 瓷砖 morph——转场 B 方案,二阶段另排
- 品牌色系变更(氛围只在 primary 族内做 alpha 游戏)
