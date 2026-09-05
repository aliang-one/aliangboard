import { test, expect } from 'vitest'
import { squareCrop } from '@/utils/avatarImage'

test('squareCrop:横图/竖图/方图中心裁剪', () => {
  expect(squareCrop(800, 400)).toEqual({ sx: 200, sy: 0, s: 400 })
  expect(squareCrop(400, 800)).toEqual({ sx: 0, sy: 200, s: 400 })
  expect(squareCrop(400, 400)).toEqual({ sx: 0, sy: 0, s: 400 })
})
