// 平台版本单一事实源 + semver 归一化纯函数(2026-08-27 版本机制设计)。
// APP_VERSION:CI 经 docker build-args 注入(Dockerfile ARG VERSION=dev → ENV APP_VERSION);
// 本地 dev / main 手动构建无注入 → 'dev'。归一化规则:比较与持久化一律去 'v' 前缀规范形,展示时前端加前缀。
export const APP_VERSION = String(process.env.APP_VERSION || 'dev').replace(/^v/, '')

// 'v1.2.3'/'1.2.3' → '1.2.3';非严格三段 semver(预发布/缩写/空)→ null
export function normalizeSemver(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(input || '').trim())
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

// 数值比较(非字典序:1.10.0 > 1.9.0);任一非法 → false
export function semverGt(a, b) {
  const x = normalizeSemver(a), y = normalizeSemver(b)
  if (!x || !y) return false
  const [a1, a2, a3] = x.split('.').map(Number)
  const [b1, b2, b3] = y.split('.').map(Number)
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3
}

// tag 名列表 → 最高规范形(全量比较,不信任入参顺序——GitHub API 按创建时间倒序非 semver 序);无合法 → null
export function pickLatest(tagNames) {
  let best = null
  for (const name of Array.isArray(tagNames) ? tagNames : []) {
    const n = normalizeSemver(name)
    if (n && (best === null || semverGt(n, best))) best = n
  }
  return best
}
