// Deploy 向导「command/args 文本 ↔ K8s string[]」切分约定的单一来源。纯函数,不引 Vue,可零依赖测试。
//
// 约定(与 K8s Dashboard/Rancher/Kuboard 一致):
//   command:shell token 语义——空白切分,但引号内不切(`sh -c` → ["sh","-c"],
//           `sh -c "echo hi"` → ["sh","-c","echo hi"]);exec 探针/生命周期钩子同此。
//   args  :每行一条——`cp /a /b` 单行 → 单条(含空格不拆散,保住 `sh -c "cp /a /b"` 习惯);多行 → 多条。
// 反例(本约定的由来):args 按空格切分会把 `sh -c` 的整段 shell 命令拆成多条,容器起不来。

// 文本 → command token 数组。空白分隔、去空项;单/双引号包裹的段落视为一个 token
// (引号内的 \" 转义为字面 ")。引号未闭合时余下全部并入当前 token(shell 同款宽容)。
export function splitCommandTokens(s) {
  if (!s) return []
  const str = String(s)
  const out = []
  let cur = ''
  let has = false        // 出现过非空白内容(含空引号 "")——避免把空 token 挤掉后误吞
  let q = null
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (q) {
      if (ch === '\\' && (str[i + 1] === q || str[i + 1] === '\\')) { cur += str[i + 1]; i++ }
      else if (ch === q) q = null
      else cur += ch
      has = true
    } else if (ch === '"' || ch === "'") {
      q = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) { out.push(cur); cur = ''; has = false }
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

// 文本 → args 数组。按行切分,行首尾去空白,跳过空行(单行即单条,行内空格原样保留)。
export function splitArgLines(s) {
  if (!s) return []
  return String(s).split('\n').map(l => l.trim()).filter(Boolean)
}

// K8s command 数组 → 表单文本。含空白/引号的 token 用双引号包裹并转义内部引号,
// 使 splitCommandTokens(joinCommandTokens(x)) 往返无损(常见 shell 写法)。
export function joinCommandTokens(arr) {
  if (!Array.isArray(arr)) return ''
  return arr.map(tok => {
    const t = String(tok)
    return /[\s"']/.test(t) ? '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : t
  }).join(' ')
}

// K8s args 数组 → 表单文本(每条一行;任何不含换行的 args 都能无损往返)。
export function joinArgLines(arr) {
  return Array.isArray(arr) ? arr.join('\n') : ''
}
