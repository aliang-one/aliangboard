# Init/Sidecar 容器字段全覆盖扩充设计(2026-08-25)

## 背景与目标

容器编辑弹窗交付后的覆盖度审计发现:init/sidecar 子容器只建模 8 字段(name/image/command/args/CPU·内存 req/lim),对照主容器能力与 K8s Container 规范存在系统性缺口,且**横跨三个面**:DeployApp 创建向导(makeForm/previewYAML/弹窗/校验)、复制 workload 回填(useWorkloadToForm 窄映射丢字段)、NsWorkloadDetail 编辑面(containerToForm/buildSubContainer 窄模型+`cpuReq` 键名与创建侧不一致+行内小表单+测试覆盖为零)。

**目标**:对齐主容器全集的字段扩充,以「一个域模块+一个弹窗、两面消费」收敛全部缺口。

**已裁决决策(与用户逐项确认)**:

| 决策点 | 结论 |
|---|---|
| 覆盖线 | 对齐主容器全集(env 三机制/ports/三探针/lifecycle/securityContext/workingDir/pullPolicy/stdin/tty);ephemeral-storage 主容器也没有→不做;terminationMessage 等表单产品不做 |
| 紧凑卡片 | 保持现状 8 字段;头部加「已配 N 项高级」badge,点徽标开弹窗 |
| 原生 sidecar | 每 sidecar 可选开关(k8s≥1.28):开启→发到 initContainers+`restartPolicy: Always`;回填自动识别;不做集群版本硬校验,开关旁提示版本要求 |
| 编辑面 | 共享弹窗单源:NsWorkloadDetail 行内小表单换卡片+badge+弹窗;模型/构建/回填/校验抽共享模块;键名统一 `cpuRequest` 风格 |

对比过的备选:两面试平各补各的(重复逻辑翻倍,否决)、数据层单源 UI 各留(编辑面行内必爆,绕回本方案,否决)。

## 架构:一个域模块、一个弹窗、两面消费

**新 `src/logic/subContainer.js`**(纯函数,零依赖 node:test 可测):

- `makeSubContainer()` — 全字段默认值(见下节形状;资源默认 100m/250m/128Mi/256Mi 同现状)
- `buildSubContainerSpec(c)` — 表单→K8s spec 对象(omitempty;探针构建镜像 NsWorkloadDetail 现有 `buildProbe` 逻辑;env 三机制/ports/lifecycle/securityContext 镜像主容器生成语义)
- `mapSubContainer(spec)` — spec→表单全量反解(复制回填与编辑回填共用);`initContainers` 中 `restartPolicy === 'Always'` → 归 `extraContainers` 且 `nativeSidecar: true`(容器级 restartPolicy 只有 Always 一个可设值,往返无损);普通 init 无此字段
- `advancedCount(c)` — 高级配置项计数(badge 用)

**`ContainerEditorDialog.vue` 泛化**:分节装下字段全集,创建向导与 NsWorkloadDetail 编辑面共用。

**接线替换**(旧窄实现删除,单源化):
- DeployApp:`makeForm` 的 init/extra 默认、`addInitContainer/addExtraContainer` 默认值 → `makeSubContainer()`;previewYAML 子容器块 → `buildSubContainerSpec`+序列化(见下节);`useWorkloadToForm.mapSidecar/mapInit` → `mapSubContainer`
- NsWorkloadDetail:`containerToForm`(子容器用途)/`buildSubContainer`/`buildResources`(子容器用途)→ 共享模块;editForm 子容器键名 `cpuReq/cpuLim/memReq/memLim` → `cpuRequest/cpuLimit/memoryRequest/memoryLimit`(模板同步迁);行内两块小表单 → 卡片+badge+弹窗

主容器的探针/env 构建路径本次**不重构**(范围纪律);共享模块的构建器写成通用形状,主容器采纳留作后续。

## 数据模型(键名与 DeployApp 主容器一致)

```js
{
  name, image, command, args,
  cpuRequest, cpuLimit, memoryRequest, memoryLimit,
  workingDir, pullPolicy: '', stdin: false, tty: false,   // pullPolicy '' = 不发(继承)
  envVars: [{ key, value }],
  envFromConfigMap: '', envFromSecret: '',
  envCMKeys: [{ name, cmName, key }],
  envSecretKeys: [{ name, secretName, key }],
  ports: [{ containerPort, protocol }],
  liveness:  { enabled, type, httpPath, port, execCommand, initialDelaySeconds, periodSeconds, timeoutSeconds, failureThreshold, successThreshold },
  readiness: { ...同上 }, startup: { ...同上 },
  lifecycle: { postStart, preStop },
  securityContext: { enabled, privileged, runAsUser, runAsGroup, runAsNonPrivileged, readOnlyRootFilesystem, addCaps, dropCaps },
  nativeSidecar: false,
}
```

探针/安全上下文/生命周期形状与主容器逐字段同款(回填与生成逻辑可镜像);探针默认值同主容器(liveness initialDelay 30 等),默认 disabled。

## 生成与回填

- **创建侧 previewYAML**:子容器块弃手拼,改 `dump(buildSubContainerSpec(c))` 后整体缩进 6 空格拼入(对齐现有列表项 6/属性 8 缩进)。**序列化安全**(yamlScalar 系列教训根治):dump 强制全字符串双引号风格 + `lineWidth: -1` 禁折行——env value 为 `on`/`3600`/带换行时不可能被 yaml.v2 的 1.1 语义误型化或折断。派生名逻辑(derivedContainerName/播种)不变。
- **编辑侧 saveEdit**:`buildSubContainerSpec` 直接产 spec 对象;native sidecar 发 `spec.initContainers` 尾部(普通 init 之后、主容器之前启动,终止有序——K8s 文档建议位)。
- **回填**:`mapSubContainer` 全量反解,复制/编辑丢字段问题随之消失;复制 workload 的原生 sidecar 也正确归位识别。

## 校验(并入现有 `containerValidation.js` 单源)

既有四条(image 必填/name DNS-1123+查重/req≤lim)不变,新增:

- ports 行非空:containerPort 必填、1-65535、protocol ∈ TCP/UDP/SCTP
- env 三机制:行非空缺 key 报错;重复 env 名报错(复用 `firstDuplicateEnvName`)
- 探针 enabled:http/tcp 须 port;exec 须命令
- 原生 sidecar:仅提示不硬校验(前端无法可靠探测集群版本)

弹窗实时(blur 显错+确认拦截)与提交 validate()(DeployApp)/saveEdit 前校验(NsWorkloadDetail)双路径同源。校验消息键统一扩展 `deploy.containerFv.*`(弹窗两面共用);NsWorkloadDetail 旧 `workload.validation.initMissingImage/sidecarMissingImage` 两条随之退役删除。

## UI

- **弹窗分节折叠**:基本/启动命令/资源常开;环境(env 三段式)/端口/探针(enabled 开关+类型切换)/生命周期/安全上下文五节可折叠,默认收起,节标题带计数。交互镜像主容器现有 UI;EnvSourceField 复用于 CM/Secret 键筛选。
- **紧凑卡片(两面)**:保持现状 8 字段;头部加「已配 N 项高级」badge(`advancedCount`),点击开弹窗。原生 sidecar 开关只在弹窗内 sidecar 类容器显示。
- **编辑面**:行内两块小表单 → 与创建面同款卡片+badge+弹窗。

## i18n

约 40+ 新键(五节标题/字段 label/badge 文案/原生 sidecar 开关+版本提示/校验消息),en+zh 双语同步,过 `npm run i18n:check`;值无 `@`、无 HTML。

## 测试

- `src/logic/subContainer.test.mjs`(零依赖 node:test,注册 test:server):spec 全字段往返、omitempty、原生 sidecar 双向归位(init↔extra+nativeSidecar)、YAML 序列化安全(`on`/数字串/带换行 env 值不变形)。
- `containerValidation` 扩测:ports/env/探针新规则正反例。
- 弹窗 vitest 扩:新字段交互、折叠节、badge 计数、原生开关仅 sidecar 显。
- DeployApp 集成:previewYAML 含子容器 env/probe 块(双引号串);复制回填往返不丢字段。
- **NsWorkloadDetail 新增 vitest(现为零)**:先补编辑弹窗可挂载壳测试,再动模板;子容器卡片 badge、confirm 写回 spec 重建正确(containers/initContainers/native sidecar 归位)。
- 存量全绿;收尾门禁 test:server+test:unit+typecheck+i18n:check+build。

## 风险与对策

| 风险 | 对策 |
|---|---|
| NsWorkloadDetail 模板手术无既有测试网 | 测试先行:先补壳测试锁定现状行为,再替换模板 |
| 键名迁移漏改 | grep `cpuReq\|cpuLim\|memReq\|memLim` 全清点,编辑面内全数迁移 |
| YAML dump 引号/折行细节 | 双引号风格+lineWidth:-1 已定;零依赖测试钉住危险值用例 |
| 并行会话 main 漂移 | worktree 自本地 main 切出;合并时再同步 |
