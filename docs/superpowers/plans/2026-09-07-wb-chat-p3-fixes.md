# 工作台 AI 对话审计第三批修复计划(P3 清账,36 项/7 任务)

来源:2026-09-06 审计(`~/.gstack/qa-reports/wb-chat-audit-2026-09-06.json`);用户 2026-09-07 批准继续第三批(P3 全量清账)。

**已由前批顺带关闭(不重复修,终审核对)**:refs-injection-03(references:[null]→BT6 归一门 400)/refs-injection-07(edit 伪造 resource→BT6 白名单+归一)/gap3-04(approve/deny clusterEntitled→BT2)/contracts-07 与 gap1-03 同根(本批 PT2 一并修)。

**半关闭残余**:refs-injection-06——BT6 关了 conv 级与客户端面,但 message 级 resource 落库/回传仍无大小上限(PT7 收口)。

## Global Constraints

(与前两批同款,逐字沿用)TDD 先红;实现者跑定向测试,合并前控制器跑四道门禁;英文提交/禁改 git config/禁 Co-Authored-By/禁 merge 到 main;零新依赖;无新端点;i18n zh/en 双语禁 src 中文面;node:sqlite 绑定纪律+多语句事务;worktree 分支+绝对路径;密集中文 rationale 注释。

---

## Task 1 (PT1): 路由健壮性七件(全在 server/routes/workbench-conversations.mjs 及其服务函数)

1. **conv-lifecycle-04** 续接/编辑/成功 done 不复位 conv.error——messages(~L302)与 edit(~L403)的复位 patch 补 `error: ''`(regenerate 已有,对照同款);测试:failed→append 成功→error 为空。
2. **cancel-races-06** approve/deny 无 try/catch——包 try/catch 与兄弟端点对称(CAS 翻 running 后 stampApprover/writeAudit/createLlmClient 抛错→500 而非悬挂 running);测试:stampApprover 抛错→500 且对话不悬 running(回滚或明确终态)。
3. **conv-lifecycle-07** compact 与 PATCH rename 无 try/catch——readBody 413/400 被全局兜底改 500;包同款 try/catch 保留状态码语义。
4. **conv-lifecycle-05** 写路径非事务×3——create(setActive/append)、messages(append/置 running)、regenerate(截断/置 running)改事务(对照 DELETE 既有事务模式);测试:中途抛错→无孤儿行。
5. **conv-lifecycle-09** listConversations 回传全文——列表 SELECT 剔除 content/userMessage(保留 title/status/updatedAt/计数),消费端核对(前端列表只用哪些字段先 grep 再删);测试:列表响应无 content 字段。
6. **conv-lifecycle-11** active 列表 LIMIT 先于 owner 过滤——SQL 改「owner 过滤后 LIMIT」或按 owner 分组保证非 admin 的 running/paused 恒在;测试:他人 10 条 running 挤不出自己的 running。
7. **contracts-10** rename 服务端截断 100 字符客户端回填原文——服务端返回截断后标题(或客户端截断同款),两侧一致;测试:200 字 rename→响应/回读一致。

## Task 2 (PT2): 鉴权与可观测四件

1. **conv-lifecycle-10** SSE 建连后不重验——keepalive 周期重验 requirePlatform+ownership(会话吊销/项目收权→关闭流);测试:吊销后 keepalive 一拍内连接被关。
2. **authz-entitlement-06** 生命周期写操作零审计——create/messages/regenerate/edit/DELETE/cancel 补 writeAudit(kind=wb_conv 类,action+convId;approve/deny 已有);测试:各动作审计行落链。
3. **authz-entitlement-07** 404/busy-400 先于 ownership-403——单对话端点(messages/regenerate/edit/GET)统一 ownership 判定前移(非 owner 恒 403,不泄漏存在性);测试:非 owner 对不存在会话也 403。
4. **contracts-07(含 gap1-03)** 文件头权限注释过时+前端三入口旧口径——注释对齐 Phase D(requirePlatform+owner);前端聊天入口(工作台 FAB/Agent-mode 三重门)按服务端实际门放行(platform 会话即可见;@server 搜索端点若 route-auth-map 仍 admin 则其入口保持 admin);i18n 键随迁;测试:非 admin platform 用户见聊天入口(组件测试),守卫静态扫描注释口径。

## Task 3 (PT3): 流与总线卫生四件

1. **agent-loop-05** chatStream 无总时限+取消不 abort——加总时限常量 **10 分钟**(流式足够宽松,超时抛错走既有 salvage);cancelConversation 接 AbortController 主动 abort 在途 fetch(与 epoch 不 bump 语义正交——abort 只断流,保留分支照常);测试:滴流桩超时→failed+partial 保留;cancel→fetch aborted。
2. **cancel-races-05** SSE 重连丢字窗(检查点滞后 ≤200 字/500ms)——hello/重连快照前若该会话 run 在途,同步 flush 一次 tracker checkpoint 再读库(窗口归零);测试:流式中途重连 hello 快照含全量已出文本。
3. **cancel-races-07** conv-bus 快照死代码——grep 确认无消费方后删除快照维护(emit 每事件维护 256 会话全量快照);同步 conv-bus 测试;若 hello 快照(PT3.2)需要它则改为按需读库(与 2 协调:2 的实现走 DB,快照机制可全删)。
4. **cancel-races-08** SSE send() 无背压——res.write 返回 false 即 end 该连接(慢消费者主动断开,客户端既有重连机制接管);测试:write false 桩→连接关闭。

## Task 4 (PT4): 上下文与记忆八件

1. **context-assembly-03** recap 无长度硬钳——写点统一 clamp **64KB chars**(setProjectRecap/maybeSummarize/compact 三写点);测试:超长→落库为截断值。
2. **context-assembly-04** 未绑集群项目提示词列 16 个被剔除 K8s 工具——提示词工具段与实际 offering 同源(FIXED 断言改活源;与 SSH 维度同修法);测试:未绑集群→提示词无 K8s 工具段。
3. **context-assembly-05** estTokens chars/2 中文低估 ~2 倍——CJK 感知估算(cjk≈1 token/char,其余≈1/4 char),trimBudgetChars 校准;测试:纯中文/纯英文/混合三态预算判定。
4. **context-assembly-06** effectivePreview 缺 sshServers——admin 预览 GET 传 sshServers,与「所见即所发」对齐;测试:预览含 SSH 服务器段。
5. **context-assembly-07** regenerate 后 history 重复落同一提问——appendHistory 去重(同 ts/同文本不再落);测试:regenerate→history 单条。
6. **context-assembly-08(含 gap2-03)** 摘要水位 `ts > watermark` 同毫秒跳过——改 `>=`(配合唯一性或 (ts,seq) 键防重摘);测试:同毫秒两行都被摘要。
7. **gap2-01** maybeSummarizeProject 无 per-project in-flight 去重——内存 in-flight Set(单进程语义,run 结束清除);测试:并发两触发→一次 LLM。
8. **gap2-04** 摘要失败全链路静默——内层 catch 与三处 `.catch(()=>{})` 补 console 日志(或统一 logger 惯例,grep 仓库日志惯例);不改语义只补可见性。

## Task 5 (PT5): 前端七件(WorkbenchChat.vue 为主)

1. **contracts-09** 新发 user turn 恒 messageId:null(编辑按钮不可用)——前端以响应/本地生成稳定消息标识回填(或服务端响应带消息行 id,若 append 响应形状易扩则服务端优先;二选一,实现者按侵入度裁决并记录);测试:发送后立即可编辑。
2. **approval-flow-02** paused 无取消入口+审批死局——前端 paused 态加「取消会话」按钮(调既有 cancel 端点);LLM 配置缺失的 approve 400 文案明确化+「拒绝」恒可用(deny 不依赖 LLM,服务端核;若依赖则去依赖);测试:paused 可取消;无 LLM 配置 deny 成功。
3. **frontend-chat-03** startStick 观察错元素——粘底观测改观察流式消息容器(实现者按 DOM 结构修正);测试:流式增长触发粘底。
4. **frontend-chat-04** esErrCount 不清零——onmessage 成功即清零(或滑动窗口);测试:5 次重连成功后一次瞬时错误不再永久降级。
5. **frontend-chat-07** stopRun 覆盖未发送草稿——回填 user 消息前保留当前草稿(仅当输入框为空才回填,或草稿先存再恢复);测试:草稿在 stopRun 后幸存。
6. **frontend-chat-09** stale paused 快照锁死(批二 fix-wave 后残余)——核现状:降级轮询下 paused 与 decidedApprovals 对齐后恢复轮询/看门狗+黄条重开入口;测试:他端决策后本端恢复可用。
7. **frontend-chat-11** clearChat 死代码+孤儿键——删除函数与 zh/en 键;i18n:check 绿。

## Task 6 (PT6): 响应契约两件

1. **contracts-08** edit 响应不回传 references——对齐 append/create(带 stamped references);测试:edit→ResourceCard 即时保留;前端若读该字段则回归绿。
2. **context-assembly-06 归位**:见 PT4(实现时若发现 admin.mjs 响应与前端预览组件耦合,归本任务处理——二选一落位,台账记录)。

## Task 7 (PT7): 换绑协调与 refs 收尾五件(fable)

1. **gap3-03** 解绑/换绑与在途对话零协调——解绑/换绑端点对该项目:running 会话 bump epoch 中止(状态 failed+原因「项目集群已变更」)、paused 会话 pendingApproval 失效(拒绝语义);测试:换绑→在途 run 停、paused 审批失效。
2. **gap3-02** 已批工具按裁决快照对新集群执行——pendingApproval 盖 clusterId 戳(裁决时),resume 执行前比对当下 project.clusterId,不一致→拒(错误明确「集群已换绑,请重新发起」);测试:换绑后 approve→工具不执行。
3. **refs-injection-04** @server 搜索 host 过滤参与 q 匹配(脱敏 oracle)——host 改等值过滤不参与 q 模糊(q 只匹 name/description);测试:host 子串作 q 不再命中。
4. **refs-injection-06 残余** message 级 resource 无大小上限——resource 落库/回传 clamp **64KB**(截断+truncated 标记,ResourceCard 显示截断提示 i18n);测试:1MB ConfigMap→64KB 落库。
5. **refs-injection-08** refs 块语法文档与 strip/scrub 解析器不识别现役 FENCE 行——对齐三处(提示词文档块格式/strip/scrub)识别现役格式,守卫测试锁「两道防线识别现役块」。
