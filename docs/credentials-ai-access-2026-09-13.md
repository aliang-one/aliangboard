# 凭据功能 + AI 访问适配器 v2 — 交付总结(2026-09-13)

> 覆盖:V1 凭据本体(14 提交,`10537c05..418d5bc0`)+ V2 AI 访问适配器(11 提交,`1e6226a8..1c35775d`,合并 `a8c1b2ce`)。
> 过程备注:V2 执行到 Task 6 时原会话遭 API 断连(ECONNRESET 双杀主循环与实现 subagent),2026-09-13 从 SDD 落盘的任务书无损恢复续做——task brief 落盘是现场恢复的关键载体。

## 一、这个功能是什么

工作台新增**凭据域**:用户把任意类型的凭据(用户名密码/服务器信息/SSH/GitHub token/数据库连接…)存进平台,由 AI 在**平台代持密码**的前提下安全使用。

**核心承诺(AI 永远不见密码明文)**:

```
用户存凭据(AES-GCM 逐字段加密落库)
   ↓ 系统提示只注入元数据清单(name/字段名(类型) + 适配器✓标记)
AI 决定用凭据 → 调适配器工具(credential 参数只传名字)
   ↓ 桥 runAdapter:闭包内解密,密码注入请求/连接参数
   ↓ 结果先脱敏(maskSensitiveText)后裁剪
AI 只拿到执行结果;全程六条红线有 e2e 锁定
```

## 二、V2 四层阶梯(核心架构)

| 层 | 机制 | 落点 |
|---|---|---|
| L1 匹配 | 适配器 registry:manifest 声明 `needs` 字段形状,凭据字段形状匹配→系统提示 `✓可用: http_request` / `(无匹配适配器)` | `server/credential-adapters/registry.mjs` |
| L2 授权 | `credential_grants` 表:审批卡「批准并记住」第三按钮落授权;收回即时生效(每次现读库);写方法**恒人审**(grant 不覆盖) | `server/credentials-store.mjs`、approve 端点 remember 载荷 |
| L3 执行 | `runAdapter` 服务端注入:http_request 组装 Bearer/db_query 填驱动 config——密码只活在单次调用栈 | `server/credentials/agent-bridge.mjs` |
| L4 顾问 | 无匹配适配器的凭据:AI 可读 text 字段,为用户拼手动命令(密码位留占位符),L2 顾问约定文案 | `server/workbench-prompt.mjs` |

**两个适配器**:

- **http_request**(完整版):method GET/POST/PUT/DELETE/PATCH(写恒人审);重定向逐跳 origin 复验(≤3 跳,防 SSRF);AI 请求头剥离 authorization/cookie/proxy-authorization 族;响应头白名单;body 32KB;超时 20s。
- **db_query**(双驱动):pg 8.23.0 + mysql2 3.24.4(依赖例外登记,懒加载零常驻开销);连接级只读(PG `default_transaction_read_only`/MySQL `SESSION TRANSACTION READ ONLY`);单语句;rows 200/64KB/15s;逐单元格脱敏(含 jsonb 嵌套/Buffer 占位)。

## 三、安全红线(spec §11,全部 e2e 锁定)

1. password 只在 exec 闭包,不进 args/审计/trace/返回/系统提示
2. 结果**先脱敏后裁剪**(防截断切半截秘密)
3. AI 不能自扩授权(grants 端点 admin 门;32 工具无 grant 写面)
4. 免审仅限只读路径;写方法恒人审;免审不免审计(approval:auto 标记)
5. http_request 可达范围恒等于 base_url origin
6. text/password 二分:AI 可读 text 明文,password 只见指纹

## 四、开发过程(SDD,每任务 实现→审查→记账)

- **V1**(存储/HTTP/AI 面 list+read 工具/智能粘贴 parse/凭据页/导航重排):14 提交,终审修复波收口。
- **V2 T1-T5**(grants 表/registry+http_request 最小版/桥扩展/grants 端点/前端授权 UI):原会话完成。
- **V2 T6**(提示词✓标记+闭环 e2e):中断恢复后续做。超纲修正 `agent-runner.mjs`——免审标记从 `(mode,name)` 重判改为 **needsApprovalFn 捕获门裁决**(`gateAutoPassed`→`execTool` 消费),grants 免审行正确带 `approval:auto`。
- **V2 T7**(http_request 加固):对抗审查 21 向 origin 绕过探针全拒;抓出 mask→truncate 顺序违规(T2 继承缺陷)。
- **V2 T8**(db_query):初审 FAIL 4 项 Important(测试计数/字段键归一/jsonb 绕脱敏/MySQL 查询超时)→修复波转 PASS-with-minors,真 PG 库集成实证。
- **T9 收尾**:小修批+全量门禁+opus 终审 **merge-ready-with-riders**;Rider 1(审批卡适配器专用展示——原误标「写文件审批」且不渲染凭据名/method/SQL)+ Rider 2(approve readBody 前移关 resume-after-cancel 微窗)修复后复审 **merge-ready**。

**门禁数字**:合并树 `npm test` 全链绿(vitest 321 文件 **2456 过 4 跳** + server 全量 + 守卫)+ typecheck 761 + build;主仓 node_modules 补装 pg/mysql2。

## 五、生效步骤

1. **本地网关重启**(8787):server 变更生效。
2. **推送+tag v1.0.33** → CI 构建 ghcr 镜像 → 集群实例拉新镜像 + 网关重启(部署实例的 `npm i` 由镜像自带)。
3. **真库集成用例**:CI 恒跳过,需在可信环境设 `TEST_PG_URL`/`TEST_MYSQL_URL` 人工验收(spec §16 已声明的漏网窗口)。

## 六、手测清单(建议)

1. 凭据页:手动建 GitHub 型凭据(base_url/api_token)/智能粘贴/「数据库」预设;逐字段 reveal。
2. 对话让 AI 查 release → 审批卡显示「外部请求审批」+凭据名+method → 批准 → 目标服务收到 Bearer。
3. 「批准并记住」→ 同操作二跑免审(审计带 approval:auto)→ 凭据详情「已授权」区可见 → 收回 → 回人审。
4. POST 请求(有 grant 也 paused);SSRF:302 跳外域被拒不发二跳。
5. db_query:只读查询过;`CREATE TABLE` 被连接级只读拒;结果中含 token 的列被 redacted。

## 七、Backlog(不阻断,记录在 SDD 账本 Task 9 节)

- **M-2(最值得做)**:审计 verb 误标——`WRITE_TOOLS` 不含适配器写方法,POST 外部写被审计成 `read`。
- M-3 query 入参文档化 / M-6 grants 区不显授权人 / M-7 收回端点 403 用例 / M-8 grant 失败 UI 误报成功 / M-11 前端 `ADAPTER_TOOLS` 硬编码 / M-13 审批卡不显 AI 自定义头 / 3xx-无-location 文案 / 301-302 method 改写 / driver 下拉(spec-plan 分歧)/ e2e 端口集中分配器。
- **参数化「保存的查询」**(值得立项):用户预写带 `$1` 参数的 SQL 存平台,AI 只能填参数不能改语句——比自由 SELECT 更强的安全面(思想源自 mcp-toolbox,2026-09-13 评估结论:不引入该库——其凭据明文落盘于自有 YAML,与 §11.1 闭包红线冲突;DB 广度按需原生长驱动)。

## 八、关联文档

- Spec:`docs/superpowers/specs/2026-09-12-credentials-and-nav-design.md`(V1)、`docs/superpowers/specs/2026-09-12-credential-adapters-v2-design.md`(V2)
- Plan:`docs/superpowers/plans/2026-09-12-credentials-and-nav.md`、`docs/superpowers/plans/2026-09-12-credential-adapters-v2.md`
- SDD 账本+全部任务书/评审包:`.superpowers/sdd/2026-09-12-credential-adapters-v2/`
