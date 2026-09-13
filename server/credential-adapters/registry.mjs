// 适配器注册表(2026-09-12-v2 spec §5):manifest 契约 + 字段形状匹配。
// 新增适配器 = 清单 + exec,零接线。
import { createHttpRequestAdapter } from './http-request.mjs'
import { createDbQueryAdapter } from './db-query.mjs'

// re-export:测试与调用方统一从 registry 取适配器工厂(定义仍在 http-request.mjs)
export { createHttpRequestAdapter }
export { createDbQueryAdapter }

const httpAdapter = createHttpRequestAdapter()
const dbAdapter = createDbQueryAdapter()
export const ADAPTERS = {
  http_request: httpAdapter,
  db_query: dbAdapter,
}

export function listAdapters() {
  return Object.entries(ADAPTERS).filter(([, a]) => a).map(([name, a]) => ({ name, title: a.manifest.title, needs: a.manifest.needs }))
}
export function adapterToolNames() {
  return new Set(Object.values(ADAPTERS).filter(Boolean).map(a => a.manifest.name))
}
export function getAdapter(name) { return ADAPTERS[name] || null }
// key 大小写不敏感;needs 的 password 型字段必须真实为 password(text 不匹配)
export function matchAdapter(adapterName, credentialRow) {
  const a = ADAPTERS[adapterName]
  if (!a) return { ok: false, missing: [`未知适配器: ${adapterName}`] }
  const byKey = new Map((credentialRow?.fields || []).map(f => [f.key.toLowerCase(), f.type]))
  const missing = []
  for (const [k, type] of Object.entries(a.manifest.needs)) {
    const actual = byKey.get(k.toLowerCase())
    if (actual !== type) missing.push(k)   // 缺失或型不符同列 missing
  }
  return missing.length ? { ok: false, missing } : { ok: true }
}
export function adaptersForCredential(credentialRow) {
  return Object.keys(ADAPTERS).filter(n => ADAPTERS[n] && matchAdapter(n, credentialRow).ok)
}
