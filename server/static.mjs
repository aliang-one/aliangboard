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

  const rel = decodeURIComponent(url.pathname)
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
  const headers = { 'Content-Type': ct, 'Content-Length': st.size }
  if (filePath.endsWith('index.html')) headers['Cache-Control'] = 'no-cache'
  else if (rel.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'

  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return true }
  createReadStream(filePath).pipe(res)
  return true
}
