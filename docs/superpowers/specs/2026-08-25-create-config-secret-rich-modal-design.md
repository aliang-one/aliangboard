# ConfigMap/Secret 富创建 Modal 设计

日期：2026-08-25 · 状态：已获批（方案 A：加宽 Modal + 内部 Tabs）

## 背景与目标

ns 列表页（NsConfigMaps/NsSecrets）的创建 Modal 只有 name + 简单 key-value 行，而创建后的详情页有很好的编辑体验（文件浏览器式多键管理、语法高亮、注解/标签、YAML 编辑）。目标：创建体验对齐编辑体验。

**用户裁决记录**：
- 改造对象：两个列表页本地 Modal（CreateResourceDialog 是零消费死组件，不在范围）
- 能力范围（全选）：文件浏览器式多键管理 + Form↔YAML（单向派生+纯 YAML 模式）+ 注解/标签输入 + Secret 掩码
- 组件策略：抽共享组件，详情页本次零改动（统一换装留 follow-up）
- 形态：加宽 Modal（max-w-4xl）+ 内部 tabs，不用向导/抽屉

## 非目标

- 不改 NsConfigMapDetail/NsSecretDetail（UI 与逻辑均不动；detectLang 抽 util 后详情页保留内联版）
- 不做 YAML→Form 回写（真双向）；不做创建后自动跳详情页（维持现状留在列表）
- 不动后端（走 makeCrud→applyResourceYaml 既有契约）
- 不清理 CreateResourceDialog 死组件（另行处理）

## 组件架构

```
NsConfigMaps.vue ──┐
                   ├──> 新 CreateConfigResourceModal.vue（共用，prop: kind='configmap'|'secret'）
NsSecrets.vue ─────┘         │
                             ├── 新 DataKeysEditor.vue     （文件浏览器式多键管理）
                             ├── 新 KeyValueRowsEditor.vue （注解/标签行编辑，一组件两用）
                             ├── 复用 Modal / CodeViewer
                             ├── detectLang 抽 src/utils/detectLang.js（新组件用；详情页内联版不动）
                             └── Secret 8 种模板抽 src/utils/secretTemplates.js（与 NsSecrets 共享）
```

### CreateConfigResourceModal

- props：`kind: 'configmap' | 'secret'`、`namespace: string`、`modelValue: boolean`（v-model 开关）
- emit：`update:modelValue`、`created`（成功后父级刷新列表）
- 结构：头部（name 必填 + Secret 的 k8sType/模板选择）+ tabs：`数据 | 注解 | 标签 | YAML` + 底部（取消/创建）
- max-w-4xl，编辑区固定高度内滚（与详情页一致）

### DataKeysEditor

- props：`modelValue: Array<{key, value}>`（v-model）、`secret: boolean`（掩码模式）、`fixedKeys: Array<{key, label, multiline}>`（模板 Secret 的固定字段，传了则不显示自由键增删）
- 左栏：键列表（文件类型图标 + 行数 + hover 删除 + 底部「+ 添加键」）；右栏：CodeViewer 高亮查看 ↔ textarea 编辑（Edit/Save/Cancel）
- Secret 模式：值输入带掩码/明文切换（防旁窥；创建值即明文，无 base64 语义）；掩码仅为显示态，不阻挡提交
- 空态：无键时右栏显示引导文案

### KeyValueRowsEditor

- props：`modelValue: Array<{key, value}>`、`placeholder`；行内 key 重复/非法检测标红
- 注解 tab 与标签 tab 各一个实例

## 交互细节

- 模板类 Secret（tls/dockerconfigjson/basic-auth/ssh-auth 等）在数据 tab 显示固定字段（textarea）；Opaque/ConfigMap 为自由键
- YAML tab：默认实时派生只读预览（含 name/k8sType/data/labels/annotations，可复制）；「切换为纯 YAML 编辑」→ Form 各 tab 冻结置灰，直接编辑提交；切回 Form 弹确认（丢弃 YAML 手改）
- Secret 提交按钮旁固定提示「值将以 base64 编码存储」

## 数据流与提交

- **Form 模式**：`{ name, namespace, k8sType, data, labels, annotations }` → `store.addConfigMap/addSecret`（扩展签名接 labels/annotations；缺省时行为与旧签名一致——回归测试锁定）→ 严格接 `{ok}`：失败 Modal 不关、表单不丢
- **纯 YAML 模式**：`store.applyResourceYaml(yaml)`，前置校验 `kind ∈ {ConfigMap, Secret}`
- 成功：关 Modal + 列表刷新 + toast（现状不变）

## 错误处理

| 场景 | 行为 |
|---|---|
| name 空/非法 K8s 名 | 提交禁用 + 行内错误（复用现有 name 校验规则） |
| 数据键/注解/标签 key 重复或非法 | 行内标红，提交禁用 |
| 纯 YAML 解析失败 / kind 不对 | YAML tab 内错误，提交禁用 |
| 服务端 4xx/5xx | toast 服务端消息（已双语化）+ Modal 保留 |

## 测试

- DataKeysEditor 单测：键增删、查看↔编辑切换、掩码 toggle、v-model 同步、空态、fixedKeys 模式
- KeyValueRowsEditor 单测：行增删、重复 key 检测
- CreateConfigResourceModal 集成测（两 kind 各一组）：Form→payload 断言（含 labels/annotations）、YAML 派生快照、纯 YAML 提交路径、校验错误态、`{ok:false}` 不关 Modal
- store.addConfigMap/addSecret 签名扩展回归（旧参数路径行为不变）
- Modal Teleport 测试查 document.body（[[toolcall-detail-modal-done]] 教训）

## i18n

全部新文案走 zh/en 双语键（新命名空间 `component.createConfigModal.*` / `component.dataKeysEditor.*` / `component.kvRows.*`）；六项门禁自动拦截缺键/残存中文。

## Follow-ups（不在本次范围）

- 详情页数据区换装 DataKeysEditor（统一两套实现）
- CreateResourceDialog 死组件清理
- detectLang 详情页内联版换 util 引用
