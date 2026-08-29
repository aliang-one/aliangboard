# SSH 会话回收策略可配置化 设计

日期:2026-08-29
状态:已评审(用户确认全局粒度 + 四条件全量)
前置:2026-08-29 SSH 会话泄漏审计(观测端点/sid 硬化/任务栏对账已落地)

## 1. 背景与目标

网关当前用固定 `SSH_IDLE_REAP_MS`(env,默认 10 分钟)回收「无人附着且空闲」的终端会话。目标:把自动关闭的**时间阈值**与**条件**做成 admin 可配置,策略改动即时生效,无需重启。

四条件(用户裁定全量支持):

| 条件 | 语义 | 默认 |
|------|------|------|
| 无人附着闲置 | 所有浏览器断开后,会话再闲置 X 分钟才回收(保活回放窗口) | 10 分钟(=现状) |
| 挂机踢 | 有浏览器附着但无活动 X 分钟也回收(清「挂机忘关」) | 关(0) |
| 最长存活硬上限 | 不论活跃与否,X 分钟后必关 | 关(0) |
| 永不自动关闭 | 上三键全 0,会话活到手动终止/网关重启 | —(组合态,非独立开关) |

粒度:**全局一套策略**(用户裁定;SSH 本就 admin-only,不做按服务器覆盖)。

## 2. 策略模型

### 2.1 设置键(platform_settings,整数分钟,0=该条件禁用)

| 键 | 含义 | 默认来源链 |
|----|------|-----------|
| `ssh.session.detachedIdleMin` | 无人附着闲置阈值 | 设置值 > env `SSH_IDLE_REAP_MS`(ms→分钟,向下取整)> 内置 10 |
| `ssh.session.attachedIdleMin` | 挂机踢阈值 | 设置值 > 内置 0 |
| `ssh.session.maxLifetimeMin` | 最长存活 | 设置值 > 内置 0 |

合法域:0–10080(0~7 天)整数。非法值(手改库等)按该键缺省处理并 `console.warn`。

### 2.2 会话活动时钟(两条件口径不同,刻意非对称)

- session 增字段:`createdAt`(ensure 时)、`lastOutputAt`(channel stdout/stderr 输出时)
- 浏览器活动 `lastActiveAt`:输入/resize 时 touch(现状);channel 输出时 `markOutput` 更新 `lastOutputAt`
- **挂机踢口径 = `max(lastActiveAt, lastOutputAt)`**:输出流动即「有事发生」——跑构建 / 看 tail -f 的活会话不被误杀(误杀比泄漏更糟)
- **无人附着口径 = 仅 `lastActiveAt`**:无人看管的会话即便远端仍在输出(无主 tail -f),X 分钟后照收——否则输出续命洞会让「无主忙会话」永生,恰是本特性要堵的泄漏

### 2.3 回收判定(纯函数 `shouldReapSession`)

```
shouldReapSession(session, policy, now) → { reap: bool, reason: 'detached-idle'|'attached-idle'|'max-lifetime'|null }
```

1. `maxLifetimeMin > 0` 且 `now - session.createdAt > maxLifetimeMin*60000` → `max-lifetime`
2. `detachedIdleMin > 0` 且 `session.browserCount === 0` 且 `now - session.lastActiveAt > detachedIdleMin*60000` → `detached-idle`
3. `attachedIdleMin > 0` 且 `session.browserCount > 0` 且 `now - max(lastActiveAt, lastOutputAt) > attachedIdleMin*60000` → `attached-idle`

(1 优先级最高;2/3 按 browserCount 互斥,实际不并存。)

## 3. 服务端改动

### 3.1 registry(terminal-sessions.mjs)

- `ensure` 记 `createdAt = now()`;session 增 `lastOutputAt`
- 新增 `markOutput(sid)`:更新 `lastOutputAt`(channel data 路径调用;与 `touch` 并存)
- `list()` 增 `createdAt`、`lastOutputAt`(观测端点免费获得剩余寿命数据)
- 纯函数 `shouldReapSession(session, policy, now)` 导出,供 sweep 与单测共用

### 3.2 sweep(server/index.mjs,60s 定时器改造)

- 每跳先读策略(`getSshSessionPolicy()`,见 3.3)→ 对每会话跑 `shouldReapSession`
- 命中:`attached-idle`/`max-lifetime` 且有附着浏览器 → 先向附着 sockets 广播 CH_ERROR(本地化文案,含原因)再执行回收;`detached-idle` 无需广播
- 回收动作与现状同:关 channel + 还池句柄 + 审计(`reason` 字段记命中条件)
- 策略读取失败/值非法 → 回落默认并 warn,不得中断 sweep

### 3.3 策略读写 + admin 端点

- `getSshSessionPolicy()` / `saveSshSessionPolicy(patch)`:读写三键;save 前校验(0–10080 整数,越界 400 带 reason);审计 `write ssh_session_policy`
- `GET /api/admin/ssh-session-policy` → `{ detachedIdleMin, attachedIdleMin, maxLifetimeMin }`
- `PUT /api/admin/ssh-session-policy`(body 同形状;**部分更新语义:省略的键保持现值**,仅校验出现的键)→ `{ ok, policy }`
- ROUTE_AUTH:落在 `/api/admin/` admin 前缀内,无需新登记(守卫测试覆盖)

### 3.4 回收告知文案

`ssh.reapedDetached` / `ssh.reapedAttached` / `ssh.reapedMaxLifetime`(zh/en 消息表,WS CH_ERROR 帧用;Accept-Language 取语)。

## 4. 前端改动

### 4.1 API(client.js)

`adminApi.sshSessionPolicy = { get: (), update: patch → PUT }`(照 podfileConfig 模式)。

### 4.2 Settings.vue 新增「SSH 会话策略」卡

- 三输入:分钟数(0=关),占位提示默认值;保存调 PUT;成功 notify
- 说明行:三条规则各一句 + **「全部设为 0 = 永不自动关闭(会话保留至手动终止或网关重启,泄漏风险自负)」**
- 改动即时生效(≤60s sweep 周期),卡片文案注明「无需重启」

### 4.3 任务栏(顺带)

无必改项;`list()` 新增字段暂不消费(YAGNI),后续做「剩余寿命」展示时直接可用。

## 5. i18n

zh/en 各增:`ssh.reapedDetached/Attached/MaxLifetime`(服务端消息表)、`settings.sshSessionPolicy*`(卡片标题/三标签/说明/保存提示)。门禁六项须全 0。

## 6. 测试

| 层 | 用例 |
|----|------|
| 纯逻辑 | `shouldReapSession` 表驱动:四条件命中/未命中;0=禁用;恰超阈;挂机踢输出续命(markOutput 后不命中);**无人附着不受输出续命(无主 tail -f 照收)**;browserCount 互斥;优先级 |
| 服务端 | GET/PUT 策略(空态=默认;PUT 部分键;越界 400;审计落账);env 兜底优先级(`SSH_IDLE_REAP_MS` 仅在无设置值时生效);sweep 挂机踢广播+回收路径(fake 时钟) |
| 前端 | Settings 卡:读取回填/保存/越界 400 展示;adminApi 形状 |

## 7. 非目标

- 按服务器/按用户的策略覆盖(全局已裁定)
- 回收前的宽限期倒计时 UI、任务栏剩余寿命展示(字段已备,后续再说)
- pod 终端(exec WS)的同款策略化——模型不同(一次性 exec),不适用
