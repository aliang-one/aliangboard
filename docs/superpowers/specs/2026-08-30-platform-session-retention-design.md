# 平台会话保留策略 + 用户中心会话列表分页 — 设计

- 日期:2026-08-30
- 状态:已批准(对话内逐节确认)
- 范围:服务端平台会话(platform_sessions)保留策略;用户中心(UserProfile)会话列表分页

## 1. 问题与根因

用户中心「安全卡 → 活跃会话」列表无限增长:

- **展示端** `src/views/UserProfile.vue`:`/api/auth/sessions` 一次返回该用户全部会话,`v-for` 全量渲染,无分页。
- **数据端** `server/index.mjs`:会话存 `platformSessions` Map + SQLite `platform_sessions` 表。TTL 默认 8h(`SESSION_TTL_MS`),但**过期只在「该 token 再次被使用」时懒删除**(`platformUserFromRequest`)——不再使用的浏览器/设备产生的僵尸会话永不回收,重启还会被 `loadPersistedPlatformSessions` 全量载回内存。
- 没有每用户数量上限,没有任何后台清理定时器。

## 2. 目标

1. 僵尸会话(已过期且不再使用)自动回收,列表只反映仍可能有效的会话。
2. 每用户活跃会话数量有上限,超出自动踢最久未活跃。
3. 会话列表展示分页,过渡期存量堆积可翻页,上限生效后平时单页。

## 3. 服务端设计

### 3.1 新模块 `server/platform-session-reaper.mjs`

纯函数模块,依赖显式注入(Map、db、参数),便于单测:

- `reapExpiredSessions({ platformSessions, db, sessions, now, ttlMs })` → `{ expired }`
  - 判据与现行懒删除**完全一致**:`now - createdAt > ttlMs`(绝对寿命,不改成滑动窗口,不改既有语义)。
  - 命中处理(逐条,单条失败不中断整批):
    1. `platformSessions.delete(token)`
    2. `DELETE FROM platform_sessions WHERE token=?`
    3. **回收 K8s 凭据**:`k8sSessionToken` 存在时 `sessions.delete(k8s)` + `DELETE FROM sessions WHERE token=?`(与改密/吊销路径一致,补齐现有懒删除不做这步的缺口)。
- `enforceSessionCap({ platformSessions, db, sessions, userId, max, keepToken, now, writeAudit })` → `{ evicted }`
  - 取该用户全部会话,按 `lastSeenAt ?? createdAt` 升序;超出 `max` 的从最旧开始踢,`keepToken`(刚登录的会话)永不踢。
  - 被踢会话处理与 reap 相同(内存 + platform_sessions + K8s 凭据回收)。
  - 踢人写审计:`writeAudit(db, { verb: 'revoke', tool: 'platform_session_evict', result: 'ok', requestSummary: 'evicted=N', source: 'platform' })`。

### 3.2 触发点(`server/index.mjs`)

- **启动**:恢复持久化会话(`loadPersistedPlatformSessions`)后跑一次 reap。
- **定时**:60s `setInterval(...).unref?.()`,与现有 SSH terminal sweep(`index.mjs:2109`)同模式;`ttl` 每跳现读(与 SSH 策略同款热更新语义)。
- **登录**:`/api/auth/login`(`routes/auth.mjs`)创建新会话后调 `enforceSessionCap`,`keepToken` = 新 token;模块经既有 deps 注入传入(与 `platformSessions`/`sessions` 同通道),不改路由签名风格。

### 3.3 配置

- `MAX_PLATFORM_SESSIONS_PER_USER`,默认 `10`,`Number(process.env[...] || 10)`,与 `SESSION_TTL_MS` 解析方式同款。
- `SESSION_TTL_MS` 语义不变(默认 8h)。

### 3.4 错误处理

- reap/enforce 内部单条 try/catch,单条失败不中断整批(与现有吊销路径风格一致)。
- 整体 DB 异常:该轮跳过,60s 后重试。
- **登录时 cap 强制失败不阻断登录**(降级为不踢,`console.error` 记日志)。
- `/api/connect-cluster` 复用既有平台会话、不新建,无需挂钩。

## 4. 前端设计(`src/views/UserProfile.vue`)

- 数据源不变:仍一次拉全 `/api/auth/sessions`。
- 新增 `currentPage = ref(1)`、`pageSize = 10`;`v-for` 改渲染切片 `sessions.slice((currentPage-1)*pageSize, currentPage*pageSize)`。
- 复用 `src/components/common/Pagination.vue`(total/pageSize/currentPage + `page-change` 事件;i18n 键已有,零新增文案)。
- 分页条仅 `sessions.length > pageSize` 时显示——上限生效后平时单页不显示,过渡期存量堆积可翻页。
- 排序仍按服务端返回序(`lastSeenAt` 降序,当前会话参与排序)。
- 边界:吊销成功重拉后 `currentPage` clamp 到 `[1, totalPages]`,删空末页不悬空。

## 5. 测试

- 服务端(新 `server/platform-session-reaper.test.mjs`,内存 Map + SQLite,参照 `auth-selfservice.test.mjs` 注入模式):
  - 过期会话被清(内存 + 表 + K8s 凭据三处);
  - 未过期会话保留;
  - cap 超限踢最旧、保留 `keepToken`;
  - `lastSeenAt` 缺省回退 `createdAt`;
  - 单条失败不中断整批。
- 登录路径(扩展现有 `server/auth-selfservice.test.mjs`,该文件已按 deps 注入模式直测 `routes/auth.mjs`):超限登录后旧会话被踢、本会话保留、cap 异常不阻断登录。
- 前端(扩展现有 `src/views/__tests__/UserProfile.test.js`):
  - `> pageSize` 时渲染分页条,翻页切片正确;
  - `≤ pageSize` 不出现分页条;
  - 末页吊销后页码 clamp。

## 6. 不做的事(YAGNI)

- 不做服务端分页 API(数量已被上限收敛)。
- 不做设置页 UI(env 可调已够)。
- 不改 TTL 语义(不改滑动窗口)。
- 不做「登录历史」审计视图。
- 不动 admin 端 UserManagement。

## 7. 手测清单(实现后)

1. 造 >10 个会话(或临时调低 env)登录,旧会话被踢、新会话保留。
2. 人为插入过期行(createdAt 超 TTL)重启网关,启动日志/列表确认被清。
3. 过期行存活期间(未重启),60s 内被定时 sweep 清掉。
4. 用户中心 >10 条时出现分页条,翻页正确;≤10 条无分页条。
5. 末页仅一条时吊销,页码回退不悬空。
6. 被踢会话对应设备的 K8s 凭据失效(该设备请求集群 401)。
