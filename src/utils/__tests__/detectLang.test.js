import { test, expect } from 'vitest'
import { detectLang, lineCount } from '../detectLang.js'

test('detectLang 按扩展名识别', () => {
  expect(detectLang('app.yml').prismLang).toBe('yaml')
  expect(detectLang('conf.json').label).toBe('JSON')
  expect(detectLang('tls.crt').label).toBe('CERT')
  expect(detectLang('plain').prismLang).toBe('none')
  expect(detectLang('run.sh').icon).toBe('terminal')
})
test('lineCount 空值/多行', () => {
  expect(lineCount('')).toBe(0)
  expect(lineCount('a\nb\nc')).toBe(3)
})
