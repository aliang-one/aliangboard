# Pod 日志新标签页查看器设计（2026-08-25）

## 背景与问题

- Workload Overview 中列的 Pod 卡片（`PodCard.vue`）只有终端 / 文件快捷入口，**无日志入口**；NsWorkloadDetail 右列的「日志」按钮（:547 `viewLogs`）只是页内跳转 `PodDetail#logs`。
- Pods 列表页（`NsPods.vue`）行内同样没有日志入口。
- `PodDetail.vue` 的 logs tab 功能完整（容器切换 / tail / since / previous / follow 流式 / 下载 / 复制），但被埋在详情页里，且工具栏存在硬编码英文。

## 目标

1. PodCard（Overview 中列 / Pods tab / NsPods 列表 / Service Endpoints 全部复用处）获得日志快捷按钮。
2. 点击日志 → **浏览器新标签页**打开独立日志页（TerminalPopup 同构模式），全屏日志 + 常用工具栏。
3. 日志查看器抽成共享组件 `LogViewerBody`，PodDetail 页内 logs tab 换用同款，获得全部新工具——单一事实源。

## 非目标

- 不做服务端 grep / 多 pod 聚合日志（仅前端过滤已加载行）。
- 不做虚拟滚动、不引新依赖（遵守仓库零依赖政策；现有依赖足够）。
- 不做浮动窗口 / 任务栏集成（用户裁决：直接新标签页）。
- 不做流中断自动重连（手动刷新，避免重连风暴）。

## 用户裁决记录（2026-08-25 澄清）

| 决策点 | 结论 |
|---|---|
| 打开方式 | 直接浏览器新标签页（不经过浮动窗口体系） |
| 工具集 | 基线七件套 + 关键字搜索/高亮（正则开关）+ 智能自动滚动（含「回到底部」）+ 折行/时间戳切换 + 级别过滤 |
| PodDetail 日志 tab | 换成同源共享组件，同步获得新工具 |

## 架构与数据流

```
PodCard 日志按钮 / NsWorkloadDetail viewLogs
  → openLogTab() → window.open('/log-popup?ns&pod&container&token', `log-${ns}-${pod}-${container}`)
      → LogPopup: api.k8s 拉 pod spec 组容器下拉（containers+initContainers+ephemeralContainers，失败回退仅 URL 容器）
      → LogViewerBody:
          非流式: api.k8s GET .../log?tailLines&sinceSeconds&previous   （一次性）
          流式:   k8sStream(.../log?follow=true) → 逐行 parseLogLine → 环形缓冲(cap 5000)
          过滤/搜索/高亮 = computed 纯前端（只作用于已加载行）
```

关键可行性事实（已核实）：

- `main.js:19-22`：`?token=` 从 URL 写入 sessionStorage 与路径无关，LogPopup 直接复用。
- 集群上下文由 session token 在服务端绑定（`server/index.mjs:514`），无需额外集群参数。
- 路由守卫豁免：`router/index.js:514` `if (to.name === 'TerminalPopup') return` 改为数组含 `LogPopup`。
- 具名 target（`log-{ns}-{pod}-{container}`）：同一 pod+容器重复点击复用同一标签页并聚焦；不同容器各开一页。

## 改动面清单

| 文件 | 动作 |
|---|---|
| `src/components/common/PodCard.vue` | 加日志按钮（终端/文件旁，icon `subject`），新增 `showLogs` prop 默认 true；**不受 canExec 禁用**（CrashLoopBackOff 看 previous 日志是刚需） |
| `src/views/NsWorkloadDetail.vue` | 右列 `viewLogs` 从页内跳转改为 `openLogTab`；Overview 中列 / Pods tab 卡片经 PodCard 自动获得入口 |
| `src/views/NsPods.vue` | 经 PodCard 自动获得入口，无直接改动 |
| `src/views/PodDetail.vue` | logs tab 内容替换为 `<LogViewerBody>`，删本地日志逻辑约 90 行 |
| `src/router/index.js` | `/log-popup` 路由（name `LogPopup`，仿 `TerminalPopup`）+ 守卫豁免数组化 |
| **新** `src/logic/podLogs.js` | 纯函数（见「逻辑分层」） |
| **新** `src/composables/useLogViewer.js` | 响应式编排 + `openLogTab()` 导出 |
| **新** `src/components/common/LogViewerBody.vue` | 工具栏 + 日志渲染区 |
| **新** `src/views/LogPopup.vue` | 顶栏（pod 名 + ns/pod:container + 关闭）+ 容器列表自拉 + LogViewerBody |
| `src/locales/{zh,en}.json` | 新键（`component.logViewer.*` / `logPopup.*` / `component.podCard.logsTitle`）+ PodDetail 日志区硬编码英文（Container:/Lines:/Since:/Previous/Follow）i18n 化 |

服务端零改动；无新增依赖。

## LogViewerBody 工具栏规范

单行 flex-wrap，沿用现有 select/checkbox 风格：

| 分组 | 控件 | 行为 |
|---|---|---|
| 查询 | Container 下拉 / Lines(100/500/1000/5000) / Since(全部/5m/15m/1h/6h) / Previous ☑ / Follow ☑ | 照搬 PodDetail 现有语义；Previous 开启自动关 Follow；任一变更重启流或重拉 |
| 搜索 | 输入框 + 正则开关 | 仅过滤已加载行；默认不区分大小写子串；正则模式 try/catch 编译，非法正则显示提示不崩溃；命中片段高亮 |
| 级别 | ERROR / WARN / INFO 三个 chip | 多选默认全开；chip 带缓冲区内计数（如 `ERROR 12`）；一键只看错误 |
| 显示 | 折行 ☑(默认开) / 时间戳 ☑(默认开) | 折行=`whitespace-pre-wrap`，关=横向滚动；时间戳关=只看消息列 |
| 操作 | 刷新 / 下载 / 复制 | 刷新=按当前模式重启流或重拉；下载/复制导出**过滤后的可见行**（WYSIWYG） |

状态行：工具栏右侧显示「已加载 N 行 / 可见 M 行」。

组件接口：

```
props: { namespace, podName, containers (string[]，PodDetail 传 base+debugContainers 合并结果，LogPopup 传自拉列表) }
emit : v-model:container  // PodDetail 跨 tab 共享 selectedContainer；LogPopup 自持
```

PodCard 日志按钮点击时默认选第一个容器（与终端/文件入口一致），页内可切换。

## 智能自动滚动（following 状态机）

- 新日志到达且 `following=true` → `nextTick` 滚到底。
- 用户上滚（距底 >40px）→ `following=false`，新行不再扰动视口。
- 暂停期间右下角悬浮按钮「↓ 回到底部（N 新行）」，N=暂停后新增行数；点击滚底并恢复跟随。
- 初始加载（含非 follow 静态拉取）自动滚到底——日志从尾往前看。

## 高亮与 XSS 安全

不用 v-html：computed 把每行消息拆成 `{text, hit}` 片段数组，模板 `v-for` 渲染 `<span>`，日志内容天然转义（文本插值），XSS 免疫，不涉及 dompurify。

## 错误处理矩阵

| 场景 | 表现 |
|---|---|
| 流中断（follow 中） | 缓冲追加一条 ERROR 行 + 顶部细条提示「流已中断」，点刷新重连；不自动重连 |
| 静态拉取失败 / 容器未启动（Pending） | 单条 ERROR 行 + 提示可试 Previous |
| Pod/容器 404 | 顶栏下横幅错误 + 空日志区 |
| 空日志 | 空态「暂无日志」 |
| 组件卸载 / 标签页关闭 | `abort()` 断流（现有 onUnmounted 模式） |
| LogPopup 无 token | 复用 TerminalPopup 的「会话已过期」整页提示 |

## 逻辑分层与测试

```
src/logic/podLogs.js        纯函数：parseLogLine、buildLogQuery、compileFilter(搜索+正则+级别)、
                             highlightSegments、isNearBottom、环形缓冲 cap 逻辑
src/composables/useLogViewer.js   响应式编排：流式状态机、following、错误、下载/复制格式化、openLogTab
src/components/common/LogViewerBody.vue   展示
src/views/LogPopup.vue      壳
```

- `parseLogLine` 从 PodDetail.vue 迁入 `src/logic/`。
- 测试（遵循仓库惯例：colocated `src/logic/*.test.mjs` node:test 风格 + vitest 组件测试）：
  - `src/logic/podLogs.test.mjs`：级别识别边界、buildLogQuery 参数组合、非法正则容错、高亮拆分正确性、缓冲截断、isNearBottom 阈值。
  - `src/components/common/__tests__/LogViewerBody.test.js`：渲染行、搜索过滤、级别 chip 过滤、previous↔follow 互斥、模拟滚动暂停/恢复、下载内容=过滤后行。
  - `src/views/__tests__/LogPopup.test.js`：URL 参数→容器列表拉取→渲染。
- 门禁：`npm test`（test:server + test:unit）/ `npm run typecheck` / `npm run i18n:check` / `npm run build`。

## 手测清单（需集群）

1. Workload Overview 中列 PodCard 点日志 → 新标签页打开，容器/行数/时间筛选生效。
2. Pods 列表页 PodCard 点日志 → 同上；具名 tab 复用（同 pod+容器二击聚焦不新开；换容器新开）。
3. CrashLoopBackOff Pod：按钮可点，勾 Previous 看崩溃前日志。
4. Follow 流式实时滚动；上滚暂停出现「回到底部（N）」，点击恢复。
5. 搜索关键字/正则高亮；级别 chip 只看 ERROR。
6. 下载/复制内容=过滤后可见行。
7. PodDetail logs tab：新工具齐全，与终端/文件 tab 的容器选择联动（v-model:container）。
8. LogPopup 关闭标签页 → 网络面板确认流断开（abort）。

## 遗留与后续（不在本期）

- 服务端 grep / 跨 pod 日志聚合（如需再做）。
- 日志时间范围自定义（现仅预设档）。
- 终端 TerminalPopup 与 LogPopup 顶栏组件抽取共用（两者结构相似，本期各自独立，避免过早抽象）。
