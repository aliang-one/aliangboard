// src/components/__tests__/IngressRulesEditor.test.js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import PortSelect from '@/components/common/PortSelect.vue'

const SVCS = [
  { name: 'web', ports: ['80', '8080'] },
  { name: 'app-svc', ports: ['80'], label: 'app-svc (this wizard)' },
]

function mountEditor(props = {}) {
  return mount(IngressRulesEditor, {
    props: { modelValue: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [
      { path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '80' },
      { path: '/admin', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' },
    ] }], services: SVCS, ...props },
    global: { plugins: [i18n] },
  })
}

test('渲染 host 卡片与每 path 行', () => {
  const w = mountEditor()
  const inputs = w.findAll('input')
  expect(inputs[0].element.value).toBe('a.com')   // defaultBackend 关闭时 host 输入在 DOM 最前
  const pathVals = inputs.map(i => i.element.value).filter(v => v.startsWith('/'))
  expect(pathVals).toEqual(['/api', '/admin'])
})

test('addPath:emit update:modelValue,新增 path 预填 defaultServiceName', async () => {
  const w = mountEditor({ defaultServiceName: 'app-svc' })
  const addPathBtn = w.findAll('button').find(b => b.text().includes(i18n.global.t('ns.ingressDetail.addPath')))
  await addPathBtn.trigger('click')
  const emitted = w.emitted('update:modelValue')
  expect(emitted).toBeTruthy()
  const hosts = emitted.at(-1)[0]
  expect(hosts[0].paths.length).toBe(3)
  expect(hosts[0].paths[2].serviceName).toBe('app-svc')
})

test('service→port 候选联动:PortSelect 收到选中 service 的 ports', () => {
  const w = mountEditor()
  const portSelects = w.findAllComponents(PortSelect)   // 按组件引用匹配(script-setup 无显式 name)
  expect(portSelects.length).toBe(4)                    // 2 paths × 2 PortSelect each (serviceName + servicePort)
  expect(portSelects[1].props('options')).toEqual(['80', '8080'])   // 第一行的 servicePort 候选 = web 的 ports
})

test('validation:serviceName 缺失时 emit 校验错误', async () => {
  const w = mountEditor({ modelValue: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [
    { path: '/api', pathType: 'Prefix', serviceName: '', servicePort: '80' },
  ] }] })
  await nextTick()
  const v = w.emitted('validation')
  expect(v).toBeTruthy()
  expect(v.at(-1)[0].some(e => e.field === 'serviceName' && e.loc === 'host[0].path[0]')).toBe(true)
})

test('validation:零 path 的 host 触发 host 级 path 必填错误(③④创建/保存按钮被拦)', async () => {
  const w = mountEditor({ modelValue: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [] }] })
  await nextTick()
  const v = w.emitted('validation')
  expect(v).toBeTruthy()
  expect(v.at(-1)[0].some(e => e.field === 'path' && e.loc === 'host[0]' && e.msg === i18n.global.t('ns.ingressDetail.valPathRequired'))).toBe(true)
})

test('withTls/withDefaultBackend 关闭时不渲染对应区块', () => {
  const w = mountEditor()
  expect(w.findAll('input[type=checkbox]').length).toBe(0)   // TLS 行与 defaultBackend 卡片都未开 → 无 checkbox
  expect(w.text()).not.toContain('spec.defaultBackend')
})
