# 手机适配第五波(Wave 5):全量审计与系统性修复设计

- 日期:2026-09-09
- 状态:待用户评审
- 前序:四波适配共用 spec `2026-09-01-mobile-adaptation-design.md`(Wave 1a/1b/2/3/4,2026-09-01~02);本波接续其「74 视图全量覆盖」未闭环的成功标准
- 用户裁决(2026-09-09):①tab 条统一**横向滚动条** ②WorkbenchDetail 侧栏**收进抽屉** ③裸表**迁 DataTable 卡片化**(语义特殊表保底横滚) ④范围 **P0+P1+P2 全清**

## 1. 背景与方法

用户反馈多处手机体验未适配(工作台对话页、SSH 服务器卡、workload overview/详情页),并明确要求「系统性检查、系统性修复」。

审计方法(2026-09-09 执行):

- 路由清点:`src/router/index.js` 全量枚举 + 独立弹窗页/全局浮层 → **13 批 88 页全覆盖**
- 逐页审计:14 项破绽检查单(固定宽度/无响应网格/不可折叠横排/裸表/tab 条/hover-only/触控目标/truncate 配方/长内容/safe-area/自定义浮层/双 pane/画布交互/入口不可达),视口假设 390px(<640 sm 断点,触屏无 hover)
- 对抗复核:每条发现由独立怀疑论代理验证(找反证:父容器缓解/已有断点类/内容有界/替代路径),宁可推翻可疑发现
- 结果:**216 条原始 → 确认 197 条(P0×6 / P1×84 / P2×107,95 文件),推翻 19 条**
- 完整注册表:同目录 `2026-09-09-mobile-audit-findings.json`(含每条复核理由),本文附录为按波 digest

内容宽度基准:手机档侧栏抽屉化后 main 全宽 390px,`p-margin`(32px×2)无 max-sm 覆盖 → **可用内容宽 326px**(下文算术均以此为基准)。

## 2. 根因:八大共性病灶

197 条几乎全部落入八类,因此修复以「配方」为单位,修一处治一片:

| # | 病灶 | 规模 | 代表证据 |
|---|------|------|----------|
| S1 | 浮窗定位/尺寸按桌面写死 | P0×3 | `FloatingWindow.vue:30` x=Math.min(80, 390-740)=-350;`:65` 最大化硬编码 left:268px;调用方 width 720/860px 固定 |
| S2 | 详情页头统一结构缺陷(icon+h1+按钮组,无 wrap/min-w-0/truncate) | ~25 页 | `NsWorkloadDetail.vue:1220-1252`(用户实测错乱处);`max-sm:flex-wrap`+`shrink-0` 组合在无 wrap 父级下**实际不生效**(基准尺寸取 max-content 单行) |
| S3 | tab 条全部不可滚 | ~14 处 | `NsWorkloadDetail.vue:1255`(7 tab ~646px)、Storage/Configuration/RBAC/UserProfile/NsConfigMapDetail/SecretDetail/RoleDetail/NetPolDetail/PodDetail 控制台/WorkbenchShell 等 |
| S4 | 裸 `<table>`(未走 DataTable 卡片模式、无横滚、外层 overflow-hidden 硬裁) | ~13 处 | NsWorkloadDetail Revisions/Events、CrdDetail Instances(P0)、NsRoleDetail rules/bindings、NsRoleBindingDetail subjects、NsHPADetail metrics、NsNetworkPolicyDetail rules、NamespaceDetail workloads、Settings components、ResourceReferences、WorkloadDetail legacy、NsServiceDetail ports |
| S5 | Pagination 组件单点破绽 | 8 条发现 | `Pagination.vue:30` 行 min-content ~310-360px > 各宿主页脚可用宽 262-294px |
| S6 | workbench 双 pane 固定侧栏 | P0×2 + P1 | `WorkbenchDetail.vue:383`(对话列表 w-56)/`:447`(Edit 文件树 w-56),聊天/编辑区仅剩 ~131px |
| S7 | SSH 终端无虚拟按键条/字号热调 | P1 | `SshTerminal.vue:213` 全文件无 isPhone;pod 侧 `InteractiveTerminal.vue:283` 有配方(KEY_BYTES+adjustFont) |
| S8 | 表单行 `flex-1` 输入无 `min-w-0`(内在宽 size=20 ≈170-200px) | ~12 处 | DeployApp labels/端口行、NpSelector/NpPeerEditor、NsServices/NsServiceDetail selector 行、NsIngress 注解行、NsRoleBinding subjects 编辑行、Storage SC parameters 行 |

次级但量大:**触控目标 <40px 且无四件套**(P2 约 50 处:列表 actions 槽图标钮、过滤 pills、userCenter/admin 图标钮、TerminalTaskbar 等);**长 unbreakable 内容无 truncate/break-all**(labels chips、事件 message、mono 路径/镜像/主体名等);**无响应前缀多列网格**(grid-cols-2/3/4 在 326px 下挤爆 ~20 处)。

**顺手修的纯 bug(审计中发现,非视口专属)**:

1. `PVDetail.vue` 7 处 `t('common.xxx')` 未包 `{{ }}` → 按钮直显字面量
2. `Settings.vue` 保存钮 `bg-primary`+`text-primary` 同引 CSS 变量 → 文字与背景同色不可见
3. `NsWorkloadDetail.vue:1259` tab 名渲染裸 key 无 i18n
4. `bg-primary/8` 幽灵透明度类(NsWorkloadDetail×3 + NsIngressDetail,V5 allowlist 豁免至今)→ 换 5 倍数刻度并清零 allowlist
5. `FloatingWindow.vue:65` 最大化 left 硬编码 268px(并入 S1)

## 3. 设计总则

1. **配方先行**:W1 先修共享组件/建立配方,后续波次按配方机械应用;配方优先纯 CSS(max-sm: 类),JS 分支(isPhone)仅用于 CSS 表达不了的结构切换(双 pane 抽屉、浮窗铺满、按键条)——沿用 `useBreakpoint.js` 头注契约。
2. **波次文件不相交**:每波触达的文件集互不重叠,避免并行会话/合并冲突;同一文件的全部发现(含 P2 触控目标)随该文件所在波次一次清完。
3. **复用既有配方,不发明新词汇**:DataTable 卡片模式、bottom sheet、四件套命中区、44px 止血条、sticky+safe-area 全部沿用;tab 横滚条是本波新增的唯一新配方(R3)。
4. **双轨 UI 约束**(2026-09-05 设计):workbench 域的手机化只动功能性 chrome(侧栏抽屉、tab 滚动、触控目标),不动 WbStage 舞台/氛围画布/门面语言。
5. **守卫防回归**:新配方配静态守卫规则,进 `npm test`。
6. **零新增依赖**;纯 JS + Tailwind 既有类。

## 4. 配方设计(实施细节)

### R1 浮窗手机铺满(S1,治 3×P0)
`FloatingWindow.vue` 消费 `useIsPhone`:
- 手机档:忽略调用方 width/pos,`left/right/top/bottom = 8px`(top 避让视口顶),即近全幅卡片;标题栏/●●● 保留;拖拽禁用(触屏本就 mouse-only)。
- 最大化分支:`left` 改消费 `var(--sb-width)`(桌面还原 260px 行为),手机档直接 inset 铺满。
- 消费方(TerminalWindow/SshTerminalWindow/FileBrowserWindow/TransfersPanel)零改动;width prop 桌面档不变。

### R2 Pagination 响应式(S5)
根行 `max-sm:flex-wrap max-sm:gap-xs`;翻页钮补四件套;摘要 span `max-sm:hidden`(信息降级可接受,翻页功能保命)。一个组件修完 8 条发现。

### R3 tab 横滚条配方(S3,用户裁决①)
纯 CSS,无 JS,桌面零变化(content 不超宽时 overflow-x-auto 无感):
- 容器:`flex items-center gap-xs overflow-x-auto border-b border-outline-variant`(新增 overflow-x-auto)
- 每个 tab 钮:`shrink-0 whitespace-nowrap`(防 CJK 逐字竖排)
- 选中下划线随按钮(已是 per-button absolute,保持);容器可加 `-webkit-scrollbar` 细条样式(沿 LogViewer 若有先例,无则默认)。
- 应用清单(~14 处):NsWorkloadDetail、PodDetail 控制台、Storage、Configuration、Network、RBAC、NsConfigMapDetail、NsSecretDetail、NsRoleDetail、NsNetworkPolicyDetail、IngressClassDetail、UserProfile、WorkbenchShell、NsNetworkPolicies 过滤条。

### R4 详情页头配方(S2)
标准结构改造(全部纯 CSS 类,~25 页同型):
- 外层:`flex flex-wrap items-start justify-between gap-x-sm gap-y-sm`(加 wrap)
- 左块:`flex items-start gap-md min-w-0`(加 min-w-0;桌面视觉不变)
- h1:`min-w-0 break-words` + `max-sm:truncate` + `:title` 全名兜底
- meta/chip 行:已有 flex-wrap 的保持,补 `min-w-0`
- 按钮组:`flex flex-wrap gap-xs`(**去 shrink-0**——审计实证 shrink-0 使 flex-wrap 失效),钮已有 `max-sm:min-h-[40px]` 的保持
- 图标盒(w-12/w-14)手机档可 `max-sm:hidden` 腾宽度(实施时逐页验证观感)。
- 面包屑(`Breadcrumbs.vue`):中间段 `truncate min-w-0`、首尾段 shrink-0。

### R5 裸表收编(S4,用户裁决③)
- **主路径:迁 DataTable**。这些表都是「行状数据 + 自定义单元格」,DataTable 列 slot 同源双分支(桌面单元格/手机 kv 行)零成本获得卡片模式。迁移模式:定义 headers 数组(name/label/minWidth)+ 每列 slot 搬运现有单元格模板;row-click 指详情跳转(有详情页的)。
- **保底路径**:语义特殊表(Role rules 的 chips 矩阵、NetPol rules 的 describePeer 长串)若迁移代价过高,外层改 `overflow-x-auto` + 表加 `min-w` + 单元格 truncate——保证可达,不追求卡片化。
- 清单:NsWorkloadDetail Revisions/Events、CrdDetail Instances、NamespaceDetail Workloads、NsRoleDetail Rules/Bindings、NsRoleBindingDetail Subjects、NsHPADetail Metrics、NsServiceDetail Ports、ResourceReferences、Settings Components、WorkloadDetail 管理的 Pod;NsNetworkPolicyDetail Rules 走保底。

### R6 双 pane 手机抽屉(S6,用户裁决②;纯 CSS 表达不了,用 isPhone)
`WorkbenchDetail.vue`:
- 手机档:`flex` 容器改条件渲染——侧栏(对话列表/Edit 文件树)默认不占位,渲染为滑入面板(`fixed inset-y-0 left-0 w-[85%] max-w-[280px]` + 遮罩 `Z.drawer-1` + Esc/选中自动收),页头工具条加「列表/文件」图标钮唤起;主区全宽。
- 桌面档零变化。侧栏内交互(重命名/删除/10s 刷新)原样。
- 同族处理:`NsConfigMapDetail.vue:258` Data tab 双栏(左 w-56 文件列表手机收为可切换/上下布局)、`DataKeysEditor.vue:126` grid-cols-[220px_1fr] 手机改单列上下、`PodDetail.vue:175` Files tab SplitPane 手机默认竖切(已有手动切换钮,改默认方向即可)。

### R7 SSH 终端手机配件(S7)
从 `InteractiveTerminal.vue` 抽共享 `TerminalKeyBar` 组件(KEY_BYTES + pointerdown.prevent 配方)+ `useTerminalFont`(clamp 8-20 + fit 重排),SshTerminal 与 InteractiveTerminal 双双消费;SshTerminal 补 `v-if="isPhone"` 按键条与字号钮。守卫测试 `InteractiveTerminal.keys.test.js` 迁移为双消费方断言。

### R8 表单行 min-w-0 配方(S8)
- 行容器:`flex flex-wrap`(或 `max-sm:flex-col`)
- 每个 `flex-1` 输入:补 `min-w-0`,必要时 `max-sm:w-full`
- 原生 select:补 `w-full`/`min-w-0`(select 挂不了伪元素,触控靠 `max-sm:min-h-[40px]`)
- 应用:DeployApp KV/端口/nodeSelector 行、NpSelector/NpPeerEditor、NsServices/NsServiceDetail selector 行、NsIngress 注解行、NsRoleBinding subjects 行、Storage SC parameters、NsConfigMapDetail/NsSecretDetail 键值编辑行、GroupsGrants 新建组行。

### R9 触控目标四件套清零(全 P2 长尾)
`relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']` 补齐 ~50 处(附录逐条);文字钮/pills 用 `max-sm:min-h-[40px]`;select 类用 min-h。同文件既有配方优先对齐(如 TerminalTaskbar 317 行样式)。

### R10 长内容与网格收敛(次级)
- chips/键值:外层 `min-w-0` + 值 `truncate`/`break-all`(labels chips、configRefs、主体名、事件 message、存储路径)
- 无前缀网格补断点:`grid-cols-2 → grid-cols-1 sm:grid-cols-2`、`grid-cols-3/4 → grid-cols-2 sm:grid-cols-3/4`(NodeDetail 用量、CrdDetail overview、NsRoleDetail/RoleBinding overview、LlmConfig 状态区、AuditLogs 统计、NsWorkloads 类型摘要、HPA 目标卡、IngressClassDetail parameters 等)
- 指标双图 `grid-cols-2 → grid-cols-1 md:grid-cols-2`(NsWorkloadDetail:1517);YAML tab 高度 560px → `max-sm:h-[60vh]`。

### R11 拓扑画布手机(S3 关联)
`WorkloadTopologyTab.vue`:`:min-zoom="isPhone ? 0.15 : 0.5"`,fit-view-on-init 即可把 1104px 四列图缩进 326px;pinch 缩放保持。不改布局算法。

### R12 纯 bug 五连修
见 §2 清单;`bg-primary/8` → `/10` 并删 `overflow-guard.test.mjs` V5 allowlist 两文件(清零后删整个 allowlist 机制)。

## 5. 波次划分(文件不相交)

| 波 | 范围 | 发现数 | 主要文件 |
|----|------|--------|----------|
| W1 | 共享基建+配方落地 | 11(P0×2) | FloatingWindow、Pagination、Breadcrumbs;守卫/测试基建 |
| W2 | 用户点名三处 | 15(P0×3) | WorkbenchDetail(+抽屉)、WorkbenchServers(+SshServerForm 弹窗 `w-[720px]`→响应式)、NsWorkloadDetail(R3/R4/R5/R10/R11/纯 bug)、WorkloadTopologyTab、SshFileBrowserWindow(随 R1) |
| W3 | 详情页全族 | 73(P0×1) | 全部 `*Detail.vue`(Ns 域 15 + 集群域 8)+ ResourceReferences/DataKeysEditor + networkpolicy 编辑器三件 |
| W4 | 列表页/向导/workbench 剩余/admin/设置 | 98(P1×28) | 列表页头与 actions 槽、DeployApp 向导、WorkbenchShell/Ledger/Records/Projects/Chat、SshTerminal 按键条、TerminalTaskbar 菜单钳制+触控、admin 五页、Settings 三处、UserProfile、LogPopup、LocaleToggle 等 |
| W5 | 守卫扩展+全量验证 | — | mobile-guard 新规则;390px 截图验收全部触达路由;V5 allowlist 清零核验 |

- 每波独立分支 + `--no-ff` 合 main(多会话并行惯例);波内 TDD:可测逻辑(抽屉开关、Pagination 布局、FloatingWindow 定位数学、守卫规则)先写测试,类配方以静态守卫+截图验收。
- 每波门禁:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run build` 全绿才合。
- W4 体量最大但 P2 占 70/98,以机械配方应用为主,可再按域拆两次合并(实施计划里定)。

## 6. 守卫扩展(W5,scripts/mobile-guard.test.mjs 新建)

静态扫 .vue,规则带 allowlist 机制(同 overflow-guard 惯例),先跑全仓红名单清零再启用:

- **M1 裸表须可滚**:`<table` 出现的文件,table 标签 10 行窗口内须有 `overflow-x-auto` 祖弟,或该文件 import DataTable 且该表在 DataTable 模板外仍须可滚——实施时以「新出现无横滚裸表即红」为口径校准。
- **M2 固定宽阈值**:模板内任意值宽度类 `w-[Npx]`/`max-w-[Npx]` N≥640 即红(弹窗/浮窗必须响应式);`w-56` 等命名档不扫(合法用于桌面,双 pane 场景靠评审)。
- **M3 V5 allowlist 清零**:R12 完成后删除 allowlist 机制本体。
- 既有 V1-V5/壳层守卫继续生效;新规则进 `npm test`。

## 7. 验证策略

1. **门禁**:每波四道门禁全绿(§5)。
2. **390px 截图验收**:每波触达的路由,`npm run build` 后对本地网关(8787,serve dist)用 headless chrome(`--window-size=390,844 --screenshot`)逐页取证,登录态经现有会话/凭据注入(实施计划定案);修前修后对比,进波次收尾记录。W5 汇总全量截图清单核对 88 页。
3. **抽测触控/交互**:Playwright(本仓已装)点验关键交互:tab 条可滚到底、抽屉开合、浮窗铺满后 ●●● 可点、四件套命中区抽查。
4. **桌面回归**:既有单测/守卫全绿即视为桌面不回归(配方均为增量断点类,桌面计算值不变;R1 FloatingWindow 最大化行为有单测钉住)。

## 8. 验收标准

- [ ] 197 条确认发现全部闭环:修复 / 明示豁免(须记录理由)——零静默丢弃
- [ ] 19 个被推翻发现不再复活(豁免不修)
- [ ] 用户点名四处实测可用:工作台对话页(手机侧栏抽屉)、SSH 服务器页(卡片化+弹窗)、workload 详情页头/tab/表格、workload overview
- [ ] 390px 截图:全部触达路由无横向溢出(body scrollWidth ≤ 390)、tab 可达、操作可达
- [ ] mobile-guard M1/M2 启用且全仓绿;V5 allowlist 删除
- [ ] 纯 bug 五连修合入
- [ ] 门禁四道全绿

## 9. 明确不做(停泊,记录在案)

- bottom sheet 下滑关闭(Wave 4 遗留 follow-up,非本审计发现)
- Wave 1-4 的真机(物理设备)手测清单——本波以 390px 截图+Playwright 覆盖,真机清单维持「待做」归属原 spec
- `p-margin` 手机档缩窄(32px→16px 可多出 32px 可用宽,但牵动全站视觉密度,单独裁决)
- 未发现破绽的其余 ~55% 无手机代码文件(流体布局天然安全,不预防性改造)

## 附录:按波次发现注册表(digest)


### W1 共享基建(FloatingWindow/Pagination/Breadcrumbs) — 11 条(P0:2 P1:6 P2:3)

| 文件:行 | 级 | 元素 | 问题 |
|---|---|---|---|
| `src/components/common/Breadcrumbs.vue:8` | P2 | 面包屑导航(本批全部详情页使用:ns 名 + Storage/ResourceQuotas/ | 三级面包屑含两个不可断行段:ns 名(如 my-team-production ≈ 110px)+ 资源名(PVC 名 30+ 字符 ≈ 190-280px),合计超 326px 可用宽,当前页标签(高亮项)被推出视口裁掉,ns 返回链接挤 |
| `src/components/common/FloatingWindow.vue:30` | P0 | FloatingWindow 初始定位 pos.x 计算 + 调用方固定 width(Ter | 390px 视口下 x=Math.min(80+…, innerWidth-740) 恒为 -350:720px 终端浮窗左缘移出屏外 350px,headerless 头部 ●●● 圆点(手机上唯一 关闭/最小化/最大化 入口,触摸拖拽在 |
| `src/components/common/FloatingWindow.vue:65` | P0 | winStyle 最大化分支 { left:'268px', top:'72px', rig | 最大化偏移硬编码桌面假设(侧栏 260px+边距);手机档 --sb-width 已是 0px(AppLayout.vue:149),390px 视口下最大化浮窗仅 ~114px 宽,终端/文件窗在手机上连最大化都不可用,与上一条叠加构成双 |
| `src/components/common/Pagination.vue:30` | P1 | Pagination 控件根容器(select + 范围摘要 + 翻页器) | 无 flex-wrap:页大小 select(按最宽 option '100 / 页' 定宽 ~85px)+ whitespace-nowrap 范围摘要(~90px)+ 翻页器(~150px)合计 ~355px,而 DataTable 卡 |
| `src/components/common/Pagination.vue:30` | P1 | Pagination 组件根行(经 #pagination slot 被 Workloads | showSizeSelector 形态(select ~90px + nowrap 摘要 ~120px + prev/计数 min-w-[60px]/next ~124px + gaps)合计 ~390px > 326px,Workload |
| `src/components/common/Pagination.vue:30` | P1 | 分页条:flex items-center gap-md(per-page select + | 检查单 C+N(共享组件但为本批页面使用方式破绽,不在豁免清单):最小内容宽 ≈58(select)+75(nowrap 摘要)+164(页码组)+32(gaps)≈329px,而 DataTable 底座 footer px-lg(lin |
| `src/components/common/Pagination.vue:30` | P2 | 分页条根 div(Namespaces 与 ClusterResourceList 两列表页 | DataTable 页脚 px-lg 后仅 294px,而 select(~75px)+nowrap 摘要(80-130px)+翻页组(~132px)+gaps ≈ 310-360px,溢出部分被 DataTable 根 overflow- |
| `src/components/common/Pagination.vue:30` | P1 | Pagination 根 <div class="flex items-center gap | 分页行 min-content ≈310px(select 63 + nowrap 摘要 85 + prev/page/next 132 + gaps)> 手机可用 262px(326−footer px-lg 64),footer 无 w |
| `src/components/common/Pagination.vue:30` | P1 | 分页条(本批三个列表页 DataTable 页脚共用,NsStorage.vue:207 / | 分页条最小内容宽 ≈ 312px(选择器 76 + 摘要 72 + 前后钮/页码 132 + gaps),超过 DataTable 页脚卡内宽 ≈ 276px(326 − px-lg 48 − border),且页脚被卡片根 overflo |
| `src/components/common/Pagination.vue:46` | P2 | 上一页/下一页 chevron 钮(/clusters 集群数>pageSize 时在页底渲 | icon-only 触控目标 28px 无四件套;手机分页翻页主入口,全仓多页共用同一组件 |
| `src/components/common/Pagination.vue:30` | P1 | Pagination(size select + 汇总 span + prev/next), | C: 行 min-content(select 最宽 option+nowrap 汇总+prev/next ≈320-360px)> 底栏可用 ~294px,尾部 next 翻页钮被 DataTable 根 overflow-hidden  |

### W2 用户点名三处(WorkbenchDetail/WorkbenchServers/NsWorkloadDetail 族) — 15 条(P0:3 P1:8 P2:4)

| 文件:行 | 级 | 元素 | 问题 |
|---|---|---|---|
| `src/components/common/WorkloadTopologyTab.vue:96` | P1 | 拓扑画布 VueFlow(fit-view-on-init, min-zoom 0.5) | 检查项M:四列图总宽 3×288+240=1104px,326px 视口 fitView 需 zoom≈0.29,被 min-zoom=0.5 钳制 → 初始视图只显示前约 650px,Pods 列(x=864..1104)整列在屏外,且  |
| `src/components/ssh/SshFileBrowserWindow.vue:20` | P0 | SSH 文件浏览浮窗(servers tab 的 openFiles 入口) | 手机档浮窗 860px 宽、起点 x=-350:工具条右侧 刷新/新建夹/上传 与每行 下载/重命名/删除 全落在视口右缘外不可达;拖拽是 mouse 事件触屏无效,最大化又锚定桌面 chrome 偏移(left:268px)→ 窗口仅 ~ |
| `src/views/NsWorkloadDetail.vue:1255` | P1 | Tab 导航条 (overview/topology/network/pods/revisi | 检查项E:7 个 tab 按钮最小内容宽合计约 530px(每按钮 px-lg=32px + 文本),390px 视口扣 p-margin 后仅 326px,条既无 flex-wrap 也无 overflow-x-auto,尾部 yaml/ |
| `src/views/NsWorkloadDetail.vue:1290` | P2 | 概览卡快速伸缩 ±1 按钮 | 检查项G:副本数 ±1 是即时变更操作,触控目标仅 24×24px 且无命中区扩展,手机上易误触/难点中(底部 44px 止血条只覆盖弹窗式 scale,不覆盖此快捷钮) |
| `src/views/NsWorkloadDetail.vue:1735` | P1 | Revisions tab 裸 <table> | 检查项D:未走 DataTable 手机卡片模式,外层是 overflow-hidden 而非 overflow-x-auto;Rev+Image(max-w-[200px] nowrap)+Replicas+Age+Actions 加 p |
| `src/views/NsWorkloadDetail.vue:1763` | P1 | Events tab 裸 <table>(5 列:Object/Reason/Type/Me | 检查项D+I:同 Revisions 表;Object 列 relatedKind+relatedName mono 无 truncate,pod 名带 hash 一词 160px+,5 列最小宽远超 326px,尾部 Age 列及部分 M |
| `src/views/NsWorkloadDetail.vue:1889` | P1 | 编辑 Modal 内 4 列网格群(资源 4 输入 1889 / 污点 2047 / 更新策 | 检查项B:手机 Modal 全屏后内容宽 ≈326px,减 section p-md 后网格 ≈294px,4 列每格仅约 70px:ResourceInput(cpu/mem 四连格)被压扁,污点行 'NoSchedule' select |
| `src/views/NsWorkloadDetail.vue:2257` | P1 | YAML 变更 diff 预览列表 | 检查项I:容器 overflow-x 被 overflow-hidden 钳为 hidden 且行 whitespace-pre 不换行,长行(镜像/registry URL 常见 60-100 字符 mono,≈430-720px)在 3 |
| `src/views/WorkbenchDetail.vue:383` | P1 | Agent 模式对话列表侧栏(conversation sidebar) | 手机 390px 下 w-56(224px) 固定侧栏无收起/抽屉化,右侧聊天主区仅剩 ~131px——WorkbenchChat 阅读列+composer 挤进 131px,输入框约 60px 宽,对话页基本不可用(A/L 类) |
| `src/views/WorkbenchDetail.vue:410` | P2 | 对话列表行 重命名/删除 图标钮 | p-0.5 + text-sm 图标 ≈20px 触控目标且删除是破坏性操作,无命中区扩展(G 类;opacity 已有 max-sm:opacity-100,只缺尺寸) |
| `src/views/WorkbenchDetail.vue:447` | P0 | Edit 模式文件树侧栏(file tree) | 同款 w-56 固定双 pane:编辑器列仅 ~131px,YamlEditor + commit 输入行(按钮常驻)被压到不可编辑(A/L 类) |
| `src/views/WorkbenchDetail.vue:472` | P2 | 文件树行删除图标钮 | 同款 ~20px 触控目标承载删除确认入口,无命中区扩展(G 类) |
| `src/views/WorkbenchServers.vue:149` | P1 | SSH 服务器清单表格 | 裸 <table> 7 列(名称/状态/host:port mono/用户名/凭据/暴露AI/操作)未走 DataTable 卡片化也无 overflow-x-auto,最小内容宽 ~700px ≈ 2× 视口,手机上整 pane 横向滚动 |
| `src/views/WorkbenchServers.vue:203` | P2 | 服务器表行内操作按钮(终端/文件/更多▾) | text-body-xs + py-xs/p-xs 按钮高 ~26px,无 max-sm:after 四件套;终端/文件是该表主操作,触屏易误触邻钮(G 类) |
| `src/views/WorkbenchServers.vue:234` | P0 | SSH 服务器新增/编辑弹窗(teleport 自定义 modal) | w-[720px] 固定宽无 max-w:390px 视口下居中两侧裁掉,表单左列 label/输入框左半在屏外;SshServerForm 底部操作行 flex justify-end 的 取消/保存 按钮落在 ~450-700px 区完 |

### W3 详情页全族 — 73 条(P0:1 P1:42 P2:30)

| 文件:行 | 级 | 元素 | 问题 |
|---|---|---|---|
| `src/views/WorkloadDetail.vue:61` | P1 | WorkloadDetail 头部(breadcrumbs + h2 display-lg  | 与 PodDetail 同型但更旧:右钮组连 max-sm:flex-wrap 都没有,「删除」(88px)+「重启」(96px)+h2 长名段 min-content 合计 ~390px > 326px,重启按钮约一半被挤出首屏(main |
| `src/components/networkpolicy/NpPeerEditor.vue:36` | P1 | ipBlock 行 <div v-if="hasIp" class="flex items- | 两个 flex-1 输入(flex-[size=20] 内在宽 ≈202px each)无 min-w-0 不换行,且嵌在 NpRuleEditor 行内(pl-md 16 + 删除钮 26 + gap 8 后可用仅 ≈292px):行 m |
| `src/components/networkpolicy/NpRuleEditor.vue:72` | P2 | ports 行 <div v-for... class="flex items-center | 带 endPort 时行 min-content ≈376px > 可用 ≈292px(342−pl-md−删除钮)→ 行溢出弹窗、endPort 框被切;且行删除钮 p-xs ≈26px 无四件套 |
| `src/components/networkpolicy/NpSelectorEditor.vue:51` | P1 | matchLabels 行 <div class="flex items-center ga | 创建向导两处行均无 wrap/min-w-0:label 行 min-content ≈463px、表达式行(含 DoesNotExist 下拉 ≈120px)≈574px,均远超手机 Modal 内宽 342px → 输入与行删除钮(p- |
| `src/views/ClusterRoleBindingDetail.vue:53` | P1 | h1 页标题 {{ crb.name }} | 同 ClusterRoleDetail:CRB 名(system:controller:* 常见 40+ 字符)32px 不可断行全文宽溢出 326px 内容区,页面横向滚动 |
| `src/views/ClusterRoleBindingDetail.vue:76` | P1 | Subjects 列表行(v-for crb.subjects) | 横排无 flex-wrap 无 min-w-0,ServiceAccount 主体名 system:serviceaccount:ns:name 常见 50-70 字符(mono ≈ 400-500px)溢出卡片内 278px,把 ml-a |
| `src/views/ClusterRoleDetail.vue:49` | P1 | h1 页标题 {{ role.name }} | 角色名无 truncate/break-all,32px/700 全文宽:内容区 326px 减图标 56px+gap 24px 后仅 ~246px,>14 字符即溢出;system:aggregate-to-admin 等常见角色名(25 |
| `src/views/ClusterRoleDetail.vue:92` | P2 | Bindings 列表行的绑定名 span | system:controller:* 绑定名(40-52 字符 mono ≈ 290-374px)无 truncate/min-w-0,溢出卡片内 278px,subjects 计数被推出 |
| `src/views/CrdDetail.vue:183` | P1 | 页头 h1(CRD 名):text-headline-md font-mono + 右侧「返 | 检查单 H+I:长 CRD 名(如 certificaterequests.cert-manager.io 最长不可断段 23ch×14.4px≈331px;kafkatopics.kafka.strimzi.io 无连字符整段 403px |
| `src/views/CrdDetail.vue:233` | P2 | Overview tab grid-cols-2 信息卡:GROUP 卡 p.font-mo | 检查单 B+I:2 列无断点变体下每卡 content ≈143px,长 API group(gateway.networking.k8s.io 26ch≈187px、internal.autoscaling.k8s.io≈202px)不可 |
| `src/views/CrdDetail.vue:313` | P0 | Instances tab 裸 <table class="w-full">(5 列:NAM | 检查单 D+N:未走 DataTable 卡片模式且无 overflow-x-auto。5 列 px-md 填充+图标+mono 名的最小内容宽 ≈450-600px >> 324px 可用,表格右溢被卡片 overflow-hidden  |
| `src/views/IngressClassDetail.vue:166` | P1 | 页头动作组(编辑/设为默认/删除三钮)与左侧标题块 | 390px 下内容宽仅 326px:左块 floor = 图标56+gap24+meta行(controller mono 不可断词如 k8s.io/ingress-nginx ~137px + DEFAULT 徽标 + Age)≈349p |
| `src/views/IngressClassDetail.vue:180` | P2 | 页头 tab 条(overview / ingresses (N) / yaml) | 三 tab 合计(px-xl 64px/钮 + 文案)≈370-390px > 326px 且无 overflow-x-auto,尾端 yaml tab 被裁,计数位数多时更宽——YAML 编辑入口手机上呈截断状(E,可达但残缺) |
| `src/views/IngressClassDetail.vue:255` | P1 | ingresses tab 关联 Ingress 行按钮(ns/name + hosts c | 行内 namespace/name span 为 shrink-0 不可换行(mono,如 kube-system/ingress-nginx-controller ≈260px),backends 组 ml-auto shrink-0,行 |
| `src/views/IngressClassDetail.vue:299` | P2 | 编辑 Modal parameters 三输入框 grid | grid-cols-3 无 sm: 断点变体,390px 全屏 Modal 下(p-lg 后 ≈342px)每输入框仅 ~108px,mono 输入 networking.k8s.io 之类 apiGroup 只能横向滚动编辑,明显挤(B) |
| `src/views/IngressClassDetail.vue:316` | P2 | 结构化编辑 Modal 的 KV 行移除 X 钮(labels/annotations 两段 | 同族问题:手机全屏 Modal 内 ~26px 移除钮触点不足(G) |
| `src/views/NamespaceDetail.vue:79` | P2 | 页头「进入命名空间」主 CTA + 同步按钮 | 页面主操作 ≈ 28px 触控目标(同行 CreateWithYamlButton 已带 max-sm:min-h-[40px],此两钮漏配,视觉高度也不齐) |
| `src/views/NamespaceDetail.vue:161` | P1 | Workloads 裸 <table>(5 列 Name/Type/Status/Repli | 未走 DataTable 且无横向滚动兜底:40 字符 workload 名不可断,5 列 min-content ≈ 700px,溢出被 section 的 overflow-hidden 直接裁掉 — Replicas/Age 列手机上 |
| `src/views/NodeDetail.vue:91` | P1 | NodeDetail 头部元信息行(嵌在 flex items-center justify | 头部元信息横排(StatusChip+IP+os·kernel+roles+arch+runtime+CORDONED)无 flex-wrap 无 min-w-0,min-content 约 430px+,叠加右侧 Cordon/Drain |
| `src/views/NodeDetail.vue:134` | P2 | 资源用量三列网格(CPU/Memory/Pods) | grid-cols-3 无 sm:/md: 断点变体,390px 下每列仅 ~98px,'31.3 Gi / 62.6 Gi' 等 mono 用量串折成多行、ProgressBar show-label 挤压(同页其他网格均做了 grid- |
| `src/views/NsHPADetail.vue:81` | P1 | HPA 详情页头部整行(flex items-center justify-between  | 详情页头横排不可折叠:左侧 56px 图标 + h1(32px 粗体,HPA 名为不可断行 DNS token)+ 无 wrap 的 meta 行(StatusChip+HPA 徽标+『Target: Deployment/xxx』不可断  |
| `src/views/NsHPADetail.vue:121` | P2 | Overview tab 目标信息双列卡(grid grid-cols-2 gap-md) | 两列网格无断点前缀(手机仍 2 列),每卡内容宽仅 ~123px,而 p 内是 mono 不可断 token『Deployment/api-gateway』(~158px)无 truncate/break-all,常见目标名直接戳出圆角卡边 |
| `src/views/NsHPADetail.vue:251` | P1 | Metrics tab 的裸 <table>(configured metrics 表,6  | 裸 <table> 6 列(metricName/type/targetType/targetValue/currentValue/status)未走 DataTable 卡片化,外层卡片是 overflow-hidden 而非 overf |
| `src/views/NsHPADetail.vue:308` | P2 | Metrics tab 底部指标明细双列卡(grid grid-cols-2 gap-lg  | 两列网格无断点前缀,每卡内容宽 ~107px,内部 flex justify-between 标签/值行(Average Utilization + 80% 等)挤压换行 2-3 行,明显拥挤错位 |
| `src/views/NsIngressDetail.vue:348` | P2 | 后端服务 chip <button class="flex items-center gap | py-0.5(2px)→ ≈24px 高的导航入口且 font-mono text-xs 文字小,无四件套;本页其余小钮均已按四件套处理,漏此 chip 组 |
| `src/views/NsLimitRangeDetail.vue:139` | P1 | 详情页头行 (icon + h1 LimitRange 名 + 编辑/删除按钮) | 同前两详情页头行破绽:无 wrap/min-w-0/truncate,56px 图标 + gap-lg + 32px 名 + 双钮 ~180px,名超 ~9 字符即总宽超 326px,按钮被推出视口、横向溢出 |
| `src/views/NsNetworkPolicyDetail.vue:103` | P1 | 详情页头 <div class="flex items-center justify-bet | 整行无 flex-wrap、左列无 min-w-0、h1 无 truncate:NetworkPolicy 名是长单词(如 deny-all-by-default ≈323px @display-lg),左侧 min-content ≈40 |
| `src/views/NsNetworkPolicyDetail.vue:128` | P1 | 详情 tab 条 <div class="flex border-b border-outl | 4 个 tab 仅 padding 就各占 64px,自然宽 ≈550px > 326px 且无 overflow-x-auto/flex-wrap → YAML tab(整页唯一全量编辑入口)手机截断不可直达;flex 收缩极限下 CJK |
| `src/views/NsNetworkPolicyDetail.vue:211` | P1 | Ingress Rules 裸 <table class="w-full text-left | 3 列每格 px-lg=64px,#/From/Ports min-content 合计常超 326px:describePeer 产出不可断长串(如 Namespace: kubernetes.io/metadata.name=defau |
| `src/views/NsNetworkPolicyDetail.vue:322` | P1 | Edit 弹窗 podSelector 行 <div class="flex items-c | 两个 flex-1 输入(px-md py-sm text-body-md font-mono,size=20 内在宽 ≈202px)无 min-w-0 不换行:行 min-content ≈473px > 手机全屏 Modal 内宽 34 |
| `src/views/NsPDBDetail.vue:88` | P1 | PDB 详情页头部整行(flex items-center justify-between  | 同款头部破绽且更重:『PodDisruptionBudget』徽标是不可断 token(~160px)+Age+h1 32px 粗体名+Edit/Delete 带字按钮,最小内容 ~448px vs 326px,操作按钮推出屏外、整页横向滚 |
| `src/views/NsPVCDetail.vue:116` | P1 | 详情页头行 (icon + h1 名称 + 编辑/删除按钮) | 头行无 flex-wrap、左块与 h1 无 min-w-0/truncate:56px 图标 + gap-lg(24) + 32px 加粗不可断行名 + 编辑/删除双钮(约196px),短名(8字符)也达 ~375px > 手机可用 32 |
| `src/views/NsPVCDetail.vue:235` | P2 | files tab 工具栏「上一级」「刷新」图标钮 (line 235/240) | 图标钮仅 icon 24px + p-xs(4px)=32px 见方且为唯一入口(无文字冗余),低于 40px 触控标准,无 max-sm:after 命中区扩展;无 hover 时 title 提示在触屏也不显示 |
| `src/views/NsPVCDetail.vue:251` | P2 | files tab 文件/目录行文件名 span 及预览头部 (line 256) | 文件名 mono 无 truncate/min-w-0(I 类):长文件名(45+ 字符 ≈ 324px > 卡内 ~276px)溢出行被卡片 overflow-hidden 裁尾;预览头部文件名同样无 min-w-0,长名把「← 返回列表 |
| `src/views/NsResourceQuotaDetail.vue:146` | P1 | 详情页头行 (icon + h1 配额名 + 编辑/删除按钮) | 同 NsPVCDetail 头行破绽:无 flex-wrap/min-w-0/truncate,典型配额名(如 my-resource-quota 17 字符 ≈ 290px)+ 图标 80px + 双钮 180px ≈ 550px > 3 |
| `src/views/NsResourceQuotaDetail.vue:186` | P2 | 配额条目标题行(图标 + 友好名 + 裸 mono key + 右侧百分比) | 左块友好名+裸 key 均不可断行无 truncate:persistentvolumeclaims 条目 = 'PersistentVolumeClaims'(170px) + '(persistentvolumeclaims)' mon |
| `src/views/NsServiceDetail.vue:466` | P2 | 页头 Edit 主按钮 class="... px-2.5 py-1 ... text-xs | Edit 主操作 ≈24px 高、加端口/加后端 ≈22px 高,均无四件套/max-sm:min-h;本页唯一带四件套的是 L556 删端口钮,其余小钮在触屏上难命中 |
| `src/views/NsServiceDetail.vue:537` | P2 | Service Ports 裸 <table class="w-full text-left | 未走 DataTable 且外层卡片是 rounded-lg overflow-hidden 无 overflow-x-auto:NodePort 型 Service 或命名端口较长(如 https-backend/hostname)时表格 |
| `src/views/NsServiceDetail.vue:792` | P1 | 统一 Edit 弹窗 selector 行 <div v-for... class="fle | 与创建弹窗同型:行 min-content ≈369px > 手机 Modal 内宽 342px,无 wrap/min-w-0 → 行删除钮在手机被切出弹窗可视区 |
| `src/views/PVDetail.vue:97` | P1 | 页头动作组(编辑/删除)与左侧标题块 | 326px 内容宽下:左块 floor(meta 行 StatusChip+Capacity+Age ≈230 + 图标80)≈310px,右组两钮 min≈100-120px,合计超宽 ~90px;即便修掉 t() 字面量,删除钮仍被推出 |
| `src/views/PVDetail.vue:99` | P1 | 编辑/删除按钮及两个 Modal 的按钮文案与标题(行 99/101/195/196/201 | 7 处 t('common.xxx') 未包 {{ }} 插值,Vue 模板按纯文本渲染,线上按钮/弹窗标题直接显示 t('common.edit')、t('common.delete') 等字面量(已在 dist/assets/PVDet |
| `src/views/PVDetail.vue:177` | P2 | 编辑 Modal 内 labels/annotations 行的移除 X 钮(行 177 与 | 手机档 Modal 全屏,删除某行 label/annotation 需点 ~26px 的 X 钮(p-xs+text-base 图标),紧邻输入框极易误触输入框(G) |
| `src/views/PodDetail.vue:175` | P2 | Files tab 文件浏览器主体(FileBrowserBody 内 SplitPane, | 横向双 pane 手机无自动收起/切换:326px 下左树只分得 ~104px(文件名几乎只剩图标),拖把 w-1(4px)触控极难命中;虽有右上角方向切换钮(手动竖切+localStorage 持久)可自救,但默认进入体验挤爆 |
| `src/views/PodDetail.vue:221` | P1 | PodDetail 头部(breadcrumbs + h2 'Pod: {name}' +  | 外层 row 无 wrap、左列无 min-w-0、h2 display-lg 无 truncate:pod 名哈希段(如 7f9c8c6f5a)在 36px 字号下 ~190px,加上已 wrap 的右侧钮组最宽 ~170px,合计 ~3 |
| `src/views/PodDetail.vue:259` | P1 | PodDetail 主控制台 tab 条(5 tab:日志/文件/YAML/终端/事件) | 5 个 tab 每个 px-xl(48px)+图标+文字 ≈110-136px,合计 540-680px >> 326px 可用宽;父卡片(col-span-12 lg:col-span-9 ... overflow-hidden)把超出部 |
| `src/views/PodDetail.vue:287` | P1 | 终端 tab 顶部工具条(容器选择+模式说明+Exec/Attach+kubectl deb | 单行 flex 无 wrap 无 overflow-x-auto:容器 label+select(font-mono,选项为容器名不可缩)+模式说明文本+Exec/Attach 两钮+debug 钮合计远超 326px,ml-auto 的「 |
| `src/views/StorageClassDetail.vue:97` | P1 | 页头动作组(设为默认/编辑/删除三钮) | 同款页头:左块 floor(meta 行 provisioner mono 不可断词 ~151px + 图标80)≈257px,右组三钮 min≈185px,合计≈442px > 326px;编辑与删除两钮整体落在可视区(≤326px)之外 |
| `src/views/StorageClassDetail.vue:124` | P2 | Details 卡 PROVISIONER 单元格(行 124)与 PARAMETERS 值 | grid-cols-2 在手机每轨仅 ~131px;provisioner 是点分不可断 mono token(rancher.io/local-path / kubernetes.io/aws-ebs ≈137-151px),单元格无 b |
| `src/views/StorageClassDetail.vue:170` | P2 | 编辑 Modal 内 labels/annotations 行的移除 X 钮(行 171 与 | 同 PVDetail:手机全屏 Modal 内 ~26px 移除钮,触控目标不足(G) |
| `src/views/WorkloadDetail.vue:125` | P2 | 「管理的 Pod」裸 <table>(Name/Status/Restarts/Node/A | 未走 DataTable(手机卡片模式)的裸表:5 列 × px-lg(32px/列) 仅内边距就 160px,加 mono pod 名/node 名内容 min-content 合计 ~360-390px > 294px 卡内宽;外卡是  |
| `src/components/common/DataKeysEditor.vue:126` | P1 | 创建 CM/Secret 弹窗自由键模式(左键列表+右内容,经 CreateConfigRe | A+L: 固定 grid-cols-[220px_1fr] 无手机变体,Modal 手机全屏(p-lg)内容宽 326px,右栏编辑区仅 ~90px,值 textarea/CodeViewer 挤成窄条,ConfigMap/Opaque S |
| `src/components/common/ResourceReferences.vue:70` | P1 | 引用反查裸 <table>(Workload/Type/RefType/Detail/Sta | D: 五列(detail 列含 mono 不可断串如 ENV ← ConfigMap.key)min-content ≈600px+,外层卡 overflow-hidden 硬裁无横滚,手机上 Detail/Status 列不可见 |
| `src/views/NsConfigMapDetail.vue:231` | P1 | 详情头部(icon + h1 资源名 + 删除按钮) | H+I: h1 无 truncate/break-all 且中间 flex 子项无 min-w-0,K8s 名为不可断单 token,>10 字符即把右侧删除钮推出屏并触发整页横滚(326px 内 icon 56+gap 24 已占 80p |
| `src/views/NsConfigMapDetail.vue:246` | P1 | 详情 tab 条(Data/References/Annotations/Labels/YA | E: tab 条 flex 无 wrap 无 overflow-x-auto,按钮 px-xl(48px/个)+标签: EN 五 tab ≈520px、ZH ≈390px > 手机内容宽 326px,EN 下 Annotations/Lab |
| `src/views/NsConfigMapDetail.vue:258` | P1 | Data tab 双栏文件浏览器(左 w-56 文件列表 + 右内容) | A+L: 左栏固定 w-56(224px) shrink-0 无手机收起/切换,390px 下右栏仅约 86-100px,文件名头(289 行 span 无 truncate)与 CodeViewer 在窄条里挤爆,编辑配置值基本不可用 |
| `src/views/NsConfigMapDetail.vue:296` | P2 | 右栏文件头 edit/delete 钮 | G: ~28px 触控目标无 after 四件套(左栏 271 行的 close 钮已配四件套,此处漏) |
| `src/views/NsConfigMapDetail.vue:383` | P2 | Labels tab 编辑行(input flex-1 + 保存/取消按钮横排) | C: 按钮横排+input min-content(≈170px)合计 ≈328px > 卡内可用 262px,卡 overflow-hidden 把取消钮裁掉;同文件注解编辑已用 flex-col(既有修复范式未复用) |
| `src/views/NsRoleBindingDetail.vue:99` | P1 | 详情头部(icon + h1 + 编辑/删除双按钮) | H+I: 同 SA 详情:101,长 RoleBinding 名把编辑/删除推出屏,整页横滚 |
| `src/views/NsRoleBindingDetail.vue:131` | P2 | Overview tab grid-cols-2 信息卡(roleRef name 常为 s | B+I: 同 NsRoleDetail:174,roleName(system:node-proxier 等)mono 不可断,155px 格装不下即溢出卡片 |
| `src/views/NsRoleBindingDetail.vue:209` | P1 | Subjects tab 裸 <table>(kind/name/namespace 三列) | D: 三列+px-lg×3 min-content ≈450px > 326px,卡 overflow-hidden 硬裁,namespace 列(subjects tab 的主内容之一)手机不可达 |
| `src/views/NsRoleBindingDetail.vue:271` | P2 | Edit Modal roleRef 区(kind select + name 输入 col | B: 同 NsRBAC:368,手机全屏弹窗下 kind select ~98px,ClusterRole 选项文本截断 |
| `src/views/NsRoleBindingDetail.vue:298` | P1 | Edit Modal subjects 编辑行(kind select + name 输入  | C: 单行 flex 无 wrap 无 max-sm:flex-col,kind=ServiceAccount 时三输入+40px 删除钮 min-content ≈530px > 弹窗内容 ~262px,行溢出、删除 subject 按钮 |
| `src/views/NsRoleDetail.vue:143` | P2 | 详情头部(icon + h1 角色名 + 删除按钮) | H+I: 同 CM 详情:143,ClusterRole 长名(system:controller:...-controller)必溢出,删除钮被推出屏;同页 Breadcrumbs 尾项同名同溢出 |
| `src/views/NsRoleDetail.vue:161` | P1 | Role 详情 tab 条(overview/rules/bindings/yaml) | E: 四 tab px-xl+英文标签 ≈410px > 326px,yaml tab(唯一直编入口)被裁到边缘,需整页横滚才可点 |
| `src/views/NsRoleDetail.vue:174` | P2 | Overview tab grid-cols-2 信息卡(name/namespace 为  | B+I: grid-cols-2 无 sm:/max-sm: 变体,手机每格 ~155px,ClusterRole 长名/长 namespace mono 无 break-all 直接穿透卡片圆角溢出 |
| `src/views/NsRoleDetail.vue:233` | P1 | Rules tab 裸 <table>(apiGroups/resources/verbs/ | D: 未走 DataTable 且无 overflow-x-auto,外层卡 overflow-hidden 把超出部分硬裁: 多 chip 规则行 min-content ≈460px > 326px,最右 actions 列(edit/ |
| `src/views/NsRoleDetail.vue:291` | P1 | Bindings tab 裸 <table>(name/namespace/roleKind | D: 五列 min-content(name mono+subjects chips+px-lg×5)≈600px+,卡 overflow-hidden 硬裁,手机上 subjects/age 列信息不可达 |
| `src/views/NsSecretDetail.vue:204` | P1 | 详情头部(h1 + type 徽章/keys/age 徽章行 + 删除按钮) | H+I: h1 无 truncate 且徽章行无 wrap:kubernetes.io/service-account-token 等长 type 名不可断,与 h1 一起把删除钮推出屏、整页横滚 |
| `src/views/NsSecretDetail.vue:221` | P1 | 详情 tab 条(与 CM 详情同构五 tab) | E: 同 NsConfigMapDetail:246,手机上尾部 tab(Labels/YAML)截断不可达,需整页横滚 |
| `src/views/NsSecretDetail.vue:267` | P2 | Data tab 键行动作钮(reveal/edit/delete) | G: 三个 ~28px 图标钮无命中区扩展,reveal(查密文明文)是 Secret 详情核心操作,手机连续误触 |
| `src/views/NsSecretDetail.vue:282` | P2 | Data tab 键值编辑行(textarea flex-1 + 保存/取消按钮横排) | C: shrink-0 按钮行不可缩+textarea min-content ≈328px > 262px,卡 overflow-hidden 裁掉取消钮(同文件注解编辑 324 行为 flex-col 正解) |
| `src/views/NsServiceAccountDetail.vue:101` | P1 | 详情头部(icon + h1 + 编辑/删除双按钮) | H+I: 双按钮(编辑+删除 ≈190px)+icon 80px 后 h1 可用宽仅 ~37px,任何正常 SA 名即溢出,编辑/删除被推出屏需整页横滚 |
| `src/views/NsServiceAccountDetail.vue:192` | P2 | Secrets tab 裸 <table>(name/type/keys/age 四列) | D: type 徽章 kubernetes.io/service-account-token 等长串无换行,四列 min-content 远超 326px,卡 overflow-hidden 硬裁,keys/age 列手机不可见 |

### W4 列表页/向导/workbench 剩余/admin/设置 — 98 条(P0:0 P1:28 P2:70)

| 文件:行 | 级 | 元素 | 问题 |
|---|---|---|---|
| `src/views/LogPopup.vue:53` | P2 | 弹窗页头栏关窗按钮 | 按钮高 ≈22px(py-0.5+16px 文案)远低于 40px 触控标准,是 /log-popup 页唯一应用内关窗入口(独立标签页无壳层);与 52 行挤爆问题叠加时可能被推出屏 |
| `src/components/common/ClusterCard.vue:115` | P2 | 删除集群 icon 钮(108 行切换钮同族) | icon-only 触控目标 28px(4px padding+20px icon)无四件套,是破坏性操作(删集群,仅 window.confirm 兜底);109 行「切换到此集群」按钮 px-3 py-1.5 ≈32px 高同样不足 4 |
| `src/components/common/DataTable.vue:213` | P2 | 手机卡片模式展开钮(共享组件破绽,本批 /admin/* 五路由 expandable 直接 | 卡片模式唯一的展开入口(YAML 查看依赖它)触控目标仅 ~24px 且紧贴行点击区,手机上难精确点中 |
| `src/components/common/DeployIngressControllerDialog.vue:139` | P2 | 控制器模板选择卡 grid | 手机全屏 Modal 下 grid-cols-2 每卡仅 ~163px,卡内标题/版本/描述/备注全挤双列,可读性差(B;文字可换行不至不可用) |
| `src/components/common/DeployIngressControllerDialog.vue:151` | P2 | 『返回选择』文字钮 | 纯 text-body-sm 文字钮无内边距,触高 ~16px,远低于 40px 触控标准(G) |
| `src/components/common/LocaleToggle.vue:23` | P2 | 登录页/选集群页右上角语言切换钮(zh/en) | 触控目标 ≈24px 高(4px×2+16px),无命中区补偿;它是这两页(无应用壳、用户菜单不可达)唯一的语言入口——看不懂中文的用户在手机上首次触达即依赖此钮 |
| `src/components/common/NsAllowlistEditor.vue:57` | P2 | ns chip 内的 × 移除钮 | G:× 字符 ~16px 见方且是移除额外 ns 的唯一路径,手机上几乎点不中 |
| `src/components/common/PortForwardPanel.vue:97` | P2 | 活动转发行 <div v-for=... class="flex items-center  | 长资源名无 truncate(flex-1 min-w-0 内 p.font-mono 直接排长名,溢出压右侧状态徽章);行尾 open_in_new/stop_circle 两钮 p-xs ≈26px 无四件套——NsServiceDet |
| `src/components/common/ToolOverrideEditor.vue:32` | P2 | 工具覆盖 chip 按钮(deny/allow 切换) | G:11px 字号+py-0.5 → ~20px 高触控目标,deny 是关掉工具的实质操作,手机上密集难命中(仅 ApiKeyManagement 消费) |
| `src/components/ssh/SshTerminal.vue:213` | P1 | SshTerminal 终端根容器(<div ref="root"> 之后无任何手机辅助条; | SSH 终端(浮窗 SshTerminalWindow + 独立页 /ssh-terminal-popup)无 isPhone 虚拟按键条也无字号热调:手机软键盘发不出 Esc/Tab/Ctrl+C/方向键,vim/top/中断命令等核心操 |
| `src/components/terminal/TerminalTaskbar.vue:219` | P2 | 任务栏根容器 32px 定高条;chip 本体 / closeAll(220) / pod  | 整条任务栏交互目标高 ~16-24px,仅各 chip 行内 ×(234/246/257/270)拿到 max-sm:min-h-[40px] max-sm:min-w-[40px] 补偿;手机上恢复终端的主入口(chip 本体)与杀全部会 |
| `src/components/terminal/TerminalTaskbar.vue:311` | P1 | SSH 会话菜单浮层(menuLeft=chip getBoundingClientRect | SSH 分组 chip 通常在任务栏右半屏,390px 视口下 left≈250px 的 200px+(行内容无 max-width,长 label 可撑到 300px+)菜单右缘越出屏外,行内关闭/改名钮不可达;同文件溢出面板(330 行 |
| `src/components/terminal/TerminalTaskbar.vue:320` | P2 | 会话菜单行关闭钮 span(杀 SSH 会话) | 触控目标 ~17px(2px padding+13px icon)且无四件套;紧邻的 317 行改名 span 同尺寸却带 relative max-sm:after:absolute max-sm:after:-inset-2 max-s |
| `src/components/userCenter/SecuritySection.vue:297` | P2 | 会话列表刷新图标钮(312 行吊销图标钮同型) | G:16px 图标+8px 内边距=24px 触控目标,无命中区扩展;同页 UserManagement 的同型按钮均带四件套,此处漏配 |
| `src/components/userCenter/TokensSection.vue:90` | P2 | 令牌行吊销图标钮 | G:24px 触控目标无命中区扩展,吊销是本行唯一操作且带确认弹窗,手机上难点中 |
| `src/components/workbench/WorkbenchChat.vue:1481` | P2 | 聊天 composer 发送/停止按钮 | w-8 h-8(32px) 是对话页最高频主操作,低于 40px 触控标准且无命中区扩展(G 类) |
| `src/views/AuditLogs.vue:98` | P2 | 统计卡三连:grid grid-cols-3 gap-sm(事件总数/Normal/Warn | 检查单 B:无断点前缀,390px 下每卡仅 ≈103px(内 content ≈71px),标签行(图标16+gap8+「事件总数」48=72px)必折行、卡片挤压明显;能用但难看 |
| `src/views/AuditLogs.vue:151` | P2 | DataTable #resource 槽按钮:Kind/relatedName mono  | 检查单 I:whitespace-nowrap 的 mono 长值(Pod/cert-manager-5d8f9b6c5-x2k9z ≈230px+)超出卡片 kv 值列(≈204px)被 overflow-hidden 硬裁,无省略号,资 |
| `src/views/ClusterCerts.vue:173` | P2 | B 段过滤 pills(全部/30 天内/已过期) | py-0.5+text-xs 仅 ~20px 高的过滤 pill,触控目标远低于 40px 且无命中区扩展 |
| `src/views/ClusterEvents.vue:58` | P2 | 类型过滤 pills(All/normal/warning) | py-xs(4px)+text-xs 仅 ~24px 高,触控目标低于 40px 且无四件套;整行 flex-wrap 本身没问题 |
| `src/views/ClusterEvents.vue:89` | P2 | DataTable #message 列插槽 span | 手机卡片模式下 kv 值容器是 min-w-0 overflow-hidden,消息内的不可断长串(sha256/镜像引用)被静默裁断且无省略号,消息尾部内容丢失(桌面档有 overflow-x-auto 不受影响) |
| `src/views/ClusterOverview.vue:253` | P2 | 侧栏事件消息 <p>{{ event.message }}</p> | 事件 message 为 K8s 原文未截断(mapEvent 直传),常见含 sha256 摘要/registry 长引用等 64+ 字符不可断串(~380px+),p 无 break-words/truncate,文字画出卡片边界并把  |
| `src/views/ClusterResourceList.vue:191` | P1 | 页头 h2 {{ cfg.title }}(五路由共用) | MutatingWebhookConfigurations/ValidatingWebhookConfigurations 是单个不可断单词(29/31 字符 24px ≈ 380-415px),加右侧刷新钮 ~90px 恒溢出 326px |
| `src/views/ClusterResourceList.vue:196` | P2 | 页头刷新按钮 | py-1.5(12px)+ body-sm 行高 16px ≈ 28px 触控目标,低于 40px 且无扩区 |
| `src/views/ClusterResourceList.vue:225` | P2 | 行删除图标钮(actions 槽,卡片模式 kv 行内) | 4px padding + 16px 图标 ≈ 24px 触控目标,无 max-sm:after 四件套 — 手机上破坏性操作(删 APIService/Webhook)命中区过小 |
| `src/views/Clusters.vue:71` | P2 | 页头动作条两按钮(同步 / 添加集群) | 按钮高 ≈32px(6px×2+20px 行高)<40px 触控标准,无 max-sm 命中区补偿;同页搜索框清除钮(89 行)已带四件套,本组漏网 |
| `src/views/Configuration.vue:128` | P1 | Configuration 页 tab 条(ConfigMaps/Secrets/Resou | 五个 tab 合计 ~477px >> 326px(ResourceQuotas 单 tab 129px),无 overflow-x-auto 无 wrap;手机上 LimitRanges/HPA 两个 tab 初始截断不可见,资源类型大面 |
| `src/views/CrdList.vue:87` | P2 | DataTable 卡片模式标题槽 #name 的 router-link(CRD 名) | 检查单 H+I:自定义槽丢掉默认 truncate;长 CRD 名(globalrbacdefinitions.rbacmanager.rekuberate.io 48ch≈346px > 卡内 ≈268px)溢出被硬裁,mono 域名不可 |
| `src/views/DeployApp.vue:859` | P2 | 六步步骤指示器(圆圈 w-8 + 连接线 w-8 md:w-16) | 标题已做 hidden md:inline(好),但 6×32px 圆 + 5×(32px 线+8px margin) ≈ 392px > 326px 卡内宽:flex 收缩把 w-8 圆压成 ~21px 宽的竖椭圆(数字溢出变形),步骤导 |
| `src/views/DeployApp.vue:990` | P1 | 向导 KV 行/端口行:labels 行(990-994)、容器端口行(1112-1118) | flex-1 的 input 保留 intrinsic min-width(size=20 ≈170px+px-md),两输入+删除钮 min-content ≈385px;端口行更深嵌套(三层 p-md 后可用仅 ~230px)溢出 ~1 |
| `src/views/DeployApp.vue:1641` | P2 | 向导底部主操作行(上一步/取消/下一步/部署) | 整页最关键的「下一步/部署」按钮 py-1.5 ≈32px 高 < 40px 触控下限,无 max-sm:min-h 补偿;软键盘弹起时误触率高(取消与部署相邻仅 gap-sm) |
| `src/views/IngressClasses.vue:85` | P1 | 列表页头标题 + 部署控制器/创建两按钮行 | 右侧两钮『部署控制器』+『创建 IngressClass』min 合计≈230px,左标题 min-content(Ingress 词 ≈120px)合计≈360-440px > 326px(en 更宽);创建钮尾部被裁,英文档下更甚——本 |
| `src/views/IngressClasses.vue:118` | P2 | actions 插槽 star/edit/delete 三颗图标钮(手机卡片模式) | 手机卡片模式下这三颗 p-xs 钮(~28px)是列表内设默认/删除唯一入口的触点,无 max-sm:after 命中区扩展,触控目标 <40px(G;行点击可进详情、详情页有同款操作,故降为打磨) |
| `src/views/LogPopup.vue:52` | P2 | 顶栏 mono 定位串 span:{{ ns }}/{{ pod }}:{{ contain | flex 子项无 truncate/min-w-0 且外层是 style=height:36px 定高头栏:实际 ns/pod/container 串(default/nginx-ingress-controller-7f4c8b6d4-x |
| `src/views/MonitoringCenter.vue:161` | P2 | Top Pods 的 CPU/内存 切换钮(同型:eventFilter 全部/警告钮, l | py-0.5(2px)+text-xs 行高仅 ~20px 高的切换钮,触屏命中率差且无 max-sm:after 命中区扩展,误触切错指标/过滤 |
| `src/views/NamespaceOverview.vue:244` | P2 | 页头 h1 命名空间名 + 右侧按钮组 | 检查项H/I:28px 粗体 ns 名不可断词且无 truncate,左侧最小宽(icon 48+gap 16+名字)加上右侧 调整分组+部署 SplitButton 约 134px,ns≥12 字符(kube-system 级别)即溢出  |
| `src/views/NamespaceOverview.vue:338` | P2 | 卡片右侧 w-[116px] 关联栏内 Service/Ingress 跳转按钮 | 检查项G:这两枚小按钮是概览卡跳转 Service/Ingress 详情的唯一入口,高度仅约 26px 且无命中区扩展 |
| `src/views/Namespaces.vue:143` | P2 | 页头同步按钮 | ≈ 28px 触控目标低于 40px,无扩区处理 |
| `src/views/Namespaces.vue:172` | P2 | Actions 槽三联图标钮(进入/编辑/删除,卡片模式 kv 行内) | 34px 触控目标且三钮仅隔 4px,删除(破坏性)与编辑紧邻 — 手机误触风险(有确认弹窗兜底故非 P1) |
| `src/views/Network.vue:79` | P1 | Network 页 tab 条(Services/Ingress/Endpoints/Net | 四个 tab 标签实测 428px(Services 94+Ingress 84+Endpoints 104+NetworkPolicies 134)>> 326px,flex 无 wrap 无 overflow-x-auto;靠 main |
| `src/views/Nodes.vue:143` | P2 | Nodes 表 #actions 列的 cordon/uncordon/drain 图标钮( | 图标钮 p-sm(~36px,低于 40px)且语义全靠 :title tooltip——触屏无 hover,手机上 lock/lock_open/output 三图标无任何文字说明,用户无法区分 cordon 与 drain(drain  |
| `src/views/NsEvents.vue:62` | P2 | 事件类型过滤胶囊按钮(All/normal/warning) | 类型过滤是本页核心筛选控件,py-xs(4px)+text-xs(16px 行高)≈ 24px 高触控目标,无 max-sm:after 四件套,手机上连续切换过滤极易误触 |
| `src/views/NsHPA.vue:157` | P2 | HPA 列表 actions 槽的 open_in_new/delete 图标按钮 | actions 列在 DataTable 手机卡片模式下渲染为『Actions』键值行,两颗图标钮(p-xs=4px + text-sm 图标 ≈ 24-28px 命中区)无 max-sm:after 四件套,删除为破坏性操作却只有 ~28 |
| `src/views/NsIngress.vue:241` | P2 | 列表 actions slot 两个图标钮 <button class="p-xs text | p-xs(4px)+text-lg 图标 ≈26px 触控目标,无 max-sm:after 四件套;手机卡片模式下 actions 渲染为 kv 行,两个 26px 钮相邻易误触且难点中 |
| `src/views/NsIngress.vue:326` | P1 | 创建弹窗自定义注解行 <div v-for... class="flex items-cen | AnnotationKeySelect 是原生 select 且页面传的 field-class 无 w-full/flex 项 min-w-0,其内在宽由最长 option『suffix — 中文描述』(如 whitelist-sourc |
| `src/views/NsLimitRanges.vue:147` | P2 | LimitRange 表格行内动作钮 (open_in_new / delete) | 同 NsResourceQuotas 行钮:text-sm 图标 + p-xs ≈ 22px 触控目标,无 max-sm:after 命中区,delete 误触风险 |
| `src/views/NsNetworkPolicies.vue:102` | P2 | 页头创建按钮 <button class="flex items-center gap-sm | py-1.5(6px)→ ≈28px 高的页头主操作,无 max-sm:min-h-[40px];同页 SplitButton 类按钮均已带 max-sm:min-h,此页未跟 |
| `src/views/NsNetworkPolicies.vue:108` | P2 | 过滤 tab 条 <div v-if="nsNetworkPolicies.length"  | 无 overflow-x-auto/flex-wrap:自然宽 zh ≈410px、en(Ingress Only…)≈450px > 326px → 「双向/Both」tab 被裁;flex 强缩下 CJK 标签逐字竖排(明显错乱),en |
| `src/views/NsNetworkPolicies.vue:161` | P2 | 列表 actions slot 两个图标钮 <button class="p-xs text | 同 NsIngress actions:p-xs ≈26px 触控目标无四件套,手机卡片模式 kv 行内难命中且 delete 为危险操作 |
| `src/views/NsPDBs.vue:186` | P2 | PDB 列表 actions 槽的 open_in_new/delete 图标按钮 | 与 NsHPA 同型:手机卡片模式下 actions 键值行里两颗 ~24-28px 图标钮无命中区扩展,删除操作触控目标过小(本页 139 行搜索清除钮已带四件套,同页不一致) |
| `src/views/NsPods.vue:142` | P2 | 页头右侧操作组 (WatchStateChip + 批量删除 + LIVE + Create | 检查项C:四个控件自身最小宽合计约 400px(zh;en 更宽),两 层 flex 均无 flex-wrap,超 326px 可用宽,标题被挤压、Create Pod 主按钮被推出屏外 |
| `src/views/NsResourceQuotas.vue:126` | P2 | 列表页头行 (h2 标题 + CreateWithYamlButton) | 无 flex-wrap:h2 'ResourceQuotas'(24px ≈ 175px) + '新建 ResourceQuota' SplitButton(≈ 215px) ≈ 390px > 326px,SplitButton 尾部 c |
| `src/views/NsResourceQuotas.vue:176` | P2 | 配额表格行内动作钮 (open_in_new / delete) | 手机卡片模式下动作钮仅 text-sm 图标(14px) + p-xs(4px) ≈ 22px 见方,远低于 40px 触控标准且无命中区扩展,delete 破坏性操作紧邻 open 钮易误触 |
| `src/views/NsServices.vue:213` | P2 | 页头标题+按钮行 <div class="flex justify-between item | 无 flex-wrap/gap:右侧按钮组 min-content ≈110px(Endpoints,px-3 py-1.5)+8+183px(SplitButton「创建 Services」+箭头)≈300px,加左侧标题 min-con |
| `src/views/NsServices.vue:262` | P2 | 列表 name slot <span class="font-mono text-xs fo | 四处列表页自定义 name slot 均无 truncate/min-w-0(仅 icon shrink-0 + 名文本):手机卡片模式标题区外层虽有 min-w-0,但 slot 内长 DNS 名(63 字符上限,如 helm 生成长名) |
| `src/views/NsServices.vue:356` | P1 | 创建 Service 弹窗 selector 行 <div v-for... class=" | 两个 flex-1 输入(px-sm py-sm text-body-sm font-mono 内在宽 ≈162px each)无 min-w-0 无 wrap:行 min-content ≈369px > 手机全屏 Modal 内宽 34 |
| `src/views/NsStorage.vue:201` | P2 | PVC 表格行内动作钮 (open_in_new / delete) | 手机卡片模式下 actions 仍渲染为 kv 行,两颗图标钮仅 24+8=32px 见方且彼此相邻,delete 为破坏性操作,误触率高(G 类:无 max-sm:after 命中区) |
| `src/views/NsWorkloads.vue:145` | P1 | 类型摘要 4 格栏 (Deployments/StatefulSets/DaemonSets | 检查项B:grid-cols-4 无 sm: 变体,390px 下每格仅约 75px,而 icon(20)+gap(8)+英文标签('StatefulSets'≈88px)+ml-auto 计数最小宽约 136px;格子 overflow- |
| `src/views/NsWorkloads.vue:204` | P2 | DataTable 手机卡片模式下 image 槽(及 name 槽) | 检查项I:手机卡片里长镜像名(harbor 域名/路径 45+ 字符≈324px)超出可用宽,被 overflow-hidden 无省略号地拦腰截断,看起来像渲染残缺而非截断提示 |
| `src/views/PriorityClasses.vue:101` | P2 | 列表页头标题 + 创建按钮行 | zh 标题『优先级类 (PriorityClasses)』的不可断词 (PriorityClasses) 在 32px display 字号下 min-content ≈260px,加创建钮(icon+『Create PriorityCla |
| `src/views/PriorityClasses.vue:154` | P1 | actions 插槽 open_in_new / delete 图标钮(手机卡片模式) | 本页 DataTable 未挂 @row-click(对照 IngressClasses/RuntimeClasses 均有)→ 手机卡片模式点卡片无任何跳转,进详情只能靠 ~28px 的 open_in_new 小钮;且 Priority |
| `src/views/RBAC.vue:108` | P2 | 页头行:flex justify-between items-end(标题+副标题 \| 权 | 检查单 C:无 flex-wrap;标题侧副标题单行 ≈271px + 按钮侧 ≈216px 互挤 → 手机上按钮文字折行(「权限\n模拟」「Create\nRole」)与多行副标题并排,items-end 底对齐明显错位(同型页头 Crd |
| `src/views/RBAC.vue:123` | P1 | tab 条:flex items-center gap-xs border-b,内含 3 个 | 检查单 E:zh/en 标签同为单个不可断行英文词,三钮最小内容宽 ≈79+166+141+gaps ≈394px > 326px 可用,无 flex-wrap 无 overflow-x-auto → ServiceAccounts tab |
| `src/views/RbacCanI.vue:170` | P2 | 推演结果行 p.text-xs.font-mono(subjectKind + subjec | 检查单 I:subjectName 无 break-all(datalist 恰恰提供 system:serviceaccount:kube-system:xxx 这类 54ch≈389px 不可断名),把结果卡右缘撑爆被 overflow |
| `src/views/RuntimeClasses.vue:68` | P1 | 列表页头标题 + 创建按钮行 | zh 标题『运行时类 (RuntimeClasses)』不可断词 (RuntimeClasses) min-content ≈265px + 创建钮 ≈180px,合计≈445px > 326px → 创建钮被裁剩一条(C/N) |
| `src/views/RuntimeClasses.vue:90` | P2 | actions 插槽 delete 图标钮(手机卡片模式) | 手机卡片模式删除钮 ~28px 触点,无命中区扩展(G;行点击进详情后页头有删除,故打磨级) |
| `src/views/Settings.vue:364` | P1 | Components tab 裸 <table class="w-full text-lef | 检查单 D+I:未走 DataTable 且无 overflow-x-auto;message 列为 mono 组件健康消息(etcd/scheduler 的 https://…/healthz 长 URL,不可断行)→ 表格最小内容宽 ≈ |
| `src/views/Settings.vue:457` | P2 | Settings 多处小触控目标:MCP 开关(457)与 MFA 开关(621)w-12  | 检查单 G:全部 <40px 命中区且无 max-sm:after 四件套(本三文件 grep max-sm:after:content 为 0 处,其他 views 已普遍铺设);MFA/MCP 开关是功能唯一入口,24px 高在触屏上易 |
| `src/views/Settings.vue:522` | P1 | Settings 全部主操作钮:transfers 保存(522)、终端策略保存(572)、 | bg-primary 与 text-primary 引同一 CSS 变量 → 按钮文字与背景同色,「保存」标签在手机(及桌面)上不可见,只剩一块色块(注:非视口专属,但直接命中本页手机可用性;全站其余按钮均为 bg-primary text |
| `src/views/Settings.vue:541` | P1 | 终端与会话 tab 三组策略输入行(label + number input + 单位):v | 检查单 A:label 固定 w-56(224px)+shrink-0,而行容器仅 ≈260px(326−卡片 p-md×2 嵌套)→ 224+8 后 input 只剩 ≈28px 或行溢出被卡片 rounded-xl overflow-h |
| `src/views/Settings.vue:639` | P1 | 安全策略 tab 输入行:密码最小长度(588)与 OIDC 七字段(issuer/clie | 检查单 A 同源:w-56(224px)+shrink-0 标签把 flex-1 min-w-0 输入框压到 ≈28px 宽 → 手机上 Issuer URL/Client Secret 等 SSO 配置无法检视输入内容,redirectU |
| `src/views/Storage.vue:184` | P1 | Storage 页 tab 条(PersistentVolumeClaims/Persist | tab 标签是全仓最长的三条:合计 ~470px >> 326px,无 overflow-x-auto 无 wrap;手机上 StorageClasses tab(PV/SC 是本页两个核心 tab)初始不可见,需横向拖动页面才能切换 |
| `src/views/Storage.vue:373` | P2 | 创建 StorageClass 弹窗的 parameters KV 行(key+value  | 同 DeployApp KV 行根因:双 flex-1 input intrinsic min ≈212px/个,行 min-content ~460px > 手机全屏 Modal 内容宽 ~326px;Modal body 是 overf |
| `src/views/UserProfile.vue:33` | P1 | profile 五 tab 条(data-testid=profile-tabs) | E:五个 tab(资料/安全/活动/访问令牌/偏好设置)合计最小宽 zh≈444px、en≈501px,远超手机可用 ~294px;zh 下 CJK 逐字换行成竖排多行标签,en 下尾部 tab(Preferences)被推出视口,只能整页 |
| `src/views/WorkbenchLedger.vue:102` | P1 | 知识 tab 头部控件组(集群选择+Bootstrap+蒸馏台账) | 父级虽有 flex-wrap,但控件组本身是一个不可换行的 flex 子项:select min-w-[180px] + 两个按钮 ≈427px > 手机可用 ~294px,整组横向溢出,蒸馏/Bootstrap 按钮要在 pane 级横向 |
| `src/views/WorkbenchLedger.vue:167` | P2 | 蒸馏 diff 审批弹窗双栏(现有 vs 蒸馏后可编辑) | grid-cols-2 无断点前缀:手机全屏 Modal(common/Modal isPhone)下两栏各 ~150px,两块 mono 学习笔记并排挤爆不可读(B 类) |
| `src/views/WorkbenchProjects.vue:192` | P2 | 项目卡换绑集群 select(bind-cluster) | py-0.5 + text-body-xs(11px) 触控目标仅 ~22px 高,远低于 40px,且 select 不能挂伪元素无命中区扩展(G 类) |
| `src/views/WorkbenchRecords.vue:180` | P2 | 存储路径明细(dbPath/workbenchDir) | 服务端绝对路径(如 /home/.../data/xxx.db,60+ 字符)是长 unbreakable mono 串,span 无 break-all/truncate → 溢出卡片边界(I 类) |
| `src/views/WorkbenchRecords.vue:193` | P1 | 对话记录行(状态chip+预览+项目名+计数+时间) | shrink-0 项合计 ~250-270px(status chip mono、projectName 无上限、'N💬 N↻' 计数、w-14 时间),手机行宽 ~294px,flex-1 truncate 的预览(该行的主体信息)只剩  |
| `src/views/WorkbenchRecords.vue:221` | P2 | 审计记录行(时间+来源badge+工具名+resource+结果) | ts w-24(96px) + 工具名 shrink-0 不可断(apply_project_manifests 等 ≈120-152px mono)+ badge + 结果,固定项 ~320-360px > ~294px:行整体横向溢出, |
| `src/views/WorkbenchShell.vue:56` | P1 | Workbench 顶部 tab 条(项目/服务器/知识/记录) | flex 无 wrap 无 overflow-x-auto,且 WbStage 根 overflow-hidden 硬裁:中文档四 tab≈376px>356px 靠 CJK 逐字换行挤下;英文档(Projects/Servers/Know |
| `src/views/Workloads.vue:128` | P1 | Workloads 页头(标题+副标题 \| Export 按钮 + CreateWithY | zh 下「工作负载」(display-lg 144px min-content)+Export(~88px)+新建工作负载 SplitButton(~130px)+gap 合计 ~370px > 326px,英文 locale 更宽;无 w |
| `src/views/admin/AiBehaviorConfig.vue:204` | P1 | 工具开关行内的工具名 span | H+I:行内容区 ~226px,固定项=开关36+工具名+审批徽章42;最长名 apply_project_manifests(23字符≈166px,requiresApproval:true)合计 ~260px,超出 ~34px,徽章/描 |
| `src/views/admin/ApiKeyManagement.vue:199` | P1 | boundSA 单元格(手机卡片模式 kv 值区) | H+I+N:值区仅 ~174px,健康点+mono ns/name(如 kube-system/aliangboard-smoke ≈191px)+代管徽章+修复链接+SSH 开关 nowrap 一行,尾部被 DataTable 卡片值区  |
| `src/views/admin/ApiKeyManagement.vue:228` | P2 | 签发 Modal 内双列表单网格(253 行第二处、296 行明文元数据同型) | B:手机 Modal 全屏后每列仅 ~167px,输入框 px-md 后内容区 ~135px 放 mono SA namespace/SA 名(placeholder aliangboard-smoke 已贴满),标签折两行;表单明显挤 |
| `src/views/admin/AuditTrail.vue:67` | P1 | 页头(标题+校验链完整性按钮+校验结果+刷新按钮) | C:zh 右侧按钮组(校验链完整性≈104px+链完整✓+刷新)占 ~231px,标题 MCP / API-key 调用审计 被压缩到 ~63px 宽(headline-lg 28px),折成 5-6 行窄柱;按钮内部也逐字换行,页头明显错 |
| `src/views/admin/GroupsGrants.vue:168` | P2 | 左栏组卡头部的新建组输入框 | A:卡片内宽 ~260px,固定 w-40+按钮 zh 合计 ~268px 已超,en(New Group)超 ~64px,靠按钮文字折两行勉强塞下,输入框宽度不随屏折叠 |
| `src/views/admin/GroupsGrants.vue:176` | P2 | 组行(chevron+组名+成员数+授权数+两图标钮) | 行内容区 ~226px,两个计数 span(成员 N/授权 N≈64px)+两按钮+图标+5 个 gap 占 ~168px,组名仅剩 ~60px,platform-admins 类名字被截到 6-7 字符;主标识被次要计数挤压 |
| `src/views/admin/GroupsGrants.vue:187` | P2 | 成员添加图标钮(220 行 ns 添加图标钮同型) | G:图标钮仅 ~24px 高、无命中区扩展;同文件 181/182/191/226 行同族按钮都带四件套,这两处漏配 |
| `src/views/admin/LlmConfig.vue:110` | P2 | 当前有效配置状态区三列网格 | B:手机仍 3 列,每列仅 ~76px,baseURL/model 的 mono break-all 文本(https://api.deepseek.com/v1)被拆成逐字竖排 3-4 行,来源徽章再挤一行,明显挤爆;同页 Securit |
| `src/views/admin/LlmConfig.vue:148` | P1 | 主操作行(保存/测试连接/检测思考能力) | C:三钮合计 zh≈316px > 卡片内宽 ~262px,zh 下按钮文字折成两行(检测思考能/力);en(Save/Test Connection/Probe Reasoning)最小宽 ~317px 直接溢出,检测按钮被推出卡片 |
| `src/views/NsConfigMaps.vue:109` | P1 | 搜索行(搜索框 + 计数 + 批量删除面板) | C: 行无 flex-wrap(同页 NsSecrets.vue:127 已有 flex-wrap),勾选行后批量面板(文案+删除+取消 ≈190-250px)+搜索框 min-content(≈173px)+计数超 326px,行溢出、批 |
| `src/views/NsConfigMaps.vue:144` | P2 | 列表行动作钮 open_in_new/delete(DataTable actions 槽) | G: p-xs+text-sm ≈24px 触控目标且无 after 四件套;卡片模式 kv 行同样渲染此槽(actions 列在 headers 内),手机上逐行删除/打开详情易误触 |
| `src/views/NsRBAC.vue:264` | P2 | RBAC 各 tab name 槽(icon+名称 span) | I: 卡片模式标题槽覆写掉了默认 truncate(206 行),ClusterRoles tab 的 system:controller:... 超长名被卡片 overflow-hidden 硬裁且无省略号,读不全(196/216/230 |
| `src/views/NsRBAC.vue:310` | P2 | ClusterRoleBindings tab 行删除钮(actions 槽) | G: p-xs+text-lg ≈28px 触控目标无 after 四件套,卡片模式渲染为 kv 行,误触行点击(本 tab 无 row-click,误触无害但目标过小) |
| `src/views/NsRBAC.vue:368` | P2 | 创建 ClusterRoleBinding 弹窗 subject 区(kind select | B: grid-cols-3 无 sm: 变体,手机全屏弹窗内容 326px 下 kind select 仅 ~98px,ServiceAccount 选项文本被原生 select 截断难辨 |
| `src/views/NsSecrets.vue:129` | P2 | 类型过滤 chips(手写内联过滤,未走 FilterBar) | G: py-xs+text-xs ≈26px 触控高 <40px 无扩展命中区,且是 Secrets 页唯一类型过滤入口,手机点选困难 |
| `src/views/NsSecrets.vue:172` | P2 | 列表行动作钮 open_in_new/delete | G: 同 NsConfigMaps:144,卡片模式下行动作钮 ~24px 触控目标无命中区扩展 |

### 被复核推翻(19 条,不修)

| 文件:行 | 原问题 | 推翻理由 |
|---|---|---|
| `src/views/NodeDetail.vue:170` | 裸 <table> 未走 DataTable 且外层无 overflow-x-auto;'MemoryPressure'(~105px不可断)+ 三列 px-m | 实测推翻:用项目自建 dist CSS+自托管 Inter(500)在 390px 复刻该表,真实 min-content=306px(Type 146.2=NetworkUnavailable 114.2+32/Status 71.4/L |
| `src/views/RBAC.vue:136` | 检查单 H:自定义标题槽覆盖了 DataTable 默认槽的 truncate(line 206),span 无 truncate/min-w-0 → 长角色名 | 实测推翻:槽内 span 无 truncate 也无 whitespace-nowrap,white-space:normal 使浏览器在连字符处断行(UAX#14)——用真实 dist CSS+自托管 Inter/JetBrains Mo |
| `src/views/Settings.vue:606` | 检查单 C:长 label「令牌有效期上限(天)」≈120px shrink-0 + w-32(128px) + 保存钮 ≈314px > 行容器 ≈260px | 390px 实测(真实 dist CSS+Inter 字体):TTL 行内容盒 258px,中文 label 120px 下 input 经 flex 收缩至 82px(number input automatic minimum 实测 7 |
| `src/views/IngressClassDetail.vue:193` | 同上:controller 点分 mono token(k8s.io/ingress-nginx ≈137px)在 ~131px 轨道内无 break-all, | 实测驳回:默认 white-space:normal 下浏览器在 ingress-nginx 的连字符后折行(headless Chromium + 项目构建 CSS 实证:两行 106.8px+35.6px),最长行 179.8px 仍在 |
| `src/views/PriorityClassDetail.vue:40` | value 徽标内 value 为裸数字(system-cluster-critical=2000000000000 → 『value: 20000000000 | 量化前提错误:system-cluster-critical value 实为 2000000000(10 位,int32 上限内不存在 13 位值,徽标实际 ~130px 非 ~145px),且其 globalDefault=false  |
| `src/views/ClusterRoleBindingDetail.vue:96` | roleName(system:controller:bootstrap-signer-controller 46 字符 ≈ 368px)不可断无 trunca | 实测推翻(Playwright 390px 复刻 p-margin32+border1+p-lg24 → 行内 276px,与审计的 278px 卡片一致):所述 roleName 含连字符,默认 CSS 换行规则下连字符是断行点,min- |
| `src/views/ClusterResourceList.vue:220` | replicasets 的 owned by Deployment/xxx-hash 是 38-44 字符不可断 token(≈ 274-317px),超 kv | 几何属实(390px 下 kv 值区实测恰 204px,DataTable.vue:221 确为 min-w-0 overflow-hidden)但核心事实错误:「38-44 字符不可断 token」不成立——Chromium 在空格和连字 |
| `src/components/common/Breadcrumbs.vue:8` | 末项是 ClusterRole/CRB 名等不可断长名:RBAC › ClusterRoles › system:controller:xxx(40+ 字符)≈ | 实测推翻:所述 system:controller:* 名均含连字符可断(flex 收缩后折 2 行,54 字符名溢出仅 26px 被 32px p-margin 完全吸收;唯一不可断的下划线名也仅溢 59px 仍在 390 视口内),且  |
| `src/views/NsWorkloadDetail.vue:1227` | 检查项H/I:24px 粗体单行名是不可断词的 DNS 名,容器链无 min-w-0、h1 无 truncate;约 11 字符以上的名字(极常见)即把右侧操作 | 实测推翻:390px/326px 内容宽浏览器复刻(token 精确转译)证明 3 字符短名页头已溢出 105px,与 h1 长度无关;26 字符带连字符 DNS 名默认在 hyphen 断行成 4 行(宽仅 103px)不撑宽,「不可断词 |
| `src/components/common/Pagination.vue:30` | 检查项C:行内最小宽约 337px('10 / 页' select≈90 + '1-10 / 共 47' nowrap≈75 + 前后钮各32 + 页码 min | 实测推翻(Playwright 真渲染 390px):Pagination min-content=286px 非 337(select 66 非估算 90、chevron 钮 24 非预设 32——icon 继承 body 16px),N |
| `src/views/NsWorkloadDetail.vue:2149` | 检查项A/C:NodePort/LoadBalancer 类型下三个定宽输入(96+112+96)+冒号+删除钮合计约 354px,超过手机全屏 Modal 内 | 实测推翻:用项目 dist 编译 CSS + 真实字体在 390px Chromium 实测,行总宽 338.14px(删除钮被 text-sm 钳到 13.92px 而非 24px,冒号 4.22px),手机全屏 Modal 内容盒 34 |
| `src/components/common/IngressPerfField.vue:56` | 输入 w-full(=格宽)+单位下拉 min-content ≈50px,在 NsIngress 创建弹窗 perf 组 grid grid-cols-2(格 | 元素与 grid-cols-2 属实,但实测(390px 视口+真实编译 CSS+真字体,Chromium)w-full 数字输入可收缩:其 flex 自动最小宽塌到 padding+border≈34px,行 min-content 实为 |
| `src/views/NsPVCDetail.vue:152` | grid-cols-2 无 max-sm 变体,卡内每格仅 ~131px;Bound PVC 的 volume 恒为 pvc-<36位uuid>(mono 12 | 实测反驳:CSS 默认断行在连字符后换行,pvc-<uuid> 最长不可断块=12 hex ≈86px < 格内文本区 98px(390−64 main p-margin−50 卡 padding−16 gap),Chromium 实测 v |
| `src/views/NsPVCDetail.vue:146` | tabs 条 flex 无 wrap 无 overflow-x-auto,但本页仅 3 个短 tab(状态/文件/YAML 约 300px)在 326px 内放 | 证据属实但发现自我结论即"不构成破绽":390px 视口下内容宽 326px(AppLayout p-margin=32px×2),三 tab 硬编码字面量 ['overview','files','yaml'] 非动态,zh(状态/文件/ |
| `src/views/NsLimitRanges.vue:110` | 同 RQ 列表页头行破绽但幅度小:en 语境 'LimitRanges'(≈140px) + 'New LimitRange'(≈195px) ≈ 335px  | 实测推翻:390px 下该头行零溢出——en 实宽 142.1+169.6=311.7px ≤ 326px(余量 14.3px,chevron 完整);zh 恰好 326px 装下(scrollWidth==clientWidth,仅按钮文 |
| `src/views/WorkbenchServers.vue:245` | w-[860px] 固定宽:ServerLedgerPanel 每段头部 flex items-center justify-between 的 保存 按钮(x | w-[860px] 类名属实但不生效为固定宽:该 div 是 fixed inset-0 flex justify-center 父级的 flex 子项且 overflow-y-auto 直接长在其上,flex-shrink:1 + min |
| `src/views/WorkbenchLedger.vue:130` | summary 文案 span 无 truncate/min-w-0(AI 生成的 summary 长度无界),同行还排 查看 diff/忽略 两钮,横排不换行 | 承重前提"summary 长度无界"不成立:summary 是服务端计数模板 `${lines.length} 条 learnings`(distill.mjs:89),pending_distills 唯一写入者是调度器(index.mj |
| `src/views/WorkbenchRecords.vue:146` | w-20(80px) 固定宽装 'x MB · N 文件'(~110px)内容,overflow 可见向左溢出盖住相邻进度条,手机 294px 行内更明显(C  | 类名属实但机制不成立:该 span 无 whitespace-nowrap/truncate(全局 CSS 与 font-mono 均无 white-space 规则),内容每个 token 后都有软换行点且最长不可断 token(~46p |
| `src/components/common/ClusterForm.vue:76` | B:添加集群 Modal 手机全屏时两列各 ~167px,mono 用户名输入内容区仅 ~135px,标签折行,挤 | 类名与列宽算术属实(每列 ~159-166px),但唯一具象症状「标签折行」被实测推翻:标签为 用户名/密码(zh 33px)/Username/Password(en ~44px),11px 字号在 159-166px 列内单行富余极大, |

