# 全应用表单字段审计——「纯数值选单位 / 格式受限给提示」合规清单

日期:2026-08-16 | 规则:纯数值字段应提供单位选择;格式受限字段应提示输入格式 | Ingress 面已于本日修复(spec:`docs/superpowers/specs/2026-08-16-ingress-field-units-validation-design.md`,Tasks 1-5)

扫描方法:`grep 'type="number"'` / `grep placeholder 单位示例` / `grep ResourceInput` / 全量 `<input` 清单(views 311 处、components 另计),再逐视图读模板代码核对实际形态(数字框/文本框/下拉/提示/校验/提交转换)。覆盖 `src/views/*.vue`(含 admin/)与 `src/components/{common,networkpolicy,layout,workbench}/**`。

判定口径:
- **数值+单位**(CPU/内存/存储量):应数字框 + 单位下拉(参照 `ResourceInput` / `IngressPerfField` 先例)。裸文本且裸数字会被 apiserver 当合法 quantity 静默接受(如 `512` = 512 字节)= 最危险。
- **纯数值**(计数/端口/秒数):应数字框(+min/max 范围),单位以 label 后缀或只读后缀呈现。
- **格式受限**(IntOrString/CIDR/CSV/cron/PEM/域名):应常显 hint + 提交前校验;placeholder 示例算「半合规」。
- 风险 = 错值后果 × 有无远端兜底(apiserver 校验拒绝=有兜底但报错晚;**静默接受错值=无兜底**)。

## 结论摘要

- 已合规(有单位选择/数字框+范围/结构化约束):**16 组**(Ingress 3 处已修 + ResourceInput 系/HPA/端口 min-max 系等 13 组)
- 不合规(裸文本数量单位/纯数值缺约束/缺提示):**19 组、约 60 个字段**(其中 1 组为未被引用的遗留组件,实际可达 18 组),按风险排序见 Backlog
- 半合规(格式受限已有 placeholder 提示、无客户端校验):**6 组**(含 Backlog 中 PEM/Secrets 项)
- 自由文本(规则不适用:ConfigMap/Secret 数据、注释、描述、检索框等):不逐行列举

> **计数口径**:按视图级分组计数(同一视图多字段归一组);半合规计数含 Backlog 中 PEM/Secrets 项。

## 明细

| 视图/组件 | 字段 | 分类 | 现状(实测) | 建议 | 风险 |
|---|---|---|---|---|---|
| NsIngress 性能面板+自定义注解(4 方言) | 47 字段 | 数值+单位/格式受限 | ✅ 已修:`IngressPerfField`(vt 元信息:数字框+单位下拉 k/m/g、ms/s/m;只读单位后缀;hint 常显)+ 提交前 `validateIngressAdv`/`validateCustomAnnotations` 拦截(spec §①②③⑤) | — | — |
| DeployApp 第 5 步网关性能调优+自定义注解 | 同上 47 字段 | 同上 | ✅ 已修:`IngressPerfField` + `AnnotationKeySelect` 已知 key 提示 + validate() 拦截(spec §③④) | — | — |
| NsIngressDetail 添加/编辑注解弹窗 | 注解 value | 格式受限 | ✅ 已修:已知 key 按 `vfmt` 显示格式 hint + 保存前校验(spec §④⑤) | — | — |
| NsLimitRanges 创建弹窗 | default/defaultRequest/max/min × CPU/Memory 共 8 字段 | 数值+单位 | 裸文本框(无 type=number),placeholder 带单位示例(`500m`/`512Mi`/`2`/`4Gi`/`50m`/`64Mi`),无校验,原样直传 `addLimitRange` | 数字框+单位下拉(ResourceInput,cpu/mem 两 kind) | **高**:填 `512` 被 apiserver 接受为 512 **字节**,静默注入 namespace 全体 Pod 默认 limits→Pod 起不来或配额浪费,无报错兜底 |
| NsLimitRangeDetail 编辑弹窗 | 同上 8 字段 | 数值+单位 | 裸文本框,且**无任何 placeholder**(比创建弹窗更差) | 同上 | **高**:同上,静默错值无兜底 |
| NsResourceQuotas 创建弹窗 | cpuHard | 纯数值(毫核)+单位陷阱 | 文本框,label 带 `(millicores, 1=1000m)`;提交 `milliToCpu(Number(f.cpuHard))`:填 `8`(想表达 8 核)→ `'8m'`(差 1000 倍,静默);填字母 → `'NaNm'`(apiserver 拒,报错难懂) | 数字框 + 只读 `m` 后缀;或 cores 数字框+核/m 下拉 | **高**:配额缩 1000 倍静默生效,Pod 全被拒 |
| NsResourceQuotas 创建弹窗 | memoryHard | 数值+单位 | 裸文本框,placeholder `16Gi`,无校验 | 数字框+Gi/Mi/Ti 下拉 | **高**:填 `16` = 16 字节,静默 |
| NsResourceQuotas 创建弹窗 | podsHard / servicesHard | 纯数值 | 裸文本框(非数字框),placeholder `20`/`10` | type=number + min=0 | 中:填字母被 apiserver 拒(有兜底,报错晚) |
| NsResourceQuotaDetail 编辑弹窗 | cpuHard / memoryHard / pvcHard / storageHard | 数值+单位 | 4 个裸文本框;仅 cpuHard 有毫核 hint+placeholder `20000`(且 `handleEdit` 同样 `milliToCpu(Number())` 陷阱);memory/pvc/storage **无任何提示** | 同创建弹窗方案 | **高**:pvc/storage 的 requests.storage 配额裸数字=字节,静默 |
| NsResourceQuotaDetail 编辑弹窗 | podsHard / servicesHard | 纯数值 | 裸文本框,无提示 | type=number | 中 |
| CreatePvcDialog(VolumeMountCard 引用) | capacity | 数值+单位 | 裸文本框,placeholder `10Gi`;创建失败有 error 提示与留窗 | 数字框+Gi/Mi/Ti 单位下拉 | 中高:填 `10` = 10 字节 PVC,apiserver 接受,静默 |
| NsStorage 创建 PVC 弹窗 | capacity | 数值+单位 | 裸文本框,placeholder 即 label「容量」——**连单位示例都没有**(全应用最差的容量输入) | 同上 | 中高:同上 |
| Storage.vue(集群级)创建 PVC + 创建 PV | capacity ×2 | 数值+单位 | 裸文本框,placeholder `10Gi`(zh `storage.capacityPlaceholder`) | 同上 | 中高:同上(PV 建错容量更难回收) |
| NsPVCDetail 编辑弹窗 | capacity | 数值+单位 | 裸文本框,placeholder `50Gi`;storageClass 有 datalist 建议良好 | 数字框+单位下拉 | 中:PVC 只能扩不能缩,错值影响后续扩容基准 |
| DeployApp 第 2 步容器端口 | containerPort | 纯数值 | **文本框**(无 type=number),placeholder `Port (e.g. 8080)`;**下一步门禁已查 `/^\d+$/` 数字校验**(「端口号必须为正整数」);缺 min/max 范围(0/70000) | type=number + min=1 max=65535 | 低:字母被客户端拦,范围超限到远端报错(有兜底但晚) |
| DeployApp 第 5 步 Service 端口 | port / nodePort | 纯数值 | **文本框**,placeholder `port`/`nodePort`;NodePort 下方有 info 行但只说「留空自动分配」,未给 30000-32767 范围;**port/nodePort 都无客户端数字校验** | type=number + min/max (port 1-65535, nodePort 30000-32767) | 中:字母/超范围要等 applyResourceYaml 远端报错(有兜底但晚、不指名字段) |
| NsServices 创建弹窗端口行 | port / nodePort | 纯数值 | type=number 但**无 min/max**(应 1-65535 / 30000-32767);targetPort 用 PortSelect 结构化(良好) | 补 min/max | 中低:超范围被 apiserver 拒(兜底存在,报错晚) |
| NsServiceDetail 编辑弹窗端口行 | port / nodePort | 纯数值 | 同上:数字框无 min/max(同视图「快速添加端口」弹窗却有 min/max,双标准) | 对齐快速添加弹窗的 min/max | 中低:同上 |
| NsWorkloadDetail 编辑弹窗健康探针 | 3 探针 × port/initialDelay/period/timeout/failure/success | 纯数值 | type=number 无 min/max;label 硬编码英文(`Initial Delay`/`Timeout`…)且**无 (s) 单位提示**(对比 DeployApp 同字段 label 带 `(s)`) | label 补单位;关键项补 min≥1 | 中:语义错值(如 timeout 巨大、period=1)apiserver 不拒→探针行为异常,无兜底 |
| NsWorkloadDetail 编辑弹窗 Service 端口/容器端口 | port / targetPort / containerPort | 纯数值 | type=number,无 min/max,placeholder `port`/`target`/`8080` | 补 min/max | 低:apiserver 兜底 |
| DeployApp 第 4 步滚动策略 | maxSurge / maxUnavailable | 格式受限(IntOrString) | 文本框,placeholder `25%`;无校验 | hint「整数或百分比」+ 提交校验 `/^\d+(%)?$/` | 中低:填 `1` = 1 个副本而非 1%,**静默**改变滚动语义 |
| DeployApp CronJob schedule | cron 表达式 | 格式受限 | 文本框,label `Schedule (Cron 表达式)`,placeholder `*/5 * * * *`;无校验 | 提交前 cron 语法校验 | 中:部分坏表达式(如 `0 0 31 2 *`)语法合法但**永不触发**,apiserver 不拦,无兜底 |
| CreateResourceDialog(遗留组件) | deployment 资源 4 字段/containerPort/pvc capacity/servicePort | 数值+单位/纯数值 | 裸文本无单位提示、端口文本框;**当前无任何视图引用**(仅 useSecretTemplates 注释提及) | 删除,或修复后再启用 | 低(不可达);若复用则为高危形态 |
| NsPDBs 创建 / NsPDBDetail 编辑 | minAvailable / maxUnavailable | 格式受限(IntOrString) | 文本框,placeholder 有格式示例「最小可用副本数(如 2 或 50%)」(半合规,无校验);desiredHealthy 为数字框+placeholder | 维持,可加提交校验 | 低:错值被 apiserver 拒 |
| NsIngress 创建 / DeployApp ingress 规则 | host / path | 格式受限 | 文本框,placeholder 示例 `app.example.com`/`/`;path 无「须以 / 开头」提示 | 复用 spec 的 `vt=path` hint+校验 | 低:apiserver 校验兜底 |
| NpPeerEditor(NetworkPolicy) | ipBlock.cidr / except | 格式受限 | 文本框,placeholder `CIDR 如 10.0.0.0/8`/`排除 CIDR,逗号分隔`(半合规) | 可加 CIDR 正则校验 | 低:apiserver 拒坏 CIDR |
| NsRoleDetail 规则编辑 | apiGroups / resources / verbs | 格式受限(CSV) | 文本框,placeholder 均有 CSV 示例(`e.g. pods, deployments, secrets`)(半合规) | 维持 | 低 |
| NsSecrets 创建(TLS/SSH/认证) | tlsCrt/tlsKey/sshKey 等 | 格式受限 | textarea,placeholder 带 PEM 头示例(`-----BEGIN CERTIFICATE-----…`)(半合规) | 维持 | 低:apiserver 拒坏 base64/PEM |
| DeployApp/NsWorkloadDetail(主/init/extra 容器) | cpu/mem request/limit | 数值+单位 | ✅ `ResourceInput`:数字框+单位下拉(cpu:cores/m;mem:Ki/Mi/Gi/Ti),内外部拆合同步 | — | — |
| NsHPA 创建 / NsHPADetail 编辑 | min/maxReplicas、cpu/memTarget | 纯数值(百分比) | ✅ 数字框 min=1(cpu/mem max=100),label 带 `(%)`;创建钮 `min>max` 禁用 | — | — |
| PriorityClasses 创建 | value | 纯数值 | ✅ 数字框 + label + `valueHint` 常显提示 | — | — |
| ScaleDialog / NsWorkloadDetail 扩缩容 | replicas | 纯数值 | ✅ 数字框 min=0/1 | — | — |
| NsServiceDetail 快速添加端口 | port / nodePort | 纯数值 | ✅ 数字框 min=1 max=65535 / min=30000 max=32767 + 说明行(可作为全应用端口输入的样板) | — | — |
| PortForwardPanel | 目标端口 / 本地端口 | 纯数值 | ✅ 数字框 + 容器端口 datalist 建议 + 「自动分配」placeholder | — | — |
| ClusterForm | kubeconfig/apiServer/token | 格式受限 | ✅ 客户端 errors 红框校验 + 格式 placeholder(`https://10.0.0.1:6443`) | — | — |
| ApiKeyManagement mint 表单 | owner/SA/namespace | 格式受限 | ✅ mintErrors 红框 + select 集群选择 | — | — |
| VolumeMountCard | 卷源/mountPath | 格式受限 | ✅ PVC/CM/Secret select 化;路径 placeholder `/etc/config`、subPath 有提示 | — | — |
| EnvSourceField | envFrom 名称/键 | 格式受限 | ✅ 名称+键 select 化(不手敲) | — | — |
| NpPortEditor(NetworkPolicy) | port/endPort | 格式受限(IntOrString) | ✅ 输入按数字/命名端口智能判定(数字→Number 并提供 endPort;命名保留字符串),placeholder「端口(空=全部)」 | — | — |
| DeployApp Job 参数/探针/超时 | completions/parallelism/backoffLimit/activeDeadlineSeconds、探针 6 参 | 纯数值 | ✅ 数字框,label 带 `(s)` 单位(轻微:无 min=1,可顺手补) | — | — |
| NsServices/NsServiceDetail 会话亲和 | sessionAffinityTimeout | 纯数值 | ✅ 数字框,label `Timeout (s)` | — | — |
| 各 ConfigMap/Secret/注解/label 编辑、业务元数据、nodeSelector、DNS searches、hostAliases、描述与检索框 | — | 自由文本 | 键值对/多行文本,K8s 侧无格式语义(或仅字符集限制,apiserver 兜底),规则不适用 | — | — |

## Backlog 建议(按风险排序:错值后果重、无静默兜底的在前)

1. **LimitRange 创建+编辑(16 字段)**:裸文本数量,裸数字=字节**静默**注入全 namespace Pod 默认 limits。改 `ResourceInput`(cpu/mem)两 kind 即可,收益最大。
2. **ResourceQuota 创建+编辑(10 字段)**:memory/pvc/storage 裸数字静默;cpuHard 有 `milliToCpu(Number())` 毫核陷阱(8→8m)。memory/pvc/storage 换单位下拉,cpuHard 换数字框+只读 `m` 后缀。
3. **PVC/PV 容量 6 处**(CreatePvcDialog/NsStorage/Storage×2/NsPVCDetail + 遗留):统一数字框+Gi/Mi/Ti 下拉;NsStorage 的 placeholder 先补 `10Gi` 示例(一行 i18n 速效)。
4. **NsWorkloadDetail 探针(无单位提示+无 min)** 与 DeployApp/NsServices 端口(文本框或无 min/max):label 补 `(s)`/数字框补 min/max;DeployApp 容器端口/Service 端口从文本框改数字框。
5. **DeployApp maxSurge/maxUnavailable + cron schedule**:加 hint 与提交前校验(cron 可用轻量五段解析);两者均有「合法但语义错」静默路径。
6. **半合规项收尾**:PDB/host/path/CIDR/CSV 补提交校验(低优先;已有 placeholder 提示+apiserver 兜底)。
7. **CreateResourceDialog 遗留组件**:无引用,建议删除(避免未来误用其高危裸文本形态)。

修复基建已就绪:`ResourceInput`(cpu/mem)与 `IngressPerfField` 的「数字框+单位下拉+提交校验」模式可直接复制到 1-3 项。

## 回归

- `npm test`(test:server 零依赖运行器 + node --test server/scripts + vitest 全量)与 `npm run typecheck`、`npm run i18n:check` 于本分支全绿,输出摘要见 `.superpowers/sdd/2026-08-16-ingress-field-units/task-6-report.md`。
