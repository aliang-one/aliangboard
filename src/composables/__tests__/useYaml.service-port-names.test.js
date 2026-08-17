// ensureServicePortNames 单元测试(useYaml.js 单一事实源):
//   Service 多端口补名规则的边界行为——store generateYAML 与 DeployApp 向导共用,
//   这里直接钉住 helper 契约,防止任一调用方绕过或改坏语义。
import { test, expect } from 'vitest'
import { ensureServicePortNames } from '../useYaml'

const P = (name, port) => ({ name, port, targetPort: port, protocol: 'TCP' })

test('返回全新数组/对象:不改动调用方 portList(防缓存污染)', () => {
  const src = [P('', 80), P('', 8080)]
  const out = ensureServicePortNames(src)
  expect(out).not.toBe(src)
  expect(out[0]).not.toBe(src[0])
  expect(src[0].name).toBe('') // 原对象保持空名
  expect(out.map(p => p.name)).toEqual(['port-80', 'port-8080'])
})

test('单端口/空数组/非数组:原样返回(不补名)', () => {
  const single = [P('', 80)]
  expect(ensureServicePortNames(single)).toBe(single)
  expect(ensureServicePortNames([])).toEqual([])
  expect(ensureServicePortNames(null)).toBe(null)
})

test('已有 name 的端口对象原样引用(不克隆不改写)', () => {
  const named = P('http', 80)
  const out = ensureServicePortNames([named, P('', 8080)])
  expect(out[0]).toBe(named)
})
