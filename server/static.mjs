// 生产静态前端服务(SPA):/api/* 未命中时,GET/HEAD 读 dist/,文件不存在则回 index.html 交客户端路由。
// 独立无副作用模块:便于单测,且 server/index.mjs import 时不会触发整服务启动(DB/listen 等)。
// 安全:① 仅 GET/HEAD;② /api 前缀交调用方走 404 JSON;③ 路径 normalize 后必须仍在 root 之内(前缀带分隔符,防 /dist 与 /dist-evil 误命中)。
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

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

  const ct = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
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

  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return true }
  createReadStream(filePath).pipe(res)
  return true
}
