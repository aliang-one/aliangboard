// src/components/common/__tests__/IngressRulesEditor.test.js
// issue #3 TLS Secret 下拉:纯手输 → PortSelect(可下拉可手输+空态提示)。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import PortSelect from '@/components/common/PortSelect.vue'

const HOSTS_ON = [{ host: 'a.example.com', tls: true, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }] }]

function mountEd(props = {}) {
  return mount(IngressRulesEditor, {
    props: { modelValue: HOSTS_ON, services: [{ name: 'svc', ports: [80] }], withTls: true, secrets: ['tls-a', 'tls-b'], ...props },
    global: { plugins: [i18n] },
  })
}

test('TLS Secret 行 = PortSelect:options=secrets prop,空态提示可配', () => {
  const w = mountEd()
  const ps = w.findAllComponents(PortSelect)
    .find(c => c.props('placeholder') === i18n.global.t('ns.ingressDetail.tlsRowSecretPlaceholder'))
  expect(ps).toBeTruthy()
  expect(ps.props('options')).toEqual(['tls-a', 'tls-b'])
  expect(ps.props('emptyHint')).toBe(i18n.global.t('ns.ingressDetail.noTlsSecretsHint'))
})

test('secrets 为空数组也渲染 PortSelect(空态提示由组件呈现)', () => {
  const w = mountEd({ secrets: [] })
  const ps = w.findAllComponents(PortSelect)
    .find(c => c.props('placeholder') === i18n.global.t('ns.ingressDetail.tlsRowSecretPlaceholder'))
  expect(ps.exists()).toBe(true)
  expect(ps.props('options')).toEqual([])
})

test('tls 勾选关闭时无 TLS PortSelect(仅 serviceName/servicePort 两个)', () => {
  const w = mountEd({ modelValue: [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }] }] })
  expect(w.findAllComponents(PortSelect).length).toBe(2)
})
