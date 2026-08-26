# Pod 日志查看器对比度修复 + 工具栏双行重构设计(2026-08-26)

## 背景与目标

用户反馈:pod 卡片点日志后,日志页深色背景(`bg-code-surface`=#0b1c30)下大量 info 字体也是深色,视觉困扰;顶部工具栏杂乱难用。

**根因**(违反「暗底代码主题单源」约定,`src/styles/code-theme.js`):`LogViewerBody.vue` 渲染容器只有 `bg-code-surface` 漏了 `text-on-code-surface`(#cfe3ff)——消息正文继承应用主题 `text-on-surface`(浅色主题=深字压深底);时间戳/`[INFO]` 标签/空态又用 `text-outline-variant`(边框 token 冒充文字色);搜索命中段 `text-on-surface` 同病。全仓 grep 证实:**LogViewerBody 是 7+ 个暗底消费方中唯一漏网**(其余 CodeViewer/YamlEditor/FilePreview/CreateResourceDialog/NsPVCDetail/NsWorkloadDetail diff/DeployApp 均成对使用;xterm 终端主题走 codeTheme 对象)。

**目标**:①渲染区全部文本绑定暗底语义色,两种应用主题下均清晰可读;②工具栏按「双行分区」重构,解决挤乱/不统一/不顺手。**非目标**:不加新功能(字号/主题切换/着色开关等,用户未要求);不换渲染引擎;不动过滤/跟随/计数等既有逻辑。

## 已裁决决策

| 决策点 | 结论 |
|---|---|
| 工具栏布局 | 双行分区(第一行数据源查询,第二行查看控制),用户 ASCII 示意图确认 |
| 等级色位置 | 组件内常量表(仅日志一处消费,不升 code-theme.js——避免为不存在的亮色日志主题过度设计) |
| 范围 | 仅 LogViewerBody.vue(单文件为主;PodDetail 内嵌 tab 与 LogPopup 新标签页同源受益) |

## 修复明细(6 处)

| 位置(现行号) | 现状 | 改为 |
|---|---|---|
| 渲染容器 ~L174 | `bg-code-surface` 无文字色 | 补 `text-on-code-surface` |
| 时间戳 ~L177 | `text-outline-variant/70` | `text-on-code-surface/50` |
| `[级别]` 标签 ~L178 | ERROR 外全 `text-outline-variant` | 常量表 `LEVEL_COLORS`:ERROR=`text-error`;WARN=`text-tertiary-fixed-dim`(不变);INFO=`text-primary-fixed-dim`(token 经 `MD_PALETTE` 展开存在,#4edea3;fixed 系即固定暗面安全变体,且与工具栏 INFO chip 既有的 primary 身份一致);DEBUG/其他=`text-on-code-surface/60` |
| 搜索命中段 ~L179 | `text-on-surface` + `bg-primary/30` | `text-on-code-surface` + `bg-code-surface-selection`(codeTheme 既有选区色 #1f3b5e) |
| 空态 ~L175 | `text-outline-variant` | `text-on-code-surface/60` |
| follow 光标条 | `bg-primary` | 不变(深底可见) |

## 工具栏双行布局

- **第一行·数据源**(容器/行数/时间窗/previous/follow):三个 select 统一紧凑规格(`h-8`、mono、同 focus ring);previous/follow 统一「checkbox+label+激活高亮」样式(沿用现有激活变色逻辑);live 徽标不变。
- **第二行·查看控制**:搜索框(`flex-1 min-w-40` 加宽)+正则开关 → 竖分隔线 → 级别 chips(激活态加重:`font-semibold`+底色提浓,计数与标签间右对齐间距)→ 竖分隔线 → 折行/时间戳 → 右侧操作组(刷新/下载/复制统一 `p-1.5 rounded-lg hover:bg-surface-container-low`)。
- 两行各自 `flex items-center gap-md` 不换行溢出挤压;行间 `border-b` 分隔。所有 testid(`log-container/log-lines/log-since/log-previous/log-follow/log-search/log-regex/log-level` 等)原样保留。

## 测试与验收

- 存量 `LogViewerBody.test.js`(缓冲 cap/跟随滚动)+ `useLogViewer.test.js` 回归全绿——布局重构零逻辑改动。
- 新增轻量断言:渲染容器 class 含 `text-on-code-surface`;级别标签按 `LEVEL_COLORS` 映射(ERROR/INFO 各一例);命中段高亮 class 更新。
- 最终以用户浏览器目验(样式断言只防回归不评美感);两种应用主题各看一眼。

## 风险

| 风险 | 对策 |
|---|---|
| 工具栏重构破坏现有 testid/交互 | testid 全保留;交互(过滤/跟随/下载/复制)逻辑零改动,vitest 回归兜底 |
| happy-dom 下 class 断言脆 | 只断言关键语义类存在,不断言完整 class 串 |
