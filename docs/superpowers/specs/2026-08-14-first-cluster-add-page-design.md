# 首装添加集群独立页设计

日期:2026-08-14
状态:已与用户确认(brainstorming 三个关键决策均已拍板)

## 背景与问题

首装(平台尚无任何集群)时,admin 登录后被弹到 `/select-cluster`,空状态的「添加集群」按钮直接
`router.push('/admin/clusters')` —— 该页是 AppLayout 子路由,首装用户带着完整应用外壳(30+ 项侧栏、
顶栏、命名空间选择器)进来,只为在管理页的一个小 modal 里填表单;且添加成功后不自动连接、不导航,
admin 被困在管理页,只能靠点侧栏项(被守卫弹回)或登出离开。集群 Overview 的大量数据(节点/Pod
计数等)只有连上集群后才有意义。

目标:添加集群做成**独立全屏页面**(AppLayout 外,与 Login/SelectCluster 同级),创建成功后
**自动连接并进入 Overview**。

## 已确认的决策

| 决策点 | 结论 |
|--------|------|
| 添加成功后去向 | 自动 connect-cluster → 直接进入 `/cluster` Overview |
| 入口范围 | SelectCluster 顶部 admin 常驻「添加集群」入口(不限首装);管理页 modal 保留用于日常管理 |
| 实现方式 | 方案 A:独立页 + 从 ClusterManagement 抽取共享 ClusterForm 组件 |

## 设计

### 1. 路由与守卫

- 新增路由 `/add-cluster`,name `AddCluster`,与 `Login`/`SelectCluster` 同级(AppLayout 外),
  组件 `src/views/AddCluster.vue`。页面自查 admin 的时机:onMounted 且 `authStore.user` 已由守卫
  fetchMe 填充(守卫先于组件挂载执行),直接读即可。
- meta:`{ requiresCluster: false, requireAdmin: true, titleKey: 'addCluster.title' }`
- 守卫(`src/router/index.js` + `src/router/clusterGate.js`)**不改逻辑**:
  - 无 K8s session 时 `resolveWhenSessionMissing` 对 `requiresCluster: false` 放行(clusterGate.js:14 已覆盖);
  - 有 session 时走原有 `api.session()` 验证。
- 非 admin 手输 URL:守卫不检查 `requireAdmin` meta,由 AddCluster.vue 挂载时自查
  `authStore.isAdmin`,false 则 redirect 回 `SelectCluster`;服务端 `POST /api/admin/clusters`
  的 requireAdmin 是最终兜底。

### 2. 页面与组件

- **`src/views/AddCluster.vue`**(新):SelectCluster 同款布局——`min-h-screen flex
  items-center justify-center`、hub 图标、标题「添加集群」+ 副标题;「← 返回选择集群」链接;
  提交过程显示「正在连接集群…」loading 态。
- **`src/components/common/ClusterForm.vue`**(新):从 `ClusterManagement.vue`(现 70-96 行)
  抽取的受控组件:`props: { form: Object }` + `emits: ['submit', 'cancel']`。字段与现状一致:
  集群名称、凭据方式 tabs(kubeconfig / token / basic)、按方式显隐的凭据输入、insecure checkbox。
- **新增前端必填校验**(现状完全没有,裸发吃 400):
  - 名称必填;
  - kubeconfig 方式:kubeconfig 非空;
  - token 方式:apiServer + token 必填;
  - basic 方式:apiServer + username 必填。
  校验失败在表单内联红字提示,不 emit submit。
- **`ClusterManagement.vue` 改造**:modal 内联表单替换为 `<ClusterForm>`,行为不变
  (notify 提示、成功后刷新列表),校验职责移入 ClusterForm。

### 3. 添加成功后的闭环(AddCluster.vue)

1. `adminApi.clusters.create(form)` —— 服务端创建时已探测 `/version` 验证凭据;
   失败(400/502)→ 页面内联错误条,**表单内容保留**。
2. 成功 → `authStore.connectCluster(res.cluster.id)`(内部自动写 LAST_CLUSTER_KEY + saveSession)
   → `clusterStore.setConnectedCluster({ apiServer, version })`
   → `window.location.href = '/cluster'` 整页跳转进 Overview(与 SelectCluster 连接成功路径
   完全一致,复用守卫水合逻辑)。
   提交按钮自身 disabled+spinner 覆盖「创建中」;创建成功后页面切换到「正在连接集群…」态。
3. create 成功但 connect 失败(如集群入库后凭据失效):显示警告「集群已添加,但连接失败:xxx」
   +「重试连接」「返回选择集群」两个动作。集群已入库,**不回滚**。

### 4. SelectCluster 改动(`src/views/SelectCluster.vue`)

- 空状态「添加集群」按钮:`router.push('/admin/clusters')` → `router.push('/add-cluster')`。
- 顶部常驻入口:admin 在已有集群时也能加新集群——标题行右侧次级「添加集群」小按钮(admin 可见)。
- 底部「集群管理」链接保留不动(删除/日常管理仍走 AppLayout 内管理页)。

### 5. i18n

- ClusterForm **复用现有 `admin.clusters.*` 表单键**(clusterName / authKubeconfig / authToken /
  authBasic / pasteKubeconfig / username / password / insecureTls / addAndVerify),不造重复键。
- 新增 `addCluster.*` 页面级键(标题 / 副标题 / 返回 / 连接中 / 已添加但连接失败 / 重试连接等),
  zh + en 两份,`npm run i18n:check` 过门禁。

### 6. 测试

- vitest(`npm run test:unit`)新增:
  - `ClusterForm.test.js`:三种凭据方式切换显隐、四条必填校验、submit/cancel 事件;
  - `AddCluster.test.js`:非 admin 重定向、create 失败内联错误且表单保留、create 成功 →
    connectCluster → 跳 `/cluster`、connect 失败显示重试态。
- 现有 `clusterGate.test.js` 不动(守卫逻辑未改)。
- 验收命令:`npm run typecheck` + `npm test` + `npm run test:unit` + `npm run i18n:check` 全绿。

## 不做的事(YAGNI)

- 不做多步向导(字段总共 4-5 个,分步徒增点击)。
- 不改 `clusterGate.js` / 守卫逻辑。
- 不动 `/clusters`(AppLayout 内基于 localStorage 的视图)与底部「集群管理」入口。
- 不在守卫里泛化 requireAdmin 检查(仅新页面自查,避免范围蔓延)。
- 不改服务端(POST /api/admin/clusters 与 /api/connect-cluster 已具备闭环所需能力)。
