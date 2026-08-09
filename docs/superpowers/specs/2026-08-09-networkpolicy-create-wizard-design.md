# NetworkPolicy 创建向导 — 设计 spec

**日期**:2026-08-09
**分支**:`feat/networkpolicy-create-wizard`
**状态**:设计已确认,待写实现计划

## 背景

`src/views/NsNetworkPolicies.vue` 的「创建网络策略」流程存在三类问题:

1. **安全陷阱(deny-all 脚枪)**:创建表单默认 `podSelector: {}`(选中 namespace 全部 Pod)+ `policyTypes: [Ingress, Egress]`,而 NetworkPolicy 是默认拒绝语义 —— 默认点一下 Create 就会让整个 namespace 所有 Pod 进出全断。表单无规则编辑能力、无风险提示、无 YAML 预览。
2. **非原子 / 错误被吞**:`handleCreate` 对 `async` 的 `store.addNetworkPolicy` 不 `await`,立即 `invalidateQueries` 并关闭弹窗。远端模式下 invalidate 可能比创建先跑(新策略不显示,需等 30s 轮询),创建失败(RBAC/冲突/非法名)无任何反馈,弹窗照关。同资源的 `NsNetworkPolicyDetail.vue` 的 `handleDelete` 是 `await` 的,建/删风格不一致。
3. **死代码 + 缺校验**:`ingressRules: f.policyTypes.includes('Ingress') ? [] : []`(两分支都是 `[]`,无意义三元);名字无 DNS-1123 校验;`generateYAML('networkpolicy', ...)` 对 `${name}` / `${k}: ${v}` 裸插值,值含特殊字符会破坏 YAML。

用户诉求:不仅要修掉不安全,还要**好用**。

## 目标 / 非目标

**目标**
- 用一个全功能结构化向导替代现有 3 字段创建弹窗,覆盖 K8s NetworkPolicy 全部常用与进阶特性。
- 根治 deny-all 脚枪:实时可见的后果 + 危险态二次确认。
- 根治非原子创建:单一 await 提交通道 + 错误可见。
- 表单与 YAML 双向可编辑,且能优雅处理 YAML 写坏的情况。

**非目标(v1)**
- 不改详情页(`NsNetworkPolicyDetail.vue`)的编辑入口。编辑器组件按 create/edit 可复用来设计,但 v1 只接入 create。edit 复用作为后续迭代。
- 不改 list/delete 路径(已正常)。

## 已确认决策

| # | 决策点 | 选择 |
|---|--------|------|
| 1 | 结构化创建路径范围 | **C — 完整规则向导**(对标 Kuboard) |
| 2 | 向导布局形态 | **单页 + 实时 YAML 预览**(所有字段 + 规则编辑器 + YAML 同屏) |
| 3 | YAML 栏 | **可编辑,双向同步**,带优雅降级 |
| 4 | 新建策略默认基线 | **放行起步**(每方向一条未限定源的规则;安全优先) |
| 5 | 规则编辑器覆盖范围 | **完整(含进阶)**:matchExpressions / ipBlock.except / endPort |
| 6 | 入口形态 | **单按钮**(向导已内嵌可编辑 YAML,等价于「从 YAML 创建」,不再加 SplitButton) |

**降级机制(决策 3 的子项,已确认)**:默认表单 ↔ YAML 双向实时同步;一旦手写 YAML 解析失败或非合法 NetworkPolicy,表单切只读 + 黄色横幅「已进入 YAML 模式」,提供「重置回表单」按钮。提交永远以 YAML 为准。

## 架构

### 核心洞察:form model = 原生 K8s spec

表单模型**直接就是 K8s NetworkPolicy 对象**(`apiVersion/kind/metadata/spec`),不引入中间 app-model。

- model→YAML:`yaml.dump(model)`(js-yaml 已是依赖,`CreateFromYamlDialog` 在用)
- YAML→model:`yaml.load()` → 校验合法 NetworkPolicy → 回填表单
- 语义往返干净(`load(dump(model))` 与 `model` 深相等,非字节级);降级仅在 YAML 解析失败 / 非 NetworkPolicy 时触发
- 后果标签 + deny-all 检测 = 对 `model.spec` 的纯函数

因为覆盖到「完整」层,`matchExpressions` / `except` / `endPort` 本就是 spec 的一部分,表单天然能绑、能编辑、能往返 —— 无需为进阶特性再造转换层。这也让双向同步比预期稳:几乎不存在「表单表达不了的构造」,降级主要兜底「YAML 写坏了」。

### 提交通道(根治非原子)

Create 永远走 `await applyResourceYaml(yaml.dump(model))` → toast + `invalidateQueries`。单一通道、await、错误可见。原 `handleCreate` 的 fire-and-forget 与死三元一并删除。

**mock 模式补丁**:`applyResourceYaml`(`src/stores/cluster.js:2620` `case 'NetworkPolicy'`)当前调 `updateNetworkPolicy`(找不到 early-return),demo 模式建不出来。改为 **upsert**(找不到则 `addNetworkPolicy`)—— 这才是 kubectl apply 真语义,顺带修潜在 bug。

## 组件拆分

每个单元单一职责、可独立理解与测试:

| 组件 / 模块 | 职责 |
|-------------|------|
| `src/components/networkpolicy/NetworkPolicyEditor.vue` | 容器:持有 model、YAML 预览栏、后果标签、提交。create/edit 复用(v1 只接 create) |
| `src/components/networkpolicy/NpPodSelectorEditor.vue` | 顶层 `spec.podSelector`(matchLabels + matchExpressions) |
| `src/components/networkpolicy/NpRuleEditor.vue` | 一条 ingress/egress 规则(`direction` prop 区分),含 peers + ports 列表 |
| `src/components/networkpolicy/NpPeerEditor.vue` | 一个 peer:podSelector / namespaceSelector / 组合 / ipBlock.cidr+except,各自 matchLabels+matchExpressions |
| `src/components/networkpolicy/NpPortEditor.vue` | 一个端口:protocol / port / endPort / 命名端口 |
| `src/logic/networkPolicy.js` | **纯逻辑**:`defaultModel()`、`consequence(spec)`、`isDenyAll(spec)`、`modelToYaml(model)`(yaml.dump 的具名封装,补全 apiVersion/kind/metadata 并规范化)、`parseAndValidate(yaml)`、`isCleanRoundtrip`。零依赖运行器可测 |

挂载点:`NsNetworkPolicies.vue` 现有 Create 弹窗 + 裸按钮 → 换成「创建网络策略」按钮打开 `NetworkPolicyEditor`(v-model dialog)。

## 安全 UX(无条件实现)

**每方向实时后果标签**,四态:

- ✅ **仅放行** —— 规则存在且限定了源/端口
- ⚠ **放行全部** —— 规则存在但未限定源(`from`/`to` 缺省 = 任何来源)
- ⛔ **拒绝全部** —— 该方向在 `policyTypes` 内但无任何规则(所有流量被阻断)
- — **不管控** —— `policyTypes` 未含此方向

关键:K8s 里「无规则」(deny 全部)与「有规则但没填 from」(allow 全部)语义完全相反 —— 这正是原流程的坑。标签把差异摊到明面,配合实时 YAML 不可能误判。

**deny-all 守卫**:进入 ⛔ 状态时 Create 禁用,需勾选「我知这将阻断该方向所有流量」才亮。

**默认基线 = 放行起步**:`defaultModel()` 产出每方向一条未限定源的规则,只有用户手动删光规则才进 deny-all。对生产最安全 —— 默认最坏只是策略无效,不会锁死 namespace。

**校验**:名字 DNS-1123(小写字母数字与 `-.`),命名空间从路由锁定不可改。

## 测试(CLAUDE.md 零依赖运行器优先)

`src/logic/networkPolicy.js` 全是纯函数 → 自研零依赖运行器(`scripts/test.mjs`)覆盖:

- `defaultModel()` 是放行起步(每方向一条未限定源规则)
- `consequence(spec)` 四态判定(仅放行 / 放行全部 / 拒绝全部 / 不管控)
- `isDenyAll(spec)` 准确识别 deny-all
- `modelToYaml` ↔ `parseAndValidate` 语义往返深相等,含 matchExpressions / ipBlock.except / endPort
- 解析失败 / 非 NetworkPolicy → 降级标志正确

组件交互(v-model 双向、降级只读、deny-all 守卫)用 vitest + @vue/test-utils + happy-dom。

## 顺带修复清单

下列问题由本设计覆盖,实现时落地(非已完成):

- `handleCreate` 非 await → 统一走 `await applyResourceYaml`
- `ingressRules: ? [] : []` 死三元 → 旧 `handleCreate` 整体删除
- 名字无校验 → DNS-1123
- `generateYAML('networkpolicy')` 裸插值 → 向导用 js-yaml `dump`(转义正确);旧 `addNetworkPolicy` / `generateYAML('networkpolicy')` 暂保留不动,后续可清理

## 已替用户拍板的子决策(可在评审时否决)

1. **单按钮不加 SplitButton**:向导已内嵌可编辑 YAML,等价「从 YAML 创建」。
2. **v1 只做 create,edit 复用留后续**:编辑器组件按可复用设计,但 v1 不接入详情页。
3. **mock 模式 upsert 补丁要做**:`applyResourceYaml` 的 NetworkPolicy case 改 upsert。
