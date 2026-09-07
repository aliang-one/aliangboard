# 用户中心 Wave 4 设计:OIDC 企业身份(SSO 登录 + JIT 供给 + 组同步)

- 日期: 2026-09-07
- 状态: 已按用户裁决定稿(四项 AskUserQuestion 批准)
- 父 spec: `docs/superpowers/specs/2026-09-04-usercenter-enterprise-design.md`(§5 Wave 4 锚点)
- 前置: Wave 1-3 全落地(用户中心/组+ns 授权/网关执行/传导/impersonation/MFA)
- 2026-09-07 用户裁决: ①范围仅 OIDC(LDAP/SCIM 缓行);②零依赖手写(node:crypto 验签+JWKS fetch+PKCE,承 TOTP 先例);③JIT 自动建户;④本地登录恒可见+admin break-glass。

---

## 0. 裁决记录

| # | 裁决 | 理由 |
|---|---|---|
| D1 | 仅 OIDC | OIDC 是企业 IdP 通用语言(Keycloak/Authentik/Entra/Google),盖住 90% 场景;LDAP/SCIM 待真实需求 |
| D2 | 零依赖实现 | node:crypto 原生验 RS256/ES256、JWKS 是一次 fetch、PKCE 是哈希;承 Wave 3 TOTP 零依赖先例 |
| D3 | JIT 自动建户 | 首次 OIDC 登录建户+每次登录同步组;Rancher/KubeSphere 同款 |
| D4 | 本地登录恒可见 | 与 W3 D3(密码保留)一致;admin 恒可本地登录(break-glass);零锁死 |
| D5(控制器) | 回调用一次性兑换码 | 平台 token 不进 URL 历史/访问日志;代价一次往返 |
| D6(控制器) | 组按需自动建 + 全量对齐 | claims 中不存在的组自动建空组;该用户 group_members 以 claims 为唯一事实源(不在即移除);本地用户成员身份不动 |

## 1. OIDC 流程(授权码 + PKCE S256 + 兑换码)

```
登录页「使用 SSO 登录」→ GET /api/auth/oidc/login (auth:none)
  网关:state(randomUUID)+nonce+PKCE verifier/challenge → 内存 Map(state→{nonce,verifier,exp},单次/10min)
  → 302 IdP authorization_endpoint?...&scope&state&code_challenge=S256
IdP 认证 → GET /api/auth/oidc/callback?code&state (auth:none)
  验 state(单次消费,过期/不匹配→302 /login?oidcError=state)
  → POST token_endpoint(code+verifier+client_id+client_secret)→ id_token(+access_token 忽略)
  → verifyIdToken(jwks 验签 RS256/ES256/HS256;验 iss/aud/exp/nonce/iat 容差)
  → JIT 建户/更新 + 组同步(§2)
  → 兑换码(randomUUID,60s,单次)→ 302 /login?oidcCode=<code>
前端 Login.vue 检测 oidcCode → POST /api/auth/oidc/exchange {code} (auth:none,独立限流)
  → { token, user, prefs }(与密码登录同构响应)→ 走既有落地逻辑(redirect/landingView/autoConnect)
```

- 失败路径全部 302 `/login?oidcError=<reason>`(denied/state/token/verify/jit),登录页内联提示(键映射白名单,reason 不透传原始错误)。
- discovery(`{issuer}/.well-known/openid-configuration`)缓存 12h;JWKS 按 kid 缓存,验签遇未知 kid 强刷一次再失败。
- 限流:exchange 端点独立令牌桶(键 `oidcx|ip`,容量 5/10s 回 1,防兑换码猜测);login/callback 无敏感输入面(state 是 UUID)。

## 2. 用户与组模型(claims 接管供给,授权模型不动)

- `platform_users` 加列(try-ALTER):`authProvider TEXT NOT NULL DEFAULT 'local'`、`oidcSubject TEXT`(=`<issuer>|<sub>`,try-create 唯一索引)。
- JIT:首次登录 INSERT(username 取 claim `preferred_username` 缺省 `sub`;displayName 取 `name`;passwordHash=NULL——OIDC 用户本地登录天然不可用,IdP 即其 MFA);再次登录 UPDATE displayName。
- username 冲突:本地已有同名用户 → **拒绝登录**(302 oidcError=usernameTaken,提示 admin 处理;不自动接管,防本地账户被 IdP 同名用户劫持)。
- 组同步(每次登录,事务):groups claim(可配名,缺省 `groups`;值必须是 string[])→ 按名 upsert groups(D6 自动建)→ 该用户 group_members 全量对齐(DELETE+INSERT 该 userId;仅当 authProvider='oidc';本地用户不动)。
- 授权链零改动:组进平台后,既有 ns_grants/allowlist/impersonation 组绑定自动生效。

## 3. 零依赖模块

- `server/jwt-verify.mjs`:`base64urlDecode(seg)`、`jwkToKeyObject(jwk)`(RSA n/e → createPublicKey;EC crv/x/y → createPublicKey;oct → HS256 secret)、`verifyJwt(token, { jwks, issuer, audience, nonce, now })` → `{ claims }` | throw(签名/iss/aud/exp/nonce/iat>now+300 各自具名错误)。常数时间比较用 crypto.timingSafeEqual 验签内部已含。
- `server/oidc.mjs`:`createOidcProvider({ db, getSetting, fetchImpl })` → `{ isEnabled(), getConfig(), discovery(issuer), jwks(issuer), buildAuthUrl(state,nonce,challenge), exchangeCode(...), verifyIdToken(...) }`;discovery/jwks 模块级缓存(`_clearOidcCacheForTest()`)。
- settings 键(`oidc.*`,platform_settings):`enabled`('1'/缺省)、`issuer`、`clientId`、`clientSecret`(与 LLM key 同明文存储惯例,GET 不回传只回 hasSecret)、`scopes`(缺省 `openid profile email`)、`groupsClaim`(缺省 `groups`)、`usernameClaim`(缺省 `preferred_username`)。
- 回调 URL 展示给 admin:`<scheme>://<host>/api/auth/oidc/callback`(Host 头推导,与 kubeconfig 同口径)。

## 4. 端点(ROUTE_AUTH)

| 端点 | class | 语义 |
|---|---|---|
| GET /api/auth/oidc/login | none | 生成 state/nonce/PKCE → 302 IdP;未启用 → 302 /login?oidcError=disabled |
| GET /api/auth/oidc/callback | none | code 换 token+验签+JIT+组同步 → 302 /login?oidcCode=… 或 oidcError=… |
| POST /api/auth/oidc/exchange | none(独立限流) | 兑换码 → { token, user, prefs }(建 platform session,stepUpAt=now,与密码登录尾段同构) |
| GET /api/admin/oidc-config | admin | 配置回显(clientSecret 只回是否已设)+ 回调 URL + discovery 测试 |
| PUT /api/admin/oidc-config | admin | 保存(issuer 格式校验 https?://;enabled 置位时须 issuer+clientId 齐);审计 admin_oidc_config |

## 5. 前端

- Login.vue:enabled 时顶部「使用 SSO 登录」主按钮(本地表单恒在其下,D4);URL 检测 `oidcCode`→静默 exchange→落地;`oidcError`→内联错误条(白名单键:disabled/state/denied/token/verify/usernameTaken/jit)。
- Settings 安全策略 tab 增「SSO 登录(OIDC)」卡:开关+五字段+「测试连接」(GET config/test:打 discovery+JWKS,回端点/支持的签发算法/首个 kid)+回调 URL 一键复制。
- client.js:authApi.oidcExchange(code);adminApi.oidcConfig { get, save, test }。
- i18n ~20 键 en/zh(login.oidc*、admin.oidc*)。

## 6. 验收标准

1. 全流程:配置 IdP(测试用 stub)→ 登录页出现 SSO 钮 → 跳转→回跳→自动 exchange→进入平台;OIDC 用户无密码,本地登录被拒(密码为空)。
2. JIT+组同步:首登建户+自动建组+成员落位;二次登录组变更(增/减)对齐;本地用户同名冲突被拒。
3. 授权链:OIDC 用户经组拿到既有 ns 授权(allowlist 集群 ns 裁剪生效)。
4. 安全:state 单次/过期拒;nonce 不符拒;验签坏密钥拒;兑换码单次/过期/错码拒+限流;clientSecret 不回传。
5. D4:本地密码表单恒在;admin break-glass(关掉 OIDC 开关一切照旧);开关默认关=存量零感知。
6. 门禁全家绿;新端点 ROUTE_AUTH 齐;i18n 双语。

## 7. 非目标

RP-initiated logout(end_session)、refresh token、SCIM、LDAP、多 IdP 并存、OIDC 用户本地 TOTP(IdP 侧)、自动建户黑名单(JIT 拒绝名单,后续按需)。

## 8. 实施分期

| 期 | 内容 |
|---|---|
| **A** | jwt-verify.mjs + oidc.mjs(纯模块)+ 配置端点 + 测试连接 |
| **B** | login/callback/exchange 三端点 + JIT/组同步 + 限流 + 审计 |
| **C** | 前端:登录页 SSO + Settings 配置卡 + i18n |
