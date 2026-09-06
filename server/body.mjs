// 请求体读取与 JSON 解析(从 index.mjs 抽出,纯逻辑可单测)。
// 修复(2026-08-16):原实现裸 JSON.parse——二进制/非 JSON 体打到任何走 readBody 的端点,
// V8 SyntaxError("Unexpected token 'x'...")会原样泄漏给前端(用户上传撞旧网关时的报错现场)。
// 现在统一抛 400 + 可读文案;空体仍返回 {}(既有契约)。
// 大小上限(2026-09-06 审计#10):readBody 是全端点共用入口,旧实现 for-await 无界缓冲,
// 恶意/异常客户端可灌巨体撑内存。超限 413 + 立即 destroy 流停读。5MB 覆盖最大合法体
// (kubeconfig / apply YAML / 审批载荷);大文件上传走专用流式端点,不经此。
import { msg } from './messages.mjs'

const BODY_LIMIT_BYTES = 5 * 1024 * 1024

export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT_BYTES) {
      req.destroy?.()
      throw Object.assign(new Error(msg(req, 'admin.bodyTooLarge')), { status: 413 })
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error(msg(req, 'admin.invalidJsonBody')), { status: 400 })
  }
}
