// 镜像仓库可用 tag 查询（registry v2 /v2/<repo>/tags/list）。
// 2026-09-03 修复「拉取可用版本 401 要求填密码」：registry v2 的鉴权是 token 流程——
// 匿名拉公共镜像也必须先向 WWW-Authenticate 指定的 token 服务换票再重试，裸请求恒 401。
// 此前实现把 401 直接当「需要账密」抛给用户（Docker Hub 公共镜像必现），且空 registry
// 的官方镜像（nginx 等）拼出 https:///v2/... 非法 URL 直接 502。两处都在此收口。
// fetchImpl 注入：index.mjs 传 undici fetch，测试传桩。

const DOCKER_HUB_DATA_HOST = 'registry-1.docker.io'

// 镜像引用 → { registry, repo }（去 digest/tag；registry 为空 = Docker Hub 官方命名空间）。
export function normalizeImageRef(image) {
  let s = String(image || '').trim().split('@')[0] // 去 digest
  const slash = s.indexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) s = s.slice(0, colon) // 去 tag（仅当 : 在最后一个 / 之后）
  const firstSlash = s.indexOf('/')
  const head = firstSlash > -1 ? s.slice(0, firstSlash) : ''
  const isRegistry = head && (head.includes('.') || head.includes(':') || head === 'localhost')
  if (isRegistry) return { registry: head, repo: s.slice(firstSlash + 1) }
  return { registry: '', repo: s } // 无 registry → 视为官方镜像（docker.io）
}

// registry/repo 归一为可直接拼 v2 路径的形态：
// Docker Hub（空/docker.io/index.docker.io）→ 数据端点 registry-1.docker.io；官方单段镜像补 library/ 命名空间。
export function normalizeEndpoint(registry, repo) {
  const isDockerHub = !registry || registry === 'docker.io' || registry === 'index.docker.io'
  const host = isDockerHub ? DOCKER_HUB_DATA_HOST : registry
  const path = isDockerHub && !repo.includes('/') ? `library/${repo}` : repo
  return { host, repo: path }
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64')
}

// 解析 WWW-Authenticate: Bearer realm="..." service="..." scope="..."
function parseBearerChallenge(header) {
  const h = String(header || '')
  if (!/^bearer\s/i.test(h)) return null
  const realm = /realm="([^"]+)"/.exec(h)?.[1]
  if (!realm) return null
  const service = /service="([^"]+)"/.exec(h)?.[1]
  const scope = /scope="([^"]+)"/.exec(h)?.[1]
  return { realm, service, scope }
}

/**
 * 拉取 tags/list。返回：
 *   { ok: true, registry, repo, tags }                    — 成功（tags 降序）
 *   { ok: false, status, needsAuth: true }                — 401 且 token 换票也失败/非 Bearer 挑战（真正需要账密）
 *   { ok: false, status, notFound: true }                 — 仓库不存在
 *   { ok: false, status, bodySnippet }                    — 其他非 2xx
 *   { ok: false, unreachable: true, message }             — https/http 均不可达
 */
export async function fetchRegistryTags({ image, username, password, fetchImpl }) {
  const fetchFn = fetchImpl
  const ref = normalizeImageRef(image)
  // 注意：registry 为空是合法形态（Docker Hub），只拦 repo 为空——旧实现 !ref.registry 即 400，
  // 导致 nginx 等官方镜像「拉取可用版本」直接报引用无法解析。
  if (!ref.repo) return { ok: false, unparsable: true }
  const { host, repo } = normalizeEndpoint(ref.registry, ref.repo)
  if (!host || !repo) return { ok: false, unparsable: true }

  const headers = {}
  if (username || password) headers.authorization = basicAuth(username, password)
  const path = `/v2/${repo}/tags/list?n=100`

  // 单次请求（https 优先，抛错回退 http）。401 且是 Bearer 挑战 → 向 token 服务换票重试一次。
  const attempt = async scheme => {
    const target = `${scheme}://${host}${path}`
    let r = await fetchFn(target, { headers })
    if (r.status === 401) {
      const challenge = parseBearerChallenge(r.headers.get('www-authenticate'))
      if (challenge) {
        try {
          const u = new URL(challenge.realm)
          if (challenge.service) u.searchParams.set('service', challenge.service)
          if (challenge.scope) u.searchParams.set('scope', challenge.scope)
          const tokHeaders = {}
          if (headers.authorization) tokHeaders.authorization = headers.authorization // 私有仓库：账密交给 token 服务
          const tr = await fetchFn(String(u), { headers: tokHeaders })
          if (tr.ok) {
            const tk = await tr.json().catch(() => ({}))
            const token = tk.token || tk.access_token
            if (token) r = await fetchFn(target, { headers: { ...headers, authorization: `Bearer ${token}` } })
          }
        } catch { /* realm 非法/换票链路异常 → 落回原 401 */ }
      }
    }
    return r
  }

  let r
  try {
    r = await attempt('https')
  } catch (e) {
    // https 不可达（明文 registry / 端口未开 TLS）→ 回退 http
    try {
      r = await attempt('http')
    } catch (e2) {
      return { ok: false, unreachable: true, message: e2?.message || String(e2) }
    }
  }

  if (r.status === 401) return { ok: false, status: 401, needsAuth: true }
  if (r.status === 404) return { ok: false, status: 404, notFound: true }
  if (!r.ok) {
    const bodySnippet = (await r.text().catch(() => '')).slice(0, 200)
    return { ok: false, status: r.status, bodySnippet }
  }
  const data = await r.json().catch(() => ({}))
  // 过滤 OCI 产物伪 tag（cosign 签名 .sig / 证明 .att / SBOM，及 buildkit 的 sha256-<digest> 裸摘要）：
  // 这些不是可部署版本，且降序排序时 'sha256-…' 恒压在数字版本前，把真版本挤出下拉首屏。
  const isArtifactTag = t => /^sha256-/.test(t) || /\.(sig|att|sbom)(\.json)?$/i.test(t)
  const tags = Array.isArray(data.tags) ? data.tags.filter(t => !isArtifactTag(t)).sort(compareTagsDesc) : []
  return { ok: true, registry: host, repo, tags }
}

// tag 排序（新→旧）：版本号 tag 按数值逐段比较（1.0.20 > 1.0.9——纯字典序会排反），
// 非版本号 tag（latest/main/sha-<短>）垫底，其中 latest 别名置首。前缀 v 均认。
function versionTuple(tag) {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(String(tag || '').trim())
  return m ? m[1].split('.').map(Number) : null
}

export function compareTagsDesc(a, b) {
  const [va, vb] = [versionTuple(a), versionTuple(b)]
  if (va && vb) {
    const len = Math.max(va.length, vb.length)
    for (let i = 0; i < len; i++) {
      const d = (va[i] || 0) - (vb[i] || 0)
      if (d) return -d // 降序
    }
    return 0
  }
  if (va) return -1 // 版本号优先
  if (vb) return 1
  if (a === 'latest') return -1 // latest 别名是非版本号里最想点的
  if (b === 'latest') return 1
  return a > b ? -1 : a < b ? 1 : 0 // 其余字典序降序（与旧行为方向一致）
}
