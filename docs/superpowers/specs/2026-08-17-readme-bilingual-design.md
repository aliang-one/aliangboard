# README 双语重构设计(English 默认 + 中文镜像)

- 日期:2026-08-17
- 分支:`feat/readme-bilingual`(自 main `24269d0`)
- 状态:已获用户批准(brainstorming 2026-08-17)

## 目标

开源项目文档面向国际受众:**英文为默认展示**,提供中文文档入口;同时修正 README 中已过时的内容、消除重复章节、收编超长列表。

## 非目标

- 不建 docs/ 中文文档站(单文件镜像即可,后续有需要再扩)
- 不补真实截图(需真实环境,保留 TODO 占位)
- 不改任何代码 / CI 配置本身(只改文档描述以匹配现状)

## 双语机制

| 文件 | 角色 |
|---|---|
| `README.md` | **英文,事实源**(source of truth) |
| `README.zh-CN.md` | **中文全量镜像**(现 README 的优化版) |

- 两文件第一行语言切换:`English | [简体中文](README.zh-CN.md)` / `[English](README.md) | 简体中文`
- GitHub 按访客浏览器语言自动渲染 `README.zh-CN.md`,英文为兜底
- 维护约定写入两文件 Contributing 节:**改 `README.md` 必须同步 `README.zh-CN.md`**

## 信息架构(两文件同构)

```
语言切换行
标题 + badges(CI / ghcr / node / vue / license)
一句话定位 + 简介
✨ Features(六组,合并原「特性」+「已接入真实集群的能力」,去重)
   ├ AI Operations(Agent 工作台 + MCP + 人审 + 审计)
   ├ Cluster & Multi-Cluster
   ├ Full Resource Lifecycle(30+ 资源 → 一张分类覆盖表)
   ├ Pod Deep Operations(exec · port-forward · 文件浏览 · debug 注入 · attach)
   ├ Rollout & Node Ops(扩缩容 · 滚动重启 · 回滚 · cordon/drain)
   └ Navigation & Insights(全局搜索 · 归属拓扑 · Events watch · 应用分层)
📸 Screenshots(TODO 占位保留)
🚀 Quick Start(K8s / Docker / 源码,三种方式)      ← 上移到 AI 深潜之前
🤖 AI Workbench & MCP(工具三档 + BYO LLM + 安全模型)
⚙️ Configuration(后端/前端环境变量表)
🔐 RBAC Recommendations(权限建议)
🐳 Container Deployment & Release(CI 发布,修正过时内容)
⚠️ Known Limitations(当前边界)
🛠 Tech Stack · 🤝 Contributing · License
```

## 内容修正清单

| 项 | 动作 |
|---|---|
| CI 发布段(过时) | 改为:`v*` tag 触发 + `workflow_dispatch`;tag 产物 `latest` / `1.2.3`(不可变) / `1.2`(滚动);删除 `sha-<hash>` 与「推 main 自动构建」说法 |
| 「特性」vs「已接入真实集群的能力」重复 | 合并去重为六分组 Features |
| 20+ 条资源平铺列表 | 收编为按类别分组的资源覆盖表(Core Workloads / Networking / Config & Storage / RBAC / Cluster & Policy / Autoscaling / CRDs) |
| 已落地未写的亮点 | 补:tmux 持久化终端(刷新不掉线)、指标图表(15min 采样 echarts)、AI 对话挂后台+悬浮入口 |
| badges | 保留现有 5 个(CI badge 仍指向 docker.yml,有效) |
| 截图 | 保留 TODO 注释占位 |

事实核对基准(worktree 内现状):CI = `.github/workflows/docker.yml`(`on: push: tags ['v*']` + `workflow_dispatch`;镜像 tag:`latest` + semver `1.2.3` + 滚动 `1.2`);已发布 tag v1.0.0~v1.0.3;Node 25+ 硬依赖(`node:sqlite`)。

## 实现步骤

1. 重写 `README.md`(英文,按上述架构)
2. 生成 `README.zh-CN.md`(中文,同构,内容 = 现 README 优化后的事实)
3. 校验:两文件章节一一对齐、内部链接/锚点有效、badge URL 与仓库(aliang-one/aliangboard)一致、代码块命令可读
4. 跑 `npm test` + `npm run typecheck` 确认未误伤其他文件
5. merge 回 main(仓库惯例 merge commit);**不自动 push origin**

## 验收标准

- [ ] `README.md` 全英文、`README.zh-CN.md` 全中文,顶部互链可跳
- [ ] CI/发布描述与 `.github/workflows/docker.yml` 实际行为一致(无 sha-<hash> 残留)
- [ ] Features 六分组无重复条目;资源覆盖表覆盖原列表全部资源类型(30+)
- [ ] 快速开始位于 AI 深潜章节之前
- [ ] 原 README 全部事实性内容(配置表/RBAC 建议/边界)无丢失
- [ ] 两文件章节结构一一对应
