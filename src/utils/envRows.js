// DeployApp 环境变量区块共用的行级判定纯函数。
// 校验端(validate)与 YAML 生成端共用语义:整行全空 → 跳过(env 名查重已收编进 envRows 模型的校验单源)。

export function isEmptyEnvRow(row, fields) {
  if (!row) return true
  return fields.every(f => {
    const v = row[f]
    return v === undefined || v === null || String(v).trim() === ''
  })
}
