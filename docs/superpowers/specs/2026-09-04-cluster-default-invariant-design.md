# 集群默认不变式设计(cluster-default invariant)

日期:2026-09-04
状态:已批准(用户裁决:显式默认类名落库 / sweep+可取消 / SC 四项全修)
前置:IngressClass/RuntimeClass 详情页已合 main(f6a94fb)

## 1. 背景与病根

「集群默认」选项曾于 5430605 从 Ingress 创建流程退役:旧语义是落库 `className=''`
(不写 ingressClassName),指望 API server 按 is-default-class 注解默认化;但集群经常
没有任何被标记默认的类(平台自带控制器清单全不标)→ Ingress 落地无类 → 控制器不接 →
永远没有 ADDRESS。修法是落库恒选确定类(pickIngressClassName 单源)。

退役解决了「无默认时静默失败」,但带来三个新问题:

1. 用户失去表达「我要集群默认」的方式;IngressClass 详情页(overview+yaml)也没有
   显眼的设默认入口,设置默认要靠手写 YAML 注解。
2. 详情页无流量可见性:看不到哪些 Ingress 引用此类、各自 host/端口。
3. 同类病在 StorageClass 侧原样存在:
   - NsStorage PVC 创建有「默认」空值选项但**无守卫**——无默认 SC 时选它 = PVC 永远 Pending
   - Storage.vue PVC 创建 fallback 链硬编码 `'standard'`(可能是不存在的假类名)
   - `updateStorageClass` 设默认**不摘旧默认** → 集群可出现两个默认,K8s 默认化行为未定义

## 2. 目标 / 非目标

**目标**

- G1 Ingress 创建入口(NsIngress 弹窗 + DeployApp 向导)恢复「集群默认」选项,且
  **仅当集群存在 is-default 类时可选**;无默认时置灰并提示原因与出路。
- G2 落库语义 = **显式默认类名**(用户裁决),不写空值;方言检测/列表展示/未来可见性全部有值。
- G3 IngressClass 详情页:header 显眼「设为默认/取消默认」;Overview 右栏「关联 Ingress」
  面板展示引用此类的 Ingress(ns/name/hosts/TLS/后端 svc:port)。
- G4 唯一性:设默认时 **sweep 摘除同类旧默认**(SC/IC 都做);允许「取消默认」回到无默认态。
- G5 SC 侧四项同批:NsStorage 守卫 / 去 'standard' 硬编码 / 设默认 sweep / SC 详情页默认钮。

**非目标**

- 不改 pickIngressClassName 的预填回退行为(有默认→默认,无默认→字母序第一)。
- 拓扑加号入口(useWorkloadTopology)不加 UI 选择,维持 pick 语义(isDefault 优先)。
- 不做「多默认」的只读侦测横幅(sweep 后新多默认只会来自集群外操作,超范围)。
- RuntimeClass 无默认概念,不涉及。

## 3. 设计

### 3.1 单源纯逻辑 `src/logic/classDefault.js`(新)

```js
// 返回被标记默认的类;注意两域 mapper 字段名不同:IC=isDefault,SC=default
// (mapStorageClass 输出 default;mapIngressClass 输出 isDefault),故带 key 参数
export function findDefaultClass(classes, key = 'isDefault') {
  return (classes || []).find(c => c && c[key]) || null
}
// 「集群默认」选项可用性(SC 调用方传 'default')
export function canUseClusterDefault(classes, key) { return !!findDefaultClass(classes, key) }
// 显式默认类名(无默认返回 '')
export function resolveClusterDefaultName(classes, key) {
  return findDefaultClass(classes, key)?.name || ''
}
```

无 Vue/store 依赖,scripts/test.mjs 直测。`pickIngressClassName`(src/logic/ingressClass.js)
保持不动——预填回退与「集群默认」是两层语义:预填是兜底,新选项是显式意图。

### 3.2 手术式 patch `src/composables/useClassPatch.js`(新)

仿 useStoragePatch.js(buildStorageClassPatch / remotePatch 范式,merge-patch+json):

```js
export const INGRESSCLASS_DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'
// desired: { isDefault: true|false|null }  null=摘除注解(取消默认)
export function buildIngressClassPatch(original = {}, { isDefault } = {}) {
  // isDefault != null 且与 original.isDefault 不同 →
  //   metadata.annotations = { [KEY]: isDefault ? 'true' : null }
  //   (merge-patch null = 删除键;'false' 不落盘,摘除即退出默认态)
  // 无改动返回 null
}
```

与 buildStorageClassPatch 的差异:SC 用 `'true'/'false'` 字符串且需双 beta 键;IC 单键、
取消默认走 null 删除(注解不留 'false' 尸体,mapper `=== 'true'` 判定本已免疫,但保持对象干净)。

### 3.3 store 层(crud.js 手写,不走 makeCrud 有损 update)

```js
// kind 通用 sweep:摘除 keepName 之外所有默认类的注解(SC 摘除时双 beta 键都置 null)
async function sweepClassDefault({ listFn, items, patchFn, keepName }) { ... }

async function promoteClassDefault(kind, name)  // sweep 其他 → 本类写 true → invalidate → {ok}
async function demoteClassDefault(kind, name)   // 本类摘注解(null)→ invalidate → {ok}
// 导出:promoteIngressClassDefault/demoteIngressClassDefault/setStorageClassDefault(null=取消)
```

- 数据源:`await fetchIngressClasses()` / `await fetchStorageClasses()`(低频操作,直连远端,
  不依赖缓存新鲜度;crumbs 与 makeCrud 的 fromCache 模式并存无冲突)。
- 顺序:**先 sweep 后写本类**。sweep 失败(部分类 PATCH 失败)→ 中止 promote,toast 明示
  「已摘除 x,但写入 y 失败」的中间态;remotePatch 自带 {ok} 契约与错误 toast。
- updateStorageClass 设默认路径接同一 sweep(isDefault=true 时先摘旧默认),修多默认存量病;
  edit modal 的 isDefault 开关自动受益。
- updateStorageClass 现状注解读取只认 `default` 字段(mapper),sweep 名单取
  `items.filter(c => c.default && c.name !== name)`。

### 3.4 Ingress 创建:恢复「集群默认」选项(NsIngress.vue + DeployApp.vue 同配方)

select 置顶插入一项,三态:

| 集群状态 | option | value | 说明 |
|---|---|---|---|
| 有默认类 | `集群默认(跟随 {name})` | 默认类名(显式落库) | 用户裁决 G2 |
| 无默认类 | `集群默认(未设置)` | disabled | 置灰;原生 select 看不到 title |
| 无任何类 | 维持现状 `classNoneAvailable` | '' | 现有行为不动 |

- **置灰必须配 hint**:select 下方一行 hint(仅无默认时显示):
  「集群当前无默认 IngressClass,已选第一个可用类;可在 IngressClass 页设为默认」。
  disabled option 无交互反馈,hint 是唯一解释面(教育入口 → 引导去详情页设默认)。
- 预填不动(pickIngressClassName);用户手选「集群默认」= 选中默认类名,落库
  `addIngress({className: <显式名>})` 零管道改动。
- data-testid:`ingress-cluster-default-option`(断言 disabled 态用)。

### 3.5 IngressClass 详情页加厚(IngressClassDetail.vue)

- **header 按钮组**(删除钮左侧):非默认 →「设为默认」(outline-primary,star 图标);
  已是默认 → DEFAULT 徽标(现有)+「取消默认」。点击分别调
  promote/demoteIngressClassDefault;失败保留原态(remotePatch {ok})。
- **Overview 改 8/4 双栏**(仿 StorageClassDetail):
  - 左 8:现有属性卡(controller/isDefault/parameters/labels/annotations)
  - 右 4:「关联 Ingress」卡——`useResourceList(['cluster', cid, 'ingresses'],
    store.fetchIngresses)` 过滤 `className === ic.name`;头部计数「N 条引用」;
    每条:ns/name(点击跳 NsIngressDetail)+ hosts(w-full truncate 配方,防溢出守卫)+
    TLS 🔒 徽标(443)+ 后端摘要 `svc:port`(首条 rule 的 backend 或 defaultBackend);
    空态「无 Ingress 引用此类」。
  - 端口语义:HTTP=80 隐含,TLS 行显式 443;后端 svc:port 是真正的业务端口信息。

### 3.6 StorageClass 侧(G5 四项)

1. **NsStorage.vue PVC「默认」守卫**:默认存在 → option「集群默认({name})」(value ''
   语义保留:PVC storageClassName 空 = apiserver 默认化,是 K8s 正确语义,与 Ingress
   显式名不同是因为 PVC 无方言检测/可见性问题);无默认 → option disabled + hint
   「集群无默认 StorageClass,请显式选择」。落库管道零改动。
2. **Storage.vue PVC 创建**:fallback 去 `'standard'` → `f.storageClass || 默认名 || ''`;
   无显式选择且无默认 → 创建按钮 disabled + hint(与 1 同文案源,i18n 复用)。
3. **SC 设默认 sweep**:见 3.3。
4. **StorageClassDetail.vue header 默认钮**:同 3.5 按钮形态;非默认→「设为默认」
   (promote = sweep 其他 + 本类写 true);已是默认 → 「取消默认」(摘注解)。
   edit modal 内 isDefault 开关保留,saveEdit 走 updateStorageClass(已接 sweep)。

## 4. 数据流与错误处理

- 设默认(两域同构):fetch 全量 → filter 默认名单(排除目标)→ 逐个 remotePatch 摘注解 →
  remotePatch 写目标 → invalidateResource → 列表/详情 15-30s 轮询自动回真。
- 失败矩阵:sweep 中途失败 → 中止 + toast 已完成/失败明细;写目标失败 → toast({ok}=false),
  详情页不乐观更新;取消默认失败 → 同。无 RBAC 权限 → api.k8s 403 经 remotePatch
  现有 catch → 用户可见错误。
- 并发:两个管理员同时设不同默认 → 后写者 sweep 前者,最终一致(K8s 语义内)。

## 5. 测试计划(TDD)

- 纯逻辑(scripts/test.mjs):classDefault 三函数(有/无默认/空列表)。
- patch builder(vitest):buildIngressClassPatch 写 true/摘 null/无改动 null;SC sweep 键单。
- store:promoteIngressClassDefault 顺序(sweep→写)、失败中止、invalidate;
  demote 幂等;updateStorageClass 设默认触发 sweep。
- 视图:NsIngress/DeployApp 集群默认选项三态 + hint;IngressClassDetail 默认钮两态 +
  关联 Ingress 面板(过滤/空态/跳转);StorageClassDetail 默认钮;NsStorage 守卫;
  Storage.vue PVC 禁用。既有 class-pick/deploy 契约测试迁移保绿。
- 门禁四件套 + build 全绿;worktree 分支 --no-ff 合 main。

## 6. 手测清单(实现后)

1. 有默认 IC:NsIngress/DeployApp 选「集群默认(跟随 x)」创建 → YAML 写 x。
2. 取消默认 → 两入口选项置灰 + hint;重新设默认 → 恢复。
3. 设默认时旧默认注解被摘(kubectl get ingressclasses -L 或详情页验证唯一默认)。
4. IngressClass 详情右栏:引用计数/hosts/443/svc:port 正确,点击跳 NsIngressDetail。
5. 无默认 SC:NsStorage「默认」置灰;Storage.vue PVC 创建禁用;设默认后两者恢复。
6. zh/en 文案与置灰提示。

## 7. 边界

- 集群外造出双默认:详情页各自显示默认徽标(如实),不在本次侦测范围(非目标)。
- IC/SC 列表为空:入口 select 维持 classNoneAvailable 现状,详情页不涉及。
- sweep 目标类已被删:fetch 快照过滤即可,PATCH 404 静默跳过(摘除语义幂等)。
