# 节点信息丰富化设计 — Cluster Overview / 节点列表 / 节点详情

- 日期：2026-08-05
- 分支：`feat/node-rich-info`（从 `main` @ 6f7304f 切出）
- 范围：三页统一升级 —— `ClusterOverview.vue`、`Nodes.vue`、`NodeDetail.vue`
- 目标：在集群管理里展示更丰富的节点信息并美化，覆盖四类信息：角色与地址、系统与运行时、调度与健康、资源与负载。

## 背景与现状

Cluster Overview 的「Node Health」网格当前每张卡片只显示：名称、状态点、CPU%、内存%、状态芯片、kubelet 版本。而 store 的 `mapNode()` 已经映射了 `roles/ip/os/kernel/age/unschedulable/conditions/usedCpu/allocCpu/usedMem/allocMem` 等字段，卡片却没用。K8s Node 对象里还有 `containerRuntimeVersion / architecture / operatingSystem / spec.taints / capacity.pods / ExternalIP` 等字段完全没映射。

节点列表（`Nodes.vue`）列稀疏（Name/Status/Role/CPU/Memory/Version/Age/Actions）。节点详情（`NodeDetail.vue`）的 System Info 面板字段也偏少，且没有 Taints 信息。

## 非目标（YAGNI）

- 不新增任何后端 API —— 数据全部来自既有 `/api/v1/nodes` + 已有 `podList`。
- 不做单节点历史 sparkline —— metrics-server 无 per-node 历史。
- 不展示 machine/boot/system UUID —— 噪音信息。
- 不改动 cordon/uncordon/drain 逻辑。
- 不引入新设计体系 —— 全部复用现有 Material 3 tokens 与 Tailwind 间距。

## 数据层（地基）：`src/stores/cluster.js`

### 扩展 `mapNode(item, metric)` 返回字段

新增（取自 K8s Node 对象）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `externalIp` | `status.addresses` 中 `type==='ExternalIP'` | 无则 `null` |
| `containerRuntime` | `status.nodeInfo.containerRuntimeVersion` | 原始值，如 `containerd://1.6.x` |
| `containerRuntimeShort` | 同上去前缀 | `containerd 1.6.x`（去掉 `xxx://`） |
| `arch` | `status.nodeInfo.architecture` | `amd64` / `arm64` |
| `osType` | `status.nodeInfo.operatingSystem` | `linux` / `windows` |
| `taints` | `spec.taints` | 归一化数组（`{key,value,effect}`）；无则 `[]` |
| `taintCount` | `taints.length` | 用于芯片 |
| `podCapacity` | `status.capacity.pods` | 数值 |
| `podAllocatable` | `status.allocatable.pods` | 数值 |
| `podCIDR` | `spec.podCIDR` | 无则 `null`，详情页展示 |

保留现有全部字段不变：`name/status/roles/version/os/kernel/ip/age/unschedulable/conditions/cpu/memory/usedCpu/allocCpu/usedMem/allocMem`。

### `podCount` 回填

`mapNode` 单节点拿不到 pods，因此在 store 的节点 + Pod 加载流程末尾，按 `pod.node === nodeName` 计数并写回每个节点的 `podCount`。集中一处计算，三个页面共享，避免各自 filter。需确认 `mapPod` 已设 `node` 字段（现状 NodeDetail 用 `p.node` 过滤，说明已设）。

### 复用 formatter

`formatCpu` / `formatMem` 已从 `@/stores/cluster` 导出，三页直接复用，不再新建。runtime/taint 的展示格式化放组件内联即可。

## 页面一：Cluster Overview 节点区（`src/views/ClusterOverview.vue`）

布局：`md:grid-cols-3` → `md:grid-cols-2`（卡片更宽更高，承载更多信息）。仍显示前 6 个节点（3 行 × 2），保留 "View all nodes" 链接。

每张卡片结构（自上而下）：

1. **头部行**：左 = 角色徽标（`master`/`worker`/`etcd`，沿用现有 chip 样式）；右 = 状态点（Ready 绿 / NotReady 红，沿用 `animate-pulse-status`）。
2. **名称**：加粗、`truncate`。
3. **一行**：内网 IP（mono、primary 色） · OS 镜像（如 `Ubuntu 22.04`）。外网 IP 若存在则紧随其后小字。
4. **一行**：`kubelet vX` · `containerRuntimeShort`（如 `containerd 1.6.x`）。
5. **CPU 行**：`CPU` 标签 + `formatCpu(usedCpu)/formatCpu(allocCpu)` + `ProgressBar` + `%`。
6. **内存行**：`Memory` 标签 + `formatMem(usedMem)/formatMem(allocMem)` + `ProgressBar` + `%`。
7. **底部**：`{podCount} pods` · `Schedulable` / `Cordoned`（cordoned 用 tertiary/error 色提示）。
8. **芯片行**：`[Ready]` 绿；`DiskPressure`/`MemoryPressure`/`PIDPressure` 为真时红字警告芯片；`taintCount>0` 时显示 `{n} taints` 芯片。

降级：metrics 不可用时（`node.cpu == null`），CPU/内存行显示 `—`（沿用 NodeDetail 模式）。

## 页面二：节点列表（`src/views/Nodes.vue` + `src/composables/useTableColumns.js`）

列总数保持 8，**把稀疏的 `version` 列升级为更丰富的 `system` 列**，并新增 `pods` 列，污点折进 status，避免列膨胀。所有列经 catalog 自动可在 Settings 勾选隐藏。

最终列：

1. **Node**（slot `name`）：名称 + 内网IP + 角色芯片 + 外网IP（小字）。
2. **Status**（slot `status`）：Ready/NotReady `StatusChip` + 压力警告小芯片（Disk/Mem/PID pressure 为真）+ 污点芯片。
3. **System**（slot `system`，升级自 `version`）：第一行 OS 镜像；第二行 `kubelet vX · {runtimeShort} · {arch}`。
4. **CPU**（slot `cpu`）：`ProgressBar` + 下方 `formatCpu(used)/formatCpu(alloc)` + `%`。
5. **Memory**（slot `memory`）：`ProgressBar` + 下方 `formatMem(used)/formatMem(alloc)` + `%`。
6. **Pods**（slot `pods`，新）：`{podCount}`（必要时 `/{podCapacity}`）。
7. **Age**：不变。
8. **Actions**：不变（cordon/uncordon/drain）。

catalog 改动：将 `{ key: 'version', label: 'Version' }` 改为 `{ key: 'system', label: 'System' }`，并在 `actions` 前插入 `{ key: 'pods', label: 'Pods' }`。注意 localStorage 持久化里若用户曾隐藏过 `version`，重命名为 `system` 后视为新列（缺省显示），可接受。

## 页面三：节点详情（`src/views/NodeDetail.vue`）

- **头部**：加角色芯片 + 架构 + 运行时短名（现有 `os · kernel` 行旁边）。
- **System Info 面板**：在现有 OS/Kernel/Kubelet/Role/Internal IP/Age/Pods/Schedulable 基础上新增行 —— Container Runtime、Architecture、OS Type（linux/windows）、External IP、Pod CIDR（`spec.podCIDR`，需 `mapNode` 顺手映射 `podCIDR`）。
- **Resource Usage 卡片**：CPU/内存之外新增第三个指标 **Pods**，与 CPU/内存同款 `ProgressBar`（`podCount/podCapacity` 百分比）+ 下方 `{podCount} / {podCapacity}` 文本。
- **新增 Taints 卡片**（System Info 旁，`lg:col-span-4` 列内）：列出每个 taint 的 `key=value:effect`，无则 "No taints"。

`mapNode` 需补映射 `podCIDR = item.spec?.podCIDR || null`。

## Mock 数据（`src/mock/cluster.js`）

给 mock 节点补齐新字段，保证无集群也能演示全部新信息：`containerRuntime`、`arch`（混入一个 arm64）、`osType`、`taints`（给一两个节点加污点）、`externalIp`、`podCapacity`，并让 mock pod 的 `node` 分布合理以体现 `podCount`。

## 验证

- Mock 模式启动 dev server，逐页确认：
  - Overview 卡片 2 列、信息齐全、metrics 缺失时降级 `—`。
  - 节点列表 8 列、新列正确、可勾选隐藏。
  - 节点详情 System Info 新行、Taints 卡片、Pods 指标。
- cordon/uncordon/drain 行为不受影响（回归）。
- 响应式：移动端 1 列，md+ 2 列（Overview）。

## 受影响文件

- `src/stores/cluster.js` —— `mapNode` 扩展 + `podCount` 回填 + `podCIDR`。
- `src/views/ClusterOverview.vue` —— 节点卡片重构。
- `src/views/Nodes.vue` —— slot 丰富 + 新 slot。
- `src/composables/useTableColumns.js` —— catalog 列调整。
- `src/views/NodeDetail.vue` —— 头部/System Info/Taints/Pods 指标。
- `src/mock/cluster.js` —— mock 节点补字段。
