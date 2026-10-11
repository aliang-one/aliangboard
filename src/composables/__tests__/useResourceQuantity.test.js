// 纯函数测试:资源量 <-> {数值, 单位} 互转。ResourceInput 组件靠它把 "4000m"/"512Mi"
// 拆成「数字框 + 单位下拉」,再把 数字+单位 合成回 K8s 规范串,交给 buildResources 原样下发。
//
// 2026-10-11 换算层全量重写(工作流审计 12 项确认缺陷的根修):
// - 单位表扩充:memory 增十进制 SI(k/M/G/T)——集群常见 '1G' 类值原样入表显示,不再
//   静默回退 Mi 造成 ~954 倍缩水;cpu 空值默认单位改 m(表首),对齐 placeholder '250m' 语义。
// - parseQuantity 支持完整 K8s quantity 文法(外来后缀/科学计数按值换算到表内单位,绝不改数量级)。
// - formatQuantity 不再静默取整(1.5Gi 曾被写成 2Gi):小数原样保留,K8s 接受 '1.5Gi'/'0.5m'。
// - convertNum(新增):单位切换时物理量换算(4000m→cores=4),供 ResourceInput 下拉切换用。
import { describe, it, expect } from 'vitest'
import { parseQuantity, formatQuantity, convertNum, RESOURCE_UNITS, toBaseValue } from '@/composables/useResourceQuantity'

describe('parseQuantity: K8s 串 → {数值, 单位}', () => {
  it('cpu: 4000m → 4000 + m', () => {
    expect(parseQuantity('4000m', 'cpu')).toEqual({ num: '4000', unit: 'm' })
  })
  it('cpu: 0.5 (cores, 无后缀) → 0.5 + 空', () => {
    expect(parseQuantity('0.5', 'cpu')).toEqual({ num: '0.5', unit: '' })
  })
  it('cpu: 2 → 2 + 空(cores)', () => {
    expect(parseQuantity('2', 'cpu')).toEqual({ num: '2', unit: '' })
  })
  it('cpu: 空串 → 空 + 默认(m,表首;对齐 250m 量级占位语义)', () => {
    expect(parseQuantity('', 'cpu')).toEqual({ num: '', unit: 'm' })
  })
  it('memory: 512Mi → 512 + Mi', () => {
    expect(parseQuantity('512Mi', 'memory')).toEqual({ num: '512', unit: 'Mi' })
  })
  it('memory: 1Gi → 1 + Gi', () => {
    expect(parseQuantity('1Gi', 'memory')).toEqual({ num: '1', unit: 'Gi' })
  })
  it('memory: 空串 → 空 + 默认(Mi)', () => {
    expect(parseQuantity('', 'memory')).toEqual({ num: '', unit: 'Mi' })
  })
  it('非法输入(字母混入) → 清空 + 默认单位', () => {
    expect(parseQuantity('abc', 'cpu')).toEqual({ num: '', unit: 'm' })
  })

  describe('外来后缀/科学计数:按物理量换算到表内单位(不再静默改数量级)', () => {
    it('cpu 100u → 0.1m(微核换算,曾是 100 cores 百万倍膨胀)', () => {
      expect(parseQuantity('100u', 'cpu')).toEqual({ num: '0.1', unit: 'm' })
    })
    it('cpu 2500000n → 2.5m(纳核换算)', () => {
      expect(parseQuantity('2500000n', 'cpu')).toEqual({ num: '2.5', unit: 'm' })
    })
    it('cpu 1e3(科学计数)→ 1000 cores', () => {
      expect(parseQuantity('1e3', 'cpu')).toEqual({ num: '1000', unit: '' })
    })
    it('memory 1G(十进制 SI 入表)→ 1 + G,不再回退 1 Mi', () => {
      expect(parseQuantity('1G', 'memory')).toEqual({ num: '1', unit: 'G' })
    })
    it('memory 512M → 512 + M', () => {
      expect(parseQuantity('512M', 'memory')).toEqual({ num: '512', unit: 'M' })
    })
    it('memory 1Pi → 1024 + Ti(表外二进制大单位换算到表内)', () => {
      expect(parseQuantity('1Pi', 'memory')).toEqual({ num: '1024', unit: 'Ti' })
    })
    it('memory 1P → 1000 + T(表外十进制大单位换算到表内)', () => {
      expect(parseQuantity('1P', 'memory')).toEqual({ num: '1000', unit: 'T' })
    })
    it('memory 1500(裸字节)→ 1.46484375 Ki(按真值换算,不再当 1500Mi)', () => {
      expect(parseQuantity('1500', 'memory')).toEqual({ num: '1.46484375', unit: 'Ki' })
    })
    it('memory 1e9 → 1 + G(科学计数按值识别十进制单位)', () => {
      expect(parseQuantity('1e9', 'memory')).toEqual({ num: '1', unit: 'G' })
    })
    it('memory 1048576(裸字节恰 1Mi)→ 1 + Mi', () => {
      expect(parseQuantity('1048576', 'memory')).toEqual({ num: '1', unit: 'Mi' })
    })
  })
})

describe('formatQuantity: {数值, 单位} → K8s 串(不取整,框显=载荷)', () => {
  it('cpu cores 保留小数: 0.5 → "0.5"', () => {
    expect(formatQuantity('0.5', '', 'cpu')).toBe('0.5')
  })
  it('cpu m: 4000 + m → "4000m"', () => {
    expect(formatQuantity('4000', 'm', 'cpu')).toBe('4000m')
  })
  it('cpu m 小数原样保留: 4000.7 → "4000.7m"(K8s 合法,不再静默取整)', () => {
    expect(formatQuantity('4000.7', 'm', 'cpu')).toBe('4000.7m')
  })
  it('memory 小数原样保留: 1.5 + Gi → "1.5Gi"(曾是框显 1.5 载荷 2Gi)', () => {
    expect(formatQuantity('1.5', 'Gi', 'memory')).toBe('1.5Gi')
  })
  it('memory: 512 + Mi → "512Mi"', () => {
    expect(formatQuantity('512', 'Mi', 'memory')).toBe('512Mi')
  })
  it('空数值 → 空串(清空)', () => {
    expect(formatQuantity('', 'm', 'cpu')).toBe('')
    expect(formatQuantity('', 'Mi', 'memory')).toBe('')
  })
  it('负数/非法 → 空串', () => {
    expect(formatQuantity('-5', 'm', 'cpu')).toBe('')
  })
  it('单位表定义正确(cpu 表首 m=空值默认;memory 含十进制 SI)', () => {
    expect(RESOURCE_UNITS.cpu.map(u => u.value)).toEqual(['m', ''])
    expect(RESOURCE_UNITS.memory.map(u => u.value)).toEqual(['Mi', 'Gi', 'Ki', 'Ti', 'k', 'M', 'G', 'T'])
  })
})

describe('convertNum: 单位切换换算(物理量不变)', () => {
  it('cpu 4000m → cores = 4', () => {
    expect(convertNum('4000', 'm', '', 'cpu')).toBe('4')
  })
  it('cpu 2 cores → m = 2000', () => {
    expect(convertNum('2', '', 'm', 'cpu')).toBe('2000')
  })
  it('memory 512Mi → Gi = 0.5(曾是 512Gi 千倍膨胀)', () => {
    expect(convertNum('512', 'Mi', 'Gi', 'memory')).toBe('0.5')
  })
  it('memory 512Mi → Ki = 524288', () => {
    expect(convertNum('512', 'Mi', 'Ki', 'memory')).toBe('524288')
  })
  it('memory 1G → Mi ≈ 953.674(跨进制换算保 12 位有效数字)', () => {
    const out = convertNum('1', 'G', 'Mi', 'memory')
    expect(Number(out)).toBeCloseTo(1e9 / 2 ** 20, 3)
  })
  it('空数值 → null(仅切单位不动数字框)', () => {
    expect(convertNum('', 'm', '', 'cpu')).toBe(null)
  })
  it('跨表内极值单位(Ki→T、Ki→Gi)恒定点记法,不产出指数串(审查修复)', () => {
    expect(convertNum('1', 'Ki', 'T', 'memory')).toBe('0.000000001024')       // 曾 '1.024e-9' → 载荷 '1.024e-9T' 非法
    expect(convertNum('1', 'Ki', 'Gi', 'memory')).toBe('0.000000953674316406')
  })
})

describe('formatQuantity/parseQuantity 闭合性:format 的输出空间恒可被 parse 读回(审查修复)', () => {
  it('亚微数值定点展开:0.0000001 + m → "0.0000001m"(曾 "1e-7m" 非法)', () => {
    expect(formatQuantity('0.0000001', 'm', 'cpu')).toBe('0.0000001m')
  })
  it('巨值定点展开:1e22 + Mi → 纯数字串', () => {
    expect(formatQuantity('1e22', 'Mi', 'memory')).toBe('10000000000000000000000Mi')
  })
  it('闭合:format → toBaseValue 往返保值(含极值单位对,相对误差 < 1e-9)', () => {
    for (const [num, unit, kind, expected] of [
      ['0.0000001', 'm', 'cpu', 1e-7],
      ['1', 'T', 'memory', 1e12 / 1024],           // T 十进制:1e12 bytes = 976562500 Ki
      ['0.000000001024', 'T', 'memory', 1],        // = 1 Ki(convertNum('1','Ki','T') 的原值)
      ['1e22', 'Mi', 'memory', 1e22 * 1024],
    ]) {
      const s = formatQuantity(num, unit, kind)
      expect(s).not.toMatch(/[eE]/)
      const back = toBaseValue(s, kind)
      expect(back).not.toBe(null)
      expect(Math.abs(back - expected) / expected).toBeLessThan(1e-9)
    }
  })
})

describe('toBaseValue: 完整文法 → 基准数值(cpu=毫核 / memory=Ki)', () => {
  it('cpu 各后缀', () => {
    expect(toBaseValue('250m', 'cpu')).toBe(250)
    expect(toBaseValue('0.5', 'cpu')).toBe(500)
    expect(toBaseValue('100u', 'cpu')).toBe(0.1)
    expect(toBaseValue('2500000n', 'cpu')).toBe(2.5)
    expect(toBaseValue('1e3', 'cpu')).toBe(1000000)
  })
  it('memory 各后缀(十进制 SI / 二进制 / 裸字节 / exa,审查修复补 E)', () => {
    expect(toBaseValue('1Mi', 'memory')).toBe(1024)
    expect(toBaseValue('1G', 'memory')).toBe(976562.5)
    expect(toBaseValue('512M', 'memory')).toBe(500000)      // 512e6 bytes = 500000 Ki
    expect(toBaseValue('1024', 'memory')).toBe(1)
    expect(toBaseValue('5E', 'memory')).toBeCloseTo((5 * 1e18) / 1024, 3)   // E(exa)曾漏白名单
  })
  it('空/非法 → null', () => {
    expect(toBaseValue('', 'cpu')).toBe(null)
    expect(toBaseValue('abc', 'memory')).toBe(null)
  })
})
