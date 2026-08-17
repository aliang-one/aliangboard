# README 双语重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `README.md` 重写为英文(事实源),新增 `README.zh-CN.md` 中文全量镜像,顶部互链;修正过时 CI 描述、合并重复章节、收编超长列表。

**Architecture:** 纯文档变更,两个文件同构(章节一一对应)。英文版按 spec 信息架构重排(Quick Start 上移、Features 六分组+资源覆盖表);中文版继承现有 README 全部事实性内容并应用同一修正。

**Tech Stack:** Markdown(GitHub Flavored)。无代码变更、无依赖变更。

## Global Constraints

- `README.md` = 英文 only,事实源;`README.zh-CN.md` = 中文 only,结构完全同构(标题层级与顺序一一对应)
- 事实基准(以仓库现状为准,不得沿用旧 README 过时描述):
  - CI(`.github/workflows/docker.yml`):**仅 `v*` tag push 触发** + `workflow_dispatch` 手动;**不再**由 main push 构建产物
  - 镜像 tag 产物:`latest`(跟随最新发布)/ `1.2.3`(semver 不可变)/ `1.2`(major.minor 滚动);**无 `sha-<hash>` tag**
  - 平台:`linux/amd64` + `linux/arm64`;认证用内置 `GITHUB_TOKEN`
  - 另有 `.github/workflows/cleanup-ghcr.yml` 清理历史镜像(可提一句)
  - 已发布 tag:v1.0.0 ~ v1.0.3;Node 25+ 硬依赖(`node:sqlite`)
- 仓库标识沿用现有 badge:GitHub `aliang-one/aliangboard`,镜像 `ghcr.io/aliang-one/aliangboard`
- 截图保留 TODO 注释占位,**不得引用不存在的图片文件**
- 不改任何代码 / workflow / 配置文件;完成后跑 `npm test` 与 `npm run typecheck` 确认零误伤
- 提交信息用仓库惯例(中文主题行),结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 在 worktree `feat/readme-bilingual` 内工作;完成后 merge 回 main,**不 push origin**

---

### Task 1: 重写 README.md(英文,事实源)

**Files:**
- Modify: `README.md`(全量重写)

**Interfaces:**
- Produces: 中文版(Task 2)镜像的章节结构、顺序与全部事实。语言切换目标文件名 `README.zh-CN.md`。

内容骨架(严格执行此顺序与事实):

```
**English** | [简体中文](README.zh-CN.md)          ← 第一行语言切换
# AliangBoard
<5 个 badge:CI docker.yml / ghcr / node 25%2B / vue 3 / Apache--2.0>(沿用现有 URL)
> Open-source, AI-native Kubernetes management panel — natural-language
> operations on top of full multi-cluster management.
简介段:LLM as cluster operator(内置 Agent workbench + MCP server,natural
language 查日志/调容器/回滚/改资源,写操作必人审)+ 完整 K8s 面板(全量资源
生命周期、exec / port-forward / debug 注入 / 多集群)。
技术栈一句话:Vue 3 + Vite + Pinia(plain JS, no TypeScript)+ Node
transparent K8s API gateway(zero extra runtime dependencies)。

## ✨ Features(六分组,合并原「特性」+「已接入真实集群的能力」,去重)
### 🤖 AI Operations
- Agent workbench + MCP server(Streamable HTTP, API-key auth)
- Tiered tools: read(free) / operator / admin(需人审);writes always human-approved
- Full audit log(who / verb / resource / HTTP code)
- Chat 可挂后台 + floating entry 悬浮入口(新增亮点)
### 🔌 Cluster & Multi-Cluster
- Bearer Token / Basic Auth 连接验证、会话恢复、退出登录
- 集群持久化、一键切换/移除
### 🗂 Full Resource Lifecycle
- 30+ 资源类型同步;结构化创建表单(20 种,ConfigMap/Secret/PVC/PV/StorageClass/Ingress/Service/IngressClass/RuntimeClass/PriorityClass/NetworkPolicy/HPA/ResourceQuota/LimitRange/Role/ServiceAccount/RoleBinding/ClusterRoleBinding/PDB/Namespace)经 Server-Side Apply 落库
- YAML 编辑/导出;乐观删除+失败回滚;多文档 YAML 一次应用
- 资源覆盖表(见下)
### 🖥 Pod Deep Operations
- exec 终端(xterm.js,**tmux-backed: 页面刷新不掉线** ← 新增亮点)
- attach · port-forward(Service/Deployment 经 endpoints 解析)
- 文件浏览(上传/下载,进度显示)· kubectl debug 注入(ephemeral containers)
### 🔁 Rollout & Node Ops
- scale · rolling restart · rollout undo · CronJob manual trigger
- Node cordon / uncordon / drain(policy/v1 Eviction)
### 🔍 Navigation & Insights
- 全局跨资源搜索 · ownerReferences 归属拓扑(可点击跳转)
- Events 实时 watch + involvedObject 过滤
- Namespace 应用分层(启发式 + label `layer.aliangboard.io` 覆盖)
- 指标图表(CPU/内存采样,15-min window ← 新增亮点)

资源覆盖表(取代旧 20+ 条平铺列表,分组):

| Category | Resources |
|---|---|
| Core Workloads | Pod · Deployment · StatefulSet · DaemonSet |
| Networking | Service · Ingress · Endpoints · NetworkPolicy · IngressClass |
| Config & Storage | ConfigMap · Secret · PVC · PV · StorageClass |
| RBAC | Role · ClusterRole · RoleBinding · ClusterRoleBinding · ServiceAccount |
| Cluster & Policy | Namespace · Node · Event · RuntimeClass · PriorityClass · ResourceQuota · LimitRange · PDB |
| Autoscaling | HPA |
| Extensions | CRD + custom resources(API discovery 驱动) |

## 📸 Screenshots
<!-- TODO 注释占位,写明待补:登录页 / 资源列表 / exec 终端 / Agent 工作台 -->

## 🚀 Quick Start(上移到 AI 深潜之前)
### Kubernetes (recommended): kubectl apply deployment.yaml + NodePort 说明 +
  admin/admin 首次播种警告 + PVC 持久化说明 + 集群内部署 SA/RBAC 提示 + 卸载即清数据
### Docker: docker pull/run ghcr.io/aliang-one/aliangboard:latest(-v aliangboard-data:/app/data)
### From source: Node 25+ 要求(node:sqlite) + npm install + npm run server + npm run dev + npm run build

## 🤖 AI Workbench & MCP(从旧 README §AI 翻译,事实不变)
### Built-in Agent Workbench:read/operator/admin 工具清单 + 人审 checkpoint
### MCP Server:claude mcp add 命令块(原样保留)
### Bring Your Own LLM:OpenAI 兼容,admin 页配置或 LLM_BASE_URL/LLM_MODEL 环境变量
### Security Model:SA-bound API keys · minTier 过滤 · 写操作人审 · 审计日志

## ⚙️ Configuration(两张环境变量表直译:后端 10 行 + 前端 2 行,含 insecure 警告段)

## 🔐 RBAC Recommendations(旧「权限建议」直译:专用 SA + 各子资源动词清单 + 会话/凭据存储说明)

## 🐳 Container Deployment & Release
容器变量表(HOST/PORT/ALIANG_DB/ALIANG_WORKBENCH_DIR/ALIANG_STATIC_DIR)+ 镜像说明
(node:25-alpine、内置 git、非 root)。
**Release(修正过时内容,按 Global Constraints 事实基准写)**:
- 触发:push `v*` tag(如 v1.2.3)或 Actions 页手动 workflow_dispatch;普通 main push 不构建
- 产物:latest / 1.2.3(不可变,锁版本)/ 1.2(随 minor 滚动)
- 平台 amd64+arm64;GITHUB_TOKEN 内置认证
- 历史镜像由 cleanup workflow 自动清理
- 当前已发布:v1.0.3

## ⚠️ Known Limitations(旧「当前边界」8 条直译)

## 🛠 Tech Stack(前端/后端/测试/打包四行直译)

## 🤝 Contributing
开发命令块 + **双语同步约定:改 README.md 必须同一 PR 更新 README.zh-CN.md**

## License
Apache-2.0 链接 + 一句说明
```

- [ ] **Step 1: Write README.md** — 按上述骨架写入完整英文文档(所有表格行、命令块、bullet 照旧 README 事实翻译,不丢事实性内容)

- [ ] **Step 2: Verify English-only + no stale content**

Run: `grep -nP '[\x{4e00}-\x{9fff}]' README.md; grep -n 'sha-' README.md; grep -n 'main branch' README.md`
Expected: 全部无输出(无中文字符、无 sha-tag 残留、无「推 main 构建」表述)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): 重写为英文事实源——六分组特性+资源覆盖表+修正 CI 发布描述"
```

---

### Task 2: 新增 README.zh-CN.md(中文镜像)

**Files:**
- Create: `README.zh-CN.md`

**Interfaces:**
- Consumes: Task 1 的章节结构与事实(顺序、分组、表格行、CI 描述必须逐节对应)
- Produces: 与 `README.md` 互链的中文全量文档;语言切换行指向 `README.md`

要点:

- 第一行:`[English](README.md) | **简体中文**`
- 内容 = 现 README(main 24269d0 版)全部事实性内容,应用与 Task 1 相同的修正与重排:
  - Features 六分组 + 资源覆盖表(中文)
  - Quick Start 上移
  - CI 发布段按事实基准改写(tag 触发 / latest·x.y.z·x.y / 删 sha-<hash>)
  - 新增亮点三条:tmux 持久终端、指标图表、AI 对话挂后台+悬浮入口
  - Contributing 加双语同步约定
- 保留中文版原有的人情味措辞(如「把大模型变成集群里的操作员」),不必逐字直译英文

- [ ] **Step 1: Write README.zh-CN.md** — 与 README.md 同构写入完整中文文档

- [ ] **Step 2: Verify structure alignment**

Run: `diff <(grep -c '^#' README.md) <(grep -c '^#' README.zh-CN.md) && diff <(grep -oP '^#{1,3} .*' README.md | wc -l) <(grep -oP '^#{1,3} .*' README.zh-CN.md | wc -l)`
Expected: 标题数量一致(逐节顺序人工核对一遍)

Run: `grep -n 'sha-' README.zh-CN.md; grep -n 'README.md' README.zh-CN.md | head -2`
Expected: 无 sha 残留;语言切换行链接到 README.md

- [ ] **Step 3: Commit**

```bash
git add README.zh-CN.md
git commit -m "docs(readme): 中文镜像 README.zh-CN.md——与英文版同构互链"
```

---

### Task 3: 终检 + 基线确认

**Files:**
- Verify only(如终检发现问题,就地修 + 追加 commit)

**Interfaces:**
- Consumes: Task 1/2 产物

- [ ] **Step 1: 内容对齐人工清单** — 逐项核对 spec 验收标准:
  - 两文件顶部互链可跳(相对路径正确)
  - CI/发布描述与 `.github/workflows/docker.yml` 一致
  - Features 无重复条目;覆盖表覆盖旧列表全部资源(28 kind + CRD/CR)
  - Quick Start 在 AI 章节之前
  - 旧 README 事实性内容(两张 env 表 / RBAC 建议 / 边界 8 条 / 容器变量表)无丢失
  - 截图为注释占位,未引用不存在文件

- [ ] **Step 2: 跑测试基线确认零误伤**

Run: `npm test && npm run typecheck`
Expected: 全绿(文档变更不应影响;若红,说明误改了代码,须回查)

- [ ] **Step 3: 收尾报告** — 汇报 diff 统计(`git diff main --stat`),等待用户确认后 merge 回 main(merge commit,不 push origin)
