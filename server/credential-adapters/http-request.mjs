// http_request 适配器(2026-09-12-v2 spec §7)。铁律:api_token 只作为请求头在 exec 闭包内组装,
// 永不进返回值/日志/错误文本;目标恒限于凭据 base_url 的 origin(SSRF 白名单)。
// redirect:'manual' 为仓内首例(undici 8.9:manual 返回真实 3xx+可读 location);Wave B 补逐跳复验。
import { fetch as defaultFetch } from 'undici'
import { maskSensitiveText } from '../secret-mask.mjs'

const BODY_MAX = 32768
const timeoutMs = () => Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 20000

export function createHttpRequestAdapter({ fetchImpl = defaultFetch } = {}) {
  const fetchFn = fetchImpl   // 注入缝,registry-tags.mjs 先例
  const manifest = {
    name: 'http_request',
    title: 'HTTP 请求',
    needs: { base_url: 'text', api_token: 'password' },
    readonlyMethods: ['GET'],           // Wave B 前仅 GET
  }
  async function exec({ fields, args }) {
    const base = String(fields.base_url || '').trim()
    if (!base) return { error: '该凭据缺 base_url 字段' }
    let baseU
    try { baseU = new URL(base) } catch { return { error: 'base_url 非法' } }
    const method = String(args?.method || 'GET').toUpperCase()
    if (!manifest.readonlyMethods.includes(method)) return { error: `仅支持 ${manifest.readonlyMethods.join('/')}（写方法后续版本提供）` }
    let u
    try { u = new URL(String(args?.path || '/'), baseU) } catch { return { error: 'path 非法' } }
    if (u.origin !== baseU.origin) return { error: '目标不在该凭据声明的 base_url 范围内' }
    let res
    try {
      res = await fetchFn(u, {
        method,
        headers: { authorization: `Bearer ${fields.api_token}`, ...(args?.query || {}) && {} },
        signal: AbortSignal.timeout(timeoutMs()),
        redirect: 'manual',
      })
    } catch (e) { return { error: `请求失败(${e?.cause?.code || e?.name || 'network'})` } }
    let body = ''
    try { body = await res.text() } catch { body = '' }
    if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX) + `…(截断,共 ${body.length})`
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: maskSensitiveText(body) }
  }
  return { manifest, exec }
}
