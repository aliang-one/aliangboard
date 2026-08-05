# 工作负载创建/编辑表单校验

- 日期：2026-08-05
- 分支：`feat/container-volume-flow`
- 范围：`src/views/DeployApp.vue`（创建）、`src/views/NsWorkloadDetail.vue`（编辑）。

## 背景
创建可放过空卷挂载、缺镜像的 init/sidecar、空端口、缺 key 的环境变量；编辑弹窗 `saveEdit` 完全无校验。需系统性补齐。

## 现状审计
- DeployApp 仅有 `canProceed`（按步 gating：名称/命名空间/镜像/Service），不覆盖 卷/init/sidecar/端口/环境变量；最终 Deploy 未再校验。
- NsWorkloadDetail `saveEdit` 无任何前置校验。

## 设计
- 提交前 `validate()`（DeployApp `handleDeploy`）/ `validateEdit()`（NsWorkloadDetail `saveEdit`）：返回错误描述数组；非空则 `notify('error', '请修正：' + errs.join('；'))` 并中止。
- 规则（两处一致，按各自表单形状实现）：
  - 卷：每条须有 mountPath；pvc/configMap/secret 须有来源、hostPath 须有路径；全空 → 「空卷挂载，请填写或删除」。
  - Init/Sidecar：添加了须有 image。
  - 端口：每条须有 containerPort。
  - 环境变量：普通须有 key；ConfigMap/Secret 引用须有 ENV 名 + 资源名 + key。
  - 创建兜底：名称（正则）/命名空间/镜像。
- UX：block + notify 列举所有问题（具体到条目）。

## 不做（YAGNI）
行内红色高亮；资源量(cpu/mem)格式强校验（K8s 侧会拒）。

## 验证
typecheck + build 通过；人工：空卷/缺镜像 init/空端口/缺 key 环境变量 → 点部署/保存 → 被 notify 拦截且列出问题。
