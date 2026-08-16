# Ingress 路径级后端映射统一(创建侧对齐编辑侧金标准)

- 日期:2026-08-16
- 状态:已与用户逐节确认(范围/向导语义/追加语义/方案选型)
- 分支:`feat/ingress-path-mapping`(worktree,基于本地 main bf88d37)

## 1. 背景与问题

用户场景:**创建 workload 时,把「某域名的某 path」映射到「某 service 的某端口」**。系统检查发现该能力在 4 个入口中只有 1 个完整,且最常用的两个创建入口恰恰是断的:

| # | 入口 | 现状 | 断点 |
|---|------|------|------|
| ① | 部署向导 Step5 `src/views/DeployApp.vue:1371` | host/多 path/pathType/TLS/IngressClass 齐全 | path 不能选 backend:YAML 生成硬编码 `servicePorts[0]?.port \|\| 80`(`DeployApp.vue:648`),多端口 Service 无法分流;勾 Ingress 关 Service 时 backend 悬空指向不存在的 `{name}-svc` |
| ② | Workload 详情「暴露」弹窗 `src/views/NsWorkloadDetail.vue:2175` | 单条 host+path+service 下拉 | servicePort 为手填文本框;每次保存新建一个 Ingress 资源(`app-ingress-2/3…` 碎片化);service 下拉仅列 selector 匹配项;无 pathType |
| ③ | Ingress 列表「New」`src/views/NsIngress.vue:235` | service+port 双下拉(体验正确) | 单 rule 单 path,同域名多 path 需建多个 Ingress 或建完进详情页补 |
| ④ | Ingress 详情「Edit Rules」`src/views/NsIngressDetail.vue:500` | ✅ 完整:host 分组卡片、每 path 选 service+端口、pathType、校验 | (编辑侧金标准,三个创建入口未对齐) |

**根因**:④ 的交互模式(host 分组 + 每 path 独立后端)没有下沉为共享能力,①②③ 各自简化实现,① 是向导初版遗留硬编码。

## 2. 已确认的决策

1. **范围**:①②③ 全修(创建侧对齐编辑侧)。
2. **向导后端语义**:① 的 path 后端可选**已有 Service**(ns 全量下拉 + 其端口),不限于向导自建 Service。
3. **② 追加语义**:同域名已有 Ingress 时默认**追加 path 进现有资源**(PATCH),可切换「新建 Ingress」。
4. **方案**:抽取共享 `IngressRulesEditor` 组件,①②③④ 四入口统一(方案 A)。

## 3. 架构

### 3.1 统一数据模型(hosts 编辑模型)

```
hosts: [{
  host: 'app.example.com',
  tls: false, tlsSecret: '',            // per-host TLS(K8s spec.tls 语义)
  paths: [{
    path: '/api', pathType: 'Prefix',
    serviceName: 'my-svc', servicePort: '8080'   // 本次补齐的核心字段
  }]
}]
```

- 向导现有 `ingressRules`(`DeployApp.vue:98`)加 `serviceName/servicePort` 两个路径级字段即兼容。
- 老 copySeed(无 serviceName/servicePort)渲染时回退默认值,不崩。

### 3.2 共享组件 `src/components/common/IngressRulesEditor.vue`

从 `NsIngressDetail.vue:529-573` 的 host 分组卡片抽取,保持 DOM 结构与 i18n 键(等价搬迁):

| Props | 说明 |
|---|---|
| `modelValue` | hosts 数组;深变更 emit `update:modelValue` |
| `services` | `[{name, ports:[…]}]`,调用方组装;向导注入虚拟项 `{name:'{workload}-svc', virtual:true}` 置顶标记「本向导创建」 |
| `withTls` | 渲染 per-host TLS 行(①③④ 开;② 不用组件) |
| `withDefaultBackend` + `defaultBackend` | ④ 专用(现行为保留) |
| `errors` | 父级语义校验结果传入,行级标红(`fieldError` 机制平移) |

- 每 path 行:path 输入 + pathType 下拉 + serviceName PortSelect + servicePort PortSelect(候选联动 = 选中 service 的 ports),即 ④ `NsIngressDetail.vue:544-556` 现有能力组件化。
- 行级校验(空值红框)内置;host/path 增删移、复制按钮平移 ④。

### 3.3 纯函数层(扩展 `src/composables/useIngressRules.js`)

现有 `buildIngressRulesPatch` 保持不动,新增:

- `hostsToFlat(hosts)` / `flatToHosts(flatRules)` — 编辑模型 ↔ 扁平 rules 互转(④ 视图内转换逻辑下沉)
- `hostsToK8sSpec(hosts)` — 生成 `{rules, tls}` spec 片段(per-host TLS 聚合为 spec.tls),供 ③ `addIngress` 与 ① YAML 共用
- `appendPathDecision(ingressList, {host, path, pathType, serviceName, servicePort})` — ② 智能追加决策:返回 `{mode:'patch', ingress, flatRules}`(host **精确**匹配已有 Ingress,flatten 后追加新 path)或 `{mode:'create'}`;空 host(`*`)不参与匹配
- `buildWizardIngressYaml(hosts, {name, namespace, ingressClassName, annotations})` — 向导 Ingress YAML 段从 `previewYAML` 拆出

**根因修正不变式**:backend 一律取 path 级 `serviceName/servicePort`;生成层禁止 `\|\| 80` 兜底、禁止硬编码 `{name}-svc`;未填写由校验拦截。

## 4. 入口接入

### ① 部署向导 Step5(`DeployApp.vue`)

- `1439-1470` 行 ingressRules 编辑区换 `IngressRulesEditor`(`withTls=true`)。
- services 源 = Vue Query ns Service + 虚拟项(`createService` 勾选时注入,新增 path 默认指向)。
- Ingress YAML 段改走 `buildWizardIngressYaml`;TLS 段从 hosts 读取(语义不变)。
- 校验强化(`stepBlockReason` `231-249` 行):勾 createIngress 时每条有效 host 的每条 path 必须已选 service+端口;`createService` 关闭 + `createIngress` 开启为合法组合(后端选已有 Service)——悬空引用根除。

### ② Workload 详情「暴露」弹窗(`NsWorkloadDetail.vue:2175`)

保持轻量单条映射定位(不塞完整编辑器;多 path 场景引导去 ③/④),升级四点:

- serviceName 下拉:关联 Service 置顶标记 + ns 全量(PortSelect 平铺)
- servicePort:文本框 → PortSelect(选项 = 选中 Service 的 portList)
- 补 pathType 下拉(默认 Prefix)
- 智能追加:弹窗内实时计算同 host 已有 Ingress;存在则默认「追加 path 到 `<ingress名>`」并明示,可切「新建」;保存 patch 走 `appendPathDecision` → `updateIngressRules`,create 走 `addIngress`

### ③ Ingress 独立创建(`NsIngress.vue:235`)

- basic 标签删掉 host/path/pathType/service/port/enableTLS 六个单条字段,换 `IngressRulesEditor`(预置一条空 host;TLS per-host)。
- `handleCreate` 用 `hostsToK8sSpec` 生成 rules/tls 传 `addIngress`;className、perf/extra 注解不动。

### ④ Ingress 详情 Edit Rules(`NsIngressDetail.vue:500`)

等价搬迁为消费组件(`withDefaultBackend=true`),DOM/交互/i18n 保持,行为不变(其他三处的回归基准)。

## 5. 测试(TDD,分层)

- **纯函数 node --test**(注册 `scripts/test.mjs`):`hostsToFlat`/`flatToHosts` 往返等价;`hostsToK8sSpec` 多 host/tls 聚合;`appendPathDecision` 精确匹配、空 host 不匹配、create 回退;`buildWizardIngressYaml` path 级 backend、无 80 兜底、无悬空引用(回归用例)。
- **组件 vitest**(@vue/test-utils + happy-dom):编辑器增删/联动(service→port 候选)、①②③ 集成冒烟。
- **手测**:真实集群向导多端口 Service 分流;② 追加后 `kubectl get ingress -o yaml` 验证。

## 6. 边界与已知坑

- `updateIngressRules(name, ns, flat, defaultBackend)` 传 `null` 会删除 defaultBackend(`cluster.js:386`)——② 的 patch 必须回传现有值(从目标 ingress 对象读取)。
- ② patch 失败:保留弹窗 + notify 错误(沿用 addIngress 的 `{ok}` 契约模式)。
- i18n:新键 en+zh 同步补齐,过 `npm run i18n:check`;含 HTML 的提示走 `v-html`(既有约定,防 `{{ }}` 显示标签文本)。
- 不动 server 端;不新增依赖。

## 7. 范围外(明确不做)

- ② 弹窗不做多 path/多 host/TLS/IngressClass(定位轻量,复杂编辑走 ③/④)。
- Service 创建/编辑链路本身不动(NsServices/NsServiceDetail 现状已达标)。
- IngressClass 默认值探测增强、defaultBackend 创建侧支持。
