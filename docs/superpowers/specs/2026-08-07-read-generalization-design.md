# 读通用化(path-based)设计

- 日期:2026-08-07
- 分支:`feat/read-generalization`(worktree `.claude/worktrees/read-gen`,从 `main` `2eb878a`)
- 状态:APPROVED(brainstorm 2026-08-07)
- 关联:资源操作完备性 B 的第一子项(读);[[apikey-mcp-agent-base]]

## 背景

当前读工具 `list_resources`/`get_resource` 硬编码 6 个 kind(pods/services/configmaps/deployments/statefulsets/daemonsets)的 `LIST_PATH`/`GET_PATH` 映射,**列/取不到** ingresses、secrets、networkpolicies、PVCs、RBAC 等常见资源,更不含 CRD。写侧已通用(`apply_yaml` 任意 kind SSA + `delete_resource` 任意 path DELETE)——读侧是明显短板。`get_resource_yaml` 名字早已在 `BOUNDED_TOOLS` 但未实现(phantom,调则「未知工具」)。

本 spec:path-based 读通用化(对齐 `delete_resource` 的 path 范式),让 AI 能看任意 namespaced 资源。

## 范围(已确认)

**做:**
1. 新工具 `get_resource_yaml`(path-based GET,返 YAML)。
2. `list_resources` 加可选 `path`(path 优先;`kind` 快捷向后兼容)。
3. 共享 `assertPathInNs` helper;收紧 `delete_resource` 的 path-ns(policy 漏洞加固)。

**不做(延后,各自独立 spec):** `can_i`(另一 phantom)、`patch_resource`(字段级写)、跨 ns allowlist、discovery-based kind 解析、集群级资源读取。

## 关键决策

### A. path-based(对齐 delete_resource),非 discovery / 非扩展硬编码

`get_resource_yaml({namespace,path})` + `list_resources({...,path?})` 都吃 K8s path。最大化通用(任意 apiGroup + CRD),零新 discovery 机制,与 `delete_resource`(AI 已用 path)一致。AI 对常见 kind 知道 path;list 结果回带每项 `path`,链式 get 无需记 path。

### B. ns 作用域按 path 解析收紧

`delete_resource` 现状:`runBoundedTool` 校验 `namespace` ARG === `boundSA_namespace`,但 `path` 直接用——若 AI 传 `namespace=boundNS` + `path=他NS/...`,policy 放行(RBAC 兜底)。这是 policy 层的 path-ns 漏洞。

新工具 + 收紧后的 delete:抽 `assertPathInNs(path, boundNs)`,解析 path 的 `/namespaces/<x>/`,强制 `<x>===boundNs`;集群级 path(无 `/namespaces/`,如 PV/Node/ClusterRole)或他 ns → policy 拒。ns-bound key = ns-scoped。

### C. YAML 输出 + 有界

`get_resource_yaml` 返 `{yaml}`(js-yaml `dump`,去 managedFields);YAML 截 32KB + `truncated`(对齐 `get_pod_logs` 纪律,防大 ConfigMap 撑爆 token)。附 `{kind,name,apiVersion}` 速览。

## 架构

### 1. `get_resource_yaml`(read 档,requiresApproval false)

args `{namespace, path}`。fn:
- `assertPathInNs(path, keyRow.boundSA_namespace)`。
- `GET path` → body;`delete body.metadata?.managedFields`(去噪)。
- `yaml = dump(body)`(js-yaml);`Buffer.byteLength(yaml)` > 32KB → 截 + `truncated`。
- return `{ kind: body.kind, name: body.metadata?.name, apiVersion: body.apiVersion, yaml, truncated, originalBytes }`。

`get_resource_yaml` 已在 `BOUNDED_TOOLS`(read 档自动含)——只需实现 `api-key-tools` 的 tool 方法 + `tool-registry` 条目,**不改 authorize**。`minTier: 'read'`, `requiresApproval: false`。

### 2. `list_resources` 泛化(加 path)

args `{namespace, kind?, path?}`。fn:
- **path 优先**:`if (a.path)` → `assertPathInNs(a.path, boundNs)`;`GET a.path` → `items = body?.items || []`;`slim = items.slice(0, LIST_MAX).map(it => ({ name: it.metadata?.name, kind: it.kind, apiVersion: it.apiVersion, path: \`${a.path}/${it.metadata?.name}\` }))`;return `{ kind: '(path)', count: items.length, returned: slim.length, items: slim }`。
- **kind 快捷**(无 path):走现有 `LIST_PATH` 6-kind 映射(逻辑不变,向后兼容)。

`tool-registry` 的 `list_resources` 描述更新:提及 `path` 可列任意 kind(给 list 端点,如 `/apis/networking.k8s.io/v1/namespaces/ns/ingresses`)。

### 3. `assertPathInNs` + delete 收紧

- helper(放 `api-key-tools.mjs`,与 `safePodPath` 同区):
  ```js
  function assertPathInNs(path, ns) {
    const m = String(path || '').match(/\/namespaces\/([^/]+)\//)
    if (!m) throw new PermissionDeniedError('policy', { detail: `path 非命名空间资源(集群级),ns 绑定 key 不允许: ${String(path).slice(0, 80)}` })
    if (m[1] !== ns) throw new PermissionDeniedError('policy', { detail: `path 命名空间 ${m[1]} 超出绑定 ns ${ns}` })
  }
  ```
- `delete_resource` fn 内首行加 `assertPathInNs(a.path, keyRow.boundSA_namespace)`(现有测试 path 与 ns 一致 → 不破)。

## 数据流

```
AI → callTool(get_resource_yaml | list_resources(path), {path})
  → runBoundedTool(namespace arg 校验 === boundSA_namespace)
  → fn: assertPathInNs(path, boundNs)  // 再校验 path 的 ns,关 policy 漏洞
  → requestFn(GET path) → 返(YAML / slim 项含 path)
```
双重 ns 校验(arg + path 解析),policy 层真闭环。

## 错误处理

- path 缺 / 非法 → 报错(提示给完整 K8s path)。
- 集群级 / 他 ns path → `assertPathInNs` throw → `runBoundedTool` catch → 审计 error,返 PERMISSION_DENIED(policy)。
- 资源不存在 → apiserver 404 → requestFn throw → 审计 error,端点返 404。
- YAML 超 32KB → 截断 + `truncated`(AI 知道截了,可缩小范围重试或接受)。
- list path 误传单资源 path(非 list)→ `items` 空(或 body 非 list 结构)→ 返 count 0 + 不抛。

## 测试

- `assertPathInNs`(纯函数):集群级(无 /namespaces/)→ throw;他 ns → throw;合法 → 通过。
- `get_resource_yaml`(stub requestFn):返 yaml 含 `kind:`、managedFields 已去;大对象截 32KB + `truncated`;path ns 不符/集群级 → policy 拒;read 档可调(operator 亦可)。
- `list_resources`(path):stub 返 list → slim 项含 `path`(=`${listPath}/${name}`);path ns 不符 → 拒;kind 快捷既有用例回归。
- `delete_resource`(收紧):既有用例(同 ns path)仍绿 + 新增他 ns path → policy 拒。

## 非目标(再确认)

`can_i` / `patch_resource` / 跨 ns / discovery-based kind→path / 集群级资源读取(ns-bound key 不支持)/ 改动既有 `get_resource`(kind-based,保留)。
