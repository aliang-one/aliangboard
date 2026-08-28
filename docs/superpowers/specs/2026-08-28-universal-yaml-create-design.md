# 全资源「从 YAML 创建」通用化设计

- 日期:2026-08-28
- 状态:设计已与用户逐节对齐(裁决记录见 §8),待实现计划
- 范围:前端 12 视图 / 13 入口点(9 视图新增 + 3 视图重构,NamespaceOverview 含 2 处入口)+ 服务端 1 个模块抽取;不碰任何表单本身

## 1. 背景与现状

「从 YAML 创建」的能力**已经存在且是通用的**,缺的只是入口:

- `src/components/common/CreateFromYamlDialog.vue`:粘贴/编辑 YAML → `useResourceApply().applyYaml` → `store.applyResourceYaml` → `api.applyYaml`(`src/api/client.js:136`)→ `POST /api/apply`。前端不校验 kind,支持多文档(`js-yaml` `loadAll`,dialog 内 `CreateFromYamlDialog.vue:60` 用它计数)。
- `server/index.mjs:1559-1573` `/api/apply` handler:逐资源 server-side apply(`PATCH …?fieldManager=aliangboard&force=true`),任意 kind、部分成功语义(全失败 422 / 部分或全成功 200 + `{resources, applied, failed, total}`)。
- 服务端 `applyYaml`(`server/index.mjs:482`)经 `discoverResource`(`index.mjs:466`)从集群 discovery 取**权威** `resource.namespaced`——CRD 也正确,当前缺 ns 落 `'default'`(`index.mjs:497`;孪生变体 `applyYamlPartial` 同款在 `:523`)。
- 工作台变体 `applyYamlPartial`(`index.mjs:513`):同样逐资源 try/catch,只回 label 不回 body。

入口现状矩阵(核查后事实,行号为当前 main):

| 视图 | 创建入口锚点 | YAML 入口 |
|------|------|------|
| Workloads.vue:139-148 / NsWorkloads.vue:134-143 / NamespaceOverview.vue:256-265, 377-386 | SplitButton(工作负载向导为主按钮) | ✅(已接) |
| NsConfigMaps.vue:154 / NsSecrets.vue:182 | CreateConfigResourceModal,YAML tab edit 模式 kind 锁定单文档 | ✅(自带,不动) |
| NsNetworkPolicies.vue:176 | NetworkPolicyEditor 内部走 applyYaml | ✅(不动) |
| NsServices.vue:221 | 表单 Modal | ❌ |
| NsIngress.vue:184 | 表单 Modal | ❌ |
| NsStorage.vue:149(PVC tab) | 内联 Modal(注:`CreatePvcDialog.vue` 唯一消费方是 `VolumeMountCard.vue:104`,非本页) | ❌ |
| NsHPA.vue:116 / NsPDBs.vue:130 / NsLimitRanges.vue:114 / NsResourceQuotas.vue:130 | 表单 Modal | ❌ |
| NsRBAC.vue:159-166 | 页头双创建按钮(见 §3.6) | ❌ |
| Namespaces.vue:145-150 | 表单 Modal(名字+标签,`:204`) | ❌ |

其他事实:

- `SplitButton.vue` API:props `{ label(必填), icon, mainAction(必填), items: [{label, icon?, action, danger?, disabled?}], disabled }`,无 emit,`run(item)`(`:16-19`)内部直调 `item.action()`。
- 既有 i18n 键(en/zh 一一对应,`src/locales/en.json:73-82` / `zh.json:73-82`):`component.createFromYaml.{title,hint,create,parseError}`、`component.splitButton.createFromYaml`。
- 既有 dialog 测试仅 1 例(渲染标题+模板填充);SplitButton 测试仅主按钮+展开菜单。
- `index.mjs` **零 export**(纯启动文件);server 测试先例:纯函数级(`kind-paths.test.mjs`)、deps 注入(`api-key-tools.test.mjs`,`:362` 已有 `apply_yaml` 走 `applyYamlFn` 注入点的用例)、handler 直测(`workbench-conv-routes.test.mjs`,被测对象本身是 factory)、真 HTTP roundtrip(`wb-approval-roundtrip.test.mjs` spawn index.mjs)。
- `server/` 下无 apply-yaml 类模块(103 个 .mjs 清单核对过)。

## 2. 目标 / 非目标

**目标**
1. 12 个视图 / 13 入口点(9 新增 + 3 重构)拥有「从 YAML 创建」入口,形态与 workload 现状一致(SplitButton 次级项)。
2. 弹窗按视图注入对应 kind 的最小模板;粘贴任意 kind / 多文档照常工作。
3. 命名空间视图粘贴的 YAML 缺 `metadata.namespace` 时补当前 ns(用户已裁决);显式写的 ns 不覆盖;集群级 kind 忽略。
4. NsRBAC 的 YAML 模板随 activeTab 变化,并顺修 RoleBinding 假按钮断链(§3.6)。
5. 服务端 ns 补齐单点化(抽模块),defaultNs 缺省时行为与现状完全一致。

**非目标(YAGNI,见 §7)**
- 不动 ConfigMap/Secret 富 Modal、NetworkPolicyEditor、任何表单字段本身。
- 不做全局单入口/命令面板。
- 不在本期接 4 个视图的 `{ok}` 契约缺口(§7 backlog)。

## 3. 设计

### 3.1 新组件 `CreateWithYamlButton.vue`(src/components/common/)

SplitButton 的黏合层,自持一个 `CreateFromYamlDialog` 实例:

```
props:
  label: String(主按钮文案,必填)
  icon: String(默认 'add')
  mainAction: Function(可选——主按钮回调;mainOpensYaml 为 true 时可缺省)
  mainOpensYaml: Boolean(默认 false——为 true 时主按钮内部直接打开 YAML 弹窗,
                供无表单创建的场景用,如 NsRBAC 的 rolebindings tab)
  yamlTemplate: String(kind 键,查 yamlTemplates.js;默认 'Deployment')
  namespace: String(传给 dialog:模板插值 + defaultNs 语义)
  extraItems: Array(追加到 SplitButton items 尾部,如 workload 的「复制工作负载」)
  disabled: Boolean(默认 false,透传 SplitButton)
emits:
  applied(透传 dialog 的 applied,供视图 refetch/invalidate)
内部:
  SplitButton(:main-action="mainOpensYaml ? openYaml : mainAction",
              items = [ {label: t('component.splitButton.createFromYaml'), icon: 'description', action: openYaml}, ...extraItems ])
  + <CreateFromYamlDialog v-model="showYaml" :kind="yamlTemplate" :namespace="namespace" @applied="emit('applied')" />
```

`mainOpensYaml` 的存在动机:NsRBAC 的 rolebindings tab 无表单创建(§3.6),主按钮需直开 YAML 弹窗,而 dialog 开关是组件内部 ref,父视图无法触达——故由 prop 表达,视图侧零胶水。

视图侧改动收敛为:创建按钮标签替换(可选 `@applied`,见 §3.5 口径)。三个 workload 视图(Workloads/NsWorkloads/NamespaceOverview,NamespaceOverview 两处 SplitButton 共用一个 dialog)重构到本组件:**4 个 dialog 实例全部显式传 `yamlTemplate="Deployment"`**,kind prop 的默认值仅作防御;重构须保持现状不扩 scope——Workloads.vue 现状不传 namespace、不接 @applied,NsWorkloads/NamespaceOverview 现状传 namespace + `@applied="workloadsQuery.refetch()"`,均原样保留(§5 有回归断言)。

### 3.2 模板单源 `src/utils/yamlTemplates.js`

`export const yamlTemplates = { [Kind]: (ns) => '…最小可 apply YAML…' }`,14 个 kind:

Deployment(自 `CreateFromYamlDialog.vue:18-43` 迁入)、Service、Ingress、PersistentVolumeClaim、HorizontalPodAutoscaler、PodDisruptionBudget、LimitRange、ResourceQuota、Role、ClusterRole、RoleBinding、ClusterRoleBinding、ServiceAccount、Namespace(集群级,模板不含 namespace 字段)。

约定:每个模板为最小合法清单(apiVersion/kind/metadata.name/namespace 插值/spec 骨架),纯静态字符串函数,不依赖 store;**集群级 kind 共 3 个(ClusterRole/ClusterRoleBinding/Namespace),模块同时导出 `CLUSTER_SCOPED_KINDS`(Set)供 nsHint 判断(§3.3),这 3 个模板一律不含 `metadata.namespace` 字段**。`CreateFromYamlDialog` 加 `kind` prop(默认 `'Deployment'`),watch 打开时按 kind 查表填充;Deployment 模板自 `CreateFromYamlDialog.vue:18-43` 迁入时须保留 `name: my-app`(既有测试 `CreateFromYamlDialog.test.js:24` 断言含 'my-app')。测试断言「每个模板可被 js-yaml parse 且 kind 正确、3 个集群级模板无 namespace 字段」。

### 3.3 namespace 缺省补齐(前端侧)

调用链四层,`defaultNs` 须逐层透传(dialog → useResourceApply → store → api),**缺任何一跳功能即静默失效**:

- `CreateFromYamlDialog.create()` 改为 `applyYaml(yaml.value, { defaultNs: props.namespace })`(`CreateFromYamlDialog.vue:68`)。
- `useResourceApply.applyYaml(yamlStr, opts = {})` 加可选第二参并透传 `opts.defaultNs`(`useResourceApply.js:9`;唯一改动消费方即本 dialog,其余 20+ 视图不传、零破坏)。
- `store.applyResourceYaml(yamlStr, opts = {})` 加可选第二参透传 `opts.defaultNs`(`cluster.js:1863`)。**不传 = 现行为**;既有调用方(23 个文件经 `useResourceApply` 间接调用 + 2 处直调:`CreateConfigResourceModal.vue:215`、`DeployApp.vue:801`)零改动。
- `api.applyYaml(yaml, defaultNs)` 加第二参 → body `{ yaml, defaultNs }`(`client.js:136`)。

dialog 内提示:editor 下方加一行 `component.createFromYaml.nsHint`——「未写 metadata.namespace 的文档将创建到 `<当前ns>`」(当前 ns 动态插值)。**显示条件:`props.namespace` 非空 且 当前 kind ∉ `CLUSTER_SCOPED_KINDS`**(集群级 kind 显示该提示是误导,§3.2)。既有 `component.createFromYaml.hint` 文案(「namespace 以 YAML 内 metadata.namespace 为准」)在 defaultNs 语义下变成错的、且与 nsHint 同窗矛盾——**同步改写**(en+zh):「显式写的 metadata.namespace 优先;未写则创建到当前命名空间」。i18n 改动合计:新增 1 组(`nsHint`)+ 改写 1 组(`hint`),en/zh 对齐,过 `npm run i18n:check`。

用户显式写的 ns 永不覆盖;补齐发生在服务端(§3.4),前端不改写用户输入。

### 3.4 服务端:`server/apply-yaml.mjs` 抽取 + defaultNs

照仓库既有「抽模块 + deps 注入」模式(`cluster-probe.mjs`、`api-key-tools.mjs`):

```js
// server/apply-yaml.mjs(新)
export function createApplyYaml({ requestKubernetes }) {
  // discoveryCache 与 discoverResource 迁入(私有):
  //   const discoveryCache = new Map() 声明自 index.mjs:59(index.mjs 同步删除原声明)
  //   discoverResource(session, object) 自 index.mjs:466-480 迁入,仅被下述两函数消费
  // 私有 helper:resolveApplyNamespace(object, resource, defaultNs)
  //   = resource.namespaced ? (object.metadata.namespace || defaultNs || 'default') : undefined
  return {
    applyYaml(session, yaml, defaultNs),        // 自 index.mjs:482-510 迁入
    applyYamlPartial(session, yaml, defaultNs), // 自 index.mjs:513-530 迁入
  }
}
```

- 核心语义(namespaced 路径段):`object.metadata.namespace || defaultNs || 'default'`——**两函数必须都走同一个 `resolveApplyNamespace` helper**,禁止各写一份 `||` 链(防漂移,§5 用例 5 依赖此结构)。
- `applied`/`failed` label 的 `namespace` 字段报**补齐后的值**(当前报原始值,缺 ns 时为 undefined)。动机:与 `resources[].metadata.namespace` 对齐,供 MCP/API-key `apply_yaml` 消费方读到真实落点。**注意这是一次跨边界可见变更**:`apply_yaml` 工具原样透传结果(`api-key-tools.mjs:394`),外部 AI 客户端看到的 `label.namespace` 会从 undefined 变为补齐值;既有用例 `api-key-tools.test.mjs:361` 只断言 `applied.length` 抓不到该漂移,§5 显式补断言。
- `index.mjs` 改为 `const { applyYaml, applyYamlPartial } = createApplyYaml({ requestKubernetes })`,消费点(`:453` apiKeyTools 注入、`:1159`、`:1440` workbench routes、`:1564` /api/apply、`:2128` reconcile)签名不变。
- 兼容性:`defaultNs` undefined 时 ns 补齐行为与现状逐字节一致;MCP/API-key `apply_yaml` 工具与工作台不传 defaultNs,ns 补齐不受影响(唯一可见差异即上述 label.namespace)。
- `/api/apply` handler 保持内联 thin(读 `input.yaml` + 新增读 `input.defaultNs`),`index.mjs` 零导出现状不破。

### 3.5 视图接线清单(12 视图 / 13 入口点:9 新增 + 3 重构)

| 视图 | 改动 | yamlTemplate | @applied 刷新 |
|------|------|------|------|
| NsServices.vue:221 | 按钮换组件 | Service | 既有 invalidate(经 store)已覆盖,无需额外接线 |
| NsIngress.vue:184 | 同上 | Ingress | 同上 |
| NsStorage.vue:149 | PVC tab 按钮换组件(仅 PVC tab;StorageClass tab 无创建,不加) | PersistentVolumeClaim | 同上 |
| NsHPA.vue:116 | 同上 | HorizontalPodAutoscaler | 同上 |
| NsPDBs.vue:130 | 同上 | PodDisruptionBudget | 同上 |
| NsLimitRanges.vue:114 | 同上 | LimitRange | 同上 |
| NsResourceQuotas.vue:130 | 同上 | ResourceQuota | 同上 |
| NsRBAC.vue:159-166 | 页头双按钮 → 单组件,随 activeTab(§3.6) | 随 tab | 同上 |
| Namespaces.vue:145-150 | 按钮换组件(main=openCreate) | Namespace | 无需接线(invalidate 覆盖,见下) |
| Workloads / NsWorkloads / NamespaceOverview | 重构到组件(§3.1),行为不变 | Deployment | 维持现状 |

「无需接线」的依据:8 个新增视图(7 表单 + Namespaces,后者查询 key `['cluster', cid, 'namespaces']`)列表均已迁 `useResourceList`(Vue Query,key 形如 `['cluster', cid, 'services']`,`NsServices.vue:36-38` 等),而 `applyResourceYaml` 成功后 invalidate 的 predicate 即 `q.queryKey[0] === 'cluster'`(`cluster.js:1868`)——apply 落地自动触发各视图重取。故「@applied 刷新」列对新增视图一律是空操作,不要去找刷新回调;三个重构视图按 §3.1 维持现状(NsWorkloads/NamespaceOverview 保留既有 `@applied="workloadsQuery.refetch()"`,Workloads 保持无)。

nsHint 显示口径:命名空间视图的 dialog(namespace prop 非空)且当前 kind 为 namespaced 时显示;Namespaces 视图集群级(Kind=Namespace ∈ `CLUSTER_SCOPED_KINDS`),模板无 ns 字段、服务端忽略 defaultNs,语义自洽。NsRBAC 的 clusterroles/clusterrolebindings tab 同理不显示 nsHint。

### 3.6 NsRBAC:随 tab 动态 + RoleBinding 断链顺修

核查发现的**真缺陷**:RoleBinding tab 的「Create RoleBinding」按钮(`NsRBAC.vue:216-218`)打开的是 **Role 的 modal**(`showCreateRoleModal`),文案硬编码英文,全仓库无任何 `addRoleBinding` 调用(`cluster.js:375` 解构后零消费)——RoleBinding 创建链路不存在。

处理:

- 页头(`:159-166`)两个常驻创建按钮 → 单个 `CreateWithYamlButton`,响应式绑定 activeTab(`:50` ref);主按钮文案用既有 `common.create`(en/zh 已有,同视图 Role modal 在用),零新键:
  - main-action(mainOpensYaml=false,传回调):`roles`→开 Role modal、`serviceaccounts`→开 SA modal、`clusterrolebindings`→开 CRB modal、`clusterroles`→开 Role modal(**不预置 scope**,与被移除按钮行为完全一致,用户在 modal 内自选;scope 下拉 `:326-332`,Cluster 提交分支在 `createRole` `:72` 现状);
  - `rolebindings`→**`mainOpensYaml` 直开 YAML 弹窗**(该 tab 无表单创建,§3.1)。
  - yamlTemplate 随 tab:Role / ServiceAccount / ClusterRoleBinding / **RoleBinding** / ClusterRole。
- RoleBinding/ClusterRoleBinding 以 YAML 为主创建形态是 RBAC 资源的合理选择(subjects 结构表单化成本高)。
- 顺修:tab 级创建按钮全部移除、创建统一收敛页头单按钮——含 `:216-218` RoleBinding 假按钮(文案硬编码英文,随移除消失)、`clusterroles` 段 `:253-255`、`clusterrolebindings` 段 `:283-285`(后两者与页头按钮在对应 tab 下功能重复)。注意 `i18n:check` 只查残存中文、**抓不到硬编码英文**,移除是否干净由 §5 显式断言兜底。
- 明确不改:`createRole`(`:68-79`)非 async、不接 `{ok}` 的问题留在 §7 backlog。

### 3.7 Namespaces 视图

表单 Modal(名字+标签,`:204`,含 nameRequired/nameExists 校验)原样保留;`:145-150` 创建按钮换 `CreateWithYamlButton`(main=openCreate,items=[从YAML创建])。**不接 `@applied`**——namespacesQuery key `['cluster', cid, 'namespaces']` 已落在 invalidate predicate 覆盖内(§3.5 依据);接既有 `sync()` 反而有副作用(清空整个 cluster 查询缓存 + 每次弹「已同步」假 toast)。

## 4. 错误处理

零新错误路径,全部复用既有链路:

- YAML parse 失败 → dialog 内联红字(赋值逻辑 `CreateFromYamlDialog.vue:57-65`,渲染 `:85`,现状)。
- apply 失败 → `useResourceApply` toast(`useResourceApply.js:9-21` 现状);全失败 422 → `store.applyResourceYaml` 返回 `{ok:false}`(现状)。
- 部分成功 → `partial` warning toast(QA ISSUE-002 语义,现状)。
- defaultNs 只影响落点,不影响成败判定。边界:空串/缺省 defaultNs → 落 `'default'`(与 §3.4 `||` 链一致,**无特判**);超长/非法字符 → K8s 422 上报,前端不特判。

## 5. 测试计划(TDD 两轨)

**服务端**(`node:test` + 自研运行器,mock `requestKubernetes` 注入,照 `api-key-tools.test.mjs:21-22` 的 mock requestFn 模式)新文件 `server/apply-yaml.test.mjs`:

1. namespaced 文档缺 ns → 路径含 `/namespaces/<defaultNs>/`,label.namespace=补齐值;
2. 显式 ns → 不覆盖;
3. 集群级 kind(discovery 返回 `namespaced:false`)→ 忽略 defaultNs;
4. 不传 defaultNs → `'default'`(兼容回归);
5. `defaultNs=''`(空串)→ 同样落 `'default'`(§4 边界);
6. `applyYamlPartial` 与 `applyYaml` 同语义抽查——测试断言两函数产出路径一致(依赖 §3.4 的 `resolveApplyNamespace` 单点,防各写一份 `||` 链);
7. 多文档混合(ns 有/无、集群级/命名空间级)逐资源结果正确;
8. discovery 缓存:同 apiVersion 二次 apply 不再发 discovery 请求。

`/api/apply` handler 不做直测(handler 内联于零导出的 index.mjs,直测需先抽路由,超范围)——thin 层由 §3.4 兼容性论证 + 既有 roundtrip 基建(`wb-approval-roundtrip.test.mjs`)兜底。`server/api-key-tools.test.mjs:362` 既有 `apply_yaml` 用例回归必须全绿,并**新增断言**:label.namespace 为补齐后值(§3.4 跨边界可见变更的防漂移锚)。

**前端**(vitest + @vue/test-utils):

- `yamlTemplates.test.js`:14 kind 模板逐个 `yamlLoad` 可解析、kind 字段正确、ns 插值正确、**3 个集群级模板(ClusterRole/ClusterRoleBinding/Namespace)均无 metadata.namespace 字段**、`CLUSTER_SCOPED_KINDS` 恰含这 3 个;
- `CreateWithYamlButton.test.js`:主按钮调 mainAction、次级项打开 dialog、kind/namespace 透传、applied 透传、extraItems 渲染、**items 顺序 = YAML 项在前 extraItems 在后**(三个 workload 视图现状顺序,行为不变承诺的一部分)、disabled 透传、**`mainOpensYaml=true` 时主按钮直开 dialog 且 kind 正确、忽略 mainAction**;
- `CreateFromYamlDialog.test.js` 扩充:kind prop 换模板(**Deployment 模板保留 `name: my-app`**,既有断言不破)、nsHint 显示条件三态(namespace 空 / namespaced kind / 集群级 kind)、**defaultNs 透传——mock `useResourceApply` 断言第二实参 `{ defaultNs }`**(§3.3 四层链最易断的一跳)、namespace 为空时不传 defaultNs、hint+nsHint 两行文案同窗不矛盾、applied emit、parse 失败分支;
- `NsRBAC` 联动:activeTab 切换 → yamlTemplate 变化、rolebindings tab 主按钮直开 YAML、**rolebindings/clusterroles/clusterrolebindings 三个 tab 下不再渲染 tab 级创建按钮**(硬编码英文移除的唯一防线,i18n 门禁抓不到);
- **3 个 workload 视图回归**(唯一动存量用户的改动):Workloads 重构后 dialog 不带 namespace、不接 applied;NsWorkloads/NamespaceOverview 保留 namespace + `@applied` refetch。

门禁:`npm test`、`npm run test:unit`、`npm run typecheck`、`npm run i18n:check` 全绿。

## 6. 数据流小结

```
[视图] CreateWithYamlButton
  ├─ mainAction → 既有表单 modal(不变)
  └─ 次级项 → CreateFromYamlDialog(kind → yamlTemplates[Kind](ns) 填充)
        ↓ 用户粘贴/编辑
      useResourceApply().applyYaml(yaml, { defaultNs })
        ↓ store.applyResourceYaml(yaml, { defaultNs })
      api.applyYaml(yaml, defaultNs) → POST /api/apply { yaml, defaultNs }
        ↓ server createApplyYaml().applyYaml
      discoverResource(discovery 缓存) → namespaced? → ns = metadata.namespace || defaultNs || 'default'
        ↓ server-side apply(逐资源 try/catch)
      200 {applied(补齐后 ns), failed} / 422 → invalidate cluster queries(applyResourceYaml 现状)→ 视图经 Vue Query 自动刷新
```

## 7. 明确不做 / backlog

- ConfigMap/Secret 通用 YAML 入口(富 Modal 已有 kind 锁定 YAML tab,避免一视图两套 YAML 路径)。
- NetworkPolicy(编辑器已走 applyYaml)。
- 全局单入口/命令面板。
- `{ok}` 契约缺口(既知遗留):NsHPA:59 / NsPDBs:70 / NsLimitRanges:65 / NsResourceQuotas:53 四视图 `await store.addXxx()` 不读返回值;NsRBAC `createRole`(`:68-79`)非 async 不接 `{ok}`。
- `/api/apply` 路由抽取与 handler 直测。
- Workloads.vue 的 dialog 补 namespace/@applied(重构时保持现状,不扩 scope)。

## 8. 用户裁决记录(2026-08-28)

1. 入口形态:**每视图次级入口**(SplitButton 模式),复用同一 dialog,按视图注入 kind 模板。
2. Namespaces 视图:**完整创建(表单+YAML)**——后核实表单已存在,只补 YAML 次级入口。
3. ConfigMap/Secret:**保持现状**(不加通用入口)。
4. 缺 ns 语义:**缺省补当前 ns**(服务端补,显式 ns 不覆盖,弹窗提示)。
