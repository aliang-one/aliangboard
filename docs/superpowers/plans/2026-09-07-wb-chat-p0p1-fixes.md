# 工作台 AI 对话审计第一批修复计划(P0×1 + P1×5)

来源:2026-09-06 工作台 AI 对话 9 维审计(完整报告 `~/.gstack/qa-reports/wb-chat-audit-2026-09-06.json`,基线 HEAD 5aeaa91);设计经用户 2026-09-07 批准(限流参数裁决:并发 5、每项目 50,做成 AI 配置页可调项)。六个缺陷归四个任务:F2+F3 同文件强耦合合并为 Task 3,F4+F5 同型鉴权门合并为 Task 2。

## Global Constraints

- **TDD**:每项先写红测试再实现;测试红了修实现,禁止改测试迁就实现。
- **门禁**:实现者跑任务相关定向测试;合并前控制器统一跑四道(`npm test` / `npm run test:unit` / `npm run typecheck` / `npm run i18n:check`)。
- **提交**:信息一律英文;禁止改 git config(作者身份仓库已配好);禁止 `Co-Authored-By` 尾注;**禁止 merge/rebase 到 main**——只在当前 worktree 分支提交。
- **依赖**:零新增外部依赖。
- **i18n**:src 禁中文字面量;新键 zh/en 双语补齐。
- **node:sqlite**:绑定 `undefined`/对象直接抛异常,写库前显式判空。
- **路由鉴权单一事实源**:本计划不新增端点;若实现中发现必须新增,停下在报告说明,不得擅自加。
- 多会话并行开发:**动手前先 `git branch --show-current` 确认在 worktree 分支**;所有 Edit 用 worktree 绝对路径。

---

## Task 1: P0 审批路由白名单(F1,审计 agent-loop-01)

**背景**:`routeDynamicApproval`(server/workbench-agent.mjs:26-30)只把 `wb_ssh_run`/`wb_ssh_job_*` 分给任务桥,**其余全部工具**(wb_scale/wb_restart/wb_update_image/wb_rollout_undo/wb_exec/apply_project_manifests/write_project_file/…)走 SSH 同步桥 `sshBridge.needsApproval`;而该裁决(server/ssh/agent-bridge.mjs:58-73)完全由 `resolve(args?.server)` 命中服务器的 `aiApprovalPolicy` 决定,`'none'` 直接免审。`args` 是 LLM 生成的 JSON——非 SSH 写工具多带一个 `server` 字段指向 'none'(甚至 readonly)策略服务器即可绕过人审,审计已真模块端到端复现(wb_scale/wb_exec 带 server:'dev-1' 免审直执行)。

**文件**:server/workbench-agent.mjs(routeDynamicApproval 及其注释块)、server/ssh/agent-bridge.mjs(needsApproval);测试进既有覆盖文件(workbench-agent.test.mjs 的 routeDynamicApproval 相关 describe;agent-bridge 有测试则进其文件,实现者 grep `needsApproval` 现有测试落位)。

**要求**:
1. `routeDynamicApproval` 改白名单分流:`wb_ssh_job_*` → sshJobs 桥(缺桥 true);工具名以 `wb_ssh_` 开头或 === `'write_server_notes'` → sshBridge(缺桥 true);**其余一律 `return true`(恒人审)**——删除「其余走同步桥」的兜底语义,同步更新 23-25 行注释与文件头注释里的相应描述。
2. `agent-bridge.needsApproval` 开头加防御:非 SSH 工具名(不以 `wb_ssh_` 开头且非 `write_server_notes`)恒 `return true`,防未来路由再错配(双保险)。
3. TDD 测试(先红):
   - 非 SSH 需审工具(至少 `wb_scale`、`wb_exec`、`write_project_file`)携带伪造 `server` 参数指向 `aiApprovalPolicy='none'` 的暴露服务器 → 裁决仍为 true(须 checkpoint);
   - 同参数指向 `readonly` 策略服务器 → 仍 true(审计验证者证实 readonly 服务器也可作跳板);
   - SSH 族行为不回归:`wb_ssh_run`/`wb_ssh_read_file`/`wb_ssh_job_*` 按各自策略裁决的既有测试全部保绿;`write_server_notes` 恒 true 保持。
4. **不做** schema 剥离未声明属性(execTool 加固属后续批次,本任务不动 execTool)。

---

## Task 2: 鉴权收口两处(F4 ledger 门 + F5 refAllowed 集群级 kind)

**背景 F4**(审计 authz-entitlement-04):`GET /api/workbench/ledger`(server/routes/workbench-projects.mjs:369-382)只有 `requirePlatform`,任意平台用户可读任意集群的全集群 survey 台账(含待审蒸馏稿 `pending`),无归属/entitlement 校验;同文件 142 行已有 `clusterEntitled(ps, cid)` helper,兄弟端点 256/285/296 均在用。

**背景 F5**(审计 refs-injection-05):`refAllowed`(server/ref-fetch.mjs:20-24)对 k8s ref 只做 `canAccessNs(..., ref.namespace, 'view')`;cluster-scoped kind(nodes/persistentvolumes/clusterroles 等)本无 namespace,伪造 namespace 字段即可越过 clusterWide 拒绝越权读取。wb 工具侧 Phase C 已有 clusterWide 分配门(终审修过),refs 面漏接。

**文件**:server/routes/workbench-projects.mjs(ledger GET)、server/ref-fetch.mjs(refAllowed);测试落 workbench-projects-gates.test.mjs(或同族)与 ref-gate.test.mjs。

**要求 F4**:
1. ledger GET 在 `requirePlatform` 后加 `if (!clusterEntitled(ps, clusterId)) → 403 { message: msg(req, 'wbp.clusterForbidden') }`,与兄弟端点逐字同款。
2. 测试:无该集群授权的平台用户 403;admin / open 集群用户 / 已授权用户 200(断言 `pending` 蒸馏稿同门可达)。

**要求 F5**:
1. `refAllowed` 对 cluster-scoped kind 不走 `canAccessNs`,改复用 wb 工具 Phase C 的 clusterWide 授权判定(**grep `clusterWide` 找单一事实源复用,禁止在 ref-fetch 另造第二份清单/逻辑**);admin 与 open 集群放行,allowlist 用户须显式 clusterWide 授权。cluster-scoped 判定同样单源(优先复用 kind-paths.mjs 的路径形状判断;若无可复用则从其导出,勿内联硬编码清单)。
2. namespaced kind 行为不变;`@server` ref 不变;未绑集群项目(`projectClusterId` 空)行为不变。
3. 测试(先红):allowlist 无 clusterWide 用户伪造 `namespace:'default'` 的 `nodes`/`persistentvolumes`/`clusterrole` ref → 拒绝(refAllowed false);同用户带 clusterWide 授权 → 放行;admin / open 集群 → 放行;namespaced kind(如 pods/deployments)既有行为回归不变。

---

## Task 3: tracker 写点守卫(F2 取消保留 partial + F3 supersede 全覆盖,同文件强耦合)

**背景 F2**(审计 cancel-races-01,P1):真实 agent 循环每轮 chat 完成必发 `onStep({type:'assistant'})`(server/agent.mjs:246-248/226-228);workbench-agent.mjs:198-201 对 assistant 事件调 `tracker.resetRound()`,而 resetRound(152-155)无条件清零 partial/reasoning 并 checkpoint 把 `conv.content` 写空。取消无法中断在途流 → 主流时序(看长答案中途点停止)为:流自然完成→assistant step→resetRound 清零→runConversation 的 cancelled 保留分支(321-328)与 cancelledCatchGuard(232-249)读到空 partial → 不落 assistant 消息,半截答案刷新蒸发。锁定「取消保留」的测试(~L446-471)桩在 onDelta 后直接 resolve、从不发 assistant step——桩形状掩蔽缺陷。

**背景 F3**(审计 agent-loop-03,P1):被取代 run(取消→修改重发,edit/regenerate bump epoch)的在途流回调无 epoch 守卫:onDelta/onReasoning(133-141)、checkpoint(130)、makeOnStep(193-206)继续写库(检查点/appendTrace/清零)并向**新 run 的 bus** 发事件,违反「被取代即静默丢弃一切产出」承诺(epoch 现只在 run 出口查,不在写点查)。

**文件**:server/workbench-agent.mjs(tracker 47-160、makeOnStep 193-206、runConversation cancelled 分支 232-249/321-328、cancelConversation 436-448)、server/workbench-agent.test.mjs。**不动** server/agent.mjs 与 server/llm.mjs(取消不可中断在途流是已知边界,本任务在 workbench-agent 侧吸收)。

**要求**:
1. **supersede 守卫**:tracker 全部写点与相关 bus emit(checkpoint / onDelta / onReasoning / appendTrace / resetRound 触发的写 / makeOnStep 路径的写)在 run 已被取代时静默 no-op。实现自选(写前比对 conv epoch/run 标识,或 tracker 持取消-取代快照),但必须覆盖上述全部写点,不得只守 run 出口。被取代定义沿用现状:**edit/regenerate bump epoch;plain cancel 不 bump**(cancelConversation 436-448 注释语义保持,不 bump 否则保留分支永不可达)。
2. **取消保留**:makeOnStep 的 assistant 分支在 resetRound 前检查取消:已取消(非被取代)→ 跳过清零与 checkpoint 抹除,使 cancelled 保留分支(321-328)读到 partial/reasoning 落 assistant 消息、conv.content 检查点不被清空。与 1 组合:被取代时该路径同样 no-op(取代优先于保留)。
3. **桩修正 + 新测试**(先红):
   - 既有「取消后保留」用例的桩改为真实循环形状:onDelta 若干 → cancel → 残余 onDelta → **onStep({type:'assistant', message})** → resolve;断言 status=cancelled、messages 含 assistant 消息(已流出文本)、DB conv.content 不为空(刷新不蒸发)。
   - 新用例 A:多轮 run 中 cancel 落在工具执行段(上一轮 assistant step 已发过)→ 当前轮已流出文本仍保留落库。
   - 新用例 B:supersede 场景(cancel 后立即 edit/regenerate bump epoch)→ 旧 run 的残余 onDelta/onStep(assistant/resetRound)/appendTrace 全部不写库、不发 bus 事件;新 run 产出完好。
   - 回归:正常 done 路径 resetRound 正常清零不受影响;既有 superseded 静默丢弃、plain-cancel 保留语义测试保绿。
4. 验收基线:审计报告 `~/.gstack/qa-reports/wb-chat-audit-2026-09-06.json` 中 cancel-races-01 与 agent-loop-03 两条的 evidence/votes 里有验证者的真实复现形状,实现完成后两类复现场景都必须绿。

---

## Task 4: 对话限额配置化(F6,逐字沿用 maxSteps 模式)

**背景**(审计 quota-abuse,P1):对话 create/run 零限流零并发上限,单用户可拉起无界并行 detached run 烧 admin LLM key、冻结单进程网关;会话行数无界增长。用户裁决(2026-09-07):**做成配置功能放进 AI 配置页**(并发默认 5、每项目默认 50,均 0=不限制)。

**参照模板**:maxSteps 全链(server/workbench-ai-config.mjs 的 `getMaxStepsConfig`/`validateMaxSteps`/`MAX_STEPS_RANGE`;server/routes/admin.mjs:249-283 的 GET 回显/PUT 落键;前端 admin「AI 行为」面板数字输入;每次 run 现读即时生效)。逐字沿用该模式,不发明新形状。

**文件**:server/workbench-ai-config.mjs、server/routes/admin.mjs、server/routes/workbench-conversations.mjs(create ~204-243 / messages ~260-306)、前端 AI 行为面板组件(实现者 grep maxSteps 定位)+ locales/{zh,en};测试:workbench-ai-config.test.mjs、workbench-ai-config-routes.test.mjs、workbench-conv-routes.test.mjs、面板组件测试。

**要求(精确值,逐字执行)**:
1. 新配置键两枚:
   - `workbench.maxRunningConversations` — 每用户并发 running 会话上限,**默认 5**,范围 **0..20**,**0=不限制**;env 通道 `WB_CONV_MAX_RUNNING_PER_USER`。
   - `workbench.maxConversationsPerProject` — 每用户×项目会话总数上限,**默认 50**,范围 **0..500**,**0=不限制**;env 通道 `WB_CONV_MAX_PER_PROJECT`。
2. workbench-ai-config.mjs:`getMaxRunningConversationsConfig(db, envRaw)` / `getMaxConversationsPerProjectConfig(db, envRaw)`——语义逐字同 `getMaxStepsConfig`(缺键/垃圾值 → env → 默认;范围内整数才采信);`validateMaxRunningConversations` / `validateMaxConversationsPerProject` 同 `validateMaxSteps`(null/undefined=不修改);导出 `MAX_RUNNING_CONVERSATIONS_RANGE = {lo:0, hi:20}`、`MAX_CONVERSATIONS_PER_PROJECT_RANGE = {lo:0, hi:500}`。
3. admin GET `/api/admin/workbench-ai-config` 回显两键已解析值(所见即所发);PUT 校验后 `setSetting` 落键(与 maxSteps 同一位置同款接线)。
4. conv 路由判定(触发 run 前现读,即时生效):
   - **create**:两道都查——该用户 running 会话行数(`status='running'`,按 userId,DB count,重启安全)达并发上限 → 429;该用户在该项目的会话总数达上限 → 429。
   - **messages / regenerate / edit**(凡把会话转入 running 的端点):查并发上限一道,计数**排除自身会话行**(自身 running 行属取代语义,不占新名额;对空闲会话 regenerate/edit 则如实占名额);不查总数。
   - 超限响应:`429` + i18n message,**文案包含当前生效的上限值**(并发例:「并发运行中的对话已达上限(N),请等待运行结束、取消部分对话,或在 AI 配置中调高上限」;总数例类似,提示可删旧会话)。admin 不豁免(统一门,0=不限制为逃生阀)。
5. 前端 AI 行为面板:maxSteps 输入旁加两个数字输入(label + 「0=不限制」提示),GET 回显 / PUT 随表单提交;vitest 组件测试各一;zh/en i18n 键补齐。
6. 前端 429 展示:WorkbenchChat 触发 run 的既有错误链路若已展示服务端 message 则零改动;否则接入 chatErrors 既有展示链。手测清单写入报告。
