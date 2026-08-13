// DeployApp 环境变量三区块(envVars / envCMKeys / envSecretKeys)共用的行级判定纯函数。
// 校验端(validate)与 YAML 生成端共用语义:整行全空 → 跳过;跨区块收集名 → 查重(K8s 拒绝重复 env 名)。

export function isEmptyEnvRow(row, fields) {
  if (!row) return true
  return fields.every(f => {
    const v = row[f]
    return v === undefined || v === null || String(v).trim() === ''
  })
}

export function firstDuplicateEnvName(envVars = [], envCMKeys = [], envSecretKeys = []) {
  const names = [
    ...(envVars || []).map(e => e?.key),
    ...(envCMKeys || []).map(e => e?.name),
    ...(envSecretKeys || []).map(e => e?.name),
  ]
  const seen = new Set()
  for (const n of names) {
    const k = (n ?? '').trim()
    if (!k) continue
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}
