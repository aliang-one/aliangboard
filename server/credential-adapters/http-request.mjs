// http_request 适配器(2026-09-12-v2 spec §7)。铁律:api_token 只作为请求头在 exec 闭包内组装,
// 永不进返回值/日志/错误文本;目标恒限于凭据 base_url 的 origin(SSRF 白名单,重定向逐跳复验)。
// redirect:'manual' 为仓内首例(undici 8.9:manual 返回真实 3xx+可读 location)。
import { fetch as defaultFetch } from 'undici'
import { maskSensitiveText } from '../secret-mask.mjs'

const BODY_MAX = 32768
const timeoutMs = () => Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 20000
// Wave B 加固(spec §7):写方法在 exec 放行(桥 needsApproval 对写方法恒人审——readonlyMethods
// 与桥共用,人审之后才到这里);AI 提供的请求头剥离敏感族(身份只可平台注入);响应头只透白名单。
const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH']
const HEADER_PASSLIST = [/^content-type$/, /^ratelimit-/, /^x-ratelimit-/, /^retry-after$/]
const FORBIDDEN_REQ_HEADERS = [/^authorization$/, /^cookie$/, /^proxy-authorization$/]
const REDIRECT_MAX = 3

export function createHttpRequestAdapter({ fetchImpl = defaultFetch } = {}) {
  const fetchFn = fetchImpl   // 注入缝,registry-tags.mjs 先例
  const manifest = {
    name: 'http_request',
    title: 'HTTP 请求',
    needs: { base_url: 'text', api_token: 'password' },
    readonlyMethods: ['GET'],   // 桥 needsApproval 判定集:写方法恒人审(spec §6.2/§7)
  }
  async function exec({ fields, args }) {
    // 字段键大小写归一(T2/T3 记账清偿):桥按存储原键传 fields(可含大写,如 API_Token),
    // exec 一律按 manifest needs 键做大小写不敏感索引——防 fields.api_token=undefined→Bearer undefined。
    const f = {}
    for (const k of Object.keys(manifest.needs)) {
      const stored = Object.keys(fields).find(x => x.toLowerCase() === k)
      f[k] = fields[stored] ?? ''
    }
    const base = String(f.base_url || '').trim()
    if (!base) return { error: '该凭据缺 base_url 字段' }
    let baseU
    try { baseU = new URL(base) } catch { return { error: 'base_url 非法' } }
    if (baseU.protocol !== 'http:' && baseU.protocol !== 'https:') return { error: 'base_url 协议仅支持 http/https' }
    const method = String(args?.method || 'GET').toUpperCase()
    if (!['GET', ...WRITE_METHODS].includes(method)) return { error: `不支持的 method: ${method}` }
    let u
    try { u = new URL(String(args?.path || '/'), baseU) } catch { return { error: 'path 非法' } }
    // 请求头:平台注入 Authorization;AI 提供的头剥离敏感族(spec §7,大小写不敏感)
    const headers = { authorization: `Bearer ${f.api_token}` }
    for (const [k, v] of Object.entries(args?.headers || {})) {
      if (FORBIDDEN_REQ_HEADERS.some(re => re.test(k.toLowerCase()))) continue
      headers[k.toLowerCase()] = String(v)
    }
    const body = method === 'GET' ? undefined : String(args?.body ?? '').slice(0, BODY_MAX)
    // redirect:'manual' 逐跳跟随,每跳 origin 复验(spec §7 SSRF 白名单)
    let res
    for (let hop = 0; hop <= REDIRECT_MAX; hop++) {
      if (u.origin !== baseU.origin) return { error: '目标不在该凭据声明的 base_url 范围内' }
      try {
        res = await fetchFn(u, { method, headers, body, signal: AbortSignal.timeout(timeoutMs()), redirect: 'manual' })
      } catch (e) { return { error: `请求失败(${e?.cause?.code || e?.name || 'network'})` } }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) break
        try { u = new URL(loc, u) } catch { return { error: '重定向地址非法' } }
        continue
      }
      break
    }
    if (res.status >= 300 && res.status < 400) return { error: `重定向超过 ${REDIRECT_MAX} 跳` }
    let text = ''
    try { text = await res.text() } catch { text = '' }
    // T7 审查修复:先脱敏后裁剪(spec §11.2)——先 slice 会把跨 32KB 边界的 JWT/PEM 切成半截,
    // mask 正则不再命中,半截秘密直达 LLM。与 db_query 的逐单元格先 mask 后裁剪同序。
    text = maskSensitiveText(text)
    if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX) + `…(截断,共 ${text.length})`
    const outHeaders = {}
    for (const [k, v] of (res.headers.entries ? res.headers.entries() : [])) {
      if (HEADER_PASSLIST.some(re => re.test(k.toLowerCase()))) outHeaders[k.toLowerCase()] = v
    }
    return { status: res.status, contentType: res.headers.get('content-type') || '', headers: outHeaders, body: text }
  }
  return { manifest, exec }
}
