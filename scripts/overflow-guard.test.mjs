// 组件文本溢出守卫 —— truncate 失效形态静态扫描(零依赖)
// 2026-09-01 顶栏 cluster/ns chip 溢出事故(URL 形集群名穿透 UI)固化的防线。
// 规则全部经真浏览器实测校准(Chromium getBoundingClientRect 矩阵),两条失效形态:
//
// V1 列向:truncate 元素的父是 `flex flex-col` + `items-start`。
//    列向交叉轴按 fit-content 定宽,white-space:nowrap 使 min-content=max-content=全文宽,
//    fit-content 不受父 max-w 钳制 → 元素比父宽,truncate(overflow:hidden)在自身边界裁剪=没裁。
//    安全出路:span 自带 w-full(宽度=父内容宽)或自带 max-w-*/w-[..](fit-content 被自身钳制)。
//
// V2 行向:truncate 元素上方隔着「行向 flex 子项」(自身无 overflow 收敛、无 min-w-0、无 max-w/w 有界)。
//    overflow:hidden 只有直接长在 flex 子项上才把它的 min-width:auto 归零;隔一层时
//    min-content(全文宽)沿中间子项向上传导,中间子项 min-width:auto 拒缩 → 整链撑破。
//    安全出路:中间 flex 子项加 min-w-0,或把 truncate 直挂到 flex 子项上,或给中间子项 max-w 有界。
//
// 新组件写 truncate 请按上述配方;误报时优先改模板对齐配方,勿为过测试加豁免。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.vue')) out.push(p)
  }
  return out
}

// 极简标签栈解析:只关心开/闭/自闭合标签的 tag 与静态 class。
// slot/template 是编译期构造、不产生 DOM 元素,跳过(否则会算出假父级)。
function tokenize(tpl, lineOffset = 0) {
  const out = []
  const re = /<(\/?)([\w-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m
  while ((m = re.exec(tpl))) {
    const line = lineOffset + tpl.slice(0, m.index).split('\n').length
    const [, close, tag, attrs] = m
    if (/^(slot|template)$/.test(tag)) continue
    // 静态 class 优先;动态 :class 中无 truncate 用法(见文件头说明),不解析表达式
    const cls = (attrs.match(/\sclass="([^"]*)"/) || [])[1] || ''
    if (close) out.push({ type: 'close', tag, cls, line })
    else if (/\/\s*$/.test(attrs)) out.push({ type: 'selfclose', tag, cls, line })
    else out.push({ type: 'open', tag, cls, line })
  }
  return out
}

const hasFlex = c => /(^|\s)(inline-)?flex(\s|$)/.test(c) // 严格等值:flex-1/flex-col 等修饰不算 flex 容器
const has = (c, k) => new RegExp(`\\b${k}\\b`).test(c)
const clipped = c => has(c, 'truncate') || has(c, 'overflow-hidden')
const bounded = c => /\bmax-w(-\S+)?\b/.test(c) || /\bw-\[/.test(c) || /\bw-full\b/.test(c)

function auditFile(file) {
  const src = readFileSync(file, 'utf8')
  const t = src.match(/<template>([\s\S]*)<\/template>/)
  if (!t) return []
  // 行号换算成文件绝对行号(SFC 根 <template> 前的行数偏移)
  const lineOffset = src.slice(0, t.index).split('\n').length - 1
  const findings = []
  const stack = []
  for (const tk of tokenize(t[1], lineOffset)) {
    if (tk.type === 'open') {
      if (has(tk.cls, 'truncate')) {
        const selfSafe = bounded(tk.cls)
        const parent = stack[stack.length - 1]
        // V1:列向 items-start 且 span 无自宽/自钳
        if (parent && hasFlex(parent.cls) && has(parent.cls, 'flex-col') && has(parent.cls, 'items-start')
          && !selfSafe) {
          findings.push({ rule: 'V1', line: tk.line, self: tk.cls,
            detail: `父级 [${parent.cls}] 为 flex-col+items-start;truncate 元素须自带 w-full 或 max-w-*` })
        }
        // V2:行向链上存在无收敛/无 min-w-0/无有界的 flex 子项
        if (!selfSafe) for (let i = stack.length - 1; i >= 0; i--) {
          const P = stack[i]
          if (clipped(P.cls)) break // 链上有收敛元素,截断传导
          const gp = stack[i - 1]
          if (!gp || !hasFlex(gp.cls)) break // P 非 flex 子项 → block 边界,受包含块约束
          if (has(gp.cls, 'flex-col')) break // 列向父由 V1 管
          if (has(P.cls, 'min-w-0') || has(P.cls, 'w-0') || bounded(P.cls)) break
          findings.push({ rule: 'V2', line: tk.line, self: tk.cls,
            detail: `中间 flex 子项 [${P.cls}] 缺 min-w-0(或收敛/有界),min-content 沿链传导撑破容器` })
          break
        }
      }
      stack.push(tk)
    } else if (tk.type === 'close') {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tk.tag) { stack.splice(i, 1); break }
    }
  }
  return findings
}

test('全仓 .vue 无 truncate 失效形态(V1 列向 + V2 行向链)', () => {
  const findings = walk(SRC).flatMap(f => auditFile(f).map(x => ({ ...x, file: f.slice(SRC.length + 1) })))
  assert.equal(
    findings.length, 0,
    '发现 truncate 失效形态(溢出会穿透 UI,修法见 scripts/overflow-guard.test.mjs 头注):\n'
    + findings.map(f => `  [${f.rule}] src/${f.file}:${f.line}\n    element: ${f.self}\n    ${f.detail}`).join('\n')
  )
})

// ── V3:裸 z-index 任意值魔数禁令(2026-09-01 手机适配 Wave 1a)──
// 浮层层级唯一来源是 zScale.js 的 Z;`z-[N]` 任意值类绕过单源,是 issue#3 糊化事故的
// 同族根因。既有违规入 allowlist(后续波次逐个清零后从名单移除);新文件一律红灯。
const Z_ARBITRARY_ALLOWLIST = [
  'components/workbench/ChatPresence.vue' // Task 6 Step 1 盘点结果: z-[45] at line 84 // TODO: ChatPresence.vue z-[45] 清零后移出名单,删整个 allowlist
]

test('V3: .vue 禁止 z-[N] 任意值魔数(层级一律 zScale 取值)', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    if (Z_ARBITRARY_ALLOWLIST.some(a => f.endsWith(a))) continue
    const src = readFileSync(f, 'utf8')
    const m = src.match(/z-\[\d+\]/)
    if (m) offenders.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [])
})

// ── V4:hover 动作常显守卫(2026-09-01 手机适配 Wave 1b,spec §4)──
// 触屏无 hover:`opacity-0` + `group-hover:opacity-100` 的动作在手机上永不可见。
// 规则:同元素 class 同时含两者时,必须配对 `max-sm:opacity-100`(手机档常显);含命名 group 变体(group-hover/turn: 等)。
test('V4: hover 显隐动作必须配 max-sm:opacity-100(手机常显)', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const cls = m[1]
      if (cls.includes('opacity-0') && /group-hover(?:\/[\w-]+)?:opacity-100/.test(cls) && !cls.includes('max-sm:opacity-100')) {
        offenders.push(`${f}: ${cls.slice(0, 80)}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
