import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageRef, normalizeEndpoint, fetchRegistryTags } from './registry-tags.mjs'

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
  assert.deepEqual(r.tags, ['latest', '1.25', '1.24']) // 降序
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
  assert.deepEqual(r.tags, ['latest', 'alpine', '1.25'])
})

test('fetchRegistryTags: 换票 realm 非法 URL → 落回原 401 needsAuth 而非抛错', async () => {
  const fetchImpl = async () => stubRes(401, { headers: { 'www-authenticate': 'Bearer realm="not-a-url"' } })
  const r = await fetchRegistryTags({ image: 'reg.io/org/app:1', fetchImpl })
  assert.equal(r.needsAuth, true)
})
