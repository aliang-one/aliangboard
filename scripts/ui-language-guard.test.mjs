// ── 双轨 UI 语言守卫(2026-09-05,宪章 docs/superpowers/specs/2026-09-05-dual-track-ui-language-design.md)──
// 平台界面分两轨:K 轨(K8s 资源管理域,平台通用语)/ W 轨(自研概念域,模块自有语)。
// 路由以 meta.module 声明归属;本守卫强制两件事:
//   V1:module 值白名单——防乱标(未登记模块名静默不上氛围、语义漂移);
//   V2:凡声明 module 的路由 meta 必须含 fullHeight:true——氛围画布仅在 overflow-hidden 的
//      fullHeight main 上稳定(文档式滚动会把伪元素滚走),漏标 = 画布破碎。
// 新 W 轨模块接入:白名单加名即可,流程见宪章 §6。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const routerSrc = readFileSync(join(ROOT, 'src/router/index.js'), 'utf8')

// W 轨白名单:已登记的自研概念模块名(新增模块在此加名,宪章 §6)
const MODULE_WHITELIST = ['workbench']

function metaBlocks(src) {
  return src.match(/meta:\s*\{[^}]*\}/g) || []
}

test('V1: meta.module 值必须在白名单内(未登记的模块名 = 红灯)', () => {
  const offenders = []
  for (const block of metaBlocks(routerSrc)) {
    const m = block.match(/module:\s*'([^']+)'/)
    if (m && !MODULE_WHITELIST.includes(m[1])) offenders.push(`module: '${m[1]}'`)
  }
  assert.deepEqual(offenders, [])
})

test('V2: 声明 module 的路由必须 fullHeight(氛围画布仅在 overflow-hidden main 上稳定)', () => {
  const offenders = []
  for (const block of metaBlocks(routerSrc)) {
    if (/module:\s*'[^']+'/.test(block) && !/fullHeight:\s*true/.test(block)) {
      offenders.push(block.slice(0, 80))
    }
  }
  assert.deepEqual(offenders, [])
})

test('守卫自检:检测逻辑对合成坏样本必须真红(防空洞地绿)', () => {
  const bad = "meta: { titleKey: 'x', module: 'audit-center' }"                    // 未登记模块名
  const bad2 = "meta: { titleKey: 'x', module: 'workbench' }"                      // 缺 fullHeight
  const good = "meta: { titleKey: 'x', module: 'workbench', fullHeight: true }"    // 合法
  for (const sample of [bad, bad2]) {
    assert.equal(/module:\s*'([^']+)'/.test(sample) && !MODULE_WHITELIST.includes(sample.match(/module:\s*'([^']+)'/)[1]) ||
      (/module:\s*'[^']+'/.test(sample) && !/fullHeight:\s*true/.test(sample)), true, `应判红: ${sample}`)
  }
  assert.equal(MODULE_WHITELIST.includes(good.match(/module:\s*'([^']+)'/)[1]) && /fullHeight:\s*true/.test(good), true, '合法样本应判绿')
})
