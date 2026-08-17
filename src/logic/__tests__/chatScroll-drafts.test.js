import { test, expect, vi } from 'vitest'
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

// H(2026-08-17 审计):草稿曾为纯内存 Map,刷新整页即丢(旧注释谎称"刷新不丢")。
// 现以 localStorage 持久(aliangboard.chat.drafts);vi.resetModules 模拟"整页刷新"。
test('草稿持久化:模块重载(=页面刷新)后草稿仍在', async () => {
  localStorage.clear()
  setDraft('conv-keep', '打了一半的长问题')
  expect(localStorage.getItem('aliangboard.chat.drafts')).toContain('打了一半的长问题')
  vi.resetModules()
  const fresh = await import('../chatDrafts')
  expect(fresh.getDraft('conv-keep')).toBe('打了一半的长问题')
  fresh.setDraft('conv-keep', '') // 空值即删,同步落盘
  expect(localStorage.getItem('aliangboard.chat.drafts')).not.toContain('打了一半的长问题')
})
