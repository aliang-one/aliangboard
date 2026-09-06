// W2 Phase E(Task 1):impersonation 身份构造 + 集群能力探测器(纯逻辑,deps 注入可单测)。
//
// 身份归真:网关凭据是集群级的,apiserver 侧审计/RBAC 只见网关不见人。Phase E 让每个 K8s
// egress 请求带 Impersonate-* 头,把真实平台用户(及其组)归真到 apiserver。命名约定(spec §7):
//   User = aliangboard:u-<userId>
//   Group = aliangboard:team-<groupId>
//   可读名走 Impersonate-Extra-Displayname(displayName 优先,回退 username)
// admin 平台用户同样携带(R3:admin 归真同理所应当);legacy 会话(无 userId)无身份 → 不注入。
//
// 探测器:网关凭据未必有 impersonate 权(自管 SA 常没有)——盲目注入会让全站请求 403。
// 故对每个 cluster 探测一次:POST /apis/authorization.k8s.io/v1/selfsubjectrulesreviews
// 显式自带 impersonate 头——2xx → 凭据可 impersonate(后续 egress 注入);403/401/网络错误
// → false(保守,不注入,回退 v1 门语义)。结果按 clusterId 缓存在内存 Map(重启清零可接受,
// 受网关单进程不变式保护);并发去重(在途 Promise 共享)。

export const IMPERSONATE_USER_PREFIX = 'aliangboard:u-'
export const IMPERSONATE_GROUP_PREFIX = 'aliangboard:team-'
export const IMPERSONATION_PROBE_PATH = '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews'

// 平台身份 → impersonate 名列表:['aliangboard:u-<userId>', ...groups.map(g => 'aliangboard:team-<groupId>')]。
// 用户不存在/禁用/空 userId → [](legacy 无归属 = 无注入)。组序随 group_members 写入序(createdAt, id 兜底)。
export function buildImpersonation(db, userId) {
  if (!userId) return []
  const user = db.prepare('SELECT id, disabled FROM platform_users WHERE id=?').get(userId)
  if (!user || user.disabled) return []
  const groups = db.prepare(`
    SELECT g.id AS id FROM groups g JOIN group_members m ON m.groupId = g.id
    WHERE m.userId = ? ORDER BY m.createdAt, g.id`).all(userId)
  return [IMPERSONATE_USER_PREFIX + userId, ...groups.map(g => IMPERSONATE_GROUP_PREFIX + g.id)]
}

// 可读名(displayName 优先,回退 username;ghost/禁用 → undefined)。Impersonate-Extra-Displayname
// 的值来源——存在内存 session 对象上(与 impersonate 列表同生命周期,不持久化)。
export function impersonateDisplaynameFor(db, userId) {
  if (!userId) return undefined
  const row = db.prepare('SELECT username, displayName, disabled FROM platform_users WHERE id=?').get(userId)
  if (!row || row.disabled) return undefined
  return row.displayName || row.username || undefined
}

// session → impersonate 头对象(node 小写头名;undici 数组形态 = 同名头重复)。
// 纯函数:impersonate 为空数组/undefined/非数组 → {}(不注入)。group 恒数组形态(单值亦然)。
// displayname 仅在确有 user 身份时携带(K8s 要求 impersonate group/extra 必须伴随 user)。
export function impersonateHeadersFor(session) {
  const list = Array.isArray(session?.impersonate) ? session.impersonate.filter(x => typeof x === 'string' && x) : []
  const user = list.find(x => x.startsWith(IMPERSONATE_USER_PREFIX))
  if (!user) return {}
  const groups = list.filter(x => x.startsWith(IMPERSONATE_GROUP_PREFIX))
  const headers = { 'impersonate-user': user }
  if (groups.length) headers['impersonate-group'] = groups
  if (session.impersonateDisplayname) headers['impersonate-extra-displayname'] = String(session.impersonateDisplayname)
  return headers
}

// egress 注入(Task 2 消费):probe 通过 + session 有身份才注;显式已有同名气头不覆盖
// (纵深防御:client spoof 头已在网关入口剥离,这里不覆盖保证内部调用方显式语义优先)。
// 就地 mutate 并返回同一 headers 对象(requestOnce 单点调用)。
export function mergeImpersonate(headers, session, probed) {
  if (!probed || !Array.isArray(session?.impersonate) || !session.impersonate.length) return headers
  const imp = impersonateHeadersFor(session)
  for (const k of Object.keys(imp)) if (headers[k] === undefined) headers[k] = imp[k]
  return headers
}

// 探测器工厂(模块闭包缓存;每集群只探测一次,在途去重)。
// requestKubernetes 与 requestOnce 同签名(注入便单测);requestOnce 对非 2xx 抛错
// (err.status 携 HTTP 码),故「到达即 2xx」;403/401/网络错误统一进 catch → false。
export function createImpersonationProbe({ requestKubernetes } = {}) {
  // clusterId → true/false(已决)| Promise<boolean>(在途)。在途条目同样算「已 kick」,
  // 防探测器自身请求回流 requestOnce 懒探测时无限递归。
  const cache = new Map()

  async function runProbe(session) {
    // 探测请求显式自带 impersonate 头——注入门未开时不带头的 2xx 证明不了 impersonate 能力。
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...impersonateHeadersFor(session),
    }
    const body = JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: {} })
    await requestKubernetes(session, IMPERSONATION_PROBE_PATH, { method: 'POST', headers, body })
    return true
  }

  function ensureProbed(session) {
    const clusterId = session?.clusterId
    if (clusterId == null || !Array.isArray(session?.impersonate) || !session.impersonate.length) {
      return Promise.resolve(false) // 无归属/无身份:不发探测,也不写缓存(不占用 clusterId 键)
    }
    const hit = cache.get(clusterId)
    if (hit !== undefined) return typeof hit === 'boolean' ? Promise.resolve(hit) : hit
    const inflight = runProbe(session).then(
      ok => { cache.set(clusterId, ok); return ok },
      () => { cache.set(clusterId, false); return false }, // 403/401/网络错误 → false(保守)
    )
    cache.set(clusterId, inflight)
    return inflight
  }

  return {
    ensureProbed,
    // true/false = 已决;undefined = 未探测或在途(egress 注入只认 === true,保守)。
    isProbed: clusterId => {
      const v = cache.get(clusterId)
      return typeof v === 'boolean' ? v : undefined
    },
    // fire-and-forget 懒探测(egress 收口用):有身份 + cache 无条目(含在途)才发起;不抛错。
    kick: session => {
      if (session?.clusterId == null || !Array.isArray(session?.impersonate) || !session.impersonate.length) return
      if (cache.has(session.clusterId)) return
      Promise.resolve(ensureProbed(session)).catch(() => { /* ensureProbed 恒不拒,双保险 */ })
    },
  }
}
