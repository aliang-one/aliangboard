// ECharts 按需注册唯一入口 + MD3 亮/暗双主题注册。所有图表组件只 import 本文件(echarts/core 树摇生效)。
// 只引 Line/Pie/Gauge + Tooltip/Grid/MarkLine + SVGRenderer——数据量 ≤30 点,SVG 比 canvas 更清晰、
// 小尺寸不糊、happy-dom 可挂载。新增图表类型时在此补注册,勿在组件里直接 import 'echarts'。
import * as echarts from 'echarts/core'
import { LineChart, PieChart, GaugeChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { MD_PALETTE, DARK_PALETTE } from '@/styles/md-palette.js'

echarts.use([LineChart, PieChart, GaugeChart, GridComponent, TooltipComponent, MarkLineComponent, SVGRenderer])

// MD3 主题工厂:字体栈与 tailwind 一致;tooltip 走 surface-container-lowest 圆角卡片。
export function buildEchartsTheme(palette) {
  return {
    color: [palette.primary, palette.secondary, palette['tertiary-container'], palette.error],
    textStyle: {
      fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: palette['on-surface-variant'],
    },
    tooltip: {
      backgroundColor: palette['surface-container-lowest'],
      borderColor: palette['outline-variant'],
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: palette['on-surface'], fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(11,28,48,.12);',
    },
    animationDuration: 600,
    animationDurationUpdate: 450,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicInOut',
  }
}

echarts.registerTheme('md3', buildEchartsTheme(MD_PALETTE))
echarts.registerTheme('md3-dark', buildEchartsTheme(DARK_PALETTE))

export { echarts }
