# 端口选择改造设计：Service targetPort 与 Ingress servicePort

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：Service 创建/编辑的 targetPort、Ingress 创建/编辑的 serviceName + servicePort

## 1. 背景与动机

K8s 中，Service 的 endpoint 端口（`targetPort`）一定指向其后端 Pod 实际监听的容器端口（`containerPort`）；Ingress 路由转发到的端口（`servicePort`）一定指向某个已存在 Service 暴露的端口（`service.spec.ports[].port`）。

当前面板这两处都采用**纯文本/数字输入框**，用户需要凭记忆手填，容易写错（端口号写错、命名端口拼错、引用了不存在的 service）。而面板实际上已经持有可用端口的数据来源（工作负载列表、Service 列表），只是没有接到表单上。

**目标**：把这两处端口填写从"手输"改为"可输可选（combobox）"——默认通过下拉从已知可用端口中选择，同时保留手输兜底以覆盖边界场景。

## 2. 目标与非目标

### 目标
- Service 的 `targetPort`：下拉候选 = 当前命名空间下所有工作负载暴露的 `containerPort`（聚合去重）。
- Ingress 的 `servicePort`：下拉候选 = 用户所选 Service 的 `spec.ports[].port`。
- Ingress 的 `serviceName`：下拉候选 = 当前命名空间下的 Service 列表。
- 以上三处均为**可输可选**：下拉引导为主，允许手输任意值兜底。

### 非目标（YAGNI，本次不做）
- 不按 Service `selector` 精确匹配工作负载来筛选 targetPort 候选（候选与 selector 无关）。
- 不新增 Gateway API（HTTPRoute/Gateway）支持——本次"gateway"即指现有 Ingress。
- 不改造端口转发（port-forward）等其他功能里的端口输入。
- 不引入端口存在性强校验（可输可选下不阻断提交）。

## 3. 现状摸底

### Service 端口表单（4 处，targetPort 均为手输 input）
| 文件 | 位置 | 说明 |
|---|---|---|
| `src/views/NsServices.vue` | 创建弹窗端口行 | `port` 数字 input / `targetPort` 文本 input / `protocol` select / `nodePort` input |
| `src/views/NsServiceDetail.vue` | 编辑弹窗端口行 | 同上结构 |
| `src/views/DeployApp.vue` | 部署向导 Step5 | 同上；已有一段"容器端口可填入 targetPort"的纯文字提示，但仍需手输 |
| `src/components/common/CreateResourceDialog.vue` | 快速创建 | `port`/`targetPort` 数字 input |

### Ingress 转发表单（2 处，serviceName/servicePort 均为手输 input）
| 文件 | 位置 |
|---|---|
| `src/views/NsIngress.vue` | 创建表单 `serviceName`/`servicePort` |
| `src/views/NsIngressDetail.vue` | 编辑路由规则表格 `serviceName`/`servicePort` |

### 可复用的现有数据
- `store.nsWorkloads`：当前 ns 工作负载列表（已水合，含 `raw` 原始对象）。
- `store.nsServices`：当前 ns Service 列表。
- `store.getServiceByName(name, ns)` → 返回对象的 `.portList`：结构化端口数组 `{name, port, targetPort, protocol, nodePort, appProtocol}`（`cluster.js` `mapService` 已生成）。
- 工作负载的 `containerPort` 当前**未在 store 层提取**，需从 `workload.raw.spec.template.spec.containers[].ports[].containerPort` 解析（`NsWorkloadDetail.vue:600` 已有可参考的提取逻辑）。
- 组件先例：`src/components/common/TagInput.vue` 已实现"input + 下拉建议浮层"模式，浮层样式（`TagInput.vue:103`）可直接参考。

### YAML 生成层
`generateYAML('service', ...)`（`cluster.js:2189`）与 `generateYAML('ingress', ...)`（`cluster.js:2234`）已支持数字与字符串型 `targetPort` / `servicePort`，本次产出值（下拉数字或手输命名端口字符串）直接兼容，**无需改动**。

## 4. 设计

### 4.1 新增 `src/components/common/PortSelect.vue`（combobox）

通用端口选择器，可输可选。

- **形态**：`<input>` 输入框 + 聚焦时弹出下拉建议浮层。
- **行为**：
  - 下拉项点击即填入 input 并 `emit('update:modelValue', value)`。
  - 用户可在 input 直接键入任意值（兜底命名端口/跨 ns/无候选场景），输入同样 `emit` 更新。
  - 输入时对候选做模糊过滤。
- **props**：
  - `modelValue`：`string | number`（v-model）
  - `options`：`Array<number>` 或 `Array<{label, value}>`（`{label,value}` 用于带附加说明，如"8080 (来自 my-deploy)"）
  - `placeholder`：`string`
  - `emptyHint`：候选为空时浮层内的说明文案（可选）
- **候选为空**：浮层不弹出（或仅显示 `emptyHint` 文案），input 仍可正常输入——**不禁用、不阻断**。
- **样式**：复用现有 input 的 class；浮层参考 `TagInput.vue:103` 的 `absolute z-30 ... bg-surface-container-lowest border ...` 样式，保持视觉一致。

### 4.2 新增 `store.nsContainerPorts`（computed）

在 `src/stores/cluster.js` 增加：

```js
const nsContainerPorts = computed(() => {
  if (!currentNamespace.value) return []
  const set = new Set()
  for (const w of nsWorkloads.value) {
    const containers = w.raw?.spec?.template?.spec?.containers || []
    for (const c of containers) {
      for (const p of c.ports || []) {
        if (p.containerPort != null) set.add(p.containerPort)
      }
    }
  }
  return [...set].sort((a, b) => a - b)
})
```

并在 store 返回值中导出 `nsContainerPorts`。

### 4.3 改造点（6 处）

#### Service targetPort → `PortSelect`

| 文件 | `options` 来源 | 备注 |
|---|---|---|
| `NsServices.vue` 创建 | `store.nsContainerPorts` | `v-model` 绑定 `p.targetPort` |
| `NsServiceDetail.vue` 编辑 | `store.nsContainerPorts` | 同上 |
| `DeployApp.vue` Step5 | 本地 `form.ports` 中已填的 `containerPort`（去重） | 替换现有那段纯文字提示 |
| `CreateResourceDialog.vue` | `store.nsContainerPorts` | |

各处只替换 `targetPort` 那一个 input 为 `<PortSelect>`，`port`/`protocol`/`nodePort` 不变。

#### Ingress serviceName + servicePort → 可输可选

| 文件 | serviceName | servicePort |
|---|---|---|
| `NsIngress.vue` 创建 | input + 当前 ns service 名建议（`store.nsServices` 取 name） | `PortSelect`，options = 选中 service 的 `portList[].port` |
| `NsIngressDetail.vue` 编辑 | 同上，回填现有 rule 的 serviceName | 同上，按现有 serviceName 带出端口候选 |

- `serviceName` 的可输可选可用原生 `<input list>` + `<datalist>`（最简），或复用 `PortSelect` 同款浮层。实现时择一，保证与端口选择器交互一致。**推荐用 PortSelect 同款浮层**以保持 UI 统一；若时间紧可用 datalist。
- 选中 service 的端口候选通过 `store.getServiceByName(serviceName, ns)?.portList` 计算。

### 4.4 联动逻辑

- **Ingress servicePort 候选随 serviceName 变化**：`watch(serviceName)` 重算 `PortSelect` 的 `options`。
  - 当前已填的 `servicePort` 若不在新候选中：**不清空**（可输可选下保留用户已填值更友好，例如手输的跨 ns 端口），仅更新候选列表。
- **Service targetPort 候选与 selector 无关**：始终为当前 ns 全部 containerPort 聚合，不监听 selector。

### 4.5 数据/YAML 层

无需改动。`generateYAML` 已兼容数字与字符串型端口值。

## 5. 边界情况（可输可选下全部自然兜底）

| 场景 | 处理 |
|---|---|
| 当前 ns 无工作负载暴露端口 | targetPort 候选为空，浮层不弹出，用户手输兜底 |
| 命名端口（targetPort 为字符串名，如 `http`） | 手输字符串兜底，`generateYAML` 原样保留 |
| Ingress 转发的 service 不在当前 ns 或尚未创建 | serviceName 手输兜底，servicePort 手输兜底 |
| ExternalName 类型 Service | 本就无需 targetPort，维持隐藏，不受影响 |

## 6. 测试考虑

- **单元/逻辑**：`nsContainerPorts` 正确聚合多工作负载、多容器、多端口的 containerPort 并去重升序。
- **组件**：`PortSelect` 点击候选项填入、手输更新、候选为空仍可输入、输入过滤候选。
- **集成（手动）**：
  - Service 创建：从下拉选 containerPort 作为 targetPort → 创建成功 → endpoint 端口正确。
  - Service 创建：手输命名端口 → YAML 正确含字符串 targetPort。
  - Ingress 创建：选 service → servicePort 候选切换 → 创建成功 → 路由转发端口正确。
  - Ingress 编辑：回填现有 rule 的 serviceName/servicePort，候选正确带出。

## 7. 涉及文件清单

**新增**
- `src/components/common/PortSelect.vue`

**修改**
- `src/stores/cluster.js`（新增 `nsContainerPorts` computed + 导出）
- `src/views/NsServices.vue`
- `src/views/NsServiceDetail.vue`
- `src/views/DeployApp.vue`
- `src/components/common/CreateResourceDialog.vue`
- `src/views/NsIngress.vue`
- `src/views/NsIngressDetail.vue`
