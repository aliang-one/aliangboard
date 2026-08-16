// vt 元信息与校验器真相表。领域事实:nginx 大小单位 k/m/g(大小写不敏感,裸数字=字节);
// haproxy 时间须带单位(ms/s/m);annotations 值最终都是字符串。
import { describe, it, expect } from 'vitest'
import { FIELD_VTS, validateAdvValue, validateIngressAdv, validateCustomAnnotations, vfmtOfKey, hintKeyOfKey, placeholderOfKey, INGRESS_DIALECTS } from '@/composables/useIngressPerf'

describe('validateAdvValue 真相表', () => {
  const sec = { key: 'proxy-send-timeout', vt: 'int', unitKey: 'ingressPerf.unitSeconds' }
  const size = { key: 'proxy-buffer-size', vt: 'size' }
  const hpx = { key: 'timeout-server', vt: 'hpxTime' }
  const lvl = { key: 'compression-level', vt: 'int', min: 1, max: 9 }
  const csvInt = { key: 'custom-http-errors', vt: 'csvInt' }
  const path = { key: 'rewrite-target', vt: 'path' }
  const bool = { key: 'ssl-redirect', options: ['', 'true', 'false'] }
  const snippet = { key: 'server-snippet', area: true }

  it('空值跳过(空=控制器默认)', () => {
    for (const fld of [sec, size, hpx, csvInt]) expect(validateAdvValue(fld, '')).toBe(null)
    expect(validateAdvValue(sec, undefined)).toBe(null)
  })
  it('int: 合法整数过,非整数拒', () => {
    expect(validateAdvValue(sec, '60')).toBe(null)
    expect(validateAdvValue(sec, '3600')).toBe(null)
    expect(validateAdvValue(sec, '6o')).toBe('ingressPerf.errInt')
    expect(validateAdvValue(sec, '-5')).toBe('ingressPerf.errInt')
    expect(validateAdvValue(sec, '1.5')).toBe('ingressPerf.errInt')
  })
  it('int + min/max: 区间外拒', () => {
    expect(validateAdvValue(lvl, '5')).toBe(null)
    expect(validateAdvValue(lvl, '0')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(lvl, '10')).toBe('ingressPerf.errRange')
  })
  it('size: 数字[+k/m/g] 过,怪单位拒', () => {
    expect(validateAdvValue(size, '4k')).toBe(null)
    expect(validateAdvValue(size, '10m')).toBe(null)
    expect(validateAdvValue(size, '1G')).toBe(null)
    expect(validateAdvValue(size, '100')).toBe(null)          // 裸数字=字节,nginx 合法
    expect(validateAdvValue(size, '4kb')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(size, '4 k')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(size, 'x')).toBe('ingressPerf.errSize')
  })
  it('size + min(buffer-size): 0/0k 拒——nginx [emerg] 拒 0 尺寸 buffer(2026-08-16 集群 dry-run 实测)', () => {
    const buf = { key: 'proxy-buffer-size', vt: 'size', min: 1 }
    expect(validateAdvValue(buf, '0')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(buf, '0k')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(buf, '4k')).toBe(null)
    expect(validateAdvValue(buf, '100')).toBe(null)
  })
  it('size per-field units/max(buffer-size): g 单位拒、>1GiB 拒、恰 1GiB 过——nginx 直通不认 g 且 1GiB 封顶(dry-run 实测 1g/1G/2g/1025m/1500m 拒,1024m/1048576k/裸 1073741824 过)', () => {
    const buf = { key: 'proxy-buffer-size', vt: 'size', min: 1, units: ['k', 'm'], max: 1073741824 }
    expect(validateAdvValue(buf, '1g')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(buf, '1G')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(buf, '1025m')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(buf, '1500m')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(buf, '2000000k')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(buf, '1024m')).toBe(null)
    expect(validateAdvValue(buf, '4K')).toBe(null)              // 大写 k/m 可(集群实测 4K 过)
    expect(validateAdvValue(buf, '1073741824')).toBe(null)     // 裸字节恰 1GiB 过
  })
  it('size 无 per-field 限制(body-size): g 合法——控制器换算字节后下发,1g/5g 过(dry-run 实测)', () => {
    const body = { key: 'proxy-body-size', vt: 'size' }
    expect(validateAdvValue(body, '1g')).toBe(null)
    expect(validateAdvValue(body, '5g')).toBe(null)
  })
  it('size 无 min(body-size): 0 合法=不限制(client_max_body_size 0)', () => {
    expect(validateAdvValue({ key: 'proxy-body-size', vt: 'size' }, '0')).toBe(null)
  })
  it('hpxTime: 数字+单位 过,裸数字拒', () => {
    expect(validateAdvValue(hpx, '50s')).toBe(null)
    expect(validateAdvValue(hpx, '5ms')).toBe(null)
    expect(validateAdvValue(hpx, '5')).toBe('ingressPerf.errTime')
    expect(validateAdvValue(hpx, '5s5')).toBe('ingressPerf.errTime')
  })
  it('csvInt: 逗号分隔状态码', () => {
    expect(validateAdvValue(csvInt, '404')).toBe(null)
    expect(validateAdvValue(csvInt, '404,503')).toBe(null)
    expect(validateAdvValue(csvInt, '404,x')).toBe('ingressPerf.errCsvInt')
    expect(validateAdvValue(csvInt, '404,')).toBe('ingressPerf.errCsvInt')
  })
  it('path: 须以 / 开头', () => {
    expect(validateAdvValue(path, '/$1')).toBe(null)
    expect(validateAdvValue(path, 'app')).toBe('ingressPerf.errPath')
  })
  it('options 字段(注解弹窗自由输入时兜底): 值须在列表内', () => {
    expect(validateAdvValue(bool, 'true')).toBe(null)
    expect(validateAdvValue(bool, 'ture')).toBe('ingressPerf.errEnum')
  })
  it('area/free 不校验', () => {
    expect(validateAdvValue(snippet, 'any raw nginx conf')).toBe(null)
  })
})

describe('validateIngressAdv: 按方言聚合', () => {
  it('nginx: 一个坏值 → 1 条错,labelKey 可翻译', () => {
    const errs = validateIngressAdv('nginx', { 'proxy-buffer-size': '4kb', 'proxy-send-timeout': '60' })
    expect(errs).toHaveLength(1)
    expect(errs[0].key).toBe('proxy-buffer-size')
    expect(errs[0].labelKey).toBe('ingressPerf.responseBufferSize')
    expect(errs[0].msgKey).toBe('ingressPerf.errSize')
  })
  it('全部合法 → 空', () => {
    expect(validateIngressAdv('nginx', { 'proxy-buffer-size': '4k' })).toEqual([])
  })
})

describe('vfmtOfKey / hintKeyOfKey / placeholderOfKey: 注解 key → 元信息', () => {
  it('已知 nginx key → 字段对象', () => {
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/proxy-send-timeout').vt).toBe('int')
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/custom-http-errors').vt).toBe('csvInt')
    expect(vfmtOfKey('haproxy-ingress.github.io/timeout-server').vt).toBe('hpxTime')
  })
  it('字段元信息: buffer-size 带 min 1(nginx 拒 0);body-size 无 min(0=不限制)', () => {
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/proxy-buffer-size').min).toBe(1)
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/proxy-body-size').min).toBeUndefined()
  })
  it('字段元信息: buffer-size units 无 g 且 max=1GiB(nginx 直通);body-size 不限单位', () => {
    const b = vfmtOfKey('nginx.ingress.kubernetes.io/proxy-buffer-size')
    expect(b.units).toEqual(['k', 'm'])
    expect(b.max).toBe(1073741824)
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/proxy-body-size').units).toBeUndefined()
  })
  it('未知 key → undefined,不限制', () => {
    expect(vfmtOfKey('custom.example/x')).toBeUndefined()
    expect(vfmtOfKey('')).toBeUndefined()
  })
  it('hint/placeholder 派生', () => {
    expect(hintKeyOfKey('nginx.ingress.kubernetes.io/custom-http-errors')).toBe('ingressPerf.hintCsvInt')
    expect(hintKeyOfKey('nginx.ingress.kubernetes.io/proxy-send-timeout')).toBe('')
    expect(placeholderOfKey('nginx.ingress.kubernetes.io/proxy-buffer-size')).toBe('4k')
    expect(placeholderOfKey('custom.example/x')).toBe('')
  })
})

describe('validateCustomAnnotations: 自定义注解行', () => {
  it('已知 key 值不合格 → 带 labelKey 的错', () => {
    const errs = validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4kb' }])
    expect(errs).toHaveLength(1)
    expect(errs[0].labelKey).toBe('ingressPerf.responseBufferSize')
    expect(errs[0].msgKey).toBe('ingressPerf.errSize')
  })
  it('未知 key / 合法值 / 空值 → 不报', () => {
    expect(validateCustomAnnotations([{ key: 'custom.example/x', value: '随便' }])).toEqual([])
    expect(validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4k' }])).toEqual([])
    expect(validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '' }])).toEqual([])
  })
})

describe('元信息全量覆盖(47 字段一个不漏)', () => {
  it('每个字段必有 vt 或 options 或 area', () => {
    for (const d of Object.values(INGRESS_DIALECTS)) for (const g of d.groups) for (const f of g.fields) {
      expect(Boolean(f.options || f.area || FIELD_VTS[f.vt]), `${d.prefix}/${f.key}`).toBe(true)
    }
  })
})
