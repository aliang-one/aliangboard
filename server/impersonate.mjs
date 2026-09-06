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
// 显式自带 impersonate 头——2xx → 凭据可 impersonate(后续 egress 注入);401/403
// → false 并缓存(确定性「凭据无 impersonate 权」);5xx/网络错误 → 本次 false 但不缓存
// (瞬态,下一请求重试)。结果按 clusterId 缓存在内存 Map(重启清零可接受,受网关单进程
// 不变式保护);并发去重(在途 Promise 共享)。
//
// Kill-switch(review #2,总开关默认关):仅当 platform_settings 的 impersonation.enabled === '1'
// 才真探测/注入——防止 Phase E Task 3/4(组 RoleBinding 供给)落地前对无身份 RBAC 的集群
// 403 风暴。关时不发 SSRR 也不写缓存 → admin 置 '1' 后无需重启,下一 kick 即真探测;
// 开→关的收口靠重启清缓存(裁定可接受)。admin 经 sqlite/platform_settings 直接置键
// (无 admin UI;Phase E Task 4 文档化)。

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
// displayname 是唯一用户可控的头值 → 剥控制字符成空格(\r\n\t 等 = 头注入防线,review #3);
// 且 undici 头值走 ByteString 转换——**>0xFF 的字符直接 TypeError**(final-review Critical 2:
// 并非 mojibake,CJK displayName 会让探测通过后的每个缓冲请求 500)——故非 Latin-1 字符整字
// 剔除(用户名仍在 impersonate-user,displayname 纯展示不影响鉴权)+ 截 64 上限 + 去首尾空白;
// 清空则整个头省略(不发空值头)。
export function impersonateHeadersFor(session) {
  const list = Array.isArray(session?.impersonate) ? session.impersonate.filter(x => typeof x === 'string' && x) : []
  const user = list.find(x => x.startsWith(IMPERSONATE_USER_PREFIX))
  if (!user) return {}
  const groups = list.filter(x => x.startsWith(IMPERSONATE_GROUP_PREFIX))
  const headers = { 'impersonate-user': user }
  if (groups.length) headers['impersonate-group'] = groups
  if (session.impersonateDisplayname) {
    const dn = String(session.impersonateDisplayname)
      .replace(/[\r\n\t\x00-\x1f]/g, ' ')          // 头注入防线:控制字符(含换行)成空格
      .replace(/[^\x20-\x7e\xa0-\xff]/g, '')       // ByteString 界:>0xFF 剔除(Critical 2)
      .slice(0, 64)                                // 头值长度上限
      .trim()
    if (dn) headers['impersonate-extra-displayname'] = dn
  }
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
// (err.status 携 HTTP 码),故「到达即 2xx」。getSetting 可选注入(kill-switch 读取;
// 未注入 = 视为关,保守)。
export function createImpersonationProbe({ requestKubernetes, getSetting } = {}) {
  // clusterId → true/false(已决)| Promise<boolean>(在途占位)。占位在 runProbe 发出任何请求
  // **之前**同步写入(final-review Critical 1)——探测器自身请求回流 requestOnce 懒探测时,
  // 回流 kick 命中在途占位而非重入,杜绝同步自递归。
  const cache = new Map()

  async function runProbe(session) {
    // 探测请求显式自带 impersonate 头——注入门未开时不带头的 2xx 证明不了 impersonate 能力。
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...impersonateHeadersFor(session),
    }
    // spec.namespace 是 SSRR 的必填字段(K8s API: "namespace to evaluate rules for. Required.")
    // ——缺省会被 apiserver 400 拒(review #1:探测永远真不了=注入死在起点)。'default' 仅作
    // 探测载体命名空间,不承载语义(RBAC 评估任一 ns 都能证明凭据的 impersonate 通道)。
    const body = JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: 'default' } })
    // __impersonationProbe 标记(final-review Critical 1 第二层防线):requestOnce 的
    // injectImpersonation 见标记早退——探测器自身请求永不回流 kick,双保险防同步自递归。
    await requestKubernetes(session, IMPERSONATION_PROBE_PATH, { method: 'POST', headers, body, __impersonationProbe: true })
    return true
  }

  function ensureProbed(session) {
    const clusterId = session?.clusterId
    if (clusterId == null || !Array.isArray(session?.impersonate) || !session.impersonate.length) {
      return Promise.resolve(false) // 无归属/无身份:不发探测,也不写缓存(不占用 clusterId 键)
    }
    // Kill-switch(review #2):默认关。关 → 不发 SSRR、不写缓存(admin 置 '1' 后无需重启,
    // 下一 kick 即真探测)。未注入 getSetting 同样视为关(保守)。
    if (!getSetting || getSetting('impersonation.enabled') !== '1') return Promise.resolve(false)
    const hit = cache.get(clusterId)
    if (hit !== undefined) return typeof hit === 'boolean' ? Promise.resolve(hit) : hit
    // 同步占位(final-review Critical 1 第一层防线):runProbe 的同步前置段会经 requestKubernetes
    // → requestOnce → injectImpersonation 回流 kick——若先发请求再写缓存,回流看到空缓存 →
    // 无限同步自递归(每次 enable 实测 ~1,148+ 发重复 SSRR 直到栈深截断)。占位 Promise 在任何
    // 请求发出之前占据 clusterId 键;结果落定后原位换成 boolean(401/403 → false 缓存;瞬态 →
    // 删键可重试),占位本身恒 resolve 不拒(ensureProbed 契约「恒不拒」保持)。
    let settle
    const placeholder = new Promise(r => { settle = r })
    cache.set(clusterId, placeholder)
    runProbe(session).then(
      ok => { cache.set(clusterId, ok); settle(ok) },
      e => {
        // 401/403 = 确定性「凭据无 impersonate 权」→ 缓存 false(不再打扰 apiserver);
        // 其余(5xx/网络错误/无 status)= 瞬态 → 不缓存(isProbed 保持 undefined,下一请求重试)。
        if (e?.status === 401 || e?.status === 403) { cache.set(clusterId, false); settle(false); return }
        cache.delete(clusterId)
        settle(false)
      },
    )
    return placeholder
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
