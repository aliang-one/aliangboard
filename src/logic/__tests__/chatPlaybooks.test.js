import { test, expect } from 'vitest'
import { SLASH_ACTIONS, PLAYBOOKS, filterSlashItems } from '../chatPlaybooks'

test('PLAYBOOKS:10 个剧本,id 唯一,键完整', () => {
  expect(PLAYBOOKS).toHaveLength(10)
  expect(new Set(PLAYBOOKS.map(p => p.id)).size).toBe(10)
  for (const p of PLAYBOOKS) expect([p.nameKey, p.descKey, p.bodyKey].every(k => typeof k === 'string' && k.length > 0)).toBe(true)
})

test('SLASH_ACTIONS:compact 动作,enabled 谓词随 canCompact', () => {
  expect(SLASH_ACTIONS.map(a => a.id)).toEqual(['compact'])
  expect(SLASH_ACTIONS[0].enabled({ canCompact: true })).toBe(true)
  expect(SLASH_ACTIONS[0].enabled({ canCompact: false })).toBe(false)
})

test('filterSlashItems:空 query 动作在前全量;子串过滤;大小写不敏感', () => {
  const all = filterSlashItems('')
  expect(all[0].id).toBe('compact')
  expect(all).toHaveLength(11)
  expect(filterSlashItems('image').map(i => i.id)).toEqual(['imagepull'])
  expect(filterSlashItems('IMAGEPULL').map(i => i.id)).toEqual(['imagepull'])
  expect(filterSlashItems('zzz')).toEqual([])
})
