// 自助访问令牌(2026-09-04 Wave1 §3.3):普通用户给自己签发/列出/吊销 API key。
// 双类 key 的「用户 key」侧:ownerUserId 必填=本人;恒托管 SA(先供给后落库,失败不留行,同 admin 模式);
// tier 封顶 operator;TTL 缺省 30d、上限 apikey.maxTtlDays(默认 90)。生效权限 = key 配置 ∩ owner 实时权限
// (∩ 判定在 resolveApiKey,Task 3)——本模块只管签发面的自我服务约束。
import { msg } from '../messages.mjs'
import { mintKey, revokeKey, listKeys } from '../auth-keys.mjs'
import { managedSaName, rbacTier } from '../sa-provision.mjs'

const SELF_TIERS = ['read', 'operator']

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
        // TTL:显式 <1/非数字 → 400;超上限一律静默钳到 maxTtlDays;缺省 30 钳入 [1, maxTtl]
        const requested = Number(input?.ttlDays)
        if (input?.ttlDays != null && (!Number.isFinite(requested) || requested < 1)) {
          sendJson(res, 400, { message: msg(req, 'mykeys.ttlInvalid', { max: maxTtlDays() }) }); return true
        }
        const ttl = Math.min(Math.max(Math.floor(Number.isFinite(requested) ? requested : 30), 1), maxTtlDays())
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
