/** @type {import('tailwindcss').Config} */
import { codeTheme } from './src/styles/code-theme.js'

export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Surface
        'surface': '#f8f9ff',
        'surface-dim': '#cbdbf5',
        'surface-bright': '#f8f9ff',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#eff4ff',
        'surface-container': '#e5eeff',
        'surface-container-high': '#dce9ff',
        'surface-container-highest': '#d3e4fe',
        'on-surface': '#0b1c30',
        'on-surface-variant': '#3c4a42',
        'inverse-surface': '#213145',
        'inverse-on-surface': '#eaf1ff',
        'outline': '#6c7a71',
        'outline-variant': '#bbcabf',
        'surface-tint': '#006c49',
        // Primary (Emerald)
        'primary': '#006c49',
        'on-primary': '#ffffff',
        'primary-container': '#10b981',
        'on-primary-container': '#00422b',
        'inverse-primary': '#4edea3',
        'primary-fixed': '#6ffbbe',
        'primary-fixed-dim': '#4edea3',
        'on-primary-fixed': '#002113',
        'on-primary-fixed-variant': '#005236',
        // Secondary (Indigo)
        'secondary': '#4648d4',
        'on-secondary': '#ffffff',
        'secondary-container': '#6063ee',
        'on-secondary-container': '#fffbff',
        'secondary-fixed': '#e1e0ff',
        'secondary-fixed-dim': '#c0c1ff',
        'on-secondary-fixed': '#07006c',
        'on-secondary-fixed-variant': '#2f2ebe',
        // Tertiary (Amber)
        'tertiary': '#855300',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#e29100',
        'on-tertiary-container': '#523200',
        'tertiary-fixed': '#ffddb8',
        'tertiary-fixed-dim': '#ffb95f',
        'on-tertiary-fixed': '#2a1700',
        'on-tertiary-fixed-variant': '#653e00',
        // Error
        'error': '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',
        // Status
        'status-running': '#10b981',
        'status-pending': '#f59e0b',
        'status-failed': '#ef4444',
        'status-succeeded': '#3b82f6',
        'status-unknown': '#6b7280',
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
      },
    },
  },
  plugins: [],
}
