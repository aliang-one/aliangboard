# SSH/终端生命周期架构方案(v2 — 已吸收对抗评审 25 条,2026-09-05)

> 状态:定稿待实施。v1→v2 变更:吸收对抗评审 5×P0/9×P1/11×P2(评审记录见
> `wf_67f0e89d-766`)。三条边界:终端身份 ≠ 连接身份;服务端唯一状态机;
> 远端 tmux = 持久 shell。

## 0. 背景与不变式

三轮事故/复审(2026-09-04~05)确认:半开泄漏、刷新静默建 shell、弹窗登录吞 chip、死 chip 盲区、
旧 channel 延迟 close 误删新会话、快速 F5 被属主拆会话——全部源于三类状态混居:浏览器
localStorage(窗口元数据)、网关内存 Map(registry/attached 计数)、真实 SSH 通道。
已落地止血(closeIf 身份校验、入口哨兵、双振心跳、死 chip 置灰、merge-on-write+删除墓碑、
401 探针+登录回跳、关闭语义收敛)全部保留并吸收;本方案不推翻,而是收编。

**项目级不变式(CLAUDE.md)**:网关单进程 + 单 SQLite 库(WAL 沿用);多实例 = 状态外移 ADR,
本方案非目标;依赖政策不新增外部依赖;WS 路由鉴权走既有升级门;提交作者 aliang-one、无尾注。

## 1. 身份模型

| 身份 | 语义 | 生成方 | 生命周期 |
|---|---|---|---|
| `terminalId` | 终端长期身份 | 服务端签发 UUID | 创建 → CLOSED(记录保留 7d) |
| `connectionId` | 单次 WS 连接临时身份 | **客户端**每 socket 新生成;P1 仅作 service 内部幂等键(用 ws 对象),P2 起进 query | 连接建立→断开 |
| `socket_label` | 远端 tmux server 的 `-L` label | `'abt-'+sha256(serverId+'|'+ownerId+'|'+instanceNonce).slice(0,8)`,instanceNonce 为**库级持久 nonce**(settings 表一次性生成) | 永久(禁止从任何 token/用户名等可变值派生) |
| `backendSession` | tmux 会话名 | `ab-t-<instanceNonce6>-<tid 前 12 位>`,由 service 单点派生落库,调用方不得传入 | 与终端同生共死 |

规则:
- SSH 侧一切 tmux exec(attach/kill/ls/has-session/capture)收口到唯一构入口
  `sshTmuxArgv({op, socketLabel, name, ...})`,保证 `-L <socket_label>` 全链一致,
  **绝不使用远端默认 tmux server**。
- DDL:`UNIQUE(server_id, backend_session)`;`socket_label` 入表(持久字段,非派生)。
- connectionId 复合键规则:attachments 结构恒为 `Map<terminalId, Map<connectionId, {socket, attachedAt}>>`,
  绝不建全局 connId 索引。同 tid 下 connId 已存在且 socket 不同 → 旧 socket `ws.close()`(接管);
  跨 tid 同 connId → 拒绝并回协议错误;connId 不得写入弹窗 URL/localStorage(弹窗确定性复用
  靠 terminalId + window.name)。

## 2. 状态机(TerminalService 独占写)

```
CREATING ──backend ready+首 attach──▶ ATTACHED
CREATING ──abandon 且无等待者──▶ LOST('create-abandoned')
CREATING ──abandon 且有等待者──▶ CREATING(交棒)
ATTACHED ──最后一个 attachment detach──▶ DETACHED
DETACHED ──任一 attach──▶ ATTACHED
DETACHED ──阶段一超时──▶ DETACHED_TIMEOUT(tmux 保留)
DETACHED_TIMEOUT ──任一 attach──▶ ATTACHED(清 detached/backend_idle 锚点)
DETACHED_TIMEOUT ──阶段二超时且 claimClose 成功──▶ CLOSING
CLOSING ──kill tmux 完成且 has-session 复核无会话──▶ CLOSED
CLOSING ──kill 失败/远端不可达/会话已不在──▶ DETACHED_TIMEOUT(回滚 + last_error + 审计 reap-aborted)
ATTACHED/DETACHED/DETACHED_TIMEOUT ──远端 shell 确认退出或 backend 不可用──▶ LOST
CREATING ──建链失败──▶ LOST(记 lastError)
任意非 CLOSED ──用户显式关闭(force)──▶ CLOSED(kill tmux)
```

七操作(全部幂等;**独有写者**,其余入口禁止裸 Map.delete/channel.close):
`create`(单飞)/ `attach(tid, connId, socket)` / `detach(tid, connId, reason)` /
`abandon(tid, connId)` / `close(tid, actor, {force})` / `markLost(tid, reason)` / `touch(tid, connId)`。

- **abandon**(复审二 P0):仅 status===CREATING 生效——waiters>0 则 no-op 交棒
  (ready 后转 DETACHED,detached_since=now);否则取消在途创建(关 channel + release +
  LOST('create-abandoned'))。非 CREATING 等价 detach。
- **创建单飞不变式**:`getOrCreate(tid, creator)` 同 tid 返回同一在途创建 promise;
  2026-08-28 的首连竞态守卫由 service 结构性保证,不再依赖调用方比对 extra.ready。
- **attach 状态前置**:返回 `{ok, status, reason}`。status ∈ {CLOSED, LOST, CLOSING}
  直接拒绝(不触达 SSH、绝不隐式 new-session);CREATING → 登记 waiters 等同一 ready;
  DETACHED/DETACHED_TIMEOUT → 唤醒(清锚点)。LOST chip 只提供「重新创建」与「关闭」。
- **CAS 规则**(复审二):所有带 await 的转换必须「先同步预留终态(claimClose 等,JS 单线程
  同步完成),await 返回后二次确认 status 仍为自己预留的值才落终态」。
- **attachment 结构**:`Map<terminalId, Map<connectionId, {socket, attachedAt}>>`(复合键)。
- 资源不变式:LOST/CLOSED 的进入路径必须同步 `releaseBackend()`(关 channel + pool release +
  ring 丢弃);记录保留 7d 供 UI 说明。
- 审计分级(复审二 P2):audit_log 链只记不可逆/有损转换(首次 ATTACHED、*→CLOSED、*→LOST、
  二段回收含 idleMs/锚点、显式 DELETE、手动 kill、属主拒绝);高频 attach/detach 落行内字段
  (`last_attach_at`/`last_detach_at`/`attach_count`)+ 非持久 `onTransition(cb)` 钩子供测试。

## 3. 生命周期判定(二段式回收 + 残留清扫)

| 阶段 | 策略键(admin 可配,0=禁用) | 动作 | 用户可见 |
|---|---|---|---|
| 阶段一 | `ssh.session.detachedIdleMin`(沿用,默认 10) | → DETACHED_TIMEOUT;tmux 保留 | chip 灰蓝「已休眠·进程保留至 {deadline}」 |
| 阶段二 | `ssh.session.backendIdleMin`(**新键,默认 10080=7 天**,0=永留;上限沿用 SESSION_POLICY_MAX_MIN) | claimClose → CLOSING → kill tmux → CLOSED | chip 摘除(记录保留 7d) |

- 锚点双字段(复审二 P1):`detached_since`(进 DETACHED=now,任一 attach=null)、
  `backend_idle_since`(进 DETACHED_TIMEOUT=now,任一 attach=null)。阶段一判定只看
  detached_since;阶段二只看 DETACHED_TIMEOUT 态的 backend_idle_since。
- **boot 对账**:`reconcileOnBoot()` 在 listen 之前跑——ATTACHED/DETACHED* → DETACHED 且
  detached_since=backend_idle_since=bootAt(不探测不建连,尊重 lazy;last_active_at 保留,
  阶段二锚点不被顺延)+ 审计;CREATING → LOST('gateway-restart')。
- **残留清扫三层防线**(复审二 P0/P1):
  1. sweep 只枚举 catalog 中 `DISTINCT socket_label`,逐 label `tmux -L <label> ls`;
  2. kill 判定:`!row || row.status ∈ {CLOSED, LOST}`(DETACHED_TIMEOUT 豁免);
  3. kill 前二次取证(全局无同 backend_session 活行)+ kill 后 has-session 复核,
     仍存活则不得标 CLOSED,回退原状态记 last_error。
- 三道闸(复审二 P2):只扫有活连接的服务器(pool.hasLive,复用 refs>0 的 client,零握手);
  per-server 失败退避 10min;单轮并发上限 2 + 整轮墙钟上限;`tmux ls` 失败一律按「本轮未知」
  处理(既不清也不标 LOST),失败计数入观测。pod 侧 `ab<hash>-<sid>` 命名空间 P4 前不归本 sweep。
- **server 删除级联**:删 ssh_servers 行之前,`service.closeByServer(serverId, 'server-deleted')`
  用尚存凭据逐个 close(杀 tmux);杀不掉的置 LOST + orphanKillFailed 审计。
- markLost 内部做 best-effort kill-session(失败不抛,审计 lost-kill-failed)。

## 4. 后端(远端 tmux = 持久 shell;hub 模型)

- **hub 模型**:每 terminalId 恒只有一条网关侧 tmux 客户端通道(复用 sockets/primary 语义),
  浏览器只做扇出;attach-session 仅创建时执行一次。capture 输出走 **per-connection 帧,绝不入
  ring**(否则第二 viewer 回放重复 + capture 副本永久污染 ring);ring 仅服务 ephemeral 降级路径
  与直播累积。回放时序钉死四步:开 exec channel(cols,rows)→ await 通道 ready/首帧 →
  capture-pane → 发回放 → 切直播(抽 `buildAttachReplay({capture, pending})` 纯函数承接可注入测试)。
- **创建/重建两步走**:`tmux -L <label> has-session -t <name>` → 存在才 attach-only
  (复用 tmuxAttachOnlyCommand 语义);**绝不 `new-session -A`**(会在会话已死时静默新建空会话,
  把已根治的「重连静默建空 shell」以 SSH 形态重新引入)。attach 路径绝不隐式新建。
- conf:路径按 label 隔离(`${dir}/.ab-tmux-<socket_label>.conf`,dir 优先账号 home 下网关
  自建目录,不用共享 /dev/shm);每次「该 (server,label) 未见会话而需 new-session」前重灌
  (-f 只在 tmux server 启动时读取)。二进制上传/写入远端的副作用写 audit_log(verb=upload)
  并在 SSH 服务器台账 notes 登记。
- resolveTmux 失败原因落 `ssh_terminals.last_error` 并经 GET /terminals 暴露 `backendReason`;
  chip tooltip 明示「此服务器无可用 tmux(原因),会话不可恢复」。
- **resize**(复审二 P2):hub 单客户端 pty 为唯一尺寸来源;`window-size largest` 降级为对外部
  attach 者(用户自己笔记本 tmux attach 同会话)的防御。CH_STATE 载荷含 `{cols, rows}`
  (取 `tmux display-message -p '#{window_width}x#{window_height}'`,随生效 resize 广播),
  前端以该值设定 xterm 尺寸。resize 策略按 backend 分派:tmux → per-client;ephemeral →
  保留 primary 仲裁 + CH_STATE 带 primaryConnectionId,非 primary 窗口提示
  「尺寸由另一窗口控制」(i18n ssh.resizeControlledByOther)。

## 5. 持久化(SQLite,单库)

```sql
CREATE TABLE ssh_terminals (
  id TEXT PRIMARY KEY,             -- terminalId
  owner_id TEXT NOT NULL,          -- platform_users.id(稳定主键;username 可删除重建,不可作归属)
  owner_name TEXT NOT NULL,        -- 展示冗余
  server_id TEXT NOT NULL,
  socket_label TEXT NOT NULL,
  backend_session TEXT NOT NULL,
  backend TEXT NOT NULL,           -- 'tmux' | 'ephemeral'
  status TEXT NOT NULL,            -- CREATING|ATTACHED|DETACHED|DETACHED_TIMEOUT|CLOSING|LOST|CLOSED
  title TEXT NOT NULL,
  last_error TEXT,
  idempotency_key TEXT,            -- POST 幂等(部分索引 owner+key)
  detached_since INTEGER,
  backend_idle_since INTEGER,
  last_attach_at INTEGER,
  last_detach_at INTEGER,
  attach_count INTEGER DEFAULT 0,
  status_version INTEGER DEFAULT 0,-- 单调递增,前端廉价 diff
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id, backend_session)
)
```
- **boot 对账**(listen 之前,单进程无并发写者):见 §3。
- CLOSED/LOST 记录保留 7d 后周期清扫;attach/detach 高频事件不入 audit 链(§2 审计分级)。
- pod 终端(terminals 表)本方案不动;catalog 预留 `kind`,统一迁移另立方案(P4)。

## 6. API 与 WS 协议(鉴权:REST 沿用 /api/ssh/ 前缀 admin;WS 升级门 platform 地板 +
   `isSshTerminalAllowed(ps)` 共用谓词收紧——route-auth-map.mjs 注释写明地板与收紧关系)

```
GET    /api/ssh/terminals                       → 本人列表(admin ?all=1,响应带 owner)
POST   /api/ssh/terminals                       {serverId, title?, idempotencyKey?, backend?:
                                                'deferred'(默认)|'immediate'} → 命中幂等键 200 返回
                                                既有行;默认 deferred 只写 catalog 行(毫秒级),
                                                SSH/tmux 建链推迟到首个 WS attach(与 lazy 一致)
POST   /api/ssh/terminals/:id/detach            {connectionId?} → 非破坏性动词:只摘 attachment
                                                (带 connId 摘自己,不带摘全部;admin ?all=1 可代摘)
DELETE /api/ssh/terminals/:id?confirm=tmux      → 显式销毁:无 confirm → 409;软护栏:ATTACHED 且
                                                now-last_active_at<60s 且非 force → 409 terminal-active
                                                (前端转二次确认,携带 title/activeMs/不可逆警示)
WS     /api/ssh/terminal?terminalId=&connectionId=&proto=2
```
- CH_STATE 帧号 = **7**,载荷 `{status, reason, lastError, attachedCount, backend, cols, rows,
  statusVersion}`;记录进 index.mjs 帧常量注释;协议版本走 query `?proto=2`(不占帧字节)。
- **旧客户端降级契约**(非 shim):WS 升级门对带旧 `?sid=` 的连接回稳定机读帧
  `CH_STATE{status:'CLOSED', reason:'protocol-retired'}` 再关;`proto<2` → CH_ERROR
  `{code:'protocol'}` + close;前端对 code:'protocol' 渲染「网关已升级,请刷新」并停止自动重连。
- 限额:`SSH_TERMINAL_MAX_PER_OWNER`(env,默认 10)+ 全局在途 CREATING 上限,超限 409
  附已存在列表。
- 兼容:**硬切换**(网关+前端同 tag 锁步)。sid 键控面迁移表(逐项):popupUrl
  `?terminalId=`、SshTerminal prop、任务栏数据源、布局键、墓碑键、mappings——见 §7。
- 关闭语义两级动词(复审二 P1):「让窗口消失」= detach(任务栏 ×/会话菜单 ×/closeAll 一律
  detach,不发 DELETE,chip 标「已断开·可唤醒」);「销毁终端」= DELETE 必须过带上下文确认
  (i18n ssh.closeIrreversibleTitle/Body:title + 已运行时长 + 「将终止会话内运行中的进程,
  不可撤销」,按钮 error 色);closeAll 确认按域拆分(ssh 逐台列出将被销毁的终端标题)。
- admin 可见性:孤儿 chip 功能迁移为「catalog 中 status=ATTACHED 且 attachments=0」的异常行
  展示;过渡期保留 GET /api/ssh/sessions 为只读观测端点(P1→P2 对账用),最终去留在 P3 验收裁决。

## 7. 前端契约

- **轮询为主、CH_STATE 为增量**(复审二 P0:无 attachment 时广播目标为空集,CH_STATE 物理不可达):
  `useSshTerminalsQuery(queryKey ['ssh','terminals'], refetchInterval 30s(沿用现 reconcile 节奏),
  refetchOnWindowFocus, retry 3, placeholderData keepPreviousData)`;CH_STATE 到达用
  `queryClient.setQueryData` patch;`status_version` 做廉价 diff;**显式禁止每页一条常驻控制 WS**
  (HTTP/1.1 同源连接预算,仓库发生过 7 连接打爆 6 上限事故)。
- 首帧空窗:localStorage last-known-good 快照(仅 id/serverId/status/title,标 stale:true)先行渲染。
- localStorage 只存布局(位置/最小化/排序,键按 terminalId);一次性导入:每条带
  idempotencyKey='import-<旧sid>'、backend='deferred';导入先载旧墓碑/recentlyClosed,命中即跳过;
  全部 200 后才写 importedV1=1 并把旧 LS_KEY 降级为纯布局 + mappings(同批落盘保原子;任何一步
  失败不写标记,重放幂等)。store 侧 single-flight pendingCreate(Map<key,Promise>),点击先渲染
  乐观 CREATING chip。
- **attachPhase 客户端瞬态覆盖层**(复审二 P2):`'idle'|'attaching'|'live'|'attachFailed'` +
  pendingAttach single-flight(第二次点击只 focus);chip attaching 显示 spinner、失败显示
  「唤醒失败·重试」;attachPhase 永不渲染成服务端状态。
- 徽标四态:ATTACHED=Live(绿)/DETACHED=「已断开·点击唤醒」(中性)/DETACHED_TIMEOUT=
  「已休眠·进程保留至 {deadline}」(灰蓝,剩余时间)/LOST=「已丢失:{lastError}」(error 色,
  不可恢复)。i18n 键 ssh.stateDetached/stateDormant/stateLost + reason×N(服务端消息表 +
  前端 locale 双份,进 i18n:check 门禁)。
- 唤醒统一 `wakeTerminal(id)`(attachPhase=attaching + 建 WS),取代 minimize→restore 触发器
  历史变体。popupSync 职责收缩为 external↔minimized 布局翻转,删除 ssh 分支 GONE_GRACE_MS
  摘记录收尾(与真值重复且会误删);墓碑对 pod 保留。

## 8. 分期交付与验收(验收拆两列:确定性 = node:test + 假 backend;手测 = 真 sshd)

| 期 | 交付 | 验收(确定性) | 验收(手测) |
|---|---|---|---|
| P1 | ① `server/ssh/terminal-handler.mjs`:`createSshTerminalHandler(deps)` move-only 抽取(逻辑零改动);② SshBackend 接口一次定到 P3 面 `{acquire, openShell, exec, hasSession, killSession, capture}`(P1 只实现前两个);③ TerminalService(状态机+七操作+单飞+CAS+boot 对账+注入时钟 `sweep(now)`);④ 全部 7 处清理入口收敛 + terminal-guard 静态守卫测试;⑤ 竞态回归脚本(fakeChannel.emitDeferred 延迟注入,非 sleep) | terminal-guard 静态守卫绿;三条脚本化竞态绿(延迟 close 误删/建连中断开/双 detach);既有 terminal-wire/terminal-sessions 测试零改动通过;新增行为锚点(detach 不再销毁 registry 条目) | — |
| P2 | ssh_terminals catalog + REST 五端点 + CH_STATE(帧 7/proto=2)+ 前端服务端真值 + localStorage 降级 + 导入 + 软护栏/确认分级 + isSshTerminalAllowed | 五端点确定性测试;导入幂等/重放;409 软护栏;协议退役帧;status_version diff | 升级夜三景:存留弹窗标签页/强刷前旧缓存页/升级前关闭过的窗口不复活 |
| P3 | tmux 后端(hub/两步创建/单回放源/二段回收/残留清扫三道闸/网关重启惰性恢复)+ CH_STATE 尺寸 | 二段回收注入时钟毫秒级穷举;回放不重复(双 viewer);清扫谓词表驱动;LOST 脚本化失败注入 | 重启后 attach 原 shell(步骤+判定点手测单) |
| P4(可选) | pod 终端并入 catalog(kind 化);rekey/归属收编;pod 命名空间清扫分派 | — | — |

P1 工作量如实估计:**3-5 人日**(handler 抽取 1 + TerminalService 1 + 竞态脚本 1-1.5 +
sweep/守卫 0.5-1)。

## 9. 测试策略

- 单元:转换表穷举(含 CLOSING/abandon 边);七操作幂等表;attachment 复合键规则;
  teardownOnOwnerGone/closeIf/buildAttachReplay/清扫谓词纯函数。
- 竞态回归:`createSshTerminalHandler(deps)` 注入假 backend + `fakeChannel.emitDeferred('close', n)`
  延迟事件注入(非 sleep):①建连中途断开 ②延迟 close vs 重连 ③双 detach ④唤醒 vs 阶段二
  claimClose CAS ⑤boot 对账。
- 静态守卫:`server/ssh/terminal-guard.test.mjs` 扫描全仓 server 源码,断言
  `sshTerminals.close|closeIf|closeByServer|reapByPolicy` 与 `extra?.channel?.close` 仅出现在
  terminal-service.mjs——「禁止裸操作」从口号变成可验收交付物(复审二 P1)。
- 手测:真 sshd + 合盖/休眠/代理断链 + 升级夜三景(ws-handshake.test.mjs 声明的手工兜底,
  判定点写成手测单)。

## 10. 已裁决事项(原开放问题关闭)

- O1:`SESSION_POLICY_DEFAULT.backendIdleMin = 10080`(7 天,与记录保留、校验上限三方自洽;
  0=永留保留)。五层登记:DEFAULT/resolvePolicy read 表/isValidMinutes 上限/admin routes keys
  数组/面板与 en/zh 文案 + session-policy-routes.test.mjs 枚举。
- O2:**维持 admin-only**。SSH 凭据是每服务器一份共享凭据(无 per-user 隔离),放开普通用户
  = 借 admin 凭据进主机,属独立 ADR;owner 双列(owner_id/owner_name)+ 全破坏性入口带 actor
  断言为放开预留结构。
- 审计分级、hub 模型、connectionId P1 内部化、resize 按 backend 分派:见 §2/§4/§6。

## 11. 已知残留(不假装解决)

- 真实 sshd + 合盖/休眠/代理断链的正向 e2e 仍缺(ws-handshake.test.mjs 头注明文手测兜底);
  本方案以 Injectable SshBackend 的确定性竞态脚本缩小差距,不宣称等同。
- 墓碑/localStorage RMW 非原子:平台固有限制,服务端真值上线后该层降级为纯布局,影响面自然消失。
