// 生产静态前端服务(SPA):/api/* 未命中时,GET/HEAD 读 dist/,文件不存在则回 index.html 交客户端路由。
// 独立无副作用模块:便于单测,且 server/index.mjs import 时不会触发整服务启动(DB/listen 等)。
// 安全:① 仅 GET/HEAD;② /api 前缀交调用方走 404 JSON;③ 路径 normalize 后必须仍在 root 之内(前缀带分隔符,防 /dist 与 /dist-evil 误命中)。
// gzip(2026-09-09 LCP 5.96s 根因修复):text 类资产按 Accept-Encoding: gzip 压缩——登录页关键
// 路径实测 1.05MB 裸传(gzip 后 ~330KB,3.3×),慢无线腿上直接顶飞 LCP。已压缩格式(字体/图片)
// 与 <1KB 小文件豁免;压缩走 zlib 异步线程池,不占事件循环;压不动(反而变大)回退裸传。
// 协商与压缩实现共用 server/http-compress.mjs(与 API JSON 面同源)。
import { createReadStream, readFile, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { MIN_COMPRESS_BYTES, acceptsGzip, maybeGzip } from './http-compress.mjs'

// 可压扩展名:纯 text 类。woff/woff2/png 等已是压缩格式,再压只浪费 CPU。
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.map', '.txt'])

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

// 返回 true = 已写响应(命中);false = 未命中(交调用方走 404 兜底)。
// req: { method };res: ServerResponse(writeHead/end/可被 pipe);url: { pathname };opts.root: dist 绝对路径。
export function serveStatic(req, res, url, { root } = {}) {
  if (!root) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (url.pathname.startsWith('/api')) return false

  let rel
  try { rel = decodeURIComponent(url.pathname) } catch { return false }
  const rootNorm = root.endsWith('/') ? root.slice(0, -1) : root
  const safe = normalize(join(rootNorm, rel))
  if (safe !== rootNorm && !safe.startsWith(rootNorm + '/')) return false // 防穿越(带分隔符)

  let filePath = safe
  try {
    const st = statSync(filePath)
    if (st.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(rootNorm, 'index.html') // SPA fallback:未知前端路由交客户端路由
  }

  let st
  try { st = statSync(filePath) } catch { return false }
  if (!st.isFile()) return false

  const ext = extname(filePath).toLowerCase()
  const ct = MIME[ext] || 'application/octet-stream'
  // 安全头(2026-08-28 架构治理):CSP 收窄 XSS 战果(CodeViewer 事故的纵深防御层)。
  // 依据:资产全部 self(fontsource 自托管/Vite 外链 CSS);style unsafe-inline = xterm/echarts/内联 style 属性;
  // img data:/blob: = 文件预览;connect ws/wss = /api/exec 终端。无 Worker、无远程图(已排查)。
  // 仅生产静态服务生效(vite dev 不经此路径);若日后引入远程资产,先改此处再上手。
  const headers = {
    'Content-Type': ct, 'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  }
  if (filePath.endsWith('index.html')) headers['Cache-Control'] = 'no-cache'
  else if (rel.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  // 可压类型恒带 Vary(即使本次裸传):共享缓存必须按键区分,否则会把压缩版错发给不识 gzip 的客户端。
  if (COMPRESSIBLE.has(ext)) headers['Vary'] = 'Accept-Encoding'

  // 裸传路径(HEAD / 不可压 / 小文件 / 压缩失败回退)
  function sendRaw() {
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(filePath).pipe(res)
  }

  // 外层先验 acceptsGzip:不识 gzip 的老客户端不整读文件,保持流式裸传路径。
  if (req.method === 'GET' && COMPRESSIBLE.has(ext) && st.size >= MIN_COMPRESS_BYTES && acceptsGzip(req)) {
    readFile(filePath, async (err, buf) => {
      // 读失败/不压条件/压不动反而变大(高度随机内容)→ 一律回退裸传,保响应可达
      const gz = err ? null : await maybeGzip(buf, req)
      if (!gz) return sendRaw()
      headers['Content-Encoding'] = 'gzip'
      headers['Content-Length'] = gz.length
      res.writeHead(200, headers)
      res.end(gz)
    })
    return true
  }
  sendRaw()
  return true
}
