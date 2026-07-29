// 测试基线脚本（零外部依赖的极简运行器）
//
// 非目标禁止新增外部依赖，因此这里用一个极简的自包含测试运行器建立「测试基线」：
// 后续任务可直接在此文件追加用例（或新增 *.test.mjs 并 import），无需引入 vitest/jest。
// 用例选取贴近本仓库真实链路：
//   - Secret 数据的 base64 编解码（与 stores/cluster.js 的 encodeSecretData 行为一致）；
//   - apply 链路依赖的 YAML 往返（使用仓库已声明的 js-yaml 依赖，非新增）。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, err })
  }
}

// --- Secret 数据 base64 往返（Node 内置 Buffer，镜像 encodeSecretData） ---
test('Secret 数据 base64 编解码可无损往返', () => {
  const encode = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Buffer.from(String(v), 'utf8').toString('base64')]))
  const decode = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString('utf8')]))
  const original = { USERNAME: 'admin', PASSWORD: 'p@ss-w0rd', 多行: '行1\n行2' }
  assert.deepEqual(decode(encode(original)), original)
})

// --- YAML 往返（仓库已声明 js-yaml 依赖，覆盖 apply 链路核心） ---
test('js-yaml 可正确加载并回写 YAML（apply 链路核心依赖）', async () => {
  const mod = await import('js-yaml')
  const yaml = mod.default ?? mod
  const doc = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm-baseline' }, data: { key: 'value' } }
  const dumped = yaml.dump(doc)
  const loaded = yaml.load(dumped)
  assert.equal(loaded.kind, 'ConfigMap')
  assert.equal(loaded.metadata.name, 'cm-baseline')
  assert.equal(loaded.data.key, 'value')
})

// --- 仓库 package.json 可解析且含必备脚本（防止基线脚本被误删） ---
test('package.json 可解析且包含 build/typecheck/test 脚本', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts, 'package.json 应包含 scripts')
  for (const key of ['build', 'typecheck', 'test']) {
    assert.ok(typeof pkg.scripts[key] === 'string' && pkg.scripts[key].length, `缺少脚本: ${key}`)
  }
})

// --- K8s 资源量解析契约（镜像 stores/cluster.js 的 cpuToMilli/memToKi，锁定 metrics 解析行为）---
// 说明：测试运行器零依赖、无法 import 带 @/ 别名的 store，故按既有 base64 用例的惯例镜像逻辑作为契约。
// 若修改 store 中的解析器，请同步本镜像，使两处保持一致。
test('K8s 资源量解析：CPU→毫核、内存→Ki（覆盖各后缀与裸值）', () => {
  const cpuToMilli = q => {
    if (q == null || q === '') return 0
    const s = String(q).trim()
    if (s.endsWith('n')) return Math.round(Number(s.slice(0, -1)) / 1e6)
    if (s.endsWith('u')) return Math.round(Number(s.slice(0, -1)) / 1e3)
    if (s.endsWith('m')) return Number(s.slice(0, -1)) || 0
    const n = Number(s)
    return isNaN(n) ? 0 : n * 1000
  }
  const memToKi = q => {
    if (q == null || q === '') return 0
    const s = String(q).trim()
    const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/)
    if (!m) return 0
    const num = Number(m[1])
    const suf = m[2] || ''
    const mult = {
      Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, Pi: 1024 ** 4, Ei: 1024 ** 5,
      k: 1000 / 1024, M: 1e6 / 1024, G: 1e9 / 1024, T: 1e12 / 1024, P: 1e15 / 1024, E: 1e18 / 1024,
    }
    return Math.round(num * (suf ? (mult[suf] ?? 1) : 1 / 1024))
  }
  // CPU：毫核 / 核 / 纳核（metrics-server 常返回纳核）/ 微核 / 空值
  assert.equal(cpuToMilli('500m'), 500)
  assert.equal(cpuToMilli('2'), 2000)
  assert.equal(cpuToMilli('868940n'), 1)      // 纳核 → 0.87m，四舍五入为 1m
  assert.equal(cpuToMilli('750u'), 1)         // 微核 → 0.75m，四舍五入为 1m
  assert.equal(cpuToMilli(''), 0)
  assert.equal(cpuToMilli(null), 0)
  // 内存：二进制后缀 / 裸字节
  assert.equal(memToKi('512Mi'), 524288)
  assert.equal(memToKi('1Gi'), 1048576)
  assert.equal(memToKi('1024Ki'), 1024)
  assert.equal(memToKi('1048576'), 1024)      // 无后缀视为裸字节
  assert.equal(memToKi(''), 0)
})

// --- 汇总 ---
const failed = results.filter(r => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}`)
}
if (failed.length) {
  console.error(`\n[test] ✗ ${failed.length}/${results.length} 用例失败：`)
  for (const r of failed) console.error('    -', r.name, '\n', r.err && r.err.stack ? r.err.stack : r.err)
  process.exit(1)
}
console.log(`\n[test] ✓ ${results.length} 用例全部通过。`)
