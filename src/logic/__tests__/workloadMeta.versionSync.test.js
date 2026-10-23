// 版本元数据「跟随镜像 tag 自动更新」纯逻辑(2026-10-23)。
// 开关注解 aliangboard.io/version-auto=true 时:面板内改镜像(改版本/编辑/回滚)后版本 label
// 同步为镜像名「:」后的 tag。这里锁两件事:
// ①syncedImageVersion 取值边界(registry 端口/digest/无 tag → latest)
// ②versionSyncTplLabels 换 version 键不误伤(CronJob jobTemplate 面/selector 绑键守卫/不 mutating)
import { describe, test, expect } from 'vitest'
import { VERSION_AUTO_KEY, syncedImageVersion, META_KEYS } from '../../composables/useBusinessMeta.js'
import { versionSyncTplLabels } from '../workloadMeta.js'

const VKEY = META_KEYS.version.canon // 'aliangboard.io/version'

describe('VERSION_AUTO_KEY:开关注解常量', () => {
  test('规范键为 aliangboard.io/version-auto', () => {
    expect(VERSION_AUTO_KEY).toBe('aliangboard.io/version-auto')
  })
})

describe('syncedImageVersion:镜像引用 → 同步用版本值', () => {
  test('常规 repo:tag → 原样取 tag(不加不减前缀)', () => {
    expect(syncedImageVersion('ghcr.io/aliang-one/aliangboard:1.0.47')).toBe('1.0.47')
    expect(syncedImageVersion('nginx:1.25')).toBe('1.25')
  })
  test('registry 带端口不误切(registry:5000/app:v2 → v2)', () => {
    expect(syncedImageVersion('registry.liang.home:5000/app:v2')).toBe('v2')
  })
  test('digest 引用取 tag 部分(app:1.2@sha256:ff → 1.2)', () => {
    expect(syncedImageVersion('app:1.2@sha256:ffee')).toBe('1.2')
  })
  test('无 tag / 空引用 → latest(与展示层 imageTag()||latest 惯例一致)', () => {
    expect(syncedImageVersion('nginx')).toBe('latest')
    expect(syncedImageVersion('registry.liang.home:5000/app')).toBe('latest')
    expect(syncedImageVersion('')).toBe('latest')
    expect(syncedImageVersion(null)).toBe('latest')
  })
})

describe('versionSyncTplLabels:模板 labels 换 version 键(全量期望 map)', () => {
  const deployRaw = { spec: { template: { metadata: { labels: { app: 'demo', [VKEY]: 'vOld', team: 'red' } } } } }

  test('Deployment 模板:只换 version 键,其余键原值保留', () => {
    expect(versionSyncTplLabels(deployRaw, '1.25', {})).toEqual({ app: 'demo', [VKEY]: '1.25', team: 'red' })
  })
  test('CronJob:读 jobTemplate.spec.template 面(podTemplateLabels 单源)', () => {
    const cronRaw = { spec: { jobTemplate: { spec: { template: { metadata: { labels: { app: 'cron', [VKEY]: 'vOld' } } } } } } }
    expect(versionSyncTplLabels(cronRaw, '2.0', {})).toEqual({ app: 'cron', [VKEY]: '2.0' })
  })
  test('无模板 labels → 只含 version 键(merge-patch 语义下其余键不受影响)', () => {
    expect(versionSyncTplLabels({}, '1.0', {})).toEqual({ [VKEY]: '1.0' })
    expect(versionSyncTplLabels(null, '1.0', {})).toEqual({ [VKEY]: '1.0' })
  })
  test('selector 绑定 version 键(病态)→ selector 原值透传,同步不得破坏 selector 不变式', () => {
    const raw = { spec: { selector: { matchLabels: { [VKEY]: 'pinned' } }, template: { metadata: { labels: { [VKEY]: 'pinned', app: 'x' } } } } }
    expect(versionSyncTplLabels(raw, '9.9', { [VKEY]: 'pinned' })[VKEY]).toBe('pinned')
  })
  test('纯函数:不改动入参 raw', () => {
    const snapshot = JSON.stringify(deployRaw)
    versionSyncTplLabels(deployRaw, '1.25', {})
    expect(JSON.stringify(deployRaw)).toBe(snapshot)
  })
})
