# 容器环境变量编辑器重构设计(统一行模型 + envFrom 多值化 + 域逻辑单源化)

日期:2026-09-05
状态:已评审(用户批准方案 A:统一行列表;对标 Kuboard / Kite 后定稿)
范围:纯前端(Vue 组件 + 纯逻辑 + i18n + 测试),不改网关、不改 K8s 提交契约

## 1. 背景与问题

用户报告创建 Deployment 向导的「环境引用」区交互混乱:顶部「From ConfigMap / From Secret」两个按钮被读成单选框,点击后出现 ENV_NAME + 资源 + key 的行,与预期不符。系统排查后确认:

**第一性根因:类型被放错了层级。** 环境变量的「取值类型」(直填 / ConfigMap Key / Secret Key / 字段引用)是**行**属性,现状却上升成了**区块**属性——直填一块、CM 引用一块、Secret 引用一块、envFrom 又是按钮 + 两个单值下拉。同一卡片里「From ConfigMap / From Secret」标签各出现两次(按钮 + 下拉 label),按钮成对并排双配色,故被读成二选一。

**对标结论**(Kuboard 工作负载编辑器 + Kite `ui/src/components/editors/environment-editor.tsx`,源码级核实):两家一致采用「统一行列表 + 行内类型选择」;envFrom 是独立小节的多行数组(行内选 ConfigMap/Secret);两家都支持 fieldRef。

**顺带挖出的 3 个静默丢数据缺陷(今日已在线上):**

- D1 多 envFrom 丢失:`NsWorkloadDetail.vue:850,995` 与 `src/logic/subContainer.js:200` 回填只取每类第一个,保存时 `envFrom` 整体重建——存量 Deployment 的 envFrom 有多条时,编辑保存后剩余条目被静默删除,顺序重排。
- D2 fieldRef 全灭:编辑壳回填只装直填 / configMapKeyRef / secretKeyRef 三类桶,`fieldRef` / `resourceFieldRef` 类型的 env 行装不下;保存时 `c0.env` 从零重建(`NsWorkloadDetail.vue:848,990`)——常见于 `MY_POD_NAME: valueFrom: fieldRef: metadata.name`,编辑保存即消失。
- D3 复制流丢引用:`useWorkloadToForm.js` 主容器只映射直填 envVars,主容器全部 valueFrom / envFrom 引用在复制 workload 时丢失(子容器反而全量反解,行为不一致)。

**混乱模式复制了 5 个面**(同域代码五处重复,一处修复须五处生效):

| # | 面 | 位置 | 现状 |
|---|---|---|---|
| 1 | DeployApp 创建向导·主容器 | `src/views/DeployApp.vue:1156-1184`(UI)、`89-92`(模型)、`433-452,671-672`(previewYAML)、`796-798`(校验) | 假单选按钮 + 单值下拉 + 三堆行 |
| 2 | ContainerEditorDialog(子容器高级编辑,DeployApp 与 NsWorkloadDetail 两面共用) | `ContainerEditorDialog.vue:188-210` | 三小节 + envFrom 裸 input 对(单值) |
| 3 | subContainer.js(CED 模型层 + 复制流子容器反解) | `src/logic/subContainer.js:25-26,90-96,130-133,149-152,200-203` | 单值 envFrom 回填/序列化 |
| 4 | NsWorkloadDetail 编辑壳·主容器 | `NsWorkloadDetail.vue:846-851,945-946,988-996,1982-2019` | 三堆 + 单值 envFrom,D1/D2 现场 |
| 5 | useWorkloadToForm.js(复制 workload 种子) | `useWorkloadToForm.js:44`(mapMainContainer) | 主容器 env 引用全不映射 |

只读消费方 `cluster.js:extractWorkloadReferences`(约 :155-190)已按全数组遍历,无需改动。

## 2. 目标

1. 环境变量编辑交互对标 Kite/Kuboard:统一行列表 + 行内类型;envFrom 多行有序数组。
2. 根治 D1/D2/D3:五面全部走同一份纯逻辑,往返无损,任何 K8s valueFrom/envFrom 形态都不再静默丢失。
3. 域逻辑单源化:新 `src/logic/envRefs.js`(零依赖纯函数)+ 新 `src/components/common/ContainerEnvEditor.vue`(共享组件),五面收编。
4. 全量测试覆盖 + 六门禁全绿。

## 3. 数据模型(纯逻辑层 `src/logic/envRefs.js`)

统一 env 行(五类型 = K8s valueFrom 全集,不再存在「装不下的类型」):

```
type ∈ 'value' | 'configMapKeyRef' | 'secretKeyRef' | 'fieldRef' | 'resourceFieldRef'

value:            { name, type: 'value',            value }
configMapKeyRef:  { name, type: 'configMapKeyRef',  cmName, key }
secretKeyRef:     { name, type: 'secretKeyRef',     secretName, key }
fieldRef:         { name, type: 'fieldRef',         fieldPath }
resourceFieldRef: { name, type: 'resourceFieldRef', resource, containerName, divisor }

envFrom 行(有序数组): { kind: 'configmap' | 'secret', name }
```

resourceFieldRef 的 `containerName` / `divisor` 均可选(divisor K8s 默认 1);fieldRef 的 `apiVersion` 等未建模长尾子字段走 passthrough(见下)。

### API

```js
makeEnvRow(type)            // 行工厂,字段按类型给空串默认
makeEnvFromRow(kind)        // { kind, name: '' }
envRowsToSpec(rows)         // → K8s env 数组(跳过空行,保序)
envFromRowsToSpec(rows)     // → K8s envFrom 数组
envRowsFromSpec(envArr)     // → 行数组(五类型全识别,保序)
envFromRowsFromSpec(arr)    // → 行数组(全数组映射,不再取第一个——D1 根治)
envRefErrors(rows)          // 半行报错(空行跳过;类型相关必填字段缺失 → { row, msg })
envFromErrors(rows)         // 缺名报错
duplicateEnvNames(rows)     // 重名检测(统一模型后天然单列表,重名即同数组内重复)
envRowCount(rows, envFromRows)  // CED 高级徽标计数
envSectionEmpty(rows, envFromRows) // CED isBare 判定
```

### 两条铁律

- **往返无损**:`envRowsFromSpec(envRowsToSpec(rows))` 恒等(深度相等、顺序保留);反解时 type 已建模子字段之外的剩余子字段(如 `fieldRef.apiVersion`)收进 `row.passthrough`(对象),序列化时原样回吐——从机制上保证零静默丢失,而非枚举特判。
- **校验政策沿用现状**:整行空 → 跳过不报不产出;半行(有任一字段但必填不全)→ 报错拦截提交。产出侧(`ToSpec`)只收完整行(与校验双保险)。

## 4. 共享组件 `src/components/common/ContainerEnvEditor.vue`

```
┌─ 环境变量 ────────────────────────────[+ 添加变量]─┐
│  变量名        类型▾              (随类型变化)      │
│  DB_HOST     [直填值 ▾]        [postgres        ] 🗑 │
│  DB_PASS     [Secret Key ▾]    [secret▾][key▾  ] 🗑 │
│  MY_NAME     [字段引用 ▾]      [metadata.name   ] 🗑 │
└──────────────────────────────────────────────────┘
┌─ 整批导入 envFrom ── 说明:资源全部 KEY→同名变量,无需变量名 ──┐
│                                              [+ 添加来源]    │
│  [ConfigMap ▾] [app-config                     ▾]        🗑 │
│  [Secret    ▾] [db-credentials                 ▾]        🗑 │
└──────────────────────────────────────────────────────────┘
```

- props:`env`(defineModel,行数组)、`envFrom`(defineModel,行数组)、`namespace`(String)、`size`(`'sm'` CED/编辑壳 | `'md'` 创建向导)。
- CM/Secret 的资源名 + key 选择复用现有 `EnvSourceField`(含下拉候选、手输兜底、ns 漂移警示、useDropdownPanel 防裁切配方),组件内不重造 combobox。
- 类型下拉(value/configMapKeyRef/secretKeyRef/fieldRef/resourceFieldRef)与 envFrom 类型下拉用原生 select(与 DeployApp 端口协议行同风格,避免新造浮层)。
- 切换类型:保留 `name`,其余字段重置为目标类型工厂(与 Kite 行为一致)。
- 布局遵守 overflow-guard 配方:行向 flex 链 `min-w-0`,列向 truncate 元素自带 `w-full`;手机档换行(grid/flex-wrap),`static` 扫描必须过。
- 文案全部 `$t`,禁 src 中文字面量。

## 5. 五面收编(每面的具体改动)

1. **DeployApp.vue 主容器**:makeForm 的 `envVars / envFromConfigMap / envFromSecret / envCMKeys / envSecretKeys` → `envRows: []` + `envFromRows: []`;「环境变量 · 直填」与「环境引用」两卡合并为一卡 `<ContainerEnvEditor size="md">`;previewYAML 的 env/envFrom 段(现 :433-452,671-672)改调 envRefs;校验(:794-799,现含 `deploy.envMissingKey/envCmMissing/envSecretMissing/envDuplicateName` 与 `isEmptyEnvRow/firstDuplicateEnvName` 本地助手)改调 envRefErrors/envFromErrors/duplicateEnvNames(错误仍挂 `step: 1`,0 基即向导第二步);`addEnvVar/removeEnvVar/addEnvCMKey/...` 六个行操作函数删除(组件内聚)。
2. **ContainerEditorDialog.vue**:draft 模型换 `envRows/envFromRows`;「环境」小节三堆 markup + envFrom input 对(:188-210)整体换 `<ContainerEnvEditor size="sm">`;校验错误展示位保留(`ced-env-error`)。
3. **subContainer.js**:`makeSubContainer` 字段换新模型;`buildContainer` 的 env/envFrom 产出(:90-96)与 `mapSubContainer` 回填(:200-203)改调 envRefs(D1 子容器侧根治);`advancedCount`(:130-133)与 `isBare`(:145-152)同步新形状;NULLABLE_KEYS 不变(env/envFrom 仍是可空键)。
4. **NsWorkloadDetail.vue 编辑壳**:editForm 换 `envRows/envFromRows`(回填 :846-851 改调 envRefs,注意现字段名 `env` 与新 `envRows` 撞名需迁移);保存序列化(:988-996)改 envRefs——`c0.env`/`c0.envFrom` 不再从零重建半截模型(D1/D2 主容器根治);编辑壳环境小节 UI(:1982-2019)换 `<ContainerEnvEditor size="sm">`。
5. **useWorkloadToForm.js**:`mapMainContainer` 补 `envRows = envRowsFromSpec(c.env)` + `envFromRows = envFromRowsFromSpec(c.envFrom)`(D3 根治);与既有 `mapSubContainer` 子容器全量反解行为对齐。

附:`extractWorkloadReferences`(cluster.js)不动;CopyWorkloadDialog 不动(workloadToForm 是唯一接缝)。

## 6. 兼容性

- 表单模型是内存态,不落盘;持久层(YAML / K8s 对象)的 `env` / `envFrom` 本就是数组 → **无数据迁移**。
- 存量单 envFrom 回填为 rows[0];多条从此完整往返。
- previewYAML 生成的 YAML 形状不变(`env:` / `envFrom:` 两段,同缩进),仅内容覆盖面变宽(fieldRef/resourceFieldRef/多 envFrom)。
- 旧行为差异(有意):直填空 value 现在保留(`value: ''` 显式产出)——与现状一致,`e.value !== undefined` 判定不变。

## 7. 校验 + i18n

新增 locale 键(zh + en 对齐,过 i18n:check 三合一门禁):

- 类型 label:`deploy.envType.value / configMapKeyRef / secretKeyRef / fieldRef / resourceFieldRef`(zh:直填值 / ConfigMap Key / Secret Key / 字段引用 / 容器资源)。
- 组头与按钮:`deploy.envRowsGroup`(环境变量)、`deploy.envRowsAdd`(添加变量)、`deploy.envFromRowsGroup`(整批导入 envFrom)、`deploy.envFromRowsHint`(该资源的全部 KEY 会成为同名环境变量,无需逐个填变量名)、`deploy.envFromRowsAdd`(添加来源)。
- 字段 label:`deploy.envField.fieldPath / resource / containerName / divisor`、`deploy.envRow.name`(变量名)、`deploy.envRow.type`(类型)。
- 校验消息:五类半行报错(`deploy.envRowMissing.<type>` 带 {name})、envFrom 缺名(`deploy.envFromRowMissing`)、重名(`deploy.envRowDuplicate` 带 {name})。
- 复用现键:`deploy.fromConfigMap / fromSecret`(envFrom 行类型下拉)、EnvSourceField 既有内部键。
- 清理:被替换 UI 独占的键(如 `deploy.envDirectGroup / envRefGroup / envFromHint / addVariable` 等)若无他消费方则删除,`workload.edit.envNormal / envCmRef / envSecretRef` 同理——删前 grep 全仓消费方。

## 8. 测试(TDD,先红后绿)

- **新 `src/logic/envRefs.test.mjs`**(自研零依赖运行器,import 进 `scripts/test.mjs`):五类型 × 往返恒等(重点:多 envFrom 保序、resourceFieldRef 全字段、passthrough 回吐、fieldRef apiVersion);半行校验矩阵;重名;计数/空判;`envRowsToSpec` 只收完整行。
- **`scripts/test.mjs` 既有 workloadToForm 用例**(:488 起):断言扩展 envRows/envFromRows 映射(含引用不丢)。
- **`src/logic/subContainer.test.mjs`**:模型形状迁移 + 徽标计数/isBare。
- **组件测试(vitest + happy-dom)**:新 `ContainerEnvEditor.test.js`(挂载、加行、切型重置、删行、v-model 回写);`DeployApp.container-editor.test.js` 等既有 env 相关断言迁移;`NsWorkloadDetail.edit-shell.test.js` 迁移;`DeployApp.subcontainer-yaml.test.js` 中 env 段 YAML 断言核对。
- **门禁**:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run i18n:check` + `npm run build`(含 overflow-guard 静态扫,在 npm test 内)。

## 9. 不做什么(YAGNI)

- 行拖拽/上下移排序(Kite/Kuboard 均无;顺序 = 添加顺序,需要时删行重加)。
- ConfigMap/Secret key 对应值的预览展示。
- envFrom 跨容器批量复制。
- fieldRef 的 apiVersion 编辑 UI(passthrough 机制保证不丢,不建编辑件)。

## 10. 交付后手测清单(真浏览器 + 集群)

1. 创建 Deployment:加直填 / CM Key / Secret Key / 字段引用各一行,YAML 预览段形状正确;提交后集群 `env` 生效。
2. 整批导入:加 ConfigMap + Secret 各一条,YAML `envFrom` 两元素保序;进容器 `echo $KEY` 验证。
3. 编辑存量 workload(手工造一个含 2×configMapRef + fieldRef 的 Deployment):编辑壳打开不丢行、保存后 `kubectl get -o yaml` 核对 env/envFrom 无损。
4. 复制 workload:主容器引用行完整带入向导。
5. 子容器(高级编辑弹窗)同模型验证;徽标计数正确。
6. 手机档:行换行不溢出,下拉不被裁切。
