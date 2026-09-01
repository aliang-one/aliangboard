// 手机档视口 mock 共享 helper(2026-09-01 手机适配 Wave 2):收敛 1b 期间 5 份本地拷贝。
// 用法:const spy = mockViewport(true) … spy.mockRestore()(或文件级 afterEach(vi.restoreAllMocks))。
import { vi } from 'vitest'

export function mockViewport(belowSm) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
