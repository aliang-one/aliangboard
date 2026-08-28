// 服务端用户可见消息双语表：按请求 Accept-Language 取语（无头默认 zh，与既有测试/行为兼容）。
// 条目按来源文件拆在 ./messages/<ns>.mjs，此处合并导出；zh 值必须与原中文逐字一致
// （既有 server 测试直接断言这些文案）。
//   api.   ← server/index.mjs
//   auth.  ← server/routes/auth.mjs
//   admin. ← server/routes/admin.mjs
//   wbc.   ← server/routes/workbench-conversations.mjs
//   wbp.   ← server/routes/workbench-projects.mjs
import { TABLE as api } from './messages/api.mjs'
import { TABLE as auth } from './messages/auth.mjs'
import { TABLE as admin } from './messages/admin.mjs'
import { TABLE as wbc } from './messages/wbc.mjs'
import { TABLE as wbp } from './messages/wbp.mjs'
import { TABLE as ssh } from './messages/ssh.mjs'

export const tables = { ...api, ...auth, ...admin, ...wbc, ...wbp, ...ssh }

// en 开头（en / en-US / en-GB…）→ en；其余（含无头/zh）→ zh
export function pickLang(req) {
  const al = String(req?.headers?.['accept-language'] || '').trim()
  return /^en\b/i.test(al) ? 'en' : 'zh'
}

// 取码文案 + {param} 插值（split/join，参数含特殊字符也安全）；缺码返回键本身便于暴露问题
export function t(lang, code, params, table = tables) {
  const m = table[code]
  if (!m) return code
  let s = m[lang] || m.zh
  if (params) for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(String(params[k]))
  return s
}

// 路由侧入口：msg(req, 'ns.key'[, params])
export function msg(req, code, params, table = tables) {
  return t(pickLang(req), code, params, table)
}
