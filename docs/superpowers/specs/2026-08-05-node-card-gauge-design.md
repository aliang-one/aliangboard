# Cluster Overview 节点卡片——紧凑仪表盘式重设计

- 日期：2026-08-05
- 分支：`feat/node-card-gauge`（从 `main` @ 8c3c22b 切出）
- 范围：仅 `src/views/ClusterOverview.vue` 的 Node Health 卡片。
- 目标：卡片更小、更形象生动。

## 背景
当前概览节点卡片信息密、纵向高（约 8 行：角色/名称/IP/OS·arch/kubelet·runtime/CPU 行/Mem 行/pods·sched/chips）。用户要更小 + 更形象生动。

## 设计（方向 A：仪表盘式）
- 网格 2 列 → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`（卡片变小，大屏 3 列）。
- 卡片改为横向：左侧 CPU 环形表盘，右侧精简信息。
  - **CPU 环形表盘**（内联 SVG，~56px）：弧形填充 = CPU%，中心大字 `52%` + 小字 `CPU`。颜色阈值沿用 `ProgressBar` 的 `barColor`：`>80 error / >60 tertiary-container / 其余 primary`；`cpu==null` → 灰环 + `—`，弧填充 0。
  - **状态光晕图标**：`dns` 图标方块，Ready → `primary` 底色 + `ring-primary/30` 柔光；NotReady → `error` 底色 + `ring-error/30`。替代原来的 2px 状态点。
  - **身份行**：图标 + 名称（truncate）+ 角色 chip。
  - **状态行**：`● Ready/NotReady` + IP（mono）；任意压力条件（Disk/Mem/PID）合并为**一个** `warning` 小图标（带 title）。
  - **底栏**：Mem 迷你条 + `%`（null→灰条）· Pod 数（图标+n）· 污点（图标+n，有才显示）。

## 信息再分配（无丢失）
概览卡变成「健康一眼看」。从概览卡移除的字段：kubelet 版本、OS 镜像、arch、runtime、external IP、CPU/Mem 绝对用量。这些已在 **节点列表**（完整列）与 **节点详情** 页保留。列表/详情页本次不动。

## 技术与约束
- 纯内联 SVG + Tailwind，**不新增依赖**。单文件 `ClusterOverview.vue`。
- 卡片不再显示绝对 CPU/Mem → 移除该视图对 `formatCpu`/`formatMem` 的 import（确认本文件无其它用处）。`StatusChip` 不再用于本卡 → 移除其 import。`ProgressBar` 仍用于 Mem 条 → 保留。
- SVG 圆环用 `pathLength="100"` + `stroke-dasharray="${cpu} 100"` 实现百分比弧。
- 降级：NotReady（cpu/memory null）→ 灰环 `—` + 灰 Mem 条 + 红 `error` 光晕。

## 不做（YAGNI）
- 不改节点列表 / 节点详情。
- 不引入图表库或新组件文件（表盘内联即可，不抽组件）。
- 不改数据层 / mock（字段已齐）。
