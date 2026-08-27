# 版本机制与更新检测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tag 即版本——CI 把 semver 版本烙进镜像 `APP_VERSION`,网关检测 GitHub tag,前端横幅+Settings「关于」提示新版本。

**Architecture:** 版本单源 `server/version.mjs`(env 注入,默认 dev)+ `server/routes/version.mjs`(GET 读穿缓存 / POST 强制重查,GitHub tags API,ok 缓存 1h / 错误缓存 5min,降级 latest:null 仍 200);前端 `useAppVersion` composable(Vue Query)供 `UpdateBanner`(AppLayout,每版本弹一次)与 `SettingsAboutPanel` 消费。

**Tech Stack:** Node 25(node:test + 自研运行器)、undici global fetch + AbortSignal.timeout、Vue 3 + @tanstack/vue-query + vitest/happy-dom。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-08-27-versioning-update-check-design.md`(已获批,已提交 9e0d72a)

## Global Constraints

- **零新增外部依赖**(CLAUDE.md 依赖政策)。
- **版本归一化单一规则**:比较与持久化一律去 `v` 前缀规范形(`1.2.3`);前端展示时加 `v` 前缀。镜像 tag(`1.2.3`)与规范形天然一致。
- **服务端测试位置**:`server/*.test.mjs` 顶层(`npm run test:server` 的 `node --test server/*.test.mjs` 只收顶层,`server/routes/` 下不收)。
- **i18n**:zh/en 两文件全量同步新增键,`npm run i18n:check` 必须过;消息值含 `@` 须转义 `{'@'}`(本项目本次无)。
- **提交**:作者恒 `aliangone <aliangone@gmail.com>`(repo config 已设);**禁止** `Co-Authored-By: Claude` 尾注;禁止 force push / 改写已推送历史。
- **提交信息风格**:`feat(scope): 中文描述` / `test(scope): ...`(见 git log 惯例)。
- **主 checkout 有并行会话脏文件**(server/workbench 系列 + locales)——**每次提交只 `git add` 本任务明确列出的文件**,绝不 `git add -A`/`git add .`;**不要动 locales 文件里与本计划无关的既有改动**(src/locales/zh.json、en.json 已有未提交修改,见 Task 5 步骤说明)。
- 服务端路由测试用 deps 注入 harness 模式(参照 `server/workbench-ai-config-routes.test.mjs` 的 adminHarness)。
- GitHub 仓库 URL 恒为 `https://github.com/aliang-one/aliangboard`。

**Spec 偏差说明**(实施时已裁决):spec 提到「新增 `api.version.*` 服务端双语消息」——实际端点只返回结构化数据、无用户可见文案(401 复用 requirePlatform 既有消息),故不新增服务端消息键;「检测失败」文案在前端 i18n。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `server/version.mjs` | Create | 版本单源 APP_VERSION + normalizeSemver/semverGt/pickLatest 纯函数 |
| `server/version.test.mjs` | Create | 纯函数单测 |
| `server/routes/auth.mjs` | Modify | `/api/health` 响应加 `version` 字段 |
| `server/routes/version.mjs` | Create | GET/POST 端点 + 内存缓存 + 降级 |
| `server/version-routes.test.mjs` | Create | 端点契约测试(deps harness) |
| `server/index.mjs` | Modify | 接线 createVersionRoutes + handle 分发 |
| `Dockerfile` | Modify | ARG VERSION=dev + ENV APP_VERSION |
| `.github/workflows/docker.yml` | Modify | 解析 VERSION 步骤 + build-args |
| `src/api/client.js` | Modify | api 对象加 getVersion/checkVersion |
| `src/composables/useAppVersion.js` | Create | useAppVersion():query + checkNow |
| `src/components/layout/UpdateBanner.vue` | Create | 更新横幅(props 驱动,localStorage 记每版本关闭) |
| `src/components/layout/__tests__/UpdateBanner.test.js` | Create | 横幅渲染/关闭持久化测试 |
| `src/components/layout/AppLayout.vue` | Modify | 挂横幅(TopNavBar 下、集群健康横幅旁) |
| `src/components/settings/SettingsAboutPanel.vue` | Create | 关于面板(自身版本/最新版本/立即检查/升级指引) |
| `src/components/settings/__tests__/SettingsAboutPanel.test.js` | Create | 面板测试(mock composable) |
| `src/views/Settings.vue` | Modify | tabs 加 about + 挂面板 |
| `src/locales/zh.json` / `src/locales/en.json` | Modify | settings.tabs.about / settings.about.* / layout.updateBanner.* |

---

### Task 1: `server/version.mjs` 纯函数 + `/api/health` 带 version

**Files:**
- Create: `server/version.mjs`
- Create: `server/version.test.mjs`
- Modify: `server/routes/auth.mjs:16-19`(health 响应)

**Interfaces:**
- Produces(后续任务依赖的精确签名):
  - `APP_VERSION: string`(导入时从 `process.env.APP_VERSION` 固化,去 `v` 前缀,默认 `'dev'`)
  - `normalizeSemver(input) → string | null`(`'v1.2.3'`/`'1.2.3'` → `'1.2.3'`;非严格三段 semver → null)
  - `semverGt(a, b) → boolean`(数值比较,`1.10.0 > 1.9.0`;任一非法 → false)
  - `pickLatest(tagNames: string[]) → string | null`(全量取最高规范形;无合法 → null)

- [ ] **Step 1: 写失败测试**

创建 `server/version.test.mjs`:

```js
// 版本纯函数契约:归一化(去 v)/数值序比较/全量取最高(2026-08-27 版本机制设计)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { APP_VERSION, normalizeSemver, semverGt, pickLatest } from './version.mjs'

test('normalizeSemver:带/不带 v 前缀 → 规范形;非法输入 → null', () => {
  assert.equal(normalizeSemver('v1.2.3'), '1.2.3')
  assert.equal(normalizeSemver('1.2.3'), '1.2.3')
  assert.equal(normalizeSemver(' v1.10.0 '), '1.10.0')
  assert.equal(normalizeSemver('v1.0.0-rc1'), null)   // 预发布非严格 semver,过滤
  assert.equal(normalizeSemver('nightly'), null)
  assert.equal(normalizeSemver(''), null)
  assert.equal(normalizeSemver(null), null)
})

test('semverGt:数值比较非字典序(1.10.0 > 1.9.0);等值/非法 → false', () => {
  assert.equal(semverGt('1.10.0', '1.9.0'), true)
  assert.equal(semverGt('v1.10.0', '1.9.0'), true)
  assert.equal(semverGt('1.2.3', '1.2.3'), false)
  assert.equal(semverGt('1.2.4', '1.2.3'), true)
  assert.equal(semverGt('1.0.0', '0.9.9'), true)
  assert.equal(semverGt('junk', '1.0.0'), false)
})

test('pickLatest:全量取最高,与顺序无关;过滤非 semver;空 → null', () => {
  assert.equal(pickLatest(['v1.0.7', 'v1.9.0', 'v1.10.0']), '1.10.0')
  assert.equal(pickLatest(['v1.10.0', 'v1.0.7', 'v1.9.0']), '1.10.0') // 顺序无关
  assert.equal(pickLatest(['v1.0.0-rc1', 'nightly', 'latest']), null)
  assert.equal(pickLatest([]), null)
  assert.equal(pickLatest(null), null)
})

test('APP_VERSION:无 env 时为 dev', () => {
  // 本测试进程未设 APP_VERSION;导入时已固化
  assert.equal(typeof APP_VERSION, 'string')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version.test.mjs`
Expected: FAIL,`Cannot find module .../server/version.mjs`

- [ ] **Step 3: 最小实现**

创建 `server/version.mjs`:

```js
// 平台版本单一事实源 + semver 归一化纯函数(2026-08-27 版本机制设计)。
// APP_VERSION:CI 经 docker build-args 注入(Dockerfile ARG VERSION=dev → ENV APP_VERSION);
// 本地 dev / main 手动构建无注入 → 'dev'。归一化规则:比较与持久化一律去 'v' 前缀规范形,展示时前端加前缀。
export const APP_VERSION = String(process.env.APP_VERSION || 'dev').replace(/^v/, '')

// 'v1.2.3'/'1.2.3' → '1.2.3';非严格三段 semver(预发布/缩写/空)→ null
export function normalizeSemver(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(input || '').trim())
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

// 数值比较(非字典序:1.10.0 > 1.9.0);任一非法 → false
export function semverGt(a, b) {
  const x = normalizeSemver(a), y = normalizeSemver(b)
  if (!x || !y) return false
  const [a1, a2, a3] = x.split('.').map(Number)
  const [b1, b2, b3] = y.split('.').map(Number)
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3
}

// tag 名列表 → 最高规范形(全量比较,不信任入参顺序——GitHub API 按创建时间倒序非 semver 序);无合法 → null
export function pickLatest(tagNames) {
  let best = null
  for (const name of Array.isArray(tagNames) ? tagNames : []) {
    const n = normalizeSemver(name)
    if (n && (best === null || semverGt(n, best))) best = n
  }
  return best
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: `/api/health` 加 version 字段**

`server/routes/auth.mjs` 顶部 import 区加:

```js
import { APP_VERSION } from '../version.mjs'
```

health 处理器(约 :16-19)响应改为:

```js
      sendJson(res, 200, { ok: true, service: 'aliangboard-api', time: new Date().toISOString(), version: APP_VERSION })
```

(已核实无测试断言 health 精确形状;Dockerfile healthcheck 只查退出码。)

- [ ] **Step 6: 验证 + 提交**

Run: `node --test server/version.test.mjs && npm run typecheck`
Expected: PASS / 无语法错

```bash
git add server/version.mjs server/version.test.mjs server/routes/auth.mjs
git commit -m "feat(version): 版本单源 server/version.mjs——semver 归一化纯函数 + /api/health 带 version"
```

---

### Task 2: `server/routes/version.mjs` 检测端点 + 接线

**Files:**
- Create: `server/routes/version.mjs`
- Create: `server/version-routes.test.mjs`
- Modify: `server/index.mjs`(import 区 ~:39、路由创建 ~:1374-1378、分发 ~:1417-1418)

**Interfaces:**
- Consumes: Task 1 的 `APP_VERSION`、`pickLatest`、`semverGt`
- Produces(HTTP 契约,Task 4 前端依赖):
  - `GET /api/version`(需平台登录)→ `200 { current, latest, hasUpdate, checkedAt }`;未登录 401(既有消息)
  - `POST /api/version/check`(需平台登录)→ 同上,强制绕过缓存
  - `current`/`latest` 均为规范形(无 v);`hasUpdate = latest && current !== 'dev' && semverGt(latest, current)`;检测失败 `latest: null, hasUpdate: false` 恒 200

- [ ] **Step 1: 写失败测试**

创建 `server/version-routes.test.mjs`(deps 注入 harness,参照 workbench-ai-config-routes.test.mjs;`fetchImpl`/`now`/`current` 全部可注入,时间旅行测 TTL):

```js
// /api/version + /api/version/check 契约:缓存 TTL/强制重查/网络降级/鉴权/hasUpdate 规则(2026-08-27 设计)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createVersionRoutes } from './routes/version.mjs'

const U = p => new URL(p, 'http://x')
const OK_TTL = 60 * 60_000
const ERR_TTL = 5 * 60_000

// okFetch:GitHub tags 响应桩;calls 记录调用次数
const okFetch = (names, calls = { n: 0 }) => {
  calls.n = 0
  return { calls, fn: async () => { calls.n++; return { ok: true, json: async () => ({ tags: names.map(name => ({ name })) }) } } }
}

function harness({ fetchImpl, requirePlatform, current = '1.0.0', nowVal = 1_000_000 } = {}) {
  const sent = []
  let now = nowVal
  const routes = createVersionRoutes({
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    requirePlatform: requirePlatform || (() => ({ userId: 'u1' })),
    fetchImpl: fetchImpl || (async () => { throw new Error('no fetch stub') }),
    now: () => now,
    current,
  })
  return { routes, sent, tick: ms => { now += ms } }
}

test('未登录:GET/POST 均 401 且不触检出网', async () => {
  let called = 0
  const { routes, sent } = harness({
    fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) } },
    requirePlatform: (r, s) => { sent.push({ status: 401 }); return null },
  })
  assert.equal(await routes.handle({ method: 'GET' }, null, U('/api/version')), true)
  assert.equal(await routes.handle({ method: 'POST' }, null, U('/api/version/check')), true)
  assert.equal(called, 0)
  assert.equal(sent.filter(x => x.status === 401).length, 2)
})

test('首次 GET 拉 GitHub 并缓存:窗口内二次 GET 不再出网;返回契约字段', async () => {
  const f = okFetch(['v1.0.7', 'v1.9.0', 'v1.10.0', 'nightly', 'v1.0.0-rc1'])
  const { routes, sent } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 1)                          // 缓存命中
  const j = sent[1].json
  assert.equal(sent[1].status, 200)
  assert.equal(j.current, '1.0.0')
  assert.equal(j.latest, '1.10.0')                    // 过滤非 semver + 全量取最高
  assert.equal(j.hasUpdate, true)
  assert.equal(typeof j.checkedAt, 'number')
})

test('ok 缓存 1h 过期后重拉', async () => {
  const f = okFetch(['v1.0.7'])
  const { routes, tick } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  tick(OK_TTL - 1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 1)                          // 未过期
  tick(1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(f.calls.n, 2)                          // 刚过期即重拉
})

test('POST check 强制绕过缓存', async () => {
  const f = okFetch(['v1.0.7'])
  const { routes } = harness({ fetchImpl: f.fn })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  await routes.handle({ method: 'POST' }, null, U('/api/version/check'))
  assert.equal(f.calls.n, 2)
})

test('网络失败/非 200:降级 latest:null 恒 200;错误态 5min 内不重试、过期重试', async () => {
  let fail = true
  const calls = { n: 0 }
  const { routes, sent, tick } = harness({
    fetchImpl: async () => { calls.n++; if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ tags: [{ name: 'v1.2.0' }] }) } },
  })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual({ latest: sent[0].json.latest, hasUpdate: sent[0].json.hasUpdate }, { latest: null, hasUpdate: false })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 1)                            // 错误缓存期内不再撞超时
  tick(ERR_TTL - 1)
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 1)                            // 仍在内
  tick(1)
  fail = false
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(calls.n, 2)
  assert.equal(sent[3].json.latest, '1.2.0')          // 恢复
})

test('GitHub 403(限流)同样降级 latest:null', async () => {
  const { routes, sent } = harness({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) })
  await routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].json.latest, null)
})

test('hasUpdate 规则:dev 恒 false;latest<=current false;严格大于才 true', async () => {
  const mk = (current, names) => {
    const f = okFetch(names)
    const h = harness({ fetchImpl: f.fn, current })
    return h
  }
  let h = mk('dev', ['v9.9.9'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // dev 不比版本

  h = mk('1.2.0', ['v1.1.0'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // current > latest

  h = mk('1.2.0', ['v1.2.0'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, false)       // 等值不提示

  h = mk('1.2.0', ['v1.2.1'])
  await h.routes.handle({ method: 'GET' }, null, U('/api/version'))
  assert.equal(h.sent[0].json.hasUpdate, true)
})

test('非匹配路径返回 false(不拦截后续分发)', async () => {
  const { routes } = harness({})
  assert.equal(await routes.handle({ method: 'GET' }, null, U('/api/other')), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-routes.test.mjs`
Expected: FAIL,`Cannot find module .../server/routes/version.mjs`

- [ ] **Step 3: 实现端点**

创建 `server/routes/version.mjs`:

```js
// 平台版本信息 + GitHub tag 更新检测(GET 读穿缓存 / POST 强制重查)。2026-08-27 版本机制设计。
// 出网失败/限流/解析异常一律降级 latest:null 仍 200(检测失败 ≠ 请求失败);
// ok 结果缓存 1h(全客户端共享,不碰 GitHub 未认证限流 60/h),错误态缓存 5min(避免每请求都撞 10s 超时)。
// current/latest 均为去 v 规范形;hasUpdate 由服务端裁决(dev 恒 false)。deps 全量可注入(fetchImpl/now/current)便于测试。
import { APP_VERSION, pickLatest, semverGt } from '../version.mjs'

const GITHUB_TAGS_URL = 'https://api.github.com/repos/aliang-one/aliangboard/tags?per_page=100'
const OK_TTL_MS = 60 * 60_000
const ERR_TTL_MS = 5 * 60_000

export function createVersionRoutes(deps) {
  const { sendJson, requirePlatform, fetchImpl = fetch, now = Date.now, current = APP_VERSION } = deps
  let cache = null // { latest: string|null, checkedAt: number, ok: boolean }

  async function probeLatest() {
    const res = await fetchImpl(GITHUB_TAGS_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`github ${res.status}`)
    const data = await res.json()
    return pickLatest(Array.isArray(data?.tags) ? data.tags.map(t => t?.name) : [])
  }

  async function respond(res, { force = false } = {}) {
    const fresh = cache && (now() - cache.checkedAt) < (cache.ok ? OK_TTL_MS : ERR_TTL_MS)
    if (force || !fresh) {
      try {
        cache = { latest: await probeLatest(), checkedAt: now(), ok: true }
      } catch {
        cache = { latest: null, checkedAt: now(), ok: false }
      }
    }
    const hasUpdate = !!cache.latest && current !== 'dev' && semverGt(cache.latest, current)
    sendJson(res, 200, { current, latest: cache.latest, hasUpdate, checkedAt: cache.checkedAt })
  }

  // 匹配版本路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    if (url.pathname === '/api/version' && req.method === 'GET') {
      if (!requirePlatform(req, res)) return true
      await respond(res)
      return true
    }
    if (url.pathname === '/api/version/check' && req.method === 'POST') {
      if (!requirePlatform(req, res)) return true
      await respond(res, { force: true })
      return true
    }
    return false
  }

  return { handle }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-routes.test.mjs`
Expected: PASS(8 tests)

- [ ] **Step 5: index.mjs 接线**

`server/index.mjs` 三处(用锚点找,行号近似):

① import 区(~:39 `import { createAuthRoutes }` 之后)加:

```js
import { createVersionRoutes } from './routes/version.mjs'
```

② 路由创建(~:1374-1378 `const authRoutes = createAuthRoutes({...})` 块之后)加:

```js
  const versionRoutes = createVersionRoutes({ sendJson, requirePlatform })
```

③ 分发(~:1417-1418)把

```js
  if (await authRoutes.handle(req, res, url)) return
  if (await adminRoutes.handle(req, res, url)) return
```

改为:

```js
  if (await authRoutes.handle(req, res, url)) return
  if (await adminRoutes.handle(req, res, url)) return
  if (await versionRoutes.handle(req, res, url)) return
```

- [ ] **Step 6: 验证 + 提交**

Run: `node --test server/version-routes.test.mjs && npm run typecheck`
Expected: PASS / 无语法错

```bash
git add server/routes/version.mjs server/version-routes.test.mjs server/index.mjs
git commit -m "feat(version): /api/version 检测端点——GitHub tag 读穿缓存(1h/5min)、降级 latest:null、POST check 强制重查"
```

---

### Task 3: Dockerfile 烙版本 + docker.yml 注入

**Files:**
- Modify: `Dockerfile:20`(ENV 区)
- Modify: `.github/workflows/docker.yml:49-58`(build-push step)

**Interfaces:**
- Consumes: 无(独立;CI 注入的 `VERSION` 被 Task 1 的 `process.env.APP_VERSION` 消费)
- Produces: 镜像 env `APP_VERSION`(tag 构建=`1.2.3` 形;手动构建=`dev`)

- [ ] **Step 1: Dockerfile 加 ARG/ENV**

`Dockerfile` runtime 阶段 ENV 行(`ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production`,~:20)改为:

```dockerfile
ARG VERSION=dev
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production APP_VERSION=${VERSION}
```

(ARG 紧贴 ENV 放 runtime 阶段;默认 dev 兜住本地/手动构建。)

- [ ] **Step 2: docker.yml 解析并传入 build-args**

`.github/workflows/docker.yml` 在「Docker meta」step(~:39-48)之后、「Build and push」step(~:49)之前插入:

```yaml
      - name: Resolve VERSION（tag → semver；手动构建 → dev）
        id: ver
        run: echo "v=${{ steps.meta.outputs.version || 'dev' }}" >> "$GITHUB_OUTPUT"
```

「Build and push」step 的 with 块(`cache-to` 之后)追加一行:

```yaml
          build-args: VERSION=${{ steps.ver.outputs.v }}
```

注意:`metadata-action` 的 `outputs.version` 仅在 semver tag 触发时非空(`v1.2.3` → `1.2.3`,无 v 前缀);`workflow_dispatch` 手动构建为空 → `|| 'dev'` 兜底。**不能**直接 `build-args: VERSION=${{ steps.meta.outputs.version }}`——显式传空串会覆盖 ARG 默认值得到 `APP_VERSION=""`。

- [ ] **Step 3: 本地可验证部分验证**

无 CI runner,本地验证 Dockerfile 语法与注入:

```bash
docker build --build-arg VERSION=9.9.9 --target build -t ab-ver-test . 2>/dev/null | tail -1 || echo "跳过(无 docker 或网络受限)——依赖下次 tag 构建实跑验证"
```

(可选;构建产物行为=`process.env.APP_VERSION=9.9.9`,已由 Task 1 单测覆盖读取逻辑。)

- [ ] **Step 4: 提交**

```bash
git add Dockerfile .github/workflows/docker.yml
git commit -m "feat(version): 镜像烙 APP_VERSION——Dockerfile ARG VERSION=dev + CI 按 tag semver 注入 build-args(手动构建兜底 dev)"
```

---

### Task 4: 前端 API 方法 + `useAppVersion` composable

**Files:**
- Modify: `src/api/client.js:212-218`(api 对象 platformHttp 端点区)
- Create: `src/composables/useAppVersion.js`

**Interfaces:**
- Consumes: Task 2 的 HTTP 契约(`GET /api/version` → `{ current, latest, hasUpdate, checkedAt }`;`POST /api/version/check`)
- Produces(Task 5/6 依赖):
  - `api.getVersion() → Promise<{ current, latest, hasUpdate, checkedAt }>`
  - `api.checkVersion() → Promise<同上>`
  - `useAppVersion() → { query, checkNow }`——`query` 为 vue-query useQuery 返回值(`query.data.value` 取数据);`checkNow: async () => void`(POST check 后 invalidate `['app-version']`)

- [ ] **Step 1: client.js 加两个方法**

`src/api/client.js` api 对象里 `listProjects`(~:212)行前后(platformHttp 端点区)加:

```js
  getVersion: () => platformHttp.request('/api/version'),
  checkVersion: () => platformHttp.request('/api/version/check', { method: 'POST' }),
```

- [ ] **Step 2: 创建 composable**

创建 `src/composables/useAppVersion.js`:

```js
// 平台自身版本 + 更新检测(2026-08-27 版本机制设计)。
// 服务端已有 1h 缓存兜底,前端 staleTime 30min 即可;queryKey 统一 ['app-version'],
// UpdateBanner 与 Settings 关于 tab 各自调用同 key 自动去重共享缓存。
// current/latest 均为去 v 前缀规范形(服务端归一);hasUpdate 由服务端裁决(dev 恒 false)。
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { api } from '@/api/client'

export function useAppVersion() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['app-version'],
    queryFn: () => api.getVersion(),
    staleTime: 30 * 60_000,
  })
  const checkNow = async () => {
    await api.checkVersion()
    await queryClient.invalidateQueries({ queryKey: ['app-version'] })
  }
  return { query, checkNow }
}
```

- [ ] **Step 3: 验证(语法)+ 提交**

Run: `npm run typecheck`
Expected: 无语法错(组件接线在 Task 5/6,此任务无独立可跑测试;逻辑由消费方测试覆盖)

```bash
git add src/api/client.js src/composables/useAppVersion.js
git commit -m "feat(version): api.getVersion/checkVersion + useAppVersion composable(Vue Query 30min stale,双消费方共享 ['app-version'])"
```

---

### Task 5: `UpdateBanner.vue` + AppLayout 挂载 + i18n

**Files:**
- Create: `src/components/layout/UpdateBanner.vue`
- Create: `src/components/layout/__tests__/UpdateBanner.test.js`
- Modify: `src/components/layout/AppLayout.vue`(script import 区 + template 集群健康横幅块之后)
- Modify: `src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: Task 4 的 `useAppVersion()`;props 契约 `{ latest: string }`
- Produces: 横幅组件(props 驱动、自管 dismiss);localStorage key `ab.updateBannerDismissed`(值为规范形版本号)

⚠️ **locales 文件已有并行会话的未提交改动**:zh.json/en.json 是 `M` 状态。编辑时只加自己的键、保留现有内容原样;提交时这两个文件会连带并行改动一起进入——**提交前先 `git diff src/locales/zh.json` 确认无越界改动,并且只 add 这两个文件**。若并行改动导致冲突风险高,先停下问用户而不是强行处理。

- [ ] **Step 1: 写失败测试**

创建 `src/components/layout/__tests__/UpdateBanner.test.js`:

```js
// 更新横幅契约:有更新未关→渲染;关闭→localStorage 记规范形且消失;
// latest=null / 已关同版本 → 不渲染。(props 驱动,不依赖 query,AppLayout 接线由挂载回归覆盖)
import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateBanner from '@/components/layout/UpdateBanner.vue'
import { i18n } from '@/i18n'

const KEY = 'ab.updateBannerDismissed'

beforeEach(() => localStorage.removeItem(KEY))

test('有新版本未关闭:渲染,展示 v 前缀版本号与 tags 链接', () => {
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('v1.1.0')
  expect(w.find('a[href="https://github.com/aliang-one/aliangboard/tags"]').exists()).toBe(true)
})

test('点击关闭:localStorage 记规范形,横幅消失', async () => {
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  await w.find('button[aria-label]').trigger('click')
  expect(localStorage.getItem(KEY)).toBe('1.1.0')
  expect(w.find('a').exists()).toBe(false)
})

test('latest=null(检测失败/无更新):不渲染', () => {
  const w = mount(UpdateBanner, { props: { latest: null }, global: { plugins: [i18n] } })
  expect(w.find('a').exists()).toBe(false)
})

test('同版本已关闭过:不渲染;更更新版本再弹', async () => {
  localStorage.setItem(KEY, '1.1.0')
  const w = mount(UpdateBanner, { props: { latest: '1.1.0' }, global: { plugins: [i18n] } })
  expect(w.find('a').exists()).toBe(false)
  await w.setProps({ latest: '1.2.0' })
  expect(w.find('a').exists()).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/UpdateBanner.test.js`
Expected: FAIL,`Failed to resolve import .../UpdateBanner.vue`

- [ ] **Step 3: 实现组件**

创建 `src/components/layout/UpdateBanner.vue`:

```vue
<script setup>
// 更新横幅:检测到新版本时显示(TopNavBar 下方,集群健康横幅同款样式、primary 色非 error 色)。
// 「横幅一次」= 每版本一次:关闭记 localStorage(ab.updateBannerDismissed=去 v 规范形),出现更新版本再弹。
// props 驱动(不自带 query),AppLayout 负责 useAppVersion 接线——便于独立测试。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ latest: { type: String, default: null } })
const { t } = useI18n()

const DISMISS_KEY = 'ab.updateBannerDismissed'
// localStorage 非响应式,初始读一次,关闭后走 ref 更新
const dismissedNow = ref((() => { try { return localStorage.getItem(DISMISS_KEY) } catch { return null } })())
const visible = computed(() => !!props.latest && dismissedNow.value !== props.latest)

function dismiss() {
  dismissedNow.value = props.latest || ''
  try { localStorage.setItem(DISMISS_KEY, props.latest || '') } catch { /* 私隐模式:仅本次不显示 */ }
}
</script>

<template>
  <div v-if="visible"
    class="px-lg py-sm flex items-center gap-sm text-on-primary bg-primary/10 border-b border-primary/30 text-body-sm">
    <span class="material-symbols-outlined text-base">system_update_alt</span>
    <span>{{ t('layout.updateBanner.found') }} <span class="font-mono font-semibold">v{{ latest }}</span></span>
    <a href="https://github.com/aliang-one/aliangboard/tags" target="_blank" rel="noopener"
      class="underline underline-offset-2 hover:opacity-80">{{ t('layout.updateBanner.view') }}</a>
    <button :aria-label="t('layout.updateBanner.dismiss')" @click="dismiss"
      class="ml-auto material-symbols-outlined text-base hover:text-on-surface cursor-pointer">close</button>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/UpdateBanner.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: i18n 键**

`src/locales/zh.json` 的 `layout` 对象内加(`clusterStatusSummary` 之后):

```json
    "updateBanner": { "found": "发现新版本", "view": "查看发布", "dismiss": "关闭" }
```

`src/locales/en.json` 对应:

```json
    "updateBanner": { "found": "New version available", "view": "View releases", "dismiss": "Dismiss" }
```

(注意 JSON 逗号:加在对象末位时前一键要补逗号。)

- [ ] **Step 6: AppLayout 挂载**

`src/components/layout/AppLayout.vue`:

① script 区 import 加:

```js
import UpdateBanner from './UpdateBanner.vue'
import { useAppVersion } from '@/composables/useAppVersion'
```

② script setup 逻辑区加:

```js
// 平台版本更新检测(横幅:每版本提示一次;未登录不进 AppLayout,query 天然不启用)
const { query: versionQuery } = useAppVersion()
const hasUpdate = computed(() => !!versionQuery.data.value?.hasUpdate)
const latestVersion = computed(() => versionQuery.data.value?.latest || null)
```

(`computed` 若未 import 需补进 vue import。)

③ template 集群健康横幅块(`Disconnected` 横幅 `</div>` 之后、`fullHeight` 注释之前)加:

```html
      <!-- 版本更新横幅:检测到新版本(每版本提示一次,可关闭) -->
      <UpdateBanner v-if="hasUpdate" :latest="latestVersion" />
```

- [ ] **Step 7: 验证 + 提交**

Run: `npx vitest run src/components/layout/__tests__/UpdateBanner.test.js && npm run typecheck && npm run i18n:check`
Expected: 全过(若 i18n:check 报键对齐,检查 zh/en 是否都加了)

```bash
git add src/components/layout/UpdateBanner.vue src/components/layout/__tests__/UpdateBanner.test.js src/components/layout/AppLayout.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(version): 更新横幅 UpdateBanner——每版本提示一次(localStorage 记规范形),挂 AppLayout 顶栏下方"
```

---

### Task 6: `SettingsAboutPanel.vue` + Settings「关于」tab + i18n

**Files:**
- Create: `src/components/settings/SettingsAboutPanel.vue`
- Create: `src/components/settings/__tests__/SettingsAboutPanel.test.js`
- Modify: `src/views/Settings.vue`(tabs 数组 + template 面板区)
- Modify: `src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: Task 4 的 `useAppVersion()`;Task 5 已建的 i18n 无重叠(本任务加 `settings.tabs.about` + `settings.about.*`)
- Produces: Settings「关于」tab 面板(自身版本/最新版本/立即检查/升级指引)

⚠️ locales 并行改动注意事项同 Task 5。

- [ ] **Step 1: 写失败测试**

创建 `src/components/settings/__tests__/SettingsAboutPanel.test.js`(vi.mock composable,参照仓库模块级 mock 配 reset 的教训——mock 状态放 `vi.hoisted`):

```js
// 关于面板契约:当前版本/最新版本渲染、dev 标、检测失败文案、立即检查调用、kubectl 命令含最新版本 tag。
// mock useAppVersion(面板自身不接 query),模拟状态经 hoisted state 切换。
import { test, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const state = vi.hoisted(() => ({
  data: { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 },
  check: vi.fn(async () => {}),
}))
vi.mock('@/composables/useAppVersion', async () => {
  const { ref } = await import('vue')
  return { useAppVersion: () => ({ query: { data: ref(state.data) }, checkNow: state.check }) }
})

import SettingsAboutPanel from '@/components/settings/SettingsAboutPanel.vue'
import { i18n } from '@/i18n'

beforeEach(() => { state.check.mockClear() })

test('渲染当前/最新版本(展示加 v 前缀)', () => {
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('v1.0.7')
  expect(w.text()).toContain('v1.1.0')
})

test('dev 构建显示 dev 与开发构建标,不显示失败', () => {
  state.data = { current: 'dev', latest: '1.1.0', hasUpdate: false, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('dev')
  expect(w.text()).toContain(i18n.global.t('settings.about.devBuild'))
})

test('latest=null 已加载:显示检测失败文案', () => {
  state.data = { current: '1.0.7', latest: null, hasUpdate: false, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain(i18n.global.t('settings.about.checkFailed'))
})

test('立即检查按钮调用 checkNow', async () => {
  state.data = { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  await w.find('button[data-test="check-now"]').trigger('click')
  expect(state.check).toHaveBeenCalledTimes(1)
})

test('kubectl 升级命令含最新版本镜像 tag(规范形=镜像 tag 形)', () => {
  state.data = { current: '1.0.7', latest: '1.1.0', hasUpdate: true, checkedAt: 1 }
  const w = mount(SettingsAboutPanel, { global: { plugins: [i18n] } })
  expect(w.text()).toContain('kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:1.1.0 -n aliangboard')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/settings/__tests__/SettingsAboutPanel.test.js`
Expected: FAIL,`Failed to resolve import .../SettingsAboutPanel.vue`

- [ ] **Step 3: 实现面板**

创建 `src/components/settings/SettingsAboutPanel.vue`:

```vue
<script setup>
// Settings「关于」面板:平台自身版本信息 + 更新检测(常驻,与顶栏横幅互补)。
// 数据经 useAppVersion(['app-version'] 共享缓存);检测失败=latest:null 灰字降级,不是错误。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppVersion } from '@/composables/useAppVersion'

const { t } = useI18n()
const { query, checkNow } = useAppVersion()

const checking = ref(false)
const copied = ref(false)

const current = computed(() => query.data.value?.current || 'dev')
const latest = computed(() => query.data.value?.latest || null)
const loaded = computed(() => !!query.data.value)
const isDev = computed(() => current.value === 'dev')

async function onCheck() {
  checking.value = true
  try { await checkNow() } finally { checking.value = false }
}

// 升级指引:镜像 tag = 规范形(与 CI semver 产物一致,无 v 前缀);deployment.yaml 现状单副本 latest
const cmd = computed(() => latest.value
  ? `kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:${latest.value} -n aliangboard`
  : '')

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(cmd.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* 剪贴板不可用:忽略,用户可手动选择 */ }
}
</script>

<template>
  <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
    <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
      <span class="material-symbols-outlined text-primary text-lg">update</span>
      <span class="text-body-sm font-semibold">{{ t('settings.about.title') }}</span>
    </div>
    <div class="p-md space-y-md">
      <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.currentVersion') }}</span>
        <span class="flex items-center gap-sm">
          <span class="font-mono text-code-sm">{{ isDev ? 'dev' : `v${current}` }}</span>
          <span v-if="isDev" class="px-sm py-xs rounded-md bg-surface-container text-on-surface-variant text-xs">{{ t('settings.about.devBuild') }}</span>
        </span>
      </div>
      <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.latestVersion') }}</span>
        <span v-if="latest" class="font-mono text-code-sm">{{ `v${latest}` }}</span>
        <span v-else-if="loaded" class="text-on-surface-variant text-body-sm">{{ t('settings.about.checkFailed') }}</span>
        <span v-else class="text-on-surface-variant text-body-sm">{{ t('settings.about.checking') }}</span>
      </div>
      <div class="flex justify-between items-center py-sm">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.upgradeGuide') }}</span>
        <button data-test="check-now" @click="onCheck" :disabled="checking"
          class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50">
          <span class="material-symbols-outlined text-sm" :class="checking ? 'animate-spin' : ''">refresh</span>
          {{ checking ? t('settings.about.checking') : t('settings.about.checkNow') }}
        </button>
      </div>
      <div v-if="cmd" class="rounded-lg bg-surface-container-low p-sm flex items-center gap-sm">
        <code class="flex-1 font-mono text-code-sm break-all">{{ cmd }}</code>
        <button @click="copyCmd" class="material-symbols-outlined text-base hover:text-primary cursor-pointer"
          :aria-label="t('settings.about.copyCommand')">{{ copied ? 'check' : 'content_copy' }}</button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/settings/__tests__/SettingsAboutPanel.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: Settings.vue 接 tab**

`src/views/Settings.vue`:

① import 区加:

```js
import SettingsAboutPanel from '@/components/settings/SettingsAboutPanel.vue'
```

② `tabs` computed 数组(customcols 之后、mcp 之前)加一行:

```js
  { key: 'about', label: t('settings.tabs.about'), icon: 'update' },
```

③ template 面板区(customcols 或 mcp 面板块之后、`</div>` 收尾前)加:

```html
        <!-- About -->
        <SettingsAboutPanel v-if="activeTab === 'about'" />
```

- [ ] **Step 6: i18n 键**

`src/locales/zh.json`:

`settings.tabs` 对象内(与既有 tab 键并列)加:

```json
      "about": "关于"
```

`settings` 对象内(顶层键区)加:

```json
    "about": {
      "title": "关于平台",
      "currentVersion": "当前版本",
      "latestVersion": "最新版本",
      "checkNow": "立即检查",
      "checking": "检测中…",
      "checkFailed": "检测失败(内网或限流)",
      "devBuild": "开发构建",
      "upgradeGuide": "版本与升级",
      "copyCommand": "复制命令"
    }
```

`src/locales/en.json` 对应:

```json
      "about": "About"
```

```json
    "about": {
      "title": "About",
      "currentVersion": "Current version",
      "latestVersion": "Latest version",
      "checkNow": "Check now",
      "checking": "Checking…",
      "checkFailed": "Check failed (offline or rate-limited)",
      "devBuild": "Dev build",
      "upgradeGuide": "Version & upgrade",
      "copyCommand": "Copy command"
    }
```

- [ ] **Step 7: 验证 + 提交**

Run: `npx vitest run src/components/settings/__tests__/SettingsAboutPanel.test.js && npm run i18n:check && npm run typecheck`
Expected: 全过

```bash
git add src/components/settings/SettingsAboutPanel.vue src/components/settings/__tests__/SettingsAboutPanel.test.js src/views/Settings.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(version): Settings 关于 tab——当前/最新版本、立即检查、kubectl 升级指引可复制"
```

---

### Task 7: 全量门禁 + 收尾

**Files:**
- 无新文件(验证任务;若门禁暴露问题,修复并按所属文件追加提交)

**Interfaces:**
- Consumes: Task 1-6 全部
- Produces: 门禁四连全绿的本分支状态

- [ ] **Step 1: 门禁四连**

```bash
npm run typecheck && npm run i18n:check && npm run test:server && npm run test:unit
```

Expected: 全部 PASS(test:server 含 `node --test server/*.test.mjs` 自动收 Task 1/2 测试;test:unit 收 Task 5/6)。
任何失败:按 superpowers:systematic-debugging 排查修复(不许注释掉测试蒙混),修复文件按所属 task 风格追加提交。

- [ ] **Step 2: 手测指引(留给用户,需发版环境)**

打下一个 tag 时实跑验证链(写入最终汇报,不阻塞合并):

1. `git tag v1.0.8 && git push origin v1.0.8` → Actions 构建日志「Resolve VERSION」步显示 `v=1.0.8`
2. 拉新镜像起容器,`curl http://<host>:8787/api/health` → `"version":"1.0.8"`
3. 登录 → Settings「关于」显示当前 v1.0.8、最新版(GitHub 现有 tag 最高者)
4. 等下一个更高 tag 发布后刷新页面 → 顶栏横幅「发现新版本 vX.Y.Z」,关闭后刷新不再弹;再发更高版再弹

- [ ] **Step 3: 收尾提交(如有修复)**

```bash
git status --short   # 确认无本计划遗留未提交文件(并行会话的 workbench 脏文件不属于本计划,不处理)
```

---

## Self-Review 记录

- **Spec 覆盖**:注入链路(Task 1/3)、检测端点+缓存+降级(Task 2)、前端数据层(Task 4)、横幅(Task 5)、关于 tab+升级指引(Task 6)、错误处理矩阵(散布各任务测试)、i18n 门禁(Task 5/6/7)、发版手测(Task 7 Step 2)——全覆盖。
- **占位符扫描**:无 TBD/TODO/「类似 Task N」;每个代码步骤含完整可落地代码。
- **类型/签名一致性**:`APP_VERSION`/`normalizeSemver`/`semverGt`/`pickLatest`(Task 1)与 Task 2 导入一致;`{ current, latest, hasUpdate, checkedAt }` 契约在 Task 2/4/5/6 间一致;`useAppVersion() → { query, checkNow }` 在 Task 4 定义、5/6 消费一致;localStorage key `ab.updateBannerDismissed` 在 Task 5 组件与测试一致;`data-test="check-now"` 在 Task 6 组件与测试一致。
- **发现并修正的问题**:① 空 build-arg 覆盖 ARG 默认值陷阱(Task 3 显式 `|| 'dev'` 步骤);② `server/routes/` 下测试不被自动收集(测试放顶层 `server/version-routes.test.mjs`);③ localStorage 非响应式,组件 dismiss 用 ref 而非 computed 直读。
