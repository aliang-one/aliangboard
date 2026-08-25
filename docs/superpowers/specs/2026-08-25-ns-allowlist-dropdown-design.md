# ns allowlist 下拉选择设计

日期:2026-08-25
状态:已批准(用户确认:下拉为主+手输兜底;方案 A 组件自治+composable)

## 背景与动机

API key 的 namespace 允许集编辑器(`NsAllowlistEditor`)目前是纯文本输入:手敲 ns 名、回车加 chip。
痛点:易打错字(dns-label 校验只是事后拦截)、不知道集群里有哪些 ns 可选。

前置事实(约束设计):
- 编辑器用在 `ApiKeyManagement.vue` 两处(mint 弹窗 / 编辑弹窗),两处都持有 `clusterId`
  (mint:用户选;编辑:`row.clusterId`)。
- 前端普通视图的 `api.k8s('/api/v1/namespaces')` 走**浏览器当前会话集群**,与 key 绑定的
  平台集群(clusterId)不一定是同一个——多集群场景下直接复用会造成候选错位(给 A 集群的 key
  选出 B 集群的 ns)。因此必须新增按集群 id、用集群表行内凭据拉取的 admin 端点。

## 设计

### 1. 服务端(routes/admin.mjs)

新端点 `GET /api/admin/clusters/:id/namespaces`:

- `requireAdmin` 门禁
- `deps.getCluster(id)` → 不存在 404
- 用该集群行凭据(`buildCallContext` + `deps.requestKubernetes`,两者已在 deps,零新增接线)
  拉 `/api/v1/namespaces?limit=500`
- 成功:`{ namespaces: [名字数组, 字典序] }`(只回名字,不回元数据)
- 拉取失败:502 `{ message }`(网关到集群的凭据/网络问题原样透出)
- ns 数量小,limit=500 一次取全,不做分页(YAGNI)

### 2. 前端 API(src/api/client.js)

`adminApi.clusters.namespaces(id)` → `platformHttp.request(...)`。

### 3. composable(src/composables/useClusterNamespaces.js)

`useClusterNamespaces()` → `{ list, loading, error, load }`:
- `load(clusterId)`:空 id 直接清空态;成功填 list;失败清空 list 并填 error——切集群后
  绝不残留上一个集群的候选
- fetch 函数可注入(默认绑 adminApi),供组件测试
- 不做缓存/TTL:弹窗即开即拉,ns 变更频率低但正确性优先(YAGNI)

### 4. NsAllowlistEditor 改造(src/components/common/NsAllowlistEditor.vue)

- 新 prop `clusterId: String`;内部 `useClusterNamespaces`,watch clusterId 重拉
  (mint 弹窗切换集群时候选跟随)
- chips 行、删除交互、全部校验(dns-label ≤63 / 去重 / ≠绑定 ns)不变
- 输入区改双态,**下拉为主 + 手输兜底**:
  - 默认态:原生 `<select>`(仓库弹窗惯例),placeholder「选择 namespace」;
    候选 = 集群 ns − 已选 chips − 绑定 ns;选中即加 chip,select 复位(可连续添加)
  - 切换链接「手动输入」↔「下拉选择」双向可切;失败后用户仍可手动切回下拉,
    此时显示失败提示 + 空候选(不自动重拉,重开弹窗才重拉)
  - **自动落手输态**(并显示原因提示):clusterId 为空 / 拉取失败 / 候选为空
  - 下拉 loading 态:disable + 「加载中…」
- i18n 双语新增键(nsAllowlist 命名空间):selectPlaceholder / switchToManual /
  switchToSelect / loading / loadFailed / emptyList

### 5. 调用点(src/views/admin/ApiKeyManagement.vue)

- mint 弹窗:`<NsAllowlistEditor :bound-ns="..." :cluster-id="mintForm.clusterId" ...>`
- 编辑弹窗:`:cluster-id="editingKey?.clusterId"`
- 其余不动(上一轮的 provision-first 保存语义、提示文案不变)

### 6. 测试

- 服务端(admin.mjs 路由测试,仿 apikey-sa-repair/managed-mint harness):
  admin 门禁 / 404 集群不存在 / 502 拉取失败 / 200 排序名字列表 / requestKubernetes
  收到的 ctx 用的是该集群行凭据
- 组件 vitest(happy-dom):
  候选渲染(排除已选与绑定 ns)/ 选中即加 chip 且 select 复位 / 双态切换 /
  clusterId 变化重拉 / 拉取失败自动落手输并提示 / 手输校验回归(dns-label、去重)
- 门禁:`npm test`(server + unit)、`npm run typecheck`、`npm run i18n:check` 全绿

## 错误处理汇总

| 场景 | 行为 |
|------|------|
| clusterId 为空(mint 先开弹窗未选集群) | 下拉空,自动手输态 |
| 集群已被删(404) | 同上,提示 |
| 网关→集群拉取失败(502) | 同上,提示 error.message |
| 集群无 ns / 候选全被排除 | 下拉显示空态提示,可切手输 |
| 手输了非法名 | 现有校验原样(dns-label/去重/≠绑定) |

## 非目标(明确不做)

- ns 搜索/过滤输入框(候选规模小,原生 select 够用)
- 服务端缓存/TTL
- 下拉里内联「创建 ns」
- 迁移 k8sHttp 会话集群方案(已否决,理由见背景)
