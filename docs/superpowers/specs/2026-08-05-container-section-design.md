# 顶部统一「容器」区（创建流 + 编辑弹窗）

- 日期：2026-08-05
- 分支：`feat/container-volume-flow`（从 `main` @ 8b081b2 切出）
- 范围：`src/views/DeployApp.vue`（创建）、`src/views/NsWorkloadDetail.vue`（编辑弹窗）。
- 目标：把初始化容器与 sidecar 容器从「高级设置/末尾」提到顶部，与主容器合并为统一「容器」区，统一创建与编辑两处结构。

## 背景
当前主容器在表单最前，而 Init/Sidecar 在创建流被塞进折叠的「高级设置」、在编辑弹窗被放到最后一个区块，填写顺序不合理。

## 挂载逻辑（本次不动）
已逐行核实：`subPath` 在创建（`DeployApp.vue:307-327`）与编辑（`NsWorkloadDetail.vue:848-869`）两条路径都正确写入 YAML；`volumeMounts` 与 pod 级 `volumes`（emptyDir/PVC/hostPath/configMap/secret 五种）都生成、name 正确关联。**逻辑无 bug，本次不改**（待用户给出 subPath/挂载失效的具体复现再议）。

## 设计
纯模板调整（移动 + 分组），不改数据模型、不改 YAML 生成、不动挂载逻辑。Init/Sidecar 字段集合不变。

### DeployApp.vue（创建流，Step 2）
- 在 Step 2 顶部建统一「容器」区，含三块：主容器（现有镜像/command/args/workdir/资源表单，原样）+ 初始化容器列表 + Sidecar 容器列表。
- Init/Sidecar 从「高级设置」折叠区**移出**；高级设置只保留探针/安全上下文/生命周期。

### NsWorkloadDetail.vue（编辑弹窗）
- 把末尾的「多容器（Init / Sidecar）」卡上移，与「主容器」合并为一张「容器」卡，置于顶部（紧跟「基本配置」）。
- 卡内分三块：主容器 / 初始化容器 / Sidecar，块间用细分隔线。
- 其余卡片顺序不变。

## 不做（YAGNI）
- 不改挂载/subPath 逻辑（已验证正确）。
- 不改 Init/Sidecar 字段集合（仅改位置/分组）。
- 不动表单模型与 YAML 映射。

## 验证
- `npm run typecheck` + `npm run build` 通过。
- 人工（dev server，0.0.0.0）：创建流 Step 2 顶部见统一容器区（主+Init+Sidecar），高级设置里不再有 Init/Sidecar；编辑弹窗顶部「容器」卡含三块；Init/Sidecar 仍可增删且保存生效。
