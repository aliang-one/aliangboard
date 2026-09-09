// HTTP gzip 协商与压缩小件(2026-09-09 LCP 5.96s / 首屏慢根因修复):
// 网关曾全程零压缩——登录页关键路径 1.05MB 裸传(gzip 后 ~330KB),K8s 透传大列表
// 1MB+(gzip 后 ~100KB),慢无线腿上首屏资产与背景刷新互踩。静态资产面(static.mjs)
// 与 API JSON 面(index.mjs sendJson)共用本件;部署即自动压缩,零配置,不依赖反代。
// 约束:压缩走 zlib 异步线程池(单进程网关不占事件循环);永不 reject(调用方免 try/catch)。
// 注意:本仓 Node 运行时的 zlib.gzip 无「省略 callback 返回 Promise」重载(实测直接抛
// "callback must be a function"),必须 promisify 包装 —— 千万别裸 await 原函数。
import { gzip as gzipCb } from 'node:zlib'
import { promisify } from 'node:util'
const gzip = promisify(gzipCb)

export const MIN_COMPRESS_BYTES = 1024

// Accept-Encoding 里的 gzip 协商:token 级解析,gzip;q=0 视为拒绝(spec 语义)。
export function acceptsGzip(req) {
  const ae = String(req?.headers?.['accept-encoding'] || '')
  for (const part of ae.split(',')) {
    const [tok, ...params] = part.trim().split(';')
    if (tok.trim().toLowerCase() !== 'gzip') continue
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='))
    if (q && Number(q.slice(2)) === 0) return false
    return true
  }
  return false
}

// 可压则压:任一不压条件(非 Buffer/太小/客户端不接受/压完反而变大/出错)返回 null = 裸传。
export async function maybeGzip(buf, req) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_COMPRESS_BYTES || !acceptsGzip(req)) return null
  try {
    const gz = await gzip(buf)
    return gz.length < buf.length ? gz : null
  } catch { return null }
}
