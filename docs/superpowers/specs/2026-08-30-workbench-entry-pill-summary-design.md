# 工作台入口 · 顶栏胶囊信息丰富化(角标+悬停面板)

- 日期:2026-08-30
- 状态:已与用户 brainstorm 定稿(形态=角标+悬停面板;内容=项目清单/运行中对话/快捷动作/待审批/SSH 会话数;实现=方案 A 单一汇总端点+Vue Query 轮询)
- 前置:2026-08-28-workbench-entry-prominent-design.md(方案 C3 品牌胶囊,本设计在其上叠加信息层,不推翻既有契约)
- 影响文件:
  - 服务端:`server/routes/workbench-projects.mjs`(新增 summary 分支)、`server/index.mjs`(deps 注入)
  - 前端:`src/components/layout/WorkbenchEntryPill.vue`(新)、`src/components/layout/TopNavBar.vue`(内联按钮换组件)、`src/api/client.js`(+summary)、`src/views/WorkbenchShell.vue`(query 一次性读取)、`src/views/WorkbenchProjects.vue`(+openCreate prop)
  - i18n:`src/i18n/zh.json` / `en.json`(`workbench.pill.*` 键族)
  - 测试:`server/routes/workbench-summary.test.mjs`(新)、`src/components/layout/__tests__/WorkbenchEntryPill.test.js`(新);既有 `TopNavBar.workbench-entry.test.js` 必须保持绿

## 1. 背景与目标

2026-08-28 方案 C3 把工作台入口从纯图标升级为品牌胶囊,但胶囊本体至今只有「图标+文字」——零信息量。用户希望入口直接携带工作台状态:不进工作台就能看到项目活跃度、有没有对话在跑、有没有待审批、开了几个 SSH 终端,并能从入口一键跳到具体项目。

目标:**入口即仪表**——胶囊带状态角标,悬停出概览面板;点击行为不变(直达 `/workbench`)。

## 2. 现状与约束

**现状**:胶囊在 TopNavBar 右区第一位(刷新按钮之前),`aria-label=nav.workbench`,激活态 `/workbench*` 前缀;点击 `router.push('/workbench')`。工作台侧:`workbench_projects`(归属 ownerId/''哨兵未绑定/repoRoot)、`workbench_conversations`(status=running 等)、conv-bus 内存快照(pending 审批)、`terminal-sessions` 内存 Map(会话带 userId)。

**硬约束**:

1. **全站挂载**:胶囊随 TopNavBar 渲染在每一页。数据获取必须是单一轻量端点+节流轮询;禁止全量 `listProjects` 语义加重(列表页已有);禁止长连接(浏览器 6 连接预算,workload watch 化事故教训)。
2. **既有胶囊契约不破坏**:`TopNavBar.workbench-entry.test.js` 的全部断言(存在/文字标签/位置在刷新前/点击直达 `/workbench`/激活态类名)必须继续通过——按钮 DOM 结构与类名原样保留,仅实现移入子组件。
3. **归属与隐私**:项目按 `listProjects(db,{userId,role})`(admin=全部,普通=own);SSH 会话数**人人只数自己的**(含 admin;`/api/ssh/sessions` 的 admin 全量观测语义不动)。
4. **导航静默原则**:summary 拉取失败不 toast(全站挂载,失败弹窗=灾难),保留旧数据+面板内细字提示。
5. **路由鉴权单表**:`/api/workbench/summary` 落在既有 `/api/workbench/` 前缀(platform)覆盖内,无需新登记;守卫测试不受影响。
6. **单进程不变式**:SSH 会话计数读 `terminal-sessions` 内存 Map(SSH 会话本就是进程态,重启归零属预期)。待审批计数**不依赖内存**——对话表 `pendingApproval` 列在 agent 暂停时落库(`status='paused'`),resume/取消时清空,重启不丢;纯 SQL 可查(conv-bus 内存快照仅服务实时 SSE,不作为计数源)。
7. **样式/i18n 政策**:Material token、无新增强效动画;新键 zh/en 双语齐备,`npm run i18n:check` 门禁绿;消息值不含 HTML(无需 v-html)。
8. **传送层惯例**:悬停面板 Teleport body + fixed 定位 + `zScale.popover`(110),防 TLS 下拉同款裁切。

## 3. 服务端:`GET /api/workbench/summary`

`server/routes/workbench-projects.mjs` 新分支(置于 `/api/workbench/projects` 块之前),`requirePlatform` 鉴权:

```jsonc
{
  "projects": [   // 归属过滤;排序:pendingApprovals↓ runningConvs↓ lastActiveAt↓(待办优先);截 8 条
    { "id", "name", "clusterId", "clusterName", "lastActiveAt", "runningConvs", "pendingApprovals" }
    // clusterId===''(''哨兵未绑定)→ clusterName: null
  ],
  "totals": { "projects": 12, "runningConvs": 1, "pendingApprovals": 2, "sshSessions": 3 }
  // totals 为全量口径(不随 projects 截断);缺字段前端按 0 容错
}
```

聚合实现(全轻量):

- **项目集**:`listProjects(db, { userId: ps.userId, role: ps.role })`,clusterName 同既有 `clusterNameOf`('' → null)。
- **运行中/最近活跃**:一条 `SELECT projectId, count(*) FILTER (status='running') , max(updatedAt) FROM workbench_conversations GROUP BY projectId`(仅取该用户项目集),JS 合并。
- **待审批/运行中**(与上一条同一查询):`SUM(CASE WHEN status='paused' AND pendingApproval IS NOT NULL THEN 1 ELSE 0 END)`——`pendingApproval` 列由 agent 暂停时落库、resume/取消时清空(workbench-agent.mjs),是持久权威源。
- **SSH**:`sshTerminals.list().filter(s => s.userId === userId).length`(现成 userId 字段,2026-08-29 属主校验同源)。

**deps 注入**:`createWorkbenchProjectRoutes` 增收 `listSshSessions`(index.mjs 已有 `sshTerminals.list` 同名包装,复用同一表达式)——测试注入假件,不直依赖单例模块。错误消息键 `wbp.summaryReadFailed` 入 `server/messages/wbp.mjs`(zh/en 双语)。

## 4. 前端

### 4.1 `WorkbenchEntryPill.vue`(新组件)

**胶囊本体**(类名/契约与 C3 逐字一致):`workspaces` 图标 + `$t('nav.workbench')` + 描边浅底/激活填充两态 + `aria-label` + 位置不动。新增:

- **角标**(同一时刻最多一枚,优先级):`totals.pendingApprovals > 0` → 红底白字数字;否则 `totals.runningConvs > 0` → 静态绿点(纯色圆点,无动画,不涉 `prefers-reduced-motion`);均 0 → 无角标。
- **title 摘要**:「{n} 项目 · {r} 运行中 · {p} 待审批 · {s} SSH」(i18n 片段拼接,纯文本)。
- 点击:`router.push('/workbench')` 不变。

**数据**:`useQuery({ queryKey: ['workbench-summary'], queryFn: workbenchApi.summary, refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, staleTime: 15_000, enabled: 已登录, retry: 1, placeholderData: keepPreviousData })`。TopNavBar 全站常驻 ⇒ 全站唯一轮询器;路由切换不重取(staleTime 内)。

**client.js**:`summary: () => platformHttp.request('/api/workbench/summary')`。

### 4.2 悬停面板

- **触发/关闭**:`mouseenter` 150ms 延迟开(防掠过);`mouseleave` 200ms 宽限关、`Escape` 关、点击面板外关、点击面板内任一链接后关。
- **定位**:按钮 rect → Teleport body + `position: fixed`,顶部贴按钮下缘、右缘对齐按钮右缘并 clamp 视口内(≥16px 边距);`z-index` 取 `Z.popover`(`src/styles/zScale.js` 单一事实源)。Teleport 后面板不再是胶囊 DOM 子节点——跨 8px 间隙的面板 `mouseenter` 取消关闭、`mouseleave` 重启宽限。
- **键盘路径**:面板为悬停增强、不抢焦点无 trap;键盘用户直达 `/workbench` 落地页(同信息同入口)。
- **结构**:
  1. 汇总 chips 行:项目 N · 运行中 N · 待审批 N · SSH N
  2. 项目行(≤8):左=项目名 + 集群名/未绑定徽章(复用 `workbench.unboundBadge`);右=相对时间 + 绿点(运行中)+ 红 chip「{n} 待审」。整行点击 → `/workbench/:id`
  3. 快捷区:「新建项目」→ `/workbench?create=1`;「集群台账」→ `/workbench/ledger`;「记录」→ `/workbench?tab=records`(三键人人可见;「服务器」tab 才是 admin)
  4. 空状态:0 项目 → 「还没有项目」+ 新建项目按钮
  5. 数据过期细字:拉取失败且有旧数据时显示「更新失败,显示 {t} 前数据」;首次加载即失败显示「加载失败」(见 §5)
- **相对时间**:组件内小 helper(刚刚/{n} 分钟前/{n} 小时前/{n} 天前,超 7 天回退 `MM-DD`),i18n 单位键,不引依赖。

### 4.3 落点改造(小)

- `TopNavBar.vue`:内联 `<button>`(现 :269-280)替换为 `<WorkbenchEntryPill />`,其余不动。
- `WorkbenchShell.vue`:onMounted 一次性读 `route.query`——`tab` 合法时设 `activeTab`,`create=1` 时向 WorkbenchProjects 传 `openCreate`;不改 tab 的组件内状态模型(不做双向路由同步)。
- `WorkbenchProjects.vue`:新增可选 prop `openCreate: Boolean`,`watchImmediate` 置 `showCreate=true`。

## 5. 错误处理与降级

- 失败不 toast;`keepPreviousData` 保旧值;面板细字标注数据时间。首次加载即失败 → 面板显示加载失败细字,胶囊无角标(等同 0)。
- 401:`enabled` 随登录态失效,轮询停止;角标消失,登录后恢复。
- 字段容错:`totals` 缺失按 0;`projects` 缺失按空数组(旧网关+新前端不炸)。
- 面板打开时数据在途:显示既有数据或骨架行,不阻塞交互。

## 6. 测试与验收

**服务端**(node --test,deps 假件注入):
- 普通用户只见自己项目/对话计数;admin 看全部
- `''` 哨兵未绑定项目列出且 `clusterName: null`
- running 计数;`status='paused' AND pendingApproval IS NOT NULL` 行 → pending 计数;paused 但 pendingApproval 为 NULL 不计
- SSH 计数按 userId 过滤(admin 也只数自己;listSshSessions 假件注入)
- >8 项目:projects 截 8 且待审/运行中排前;totals 全量
- 未认证 401(requirePlatform 既有)

**前端**(vitest + happy-dom):
- 胶囊契约:aria-label/类名两态/点击 push `/workbench`;既有 TopNavBar 测试继续绿(位置在刷新前)
- 角标优先级:pending 红数字 > running 绿点 > 无
- 悬停 150ms 开面板(fake timers);行点击导航;Escape/外点/链内点击关闭
- 汇总 chips/空状态/快捷区渲染;数据失败无 toast
- WorkbenchShell `?tab=`/`?create=1` 一次性读取;WorkbenchProjects openCreate

**i18n 门禁**:`npm run i18n:check` 绿(新键双语齐备、无残留中文)。

**手测**(需真机+网关重启):角标 30s 内更新/窗口聚焦即刷新;窄窗口面板不裁切;`?create=1` 自动开弹窗;普通用户 SSH 数不含他人;待审批真实对话中出现并计数;网关重启后待审批仍在(`pendingApproval` 持久化)、running 由既有 salvage 收敛。

## 7. 不做的事(YAGNI)

- 不做实时推送(SSE/WS)——30s 轮询对导航级信息足够,避免全局长连接
- 不改 `/api/ssh/sessions` admin-only 语义
- 不做面板内审批决策/会话终止等操作(只读概览+跳转)
- 不做 tab 路由双向同步(仅一次性 query 读取)
- 不做白名单排序配置/用户自定义面板内容

## 8. 迭代补记(2026-08-30 当日用户反馈,均已合 main)

1. **角标常驻化**(2a504d2):原设计角标仅在待审批/运行中 >0 时出现,用户反馈「入口一眼要有信息」→ 改三态常驻:待审批红数字 > 运行中绿数字 > 项目数中性徽章,0 活跃也不空。
2. **内联迷你统计条**(ee44067):≥lg 视口胶囊内直接展示「N 项目 · N 运行中 · N 待审批」三段(0 也显示),数字按状态着色(项目中性/运行绿/待审批红),标签词弱灰;SSH 不上条(悬停面板看)。`hidden lg:inline-flex`,窄屏由单枚状态徽章接管(`lg:hidden`),两形态互斥防信息重复。复用既有 pill 键 + 新增短标签键 `kProjects/kRunning/kPending`(zh/en)。顶栏预算:整胶囊 ≈210px,shrink-0 由搜索收缩链吸收(issue #3 契约)。
