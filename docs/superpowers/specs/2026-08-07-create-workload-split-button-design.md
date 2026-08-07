# 创建负载分割按钮（SplitButton）设计

**日期**: 2026-08-07
**状态**: 待实现
**范围**: 全局 `/workloads` 页与命名空间 `/ns/:namespace/workloads` 页的「创建负载」入口

## 1. 背景与目标

当前两个工作负载列表页的「创建」按钮都是普通跳转按钮，直接进入 `DeployApp.vue` 6 步向导（表单创建）。用户希望把「创建」按钮升级为**分割按钮**（主按钮 + 右侧下拉箭头）：

- **主按钮点击**（默认动作）：进入现有向导，网页表单创建（行为不变）。
- **右侧下拉箭头**：弹出菜单，提供两种额外的创建方式：
  1. **从 YAML 创建** —— 弹窗内置 YamlEditor，预填 Deployment 模板，编辑后直接 apply。
  2. **复制 workload** —— 选某个命名空间下的某个工作负载，将其「另存」到当前空间：仍走向导的全部创建步骤，只是各步骤已用源 workload 的内容预填好（best-effort）。

### 现状（探索结论）

- 创建入口：`src/views/Workloads.vue:115-118`（全局 "New Workload" → `/deploy`）、`src/views/NsWorkloads.vue:120-122`（命名空间 "新建" → `/ns/:namespace/deploy`）。两者均为 `router-link`，无下拉。
- 表单创建走 `DeployApp.vue`（表单 → 生成 YAML → `store.applyResourceYaml`）。
- YAML 创建底层已具备：`POST /api/apply`（`src/api/client.js:121`）、`store.applyResourceYaml`（`src/stores/cluster.js:3135-3170`）、`useResourceApply` composable、`YamlEditor` 组件（可查看/编辑）。缺独立入口。
- 复制 workload：**当前完全没有该功能**。底层能力齐全（`GET /api/k8s/...` 取详情、`exportYaml` 导出、`applyResourceYaml` 创建）。
- 分割按钮组件：仅有 `DropdownMenu`（纯菜单，用于行内「…」操作），**无** SplitButton。

## 2. 架构（方案 A）

新增 5 个文件 + 改动 3 个现有文件：

```
[Workloads.vue / NsWorkloads.vue]
  └─ <SplitButton label=新建 icon=rocket_launch>
       主按钮点击  → router.push('/deploy' 或 '/ns/:ns/deploy')   ← 现有向导,默认动作
       下拉菜单:
         · 从 YAML 创建   → 打开 <CreateFromYamlDialog>
         · 复制 workload  → 打开 <CopyWorkloadDialog>
```

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/components/common/SplitButton.vue` | 新增·通用 | 主按钮 + 右侧下拉箭头；主按钮执行默认动作，箭头展开菜单（items 同 `DropdownMenu` 的 `{label,icon,action,danger?,disabled?}`，复用点击外部 / ESC 关闭） |
| `src/components/common/CreateFromYamlDialog.vue` | 新增 | 弹窗内 `YamlEditor`，预填 Deployment 模板；「创建」→ `useResourceApply().applyYaml(yaml)` → 成功关弹窗 + 刷新列表 |
| `src/components/common/CopyWorkloadDialog.vue` | 新增 | 命名空间下拉 + workload 表（5 类型，同类型复制）；选中 → 拉取源详情 → 反向映射 → 种入 seed → 跳向导 |
| `src/composables/useWorkloadToForm.js` | 新增·纯函数 | `workloadToForm(object, kind)` 把源对象反向映射成向导表单（best-effort，不引 Vue，可被零依赖运行器测） |
| `src/composables/useCopySeed.js` | 新增·单例 | `setSeed/consumeSeed` 模块级 reactive 单例，把预填对象跨路由传给 `DeployApp` |
| `src/views/Workloads.vue` | 改 | 用 `SplitButton` 替换 "New Workload" 链接 |
| `src/views/NsWorkloads.vue` | 改 | 用 `SplitButton` 替换 "新建" 链接 |
| `src/views/DeployApp.vue` | 改（极小） | `onMounted` 调 `consumeSeed()`；有 seed 则初始化表单并清空 seed；无 seed 行为不变 |
| `src/locales/zh.json` / `en.json` | 改 | 新增菜单项/弹窗文案键 |

### 数据流

**从 YAML 创建**：SplitButton 菜单 → 开 `CreateFromYamlDialog` → 编辑 YAML（预填模板）→ `useResourceApply().applyYaml` → toast → 关弹窗 + 父组件刷新列表。

**复制 workload**：SplitButton 菜单 → 开 `CopyWorkloadDialog` → 选源 ns + workload → 拉源详情 → `workloadToForm` → `useCopySeed.setSeed` → `router.push(向导路由)` → `DeployApp` 挂载 → `consumeSeed` 初始化表单 → 用户过向导（默认全填好，改名/ns） → 现有 `handleDeploy` apply。

### 向导改动最小化

复制不侵入向导逻辑，只在挂载时读一次 seed。全局页复制时，向导 namespace 字段预填源的 namespace（用户改）；命名空间页复制时，namespace 预填当前页 ns。

## 3. 组件契约

### 3.1 `SplitButton.vue`

```
Props:
  label: string              // 主按钮文字
  icon?: string              // 主按钮图标（material symbol）
  mainAction: () => void     // 主按钮点击回调
  items: Array<{ label, icon?, action: () => void, danger?, disabled? }>  // 菜单项
  disabled?: boolean
行为:
  - 主按钮占主体宽度；右侧紧贴一条竖分隔线 + 小箭头按钮
  - 点主按钮 → mainAction()
  - 点箭头 → 切换菜单（绝对定位，复用 DropdownMenu 的展开/点击外部/ESC 关闭模式）
  - 选菜单项 → 调该项 action() 并关菜单
```

### 3.2 `CreateFromYamlDialog.vue`

```
Props:
  modelValue: boolean        // v-model 控制显隐
  namespace?: string         // 可选；实际 namespace 以 YAML 内 metadata.namespace 为准
内置:
  - YamlEditor（可编辑），初始值 = Deployment 模板（含 name/image/replicas 占位）
  - 取消 / 创建 按钮
行为:
  - 创建前先用 yamlLoadAll 解析；解析失败 → 内联报错，不打 API
  - 解析成功 → useResourceApply().applyYaml(yaml) → ok 则 emit('applied') + 关弹窗；失败 toast
Emit:
  update:modelValue, applied
```

### 3.3 `CopyWorkloadDialog.vue`

```
Props:
  modelValue: boolean
  defaultTargetNamespace?: string   // 命名空间页传当前 ns；全局页不传（目标由向导 ns 字段定）
状态:
  sourceNs: string          // 默认 = defaultTargetNamespace 或首个 ns
  workloads: []             // 当前 sourceNs 下的 workload 列表（5 类型合并）
  selected: null            // 选中的源 workload { type, name }
  loading: boolean
行为:
  - sourceNs 变化 → 拉该 ns 的 workload 列表（复用 store 列 workload 的能力；5 类型合并展示）
  - 表格列：名称 / 类型 / 副本 / 创建时间；单选一行
  - 确认 → 拉源详情（GET 对应 kind 的完整对象）→ workloadToForm(object, kind) → useCopySeed.setSeed({ form, type }) → router.push(向导路由) → 关弹窗
Emit:
  update:modelValue
```

### 3.4 `useWorkloadToForm.js`（纯函数）

```js
export function workloadToForm(object, kind)  // object: K8s 完整对象; kind: 'Deployment'|...
// 返回: 向导表单结构（与 DeployApp 的 form 字段对齐）
```

不导入 Vue，纯数据转换，可被 `scripts/test.mjs` 零依赖运行器测试。

### 3.5 `useCopySeed.js`（reactive 单例）

```js
export function useCopySeed()  // 返回 { setSeed(seed), consumeSeed(), hasSeed() }
// 模块级 ref 持有 seed；consumeSeed 取出并清空
```

## 4. 反向映射字段表

5 种 kind 容器 spec 路径不同（Deployment/STS/DS/Job 取 `spec.template.spec`；CronJob 取 `spec.jobTemplate.spec.template.spec`），但容器字段映射一致：

| 源字段 | → 向导表单字段 | 备注 |
|---|---|---|
| `kind` | `workloadType` | Deployment/StatefulSet/DaemonSet/Job/CronJob |
| `metadata.name` / `metadata.namespace` | `name` / `namespace` | 复制时 name 预填源名，提示改名 |
| `metadata.labels` / `metadata.annotations` | `labels` / `annotations` | 保留（剔除自动注入项如 `pod-template-hash`） |
| `spec.replicas`（STS 同） | `replicas` | DaemonSet 无；Job/CronJob 映射 `completions`/`parallelism` |
| `spec.schedule` / `spec.jobTemplate...`（CronJob） | CronJob 专属 | 容器路径多嵌一层 |
| `spec.template.spec.containers[0]` | 主容器块（`containerName`/`image`/`command`/`args`/`env`/`ports`/`resources`/探针） | 主容器映射完整字段 |
| `spec.template.spec.containers[1..]` | `extraContainers`（sidecar 数组） | sidecar 块只建模 `name`/`image`/`command`/`cpu-mem 请求限制`，其 env/ports/探针等丢弃 |
| `.image` / `.command` / `.args` | 主容器 `image` / `command` / `args` | 数组照搬 |
| `.env` / `.ports` | 主容器 `env` / `ports` | 保留 value/valueFrom |
| `.resources.{limits,requests}` | 主容器 `resources` | 照搬 |
| `.livenessProbe` / `.readinessProbe` | 主容器健康检查 | 照搬 |
| `spec.template.spec.initContainers[]` | `form.initContainers` 数组 | init 块只建模 `name`/`image`/`command`/`cpu-mem`，其余丢弃 |
| `spec.template.spec.volumes` + `.volumeMounts` | 存储卷 | 按 volumeMounts 配对 volumes；PVC/CM/Secret/HostPath/emptyDir/NFS 按向导支持类型映射 |
| `.nodeSelector` / `.tolerations` | 高级设置 | 照搬 |

### 边界（已知有损）

- **多容器**：主容器（`containers[0]`）映射完整字段；其余容器映射到 `extraContainers`（sidecar），但 sidecar 块只建模 name/image/command/cpu-mem，env/ports/探针等丢弃（seed 时若有丢弃记一条提示）。
- **initContainers**：向导已建模（映射到 `form.initContainers`），但同样只含 name/image/command/cpu-mem，其余丢弃。
- **高级字段**：复杂 affinity（非向导模型）、自定义 strategy、lifecycle hooks、securityContext 细节等不映射（best-effort）。

## 5. 错误处理

- YAML 创建弹窗：apply 前先 `yamlLoadAll` 解析，解析失败内联报错，不打 API。
- 复制弹窗：拉取源详情失败 → toast + 留在弹窗；源 ns 无 workload → 空状态文案。
- 名称冲突：预填源名；K8s apply 的 409 由现有 toast 兜底；向导顶部 seed 时显示「已从 <ns>/<name> 复制，请确认名称与命名空间」提示条。
- Mock 模式：复制弹窗源列表来自 store mock 数据（按 ns 暴露 mock workload 时可用）；源详情 mock 下从 store 取；不可用时降级 toast。YAML 创建 mock 下走 store mock apply。

## 6. 测试（遵循 CLAUDE.md 依赖政策）

- `workloadToForm` 纯函数、不引 Vue → `scripts/test.mjs` 零依赖运行器覆盖：完整 Deployment、最小 Deployment、StatefulSet（含 volumeClaimTemplates）、CronJob（嵌套路径）、多容器（验证只取首容器）、缺字段容错。
- SplitButton / 弹窗组件 → vitest + @vue/test-utils 冒烟测试（可选，优先保证纯逻辑覆盖）。
- 基线：`npm run typecheck`（`node --check`）、`npm run i18n:check` 门禁。

## 7. i18n

新增键：`component.createFromYaml.*`、`component.copyWorkload.*`、`ns.workloads.createFromYaml`、`ns.workloads.copyWorkload` 等（命名按现有 `{scope}.{feature}.{action}` 约定）。zh + en 双语；`npm run i18n:check` 作门禁。

## 8. 不做（YAGNI）

- 不做跨类型复制（Deployment 复制成 StatefulSet 等），仅同类型。
- 不做「复制」时的无损 YAML 叠加（用户已选 best-effort）。
- 不改 `CreateResourceDialog`（那是 Service/CM/Secret 等的简化创建弹窗，与本需求无关）。
- 不给其它资源页（Service/ConfigMap 等）加 SplitButton，仅两个负载页（后续可复用 SplitButton 扩展）。
