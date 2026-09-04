// ClusterSwitchPanel:集群选择面板(自顶栏迁入侧栏的承接组件)。
// 契约:哑组件——集群数据 props 进,select/manage/close 事件出;
// Teleport body + fixed 锚定(桌面)或贴底 bottom sheet(手机)内聚在本组件,
// 宿主(SideNavBar)只负责触发钮与开关状态。
import { test, expect, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

import ClusterSwitchPanel from '@/components/layout/ClusterSwitchPanel.vue'

const CLUSTERS = [
  { name: 'prod', apiServer: 'https://prod.example', version: 'v1.31.2', distribution: 'k3s', status: 'Healthy' },
  { name: 'staging', apiServer: 'https://staging.example', version: 'v1.30.1', distribution: 'Kubernetes', status: 'Degraded' },
]

function mountPanel(extraProps = {}) {
  return mount(ClusterSwitchPanel, {
    props: {
      open: true,
      triggerRef: ref(document.createElement('button')),
      clusters: CLUSTERS,
      currentName: 'prod',
      healthSeverity: 'ok',
      healthReasons: [],
      ...extraProps,
    },
    global: { plugins: [i18n] },
  })
}

afterEach(() => { document.body.innerHTML = '' })

test('open=false 不渲染;open=true Teleport 到 body 且带 data-testid', async () => {
  const closed = mountPanel({ open: false })
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]')).toBeFalsy()
  closed.unmount()

  const w = mountPanel()
  await Promise.resolve()
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]')).toBeTruthy()
  expect(w.find('[data-testid="cluster-dropdown-panel"]').exists()).toBe(false) // 不在组件树内
  w.unmount()
})

test('渲染集群列表:名称/版本·发行版,当前项 CURRENT 徽标+高亮', () => {
  const w = mountPanel()
  const panel = document.querySelector('[data-testid="cluster-dropdown-panel"]')
  expect(panel.textContent).toContain('prod')
  expect(panel.textContent).toContain('staging')
  expect(panel.textContent).toContain('v1.31.2 · k3s')
  expect(panel.textContent).toContain('v1.30.1 · Kubernetes')
  expect(panel.textContent).toContain('CURRENT')
  // 当前项行高亮(primary-container 底),他项不高亮
  const rows = panel.querySelectorAll('[data-test="cluster-row"]')
  expect(rows[0].className).toContain('bg-primary-container')
  expect(rows[1].className).not.toContain('bg-primary-container')
  w.unmount()
})

test('点击集群行 emit select(apiServer);管理全部钮 emit manage', async () => {
  const w = mountPanel()
  const rows = document.querySelectorAll('[data-test="cluster-row"]')
  rows[1].click()
  await nextTick()
  expect(w.emitted('select')).toEqual([['https://staging.example']])
  document.querySelector('[data-test="manage-all"]').click()
  await nextTick()
  expect(w.emitted('manage')).toHaveLength(1)
  w.unmount()
})

test('健康点分级:当前集群按 healthSeverity,他集群中性灰', () => {
  const w = mountPanel({ healthSeverity: 'crit' })
  const dots = document.querySelectorAll('[data-test="cluster-dot"]')
  expect([...dots[0].classList]).toContain('bg-error')            // crit → error
  expect([...dots[1].classList]).toContain('bg-on-surface-variant') // 他集群恒中性
  w.unmount()

  const w2 = mountPanel({ healthSeverity: 'warn' })
  expect([...document.querySelectorAll('[data-test="cluster-dot"]')[0].classList]).toContain('bg-tertiary-container')
  w2.unmount()
})

test('bottomSheet=true:贴底全宽形态(data-bottom-sheet);桌面:非贴底', () => {
  const sheet = mountPanel({ bottomSheet: true })
  const sp = sheet.find('[data-testid="cluster-dropdown-panel"]')
  expect(sp.exists()).toBe(false) // Teleport:组件树内不可见,查 body
  const sheetEl = document.querySelector('[data-testid="cluster-dropdown-panel"]')
  expect(sheetEl.getAttribute('data-bottom-sheet')).toBe('true')
  expect(sheetEl.className).toContain('bottom-0')
  sheet.unmount()

  const desk = mountPanel({ bottomSheet: false })
  const deskEl = document.querySelector('[data-testid="cluster-dropdown-panel"]')
  expect(deskEl.getAttribute('data-bottom-sheet')).toBe('false')
  expect(deskEl.style.position).toBe('fixed')
  // 桌面锚定档必须自带宽上限(旧顶栏 placeDropdown 显式 320px;丢失会 shrink-to-fit,
  // URL 形集群名把面板撑到视口宽,truncate 永不生效——审查抓回的回归)
  expect(deskEl.className).toContain('w-80')
  desk.unmount()
})
