import { test, expect } from 'vitest'
import { isNearBottomCalc, NEAR_BOTTOM_PX } from '@/logic/chatScroll'
import { getDraft, setDraft } from '@/logic/chatDrafts'

test('isNearBottomCalc: 距底小于阈值 true,大于 false,恰好阈值 false', () => {
  expect(isNearBottomCalc(1000, 900, 100)).toBe(true)   // 0 距离
  expect(isNearBottomCalc(1000, 950, 100)).toBe(true)   // 50 < 100
  expect(isNearBottomCalc(1000, 800, 100)).toBe(false)  // 200 > 100
  expect(isNearBottomCalc(1000, 1000 - 100 - NEAR_BOTTOM_PX, 100)).toBe(false) // 恰好阈值
})

test('chatDrafts: 存/取/空删/隔离', () => {
  setDraft('a', 'hello')
  setDraft('new', 'draft for new')
  expect(getDraft('a')).toBe('hello')
  expect(getDraft('new')).toBe('draft for new')
  expect(getDraft('b')).toBe('')
  setDraft('a', '')   // 空值即删
  expect(getDraft('a')).toBe('')
  expect(getDraft('new')).toBe('draft for new', '互不影响')
})
