# AliangBoard

K8s 多集群管理前端（Vue 3 + Vite + Pinia，纯 JS）+ 网关（`server/`，Node，透明透传 K8s API）。

## 依赖政策

仓库默认**不新增外部依赖**（见 `scripts/test.mjs` / `scripts/typecheck.mjs` 顶部注释：测试用自研零依赖运行器、类型用 `node --check`，刻意不引 vitest/jest/TypeScript）。

以下为已裁决的**例外**（新增依赖须经同等审视并在此登记，附 rationale）：

| 依赖 | 类别 | 引入原因 | 裁决来源 |
|------|------|----------|----------|
| `@tanstack/vue-query` | 运行时（dependencies） | 数据层终极优化：服务端状态归 Vue Query（去重/缓存/过期重取/三态/变更失效），Pinia 只留客户端状态。与 pinia/vue-router 同级的标准库。 | `/plan-eng-review` 2026-08-06：零依赖政策解读为「只约束工具链(test/build 不引 vitest/jest/ts)」，运行时可接受标准库 |
| `vitest` + `@vue/test-utils` + `happy-dom` | 测试工具（devDependencies） | 66 页数据层迁移需组件/交互自动化安全网。纯逻辑仍优先用自研零依赖运行器覆盖。 | `/plan-eng-review` 2026-08-06：例外从运行时扩到测试工具 |
| `marked` | 运行时（dependencies） | 工作台 chat agent 终答 markdown→HTML 解析（标准、~30KB）。 | 2026-08-10 workbench Cursor-style chat 设计 |
| `dompurify` | 运行时（dependencies） | 消毒 marked 产出的 HTML（`conv.content` 为 LLM 生成、走 `v-html`，必须防 XSS）。 | 2026-08-10 workbench Cursor-style chat 设计 |
| `echarts` | 运行时（dependencies） | 图表美化:折线/环形/表盘。`echarts/core` 按需引入(树摇,gzip 实测 ≈188KB,独立懒加载 chunk,未入主包),tooltip/渐变/过渡动画开箱即用。 | 2026-08-14 图表美化设计 `docs/superpowers/specs/2026-08-14-chart-beautification-design.md` |
| `ssh2` | 运行时（dependencies） | SSH 客户端唯一可行纯 JS 实现(交互 shell 通道 + SFTP + password/keyboard-interactive/私钥认证)。系统 ssh 无法安全支持密码认证(sshpass 密码过 argv/环境变量)且容器须加装系统包。 | 2026-08-28 SSH 管理设计 `docs/superpowers/specs/2026-08-28-ssh-management-design.md` |

> 设计文档：`~/.gstack/projects/aliang-aliangboard/liang-feat-data-model-design-20260806-001249.md`（含 GSTACK REVIEW REPORT）。

## 提交规范

- 提交作者恒为 `aliangone <aliangone@gmail.com>`;**禁止**在提交信息中加 `Co-Authored-By: Claude` 尾注(用户 2026-08-26 明确要求,GitHub 会把尾注渲染成共同作者)。
- **禁止改写已推送的历史**、禁止 force push(多会话并行开发,改写历史会使并行会话推送被拒);任何清理/修整只允许作用于**未推送的本地提交**。

## 架构约束

- **网关单进程不变式**(2026-08-28 显式化):`server/` 网关以「单进程 + 单 SQLite 库」为前提——`node:sqlite` 单连接同步写、会话/限流/看门狗全在内存 Map、审计链哈希(prevHash 单调)假设唯一写入者。双进程同库 = 静默脑裂。防线:启动时抢 `<db>.lock` 独占锁(`server/single-process-lock.mjs`,持锁者活着拒启、死 pid 接管);部署侧固定 `replicas: 1 + Recreate`(deployment.yaml)。**要水平扩展必须先做状态外移(会话/限流/审计锚点)的 ADR,禁止默认可扩。**
- **路由鉴权单一事实源**:新端点必须先在 `server/route-auth-map.mjs` 的 `ROUTE_AUTH` 声明鉴权 class(none/session/platform/admin/apikey/mcp)——表外 `/api/*` 一律 404,守卫测试静态扫源码路径字面量强制登记。

## 测试

- 服务端 + 纯逻辑：`npm test`（含 `scripts/test.mjs` 自研零依赖运行器 + `node --test server/*.test.mjs`）。
- 前端单测：`npm run test:unit`（vitest，happy-dom + @vue/test-utils）。
- 类型/语法基线：`npm run typecheck`（`node --check` 全 .js/.mjs；.vue 由 `npm run build` 覆盖）。
