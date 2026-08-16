import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import IngressPerfField from '../IngressPerfField.vue'

const mountFld = (fld, modelValue = '') => mount(IngressPerfField, {
  props: { fld, modelValue },
  global: { plugins: [i18n] },
})

describe('IngressPerfField: size(数字+单位下拉)', () => {
  const fld = { key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k', vt: 'size' }
  it('渲染 number 输入 + 单位 select(placeholder 保留)', () => {
    const w = mountFld(fld)
    expect(w.find('input[type="number"]').exists()).toBe(true)
    const units = w.findAll('select option').map(o => o.element.value)
    expect(units).toEqual(['k', 'm', 'g'])
    expect(w.find('input').attributes('placeholder')).toBe('4k')
  })
  it('回显拆合:10m → 10 + m;改 4+k → emit "4k"', async () => {
    const w = mountFld(fld, '10m')
    expect(w.find('input[type="number"]').element.value).toBe('10')
    expect(w.find('select').element.value).toBe('m')
    await w.find('input[type="number"]').setValue('4')
    await w.find('select').setValue('k')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('4k')
  })
  it('外部重填:8m → 8 + m(编辑回显)', async () => {
    const w = mountFld(fld, '10m')
    await w.setProps({ modelValue: '8m' })
    expect(w.find('input[type="number"]').element.value).toBe('8')
    expect(w.find('select').element.value).toBe('m')
  })
  it('旧值无单位(裸数字 100)→ 数字保留,单位取默认 m', () => {
    const w = mountFld(fld, '100')
    expect(w.find('input[type="number"]').element.value).toBe('100')
    expect(w.find('select').element.value).toBe('m')
  })
  it('per-field units 收窄(buffer-size 实字段:k/m,无 g)+ 字段级 hint', () => {
    const w = mountFld({ key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k', vt: 'size', min: 1, units: ['k', 'm'], max: 1073741824, hintKey: 'ingressPerf.hintBufferSize' })
    expect(w.findAll('select option').map(o => o.element.value)).toEqual(['k', 'm'])
    expect(w.text()).toContain('1GiB')
  })
  it('空值 mount + 输入 4 → emit "4m"(默认单位兜底),单位下拉显示 m', async () => {
    const w = mountFld(fld)
    await w.find('input[type="number"]').setValue('4')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('4m')
    expect(w.find('select').element.value).toBe('m')
  })
})

describe('IngressPerfField: int(数字框+只读单位后缀)', () => {
  it('unitKey → 渲染后缀 span(秒);emit 纯数字', async () => {
    const fld = { key: 'proxy-send-timeout', labelKey: 'ingressPerf.sendTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' }
    const w = mountFld(fld, '3600')
    expect(w.find('span').text()).toBe('秒')
    expect(w.find('input[type="number"]').element.value).toBe('3600')
    await w.find('input[type="number"]').setValue('60')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('60')
  })
  it('min/max 透传(compression-level 1-9)', () => {
    const fld = { key: 'compression-level', labelKey: 'ingressPerf.compressionLevel', ph: '5', vt: 'int', min: 1, max: 9 }
    const w = mountFld(fld)
    expect(w.find('input[type="number"]').attributes('min')).toBe('1')
    expect(w.find('input[type="number"]').attributes('max')).toBe('9')
  })
  it('unitKey 但译文为空时不渲染 span(直角输入框)', () => {
    const { locale } = i18n.global
    const oldLocale = locale.value
    locale.value = 'en'
    const fld = { key: 'worker-count', labelKey: 'ingressPerf.workerCount', ph: '4', vt: 'int', unitKey: 'ingressPerf.unitCount' }
    const w = mountFld(fld)
    expect(w.find('span').exists()).toBe(false)
    expect(w.find('input').classes()).not.toContain('rounded-r-none')
    locale.value = oldLocale
  })
})

describe('IngressPerfField: hpxTime / csvInt / options / area', () => {
  it('hpxTime: 50s → 50 + s;emit 带', async () => {
    const w = mountFld({ key: 'timeout-server', labelKey: 'ingressPerf.hpx.timeoutServer', ph: '50s', vt: 'hpxTime' }, '50s')
    expect(w.find('input[type="number"]').element.value).toBe('50')
    expect(w.find('select').element.value).toBe('s')
    await w.find('input[type="number"]').setValue('5')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('5s')
  })
  it('csvInt: 文本框 + 常显 hint(placeholder 保留)', () => {
    const w = mountFld({ key: 'custom-http-errors', labelKey: 'ingressPerf.customHttpErrors', ph: '404,503', vt: 'csvInt' })
    const input = w.find('input:not([type="number"])')
    expect(input.attributes('placeholder')).toBe('404,503')
    expect(w.text()).toContain('404,503')
  })
  it('options: 渲染 select,空选项显示「默认(不设置)」', () => {
    const w = mountFld({ key: 'ssl-redirect', labelKey: 'ingressPerf.httpsRedirect', options: ['', 'true', 'false'] })
    expect(w.findAll('option')).toHaveLength(3)
    expect(w.find('option').text()).toContain('默认')
  })
  it('area: textarea + snippet hint', () => {
    const w = mountFld({ key: 'server-snippet', labelKey: 'ingressPerf.serverSnippet', ph: '# raw nginx server snippet', area: true })
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('admission')
  })
})
