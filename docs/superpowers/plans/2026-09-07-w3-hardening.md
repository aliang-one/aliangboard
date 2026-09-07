# Wave 3 安全加固(TOTP MFA + step-up + admin 会话治理 + 个人 kubeconfig)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox steps.

**Goal:** 落地 Wave 3 spec 全部四期——TOTP MFA(自选+强制开关+恢复码)、账户面 step-up、admin 会话列表/强制下线、个人 kubeconfig(网关代理凭据)。

**Architecture:** 零依赖 TOTP 纯模块(node:crypto+手写 base32);登录改两步(mfaTicket 内存票根);平台会话加 mfaPending/stepUpAt 两列;受限 token 在 platformUserFromRequest 单点拦截;kubeconfig 走新 `/api/k8s-proxy/:clusterId/*` 路由族(平台 token→该用户 K8s 会话→复用 Phase B 透传门)。

**Tech Stack:** Node + node:sqlite、node:test;Vue3 + vitest/happy-dom;`qrcode`(npm,依赖豁免 D5)。

**Spec:** `docs/superpowers/specs/2026-09-07-usercenter-wave3-hardening-design.md`(D1-D6 裁决 + §1-§6)

## Global Constraints

- 提交作者 `aliang-one <aliangdone@gmail.com>`(提交前核);英文信息;禁 Co-Authored-By 尾注;worktree 执行 `--no-ff` 合回;**实现者禁自行合并**。
- **唯一新依赖 `qrcode`**(Task 3 落地时 npm i + CLAUDE.md 豁免表登记 rationale=spec D5);其余零新依赖。
- node:sqlite 绑定禁 undefined;try-ALTER 在 CREATE 后;新端点全部 ROUTE_AUTH 登记(守卫测试强制)。
- 兼容红线:未启用 MFA + 开关关(默认)→ 一切行为与今天逐字节一致;存量库升级零感知。
- 消息双语(messages/auth.mjs zh 基准 / admin.mjs);前端键 en/zh 齐;门禁全家 bare。
- 安全红线:mfaTicket 单次 5min;MFA 码端点独立限流(键 `mfa|ip|username`,容量 5/10s 回 1);恢复码 SHA-256 哈希落库、明文仅启用时回一次、登录用即焚;TOTP 比较常数时间。

---

### Task 1: server/totp.mjs 纯模块(RFC 6238)

**Files:** Create `server/totp.mjs`;Test Create `server/totp.test.mjs`
**Interfaces (Produces,后续全消费):**
- `base32Encode(buf: Buffer) -> string` / `base32Decode(s: string) -> Buffer`(RFC 4648,无 padding)
- `generateTotpSecret() -> string`(20 随机字节 → base32,32 字符)
- `otpauthUri(secret: string, username: string, issuer='AliangBoard') -> string`(`otpauth://totp/AliangBoard:<u>?secret=<s>&issuer=AliangBoard`,username 需 encodeURIComponent)
- `verifyTotp(secret, code, { window=1, now=Date.now() }) -> boolean`(HMAC-SHA1/30s/±1 窗/常数时间比较;code 必须 6 位数字串否则 false)
- `generateRecoveryCodes(n=10) -> [{ plaintext: 'XXXXX-XXXXX', hash: sha256hex }]`
- `hashRecoveryCode(plaintext) -> sha256hex`(归一化:大写+去内空格后哈希——登录输入容错)

- [ ] Step 1 失败测试(核心用例——**RFC 6238 附录测试向量**:secret base32 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'(= '12345678901234567890'),T=59→'94287082',T=1111111109→'07081804';window 用例:code 为上一窗/下一窗/当窗;错码 false;非 6 位 false;base32 往返;恢复码形状+哈希确定性+归一化(' abcde-fghij '→同 hash);verifyTotp 用 `now` 注入)
- Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(server): zero-dependency TOTP module (RFC 6238 vectors, base32, recovery codes)`

### Task 2: schema + MFA 端点(setup/enable/disable)+ 登录二步 + 恢复码

**Files:** Modify `server/index.mjs`(try-ALTER:platform_users.totpSecret、platform_sessions.mfaPending/stepUpAt、CREATE mfa_recovery_codes;checkLoginRate 旁挂 MFA 限流或复用);`server/routes/auth.mjs`(login 改造 + 4 新端点);`server/messages/auth.mjs`(新键);Test `server/auth-selfservice.test.mjs` 追加 + Create `server/mfa.test.mjs`(端点级,工厂照 auth-selfservice)
**Interfaces:**
- Consumes: Task 1 全部;`checkLoginRate(key)`(auth.mjs:54 同款调用)。
- Produces: `POST /api/auth/mfa/setup` → `{ secret, otpauthUri }`(pending secret 内存 Map<userId,secret>,5min,重复调用轮换);`POST /api/auth/mfa/enable {secret, code}` → `{ ok, recoveryCodes: [plaintext×10] }`(验通过:totpSecret 落库+10 码哈希入库+stepUpAt=now);`POST /api/auth/mfa/disable {code}`(TOTP 或恢复码验过 → 清两处;**需 step-up**:session.stepUpAt 距今>10min → 409 `{stepUpRequired:true}`);`POST /api/auth/login/mfa {username, mfaTicket, code}`(none class+独立限流键 `mfa|ip|username`;ticket 内存 Map 单次 5min;TOTP 过或恢复码过(即焚:UPDATE usedAt)→ 走 login 成功尾段原样:建 platform session(stepUpAt=now)+ 响应 token/user/prefs)。
- login 改造(auth.mjs:56 密码验证通过后插段):`if (user.totpSecret) { const ticket=randomUUID(); mfaTickets.set(ticket,{userId,exp}); audit; sendJson(res,200,{mfaRequired:true,mfaTicket:ticket}); return true }`——注意**未启用且开关关**路径零变化。

- [ ] Step 1 失败测试:①setup 返回 32 字符 secret+otpauth 含 username;②enable 对错码 200/400,成功回 10 码且库中 10 哈希;③login 对启用用户回 mfaRequired+ticket 不回 token;④login/mfa 正确 TOTP → 完整 token;恢复码 → token 且二次用 401;错 ticket/过期 ticket 401;⑤限流 6 连击 429;⑥disable:step-up 过期 409、新鲜 200 清库;⑦未启用用户一切照旧(回归锚)。测试用 Task 1 的 generateTotpSecret+手动构造「当前时刻有效码」(用 verifyTotp 同款 now 注入辅助:导出 `totpCodeAt(secret, t)` 供测试——加进 Task 1 Produces)
- Step 2-5 → Commit `feat(server): MFA enrollment + two-step login with mfaTicket + recovery codes + step-up-guarded disable`

### Task 3: 强制开关 + 受限 token + step-up 端点

**Files:** Modify `server/index.mjs`(platformUserFromRequest 拦截)、`server/routes/auth.mjs`(`POST /api/auth/step-up`)、`server/routes/admin.mjs`(GET/PUT `/api/admin/mfa-policy` 复用 password-policy 端点模式)、`server/messages/auth.mjs`;Test `server/mfa.test.mjs` 追加
**Interfaces:**
- Produces: `POST /api/auth/step-up {code}` → session.stepUpAt=now(恢复码可验不即焚);platformUserFromRequest 读到 `mfaPending=1` → 仅放行 GET /api/auth/me、POST /api/auth/mfa/*、POST /api/auth/logout、POST /api/auth/preferences(引导页保语言)→ 其余 403 `auth.mfaEnrollmentRequired`;`GET/PUT /api/admin/mfa-policy {enabled}`(settings 键 `auth.mfa.required`='1'/删);login 尾段:开关开+用户无 totpSecret → 建会话 mfaPending=1;enable 成功 → UPDATE mfaPending=0。
- 验收映射:spec §5.3 全部。

- [ ] Step 1 失败测试:开关开+未启用登录 → token 受限(me 200 / my-clusters 403 mfaEnrollmentRequired);enable 后同 token 完整(me 200 + my-clusters 200);step-up:10min 内免/超时 409/验过刷新。Step 2-5 → Commit `feat(server): global MFA require switch with restricted pending token + step-up endpoint`

### Task 4: 前端——安全卡 MFA 区 + 登录二步 + step-up 弹窗(qrcode 依赖)

**Files:** `npm i qrcode` + CLAUDE.md 豁免表登记;Modify `src/components/userCenter/SecuritySection.vue`(两步验证卡)、`src/views/Login.vue`(mfaRequired 二步表单)、`src/api/client.js`(authApi.mfaSetup/mfaEnable/mfaDisable/mfaLogin/stepUp)、`src/components/common/StepUpDialog.vue`(Create,409 拦截+重放)、`src/locales/{en,zh}.json`;Test `src/views/__tests__/UserProfile.test.js` 追加 + `src/views/__tests__/Login.mfa.test.js`(Create)
**Interfaces:** Consumes Task 1-3 端点。Produces: `StepUpDialog`(props: visible;emits: done;内部 POST step-up 失败提示);SecuritySection 发 409 stepUpRequired 时挂它。登录页:mfaRequired → 渲染二步表单(码/恢复码一框)→ mfaLogin → 原跳转逻辑。
- [ ] Step 1 失败测试:①SecuritySection 未启用渲染「启用」钮 → 点击 → setup 调用+二维码 img(qrcode.toString → dataURL,mock qrcode 模块)→ 输码 enable → 恢复码一次性弹窗;②已启用渲染徽章+禁用钮(409 → 弹 StepUpDialog → 验过重放 → disable 调用);③Login:mock login 返 mfaRequired → 二步表单 → mfaLogin 成功跳转。Step 2-5 → Commit `feat(web): MFA enrollment card with QR + two-step login + step-up dialog (qrcode dep per spec D5)`

### Task 5: admin 会话治理

**Files:** Modify `server/routes/admin.mjs`(GET /api/admin/sessions 分页 + DELETE /api/admin/sessions/:userId)、`server/messages/admin.mjs`;`src/views/admin/UserManagement.vue`(强制下线钮+徽章)、`src/api/client.js`(adminApi.sessions)、locales;Test `server/admin-sessions.test.mjs`(Create)+ UserManagement 测试追加
**Interfaces:** DELETE → `revokeUserSessions({db,platformSessions,sessions}, userId)`(既有)+审计 `admin_force_logout`;GET → JOIN platform_users 列 username/role/mfaPending + ip/userAgent 摘要/createdAt/lastSeenAt,lastSeen 降序,size 钳 1..200。
- [ ] Step 1 失败测试:列表含全用户会话+分页;DELETE 后目标 token 下一请求 401(revoke 真调)+审计行;非 admin 401。Step 2-5 → Commit `feat(server,web): admin session governance — list all sessions + force logout with audit`

### Task 6: 个人 kubeconfig(/api/k8s-proxy 路由族 + 用户中心卡)

**Files:** Modify `server/index.mjs`(GET /api/my/kubeconfig + /api/k8s-proxy/:clusterId/* 分发)、`server/routes/auth.mjs` 或独立 `server/routes/k8s-proxy.mjs`(Create,薄:解析平台 token→查该用户该集群活跃 K8s 会话→把 path 重写进既有透传管线);`server/route-auth-map.mjs`;`src/components/userCenter/`(安全 tab「kubectl 访问」卡)、client.js、locales;Test `server/k8s-proxy.test.mjs`(Create)+ UserProfile 测试追加
**Interfaces:**
- `/api/k8s-proxy/:clusterId/<k8s-path...>`(platform class):平台会话→`platform_sessions WHERE userId AND 未过期` 取最新 k8sSessionToken→sessions Map 取 k8s 会话(无 → 401 `kubecfg.noClusterSession`「请先在平台连接该集群」)→ **调用既有 isK8s 透传处理**(把内部 path 前缀改写为 /api/k8s/<k8s-path> 后复用同一代码路径——实现上最简:handler 内部直接构造与 /api/k8s/* 相同的内部调用,ns 门/session-guard 自然生效;若透传块不可函数化复用,则拷贝调用 k8sGate.gateParsedPath+requestOnce 的最小管线——**以复用为准,拷贝需终审说明**)。
- `GET /api/my/kubeconfig?clusterId=` → YAML 文本(server: `http(s)://<req.headers.host>/api/k8s-proxy/<clusterId>`;token: 当前平台 token 明文;UI 卡:选集群(已分配且已连接)+复制/下载+失效说明文案)。
- 验收映射:spec §5.6。

- [ ] Step 1 失败测试:①kubeconfig YAML 形状(server 路径/token 占位/cluster name);②proxy:view 用户 GET 未授权 ns pods → 403(gate 生效证据);吊销平台会话后 → 401;③浏览器 /api/k8s/* 直连回归锚。Step 2-5 → Commit `feat(server,web): personal kubeconfig — gateway-proxy credential over platform token, ns-trimmed by existing gate`

### Task 7: 门禁收口 + 依赖豁免登记核验

- [ ] npm test / test:unit -- --maxWorkers=2 / typecheck / build / 裸 i18n:check 全绿;qrcode 在 CLAUDE.md 豁免表;spec §5 验收逐条自检;合并(控制器)。

## 手测清单(网关重启后)

① 启用 MFA 全流程(扫码→验码→恢复码抄录)→ 登出 → 登录需 TOTP → 恢复码可进且即焚;② admin 开强制开关 → 未启用用户登录只见引导页 → 启用后完整;③ 改密超 10min → step-up 弹窗;④ admin 强制下线 → 目标用户即踢;⑤ kubectl 用下载的 kubeconfig get pods 走通,view 用户只见授权 ns,平台登出后 kubectl 立即 401。
