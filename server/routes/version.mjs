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
