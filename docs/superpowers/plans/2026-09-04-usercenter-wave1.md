# 用户中心 Wave 1(个人域补全)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec §3 的七个条目,把用户中心从单页三卡扩为五 tab 个人域(资料/安全/活动/访问令牌/偏好),新增我的活动、自助访问令牌(双类 key 第一天形态)、头像、偏好丰富化、会话卡补强、密码策略可配置。

**Architecture:** 服务端全部走既有 handler/dispatcher 模式(deps 注入、`requirePlatform` 纵深防御、ROUTE_AUTH 门外 404、messages.mjs 双语表、try-ALTER 幂等迁移);前端沿用 authApi 直调 + Pinia store + vitest/happy-dom 组件契约测试,UserProfile 拆壳 + `src/components/userCenter/` 子组件,tab 状态走路由 query。

**Tech Stack:** Vue 3 + Pinia + vue-i18n(纯 JS)、Node + node:sqlite、node:test(服务端)、vitest + happy-dom(前端)。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-04-usercenter-enterprise-design.md`(§3 全部;§2 公理约束全局适用)

## Global Constraints(每个任务隐含遵守)

- **worktree 隔离**:执行在独立 worktree 分支进行(用户硬约束),完成后 `--no-ff` 合回 main。
- **提交**:作者恒 `aliang-one <aliangdone@gmail.com>`(repo config 已设,提交前 `git config user.email` 复核一次);提交信息**英文**;**禁止** `Co-Authored-By: Claude` 尾注;禁止 force push。
- **零新增外部依赖**(CLAUDE.md 依赖政策)。
- **ROUTE_AUTH 单一事实源**:每个新端点必须在 `server/route-auth-map.mjs` 登记,否则 404;守卫测试静态扫源码路径字面量强制。
- **服务端用户可见消息**一律走 `msg(req, 'key')`(`server/messages/*.mjs` 双语表,zh 值为基准文案);缺码返回键本身,不算完成。
- **node:sqlite 绑定边界**:绑定值只允许 string/number/null/Buffer;一切 `undefined` 必须归一为 `null`,对象/数组必须先 JSON.stringify(历史事故:`updateConversation` 绑 undefined 全量失败)。
- **i18n 双语**:每个新 UI 文本键在 `src/locales/en.json` 与 `src/locales/zh.json` 同时补齐;vue-i18n 消息值里的字面 `@` 必须写成 `{'@'}`;含 HTML 的消息必须 v-html 渲染。门禁 `npm run i18n:check`。
- **门禁命令**:`npm test`(服务端自研运行器 + node --test)、`npm run test:unit`(vitest;多会话并行期加 `-- --maxWorkers=2`)、`npm run typecheck`(`node --check`)、`npm run build`(.vue 覆盖)。
- **既有测试契约不回退**:本计划多处改动被既有测试锁定的行为(如会话吊销防自锁 400、改密吊销计数),迁移时契约必须原样保留。
- 服务端测试统一模式:临时 db(`node:sqlite` `DatabaseSync(':memory:')` + 手工建表或 `createXxxSchema(db)`)+ deps 注入 stub + 收集 `sent` 响应数组断言(范式见 `server/auth-selfservice.test.mjs:13-40`)。
- **spec 偏差记录**(唯一一处,已裁决):头像读取端点返回 JSON `{ dataUrl }`(≈267KB)而非裸字节流——避免引入 `platformHttp` 之外的 raw 响应通道;缓存改前端内存单例(放弃 ETag)。其余与 spec 逐字一致。

---

### Task 1: 密码策略可配置(服务端:单源扩展 + 三路接线 + 策略端点)

**Files:**
- Modify: `server/password-policy.mjs`(全量重写,5 行 → 策略单源)
- Modify: `server/routes/auth.mjs`(change-password 接线 + 新端点 GET /api/auth/password-policy)
- Modify: `server/routes/admin.mjs`(建户/重置接线 + GET/PUT /api/admin/password-policy)
- Modify: `server/index.mjs`(authRoutes deps 增 `getSetting`)
- Modify: `server/route-auth-map.mjs`(登记 2 个新端点)
- Modify: `server/messages/auth.mjs`(3 个新规则消息)
- Test: `server/password-policy.test.mjs`(既有,追加)、`server/auth-selfservice.test.mjs`(追加)

**Interfaces:**
- Produces: `DEFAULT_PASSWORD_POLICY`(常量 `{ minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false }`)、`normalizePolicy(raw) -> policy`、`resolvePasswordPolicy(getSetting) -> policy`(getSetting 取 `'auth.passwordPolicy'` JSON,坏值回默认)、`firstFailedRule(pw, policy?) -> 'minLength'|'mixed'|'digit'|'symbol'|null`、`isPasswordOk(pw, policy?) -> boolean`(布尔契约不变,Task 9 前端镜像它的规则)。后续所有任务用这些名字,勿改名。

- [ ] **Step 1: 写失败测试(纯函数规则)**

在 `server/password-policy.test.mjs` 追加(保留既有内容):

```js
import { DEFAULT_PASSWORD_POLICY, normalizePolicy, resolvePasswordPolicy, firstFailedRule } from './password-policy.mjs'

test('默认档与历史行为逐字一致:仅长度≥8', () => {
  assert.equal(firstFailedRule('short', DEFAULT_PASSWORD_POLICY), 'minLength')
  assert.equal(firstFailedRule('longenough', DEFAULT_PASSWORD_POLICY), null)
  assert.equal(firstFailedRule(undefined), 'minLength')
  assert.equal(firstFailedRule(123), 'minLength')
})

test('规则档位:mixed/digit/symbol 按开关生效,关则不判', () => {
  const p = { minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: true }
  assert.equal(firstFailedRule('alllowercase1!', p), 'mixed')
  assert.equal(firstFailedRule('NoDigits!!', p), 'digit')
  assert.equal(firstFailedRule('NoSymbol11Aa', p), 'symbol')
  assert.equal(firstFailedRule('Good1!aA', p), null)
  // 关掉的规则不判:全小写长密码在默认档通过
  assert.equal(firstFailedRule('alllowercase', { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false }), null)
})

test('normalizePolicy:逐字段回退默认,minLength 钳 [8,128]', () => {
  assert.deepEqual(normalizePolicy(null), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(normalizePolicy('garbage'), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(normalizePolicy({ minLength: 3, requireMixed: 'yes' }), { minLength: 8, requireMixed: true, requireDigit: false, requireSymbol: false })
  assert.equal(normalizePolicy({ minLength: 999 }).minLength, 128)
})

test('resolvePasswordPolicy:读 settings JSON,坏 JSON 回默认', () => {
  assert.deepEqual(resolvePasswordPolicy(() => null), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(resolvePasswordPolicy(() => '{"minLength":12,"requireDigit":true}'), { minLength: 12, requireMixed: false, requireDigit: true, requireSymbol: false })
  assert.deepEqual(resolvePasswordPolicy(() => 'not-json'), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(resolvePasswordPolicy(() => { throw new Error('db gone') }), DEFAULT_PASSWORD_POLICY)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --filter password-policy 2>/dev/null || node --test server/password-policy.test.mjs`
Expected: FAIL(导入不存在:`DEFAULT_PASSWORD_POLICY is not exported`)。注意 `npm test` 的自研运行器若无 filter,直接用 `node --test`。

- [ ] **Step 3: 实现 password-policy.mjs(全量替换)**

```js
// 密码策略单源(2026-08-29 用户中心设计 G5;2026-09-04 Wave1 可配置化):自改/建户/重置三路同一规则。
// 策略对象注入:isPasswordOk 保持布尔契约(既有调用方零改动);精细规则用 firstFailedRule。
// 默认档(DEFAULT_PASSWORD_POLICY)与 2026-08-29~2026-09-04 的历史行为逐字一致(仅长度≥8)。
export const PASSWORD_MIN_LENGTH = 8
export const DEFAULT_PASSWORD_POLICY = { minLength: PASSWORD_MIN_LENGTH, requireMixed: false, requireDigit: false, requireSymbol: false }

// 坏值逐字段回退默认;minLength 钳 [8,128](防 admin 把自己锁死在 0 或锁死所有人)。
export function normalizePolicy(raw) {
  const p = { ...DEFAULT_PASSWORD_POLICY }
  if (raw && typeof raw === 'object') {
    const n = Number(raw.minLength)
    if (Number.isFinite(n) && n > 0) p.minLength = Math.min(Math.max(Math.floor(n), PASSWORD_MIN_LENGTH), 128)
    for (const k of ['requireMixed', 'requireDigit', 'requireSymbol']) if (raw[k] != null) p[k] = !!raw[k]
  }
  return p
}

// getSetting('auth.passwordPolicy') → JSON → policy;缺值/坏 JSON/读库异常一律回默认(fail-open 到历史行为)。
export function resolvePasswordPolicy(getSetting) {
  try {
    const raw = typeof getSetting === 'function' ? getSetting('auth.passwordPolicy') : null
    return normalizePolicy(raw ? JSON.parse(raw) : null)
  } catch { return { ...DEFAULT_PASSWORD_POLICY } }
}

// 返回第一个未满足的规则名;null = 通过。mixed = 必须同时含大小写字母。
export function firstFailedRule(pw, policy = DEFAULT_PASSWORD_POLICY) {
  if (typeof pw !== 'string' || pw.length < (policy.minLength ?? PASSWORD_MIN_LENGTH)) return 'minLength'
  if (policy.requireMixed && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) return 'mixed'
  if (policy.requireDigit && !/\d/.test(pw)) return 'digit'
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) return 'symbol'
  return null
}

export function isPasswordOk(pw, policy = DEFAULT_PASSWORD_POLICY) {
  return firstFailedRule(pw, policy) == null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/password-policy.test.mjs`
Expected: PASS(既有 + 新增全绿)

- [ ] **Step 5: 写失败测试(端点接线)**

`server/auth-selfservice.test.mjs` 追加(沿用该文件既有 `makeDb/seed/makeRoutes` 工厂;若其 deps 未含 `getSetting`,在工厂 deps 里加 `getSetting: () => over._setting ?? null` 形式的注入点):

```js
test('改密:策略档 requireDigit 开启 → 缺数字 400 passwordNeedDigit;满足则通过', async () => {
  const db = makeDb(); seed(db)
  const routes = makeRoutes(db, { _setting: JSON.stringify({ minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: false }) })
  deps._body = { currentPassword: 'right-password', newPassword: 'NoDigitsHere' }   // 按该文件实际的 body 注入方式
  await routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/change-password'))
  assert.equal(sent.at(-1).status, 400)
  assert.equal(sent.at(-1).payload.message, MSG.zh['auth.passwordNeedMixed'])      // NoDigitsHere 缺大写 → mixed 先命中
  // 满足全部规则 → 200
  deps._body = { currentPassword: 'right-password', newPassword: 'Good1!Pass' }
  await routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/change-password'))
  assert.equal(sent.at(-1).status, 200)
})

test('GET /api/auth/password-policy:回当前生效策略', async () => {
  const db = makeDb(); seed(db)
  const routes = makeRoutes(db, { _setting: JSON.stringify({ minLength: 12 }) })
  await routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/password-policy'))
  assert.equal(sent.at(-1).status, 200)
  assert.deepEqual(sent.at(-1).payload.policy, { minLength: 12, requireMixed: false, requireDigit: false, requireSymbol: false })
})
```

(以上测试骨架的 `sent/resStub/deps/MSG` 引用按 `auth-selfservice.test.mjs` 既有具名变量对号入座;新测试文件顶部需 `import { TABLE as MSG } from './messages/auth.mjs'` 或直接断言中文文案。)

- [ ] **Step 6: 跑测试确认失败**(400 不带新消息/端点 404 兜底)
- [ ] **Step 7: 实现**

`server/routes/auth.mjs`:
1. deps 解构增 `getSetting`;import 改为 `import { isPasswordOk, resolvePasswordPolicy, firstFailedRule } from '../password-policy.mjs'`。
2. change-password 校验块(`auth.mjs:128`)替换为:

```js
        const policy = resolvePasswordPolicy(getSetting)
        const rule = firstFailedRule(newPassword, policy)
        if (rule) {
          const key = rule === 'minLength' ? 'auth.passwordTooShort'
            : rule === 'mixed' ? 'auth.passwordNeedMixed'
            : rule === 'digit' ? 'auth.passwordNeedDigit' : 'auth.passwordNeedSymbol'
          sendJson(res, 400, { message: msg(req, key) }); return true
        }
```

3. 在 PUT /api/auth/preferences 块之后追加新端点:

```js
    // GET /api/auth/password-policy — 当前生效密码策略(前端改密表单做同规则预检,Wave1 §3.7)
    if (url.pathname === '/api/auth/password-policy' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      sendJson(res, 200, { policy: resolvePasswordPolicy(getSetting) })
      return true
    }
```

`server/routes/admin.mjs`:
1. import 增 `resolvePasswordPolicy, firstFailedRule, normalizePolicy`。
2. 建户(`admin.mjs:566`)与重置(`admin.mjs:621`)两处 `if (!isPasswordOk(password))` 替换为与上面同构的 rule 分支(minLength 用既有 `admin.passwordTooShort`,其余三档复用 `auth.passwordNeedMixed/NeedDigit/NeedSymbol`——消息表已合并,跨前缀复用合法)。
3. 在 `/api/admin/audit-log/verify` 块后追加:

```js
    if (url.pathname === '/api/admin/password-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { policy: resolvePasswordPolicy(getSetting) })
      return true
    }
    if (url.pathname === '/api/admin/password-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.minLength != null && (!Number.isFinite(Number(input.minLength)) || Number(input.minLength) < 8)) {
        sendJson(res, 400, { message: msg(req, 'admin.passwordPolicyInvalid') }); return true
      }
      const policy = normalizePolicy(input)
      setSetting('auth.passwordPolicy', JSON.stringify(policy))
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_password_policy', result: 'ok', requestSummary: `minLength=${policy.minLength}`, source: 'platform' })
      sendJson(res, 200, { policy })
      return true
    }
```

`server/index.mjs:1463` authRoutes deps 增 `getSetting,`(admin deps 已有,勿重复传也无所谓)。

`server/route-auth-map.mjs` 平台段追加:

```js
  { method: 'GET',  pattern: '/api/auth/password-policy', auth: 'platform' }, // 自助改密表单的生效策略
```

admin 段无需加(`{ prefix: '/api/admin/' }` 已盖;字面量守卫只对源码扫描,`'/api/admin/password-policy'` 字面量出现于 admin.mjs → 若守卫测试要求精确登记则补 `{ method: 'GET', pattern: '/api/admin/password-policy', auth: 'admin' }` 与 PUT 两条——以跑 `node --test server/route-auth-map.test.mjs` 结果为准)。

`server/messages/auth.mjs` TABLE 增(zh 为基准,与既有条目同构):

```js
  'auth.passwordNeedMixed': { zh: '密码需同时包含大小写字母', en: 'Password must contain both upper and lower case letters' },
  'auth.passwordNeedDigit': { zh: '密码需包含数字', en: 'Password must contain a digit' },
  'auth.passwordNeedSymbol': { zh: '密码需包含符号', en: 'Password must contain a symbol' },
```

`server/messages/admin.mjs` TABLE 增:

```js
  'admin.passwordPolicyInvalid': { zh: '密码策略非法:最小长度不得小于 8', en: 'Invalid password policy: minLength must be at least 8' },
```

- [ ] **Step 8: 跑测试确认通过**:`node --test server/auth-selfservice.test.mjs server/password-policy.test.mjs server/route-auth-map.test.mjs` 全绿;再跑 `npm test` 确认无回归(admin-seed 等密码路径消费者行为不变)。
- [ ] **Step 9: Commit**

```bash
git add server/password-policy.mjs server/password-policy.test.mjs server/routes/auth.mjs server/routes/admin.mjs server/index.mjs server/route-auth-map.mjs server/messages/auth.mjs server/messages/admin.mjs server/auth-selfservice.test.mjs
git commit -m "feat(server): configurable password policy — rules single-source, wired into self-change/admin-create/admin-reset, GET policy endpoints"
```

---

### Task 2: DB 迁移 + auth-keys 扩展(ownerUserId/expiresAt/lastUsedAt/lastUsedIp + platform_users.avatar)

**Files:**
- Modify: `server/auth-keys.mjs`(schema try-ALTER、mintKey、listKeys、isActive)
- Modify: `server/index.mjs`(platform_users try-ALTER 增 avatar/avatarMime,插在既有 prefs try-ALTER `index.mjs:186` 旁)
- Test: `server/auth-keys.test.mjs`(追加)

**Interfaces:**
- Produces: `mintKey(db, input)` 新增可选入参 `ownerUserId`(TEXT,NULL=服务 key)、`expiresAt`(INTEGER,null=永不过期),返回对象含这两字段;`listKeys(db, { owner, ownerUserId } = {})` 双过滤器;`isActive(row)` 含 `expiresAt` 判定(`row.expiresAt && Date.now() > row.expiresAt → false`);api_keys 新列 `ownerUserId TEXT` / `expiresAt INTEGER` / `lastUsedAt INTEGER` / `lastUsedIp TEXT`;platform_users 新列 `avatar BLOB` / `avatarMime TEXT`。Task 3/4/6/11 消费。

- [ ] **Step 1: 写失败测试**(`server/auth-keys.test.mjs` 追加;沿用该文件既有建库方式——`createApiKeysSchema(db)` 临时库)

```js
test('ownerUserId/expiresAt:mintKey 落库并回显;listKeys 按 ownerUserId 过滤', () => {
  const db = new DatabaseSync(':memory:'); createApiKeysSchema(db)
  const a = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', ownerUserId: 'u1', expiresAt: 9999999999999 })
  assert.equal(a.ownerUserId, 'u1'); assert.equal(a.expiresAt, 9999999999999)
  mintKey(db, { owner: 'svc', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa2' })   // 服务 key:两字段缺省 null
  const mine = listKeys(db, { ownerUserId: 'u1' })
  assert.equal(mine.length, 1); assert.equal(mine[0].ownerUserId, 'u1')
  const all = listKeys(db)
  assert.equal(all.length, 2); assert.equal(all.find(k => !k.ownerUserId).ownerUserId, null)
})

test('isActive:expiresAt 过期即失效,revoked 仍优先', () => {
  assert.equal(isActive({ revokedAt: null, expiresAt: Date.now() - 1000 }), false)
  assert.equal(isActive({ revokedAt: null, expiresAt: Date.now() + 60000 }), true)
  assert.equal(isActive({ revokedAt: null, expiresAt: null }), true)
  assert.equal(isActive({ revokedAt: 123, expiresAt: null }), false)
  assert.equal(isActive(null), false)
})

test('旧库迁移:无新列的存量表 ALTER 补列不抛', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, keyHash TEXT NOT NULL UNIQUE, prefix TEXT, owner TEXT NOT NULL,
    clusterId TEXT NOT NULL, boundSA_namespace TEXT NOT NULL, boundSA_name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'read',
    createdAt INTEGER NOT NULL, revokedAt INTEGER)`)
  createApiKeysSchema(db)   // 二次执行 = 存量库升级路径
  db.prepare(`INSERT INTO api_keys (id,keyHash,prefix,owner,clusterId,boundSA_namespace,boundSA_name,createdAt) VALUES ('k','h','p','o','c','n','s',1)`).run()
  const row = db.prepare('SELECT ownerUserId, expiresAt, lastUsedAt, lastUsedIp FROM api_keys WHERE id=?').get('k')
  assert.equal(row.ownerUserId, null)
})
```

- [ ] **Step 2: 跑确认失败**(列不存在/入参未实现)
- [ ] **Step 3: 实现**

`server/auth-keys.mjs` createApiKeysSchema 末尾追加:

```js
  // Wave1(2026-09-04):双类 key(ownerUserId NULL=服务 key)+ TTL + 使用痕迹。node:sqlite 无 ADD COLUMN IF NOT EXISTS,沿用 try-ALTER 惯例。
  try { db.exec('ALTER TABLE api_keys ADD COLUMN ownerUserId TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE api_keys ADD COLUMN expiresAt INTEGER') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE api_keys ADD COLUMN lastUsedAt INTEGER') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE api_keys ADD COLUMN lastUsedIp TEXT') } catch { /* 列已存在 */ }
```

mintKey 签名与 INSERT 改为(仅列增量,其余逐字保留):

```js
export function mintKey(db, input) {
  const { owner, clusterId, boundSA_namespace, boundSA_name, tier = 'read', label = null, createdBy = null, tool_overrides = null, allowed_namespaces = null, id: inputId = null, saManaged = 0, sshAccess = 0, ownerUserId = null, expiresAt = null } = input || {}
  // ……校验与 normalize 原样……
  db.prepare(`INSERT INTO api_keys (id, keyHash, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, allowed_namespaces, label, createdBy, createdAt, revokedAt, saManaged, sshAccess, ownerUserId, expiresAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)`).run(
    id, hashKey(plaintext), plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, overridesJson, allowedNsJson, label, createdBy, createdAt, saManaged ? 1 : 0, sshAccess ? 1 : 0, ownerUserId ?? null, expiresAt ?? null)
  return { id, plaintext, prefix: plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides: overridesJson, allowed_namespaces: allowedNsJson, label, createdBy, createdAt, saManaged: saManaged ? 1 : 0, sshAccess: sshAccess ? 1 : 0, ownerUserId: ownerUserId ?? null, expiresAt: expiresAt ?? null }
}
```

isActive / listKeys:

```js
export function isActive(row) {
  if (!row || row.revokedAt) return false
  if (row.expiresAt && Date.now() > row.expiresAt) return false   // Wave1:TTL 到期即失效(读取时惰性判定)
  return true
}

export function listKeys(db, { owner, ownerUserId } = {}) {
  const where = []; const params = []
  if (owner) { where.push('owner = ?'); params.push(owner) }
  if (ownerUserId) { where.push('ownerUserId = ?'); params.push(ownerUserId) }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const sql = `SELECT id, prefix, owner, ownerUserId, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, allowed_namespaces, label, createdBy, createdAt, revokedAt, saManaged, sshAccess, expiresAt, lastUsedAt, lastUsedIp
               FROM api_keys ${clause} ORDER BY createdAt DESC`
  return db.prepare(sql).all(...params)
}
```

`server/index.mjs` platform_users try-ALTER 区(搜索 `try-ALTER` 的 prefs 迁移处,约 186 行)旁追加:

```js
try { db.exec('ALTER TABLE platform_users ADD COLUMN avatar BLOB') } catch { /* 列已存在 */ }        // Wave1 §3.5:头像存 SQLite blob(单库不变式)
try { db.exec('ALTER TABLE platform_users ADD COLUMN avatarMime TEXT') } catch { /* 列已存在 */ }
```

- [ ] **Step 4: 跑确认通过** `node --test server/auth-keys.test.mjs` + `npm test`(auth-keys 消费方零回归)
- [ ] **Step 5: Commit**

```bash
git add server/auth-keys.mjs server/auth-keys.test.mjs server/index.mjs
git commit -m "feat(server): api_keys dual-class schema (ownerUserId/expiresAt/lastUsedAt/lastUsedIp) + platform_users avatar columns"
```

---

### Task 3: key 鉴权实时收权(resolveApiKey ∩ owner)+ lastUsed 触碰 + 删户级联吊 key

**Files:**
- Modify: `server/api-key-tools.mjs:27-32`(resolveApiKey)
- Create: `server/key-usage-touch.mjs`
- Modify: `server/index.mjs`(apikey verifier 挂 touch)
- Modify: `server/routes/admin.mjs:577-590`(user DELETE 级联吊 key)
- Test: `server/api-key-tools.test.mjs`(追加)、Create `server/key-usage-touch.test.mjs`

**Interfaces:**
- Produces: `touchKeyUsage(db, keyRow, { now?, ip?, minIntervalMs? }) -> boolean`(模块级 Map 节流,默认 60s,语义对齐 `session-touch.mjs`;导出 `_resetKeyUsageForTest()`)。resolveApiKey 新语义:**ownerUserId 非空的 key,其 owner 被删/禁用 → key 即刻无效;owner 非 admin 且未分配 key.clusterId → 即刻无效**(spec §3.3 集群粗交集 + 公理 4 请求时求值)。禁用用户的 key 不落 DB 级联(运行时已死,删户才物理吊销——避免 PATCH disabled 时误伤「仅临时禁用」的可回逆性)。

- [ ] **Step 1: 写失败测试**

`server/api-key-tools.test.mjs` 追加(自建最小表;明文 key 用 `generateKeyPlaintext()` + `hashKey()` 落库,与 lookupKey 的 sha256 查找对得上):

```js
test('resolveApiKey 双类收权:owner 删/禁 → null;未分配集群 → null;admin owner 与服务 key 跳过分配检查', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, keyHash TEXT UNIQUE, prefix TEXT, owner TEXT, ownerUserId TEXT, clusterId TEXT, createdAt INTEGER, revokedAt INTEGER)`)
  db.prepare(`INSERT INTO platform_users VALUES ('u1','user',0)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('u2','user',1)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('a1','admin',0)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1')`).run()
  const mint = (ownerUserId, clusterId) => {
    const plain = generateKeyPlaintext()
    db.prepare(`INSERT INTO api_keys VALUES (?,?,?,?,?,?,1,NULL)`)
      .run(plain.slice(0, 8), hashKey(plain), plain.slice(0, 8), 'x', ownerUserId, clusterId)
    return plain
  }
  const plainOk = mint('u1', 'c1'); const plainDisabled = mint('u2', 'c1')
  const plainUnassigned = mint('u1', 'c9'); const plainAdmin = mint('a1', 'c9'); const plainSvc = mint(null, 'c9')
  const req = p => ({ headers: { authorization: `Bearer ${p}` } })
  assert.ok(resolveApiKey(db, req(plainOk)))                       // 已分配 → row
  assert.equal(resolveApiKey(db, req(plainDisabled)), null)        // owner 禁用 → 即刻死
  assert.equal(resolveApiKey(db, req(plainUnassigned)), null)      // owner 未分配 c9 → 即刻死
  assert.ok(resolveApiKey(db, req(plainAdmin)))                    // admin owner 不看分配表
  assert.ok(resolveApiKey(db, req(plainSvc)))                      // 服务 key(ownerUserId NULL)零影响
})
```

(若该文件未 import,补 `import { generateKeyPlaintext, hashKey } from './auth-keys.mjs'`。)

Create `server/key-usage-touch.test.mjs`:

```js
// lastUsedAt 节流回写(对齐 session-touch 语义):内存即时、SQLite 按间隔。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { touchKeyUsage, _resetKeyUsageForTest } from './key-usage-touch.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY, lastUsedAt INTEGER, lastUsedIp TEXT)')
  return db
}

test('首次触碰落库;间隔内跳过;越过间隔再落;ip 一并写入', () => {
  _resetKeyUsageForTest()
  const db = makeDb()
  db.prepare("INSERT INTO api_keys (id) VALUES ('k1')").run()
  const row = { id: 'k1' }
  assert.equal(touchKeyUsage(db, row, { now: 1000, ip: '1.2.3.4' }), true)
  assert.equal(touchKeyUsage(db, row, { now: 2000, ip: '1.2.3.4' }), false)        // 60s 内
  assert.equal(touchKeyUsage(db, row, { now: 61000, ip: '5.6.7.8' }), true)
  const r = db.prepare('SELECT lastUsedAt, lastUsedIp FROM api_keys WHERE id=?').get('k1')
  assert.equal(r.lastUsedAt, 61000); assert.equal(r.lastUsedIp, '5.6.7.8')
})

test('db 异常不抛(节流 map 已推进,降级为丢一次统计)', () => {
  _resetKeyUsageForTest()
  assert.equal(touchKeyUsage(makeDb(), { id: 'no-row' }, { now: 1 }), true)        // UPDATE 0 行,不抛
  assert.equal(touchKeyUsage(null, null), false)
})
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**

`server/api-key-tools.mjs` resolveApiKey 替换:

```js
// 解析 API key(Authorization: Bearer)。有效→row;无效/已吊销/过期→null。
// Wave1(2026-09-04)双类 key 实时收权(spec 公理 4):ownerUserId 非空的用户 key 逐请求复读 owner 状态——
// 被删/禁用即刻失效;非 admin owner 还须已分配 key 所绑集群(user_clusters 粗门禁交集)。服务 key(NULL)零影响。
export function resolveApiKey(db, req) {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const row = lookupKey(db, token)
  if (!isActive(row)) return null
  if (row.ownerUserId) {
    const u = db.prepare('SELECT disabled, role FROM platform_users WHERE id=?').get(row.ownerUserId)
    if (!u || u.disabled) return null
    if (u.role !== 'admin') {
      const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(row.ownerUserId, row.clusterId)
      if (!assigned) return null
    }
  }
  return row
}
```

Create `server/key-usage-touch.mjs`:

```js
// API key lastUsedAt 节流回写(2026-09-04 Wave1 §3.3;语义对齐 session-touch.mjs):
// 每 key 内存 Map 节流(默认 60s),SQLite 同步写降频。模块级 Map 与单进程不变式一致(重启清零=最多多写一次)。
const lastTouch = new Map() // keyId → ts

export function touchKeyUsage(db, keyRow, { now = Date.now(), ip = null, minIntervalMs = 60_000 } = {}) {
  if (!db || !keyRow?.id) return false
  const prev = lastTouch.get(keyRow.id)
  if (prev && now - prev < minIntervalMs) return false
  lastTouch.set(keyRow.id, now)
  try {
    db.prepare('UPDATE api_keys SET lastUsedAt=?, lastUsedIp=? WHERE id=?').run(now, ip ?? null, keyRow.id)
    return true
  } catch { return false }
}

export function _resetKeyUsageForTest() { lastTouch.clear() }
```

`server/index.mjs` apikey verifier(约 370-375 行)在 `req.abKeyRow = keyRow` 前插一行:

```js
      touchKeyUsage(db, keyRow, { ip: req.socket?.remoteAddress || null })
```

(import 增 `touchKeyUsage`;放到 `import { touchSession }` 旁。)

`server/routes/admin.mjs` user DELETE(`admin.mjs:584` revokeUserSessions 之后、DELETE platform_users 之前)插:

```js
      // Wave1 §3.3:删户级联吊销其名下全部用户 key(禁用不落级联——resolveApiKey 运行时已判死,保留可回逆)
      const revokedKeys = db.prepare('UPDATE api_keys SET revokedAt=? WHERE ownerUserId=? AND revokedAt IS NULL').run(Date.now(), id).changes
```

并把同函数内 writeAudit 的 requestSummary 改为 `` `id=${id} revokedKeys=${revokedKeys}` ``。

- [ ] **Step 4: 跑确认通过**:`node --test server/api-key-tools.test.mjs server/key-usage-touch.test.mjs` + `npm test`
- [ ] **Step 5: Commit**

```bash
git add server/api-key-tools.mjs server/key-usage-touch.mjs server/key-usage-touch.test.mjs server/api-key-tools.test.mjs server/index.mjs server/routes/admin.mjs
git commit -m "feat(server): live per-user key revocation in resolveApiKey (owner disabled/unassigned kills key) + throttled lastUsedAt touch + delete-user key cascade"
```

---

### Task 4: 自助 key 端点(POST/GET/DELETE /api/my/keys,托管 SA 供给)

**Files:**
- Create: `server/routes/my-keys.mjs`
- Modify: `server/index.mjs`(装配 + ROUTE_AUTH 无关此处)
- Modify: `server/route-auth-map.mjs`(3 条登记)
- Modify: `server/messages.mjs` + Create `server/messages/mykeys.mjs`
- Test: Create `server/my-keys.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `mintKey(含 ownerUserId/expiresAt)`、`listKeys({ownerUserId})`、`revokeKey`;admin.mjs:343-364 的托管供给模式(`managedSaName(id)` + `rbacTier(...)` + `deps.provisionCluster(deps.getCluster(clusterId), spec)`)。
- Produces: `createMyKeyRoutes(deps).handle(req,res,url) -> boolean`,deps = `{ db, sendJson, readBody, requirePlatform, randomUUID, writeAudit, getSetting, getCluster, provisionCluster }`。端点契约:
  - `GET /api/my/keys` → `{ apikeys: [...] }`(仅自己的,含已吊销行——吊销时间也是个人审计)
  - `POST /api/my/keys` body `{ clusterId, namespace, tier, label, ttlDays }` → `{ apikey: { id, plaintext, ... } }`;错误:400 `mykeys.namespaceRequired / mykeys.tierInvalid / mykeys.ttlInvalid`;403 `mykeys.clusterForbidden`;502 `mykeys.provisionFailed {reason}`;503 `mykeys.provisionUnavailable`
  - `DELETE /api/my/keys/:id` → `{ ok: true }`;404 `mykeys.keyNotFound`
  - 规则:`tier ∈ ['read','operator']`(自助封顶 operator,spec §3.3);`ttlDays` 缺省 30、钳 `[1, maxTtlDays]`,`maxTtlDays = clamp(Number(getSetting('apikey.maxTtlDays')) || 90, 1, 365)`;key 恒托管 SA(saManaged=1,先供给后落库,模式同 admin);`owner=ps.username, createdBy=ps.username, ownerUserId=ps.userId, expiresAt=now+ttl*86400000`。

- [ ] **Step 1: 写失败测试**(`server/my-keys.test.mjs`,node:test + 临时 db + deps stub;`provisionCluster` stub 返回 `{ ok: true }`,失败分支返回 `{ ok: false, failed: [{ kind: 'rbac', error: 'boom' }] }`)

```js
// 自助访问令牌端点(2026-09-04 Wave1 §3.3):归属过滤 / tier 封顶 / TTL 钳制 / 托管供给 / 归属吊销。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createMyKeyRoutes } from './routes/my-keys.mjs'
import { createApiKeysSchema } from './auth-keys.mjs'
import { lookupKey } from './auth-keys.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, apiServer TEXT, authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER)`)
  createApiKeysSchema(db)
  db.prepare(`INSERT INTO platform_users (id,username,role,createdAt) VALUES ('u1','alice','user',1)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1')`).run()
  db.prepare(`INSERT INTO clusters (id,apiServer) VALUES ('c1','https://x')`).run()
  return db
}

function makeRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_r, status, payload) => sent.push({ status, payload }),
    readBody: async (req) => req._body, requirePlatform: (req) => req._ps,
    randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2), writeAudit: () => {},
    getSetting: () => over._maxTtl ?? null,
    getCluster: (id) => db.prepare('SELECT * FROM clusters WHERE id=?').get(id) || null,
    provisionCluster: over._provision ?? (async () => ({ ok: true })),
    ...over._deps,
  }
  return { routes: createMyKeyRoutes(deps), sent, deps }
}

const REQ = { _ps: { userId: 'u1', username: 'alice', role: 'user' } }

test('POST:托管供给成功 → 200 回明文一次;落库行带 ownerUserId/expiresAt/saManaged', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  const body = { clusterId: 'c1', namespace: 'team-a', tier: 'operator', label: 'ci', ttlDays: 30 }
  await routes.handle({ ...REQ, method: 'POST', _body: body }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 200)
  const { apikey } = sent.at(-1).payload
  assert.ok(apikey.plaintext && apikey.plaintext.length >= 40)
  const row = lookupKey(db, apikey.plaintext)
  assert.equal(row.ownerUserId, 'u1'); assert.equal(row.saManaged, 1); assert.equal(row.tier, 'operator')
  assert.ok(row.expiresAt > Date.now())
})

test('POST:未分配集群 403;非法 tier 400;非法 ttl 400;供给失败 502 且不留行', async () => {
  const db = makeDb(); const { routes, sent, deps } = makeRoutes(db)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c9', namespace: 'n', tier: 'read' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 403)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'admin' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 400)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 99999 } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 400)
  const fail = makeRoutes(db, { _provision: async () => ({ ok: false, failed: [{ kind: 'rbac', error: 'boom' }] }) })
  await fail.routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(fail.sent.at(-1).status, 502)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM api_keys').get().c, 0)   // 先供给后落库:失败无「出生即死亡」key
})

test('POST:ttl 钳到 maxTtlDays(设置 7 → 999 请求得 ≤7 天)', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db, { _maxTtl: '7' })
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 999 } }, {}, new URL('http://x/api/my/keys'))
  const row = lookupKey(db, sent.at(-1).payload.apikey.plaintext)
  assert.ok(row.expiresAt <= Date.now() + 8 * 86400000)
})

test('GET:只回自己的(含已吊销);DELETE:归属过滤,他人/不存在 404,成功后 key 失效', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  db.prepare(`INSERT INTO api_keys (id,keyHash,prefix,owner,ownerUserId,clusterId,boundSA_namespace,boundSA_name,createdAt)
              VALUES ('k-mine','h1','p1','alice','u1','c1','n','s',1)`).run()
  db.prepare(`INSERT INTO api_keys (id,keyHash,prefix,owner,ownerUserId,clusterId,boundSA_namespace,boundSA_name,createdAt)
              VALUES ('k-other','h2','p2','bob','u2','c1','n','s',2)`).run()
  await routes.handle({ ...REQ, method: 'GET' }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).payload.apikeys.length, 1)
  await routes.handle({ ...REQ, method: 'DELETE' }, {}, new URL('http://x/api/my/keys/k-other'))
  assert.equal(sent.at(-1).status, 404)
  await routes.handle({ ...REQ, method: 'DELETE' }, {}, new URL('http://x/api/my/keys/k-mine'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(db.prepare('SELECT revokedAt FROM api_keys WHERE id=?').get('k-mine').revokedAt > 0)
})
```

- [ ] **Step 2: 跑确认失败**(模块不存在)
- [ ] **Step 3: 实现 `server/routes/my-keys.mjs`**

```js
// 自助访问令牌(2026-09-04 Wave1 §3.3):普通用户给自己签发/列出/吊销 API key。
// 双类 key 的「用户 key」侧:ownerUserId 必填=本人;恒托管 SA(先供给后落库,失败不留行,同 admin 模式);
// tier 封顶 operator;TTL 缺省 30d、上限 apikey.maxTtlDays(默认 90)。生效权限 = key 配置 ∩ owner 实时权限
// (∩ 判定在 resolveApiKey,Task 3)——本模块只管签发面的自我服务约束。
import { msg } from '../messages.mjs'
import { mintKey, revokeKey, listKeys } from '../auth-keys.mjs'
import { managedSaName, rbacTier } from '../sa-provision.mjs'

const SELF_TIERS = ['read', 'operator']
const enc = encodeURIComponent

export function createMyKeyRoutes(deps) {
  const { db, sendJson, readBody, requirePlatform, randomUUID, writeAudit, getSetting, getCluster, provisionCluster } = deps

  function maxTtlDays() {
    return Math.min(Math.max(Math.floor(Number(getSetting?.('apikey.maxTtlDays')) || 90), 1), 365)
  }

  async function handle(req, res, url) {
    if (url.pathname === '/api/my/keys' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      // 含已吊销行:吊销时间本身是个人审计信息(前端灰显)
      sendJson(res, 200, { apikeys: listKeys(db, { ownerUserId: ps.userId }) })
      return true
    }

    if (url.pathname === '/api/my/keys' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const { clusterId, namespace } = input || {}
        const tier = input?.tier || 'read'
        if (!namespace) { sendJson(res, 400, { message: msg(req, 'mykeys.namespaceRequired') }); return true }
        if (!SELF_TIERS.includes(tier)) { sendJson(res, 400, { message: msg(req, 'mykeys.tierInvalid') }); return true }
        // 集群粗门禁:admin 全量(对齐 /api/my-clusters 语义),普通用户须已分配
        if (ps.role !== 'admin') {
          const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
          if (!assigned) { sendJson(res, 403, { message: msg(req, 'mykeys.clusterForbidden') }); return true }
        } else {
          const exists = getCluster(clusterId)
          if (!exists) { sendJson(res, 403, { message: msg(req, 'mykeys.clusterForbidden') }); return true }
        }
        const ttl = Math.min(Math.max(Math.floor(Number(input?.ttlDays) || 30), 1), maxTtlDays())
        if (Number(input?.ttlDays) > maxTtlDays() || (input?.ttlDays != null && (!Number.isFinite(Number(input.ttlDays)) || Number(input.ttlDays) < 1))) {
          sendJson(res, 400, { message: msg(req, 'mykeys.ttlInvalid', { max: maxTtlDays() }) }); return true
        }
        if (!provisionCluster || !getCluster) { sendJson(res, 503, { message: msg(req, 'mykeys.provisionUnavailable') }); return true }
        const id = randomUUID()
        const name = managedSaName(id)
        const prov = await provisionCluster(getCluster(clusterId), {
          keyId: id, namespace, name, tier: rbacTier({ tier, tool_overrides: null }), namespaces: [],
        })
        if (!prov.ok) {
          sendJson(res, 502, { message: msg(req, 'mykeys.provisionFailed', { reason: prov.failed?.[0]?.error || prov.failed?.[0]?.kind || msg(req, 'mykeys.unknownError') }), failed: prov.failed })
          return true
        }
        const k = mintKey(db, {
          id, owner: ps.username, clusterId, boundSA_namespace: namespace, boundSA_name: name, saManaged: 1,
          tier, label: input?.label ? String(input.label).slice(0, 64) : null, createdBy: ps.username,
          ownerUserId: ps.userId, expiresAt: Date.now() + ttl * 86400000,
        })
        // k.plaintext 仅此次返回;前端弹「仅显示一次」窗
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'my_key_mint', result: 'ok', clusterId, namespace, requestSummary: `id=${id} tier=${tier} ttl=${ttl}d`, source: 'platform' })
        sendJson(res, 200, { apikey: k })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e?.message || msg(req, 'mykeys.mintFailed') }); return true }
    }

    const m = url.pathname.match(/^\/api\/my\/keys\/([^/]+)$/)
    if (m && req.method === 'DELETE') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const id = decodeURIComponent(m[1])
      const row = db.prepare('SELECT id FROM api_keys WHERE id=? AND ownerUserId=?').get(id, ps.userId)
      if (!row) { sendJson(res, 404, { message: msg(req, 'mykeys.keyNotFound') }); return true }
      revokeKey(db, id)
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'my_key_revoke', result: 'ok', requestSummary: `id=${id}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }

    return false
  }

  return { handle }
}
```

(`enc` 若最终未用则删除该行——node --check 不报未用变量,但保持整洁。)

Create `server/messages/mykeys.mjs`(TABLE 对象,zh 基准):

```js
export const TABLE = {
  'mykeys.namespaceRequired': { zh: '缺少绑定的 namespace', en: 'Namespace is required' },
  'mykeys.tierInvalid': { zh: '令牌档位仅支持 read / operator', en: 'Tier must be read or operator' },
  'mykeys.clusterForbidden': { zh: '该集群未分配给你', en: 'This cluster is not assigned to you' },
  'mykeys.ttlInvalid': { zh: '有效期须在 1-{max} 天内', en: 'TTL must be between 1 and {max} days' },
  'mykeys.provisionUnavailable': { zh: '集群身份供给组件不可用', en: 'Cluster identity provisioning is unavailable' },
  'mykeys.provisionFailed': { zh: '集群身份供给失败:{reason}', en: 'Cluster identity provisioning failed: {reason}' },
  'mykeys.keyNotFound': { zh: '令牌不存在或不属于你', en: 'Token not found or not yours' },
  'mykeys.mintFailed': { zh: '签发失败', en: 'Failed to create token' },
  'mykeys.unknownError': { zh: '未知错误', en: 'unknown error' },
}
```

`server/messages.mjs` 增 `import { TABLE as mykeys } from './messages/mykeys.mjs'` 并在 tables 合并对象加 `...mykeys`。

`server/route-auth-map.mjs` 平台段追加:

```js
  { method: 'GET',  pattern: '/api/my/keys', auth: 'platform' }, // 自助访问令牌列表(仅本人)
  { method: 'POST', pattern: '/api/my/keys', auth: 'platform' }, // 自助签发(托管 SA,tier≤operator)
  { prefix: '/api/my/keys/', auth: 'platform' },                 // DELETE /:id(归属过滤)
```

`server/index.mjs`:import `createMyKeyRoutes`;在 `const authRoutes = createAuthRoutes({...})` 之后装配(dispatch 顺序无冲突):

```js
  const myKeyRoutes = createMyKeyRoutes({
    db, sendJson, readBody, requirePlatform, randomUUID, writeAudit, getSetting,
    getCluster: (id) => db.prepare('SELECT * FROM clusters WHERE id=?').get(id) || null,
    provisionCluster: async (row, spec) => {
      if (!row) throw new Error(msg(req, 'api.clusterNotFound'))
      return provisionSa({ requestFn: requestKubernetes, callCtx: buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure }) }, spec)
    },
  })
  if (await myKeyRoutes.handle(req, res, url)) return
```

- [ ] **Step 4: 跑确认通过** `node --test server/my-keys.test.mjs server/route-auth-map.test.mjs` + `npm test`
- [ ] **Step 5: Commit**

```bash
git add server/routes/my-keys.mjs server/my-keys.test.mjs server/messages/mykeys.mjs server/messages.mjs server/route-auth-map.mjs server/index.mjs
git commit -m "feat(server): self-service access tokens — POST/GET/DELETE /api/my/keys with managed-SA provisioning, tier cap, TTL clamp, ownership-filtered revoke"
```

---

### Task 5: 我的活动端点(GET /api/my/activity)

**Files:**
- Modify: `server/routes/auth.mjs`(新端点,放在 GET /api/auth/sessions 块后)
- Modify: `server/route-auth-map.mjs`(1 条)
- Test: `server/auth-selfservice.test.mjs`(追加)

**Interfaces:**
- Consumes: `queryAuditLog(db, { owner, tool, toolPrefix, result, source, since, until, page, size, status })`(audit.mjs:104,已存在——只复用不修改)。
- Produces: `GET /api/my/activity?tool=&result=&source=&page=&size=` → `queryAuditLog` 原样返回 + `windowDays: 90`。**强制 `owner = ps.username`、强制 `since = now - 90d`**(服务端钳制,客户端传不进)、`status` 恒 'finalized'(queryAuditLog 默认)。

- [ ] **Step 1: 写失败测试**(auth-selfservice.test.mjs 追加;先 `createAuditSchema(db)` + `writeAudit(db, {...})` 造两条本用户一条他人的 finalized 行)

```js
test('GET /api/my/activity:只回本 username 行;90 天窗口强制;分页透传', async () => {
  const db = makeDb(); seed(db); createAuditSchema(db)
  const now = Date.now()
  writeAudit(db, { owner: 'alice', tool: 'platform_login', verb: 'login', result: 'ok', ts: now, source: 'platform' })
  writeAudit(db, { owner: 'bob', tool: 'platform_login', verb: 'login', result: 'ok', ts: now, source: 'platform' })
  const routes = makeRoutes(db)
  await routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/my/activity'))
  assert.equal(sent.at(-1).status, 200)
  const out = sent.at(-1).payload
  assert.equal(out.total, 1); assert.equal(out.items[0].owner, 'alice'); assert.equal(out.windowDays, 90)
  // result 过滤透传
  await routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/my/activity?result=denied'))
  assert.equal(sent.at(-1).payload.total, 0)
})
```

(注:`writeAudit` 内部取 `Date.now()` 作 ts,测试里断言 total/owner 即可,不必注入时钟;90 天窗口的「强制」体现为 since 参数不可由 query 覆盖——实现里不读 `q.get('since')` 即可,另补一条:造一条 `ts: Date.now() - 91*86400000` 的旧行需要直接 INSERT 而非 writeAudit,断言 total 仍为 1。)

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**(auth.mjs 顶部 `import { queryAuditLog } from '../audit.mjs'`;新块)

```js
    // GET /api/my/activity — 我的活动(2026-09-04 Wave1 §3.2):audit_log 按本人 username 过滤的只读视图。
    // v1 固定 90 天窗口(服务端钳制,client 传 since/until 无效);只回 finalized 行(queryAuditLog 默认)。
    if (url.pathname === '/api/my/activity' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const q = url.searchParams
      const out = queryAuditLog(db, {
        owner: ps.username,
        tool: q.get('tool') || undefined, toolPrefix: q.get('toolPrefix') || undefined,
        result: q.get('result') || undefined, source: q.get('source') || undefined,
        since: Date.now() - 90 * 86400000,
        page: q.get('page') || undefined, size: q.get('size') || undefined,
      })
      sendJson(res, 200, { ...out, windowDays: 90 })
      return true
    }
```

`server/route-auth-map.mjs` 平台段追加:

```js
  { method: 'GET', pattern: '/api/my/activity', auth: 'platform' }, // 我的活动(audit_log 本人只读视图,90d 窗口)
```

- [ ] **Step 4: 跑确认通过** `node --test server/auth-selfservice.test.mjs server/route-auth-map.test.mjs`
- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.mjs server/route-auth-map.mjs server/auth-selfservice.test.mjs
git commit -m "feat(server): GET /api/my/activity — per-user audit_log view, owner pinned server-side, 90-day window"
```

---

### Task 6: 头像端点(PATCH 扩展 + GET avatar dataUrl)+ preferences 新键

**Files:**
- Modify: `server/routes/auth.mjs`(PATCH /api/auth/me 扩展、新端点 GET /api/auth/me/avatar、PUT /api/auth/preferences 新键)
- Modify: `server/route-auth-map.mjs`(1 条)
- Modify: `server/messages/auth.mjs`(2 条)
- Test: `server/auth-selfservice.test.mjs`(追加)

**Interfaces:**
- Produces:
  - PATCH /api/auth/me 接受 `{ displayName?, avatar?(data URL 字符串), avatarClear?(true) }`,三者全空才 400;avatar 校验:mime 白名单 `['image/png','image/jpeg','image/webp']`、解码后 ≤ 200*1024 字节;存储列 `avatar`(Buffer)/ `avatarMime`;响应 user 恒不含 avatar 字段(体积)。
  - `GET /api/auth/me/avatar` → `{ dataUrl: 'data:image/png;base64,...' }`;无头像 404 `auth.avatarNotFound`。
  - PUT /api/auth/preferences 新接受键:`landingView ∈ ['cluster','workbench','last']`、`defaultClusterId: string≤64|null`、`defaultNamespace: DNS 标签 ≤63|null`、`rowsPerPage ∈ [10,20,50,100]|null`(非法值 400 `auth.preferenceInvalid`,null 合法=清除)。

- [ ] **Step 1: 写失败测试**(auth-selfservice.test.mjs 追加)

```js
test('PATCH me 头像:合法 data URL 落库;超 200KB 400;坏 mime 400;avatarClear 清空;user 响应不含 avatar', async () => {
  const db = makeDb(); seed(db)
  const routes = makeRoutes(db)
  const tinyPng = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  deps._body = { avatar: tinyPng }
  await routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(sent.at(-1).payload.user.avatar === undefined)
  assert.ok(db.prepare('SELECT avatar FROM platform_users WHERE id=?').get('u1').avatar.length > 0)
  const big = 'data:image/png;base64,' + Buffer.alloc(200 * 1024 + 1, 7).toString('base64')
  deps._body = { avatar: big }
  await routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 400)
  deps._body = { avatar: 'data:text/html;base64,PGI+' }
  await routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 400)
  deps._body = { avatarClear: true }
  await routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 200)
  assert.equal(db.prepare('SELECT avatar FROM platform_users WHERE id=?').get('u1').avatar, null)
})

test('GET avatar:有则回 dataUrl;无则 404', async () => {
  const db = makeDb(); seed(db)
  const routes = makeRoutes(db)
  await routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me/avatar'))
  assert.equal(sent.at(-1).status, 404)
  db.prepare('UPDATE platform_users SET avatar=?, avatarMime=? WHERE id=?').run(Buffer.from([1, 2, 3]), 'image/png', 'u1')
  await routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/me/avatar'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(sent.at(-1).payload.dataUrl.startsWith('data:image/png;base64,'))
})

test('PUT preferences 新键:合法落库,非法 400', async () => {
  const db = makeDb(); seed(db)
  const routes = makeRoutes(db)
  deps._body = { landingView: 'workbench', rowsPerPage: 50, defaultNamespace: 'team-a', defaultClusterId: 'c1' }
  await routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 200)
  assert.equal(JSON.parse(db.prepare('SELECT prefs FROM platform_users WHERE id=?').get('u1').prefs).landingView, 'workbench')
  deps._body = { landingView: 'evil' }
  await routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 400)
  deps._body = { rowsPerPage: 33 }
  await routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, resStub, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 400)
})
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**(auth.mjs)

PATCH /api/auth/me 块整体替换:

```js
    // PATCH /api/auth/me — 自助资料(2026-08-29 设计;Wave1 §3.5 扩头像)。
    // 白名单:displayName / avatar(data URL) / avatarClear;username/role/passwordHash 静默忽略(防穿越)。
    // 头像:仅 png/jpeg/webp,解码后 ≤200KB,存 SQLite blob(单库不变式);响应 user 恒不含 avatar 本体。
    const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp']
    const AVATAR_MAX_BYTES = 200 * 1024
    if (url.pathname === '/api/auth/me' && req.method === 'PATCH') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.displayName == null && input.avatar == null && !input.avatarClear) {
        sendJson(res, 400, { message: msg(req, 'auth.noUpdateFields') }); return true
      }
      if (input.displayName != null) {
        const displayName = String(input.displayName).trim().slice(0, 64)
        db.prepare('UPDATE platform_users SET displayName=? WHERE id=?').run(displayName || null, ps.userId)
      }
      if (input.avatarClear) {
        db.prepare('UPDATE platform_users SET avatar=NULL, avatarMime=NULL WHERE id=?').run(ps.userId)
      }
      if (input.avatar != null) {
        const m = typeof input.avatar === 'string' ? input.avatar.match(/^data:([^;,]+);base64,(.*)$/s) : null
        const buf = m ? Buffer.from(m[2], 'base64') : null
        if (!m || !AVATAR_MIMES.includes(m[1]) || !buf.length || buf.length > AVATAR_MAX_BYTES) {
          sendJson(res, 400, { message: msg(req, 'auth.avatarInvalid') }); return true
        }
        db.prepare('UPDATE platform_users SET avatar=?, avatarMime=? WHERE id=?').run(buf, m[1], ps.userId)
      }
      const user = db.prepare('SELECT id,username,role,displayName,createdAt FROM platform_users WHERE id=?').get(ps.userId)
      sendJson(res, 200, { user })
      return true
    }
```

新端点(放在 PATCH 块后):

```js
    // GET /api/auth/me/avatar — 头像读取(JSON dataUrl;header 鉴权,不走 <img> 裸链,Wave1 §3.5 裁决)
    if (url.pathname === '/api/auth/me/avatar' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const row = db.prepare('SELECT avatar, avatarMime FROM platform_users WHERE id=?').get(ps.userId)
      if (!row || !row.avatar) { sendJson(res, 404, { message: msg(req, 'auth.avatarNotFound') }); return true }
      const buf = Buffer.isBuffer(row.avatar) ? row.avatar : Buffer.from(row.avatar)
      sendJson(res, 200, { dataUrl: `data:${row.avatarMime || 'image/png'};base64,${buf.toString('base64')}` })
      return true
    }
```

PUT /api/auth/preferences 校验段(`auth.mjs:107-108` 之后)追加:

```js
      const PREF_LANDINGS = ['cluster', 'workbench', 'last']
      const PREF_ROWS = [10, 20, 50, 100]
      if (input.landingView !== undefined && input.landingView !== null && !PREF_LANDINGS.includes(input.landingView)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.defaultClusterId !== undefined && input.defaultClusterId !== null && (typeof input.defaultClusterId !== 'string' || input.defaultClusterId.length > 64)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.defaultNamespace !== undefined && input.defaultNamespace !== null && (typeof input.defaultNamespace !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.defaultNamespace))) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.rowsPerPage !== undefined && input.rowsPerPage !== null && !PREF_ROWS.includes(input.rowsPerPage)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
```

对应写入段(`auth.mjs:110-111` 后)追加:

```js
      if (input.landingView !== undefined) prefs.landingView = input.landingView
      if (input.defaultClusterId !== undefined) prefs.defaultClusterId = input.defaultClusterId
      if (input.defaultNamespace !== undefined) prefs.defaultNamespace = input.defaultNamespace
      if (input.rowsPerPage !== undefined) prefs.rowsPerPage = input.rowsPerPage
```

`server/messages/auth.mjs` 增:

```js
  'auth.avatarInvalid': { zh: '头像仅支持 png/jpeg/webp 且不超过 200KB', en: 'Avatar must be png/jpeg/webp under 200KB' },
  'auth.avatarNotFound': { zh: '尚未设置头像', en: 'No avatar set' },
```

`server/route-auth-map.mjs` 平台段追加:

```js
  { method: 'GET', pattern: '/api/auth/me/avatar', auth: 'platform' }, // 头像读取(JSON dataUrl,本人)
```

- [ ] **Step 4: 跑确认通过** `node --test server/auth-selfservice.test.mjs server/route-auth-map.test.mjs` + `npm test`
- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.mjs server/route-auth-map.mjs server/messages/auth.mjs server/auth-selfservice.test.mjs
git commit -m "feat(server): avatar upload/clear/read (SQLite blob, dataUrl readback) + preferences keys landingView/defaultClusterId/defaultNamespace/rowsPerPage"
```

---

### Task 7: 前端状态层(client.js API 扩展 + preferences store + rowsPerPage 单源)

**Files:**
- Modify: `src/api/client.js`(authApi 扩展 + adminApi.passwordPolicy/tokenPolicy)
- Modify: `src/stores/preferences.js`(4 新键)
- Create: `src/utils/rowsPerPage.js`
- Test: `src/stores/__tests__/preferences.test.js`(追加;路径以既有文件为准,`ls src/stores/__tests__/`)

**Interfaces:**
- Produces:
  - `authApi.myActivity(params)` / `authApi.getPasswordPolicy()` / `authApi.myKeysList()` / `authApi.myKeysMint(payload)` / `authApi.myKeysRevoke(id)` / `authApi.uploadAvatar(dataUrl)` / `authApi.clearAvatar()` / `authApi.getAvatar()`
  - `adminApi.passwordPolicy: { get, save }` / `adminApi.tokenPolicy: { get, save }`
  - preferences store 新状态:`landingView`、`defaultClusterId`、`defaultNamespace`、`rowsPerPage`(均 ref,null=未设置)+ `hydrateFromServer` 覆盖 + `persist()` 全量双写(PUT 带全部键);新 action `setLandingView/setDefaultClusterId/setDefaultNamespace/setRowsPerPage`(各自赋值后 `persist()`)。
  - `rowsPerPageDefault`(module ref,初值 10)+ `setRowsPerPageDefault(n)`(白名单 [10,20,50,100],越界回 10)。Task 12 的 usePagination/Login/cluster store 消费。

- [ ] **Step 1: 写失败测试**(preferences store 测试追加;沿用该文件既有 createPinia 挂载模式)

```js
test('新偏好键:hydrateFromServer 覆盖 + setXxx 即时生效并 PUT 全量键', async () => {
  const pinia = createPinia(); setActivePinia(pinia)
  const prefs = usePreferencesStore()
  prefs.hydrateFromServer({ language: 'zh', theme: 'dark', landingView: 'workbench', defaultClusterId: 'c9', defaultNamespace: 'team-a', rowsPerPage: 50 })
  expect(prefs.landingView).toBe('workbench')
  expect(prefs.defaultNamespace).toBe('team-a')
  prefs.setRowsPerPage(100)
  expect(prefs.rowsPerPage).toBe(100)
  expect(apiMocks.savePreferences).toHaveBeenLastCalledWith({ language: 'zh', theme: 'dark', landingView: 'workbench', defaultClusterId: 'c9', defaultNamespace: 'team-a', rowsPerPage: 100 })
  expect(rowsPerPageDefault.value).toBe(100)   // 联动单源模块
})

test('rowsPerPageDefault:setRowsPerPageDefault 白名单外回 10', () => {
  setRowsPerPageDefault(33); expect(rowsPerPageDefault.value).toBe(10)
  setRowsPerPageDefault(20); expect(rowsPerPageDefault.value).toBe(20)
  setRowsPerPageDefault('x'); expect(rowsPerPageDefault.value).toBe(10)
})
```

- [ ] **Step 2: 跑确认失败** `npx vitest run src/stores/__tests__/preferences.test.js --maxWorkers=2`(路径按实际)
- [ ] **Step 3: 实现**

`src/utils/rowsPerPage.js`:

```js
// 每页行数全局默认单源(2026-09-04 Wave1 §3.4)。preferences store hydrate/set 时推进;
// usePagination 等无 pinia 消费方直接 import,避免 composable 依赖 store(无 pinia 测试消费者历史事故)。
import { ref } from 'vue'

export const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100]
export const rowsPerPageDefault = ref(10)

export function setRowsPerPageDefault(n) {
  const v = Number(n)
  rowsPerPageDefault.value = ROWS_PER_PAGE_OPTIONS.includes(v) ? v : 10
}
```

`src/stores/preferences.js`:状态区加 4 个 ref;`hydrateFromServer` 加:

```js
    if (prefs.landingView) landingView.value = prefs.landingView
    if (prefs.defaultClusterId) defaultClusterId.value = prefs.defaultClusterId
    if (prefs.defaultNamespace) defaultNamespace.value = prefs.defaultNamespace
    if (prefs.rowsPerPage) { rowsPerPage.value = prefs.rowsPerPage; setRowsPerPageDefault(prefs.rowsPerPage) }
```

新 actions(模式同 setTheme:赋值 → persist);`persist()` 改为:

```js
    authApi.savePreferences({ language: language.value, theme: theme.value, landingView: landingView.value, defaultClusterId: defaultClusterId.value, defaultNamespace: defaultNamespace.value, rowsPerPage: rowsPerPage.value }).catch(() => {})
```

(localStorage 双写仅保留 language/theme 两键不变——新键是账号级偏好,登录前无意义。)return 对象加 4 状态 + 4 actions。

`src/api/client.js` authApi 对象追加:

```js
  // —— Wave1 个人域(2026-09-04)——
  myActivity: (params = {}) => platformHttp.request(`/api/my/activity?${new URLSearchParams(params)}`),
  getPasswordPolicy: () => platformHttp.request('/api/auth/password-policy'),
  myKeysList: () => platformHttp.request('/api/my/keys'),
  myKeysMint: payload => platformHttp.request('/api/my/keys', { method: 'POST', body: JSON.stringify(payload) }),
  myKeysRevoke: id => platformHttp.request(`/api/my/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadAvatar: dataUrl => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ avatar: dataUrl }) }),
  clearAvatar: () => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ avatarClear: true }) }),
  getAvatar: () => platformHttp.request('/api/auth/me/avatar'),
```

adminApi 对象追加:

```js
  passwordPolicy: {
    get: () => platformHttp.request('/api/admin/password-policy'),
    save: payload => platformHttp.request('/api/admin/password-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  tokenPolicy: {
    get: () => platformHttp.request('/api/admin/token-policy'),
    save: payload => platformHttp.request('/api/admin/token-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  },
```

- [ ] **Step 4: 跑确认通过**(store 测试)。
- [ ] **Step 5: Commit**

```bash
git add src/api/client.js src/stores/preferences.js src/utils/rowsPerPage.js src/stores/__tests__/preferences.test.js
git commit -m "feat(web): personal-domain client APIs + preferences keys (landing/default cluster+ns/rows-per-page) with rowsPerPage single-source module"
```

---

### Task 8: UserProfile tab 壳 + 三卡拆分(既有契约零回退)

**Files:**
- Create: `src/components/userCenter/ProfileSection.vue`(资料卡代码自 UserProfile.vue:98-120 迁入)
- Create: `src/components/userCenter/SecuritySection.vue`(安全卡 `:122-169` + ConfirmDialog 迁入;ConfirmDialog 随迁)
- Create: `src/components/userCenter/PreferencesSection.vue`(偏好卡 `:171-196` + langOptions/themeOptions 迁入)
- Modify: `src/views/UserProfile.vue`(壳:页头 + tab 条 + 5 个 v-if 分支)
- Modify: `src/views/__tests__/UserProfile.test.js`(mock 扩展 + 按 tab 挂载)

**Interfaces:**
- Produces: 壳的 tab 定义 `{ key: 'profile'|'security'|'activity'|'tokens'|'preferences' }`,URL query `?tab=` 可直达,非法值回 `profile`;**全部既有 data-testid 原样保留**(profile-displayname-input/save、pwd-current/new/confirm/submit、session-row、session-revoke-<fp>、sessions-revoke-others、sessions-pagination、pref-lang-*/pref-theme-*)——它们是 Task 9-12 的锚点,也是既有 10 契约的锚点。Task 10/11 的 ActivitySection/TokensSection 挂进壳的对应 v-if(本任务先留注释占位行 `<!-- Task 10/11 -->`,不 import 不存在的组件)。

- [ ] **Step 1: 先改测试(mock 扩展 + tab 挂载),跑确认红**

UserProfile.test.js 修改点:
1. `vi.mock('vue-router')` 改为:

```js
const routeState = vi.hoisted(() => ({ query: {} }))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => routeState,
}))
```

2. `apiMocks` 增(Task 9-12 会用,一次加齐):

```js
  myActivity: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 50, windowDays: 90 }),
  myKeysList: vi.fn().mockResolvedValue({ apikeys: [] }),
  myKeysMint: vi.fn(), myKeysRevoke: vi.fn(),
  myClusters: vi.fn().mockResolvedValue({ clusters: [] }),
  getPasswordPolicy: vi.fn().mockResolvedValue({ policy: { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false } }),
  getAvatar: vi.fn().mockRejectedValue({ status: 404 }),
  uploadAvatar: vi.fn(), clearAvatar: vi.fn(),
```

(`@/api/client` mock 工厂仍只 export `authApi`——子组件不得 import adminApi,否则此 mock 炸。)
3. `mountPage` 改为 `function mountPage(tab = 'security') { routeState.query = { tab }; return mount(UserProfile, { global: { plugins: [i18n] } }) }`(既有测试的挂载默认 security,保证会话类契约不变)。
4. 资料卡契约测试改 `mountPage('profile')`,偏好卡契约改 `mountPage('preferences')`。

- [ ] **Step 2: 跑 `npx vitest run src/views/__tests__/UserProfile.test.js --maxWorkers=2` 确认红**(壳未实现,session 测试找不到 testid)
- [ ] **Step 3: 拆分实现**

三个 Section 组件 = 原卡片的 `<script>` 局部状态/方法 + 模板卡片 `<div>` 原样搬迁,import 各自所需(authApi、store、ConfirmDialog、Pagination、uaSummary、notify)。要点:
- ProfileSection:自持 `displayName/savingName` 逻辑(原 :22-34)。
- SecuritySection:自持改密 + 会话列表 + 分页 + 吊销逻辑(原 :36-86)与 ConfirmDialog(原 :198-201);**预留 createdAt 展示与刷新钮给 Task 9,本任务先原样迁**。
- PreferencesSection:自持 langOptions/themeOptions(原 :89-90)。
- 壳 UserProfile.vue 全量替换为:

```vue
<script setup>
// 用户中心壳(2026-09-04 Wave1 §3.1):五 tab(资料/安全/活动/访问令牌/偏好),tab 状态走 ?tab= 可直达。
// 平台层页面(requiresCluster:false,无集群也能进);仅头像菜单进入,侧边栏不加入口。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ProfileSection from '@/components/userCenter/ProfileSection.vue'
import SecuritySection from '@/components/userCenter/SecuritySection.vue'
import PreferencesSection from '@/components/userCenter/PreferencesSection.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const TABS = [
  { key: 'profile', icon: 'person', labelKey: 'userCenter.tabProfile' },
  { key: 'security', icon: 'shield', labelKey: 'userCenter.tabSecurity' },
  { key: 'activity', icon: 'history', labelKey: 'userCenter.tabActivity' },
  { key: 'tokens', icon: 'key', labelKey: 'userCenter.tabTokens' },
  { key: 'preferences', icon: 'tune', labelKey: 'userCenter.tabPreferences' },
]
const activeTab = computed(() => (TABS.some(x => x.key === route.query.tab) ? route.query.tab : 'profile'))
function switchTab(key) { router.replace({ query: { ...route.query, tab: key } }) }
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl mx-auto flex flex-col gap-md">
    <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('userCenter.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('userCenter.subtitle') }}</p></div>

    <div class="flex gap-xs border-b border-outline-variant" data-testid="profile-tabs">
      <button v-for="tab in TABS" :key="tab.key" :data-testid="`profile-tab-${tab.key}`"
        class="flex items-center gap-xs px-md py-sm text-body-sm border-b-2 -mb-px transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'"
        @click="switchTab(tab.key)">
        <span class="material-symbols-outlined text-base">{{ tab.icon }}</span>{{ $t(tab.labelKey) }}
      </button>
    </div>

    <ProfileSection v-if="activeTab === 'profile'" />
    <SecuritySection v-else-if="activeTab === 'security'" />
    <!-- Task 10: <ActivitySection v-else-if="activeTab === 'activity'" /> -->
    <!-- Task 11: <TokensSection v-else-if="activeTab === 'tokens'" /> -->
    <PreferencesSection v-else-if="activeTab === 'preferences'" />
  </section>
</template>
```

i18n(两语言文件 userCenter 对象内):`tabProfile` 资料/Profile、`tabSecurity` 安全/Security、`tabActivity` 活动/Activity、`tabTokens` 访问令牌/Access Tokens、`tabPreferences` 偏好设置/Preferences。

- [ ] **Step 4: 跑测试确认全绿**(既有 10 契约 + 无新增);`npm run build` 过(.vue 编译)。
- [ ] **Step 5: Commit**

```bash
git add src/views/UserProfile.vue src/components/userCenter/ src/views/__tests__/UserProfile.test.js src/locales/en.json src/locales/zh.json
git commit -m "refactor(web): user center shell with five routable tabs; profile/security/preferences cards extracted verbatim"
```

---

### Task 9: 安全卡补强(createdAt 展示 + 刷新钮 + 密码策略客户端校验)

**Files:**
- Create: `src/utils/passwordRules.js`(`firstFailedRule` 前端镜像)
- Modify: `src/components/userCenter/SecuritySection.vue`
- Test: `src/views/__tests__/UserProfile.test.js`(追加)、`src/utils/passwordRules.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 的 `authApi.getPasswordPolicy()` → `{ policy }`;Task 7 无新依赖。
- Produces: `firstFailedRule(pw, policy)` / `DEFAULT_PASSWORD_POLICY`(`src/utils/passwordRules.js`,规则与 server/password-policy.mjs 逐字镜像——**双语两份是有意为之**(前端不能 import 服务端模块),测试钉住两边同构的关键用例)。

- [ ] **Step 1: 写失败测试**

`src/utils/passwordRules.test.js`(vitest):

```js
import { test, expect } from 'vitest'
import { firstFailedRule, DEFAULT_PASSWORD_POLICY, failedRuleMessageKey } from '@/utils/passwordRules'

test('镜像服务端规则:长度/mixed/digit/symbol', () => {
  expect(firstFailedRule('short')).toBe('minLength')
  expect(firstFailedRule('longenough')).toBeNull()
  const p = { minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: true }
  expect(firstFailedRule('alllowercase1!', p)).toBe('mixed')
  expect(firstFailedRule('NoDigits!!', p)).toBe('digit')
  expect(firstFailedRule('NoSymbol11Aa', p)).toBe('symbol')
  expect(firstFailedRule('Good1!aA', p)).toBeNull()
})

test('failedRuleMessageKey:映射 i18n 键', () => {
  expect(failedRuleMessageKey('minLength')).toBe('userCenter.pwdNeedMin')
  expect(failedRuleMessageKey('mixed')).toBe('userCenter.pwdNeedMixed')
  expect(failedRuleMessageKey('digit')).toBe('userCenter.pwdNeedDigit')
  expect(failedRuleMessageKey('symbol')).toBe('userCenter.pwdNeedSymbol')
})
```

UserProfile.test.js 追加:

```js
test('安全卡:会话行显示登录时间 createdAt;刷新钮重拉列表', async () => {
  const w = mountPage('security')
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(1)
  expect(w.find('[data-testid="session-row"]').text()).toContain(new Date(1756400000000).toLocaleDateString())
  await w.find('[data-testid="sessions-refresh"]').trigger('click')
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('改密:策略档(服务端 policy)缺数字 → 客户端拒绝不发请求', async () => {
  const w = mountPage('security')
  await flushPromises()
  apiMocks.getPasswordPolicy.mockResolvedValue({ policy: { minLength: 8, requireMixed: false, requireDigit: true, requireSymbol: false } })
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('NoDigitsHere')
  await w.find('[data-testid="pwd-confirm"]').setValue('NoDigitsHere')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()
  w.unmount()
})
```

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现**

`src/utils/passwordRules.js`:

```js
// 密码规则前端镜像(2026-09-04 Wave1 §3.7)。与 server/password-policy.mjs 的 firstFailedRule 逐字同构
// (有意复制:前端不 import 服务端模块);两边由各自测试钉住同构用例,改一处必改另一处。
export const DEFAULT_PASSWORD_POLICY = { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false }

export function firstFailedRule(pw, policy = DEFAULT_PASSWORD_POLICY) {
  if (typeof pw !== 'string' || pw.length < (policy.minLength ?? 8)) return 'minLength'
  if (policy.requireMixed && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) return 'mixed'
  if (policy.requireDigit && !/\d/.test(pw)) return 'digit'
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) return 'symbol'
  return null
}

export function failedRuleMessageKey(rule) {
  return rule === 'minLength' ? 'userCenter.pwdNeedMin'
    : rule === 'mixed' ? 'userCenter.pwdNeedMixed'
    : rule === 'digit' ? 'userCenter.pwdNeedDigit' : 'userCenter.pwdNeedSymbol'
}
```

SecuritySection 改动:
1. onMounted 增 `authApi.getPasswordPolicy().then(r => { policy.value = r.policy || DEFAULT_PASSWORD_POLICY }).catch(() => {})`;`changePassword` 的客户端校验段替换:

```js
  const errs = {}
  if (!pwdForm.value.current) errs.current = true
  const rule = firstFailedRule(pwdForm.value.next, policy.value)
  if (rule) { errs.next = true; nextErrorKey.value = failedRuleMessageKey(rule) }
  if (pwdForm.value.next !== pwdForm.value.confirm) errs.confirm = true
```

(模板 next 错误行 `v-if="pwdErrors.next"` 内文案改 `{{ $t(nextErrorKey || 'userCenter.passwordMinHint') }}`。)
2. 会话行次行改 `{{ s.ip || '—' }} · {{ $t('userCenter.sessionLoginAt', { time: fmtTime(s.createdAt) }) }} · {{ $t('userCenter.lastActive', { time: fmtTime(s.lastSeenAt) }) }}`。
3. 标题行(`sessionsTitle` 那行)右侧、`revokeOthers` 按钮左边加刷新钮:

```html
        <button data-testid="sessions-refresh" class="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10" :title="$t('common.refresh')" @click="loadSessions">
          <span class="material-symbols-outlined text-base">refresh</span>
        </button>
```

(若 `common.refresh` 键不存在则本任务补:`common.refresh` = 刷新/Refresh——先 grep 确认。)

i18n 追加(userCenter 对象):`pwdNeedMin` 至少 8 个字符/At least 8 characters、`pwdNeedMixed` 需同时包含大小写字母/Must contain upper and lower case、`pwdNeedDigit` 需包含数字/Must contain a digit、`pwdNeedSymbol` 需包含符号/Must contain a symbol、`sessionLoginAt` 登录于 {time}/Signed in {time}。

- [ ] **Step 4: 跑绿** `npx vitest run src/views/__tests__/UserProfile.test.js src/utils/passwordRules.test.js --maxWorkers=2`
- [ ] **Step 5: Commit**

```bash
git add src/utils/passwordRules.js src/utils/passwordRules.test.js src/components/userCenter/SecuritySection.vue src/views/__tests__/UserProfile.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(web): session card createdAt + manual refresh; client-side password policy mirror in security tab"
```

---

### Task 10: 活动 tab(ActivitySection)

**Files:**
- Create: `src/components/userCenter/ActivitySection.vue`
- Modify: `src/views/UserProfile.vue`(挂进壳)
- Test: `src/views/__tests__/UserProfile.test.js`(追加)

**Interfaces:**
- Consumes: `authApi.myActivity(params)`(Task 7);分页复用 `src/components/common/Pagination.vue`(props: total/pageSize/currentPage,event: page-change)。

- [ ] **Step 1: 写失败测试**(UserProfile.test.js 追加)

```js
test('活动 tab:挂载拉取并渲染行;result 过滤变化重拉;空态;90 天窗口提示', async () => {
  apiMocks.myActivity.mockResolvedValue({ items: [
    { seq: 3, ts: 1756400100000, tool: 'platform_login', verb: 'login', result: 'ok', owner: 'alice', clusterId: null, namespace: null, resource: null, requestSummary: 'ip=1.2.3.4' },
    { seq: 2, ts: 1756300000000, tool: 'my_key_mint', verb: 'write', result: 'ok', owner: 'alice', clusterId: 'c1', namespace: 'team-a', resource: null, requestSummary: 'id=x tier=read' },
  ], total: 2, page: 1, size: 50, windowDays: 90 })
  const w = mountPage('activity')
  await flushPromises()
  expect(apiMocks.myActivity).toHaveBeenCalledWith({})
  const rows = w.findAll('[data-testid="activity-row"]')
  expect(rows).toHaveLength(2)
  expect(w.text()).toContain('platform_login')
  expect(w.find('[data-testid="activity-window"]').text()).toContain('90')
  await w.find('[data-testid="activity-result-filter"]').setValue('denied')
  await flushPromises()
  expect(apiMocks.myActivity).toHaveBeenLastCalledWith({ result: 'denied' })
  w.unmount()
})

test('活动 tab:空列表渲染空态', async () => {
  apiMocks.myActivity.mockResolvedValue({ items: [], total: 0, page: 1, size: 50, windowDays: 90 })
  const w = mountPage('activity')
  await flushPromises()
  expect(w.find('[data-testid="activity-empty"]').exists()).toBe(true)
  w.unmount()
})
```

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现 ActivitySection**

```vue
<script setup>
// 我的活动(2026-09-04 Wave1 §3.2):audit_log 本人只读视图。服务端钳 owner+90 天窗口,前端只做过滤/分页。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import Pagination from '@/components/common/Pagination.vue'

const { t } = useI18n()
const loading = ref(false)
const items = ref([])
const total = ref(0)
const windowDays = ref(90)
const page = ref(1)
const pageSize = 50
const resultFilter = ref('')

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, size: pageSize }
    if (resultFilter.value) params.result = resultFilter.value
    const res = await authApi.myActivity(params)
    items.value = res.items || []
    total.value = res.total || 0
    windowDays.value = res.windowDays || 90
  } catch { /* 失败保留空态(与安全卡会话列表同策略) */ } finally { loading.value = false }
}
function onFilter() { page.value = 1; load() }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—' }
onMounted(load)
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <div class="flex items-center justify-between mb-md flex-wrap gap-sm">
      <h3 class="text-headline-sm font-bold">{{ $t('userCenter.activityTitle') }}</h3>
      <select v-model="resultFilter" data-testid="activity-result-filter" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-body-sm" @change="onFilter">
        <option value="">{{ $t('userCenter.filterAll') }}</option>
        <option value="ok">{{ $t('userCenter.resultOk') }}</option>
        <option value="denied">{{ $t('userCenter.resultDenied') }}</option>
        <option value="error">{{ $t('userCenter.resultError') }}</option>
      </select>
    </div>
    <p class="text-body-xs text-on-surface-variant mb-md" data-testid="activity-window">{{ $t('userCenter.activityWindow', { n: windowDays }) }}</p>

    <div v-if="loading" class="py-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></div>
    <div v-else-if="!items.length" class="py-lg text-center text-on-surface-variant text-body-sm" data-testid="activity-empty">{{ $t('userCenter.activityEmpty') }}</div>
    <div v-else class="flex flex-col gap-xs">
      <div v-for="it in items" :key="it.seq" data-testid="activity-row"
        class="flex items-start gap-md px-md py-sm rounded-lg border border-outline-variant/50">
        <span class="material-symbols-outlined text-on-surface-variant text-base shrink-0 mt-xs" :class="it.result === 'ok' ? 'text-primary' : 'text-error'">
          {{ it.result === 'ok' ? 'check_circle' : 'cancel' }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium truncate font-mono">{{ it.tool }}<span v-if="it.verb" class="ml-sm text-on-surface-variant font-sans">· {{ it.verb }}</span></p>
          <p class="text-body-xs text-on-surface-variant truncate">
            {{ fmtTime(it.ts) }}<span v-if="it.clusterId"> · {{ it.clusterId }}<span v-if="it.namespace">/{{ it.namespace }}</span></span>
            <span v-if="it.requestSummary"> · {{ it.requestSummary.slice(0, 80) }}</span>
          </p>
        </div>
      </div>
    </div>
    <Pagination v-if="total > pageSize" class="mt-sm" :total="total" :page-size="pageSize" :current-page="page"
      @page-change="(p) => { page = p; load() }" />
  </div>
</template>
```

壳挂载(Task 8 注释占位处):`<ActivitySection v-else-if="activeTab === 'activity'" />` + import。

i18n:`activityTitle` 我的活动/My Activity、`filterAll` 全部/All、`resultOk` 成功/Success、`resultDenied` 被拒绝/Denied、`resultError` 出错/Error、`activityWindow` 展示最近 {n} 天记录/Showing the last {n} days、`activityEmpty` 暂无活动记录/No recent activity。

- [ ] **Step 4: 跑绿** + `npm run build`
- [ ] **Step 5: Commit**

```bash
git add src/components/userCenter/ActivitySection.vue src/views/UserProfile.vue src/views/__tests__/UserProfile.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(web): my-activity tab — per-user audit rows with result filter, pagination, 90-day window notice"
```

---

### Task 11: 访问令牌 tab(TokensSection)

**Files:**
- Create: `src/components/userCenter/TokensSection.vue`
- Modify: `src/views/UserProfile.vue`(挂进壳)
- Test: `src/views/__tests__/UserProfile.test.js`(追加)

**Interfaces:**
- Consumes: `authApi.myKeysList/myKeysMint/myKeysRevoke/myClusters`(Task 7);`ConfirmDialog`。

- [ ] **Step 1: 写失败测试**(UserProfile.test.js 追加;`apiMocks.myClusters` 已在 Task 8 mock)

```js
test('令牌 tab:挂载拉 key 列表 + 集群列表,渲染行(含过期/吊销态)', async () => {
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [
    { id: 'k1', prefix: 'abcd1234', label: 'ci', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756400000000, expiresAt: Date.now() + 86400000, lastUsedAt: null, revokedAt: null, ownerUserId: 'u1' },
    { id: 'k2', prefix: 'beef5678', label: 'old', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756300000000, expiresAt: Date.now() - 86400000, lastUsedAt: 1756390000000, revokedAt: null, ownerUserId: 'u1' },
    { id: 'k3', prefix: 'dead0000', label: 'x', clusterId: 'c1', boundSA_namespace: 'team-a', tier: 'read', createdAt: 1756200000000, expiresAt: null, lastUsedAt: null, revokedAt: 1756250000000, ownerUserId: 'u1' },
  ] })
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  const w = mountPage('tokens')
  await flushPromises()
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(1)
  const rows = w.findAll('[data-testid="token-row"]')
  expect(rows).toHaveLength(3)
  expect(rows[0].text()).toContain('abcd1234')
  expect(rows[1].text()).toContain(w.vm.$.t ? '' : '')    // 过期态由 status badge 断言:
  expect(rows[1].html()).toContain('expired')              // data-testid=token-status-expired
  expect(rows[2].html()).toContain('revoked')
  w.unmount()
})

test('签发:填表 mint → 明文只显一次弹窗(含复制钮)→ 关闭后列表重拉', async () => {
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [] })
  apiMocks.myKeysMint.mockResolvedValue({ apikey: { id: 'k9', plaintext: 'PLAINTEXT-VALUE-123', prefix: 'PLAINTEXT' } })
  const w = mountPage('tokens')
  await flushPromises()
  await w.find('[data-testid="token-mint-btn"]').trigger('click')
  await w.find('[data-testid="token-mint-cluster"]').setValue('c1')
  await w.find('[data-testid="token-mint-namespace"]').setValue('team-a')
  await w.find('[data-testid="token-mint-submit"]').trigger('click')
  await flushPromises()
  expect(apiMocks.myKeysMint).toHaveBeenCalledWith({ clusterId: 'c1', namespace: 'team-a', tier: 'read', label: '', ttlDays: 30 })
  expect(w.find('[data-testid="token-plaintext"]').text()).toContain('PLAINTEXT-VALUE-123')
  await w.find('[data-testid="token-plaintext-close"]').trigger('click')
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('吊销:确认框链后调 myKeysRevoke 并重拉', async () => {
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  apiMocks.myKeysList.mockResolvedValue({ apikeys: [{ id: 'k1', prefix: 'abcd1234', label: '', clusterId: 'c1', boundSA_namespace: 'n', tier: 'read', createdAt: 1, expiresAt: null, lastUsedAt: null, revokedAt: null }] })
  apiMocks.myKeysRevoke.mockResolvedValue({ ok: true })
  const w = mountPage('tokens')
  await flushPromises()
  await w.find('[data-testid="token-revoke-k1"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-ok"]').click()   // ConfirmDialog Teleport 到 body(既有契约,UserProfile.test.js:98 同款)
  await flushPromises()
  expect(apiMocks.myKeysRevoke).toHaveBeenCalledWith('k1')
  expect(apiMocks.myKeysList).toHaveBeenCalledTimes(2)
  w.unmount()
})
```

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现 TokensSection**(结构:列表卡 + 签发 Modal + 明文一次性 Modal + 吊销 ConfirmDialog;Modal 组件用 `src/components/common/Modal.vue`,props 用法参考 CreateFromYamlDialog 的调用点)

核心逻辑(script 关键段,模板按仓库既有卡片/Modal 风格组装):

```js
const keys = ref([])
const clusters = ref([])
const showMint = ref(false)
const mintForm = ref({ clusterId: '', namespace: '', tier: 'read', label: '', ttlDays: 30 })
const mintError = ref('')
const plaintext = ref('')        // 非空 = 显示一次性弹窗
const revokeTarget = ref(null)
const showRevokeConfirm = ref(false)

async function load() {
  try { keys.value = (await authApi.myKeysList()).apikeys || [] } catch { keys.value = [] }
  try { clusters.value = (await authApi.myClusters()).clusters || [] } catch { clusters.value = [] }
}
function statusOf(k) {
  if (k.revokedAt) return 'revoked'
  if (k.expiresAt && Date.now() > k.expiresAt) return 'expired'
  return 'active'
}
async function mint() {
  mintError.value = ''
  if (!mintForm.value.clusterId || !mintForm.value.namespace) { mintError.value = t('mykeys.formIncomplete'); return }
  try {
    const res = await authApi.myKeysMint({ ...mintForm.value })
    showMint.value = false
    plaintext.value = res.apikey.plaintext
    load()
  } catch (e) { mintError.value = e.message || t('common.opFailed') }
}
async function doRevoke() {
  const target = revokeTarget.value; showRevokeConfirm.value = false
  if (!target) return
  try { await authApi.myKeysRevoke(target.id); load() } catch (e) { notify('error', e.message || t('common.opFailed')) }
}
function fmtDay(ts) { return ts ? new Date(ts).toLocaleDateString() : '—' }
onMounted(load)
```

模板要点(必须的 testid):`token-mint-btn`、`token-mint-cluster`(select,option 来自 clusters)、`token-mint-namespace`(input)、tier 二选一钮(`token-mint-tier-read` / `token-mint-tier-operator`)、`token-mint-ttl`(select 7/30/90)、`token-mint-submit`、行 `token-row`(prefix 等宽 + label + clusterId/ns + tier + 过期日 `fmtDay(expiresAt)` + 最近使用 `lastUsedAt ? fmtDay : '—'`)、状态徽章 `token-status-active/expired/revoked`、行内吊销钮 `token-revoke-<id>`(仅非 revoked 行)、一次性弹窗 `token-plaintext`(等宽明文 + 复制钮 `token-copy` + 关闭 `token-plaintext-close`,文案警告仅显示一次)。

i18n(`userCenter.tokens.*` 与 `mykeys.*` 前端键):tokensTitle 访问令牌/Access Tokens、tokensHint 用于 CI/MCP 的个人凭据;权限随你的账号实时收缩/Personal credentials for CI or MCP; scope shrinks live with your account、mintBtn 签发令牌/Create Token、mintCluster 集群/Cluster、mintNamespace 绑定 Namespace/Bound Namespace、mintTier 档位/Tier、tierRead 只读/Read-only、tierOperator 可操作/Operate、mintTtl 有效期(天)/TTL (days)、mintSubmit 签发/Create、plaintextTitle 请立即保存令牌/Save your token now、plaintextHint 关闭后无法再次查看/It will never be shown again、copy 复制/Copy、copied 已复制/Copied、colToken 令牌/Token、colLabel 备注/Label、colScope 范围/Scope、colExpires 过期于/Expires、colLastUsed 最近使用/Last used、statusActive 生效中/Active、statusExpired 已过期/Expired、statusRevoked 已吊销/Revoked、revokeConfirmTitle 吊销该令牌?/Revoke this token?、revokeConfirmMessage 使用它的集成将立即失效/Integrations using it stop working immediately、formIncomplete 请选择集群并填写 namespace/Pick a cluster and fill in the namespace。

- [ ] **Step 4: 跑绿** + `npm run build`
- [ ] **Step 5: Commit**

```bash
git add src/components/userCenter/TokensSection.vue src/views/UserProfile.vue src/views/__tests__/UserProfile.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(web): access tokens tab — self-service list/mint (show-once plaintext)/revoke with cluster+ns+tier+TTL form"
```

---

### Task 12: 偏好丰富化(UI + 四个消费点)

**Files:**
- Modify: `src/components/userCenter/PreferencesSection.vue`
- Modify: `src/composables/usePagination.js`(默认行数)
- Modify: `src/stores/auth.js`(tryAutoConnect 首选 defaultClusterId)
- Modify: `src/views/Login.vue`(落地页)
- Modify: `src/stores/cluster.js`(defaultNamespace 应用,namespace 列表加载处 `cluster.js:519` 旁)
- Modify: `src/router/index.js`(afterEach 记录 lastView)
- Test: `src/views/__tests__/UserProfile.test.js`(追加)、`src/stores/__tests__/preferences.test.js` 已覆盖 store;消费点各补最小断言

**Interfaces:**
- Consumes: Task 7 的 store 新状态与 `rowsPerPageDefault`。

- [ ] **Step 1: 写失败测试**

UserProfile.test.js 追加:

```js
test('偏好 tab:新增五项控件渲染且写入 store', async () => {
  apiMocks.myClusters.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod' }] })
  const w = mountPage('preferences')
  await flushPromises()
  await w.find('[data-testid="pref-landing"]').setValue('workbench')
  expect(usePreferencesStore().landingView).toBe('workbench')
  await w.find('[data-testid="pref-default-cluster"]').setValue('c1')
  expect(usePreferencesStore().defaultClusterId).toBe('c1')
  await w.find('[data-testid="pref-default-ns"]').setValue('team-a')
  expect(usePreferencesStore().defaultNamespace).toBe('team-a')
  await w.find('[data-testid="pref-rows"]').setValue('50')
  expect(usePreferencesStore().rowsPerPage).toBe(50)
  w.unmount()
})
```

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现**

PreferencesSection 在语言/主题两块后追加(2×2 grid 延伸,风格同既有分段按钮):

```html
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefLanding') }}</p>
        <select v-model="landingModel" data-testid="pref-landing" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setLandingView(landingModel)">
          <option value="cluster">{{ $t('userCenter.landingCluster') }}</option>
          <option value="workbench">{{ $t('userCenter.landingWorkbench') }}</option>
          <option value="last">{{ $t('userCenter.landingLast') }}</option>
        </select>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefRows') }}</p>
        <select v-model="rowsModel" data-testid="pref-rows" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setRowsPerPage(Number(rowsModel))">
          <option v-for="n in [10, 20, 50, 100]" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefDefaultCluster') }}</p>
        <select v-model="clusterModel" data-testid="pref-default-cluster" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setDefaultClusterId(clusterModel || null)">
          <option value="">{{ $t('userCenter.filterAll') }}</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="sm:col-span-2">
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefDefaultNs') }}</p>
        <input v-model="nsModel" data-testid="pref-default-ns" placeholder="default" maxlength="63"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setDefaultNamespace(nsModel || null)" />
        <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('userCenter.prefDefaultNsHint') }}</p>
      </div>
```

(script 增 `landingModel = ref(prefs.landingView || 'cluster')`、`rowsModel = ref(prefs.rowsPerPage || 10)`、`clusterModel = ref(prefs.defaultClusterId || '')`、`nsModel = ref(prefs.defaultNamespace || '')`、`clusters = ref([])`;onMounted 增 `authApi.myClusters().then(r => { clusters.value = r.clusters || [] }).catch(() => {})`——与登录后 tryAutoConnect 的 `defaultClusterId` 消费点(Task 12 下方)闭环,选项=已分配集群,语义与服务端交集一致。)

`src/composables/usePagination.js:9` 改:

```js
import { rowsPerPageDefault } from '@/utils/rowsPerPage'
...
  const pageSize = ref(opts.pageSize ?? rowsPerPageDefault.value)
```

`src/stores/auth.js` tryAutoConnect 改:

```js
  // 自动连接(登录后调用):优先偏好里的默认集群(未授权/失效则静默降级),再回退上次使用的集群。
  async function tryAutoConnect() {
    const preferred = usePreferencesStore().defaultClusterId
    if (preferred) {
      try { return await connectCluster(preferred) } catch { /* 首选失效 → 降级 last */ }
    }
    const lastId = localStorage.getItem(LAST_CLUSTER_KEY)
    if (!lastId) return null
    try {
      return await connectCluster(lastId)
    } catch {
      localStorage.removeItem(LAST_CLUSTER_KEY)
      return null
    }
  }
```

`src/views/Login.vue:33-38` 改:

```js
    // 落地页偏好(Wave1 §3.4):redirect > landingView > 自动连集群(现状)
    const landing = usePreferencesStore().landingView
    if (landing === 'workbench') { router.push('/workbench'); return }
    if (landing === 'last') {
      const last = localStorage.getItem('aliangboard.lastView')
      if (last && last.startsWith('/') && !last.startsWith('/login')) { window.location.href = last; return }
    }
    const auto = await authStore.tryAutoConnect()
```

(import 增 `usePreferencesStore`。)

`src/router/index.js`:在既有 `router.afterEach` 内追加(保留 applyRouteTitle):

```js
router.afterEach((to) => {
  applyRouteTitle(to)
  // Wave1 §3.4:「上次访问」落地页的记忆源(login 不记,防止落地回登录页)
  if (to.path && to.path !== '/login') {
    try { localStorage.setItem('aliangboard.lastView', to.fullPath || to.path) } catch { /* 无 storage */ }
  }
})
```

(若 afterEach 形态不同——如已有多个 afterEach——把存储逻辑并入既有回调,不新挂第二个。)

`src/stores/cluster.js:519-522` 改:

```js
      if (currentNamespace.value && namespaceList.value.length
          && !namespaceList.value.some(n => n.name === currentNamespace.value)) {
        setNamespace(namespaceList.value[0].name)
      } else if (!currentNamespace.value) {
        // Wave1 §3.4:无记忆 ns 时落偏好默认(仅当其存在于该集群;无 pinia 环境(单测)静默跳过)
        let preferred = null
        try { preferred = usePreferencesStore().defaultNamespace } catch { /* 无 pinia */ }
        if (preferred && namespaceList.value.some(n => n.name === preferred)) setNamespace(preferred)
      }
```

(文件顶部 `import { usePreferencesStore } from '@/stores/preferences'`;函数内惰性调用 + try/catch,守住「store 加依赖必查无 pinia 测试消费者」教训。)

i18n:`prefLanding` 登录后进入/Landing page、landingCluster 集群总览/Cluster overview、landingWorkbench 工作台/Workbench、landingLast 上次访问/Last visited、prefRows 每页行数/Rows per page、prefDefaultCluster 默认集群/Default cluster、prefDefaultNs 默认 Namespace/Default Namespace、prefDefaultNsHint 进入集群时未记住 namespace 则用它/Used when no namespace is remembered for the cluster。

- [ ] **Step 4: 跑绿**:UserProfile 测试 + preferences 测试 + `npx vitest run src/stores/__tests__ --maxWorkers=2`(cluster store 若有测试,确认 defaultNamespace 改动无 pinia 回归)+ `npm test` + `npm run build`
- [ ] **Step 5: Commit**

```bash
git add src/components/userCenter/PreferencesSection.vue src/composables/usePagination.js src/stores/auth.js src/views/Login.vue src/stores/cluster.js src/router/index.js src/views/__tests__/UserProfile.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(web): preferences enrichment — landing page, rows-per-page via usePagination default, default namespace on cluster load, lastView memory"
```

---

### Task 13: 头像 UI(裁剪压缩工具 + 共享 composable + 两处消费)

**Files:**
- Create: `src/utils/avatarImage.js`
- Create: `src/composables/useAvatar.js`
- Modify: `src/components/userCenter/ProfileSection.vue`(上传/清除)
- Modify: `src/components/layout/UserMenu.vue`(头像位渲染)
- Test: `src/utils/avatarImage.test.js`、`src/views/__tests__/UserProfile.test.js`、`src/components/layout/__tests__/UserMenu.test.js`(追加)

**Interfaces:**
- Consumes: Task 6 的 `authApi.uploadAvatar/clearAvatar/getAvatar`;Task 8 mock 已含 getAvatar(mockRejected 404)。
- Produces:
  - `squareCrop(w, h) -> { sx, sy, s }`(中心正方形裁剪,纯函数,happy-dom 可测)
  - `fileToAvatarDataUrl(file) -> Promise<'data:image/...;base64,...' | null>`(null = 非图片/解码失败;输出 256×256 jpeg quality 0.85,≤200KB 由服务端再校验)
  - `useAvatar() -> { avatarDataUrl, ensureLoaded, apply, clearLocal }`(模块级单例 ref:UserMenu 与 ProfileSection 共享同一份数据,上传后即时同步)

- [ ] **Step 1: 写失败测试**

`src/utils/avatarImage.test.js`:

```js
import { test, expect } from 'vitest'
import { squareCrop } from '@/utils/avatarImage'

test('squareCrop:横图/竖图/方图中心裁剪', () => {
  expect(squareCrop(800, 400)).toEqual({ sx: 200, sy: 0, s: 400 })
  expect(squareCrop(400, 800)).toEqual({ sx: 0, sy: 200, s: 400 })
  expect(squareCrop(400, 400)).toEqual({ sx: 0, sy: 0, s: 400 })
})
```

UserMenu.test.js 追加(mock 工厂同步扩 `getAvatar: vi.fn()`、`clearAvatar: vi.fn()`、`uploadAvatar: vi.fn()`;`beforeEach` 里 `apiMocks.getAvatar.mockReset()`):

```js
test('头像已设置:触发钮渲染 img(getAvatar resolve dataUrl)', async () => {
  apiMocks.getAvatar.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAA' })
  const w = mountMenu()      // 该文件既有的挂载 helper 名以实际为准
  await flushPromises()
  expect(w.find('[data-testid="user-avatar-img"]').exists()).toBe(true)
  w.unmount()
})

test('头像未设置(getAvatar 404):回退首字母圆', async () => {
  apiMocks.getAvatar.mockRejectedValue({ status: 404 })
  const w = mountMenu()
  await flushPromises()
  expect(w.find('[data-testid="user-avatar-fallback"]').exists()).toBe(true)
  w.unmount()
})
```

UserProfile.test.js 追加(mock `@/utils/avatarImage` 的 `fileToAvatarDataUrl` 返回固定 dataUrl,绕开 canvas——happy-dom 无 2d context):

```js
vi.mock('@/utils/avatarImage', () => ({
  AVATAR_SIZE: 256,
  squareCrop: (w, h) => ({ sx: 0, sy: 0, s: Math.min(w, h) }),
  isSupportedImage: (f) => !!f && f.type === 'image/jpeg',
  fileToAvatarDataUrl: vi.fn(async (f) => (f && f.type === 'image/jpeg' ? 'data:image/jpeg;base64,AAA' : null)),
}))

test('资料卡:上传头像调 uploadAvatar 且共享态即时更新', async () => {
  apiMocks.uploadAvatar.mockResolvedValue({ user: {} })
  const w = mountPage('profile')
  await flushPromises()
  const input = w.find('[data-testid="avatar-input"]')
  await input.trigger('change', { target: { files: [new File([], 'a.jpg', { type: 'image/jpeg' })], value: '' } })
  await flushPromises()
  expect(apiMocks.uploadAvatar).toHaveBeenCalledWith('data:image/jpeg;base64,AAA')
  expect(w.find('[data-testid="avatar-img"]').exists()).toBe(true)   // 共享单例即时生效
  w.unmount()
})

test('资料卡:清除头像调 clearAvatar 并回退首字母', async () => {
  apiMocks.clearAvatar.mockResolvedValue({ user: {} })
  const w = mountPage('profile')
  await flushPromises()
  await w.find('[data-testid="avatar-clear"]').trigger('click')
  await flushPromises()
  expect(apiMocks.clearAvatar).toHaveBeenCalledTimes(1)
  expect(w.find('[data-testid="avatar-fallback"]').exists()).toBe(true)
  w.unmount()
})
```

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现**

`src/utils/avatarImage.js`:

```js
// 头像文件 → 256×256 data URL(2026-09-04 Wave1 §3.5)。前端 canvas 中心裁剪+压缩,服务端只做兜底校验。
// squareCrop 是纯函数(单测);fileToAvatarDataUrl 依赖 Image/canvas(真浏览器路径,happy-dom 不测)。
export const AVATAR_SIZE = 256

export function squareCrop(w, h) {
  const s = Math.min(w, h)
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s }
}

export function isSupportedImage(file) {
  return !!file && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
}

export function fileToAvatarDataUrl(file) {
  return new Promise((resolve) => {
    if (!isSupportedImage(file)) { resolve(null); return }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const { sx, sy, s } = squareCrop(img.naturalWidth, img.naturalHeight)
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE; canvas.height = AVATAR_SIZE
        canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch { resolve(null) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}
```

`src/composables/useAvatar.js`:

```js
// 头像共享态(2026-09-04 Wave1 §3.5):模块级单例——UserMenu(顶栏)与 ProfileSection(上传处)
// 引用同一 ref,上传/清除即时全站生效。会话内缓存一次;登出后下次进入由页面重新 ensureLoaded。
import { ref } from 'vue'
import { authApi } from '@/api/client'

const avatarDataUrl = ref(null)
let fetchOnce = null

export function useAvatar() {
  function ensureLoaded() {
    if (!fetchOnce) {
      fetchOnce = authApi.getAvatar().then(r => { avatarDataUrl.value = r?.dataUrl || null }).catch(() => { avatarDataUrl.value = null })
    }
    return fetchOnce
  }
  function apply(dataUrl) { avatarDataUrl.value = dataUrl; fetchOnce = fetchOnce || Promise.resolve() }
  function clearLocal() { avatarDataUrl.value = null }
  return { avatarDataUrl, ensureLoaded, apply, clearLocal }
}
```

ProfileSection 头像区(替换原首字母圆 div 的头像部分;`user`/`initial` 逻辑随迁):

```html
      <div class="relative shrink-0">
        <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="avatar-img" alt="avatar"
          class="w-14 h-14 rounded-full object-cover border border-outline-variant" />
        <div v-else data-testid="avatar-fallback"
          class="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-lg font-bold">{{ initial }}</div>
      </div>
```

(displayName 编辑行下方加一行操作:`<input type="file" accept="image/png,image/jpeg,image/webp" data-testid="avatar-input" class="hidden" ref="avatarFileEl" @change="onAvatarFile" />` + 两个按钮 `avatar-pick`(触发 input.click)/ `avatar-clear`(调 `authApi.clearAvatar()` → `clearLocal()` → toast)。)

```js
async function onAvatarFile(e) {
  const file = e.target?.files?.[0]
  e.target.value = ''
  if (!file) return
  const dataUrl = await fileToAvatarDataUrl(file)
  if (!dataUrl) { notify('error', t('userCenter.avatarInvalid')); return }
  try {
    await authApi.uploadAvatar(dataUrl)
    apply(dataUrl)
    notify('success', t('common.save'))
  } catch (err) { notify('error', err.message || t('common.opFailed')) }
}
```

UserMenu.vue:两处头像(触发钮 8×8 + 菜单头 10×10)改为同款 `v-if avatarDataUrl` img / `v-else` 首字母 div(testid: 触发钮处 `user-avatar-img`/`user-avatar-fallback`);`onMounted(() => { ensureLoaded() })`(onMounted 已有,追加一行)。

i18n:`userCenter.avatarUpload` 上传头像/Upload avatar、`userCenter.avatarClear` 清除头像/Remove avatar、`userCenter.avatarInvalid` 仅支持 png/jpeg/webp/Only png, jpeg, webp are supported。

- [ ] **Step 4: 跑绿**:`npx vitest run src/utils/avatarImage.test.js src/views/__tests__/UserProfile.test.js src/components/layout/__tests__/UserMenu.test.js --maxWorkers=2` + `npm run build`
- [ ] **Step 5: Commit**

```bash
git add src/utils/avatarImage.js src/utils/avatarImage.test.js src/composables/useAvatar.js src/components/userCenter/ProfileSection.vue src/components/layout/UserMenu.vue src/views/__tests__/UserProfile.test.js src/components/layout/__tests__/UserMenu.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(web): avatar upload with canvas center-crop to 256px, shared singleton state across UserMenu and profile"
```

---

### Task 14: admin 安全策略 UI(Settings.vue)+ token-policy 端点 + 门禁收口

**Files:**
- Modify: `server/routes/admin.mjs`(GET/PUT /api/admin/token-policy,参照 :150-177 ssh-session-policy 模式)
- Modify: `server/index.mjs`(无——admin 前缀已盖 ROUTE_AUTH;守卫测试若要求字面量登记则补 2 条)
- Modify: `src/views/admin/Settings.vue`(新 admin-only tab「安全策略」:密码策略表单 + 令牌 TTL 上限)
- Modify: `src/api/client.js`——无(Task 7 已加)
- Test: `server/admin-policy.test.mjs`(新建)、`src/views/admin/__tests__/`(Settings 相关测试文件若存在则追加,否则组件改动由 build+i18n 门禁覆盖,服务端契约由新测试钉住)

**Interfaces:**
- Produces: `GET /api/admin/token-policy` → `{ maxTtlDays }`;`PUT` body `{ maxTtlDays }`(整数 1..365)→ `{ ok: true, maxTtlDays }`;非法 400 `admin.tokenPolicyInvalid`。设置键 `'apikey.maxTtlDays'`(Task 4 消费)。

- [ ] **Step 1: 写失败测试**(Create `server/admin-policy.test.mjs`)

```js
// admin 安全策略端点(2026-09-04 Wave1 §3.3/§3.7):token-policy GET/PUT 与 password-policy PUT 校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'
import { createAuditSchema } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  return db
}

function makeRoutes(db, { role = 'admin' } = {}) {
  const sent = []
  const store = new Map()
  const deps = {
    db, sendJson: (_r, s, p) => sent.push({ status: s, payload: p }), readBody: async (req) => req._body,
    requireAdmin: (req) => (req._ps?.role === 'admin' ? req._ps : null),
    getSetting: (k) => store.get(k) ?? null, setSetting: (k, v) => store.set(k, String(v)),
    writeAudit: () => {}, platformSessions: new Map(), sessions: new Map(),
  }
  return { routes: createAdminRoutes(deps), sent, store }
}

const ADMIN = { _ps: { userId: 'a1', username: 'root', role: 'admin' } }

test('token-policy:GET 初始 90;PUT 30 落 store;PUT 0/400/NaN 400', async () => {
  const db = makeDb(); const { routes, sent, store } = makeRoutes(db)
  const call = (method, body) => routes.handle({ ...ADMIN, method, _body: body }, {}, new URL('http://x/api/admin/token-policy'))
  await call('GET')
  assert.deepEqual(sent.at(-1).payload, { maxTtlDays: 90 })
  await call('PUT', { maxTtlDays: 30 })
  assert.equal(sent.at(-1).status, 200); assert.equal(store.get('apikey.maxTtlDays'), '30')
  await call('PUT', { maxTtlDays: 0 }); assert.equal(sent.at(-1).status, 400)
  await call('PUT', { maxTtlDays: 400 }); assert.equal(sent.at(-1).status, 400)
  await call('PUT', { maxTtlDays: NaN }); assert.equal(sent.at(-1).status, 400)
  await call('GET'); assert.deepEqual(sent.at(-1).payload, { maxTtlDays: 30 })
})

test('token-policy:非 admin 403(requireAdmin stub 返 null)', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  await routes.handle({ _ps: { userId: 'u1', username: 'bob', role: 'user' }, method: 'PUT', _body: { maxTtlDays: 30 } }, {}, new URL('http://x/api/admin/token-policy'))
  assert.equal(sent.at(-1).status, 401)
})

test('password-policy PUT:minLength<8 400;合法落 JSON;GET 回显归一化策略', async () => {
  const db = makeDb(); const { routes, sent, store } = makeRoutes(db)
  const put = (body) => routes.handle({ ...ADMIN, method: 'PUT', _body: body }, {}, new URL('http://x/api/admin/password-policy'))
  const get = () => routes.handle({ ...ADMIN, method: 'GET' }, {}, new URL('http://x/api/admin/password-policy'))
  await put({ minLength: 3 }); assert.equal(sent.at(-1).status, 400)
  await put({ minLength: 12, requireDigit: true }); assert.equal(sent.at(-1).status, 200)
  assert.deepEqual(JSON.parse(store.get('auth.passwordPolicy')), { minLength: 12, requireMixed: false, requireDigit: true, requireSymbol: false })
  await get(); assert.equal(sent.at(-1).payload.policy.minLength, 12)
})
```

(注:admin.mjs 的 createAdminRoutes deps 远多于上述子集——stub 工厂只提供被测路径用到的键;若 admin.mjs 顶部解构对缺失键立即取用(非调用期),补 `randomUUID: () => 'x'` 等哑值,以 `node --test` 报错为准逐个补。)

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现**(admin.mjs,password-policy 块后)

```js
    if (url.pathname === '/api/admin/token-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { maxTtlDays: Math.min(Math.max(Math.floor(Number(getSetting('apikey.maxTtlDays')) || 90), 1), 365) })
      return true
    }
    if (url.pathname === '/api/admin/token-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      const n = Math.floor(Number(input?.maxTtlDays))
      if (!Number.isFinite(n) || n < 1 || n > 365) { sendJson(res, 400, { message: msg(req, 'admin.tokenPolicyInvalid') }); return true }
      setSetting('apikey.maxTtlDays', String(n))
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_token_policy', result: 'ok', requestSummary: `maxTtlDays=${n}`, source: 'platform' })
      sendJson(res, 200, { ok: true, maxTtlDays: n })
      return true
    }
```

`server/messages/admin.mjs` 增:`'admin.tokenPolicyInvalid': { zh: '令牌有效期上限须在 1-365 天', en: 'Token max TTL must be 1-365 days' }`。

Settings.vue:复刻 `mcp`/`ssh` admin tab 的既有写法(读 :406-423 的 ssh tab 条目与 section 块,新 tab key `'security'`,admin 门控字段照抄兄弟条目)。section 内容 = 两个小表单卡:
1. 密码策略:minLength(number input 8..128)+ 三个 checkbox(requireMixed/requireDigit/requireSymbol);`onMounted` → `adminApi.passwordPolicy.get()` 预填;保存钮 `data-testid="policy-save"` → `adminApi.passwordPolicy.save(form)` → toast。
2. 令牌上限:number input `data-testid="token-ttl-input"`(1..365)+ 保存钮 → `adminApi.tokenPolicy.save({ maxTtlDays: n })` → toast。

i18n(admin 命名空间):`admin.securityPolicy.title` 安全策略/Security Policy、`admin.securityPolicy.password` 密码策略/Password Policy、`admin.securityPolicy.minLength` 最小长度/Min length、`admin.securityPolicy.requireMixed` 需大小写字母/Require mixed case、`admin.securityPolicy.requireDigit` 需数字/Require digit、`admin.securityPolicy.requireSymbol` 需符号/Require symbol、`admin.securityPolicy.tokenTtl` 令牌有效期上限(天)/Token max TTL (days)、`admin.securityPolicy.saved` 已保存/Saved。

- [ ] **Step 4: 全量门禁收口**(本任务也是收尾任务)

```bash
npm test                                # 服务端全量
npm run test:unit -- --maxWorkers=2     # 前端全量(多会话并行期限 worker)
npm run typecheck                       # node --check 全 .js/.mjs
npm run i18n:check                      # 残留中文/键对齐/引用键缺失三合一
npm run build                           # .vue 编译 + 打包
node --test server/route-auth-map.test.mjs   # 守卫测试(新端点登记完整性)
```

Expected: 全绿。任何红灯先分辨既有 flaky(记忆在案:WorkbenchChat 审批 CAS)与本波引入。

- [ ] **Step 5: Commit + 合并**

```bash
git add server/routes/admin.mjs server/admin-policy.test.mjs server/messages/admin.mjs src/views/admin/Settings.vue server/route-auth-map.mjs src/locales/en.json src/locales/zh.json
git commit -m "feat(admin): security policy settings tab (password policy + token max TTL) with GET/PUT token-policy endpoint"
```

随后按仓库惯例在 worktree 分支收尾:`--no-ff` 合回 main,合并前 `git log main..HEAD` 核对区间构成(多会话教训)。

---

## 手测清单(合并后,需网关重启 + 真浏览器)

1. `/profile?tab=tokens` 直达;签发 key → 明文只显一次 → 刷新后列表在;用该 key 打 `/api/key/<cluster>/call` 成功且 `lastUsedAt` 出现;把 owner 的集群分配收回 → 该 key 立即 401。
2. 活动 tab 出现登录/改密/签发记录;result 过滤生效;他人操作不出现。
3. admin 把密码策略调成 requireDigit → 普通用户改密(缺数字)前后端同时拒绝。
4. 头像上传(横图)→ 顶栏与资料卡同步变;清除后回首字母。
5. 落地页设为工作台 → 重新登录直达 `/workbench`;rowsPerPage=50 → 列表页默认 50 行。
6. 令牌 TTL 上限设 7 → 用户签发页选 90 → 服务端钳到 7(或前端提交后 400,以实现为准:钳制)。

## 非目标(本波明确不做)

email/忘记密码、通知偏好、个人态漫游(自建列服务端化)、kubeconfig 下载、MFA、admin ApiKeyManagement 界面改造(其数据行新增列即可,UI 不动)、`rowsPerPage` 覆盖 29 处手写 `ref(10)` 视图(usePagination 消费方即得,显式传参者按 spec「不被覆盖」保持)。
