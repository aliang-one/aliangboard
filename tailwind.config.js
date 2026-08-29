/** @type {import('tailwindcss').Config} */
import { codeTheme } from './src/styles/code-theme.js'
import { MD_PALETTE } from './src/styles/md-palette.js'

export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // MD3 全套色板唯一来源:src/styles/md-palette.js —— 三元组化后经 CSS 变量取色,
        // <alpha-value> 保住全站 bg-primary/10 类透明度写法;html.dark 挂类即整站翻转。
        ...Object.fromEntries(Object.keys(MD_PALETTE).map(k => [k, `rgb(var(--md-sys-color-${k}) / <alpha-value>)`])),
        // 暗底代码/终端主题（与 xterm/prism 共用 src/styles/code-theme.js，单一来源）
        'code-surface': codeTheme.surface,
        'on-code-surface': codeTheme.onSurface,
        'code-surface-selection': codeTheme.selection,
        'code-surface-dim': codeTheme.dim,
      },
      fontFamily: {
        // Latin 优先 Inter；中文回落到 PingFang SC(Mac)/Microsoft YaHei(Win)/思源(Noto CJK)，跨平台一致
        'sans': ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Source Han Sans CN', 'Noto Sans CJK SC', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // 完整阶梯:display(大号数字/标题)→ headline(页面标题)→ body(正文)→ label/code。
        // 此前模板里用到 body-xs / headline-lg / display-md 但配置缺这三档，导致 169 处静默回落到默认字号
        // (MCP 设置页"字体不一样"的根因)。补齐让全站字号成体系。
        'display-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'display-md': ['28px', { lineHeight: '36px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['28px', { lineHeight: '36px', letterSpacing: '-0.01em', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '32px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-sm': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'body-lg': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'body-md': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'body-xs': ['11px', { lineHeight: '16px', fontWeight: '400' }],
        'label-caps': ['11px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
        'code-sm': ['12px', { lineHeight: '18px', fontWeight: '400' }],
      },
      spacing: {
        'base': '4px',
        'xs': '4px',
        'sm': '8px',
        'md': '16px',
        'lg': '24px',
        'xl': '32px',
        '2xl': '48px',
        'gutter': '24px',
        'margin': '32px',
      },
      borderRadius: {
        'DEFAULT': '0.25rem',
        'lg': '0.5rem',
        'xl': '0.75rem',
        '2xl': '1rem',
        'full': '9999px',
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgb(0 0 0 / 0.05)',
        'card-hover': '0 10px 15px -3px rgb(0 0 0 / 0.08)',
        'dropdown': '0 10px 25px -5px rgb(0 0 0 / 0.1)',
      },
      animation: {
        'pulse-status': 'pulse-status 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
        'dash-flow': 'dash-flow 5s linear infinite',
        'bar-stripes': 'bar-stripes 1.2s linear infinite',
      },
      keyframes: {
        'pulse-status': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'dash-flow': {
          to: { strokeDashoffset: '0' },
        },
        'bar-stripes': {
          // backgroundImage 是两层(斜纹 repeating-linear-gradient + 底部渐变 linear-gradient),
          // backgroundPosition 必须逐层给值且只动斜纹层(渐变层恒 0 0)。
          // 45° 斜纹横向周期 = 12px/cos45° ≈ 16.97px,整周期位移消除循环接缝的相位跳变(旧 24px 非整数倍,每圈跳一下)。
          '0%': { backgroundPosition: '16.97px 0, 0 0' },
          '100%': { backgroundPosition: '0 0, 0 0' },
        },
      },
    },
  },
  plugins: [],
}
