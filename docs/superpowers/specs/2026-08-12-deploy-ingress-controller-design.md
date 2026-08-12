# 部署 Ingress 控制器(预设模板)设计

> 状态:已与用户确认方向、范围、清单来源。待写实现计划。
> 日期:2026-08-12。分支:`worktree-feat+next`。

## 1. 背景与动机

平台创建 Ingress 时,「IngressClass 下拉」只列集群**真实存在**的类(2026-08-12 修复:原先硬编码 nginx/traefik/kong 等假类)。用户反馈「一个 nginx ingressclass 有时不够用」,希望能**在平台内直接部署新的 ingress 控制器**(traefik / haproxy / kong 等),装完后新类真实可用、出现在下拉里。

注意:本功能**不是**「ingress 创建模板」(给*已装好*的控制器快速建 ingress),而是**部署控制器本身**。两者可叠加,但本 spec 只覆盖后者。

## 2. K8s 流程科普(澄清过的认知)

- `IngressClass` 本身只是个**指针资源**,仅一个 `spec.controller: <控制器名>` 字段。它**自己不干活**。
- 真正干活的是 **ingress 控制器**:一整套 Deployment + Service + ServiceAccount + ClusterRole/Binding + ConfigMap + 那个 IngressClass。控制器没跑,引用该 class 的 ingress 无人理(无 IP、不转发)。
- 所以「加一个 traefik ingressclass」=**部署 traefik 控制器整套**(IngressClass 是其中一员)。装好 Pod Running 后,新 class 才是真的。
- 控制器通常用 **Helm** 或各官方**一键 YAML 清单(all-in-one manifest)** 安装。本方案用后者(平台网关无 Helm)。

## 3. 目标 / 非目标

**目标**
- 平台内置 4 个控制器的官方清单模板:nginx-ingress、traefik、haproxy、kong。
- 用户在 `IngressClasses.vue` 一键发起部署:选控制器 → 清单进 YAML 编辑器(可微调)→ server-side apply。
- 装完自动刷新 IngressClass 列表,新类出现在所有创建表单的下拉(共享 Vue Query key)。
- apply 前 RBAC 预检 + 逐资源 applied/failed 进度。

**非目标**
- 不安装控制器以外的东西(非通用应用目录)。
- 不内置 Helm(网关无 Helm;如需 Helm 走另案)。
- 不做控制器的升级/卸载向导(v1 仅「装」;升级=重跑幂等 SSA,卸载用现有资源删除)。
- 不自动选云厂商 LB 变体(v1 每控制器只钉一个 bare-metal NodePort 变体;其它变体用户装前手改 YAML)。

## 4. 架构与数据模型

### 4.1 打包清单(服务端静态资产)

`server/manifests/ingress-controllers/`:
- `nginx-ingress.yaml` — ingress-nginx 官方 bare-metal NodePort 变体,钉版本。
- `traefik.yaml` — Traefik 官方清单,钉版本。
- `haproxy.yaml` — HAProxy Ingress 官方清单,钉版本。
- `kong.yaml` — Kong 官方清单,钉版本。
- `catalog.mjs` — 元数据数组:

```js
export const INGRESS_CONTROLLER_TEMPLATES = [
  {
    id: 'nginx-ingress',
    labelKey: 'ingressController.nginx-ingress.label',
    descKey:   'ingressController.nginx-ingress.desc',
    version: '<实现期钉>',                    // 拉官方清单时填入具体版本号
    source: 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/...',
    variant: 'bare-metal NodePort',
    controller: 'k8s.io/ingress-nginx',     // 对应 IngressClass.spec.controller
    defaultClassName: 'nginx',
    file: 'nginx-ingress.yaml',
    notesKey: 'ingressController.nginx-ingress.notes',
  },
  { id: 'traefik',  controller: 'traefik.io/ingress-controller', defaultClassName: 'traefik',  file: 'traefik.yaml',  ... },
  { id: 'haproxy',  controller: 'haproxy-ingress.github.io/controller', defaultClassName: 'haproxy', file: 'haproxy.yaml', ... },
  { id: 'kong',     controller: 'incubator.ingress-controller.konghq.com', defaultClassName: 'kong', file: 'kong.yaml', ... },
]
```

> `controller` 字段值以各项目官方 IngressClass 清单为准;**清单有效性门禁测试**会断言打包 yaml 内的 `spec.controller` 与 catalog 声明一致(见 §8)。
>
> `version` / `controller` / `source` 均在实现期按拉取的官方清单填入准确值;catalog 示例仅示意结构,不留运行时占位。

### 4.2 新端点(读文件范式同 `readTmuxBinary`)

- `GET /api/ingress-controller-templates` → 返回 catalog(脱去 file 内部路径,只留客户端需要的字段)。
- `GET /api/ingress-controller-templates/:id` → 返回 `{ yaml: <清单文本> }`;id 不在 catalog → 404。
- **apply 复用** 现成 `POST /api/apply`(`applyYaml`:多文档 `yamlLoadAll` + 逐资源 server-side apply + `{ resources, applied, failed, total }`)。

### 4.3 RBAC 预检

apply 前用现有 can-i 能力聚合检查:网关 token 对 `clusterroles`/`clusterrolebindings`/`deployments`/`services`/`serviceaccounts`/`ingressclasses`/`configmaps` 的 `create`。结果为「缺哪些」→ 展示给用户。**非阻断**(允许继续;真正缺时 apply 会在那些资源上报 403,进 failed 列表)。

## 5. 组件清单

**服务端**
- `server/manifests/ingress-controllers/<4 个>.yaml`(官方,钉版本)。
- `server/manifests/ingress-controllers/catalog.mjs`(元数据,纯模块)。
- `server/index.mjs`:加 2 个 GET 端点;catalog 与文件读取逻辑(可抽小模块 `server/ingress-controller-templates.mjs` 便于单测)。

**前端**
- `src/api/client.js`:加 `ingressControllerTemplates.list()` / `.manifest(id)`。
- `src/composables/useIngressControllerTemplates.js`:薄封装(list/manifest,可并入 store 视实现定)。
- `src/views/IngressClasses.vue`:加「部署控制器」按钮 + 挂载弹窗。
- `src/components/.../DeployControllerDialog.vue`(新):
  - 三步:① 控制器卡片选择(显 label/version/variant/desc/controller/将建的 className);② 清单进 `YamlEditor` 可编辑;③ apply 进度。
  - **优先复用** `CreateFromYamlDialog`(已是 YamlEditor + template + apply);若其 API 不合身(如需要 catalog 选择步、RBAC 预检、进度态),则薄包一层新弹窗,内部仍复用 `YamlEditor` + `useResourceApply`。
- i18n:`ingressController.*`(每控制器 label/desc/notes + 变体说明 + 弹窗文案)。

## 6. 数据流

1. 用户在 `IngressClasses.vue` 点「部署控制器」。
2. 弹窗 `GET /api/ingress-controller-templates` → 显 4 个控制器卡片。
3. 选某控制器(如 traefik)→ `GET .../traefik` → 清单文本载入 `YamlEditor`。
4. RBAC 预检聚合 can-i → 列出缺的权限(若有)。
5. 用户可微调(namespace / className / replicas 等)→ 点「部署」。
6. 弹窗调 `POST /api/apply`(body = 编辑后的 yaml)→ 服务端逐资源 SSA → `{ applied, failed, total }`。
7. 弹窗显进度:X/total applied + failed 清单(每条带 error)。
8. 若有成功 → `queryClient.invalidateQueries(['cluster', cid, 'ingressclasses'])` → IngressClass 列表刷新 → 新类(如 traefik)出现在 `NsIngress` / `DeployApp` / `NsIngressDetail` 的 className 下拉(它们共享该 key)。

## 7. 错误处理

- **RBAC 不足**(硬前置):预检列缺的权限;apply 时集群级 RBAC 资源 403 进 failed,带可执行提示("网关 token 缺 create clusterrolebindings,需提升权限")。
- **部分失败**:`applyYaml` 已逐资源 try/catch;UI 同时显 applied/failed;SSA 幂等可重跑失败子集。
- **已装该 class**:检测同名 IngressClass 存在 → 提示"将更新(幂等)";SSA 不会建重复。
- **清单文件缺/读错**:端点 404 + 清晰文案。
- **集群不可达/会话失效**:标准错误 toast。

## 8. 测试策略

- **服务端 `node --test`**(新 `server/ingress-controller-templates.test.mjs`):
  - 列 catalog 端点返回字段齐全、4 条。
  - 取清单端点返回文本、缺 id → 404。
  - catalog 完整性:每条 `file` 真实存在、`controller`/`defaultClassName`/`version` 非空。
- **清单有效性门禁**(关键,零依赖运行器 `scripts/test.mjs` 可 import):
  - 每个打包 yaml `yamlLoadAll` 不抛;
  - 至少含一个 `kind: IngressClass`;
  - 该 IngressClass 的 `spec.controller` 与 catalog 声明一致;
  - 资源数 ≥ 阈值(防截断)。→ 钉死版本、防坏清单,CI 期拦。
- **前端 vitest**:DeployControllerDialog 渲染(卡列表、RBAC 预检展示、apply 进度态),mock api/client。
- RBAC 预检聚合逻辑(can-i 结果 → 缺失列表)单测。

## 9. 约束与前置条件

- **RBAC(环境前置)**:网关绑的 K8s token 需集群级 create 权限(clusterroles/clusterrolebindings + 控制器的 ns 资源)。不足则装不上,预检明示。非代码问题。
- **变体**:v1 每控制器只钉一个默认变体(bare-metal NodePort,无云 LB 依赖)。其它变体用户装前在 YAML 编辑器手改。
- **版本**:清单钉死;升级=换文件 + 走评审。
- **清单体积**:4 个共约 2–3k 行 YAML;可接受(小于已打包的 tmux 二进制 1.5MB)。

## 10. 分期建议(写实现计划用,不缩范围)

- **P1**:catalog + 2 端点 + nginx-ingress 一条**打通端到端**(选 → 改 → apply → 刷新),含 RBAC 预检与进度。证明脊柱。
- **P2**:补 traefik / haproxy / kong 清单与 catalog 条目(重复 P1 已定流程)。
- **P3**:RBAC 预检打磨、"已装"检测、部分失败重试 UX、变体切换(若需要)。

## 11. 开放问题(写计划时定)

- `DeployControllerDialog` 是否能直接复用 `CreateFromYamlDialog`,还是要新弹窗:取决于其现有 props/slot 是否容得下「catalog 选择步 + RBAC 预检 + 进度态」。实现期读源码裁决。
- catalog 元数据放 `catalog.mjs`(纯 ES 模块,可被 `scripts/test.mjs` 直 import,便于门禁测试)还是 `.json`:倾向 `.mjs`(与 `storageClassPresets.js` 同,可附注释 + 类型友好)。
- 控制器默认 namespace(如 `ingress-nginx` / `traefik`)是钉死还是用户必填:倾向钉死官方惯例命名,用户可在 YAML 改。
