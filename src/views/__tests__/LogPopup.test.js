// src/views/__tests__/LogPopup.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { i18n } from '@/i18n'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      k8s: vi.fn(async () => ({
        spec: {
          containers: [{ name: 'main' }, { name: 'sidecar' }],
          initContainers: [{ name: 'init-db' }],
          ephemeralContainers: [{ name: 'debugger' }],
        },
      })),
    },
  }
})

import LogPopup from '@/views/LogPopup.vue'

// LogViewerBody 桩：捕获 props，避免其内部 composable 发请求
const bodyProps = []
const BodyStub = defineComponent({
  props: ['namespace', 'podName', 'containers', 'container'],
  template: '<div data-testid="log-viewer-stub">{{ containers.join(",") }}</div>',
  mounted() { bodyProps.push({ ns: this.namespace, pod: this.podName, containers: [...this.containers] }) },
})

async function mountPopup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/log-popup', name: 'LogPopup', component: LogPopup }] })
  router.push('/log-popup?ns=default&pod=pod-1&container=main')
  await router.isReady()
  return mount(LogPopup, {
    global: { plugins: [createPinia(), i18n, router], stubs: { LogViewerBody: BodyStub } },
  })
}

test('从 URL 读 ns/pod/container，拉 pod spec 组全量容器列表（含 init/ephemeral）传给 LogViewerBody', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const w = await mountPopup()
  await new Promise(r => setTimeout(r, 0))   // 等 onMounted 的 api.k8s
  const { api } = await import('@/api/client')
  expect(api.k8s).toHaveBeenCalledWith('/api/v1/namespaces/default/pods/pod-1')
  expect(w.find('[data-testid="log-viewer-stub"]').text()).toBe('main,sidecar,init-db,debugger')
})

test('容器列表拉取失败：回退为 URL 单容器，页面不崩', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const { api } = await import('@/api/client')
  api.k8s.mockRejectedValueOnce(new Error('404'))
  const w = await mountPopup()
  await new Promise(r => setTimeout(r, 0))
  expect(w.find('[data-testid="log-viewer-stub"]').text()).toBe('main')
})
