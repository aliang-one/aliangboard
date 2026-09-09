// 手机适配静态守卫(M1/M2)—— 2026-09-09 Wave5(W3+W4+W5)T0「守卫先行」。
// 目标机型 390px 视口(内容宽约 326px):两类静态可判定的横向溢出源头。
//
// M1 裸表须可滚:文件含 `<table` 且全文件无 `overflow-x-auto` 且未 import DataTable → 违规。
//    裸表列 min-content(长 DNS 名/mono 串)轻易超 326px,外层卡片 overflow-hidden 硬裁=手机不可达。
//    安全出路:①迁 `@/components/common/DataTable`(手机卡片模式内建);②语义特殊表保底:
//    外层 `overflow-x-auto` + 表 `min-w-[600px]` + 单元格 truncate(见 NsNetworkPolicyDetail 配方)。
//    DataTable.vue 自身内建 `<table`,是唯一豁免文件(不走 allowlist)。
//
// M2 固定宽阈值:任意值宽类 `w-[Npx]`/`max-w-[Npx]` 且 N≥640 → 违规;min(...) 响应式上限是
//    唯一逃生口(如 `w-[min(720px,calc(100vw-2rem))]`:上限 720 但随视口收缩)。判定不解析 class
//    属性,取匹配点 ±120 字符窗口内有 `min(` 即放行(同 class 串近似)。
//
// 两规则各带 allowlist,种子=2026-09-09 全仓扫描存量违规(逐条注释 what/why)。
// 政策:allowlist 只减不增,每修复批次删自己文件的条目,W5 收口清零(或留带裁决注释的豁免);
// 新文件/新违规一律红灯。误报时优先改模板对齐配方,勿为过测试加豁免。
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

// ── M1 判定(纯函数)──
const M1_DT_IMPORT = "@/components/common/DataTable"
function m1Violations(src) {
  if (!src.includes('<table')) return []
  if (src.includes('overflow-x-auto')) return []
  if (src.includes(M1_DT_IMPORT)) return []
  // 命中行摘录(首处,截 60 字符)供报错定位
  const m = src.match(/<table[^\n]*/)
  return [m[0].trim().slice(0, 60)]
}

// ── M2 判定(纯函数)──
// (?<![\w-]) 排除 min-w-[Npx](min-width 是下限不是固定宽,保底配方的 min-w-[600px] 不在射程)
const M2_WIDTH_RE = /(?<![\w-])(?:max-)?w-\[(\d+)px\]/g
const M2_MIN_WINDOW = 120
function m2Violations(src) {
  const out = []
  for (const m of src.matchAll(M2_WIDTH_RE)) {
    if (Number(m[1]) < 640) continue
    const start = Math.max(0, m.index - M2_MIN_WINDOW)
    const end = Math.min(src.length, m.index + m[0].length + M2_MIN_WINDOW)
    if (!src.slice(start, end).includes('min(')) out.push(m[0])
  }
  return out
}

// ── 规则语义自检(钉住阈值与逃生口,防未来误松)──
test('M1/M2 规则语义自检(阈值/逃生口/排除项)', () => {
  // M1:三条件各自放行
  assert.deepEqual(m1Violations('<template><table class="w-full"><tr><td>x</td></tr></table></template>'),
    ['<table class="w-full"><tr><td>x</td></tr></table></template>'.slice(0, 60)])
  assert.deepEqual(m1Violations('<div class="overflow-x-auto"><table>x</table></div>'), [])
  assert.deepEqual(m1Violations(`import DataTable from '@/components/common/DataTable.vue'\n<table>x</table>`), [])
  assert.deepEqual(m1Violations('<template><div>no table here</div></template>'), [])
  // M2:阈值 640、前缀 max-w、逃生口 min(、排除 min-w-
  assert.deepEqual(m2Violations('w-[860px]'), ['w-[860px]'])
  assert.deepEqual(m2Violations('max-w-[720px]'), ['max-w-[720px]'])
  assert.deepEqual(m2Violations('max-w-[400px]'), []) // 400 < 640
  assert.deepEqual(m2Violations('w-[min(860px,calc(100vw-2rem))]'), []) // min( 上限
  assert.deepEqual(m2Violations('min-w-[600px]'), []) // min-width 不在射程
  assert.deepEqual(m2Violations('sm:w-[640px]'), ['w-[640px]']) // 响应式前缀不豁免(按裁决,断点内仍须 min( 形态)
  // ±120 字符窗口:近距 min( 放行、远距不豁免
  assert.deepEqual(m2Violations('class="w-[720px]" style="width: min(720px, 100vw)"'), [])
  assert.deepEqual(m2Violations('w-[720px]' + 'x'.repeat(200) + 'min('), ['w-[720px]'])
})

// ── M1:裸表存量违规 allowlist(种子 2026-09-09,12 条;修复批次清账后删除条目)──
// B2 已清账(2026-09-09):NsRoleDetail/NsRoleBindingDetail/NsServiceAccountDetail 四表迁 DataTable,条目删除。
// B3 已清账(2026-09-09):NsNetworkPolicyDetail rules/peers 表×2 + NsServiceDetail ports 表走保底(overflow-x-auto + min-w-[600px] + truncate),条目删除。
// B4 已清账(2026-09-09):NsHPADetail metrics 裸表 6 列迁 DataTable(row-key=_idx),条目删除。
// B5 已清账(2026-09-09):CrdDetail instances 表(P0,expandable DataTable)/ResourceReferences 五列表/NamespaceDetail
// workloads 表迁 DataTable;WorkloadDetail legacy Pod 表/NodeDetail conditions 表走保底(overflow-x-auto + min-w + truncate),条目删除。
const M1_ALLOWLIST = [
  'components/common/CopyWorkloadDialog.vue', // 选择工作负载弹窗裸表;外层是 overflow-auto(max-h 卡)非 overflow-x-auto 字面量 → 按字面规则计违规,后续对齐配方(overflow-x-auto)或带裁决豁免
]

test('M1: 裸 <table> 须可滚(overflow-x-auto 或迁 DataTable),存量见 allowlist', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    if (f.endsWith('components/common/DataTable.vue')) continue // 守卫对象外:DataTable 自身合法内建 <table
    if (M1_ALLOWLIST.some(a => f.endsWith(a))) continue
    const hits = m1Violations(readFileSync(f, 'utf8'))
    if (hits.length) offenders.push(`${f}: ${hits[0]}`)
  }
  assert.deepEqual(offenders, [],
    '发现裸 <table> 无横滚且未迁 DataTable(手机上列内容被卡片 overflow-hidden 硬裁,修法见 scripts/mobile-guard.test.mjs 头注 M1)')
})

// ── M2:固定宽存量违规 allowlist ──
// 种子为空:2026-09-09 T0 全仓扫描 207 个 .vue,≥640px 固定宽已被 W1+W2 清零
// (WorkbenchServers/NsWorkloadDetail 等均已 w-[min(...)] 形态,PortSelect w-[460px] 等最大值均 < 640)。
// 此名单保持为空:新违规当批修复,不留存量。
const M2_ALLOWLIST = [
  // (空——W5 收口核验 allowlist 清零时,本数组应仍为空或仅剩带裁决注释的豁免)
]

test('M2: w-[Npx]/max-w-[Npx] ≥640px 固定宽须带 min(...) 响应式上限(390px 视口零横向溢出)', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    if (M2_ALLOWLIST.some(a => f.endsWith(a))) continue
    const hits = m2Violations(readFileSync(f, 'utf8'))
    if (hits.length) offenders.push(`${f}: ${hits.join(' ')}`)
  }
  assert.deepEqual(offenders, [],
    '发现 ≥640px 固定宽类(390px 视口必然横向溢出),改 w-[min(Npx,calc(100vw-2rem))] 形态(修法见 scripts/mobile-guard.test.mjs 头注 M2)')
})
