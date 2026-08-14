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
| `echarts` | 运行时（dependencies） | 图表美化:折线/环形/表盘。`echarts/core` 按需引入(树摇,gzip ≈100KB),tooltip/渐变/过渡动画开箱即用。 | 2026-08-14 图表美化设计 `docs/superpowers/specs/2026-08-14-chart-beautification-design.md` |

> 设计文档：`~/.gstack/projects/aliang-aliangboard/liang-feat-data-model-design-20260806-001249.md`（含 GSTACK REVIEW REPORT）。

## 测试

- 服务端 + 纯逻辑：`npm test`（含 `scripts/test.mjs` 自研零依赖运行器 + `node --test server/*.test.mjs`）。
- 前端单测：`npm run test:unit`（vitest，happy-dom + @vue/test-utils）。
- 类型/语法基线：`npm run typecheck`（`node --check` 全 .js/.mjs；.vue 由 `npm run build` 覆盖）。
