# 用户中心 Wave 3 设计:安全加固(TOTP MFA + step-up + admin 会话治理 + 个人 kubeconfig)

- 日期: 2026-09-07
- 状态: 待用户评审
- 父 spec: `docs/superpowers/specs/2026-09-04-usercenter-enterprise-design.md`(§5 Wave 3 锚点;§2 公理)
- 前置已落地: Wave 1(个人域)、W2-0/A/B/C+D/E(组+ns 授权+传导+impersonation)
- 2026-09-07 用户裁决: ①MFA 仅 TOTP+恢复码(passkey 留 Wave 4 IdP 侧);②admin 强制=全局单开关;③本地密码保留但启用者必过 MFA(零锁死,无绕过);④step-up 仅账户安全面。

---

## 0. 设计裁决记录(全部用户 2026-09-07 确认)

| # | 裁决 | 理由 |
|---|---|---|
| D1 | MFA = TOTP + 恢复码,不做 WebAuthn/passkey | 自托管 TOTP 已覆盖 KubeSphere 同级;passkey 钓鱼抵抗在 LAN/VPN 不突出,Wave 4 OIDC 时代 IdP 侧做更正统 |
| D2 | admin 强制策略 = 全局单开关 `auth.mfa.required`(platform_settings) | 小团队适用;per-group 策略复杂度高一档且 Wave 4 后由 IdP 承担 |
| D3 | 本地密码永久保留,MFA 是叠加非替代:启用者本地登录也必须过 TOTP | Rancher #26759 教训的反向应用——不制造「密码旁路」;同时零锁死风险(无 email 恢复链路,已裁决不做 SMTP) |
| D4 | step-up 仅账户安全面(改密/MFA 管理/看恢复码);不动 K8s 操作与 API key/审批 | K8s 面已有 allowlist+operate 显式授权;key 签发已有 ns entitlement;避免终端会话中途弹窗的体验灾难 |
| D5 | TOTP 二维码 = 引入 `qrcode` 运行时依赖(走依赖豁免,~14KB) | 手动输入 otpauth URI 的 UX 不可接受;canvas 手绘 QR 不现实 |
| D6 | kubeconfig = 指向网关的代理凭据,token = 用户当前平台 token | 随平台会话吊销而死(父 spec 红线天然满足);ns 裁剪由 Phase B k8s-gate 免费提供;诚实定位「跟着登录态走的 kubectl 凭据」,长效服务凭据是 API key 领域 |

## 1. TOTP MFA

### 1.1 服务端纯模块 `server/totp.mjs`

零依赖,`node:crypto` 实现 RFC 6238:
- `base32Encode(buf) / base32Decode(str)`(手写 ~30 行,RFC 4648)
- `generateTotpSecret() -> { secret(base32), otpauthUri(username, issuer) }`(20 字节随机 → base32;otpauth://totp/AliangBoard:<username>?secret=...&issuer=AliangBoard)
- `verifyTotp(secret, code, { window: 1, now }) -> boolean`(HMAC-SHA1,30s 步,±1 窗容差,常数时间比较)
- `generateRecoveryCodes(n=10) -> [{ plaintext, hash }]`(randomBytes→base32 分组 XXXX-XXXX;hash=SHA-256)

### 1.2 schema

```sql
-- platform_users 加列(try-ALTER):
ALTER TABLE platform_users ADD COLUMN totpSecret TEXT;        -- base32,NULL=未启用
-- 新表:
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  userId TEXT NOT NULL, codeHash TEXT NOT NULL, usedAt INTEGER,
  PRIMARY KEY (userId, codeHash));
```
totpSecret **不加密存储**(裁决:密钥与 SQLite 同文件同信任边界,加密密钥无处独立安放,安全性同源;部署文档明示「库文件即敏感」——既有事实,0600 权限已设)。

### 1.3 端点(全部 ROUTE_AUTH 登记)

| 端点 | class | 语义 |
|---|---|---|
| `POST /api/auth/mfa/setup` | platform | 生成 pending secret(不落库,响应含 secret+otpauthUri;同会话重复调用轮换 pending);需要 step-up 若已启用 MFA(重置场景) |
| `POST /api/auth/mfa/enable` | platform | body {secret, code}:验码通过 → totpSecret 落库 + 生成 10 恢复码(哈希入库)→ 响应恢复码明文(仅此次) |
| `POST /api/auth/mfa/disable` | platform | body {code}:验 TOTP 或恢复码 → 清 totpSecret + 清恢复码;**必须 step-up** |
| `POST /api/auth/login/mfa` | none(独立限流) | body {username, mfaCode}:登录二步——验 TOTP 或恢复码(恢复码即焚)→ 发平台 token。**前置**:需先过 `POST /api/auth/login` 密码步,响应 `mfaRequired:true, mfaTicket`(随机 64hex,内存 Map 5 分钟 TTL,单次有效) |
| `POST /api/auth/step-up` | platform | body {code}:验 TOTP/恢复码 → 平台会话 stepUpAt=now |

登录改造(`POST /api/auth/login`):密码验证通过且 totpSecret 存在 → **不发 token**,发 mfaTicket;强制开关打开且用户未启用 MFA → 发**受限 token**(见 1.5)。登录限流:MFA 端点独立令牌桶(键 `mfa|ip|username`,容量 5、10s 回 1——防对 ticket 期内 6 位码暴力,10^6 空间 / 300s 窗 / 5 次 ≈ 安全)。

### 1.4 前端(用户中心安全 tab 扩展)

- 「两步验证」卡:未启用 → 「启用」按钮 → 弹窗(otpauth URI 文本 + **qrcode 二维码** + 手动密钥)→ 输入验证码 → 成功 → **恢复码一次性展示弹窗**(复制全部/逐个划掉)。
- 已启用 → 状态徽章 + 「禁用」(step-up 弹窗) + 「重新生成恢复码」(step-up)。
- 登录页:密码通过且 mfaRequired → 二步表单(TOTP 码或恢复码二选一输入框)。
- 受限 token 状态 → 引导页(仅「先启用两步验证」+ 登出两个出口)。

### 1.5 admin 强制开关

- `platform_settings.auth.mfa.required` ∈ '1'/缺省(默认关,存量零感知)。
- 开关打开后未启用用户登录 → 发受限 token:`platform_sessions` 行加 `mfaPending INTEGER DEFAULT 0`(try-ALTER);`platformUserFromRequest` 读到 mfaPending=1 时仅放行:GET /api/auth/me、MFA setup/enable、logout;其余 403 `auth.mfaEnrollmentRequired`。启用完成 → 置 0。
- admin 设置页(Settings 安全策略 tab)加开关;开关打开不影响已启用用户。

## 2. Step-up 重认证(轻量)

- platform_sessions 加列 `stepUpAt INTEGER`(try-ALTER);登录/MFA 登录时 stepUpAt=now(刚认证过)。
- 账户安全操作守卫:改密、MFA disable、MFA setup(已启用者)、重新生成恢复码 → `now - stepUpAt > 10min` 则 409 `{ stepUpRequired: true }`。
- 前端:409 拦截 → TOTP 弹窗 → POST step-up → 重放原请求。UserMenu 内已有 ConfirmDialog 模式可复用。
- 恢复码可用于 step-up(等同 TOTP,不即焚——仅登录时即焚;**裁决**:step-up 用恢复码不消费,因其已持有完整会话,防的是 CSRF/偷拍屏,非身份证明)。

## 3. Admin 会话治理

- `GET /api/admin/sessions` → 全用户活跃会话(platform_sessions JOIN platform_users:username/role/ip/UA 摘要/createdAt/lastSeenAt/mfaPending,按 lastSeen 降序,分页复用 queryAuditLog 模式)。
- `DELETE /api/admin/sessions/:userId` → revokeUserSessions(既有级联:平台会话+K8s 凭据)+ 审计 `admin_force_logout`。
- UserManagement 行操作加「强制下线」钮(ConfirmDialog);mfaPending 用户行加徽章。

## 4. 个人 kubeconfig

- `GET /api/my/kubeconfig?clusterId=`(platform class)→ 文本 YAML:
  ```yaml
  apiVersion: v1
  kind: Config
  clusters: [{ name: aliangboard-<clusterName>, cluster: { server: <网关对外地址>/api/k8s-proxy/<clusterId> } }]
  users: [{ name: user, user: { token: <当前平台 token 明文> } }]
  contexts/current: 指向上者
  ```
- **新路由族 `/api/k8s-proxy/:clusterId/*`**(ROUTE_AUTH=platform):用平台 token 解析用户 → 取该用户该集群的 K8s 会话(从 platform_sessions.k8sSessionToken;无会话或吊销 → 401「请先在平台连接该集群」)→ 转入既有 k8s 透传管线(Phase B ns 门+session-guard 全部生效,**ns 裁剪免费获得**)。与既有 `/api/k8s/*`(session class,浏览器用)并存,互不影响。
- 网关对外地址:请求 Host 头推导(同源假设;X-Forwarded-Host 不信——部署文档说明反代场景需保 Host)。
- **失效语义**(诚实文档,UI 明示):8h 平台 TTL / 改密 / 禁用 / 强制下线 / 集群分配收回——全部即死。定位:「跟着登录态走的 kubectl 凭据」;CI/长效 → API key。
- 用户中心安全 tab 加「kubectl 访问」卡:选集群 → 显示 kubeconfig(复制/下载)+ 失效说明。

## 5. 验收标准

1. 启用流程:生成二维码 → 验码启用 → 恢复码一次性展示;登出重登需 TOTP;恢复码登录即焚(二次用拒)。
2. 暴力:MFA 端点 5 次后 429;错误 ticket/过期 ticket 拒。
3. 强制开关:打开后未启用用户登录只见 MFA 引导页(直调其他端点 403);启用后完整可用;admin 已启用者不受影响;存量部署开关默认关零感知。
4. step-up:改密前 10min 内免重验;超时 409 → TOTP 弹窗 → 重放成功;无 MFA 用户改密不要求 step-up(无 TOTP 可验,密码本身即刚验证)。
5. admin 会话:列表含全用户;强制下线后目标用户下一请求 401;审计行存在。
6. kubeconfig:kubectl get pods 走通(网关代理);ns 裁剪生效(view 用户看不到未授权 ns 资源);吊销平台会话后 kubectl 即死;直连 `/api/k8s/*` 浏览器路径回归不变。
7. 门禁全家绿;新端点 ROUTE_AUTH 齐;qrcode 依赖入 CLAUDE.md 豁免表。

## 6. 非目标

WebAuthn/passkey(Wave 4 IdP)、per-group MFA 策略、SMTP 告警(新设备登录通知)、API key 签发的 step-up(D4 裁决)、kubeconfig 长效化/refresh token、oidc-login(全 Wave 4)。

## 7. 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **A** | totp.mjs + schema + setup/enable/disable + 登录二步 + 恢复码 + 前端安全卡+登录二步表单 | 无 |
| **B** | step-up(stepUpAt+守卫+弹窗)+ admin 强制开关 + 受限 token | A |
| **C** | admin 会话列表/强制下线 + UserManagement UI | 无(可与 A 并行) |
| **D** | kubeconfig(k8s-proxy 路由族 + 用户中心卡) | 无(依赖 Phase B 既有门,已合) |
