# 工作台 AI 对话审计第二批修复计划(P2×13,6 任务)

来源:2026-09-06 工作台 AI 对话 9 维审计(`~/.gstack/qa-reports/wb-chat-audit-2026-09-06.json`);用户 2026-09-07 批准继续第二批。范围=P2 全量 14 项中仍开放的 13 项(gap1-02 的「每用户/每项目会话数上限」已由第一批 F6 关闭;**TTL/清扫 PARK**——50/项目上限已封顶增长,自动删用户会话属政策决策,另行裁决)。13 项归 6 任务;分组考虑了同文件相邻区域(WorkbenchChat.vue 723-737 互锁区四件归并 BT4;summarize.mjs 两函数分属 BT1/BT5 顺序落地)。

## Global Constraints

(与第一批同款,逐字沿用)
- **TDD**:每项先写红测试再实现;测试红了修实现,禁止改测试迁就实现。
- **门禁**:实现者跑任务相关定向测试;合并前控制器统一跑四道(`npm test` / `npm run test:unit` / `npm run typecheck` / `npm run i18n:check`)。
- **提交**:信息一律英文;禁止改 git config;禁止 `Co-Authored-By` 尾注;**禁止 merge/rebase 到 main**——只在当前 worktree 分支提交。
- **依赖**:零新增外部依赖。本计划不新增端点(发现需要就停下报告)。
- **i18n**:src 禁中文字面量;新键 zh/en 双语补齐。
- **node:sqlite**:绑定 `undefined`/对象直接抛异常;多语句变更用事务。
- **动手前先 `git branch --show-current` 确认在 worktree 分支**;所有 Edit 用 worktree 绝对路径。
- 注释风格:密集中文 rationale,匹配周边密度。

---

## Task 1: compact 水位竞态防护(conv-lifecycle-01)

**背景**:compactConversation(server/workbench-summarize.mjs:71-99)在 L74 入口检查、L77 读 maxSeq、L84-90 await LLM、L93 **无条件落库**。await 窗口内 regenerate/edit 截断(水位被钳回)或会话状态翻转,落库的 summarizedUpTo 可高于未来消息 seq → buildHistory **永久跳过新消息**(数据面永久丢内容)。

**文件**:server/workbench-summarize.mjs;测试 server/workbench-summarize.test.mjs。

**要求**(审计 suggestedFix 为准):
1. 落库前与 maybeSummarize 同款防护:重读 `getConversation(db, convId)`——已不存在或状态翻转为 running/paused → 放弃写;`summarizedUpTo = Math.min(maxSeq - COMPACT_KEEP_RECENT, getMaxSeq(db, convId))` 钳制;写库用条件 UPDATE(WHERE summarizedUpTo=旧值 或 COALESCE 守卫),changes=0 即放弃,防覆写并发摘要。
2. TDD 红:受控 Promise 挂起 LLM → 窗口内 regenerate 截断 → 放行 → 断言 summarizedUpTo 不超过截断后水位、后续 append 的新消息进 buildHistory;同款红:窗口内会话转 running → 不落库。回归:正常 compact 路径与既有 summarize 测试保绿。

## Task 2: 鉴权三处门(authz-entitlement-02 + 03)

**背景**:①edit 与 approve/deny 路由缺 `clusterEntitled` 门(messages/regenerate 有,edit 实测失权 owner 200+run 启动);②`wb_bootstrap_ledger` 工具零授权门,allowlist 非 admin 可经对话触发全集群 survey,与 wb_top nodes 的 clusterWide 拒绝语义不一致。

**文件**:server/routes/workbench-conversations.mjs(edit ~360-418、approve/deny ~573-621)、server/index.mjs(~1345 bootstrapLedger 闭包)、server/tool-registry.mjs(~106-110);测试 server/wbc-downshift.test.mjs、server/wb-tool-gate.test.mjs。

**要求**:
1. edit 与 approve/deny 在 resolveConvProject 通过后补 `if (!clusterEntitled(ps, project.clusterId)) → 403 { message: msg(req, 'wbp.clusterForbidden') }`(approve 的 projectForGate 已在手);与同文件兄弟端点逐字同款。
2. bootstrapLedger 闭包首行加 `gate.clusterWide('wb_bootstrap_ledger')`(open/admin 放行、allowlist 非 admin 拒,与 wb_top nodes 同判;gate 模式参考同文件既有 wb_top/clusterWide 工具)。
3. TDD 红:wbc-downshift 补 assignedCluster:false 下 edit/approve/deny → 403;wb-tool-gate 补 allowlist 非 admin 调 bootstrap_ledger → {error} 拒绝、admin/open → 放行。回归:授权用户全路径 200 不变。

## Task 3: 流与终态·服务端(agent-loop-04 + contracts-02)

**背景**:①chatStream(server/llm.mjs:102-105)静默吞流内 error 事件(JSON.parse 失败 continue / 无 delta continue),空终答也标 done——中途上游故障的半截答案无任何错误提示;②无产出的失败/取消轮上 regenerate 必 400(routes/workbench-conversations.mjs:328-329 removed===0 拒),前端恒亮按钮。

**文件**:server/llm.mjs、server/routes/workbench-conversations.mjs(regenerate);测试 server/llm.test.mjs、server/workbench-conv-routes.test.mjs。

**要求**:
1. llm.mjs 解析层:payload 含 `obj.error` 且无 `obj.choices` → `throw new Error('LLM 流内错误: ' + (obj.error?.message || JSON.stringify(obj.error).slice(0,200)))`——抛出点在已吐 delta 之后,chatWithRetry 不重试,走既有 salvage 保留半截内容并标 failed(与中断保全语义一致)。终态兜底:流结束时 content 空 && 无 tool_calls && 无 finishReason → 抛「LLM 返回空响应」。TDD 红:流内 error 与空流两用例(llm.test.mjs)。
2. regenerate 路由放宽(裁决:服务端单点优于前端绕行):removed===0 但仍存在 user 消息 → 放行(等价原问题重跑,buildHistory 以剩余消息即末条 user 重跑,语义自洽)。TDD 红:失败轮(无 assistant 消息)regenerate → 200 + run 启动;回归:正常 regenerate 保绿。

## Task 4: 前端聊天终态与审批四件(frontend-chat-01 + contracts-01 + contracts-03 + approval-flow-01)

**背景**(均在 WorkbenchChat.vue/ChatTurn.vue,723-737 区互锁,故归一任务):①SSE 主路径 done 后 turn.content 恒空——复制按钮对每条刚完成的回答复制空串(ChatTurn.vue:162-168,224);②SSE `status:cancelled` 事件不更新 convStatus,跨实例取消后状态栏恒「运行中」、排队消息永不自动出队(WorkbenchChat.vue:723-726);③审批被他端决策后本实例 Modal 不消失且输入框保持禁用——pendingApproval 在 SSE running/终态与 pollOnce 终态分支均不清空(646-680,735-737);④审批弹窗对 wb_ssh_job_write/write_server_notes 参数盲区,人审退化盲批(282-295,1334-1349)。

**文件**:src/components/workbench/WorkbenchChat.vue、src/components/workbench/ChatTurn.vue;测试 src/components/workbench/__tests__/(WorkbenchChat.sse/queue/approval、ChatTurn.test)。

**要求**:
1. 复制空串:done 兜底处以 trace 末个 assistant 块回填 turn.content(与 ensureFinalTraceBlock 同源语义),或 copyContent 取 `turn.content || 末个 assistant trace 块 content || ''`;用活体 SSE 事件序列(step.assistant + status done)锁 content 形状的测试。
2. SSE 透传:`else if (['done','failed','paused','cancelled'].includes(evt.status)) convStatus.value = evt.status`(hello 同款);**顺带把 737 行数组抽常量**,两处清单共用消漂移。
3. pendingApproval 清空:在上述同一终态条件(status/hello ∈ running/done/failed/cancelled)追加 `pendingApproval.value = null`;pollOnce 的 done/failed/cancelled 分支同款补一行(decidedApprovals 语义不变——决策压制按 toolCallId,清空只撤过期弹窗)。
4. 审批参数渲染:approvalTarget 增加 scope 分支;正文块增加 `args.text`(job_write 应答)与 `args.notes`(台账备注)的 pre 展示(带 jobId 目标行);**无匹配分支的工具兜底渲染 args 的 JSON(截断)**——任何 requiresApproval 工具至少可见完整参数;command 数组 join(' ') 归一后渲染。i18n 新键 zh/en。
5. TDD:四件各先红。回归:既有 sse/queue/approval 测试保绿。

## Task 5: recap 一致性两件(context-assembly-02 + gap2-02)

**背景**:①buildHistory(server/workbench-projects.mjs:353-354)注入 conv.recap 只有头注 caveat、缺尾部作废护栏——毒 recap 护栏未覆盖全部注入点;②setProjectRecap 人工清空/覆写可被在途摘要击穿:清空的毒 recap 被复活、人工精编被静默覆盖(416-425)。

**文件**:server/workbench-projects.mjs、server/workbench-prompt.mjs、server/workbench-summarize.mjs(maybeSummarizeProject);测试 workbench-prompt.test.mjs、workbench-summarize.test.mjs、workbench-projects.test.mjs。

**要求**:
1. 尾部护栏单源化:抽 workbench-prompt.mjs 导出 `buildRecapInjection(recap)`(头注+正文+MEM_FOOTER 尾部作废护栏),buildHistory 与 buildProjectMemoryInjection 共用;扩展既有静态守卫测试:扫描 buildHistory 不得内联裸 caveat 字面量。
2. recapRev 乐观锁:workbench_projects 加列 `recapRev INTEGER DEFAULT 0`(try-ALTER 在 CREATE 后,迁移同款);setProjectRecap 两分支均 `recapRev = recapRev + 1`;maybeSummarizeProject 读快照时记 rev,条件写追加 `AND recapRev=?`,changes=0 丢弃(与既有水位守卫并列)。
3. TDD 红:①buildHistory 注入含尾部护栏(与 buildProjectMemoryInjection 同源断言);②受控 Promise 挂起摘要 → setProjectRecap('') → 放行 → 断言 projectRecap 仍 NULL、水位仍 0;人工精编同款。回归:正常摘要路径保绿。

## Task 6: refs 健壮性两件(refs-injection-02 + gap3-01)

**背景**:①references 数量/形状零校验(routes/workbench-conversations.mjs:131-161,227,273,382):巨数组慢耗网关+集群 API,每轮 LLM 前全量重拉放大;②项目换绑集群后存量对话 @refs 静默在新集群解析:同名资源串味、缺失误报「已删除」、ResourceCard 恒显旧集群快照、零提示。

**文件**:server/routes/workbench-conversations.mjs(refs 归一+落库盖戳)、server/workbench-agent.mjs(refreshSystem 前比对)、前端 ResourceCard/审批卡(grep 定位);测试 ref-gate/wb-server-ref 相关 + 前端组件测试。

**要求**:
1. 入口统一归一 references(单一辅助函数,create/messages/edit 三入口共用):条数上限 **20**(与搜索 slice(0,50) 同量级)、元素必须对象且 kind/namespace/name 为 string、总字节数上限 **64KB**;超限/畸形 → 400 i18n message(而非静默截断——静默丢引用会让 AI 上下文与用户所见漂移)。
2. 换绑锚定(裁决:显式作废优于静默清出——保留历史透明度):references 落库时盖 `clusterId` 戳(创建/续接消息时取 project.clusterId);run/resume 装配 refreshSystem 前比对 ref 戳与当下 project.clusterId,不一致 → 该 ref 停用并在注入上下文加「(引用创建于集群 X,项目已换绑,已停用,请让用户重新 @)」注记,不静默重解析;ResourceCard/审批卡补来源集群标识(i18n)。老行无戳:视作当前集群(向后兼容,不炸存量)。
3. TDD 红:①26 条/非对象元素/70KB → 400;②换绑后旧 ref 不再重拉、注入含作废注记、ResourceCard 显示来源集群;③老行无戳路径不回归。回归:refs 相关既有测试保绿。
