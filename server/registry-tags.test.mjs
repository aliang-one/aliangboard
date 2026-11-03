import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageRef, normalizeEndpoint, fetchRegistryTags, compareTagsDesc, resolveRegistryAuthFromSecret } from './registry-tags.mjs'

// —— ref 解析 ——
test('normalizeImageRef: 官方镜像无 registry', () => {
  assert.deepEqual(normalizeImageRef('nginx:1.25'), { registry: '', repo: 'nginx' })
  assert.deepEqual(normalizeImageRef('nginx'), { registry: '', repo: 'nginx' })
  assert.deepEqual(normalizeImageRef('nginx@sha256:abc'), { registry: '', repo: 'nginx' })
})
test('normalizeImageRef: 命名空间镜像与自建 registry', () => {
  assert.deepEqual(normalizeImageRef('user/app:v1'), { registry: '', repo: 'user/app' })
  assert.deepEqual(normalizeImageRef('reg.local:5000/team/app:2'), { registry: 'reg.local:5000', repo: 'team/app' })
  assert.deepEqual(normalizeImageRef('ghcr.io/org/app'), { registry: 'ghcr.io', repo: 'org/app' })
})

// —— Docker Hub 端点归一 ——
test('normalizeEndpoint: 空 registry → registry-1 + library/ 前缀', () => {
  assert.deepEqual(normalizeEndpoint('', 'nginx'), { host: 'registry-1.docker.io', repo: 'library/nginx' })
  assert.deepEqual(normalizeEndpoint('docker.io', 'nginx'), { host: 'registry-1.docker.io', repo: 'library/nginx' })
  assert.deepEqual(normalizeEndpoint('index.docker.io', 'user/app'), { host: 'registry-1.docker.io', repo: 'user/app' })
  assert.deepEqual(normalizeEndpoint('reg.local:5000', 'team/app'), { host: 'reg.local:5000', repo: 'team/app' })
})

// —— 桩工厂 ——
// res 形态仿 undici Response：status / headers.get / text / json
function stubRes(status, { headers = {}, json = null, text = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => text,
  }
}

test('fetchRegistryTags: 匿名公共镜像 401 → token 换票重试成功（2026-09-03 修复的主场景）', async () => {
  const calls = []
  const fetchImpl = async (target, opts = {}) => {
    calls.push({ target, auth: opts.headers?.authorization || null })
    if (target.startsWith('https://auth.docker.io/token')) {
      return stubRes(200, { json: { token: 'tok-anon' } })
    }
    if (target === 'https://registry-1.docker.io/v2/library/nginx/tags/list?n=100') {
      if (opts.headers?.authorization !== 'Bearer tok-anon') {
        return stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' } })
      }
      return stubRes(200, { json: { tags: ['1.25', '1.24', 'latest'] } })
    }
    return stubRes(404)
  }
  const r = await fetchRegistryTags({ image: 'nginx:1.25', fetchImpl })
  assert.equal(r.ok, true)
  assert.deepEqual(r.tags, ['1.25', '1.24', 'latest']) // 版本号数值降序，非版本号垫底
  assert.equal(r.registry, 'registry-1.docker.io')
  assert.equal(r.repo, 'library/nginx')
  // 三段链：裸列表(401) → 换票(无凭据) → 带 Bearer 重试
  assert.deepEqual(calls.map(c => c.target), [
    'https://registry-1.docker.io/v2/library/nginx/tags/list?n=100',
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull',
    'https://registry-1.docker.io/v2/library/nginx/tags/list?n=100',
  ])
  assert.equal(calls[2].auth, 'Bearer tok-anon')
})

test('fetchRegistryTags: 换票时用户账密以 Basic 交给 token 服务', async () => {
  let tokenAuth = null
  const fetchImpl = async (target, opts = {}) => {
    if (target.startsWith('https://auth.example.com/token')) {
      tokenAuth = opts.headers?.authorization || null
      return stubRes(200, { json: { access_token: 'tok-priv' } })
    }
    if (opts.headers?.authorization === 'Bearer tok-priv') return stubRes(200, { json: { tags: ['v1'] } })
    return stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token",service="registry.example.com"' } })
  }
  const r = await fetchRegistryTags({ image: 'reg.example.com/team/app:1', username: 'u', password: 'p', fetchImpl })
  assert.equal(r.ok, true)
  assert.ok(tokenAuth?.startsWith('Basic '), 'token 端点应收到 Basic 凭据')
})

test('fetchRegistryTags: 换票后仍 401（真私有仓库）→ needsAuth', async () => {
  const fetchImpl = async target => {
    if (target.startsWith('https://auth.private.io/token')) return stubRes(200, { json: { token: 'bad' } })
    return stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="https://auth.private.io/token",service="registry.private.io",scope="repository:team/app:pull"' } })
  }
  const r = await fetchRegistryTags({ image: 'reg.private.io/team/app:1', fetchImpl })
  assert.deepEqual({ ok: r.ok, needsAuth: r.needsAuth, status: r.status }, { ok: false, needsAuth: true, status: 401 })
})

test('fetchRegistryTags: 非 Bearer 挑战（Basic registry）且无账密 → needsAuth', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return stubRes(401, { headers: { 'www-authenticate': 'Basic realm="Registry"' } }) }
  const r = await fetchRegistryTags({ image: 'reg.local:5000/app:1', fetchImpl })
  assert.equal(r.needsAuth, true)
  assert.equal(calls, 1) // 不应换票死循环
})

test('fetchRegistryTags: 非 Bearer 挑战但带了账密 → 首次请求即 Basic 直达', async () => {
  const fetchImpl = async (target, opts = {}) => {
    if (opts.headers?.authorization === 'Basic ' + Buffer.from('u:p').toString('base64')) return stubRes(200, { json: { tags: ['a'] } })
    return stubRes(401, { headers: { 'www-authenticate': 'Basic realm="Registry"' } })
  }
  const r = await fetchRegistryTags({ image: 'reg.local:5000/app:1', username: 'u', password: 'p', fetchImpl })
  assert.equal(r.ok, true)
})

test('fetchRegistryTags: 404 → notFound；其他状态 → bodySnippet', async () => {
  const r404 = await fetchRegistryTags({ image: 'reg.io/org/missing:1', fetchImpl: async () => stubRes(404) })
  assert.deepEqual({ ok: r404.ok, notFound: r404.notFound, status: r404.status }, { ok: false, notFound: true, status: 404 })
  const r500 = await fetchRegistryTags({ image: 'reg.io/org/x:1', fetchImpl: async () => stubRes(500, { text: 'boom' }) })
  assert.equal(r500.bodySnippet, 'boom')
})

test('fetchRegistryTags: https 抛错回退 http（明文 registry）', async () => {
  const fetchImpl = async (target) => {
    if (target.startsWith('https://')) throw new Error('ECONNREFUSED')
    return stubRes(200, { json: { tags: ['t1'] } })
  }
  const r = await fetchRegistryTags({ image: 'reg.local:5000/app:1', fetchImpl })
  assert.deepEqual({ ok: r.ok, registry: r.registry }, { ok: true, registry: 'reg.local:5000' })
})

test('fetchRegistryTags: https+http 均抛错 → unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const r = await fetchRegistryTags({ image: 'reg.local:5000/app:1', fetchImpl })
  assert.equal(r.unreachable, true)
})

test('fetchRegistryTags: 空 repo → unparsable（修复前官方镜像被误判的对照）', async () => {
  const r = await fetchRegistryTags({ image: '', fetchImpl: async () => { throw new Error('should not fetch') } })
  assert.equal(r.unparsable, true)
})

test('fetchRegistryTags: OCI 产物伪 tag（sha256-/.sig/.att/.sbom）被过滤，不占版本下拉', async () => {
  const fetchImpl = async () => stubRes(200, { json: { tags: [
    'sha256-31f3270dfc', 'sha256-31f3270dfc.sig', 'sha256-31f3270dfc.att', 'sha256-abc.sbom', 'x.sbom.json',
    '1.25', 'latest', 'alpine',
  ] } })
  const r = await fetchRegistryTags({ image: 'nginx:1.25', fetchImpl })
  assert.deepEqual(r.tags, ['1.25', 'latest', 'alpine'])
})

// —— 版本号感知排序 ——
test('compareTagsDesc: 数值比较 1.0.20 > 1.0.9（字典序反例钉住）', () => {
  const tags = ['1.0.9', '1.0.20', '1.0.2', '0.9.10', '0.9.9']
  assert.deepEqual(tags.slice().sort(compareTagsDesc), ['1.0.20', '1.0.9', '1.0.2', '0.9.10', '0.9.9'])
})
test('compareTagsDesc: 段数不齐按 0 补齐（1.1 > 1.0.20；v 前缀均认）', () => {
  assert.deepEqual(['1.1', 'v1.0.20', '1.0.3'].sort(compareTagsDesc), ['1.1', 'v1.0.20', '1.0.3'])
  assert.deepEqual(['1', '1.0.1'].sort(compareTagsDesc), ['1.0.1', '1'])
})
test('compareTagsDesc: 非版本号垫底且 latest 置首，其余字典序降序', () => {
  assert.deepEqual(
    ['main', 'sha-abc123', 'latest', '2.0.0', 'beta'].sort(compareTagsDesc),
    ['2.0.0', 'latest', 'sha-abc123', 'main', 'beta'],
  )
})
test('fetchRegistryTags: ghcr 场景端到端排序——1.0.20 在 1.0.19 前', async () => {
  const fetchImpl = async (target, opts = {}) => {
    const t = String(target)
    if (t.startsWith('https://ghcr.io/token')) return stubRes(200, { json: { token: 't' } })
    if (t.includes('tags/list')) {
      if (opts.headers?.authorization) return stubRes(200, { json: { tags: ['1.0.19', '1.0.20', 'main', 'latest', 'sha-x'] } })
      return stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:aliang-one/aliangboard:pull"' } })
    }
    return stubRes(404)
  }
  const r = await fetchRegistryTags({ image: 'ghcr.io/aliang-one/aliangboard:1.0.19', fetchImpl })
  assert.deepEqual(r.tags.slice(0, 3), ['1.0.20', '1.0.19', 'latest'])
})

test('fetchRegistryTags: 换票 realm 非法 URL → 落回原 401 needsAuth 而非抛错', async () => {
  const fetchImpl = async () => stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="not-a-url"' } })
  const r = await fetchRegistryTags({ image: 'reg.io/org/app:1', fetchImpl })
  assert.equal(r.needsAuth, true)
})


// === resolveRegistryAuthFromSecret(issue#20 bug2:修改版本弹窗凭证可选已有)===
// docker-registry Secret(.dockerconfigjson)→ 指定镜像 registry host 的 {username,password}。
// 服务端解析(凭证不出网关);前端只传 secretRef {namespace,name}。
const b64 = s => Buffer.from(s).toString('base64')
const makeSecret = auths => ({ data: { '.dockerconfigjson': b64(JSON.stringify({ auths })) } })

test('resolver: 精确 host 匹配,entry.auth(base64 user:pass)解码', () => {
  const s = makeSecret({ 'registry.cn-hangzhou.aliyuncs.com': { auth: b64('aliyun-user:p@ss') } })
  const r = resolveRegistryAuthFromSecret(s, 'registry.cn-hangzhou.aliyuncs.com/ns/app:v1')
  assert.deepEqual(r, { ok: true, username: 'aliyun-user', password: 'p@ss', matchedKey: 'registry.cn-hangzhou.aliyuncs.com' })
})

test('resolver: key 带 scheme 与 /v1/ 尾巴 → 归一后匹配', () => {
  const s = makeSecret({ 'https://reg.example.com/v1/': { auth: b64('u:p') } })
  const r = resolveRegistryAuthFromSecret(s, 'reg.example.com/ns/app:v1')
  assert.equal(r.ok, true)
  assert.equal(r.username, 'u')
})

test('resolver: docker hub 别名互认(image 无 registry → 数据端点 host;key=index.docker.io 变体)', () => {
  const s = makeSecret({ 'https://index.docker.io/v1/': { auth: b64('hubu:hubp') } })
  const r = resolveRegistryAuthFromSecret(s, 'nginx:1.25')
  assert.equal(r.ok, true)
  assert.equal(r.username, 'hubu')
  assert.equal(r.password, 'hubp')
})

test('resolver: entry 直接 username/password(无 auth 字段)可用', () => {
  const s = makeSecret({ 'reg.io': { username: 'direct-u', password: 'direct-p' } })
  const r = resolveRegistryAuthFromSecret(s, 'reg.io/ns/app:v1')
  assert.deepEqual({ ok: r.ok, username: r.username, password: r.password }, { ok: true, username: 'direct-u', password: 'direct-p' })
})

test('resolver: 无匹配且多条目 → no-match(不瞎选)', () => {
  const s = makeSecret({ 'a.io': { auth: b64('a:a') }, 'b.io': { auth: b64('b:b') } })
  const r = resolveRegistryAuthFromSecret(s, 'c.io/ns/app:v1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-match')
})

test('resolver: 无匹配且单条目 → no-match(对抗审查 MED:绝不把凭证发给异 registry 主机,kubelet 同语义)', () => {
  // 单条目兜底会把 aliyun 凭证发给 quay.io 等任意镜像所指主机(含其 token realm、明文回退线路)——
  // 凭证出口 fail-safe 优于 fail-open;用户走手动填写降级
  const s = makeSecret({ 'my-reg.local:5000': { auth: b64('u:p') } })
  const r = resolveRegistryAuthFromSecret(s, 'registry.cn-shenzhen.aliyuncs.com/ns/app:v1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-match')
})

test('resolver: 缺 .dockerconfigjson / 坏 base64 / 坏 JSON → bad-secret', () => {
  assert.equal(resolveRegistryAuthFromSecret({ data: {} }, 'reg.io/a/b').reason, 'bad-secret')
  assert.equal(resolveRegistryAuthFromSecret({ data: { '.dockerconfigjson': '!!!not-base64!!!' } }, 'reg.io/a/b').reason, 'bad-secret')
  assert.equal(resolveRegistryAuthFromSecret({ data: { '.dockerconfigjson': b64('{broken') } }, 'reg.io/a/b').reason, 'bad-secret')
  assert.equal(resolveRegistryAuthFromSecret(null, 'reg.io/a/b').reason, 'bad-secret')
})

test('resolver: 命中条目但无任何账密字段 → no-creds', () => {
  const s = makeSecret({ 'reg.io': {} })
  const r = resolveRegistryAuthFromSecret(s, 'reg.io/ns/app:v1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-creds')
})
