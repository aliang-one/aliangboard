import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ContainerEnvEditor from '../common/ContainerEnvEditor.vue'

const mountIt = (env = [], envFrom = []) => mount(ContainerEnvEditor, {
  props: { env, envFrom, namespace: 'ns1', size: 'md' },
  global: { plugins: [i18n], stubs: { EnvSourceField: { template: '<div class="esf-stub" />' } } },
})

describe('ContainerEnvEditor', () => {
  it('加行:默认直填行入列并可删', async () => {
    const w = mountIt()
    await w.find('[data-testid="ceed-add-env"]').trigger('click')
    expect(w.props('env')).toHaveLength(1)
    expect(w.props('env')[0].type).toBe('value')
    await w.find('[data-testid="ceed-del-env-0"]').trigger('click')
    expect(w.props('env')).toHaveLength(0)
  })

  it('切类型:保留 name、其余字段重置为新类型形状', async () => {
    const env = [{ name: 'DB', type: 'value', value: 'x', passthrough: undefined }]
    const w = mountIt(env)
    await w.find('[data-testid="ceed-type-0"]').setValue('secretKeyRef')
    expect(w.props('env')[0].name).toBe('DB')
    expect(w.props('env')[0].type).toBe('secretKeyRef')
    expect(w.props('env')[0].secretName).toBe('')
    expect(w.props('env')[0].value).toBeUndefined()
  })

  it('CM/Secret 行渲染 EnvSourceField(kind 正确)', async () => {
    const env = [
      { name: 'A', type: 'configMapKeyRef', cmName: 'cm', key: 'k' },
      { name: 'B', type: 'secretKeyRef', secretName: 's', key: 'k' },
    ]
    const w = mountIt(env)
    const stubs = w.findAll('.esf-stub')
    expect(stubs.length).toBeGreaterThanOrEqual(2)
  })

  it('envFrom:加行默认 configmap,可切 secret,可删', async () => {
    const w = mountIt()
    await w.find('[data-testid="ceed-add-from"]').trigger('click')
    expect(w.props('envFrom')[0].kind).toBe('configmap')
    await w.find('[data-testid="ceed-from-kind-0"]').setValue('secret')
    expect(w.props('envFrom')[0].kind).toBe('secret')
    await w.find('[data-testid="ceed-del-from-0"]').trigger('click')
    expect(w.props('envFrom')).toHaveLength(0)
  })

  it('fieldRef/resourceFieldRef 行渲染对应输入', async () => {
    const env = [
      { name: 'P', type: 'fieldRef', fieldPath: 'metadata.name' },
      { name: 'R', type: 'resourceFieldRef', resource: 'requests.cpu', containerName: '', divisor: '' },
    ]
    const w = mountIt(env)
    expect(w.find('[data-testid="ceed-fieldpath-0"]').exists()).toBe(true)
    expect(w.find('[data-testid="ceed-resref-resource-1"]').exists()).toBe(true)
  })
})
