// src/logic/__tests__/volumeBackfill.test.js
// 卷回填单源:编辑面(mergeVolumes 上提)与复制面(useWorkloadToForm)共用(spec 2026-08-29 §3.1)
import { test, expect } from 'vitest'
import { splitContainers, backfillVolumes } from '@/logic/volumeBackfill'

const projected = { name: 'proj-1', projected: { sources: [{ configMap: { name: 'cm' } }] } }

test('splitContainers: native sidecar(Always init)归位到 plain sidecar 之外', () => {
  const pod = { containers: [{ name: 'main' }, { name: 'side-a' }], initContainers: [{ name: 'init-a' }, { name: 'nat', restartPolicy: 'Always' }] }
  const s = splitContainers(pod)
  expect(s.mainContainer.name).toBe('main')
  expect(s.plainInits.map(c => c.name)).toEqual(['init-a'])
  expect(s.plainSidecars.map(c => c.name)).toEqual(['side-a'])
  expect(s.nativeSidecars.map(c => c.name)).toEqual(['nat'])
})

test('backfillVolumes: 多容器 target 对齐(native 占 sidecar:plain 数 + 序)', () => {
  const pod = {
    containers: [{ name: 'main', volumeMounts: [{ name: 'v-main', mountPath: '/m' }] }, { name: 'side-a', volumeMounts: [{ name: 'v-side', mountPath: '/s' }] }],
    initContainers: [{ name: 'init-a', volumeMounts: [{ name: 'v-init', mountPath: '/i' }] }, { name: 'nat', restartPolicy: 'Always', volumeMounts: [{ name: 'v-nat', mountPath: '/n' }] }],
    volumes: [{ name: 'v-main', emptyDir: {} }, { name: 'v-side', emptyDir: {} }, { name: 'v-init', emptyDir: {} }, { name: 'v-nat', emptyDir: {} }],
  }
  const rows = backfillVolumes(pod)
  const byMount = Object.fromEntries(rows.map(r => [r.mountPath, r.target]))
  expect(byMount['/m']).toBe('main')
  expect(byMount['/i']).toBe('init:0')
  expect(byMount['/s']).toBe('sidecar:0')
  expect(byMount['/n']).toBe('sidecar:1') // plain 1 个 → native 从 1 起
})

test('backfillVolumes: 解析 items/hostPathType/defaultMode(int→八进制串)', () => {
  const pod = {
    containers: [{ volumeMounts: [{ name: 'cm-v', mountPath: '/c' }, { name: 'hp-v', mountPath: '/h' }, { name: 'sec-v', mountPath: '/s' }] }],
    volumes: [
      { name: 'cm-v', configMap: { name: 'cm1', items: [{ key: 'a', path: 'conf/a.yml' }], defaultMode: 420 } },
      { name: 'hp-v', hostPath: { path: '/h', type: 'Directory' } },
      { name: 'sec-v', secret: { secretName: 's1', defaultMode: 256 } },
    ],
  }
  const rows = backfillVolumes(pod)
  const cm = rows.find(r => r.name === 'cm-v')
  expect(cm.items).toEqual([{ key: 'a', path: 'conf/a.yml' }])
  expect(cm.defaultMode).toBe('0644')
  expect(rows.find(r => r.name === 'hp-v').hostPathType).toBe('Directory')
  expect(rows.find(r => r.name === 'sec-v').defaultMode).toBe('0400')
})

test('backfillVolumes: 未知卷类型 → unknown + raw 原样透传;不降级 emptyDir', () => {
  const pod = { containers: [{ volumeMounts: [{ name: 'proj-1', mountPath: '/p' }] }], volumes: [projected] }
  const rows = backfillVolumes(pod)
  expect(rows[0].type).toBe('unknown')
  expect(rows[0].raw).toEqual(projected)
  expect(rows[0].raw).not.toBe(projected) // 行持有独立副本(非同引用)
  // 卷名未注册的 mount 回退 emptyDir(不是 unknown——raw 为 null 无从透传)
  const orphan = backfillVolumes({ containers: [{ volumeMounts: [{ name: 'ghost', mountPath: '/g' }] }] })
  expect(orphan[0].type).toBe('emptyDir')
})

test('backfillVolumes: 只定义未挂载的卷 → main 占位行', () => {
  const rows = backfillVolumes({ containers: [{}], volumes: [{ name: 'idle', emptyDir: {} }] })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ name: 'idle', target: 'main', mountPath: '' })
})
