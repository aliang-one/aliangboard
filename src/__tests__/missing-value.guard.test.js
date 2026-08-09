// .value 守门的「反向」验证:证明检测器真能抓住 bug(不只会在干净代码上通过),
// 且不误报正确用法。再跑一次全仓扫描断言 0。
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { findMissingValue } from '../../scripts/check-missing-value.mjs'

const BUGGY = [
  ['computed 上数组方法', 'const list = computed(() => [])\nlist.filter(x => x)'],
  ['computed spread', 'const list = computed(() => [])\nfoo([...list])'],
  ['computed for-of', 'const list = computed(() => [])\nfor (const x of list) {}'],
  ['computed 裸 return', 'const crds = computed(() => [])\nfunction f() { return crds }'],
  ['computed .length', 'const list = computed(() => [])\nif (list.length) {}'],
  ['ref 上数组方法', 'const pods = ref([])\npods.map(p => p)'],
]
const CORRECT = [
  ['X.value.method', 'const list = computed(() => [])\nlist.value.filter(x => x)'],
  ['[...X.value]', 'const list = computed(() => [])\nfoo([...list.value])'],
  ['for-of X.value', 'const list = computed(() => [])\nfor (const x of list.value) {}'],
  ['属性访问 obj.X.method(非该 computed)', 'const wl = computed(() => ({}))\nwl.value.revisions.filter(r => r)'],
  ['注释行', 'const list = computed(() => [])\n// list.filter(x=>x)'],
  ['同名前缀的别的变量', 'const list = computed(() => [])\notherList.filter(x => x)'],
]

test('findMissingValue: 捕获全部已知 bug 模式', () => {
  for (const [label, src] of BUGGY) {
    const v = findMissingValue(src)
    expect(v.length, `「${label}」应被捕获,但没:\n${src}`).toBeGreaterThan(0)
  }
})

test('findMissingValue: 不误报正确用法', () => {
  for (const [label, src] of CORRECT) {
    const v = findMissingValue(src)
    expect(v.length, `「${label}」不应被报,但报了 ${JSON.stringify(v)}:\n${src}`).toBe(0)
  }
})

test('全仓扫描:无 computed/ref 漏 .value', () => {
  let code = 0, out = ''
  try { execFileSync('node', [resolve('scripts/check-missing-value.mjs'), '--quiet'], { encoding: 'utf8', stdio: 'pipe' }) }
  catch (e) { code = e.status ?? 1; out = (e.stdout || '') + (e.stderr || '') }
  expect(code, `全仓扫描发现漏 .value:\n${out}`).toBe(0)
})
