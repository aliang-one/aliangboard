import { test, expect } from 'vitest'
import { useCopySeed } from '../useCopySeed'

test('useCopySeed: set → consume 返回值并清空', () => {
  const { setSeed, consumeSeed, hasSeed } = useCopySeed()
  consumeSeed() // 清理可能的残留
  expect(hasSeed()).toBe(false)
  setSeed({ form: { name: 'x' }, type: 'Deployment', source: 'default/x' })
  expect(hasSeed()).toBe(true)
  const s = consumeSeed()
  expect(s.form.name).toBe('x')
  expect(s.type).toBe('Deployment')
  expect(consumeSeed()).toBeNull()
  expect(hasSeed()).toBe(false)
})
