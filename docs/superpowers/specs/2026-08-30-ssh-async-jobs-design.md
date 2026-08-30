# SSH 异步任务层设计——AI 对托管服务器的长时/交互/大输出命令执行

日期:2026-08-30
状态:已评审(方案 A + 交互形态=任务+stdin,用户已确认)
关联:`server/ssh/agent-bridge.mjs`(现有同步 SSH 桥)、`server/tool-registry.mjs`、`server/workbench-prompt.mjs`

## 0. 背景与根因

用户诉求:AI 要能对平台托管的 SSH 服务器做真实运维(装包/构建等长时命令、安装器/REPL 交互应答、大输出日志分析)。

排查发现的现状分三层:

1. **同步 SSH 桥已存在且已推 origin/main**:`wb_ssh_exec`(一次性命令,30s 默认/120s 上限,stdout 截 32KB)、`wb_ssh_read_file`(SFTP)、`read_server_ledger`/`write_server_notes`(台账)。审批策略 per-server(none/readonly/always),凭据对 AI 不可见。
2. **真实缺口**:长时命令跑不完(120s 上限)、交互应答做不了(非交互一次性)、大输出被截断(32KB)。
3. **"AI 说没有 SSH 工具"的真相(P0 bug + 配置缺失)**:
   - 集群部署实例(aboard.liang.home)的库是独立的,里面**没有登记/暴露任何 SSH 服务器**;
   - 但提示词工具文档段(`workbench-prompt.mjs:34` `registry.workbenchTools()`)**不按暴露状态过滤**,无条件列出 4 个 SSH 工具;而实际工具数组(`tool-registry.mjs:211` `sshExposedCount===0` 裁剪)把它们剔除了;
   - AI 处于"能力说明里有、工具列表里没有"的矛盾态,其答复("没有挂载 SSH 能力")是对现状的**精确描述**,不是幻觉。

## 1. 范围

**做**:
- P0:提示词/工具 offering 同源修复(零暴露时提示词不再提及 SSH 工具)
- 异步任务层:5 个新工具,让 AI 能启动长时任务、按需读输出、写 stdin 应答、查列表、终止
- MCP/API-key 通道对齐(keyMode fail-closed 语义沿用)
- admin 任务策略配置(TTL/并发/超时/输出封顶)
- 运维清单(集群实例基线修复)

**不做(非目标)**:
- 真终端附着(逐键操作、与人共屏)
- sudo 长任务(sudo 密码与交互应答抢 stdin;需要时走同步 `wb_ssh_exec`)
- 输出向前端的实时流式推送(AI 按需拉取已够)
- 跨服务器任务编排
- 任务落库持久化(远端文件目录即事实源,见 §4)

## 2. P0:提示词与工具 offering 同源

**现状**:`buildWorkbenchSystemPrompt` 的只读/需人审工具文档段只按 `disabledTools` 过滤;SSH 4 工具(`wb_ssh_exec`/`wb_ssh_read_file`/`read_server_ledger`/`write_server_notes`)在零暴露时仍被写进提示词。

**修复**:
- `sshServers` 清单为空时,工具文档段同步剔除 SSH 4 工具——与 `workbenchExcludeTools` 的 `SSH_HIDDEN_TOOLS` **同一事实源**(从 tool-registry 导出该常量或谓词,禁止第二份名单)。
- admin 生效预览端点(`workbench-conversations.mjs:131` `effectivePrompt`)经同一函数自动修复。
- 同文件 `:132` 透明面板 `tools:` 列表(`registry.workbenchTools()`)应用同款剔除(按 `sshPromptServers().length`)。

**测试**:零暴露时生成的提示词不含任何 SSH 工具名(prompt 快照断言);有暴露时包含;透明面板 `tools` 列表同语义。

## 3. 架构与远端布局

新增 `server/ssh/job-bridge.mjs`,与 `agent-bridge.mjs` 同构:全部操作都是**一次性 exec**(复用现有连接池/审批/审计/超时/截断原语),网关不为任务持有任何长连接。

每个任务在远端占一个目录,**远端文件目录即事实源**(网关重启后可重新发现):

```
/tmp/.ab-job/<jobId>/        # jobId = 网关生成 uuid;路径拼接前强校验 ^[a-f0-9-]{36}$(防路径注入)
  in     # fifo(stdin)。wrapper 以 O_RDWR 持有 fd,防读端 EOF 与写端阻塞
  out    # stdout+stderr 合流;经 dd 计数封顶(默认 64MB),防 /tmp(tmpfs)爆盘
  code   # 退出码文件;存在 = 任务已结束(权威结束信号)
  pid    # setsid 会话首进程 pid(整组可 kill)
  meta   # JSON:{jobId, projectId, startedAt, timeoutMin, maxOutMb}
```

**启动语义契约**(单次 exec 完成;精确引号拼装交由实现+单测,使用现有 `shQuote`):
- `mkdir -p` + 写 meta + `mkfifo in`;
- `setsid sh -c '…' &` 脱离会话后台执行,`echo $! > pid`;
- 内层命令包 `timeout --kill-after=10 <timeoutMin>m`——**寿命上限在远端强制**,网关死亡任务也按时终止;
- 命令退出码经 sidecar 文件精确落 `code`(不能用管道右端的退出码;`out` 被 dd 封顶触发 SIGPIPE 杀命令时,`code` 如实记录 141);
- stdin:内层 `exec 9<> in` 后 `<&9`。

**读输出契约**(单次 exec,二进制安全):stdout = `tail -c +<offset+1> out | head -c <maxBytes>` 的原始字节;stderr 边带一行 `AB_SIZE=<out总字节> AB_RUNNING=<0|1> AB_EXIT=<code或空>`(运行中判定 = 无 `code` 文件且 `kill -0 $(cat pid)` 成功;**无 code 且 pid 已死/缺失** → dead/unknown,exitCode 如实报 null)。**fileSize 以 AB_SIZE 为权威**,AI 据此推进 offset。

**写 stdin 契约**(单次 exec):`sh -c 'exec 9<>"<D>/in" || exit 3; printf "%s\n" <shQuote(text)> >&9'`;O_RDWR 打开永不阻塞;exit 3 = fifo 已不存在(任务已清理/结束)。

**终止契约**(单次 exec):`kill -TERM -- -<pid>` → 睡 1s → `kill -KILL -- -<pid>`(负 pid = 整进程组);返回 `{ok}`;被杀任务 `code` 不会出现,状态如实呈 dead/unknown。

**列任务契约**(单次 exec):遍历 `/tmp/.ab-job/*/` 输出 jobId+结束态,网关与内存 map 合并补 projectId/起始时间;跨网关重启的孤儿任务靠它重新发现。

## 4. 数据流与生命周期

```
启动 wb_ssh_run ──→ 立即返 {jobId, pid}
  │
  ├─ AI 轮询 wb_ssh_job_out(offset 自推进)→ 增量输出 + AB_RUNNING/AB_EXIT
  │     └─ 需要应答时 wb_ssh_job_write(一行一写,自动补 \n)
  │
  ├─ 异常时 wb_ssh_job_kill(免审止损)
  │
  └─ 结束(code 出现)→ 读尾块 → TTL 扫描清目录
```

- **TTL 清理**:挂靠现有 reap sweep 定时器;对有任务的服务器 exec `find /tmp/.ab-job -maxdepth 1 -type d -mmin +<ttlMin> -exec rm -rf {} +`。默认 120min。
- **并发上限**:每服务器**运行中**任务 ≤4(远端目录数-已完成数),启动时校验,超限报错。
- **轮询节奏**:由 AI 自行决定(promptHint 给建议:2-5s);平台不推送。

## 5. 工具面与审批语义

5 个新工具,零暴露时随现有 `SSH_HIDDEN_TOOLS` 整组隐藏:

| 工具 | 静态 requiresApproval | 动态(dynamicApproval) | 语义 |
|---|---|---|---|
| `wb_ssh_run {server, command, timeoutMin?, maxOutMb?}` | true | none→免审;readonly→`classifyReadonly` 过则免审否则人审;always→人审 | 启动时**一次性**审批;timeoutMin 默认 30 钳 1..120,maxOutMb 默认 64 钳 1..512 |
| `wb_ssh_job_out {server, jobId, offset?, maxBytes?}` | false | —(免审) | 读已批准任务的产出;maxBytes 默认 16384 钳 1..32768 |
| `wb_ssh_job_write {server, jobId, text}` | true | none→免审;readonly/always→人审 | 应答改变执行流,中高策不下放;text ≤4KB |
| `wb_ssh_job_list {server}` | false | —(免审) | 发现/重连 |
| `wb_ssh_job_kill {server, jobId}` | false | —(免审) | **安全动作**:止损不应被审批卡住;恒审计 |

**MCP/API-key 通道**:`wb_ssh_run`/`wb_ssh_job_out`/`wb_ssh_job_list` 加入 `SSH_KEY_TOOLS`(authorize.mjs)与 mcp.mjs 分派;keyMode fail-closed 映射沿用现有桥(`always`→拒 run;`readonly`→run 仅白名单命令)。`wb_ssh_job_write`/`wb_ssh_job_kill` 仅工作台(keyMode 无人审,与 `write_server_notes` 同理由)。

**审计**(agent-runner `WRITE_TOOLS` + `wbAuditIntent`):run/write/kill → verb `write`,out/list → verb `read`;resource = `SshJob/<jobId>` + server 归因沿用 `args.server` 分支。

## 6. 错误处理与边界

- **非 Linux 远端**(无 `setsid`/GNU `timeout`,如 macOS/BSD):启动即失败,错误文案明确指向"异步任务仅支持 Linux 服务器"。
- **jobId 校验**:严格 uuid 正则,不匹配直接拒(路径拼接注入防线);jobId 与 server 不匹配(跨服务器错配)报明确错误。
- **out 不存在/目录已清理**:job_out 返回明确错误(TTL 已清/AI 需重跑),不静默空串。
- **封顶触发**:`code=141` + meta 标记 `outCapped`,AI 可见(promptHint 说明:超大输出应在服务器侧过滤后再跑)。
- **网关重启**:内存 map 丢失不丢任务;`job_list` 以远端目录重建。
- **同兼容语义**:错误只含 exitCode/stdout/stderr/durationMs,绝不含凭据;not-exposed/not-found 文案与现有桥一致(不回显 host)。

## 7. 测试

1. **纯函数单测**:启动命令拼装器(含引号/封顶/timeout 注入)、stdin 写命令、stderr 边带解析、offset/fileSize 推进、TTL 扫描选择、jobId 校验。
2. **bridge 集成测试**(沿用 agent-bridge.test.mjs 假 pool/client 模式):5 工具 × 三策略 × keyMode 矩阵;审批门(含 sudo 真值语义不回归)。
3. **注册表守卫**:`SSH_HIDDEN_TOOLS` 扩容双向守卫;`WRITE_TOOLS` 审计登记;MCP `SSH_KEY_TOOLS` 双向守卫(authorize.test.mjs 模式)。
4. **P0 同源修复**:零暴露提示词快照断言(不含 SSH 工具名)+ 有暴露反例 + 透明面板列表同语义。
5. **e2e 脚本**(沿用 ssh e2e 模式,15 断言风格):真 Linux 环境(可用 kind 节点/本地 sshd)跑 run→write→out→kill→TTL 全生命周期。
6. **门禁**:`npm run i18n:check` 等全绿(本特性预计零新 i18n 键——审批横幅/审计查看器均泛化展示,若实现中新增键则 en/zh 双语齐)。

## 8. 运维清单(集群实例基线修复,非代码)

1. 集群实例镜像更新:SSH 桥已在 origin/main,重新拉镜像 + rollout restart。
2. 在**集群实例**的服务器页登记美国服务器(凭据/sudo 密码)→ 打开"暴露给 AI" → 选审批策略(建议 readonly)。
3. 验证:工作台对话让 AI 调 `read_server_ledger`,有返回即链路通。
4. 顺手清理:本机僵尸网关(PID 2118725,worktree 已删)与僵尸 vite preview(:5199)。

## 9. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 底层机制 | A:远端 shell 原语(fifo+setsid+timeout+dd) | 零远端依赖;与现有桥同构(审批/审计/池复用零改动);B(tmux)依赖远端装 tmux 鸡生蛋;C(网关长连接)重启丢任务+占死连接池+网关缓冲重回截断老路 |
| 交互形态 | 任务+stdin 应答 | 覆盖安装器应答/REPL 批处理;真终端附着过重且与人共屏有隐私/互抢问题,列为非目标 |
| write 审批 | 按服务器策略(none 免审,余者人审) | 应答内容能改变执行流,中高策不下放;none 是服务器主的完全信任声明 |
| kill 免审 | 恒免审 | 止损是安全动作;审批卡止损反而放大事故 |
| out/list 免审 | 恒免审 | 轮询读若是人审则特性不可用;读的是已批准任务的产出 |
| 事实源 | 远端文件目录 | 网关重启可恢复;不引入 DB 持久化(非目标) |
| 输出封顶 | dd 计数封顶,默认 64MB | /tmp 可能是 tmpfs,不封顶有爆内存/爆盘风险;SIGPIPE 杀命令如实记 141 |
| sudo | V1 不支持 sudo 长任务 | sudo 密码与交互应答抢 stdin;需要时走同步 wb_ssh_exec |
