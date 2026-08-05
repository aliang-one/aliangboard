# 环境变量 ConfigMap/Secret 来源选择器（编辑 + 创建流）

- 日期：2026-08-05
- 分支：`feat/env-source-picker`（从 `main` @ 0005057 切出）
- 范围：编辑弹窗（`NsWorkloadDetail.vue`）与创建流（`DeployApp.vue`）的环境变量 ConfigMap/Secret 引用编辑，含 `envFrom`。

## 背景
当前编辑 Deployment 时，引用 ConfigMap/Secret 的环境变量需手输资源名 + key（编辑弹窗全是文本框；创建流的资源名是 `<select>` 但 key 仍手输），不友好且易错。

## 目标
把「资源名 + key」改成**可选可输**（select-or-type）：下拉列出当前命名空间下的 ConfigMap/Secret 及其 `data` 的 key，用户可点选，也可继续手输（资源尚未创建/跨命名空间场景）。

## 设计

### 新组件 `src/components/common/EnvSourceField.vue`
- Props：`kind`（`'configmap' | 'secret'`）、`namespace`（string）、`withKey`（boolean，默认 `true`）。
- 双 v-model：`name`（`v-model:name`）、`key`（`v-model:key`）。
- 渲染（原生 `<input>` + `<datalist>`，零新依赖）：
  - **资源名**输入 + `<datalist>`：候选 = 该 namespace 下的 ConfigMap（或 Secret）名。
  - 当 `withKey`：**key** 输入 + `<datalist>`：候选 = 所选资源的 `data` 键（随 `name` 变化重算；未选/未知资源时候选为空，但仍可手输）。
- 每个实例的 `<datalist id>` 需唯一（用 Vue 3.5 `useId()`）。
- 降级：列表未加载 → datalist 为空，输入框仍接受手输（永不阻塞）。

### 集成（保留 `ENV名` 文本输入不变）
- `NsWorkloadDetail.vue` 编辑弹窗：
  - ConfigMap key 引用行：`ENV名` 输入 + `<EnvSourceField kind="configmap" v-model:name="e.cmName" v-model:key="e.key" :namespace="..." />`
  - Secret key 引用行：同上 `kind="secret"`、`v-model:name="e.secretName"`。
  - `envFrom` ConfigMap：`<EnvSourceField kind="configmap" :with-key="false" v-model:name="editForm.envFromConfigMap" />`
  - `envFrom` Secret：`kind="secret" :with-key="false" v-model:name="editForm.envFromSecret"`。
- `DeployApp.vue` 创建表单：同样替换（统一掉现有「名 select + key 手输」的半改进状态）。
- 表单模型与 YAML 映射（`NsWorkloadDetail.vue` ~835-843、`DeployApp.vue` 对应处）**不变**——组件填入同名字段。

### 数据来源
- 组件内用 `store.configMapList` / `store.secretList`（全量）按 `namespace` prop 过滤得到候选资源；key 取自匹配资源的 `data` 键。
- 不依赖 `currentNamespace`，由父组件显式传 namespace（路由参数），更稳。

## 不做（YAGNI）
- 不自动用 key 回填 ENV 名（行为易出乎意料）。
- 不做跨命名空间浏览。
- 不新建自定义下拉组件（datalist 足够）。

## 验证
- `npm run typecheck` + `npm run build` 通过。
- 人工（dev server，0.0.0.0 暴露）：编辑弹窗与创建流里，资源名/key 可下拉选也可手输；envFrom 只选资源名；选不同 ConfigMap 时 key 候选随之变化；资源列表为空时仍可手输。
