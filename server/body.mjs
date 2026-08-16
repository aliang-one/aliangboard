// 请求体读取与 JSON 解析(从 index.mjs 抽出,纯逻辑可单测)。
// 修复(2026-08-16):原实现裸 JSON.parse——二进制/非 JSON 体打到任何走 readBody 的端点,
// V8 SyntaxError("Unexpected token 'x'...")会原样泄漏给前端(用户上传撞旧网关时的报错现场)。
// 现在统一抛 400 + 可读文案;空体仍返回 {}(既有契约)。
export async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是有效 JSON(需要 application/json)'), { status: 400 })
  }
}
