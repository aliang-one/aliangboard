// Deploy 向导「command/args 文本 ↔ K8s string[]」切分约定的单一来源。纯函数,不引 Vue,可零依赖测试。
//
// 约定(与 K8s Dashboard/Rancher/Kuboard 一致):
//   command:空白切分(shell token 语义)——`sh -c` → ["sh","-c"];exec 探针/生命周期钩子同此。
//   args  :每行一条——`cp /a /b` 单行 → 单条(含空格不拆散,保住 `sh -c "cp /a /b"` 习惯);多行 → 多条。
// 反例(本约定的由来):args 按空格切分会把 `sh -c` 的整段 shell 命令拆成多条,容器起不来。

// 文本 → command token 数组。空白(空格/制表/换行)分隔,去空项。
export function splitCommandTokens(s) {
  if (!s) return []
  return String(s).split(/\s+/).filter(Boolean)
}

// 文本 → args 数组。按行切分,行首尾去空白,跳过空行(单行即单条,行内空格原样保留)。
export function splitArgLines(s) {
  if (!s) return []
  return String(s).split('\n').map(l => l.trim()).filter(Boolean)
}

// K8s command 数组 → 表单文本(空格 join;token 自身不含空格时往返无损)。
export function joinCommandTokens(arr) {
  return Array.isArray(arr) ? arr.join(' ') : ''
}

// K8s args 数组 → 表单文本(每条一行;任何不含换行的 args 都能无损往返)。
export function joinArgLines(arr) {
  return Array.isArray(arr) ? arr.join('\n') : ''
}
