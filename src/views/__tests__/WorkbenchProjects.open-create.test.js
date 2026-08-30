// src/views/__tests__/WorkbenchProjects.open-create.test.js
// openCreate prop(顶栏胶囊快捷区「新建项目」):true 时 Modal 直接开,默认关。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'

vi.mock('@/api/client', () => ({
  workbenchApi: { listProjects: vi.fn().mockResolvedValue({ projects: [] }), createProject: vi.fn(), updateProjectCluster: vi.fn() },
  authApi: { myClusters: vi.fn().mockResolvedValue([]) },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
const mountProjects = props => mount(WorkbenchProjects, { props, global: { plugins: [createPinia(), i18n] } })

test('openCreate=true:创建弹窗直接打开(Teleport 到 body)', async () => {
  const w = mountProjects({ openCreate: true })
  await w.vm.$nextTick()
  expect(document.body.querySelector('input[placeholder="my-project"]')).toBeTruthy()
  w.unmount() // Teleport 到 body 的 Modal 不卸载会泄漏进下一用例(happy-dom 不自动清理)
})
test('默认(false):弹窗不开', async () => {
  const w = mountProjects()
  await w.vm.$nextTick()
  expect(document.body.querySelector('input[placeholder="my-project"]')).toBeFalsy()
})
