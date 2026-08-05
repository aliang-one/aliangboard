# HPA 创建与管理优化

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：HPA 创建表单下拉化 + 编辑加 memoryTarget + updateHPA 改 merge-patch

## 1. 现状问题

| 位置 | 问题 |
|---|---|
| 创建（NsHPA.vue）| targetName 纯文本输入 → 应下拉选 workload；targetKind 硬编码 → 应下拉；缺 memoryTarget；无校验 |
| 编辑（NsHPADetail.vue）| 仅 min/max/cpuTarget → 缺 memoryTarget |
| store updateHPA | 走 generateYAML 全量替换 → 应 merge-patch |

## 2. 设计

### 2.1 创建表单（NsHPA.vue）
- targetKind → `<select>`（Deployment/StatefulSet/DaemonSet）
- targetName → `<select>`（跟随 targetKind 过滤 nsWorkloads）
- memoryTarget → `<input type="number">`（与 cpuTarget 并排）
- handleCreate 加 memoryTarget: parseInt(f.memoryTarget)
- Save disabled 当 min > max 或 targetName 空

### 2.2 编辑表单（NsHPADetail.vue）
- openEdit 加 memoryTarget 回填
- 模板加 memoryTarget input
- saveEdit 加 memoryTarget

### 2.3 store updateHPA 改 merge-patch
- 构造 patch `{ spec: { minReplicas, maxReplicas, metrics: [{type:Resource,resource:{name:cpu,target:{type:Utilization,averageUtilization}}, {name:memory,...}] } }`
- 用 remotePatch → PATCH application/merge-patch+json
- 复用既有 remotePatch helper

## 3. 涉及文件
- `src/views/NsHPA.vue`
- `src/views/NsHPADetail.vue`
- `src/stores/cluster.js`（updateHPA）
