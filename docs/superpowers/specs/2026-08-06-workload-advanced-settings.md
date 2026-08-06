# 工作负载创建/编辑——高级设置扩展

- 日期：2026-08-06
- 分支：`feat/workload-advanced`（从 `main` @ 65a3868 切出）
- 范围：`src/views/DeployApp.vue`（创建向导 Step 4）、`src/views/NsWorkloadDetail.vue`（编辑弹窗）。

## 背景
Step 4「调度与更新策略」现有 strategy/nodeSelector/tolerations/priorityClass。用户要扩展为「高级设置」，加 Pod 安全上下文、DNS、主机别名、主机网络、Pod 亲和/反亲和。serviceAccount 从 Step 2 移入。

## 新增功能（spec.template.spec.* 生成）
### a. Pod 安全上下文 (`spec.securityContext`)
- runAsUser, runAsGroup, fsGroup (数字), runAsNonRoot (bool), seccompProfile (select: 空/RuntimeDefault/Unconfined)
### b. DNS (`dnsPolicy` + `dnsConfig`)
- dnsPolicy: 空/ClusterFirst/Default/None/ClusterFirstWithHostNet
- dnsConfig: nameservers[] (≤3), searches[], options[]({name, value})
### c. 主机别名 (`hostAliases`)
- [{ip, hostnames}]（hostnames 逗号分隔→数组）
### d. 主机网络 (`hostNetwork`/`hostPID`/`hostIPC`)
- 3 个 bool 开关
### e. Pod 亲和/反亲和 (`affinity`)
- 简化：enabled/type(affinity|anti-affinity)/topologyKey(默认 hostname)/labelKey/labelValue/strength(required|preferred)
- 生成 preferredDuringScheduling 或 requiredDuringScheduling（按 type + strength）
### f. ServiceAccount 移入 Step 4
- 从 Step 2 移到 Step 4（serviceAccountName/imagePullSecrets）

## 不做（YAGNI）
supplementalGroups/sysctls/seLinuxOptions；matchExpressions 复杂选择器；required+preferred 同时。

## 验证
typecheck + build 通过；人工：创建向导 Step 4 + 编辑弹窗 均可设置上述字段并正确生成/回填 YAML。
