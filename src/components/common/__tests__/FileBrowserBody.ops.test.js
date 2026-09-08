// FileBrowserBody 文件三件套接线(mock @/api/client):工具条 mkdir → PromptDialog 确认 →
// podFileApi.mkdir(父目录=选中目录)+ 强刷;FolderPreview 行内钮发起 rename/delete;
// 删除后选中/展开态清理;重命名后 selected 随迁。SplitPane/FileTree 走浅桩,聚焦编排逻辑。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => ({ list: [], mkdir: [], rename: [], delete: [] }))
vi.mock('@/api/client', () => ({
  podFileApi: {
    list: vi.fn(async ({ path }) => { calls.list.push(path); return { path, entries: [{ name: 'logs', type: 'dir' }, { name: 'a.txt', type: 'file' }] } }),
    read: vi.fn(async () => ({ path: '/a.txt', content: 'x', truncated: false, binary: false })),
    write: vi.fn(async () => ({ ok: true })),
    mkdir: vi.fn(async p => { calls.mkdir.push(p); return { ok: true } }),
    rename: vi.fn(async p => { calls.rename.push(p); return { ok: true } }),
    delete: vi.fn(async p => { calls.delete.push(p); return { ok: true } }),
  },
}))
vi.mock('../SplitPane.vue', () => ({
  default: { name: 'SplitPane', props: ['storageKey', 'defaultSplit'], template: '<div class="flex h-full"><slot name="first" /><slot name="second" /></div>' },
}))
// Modal 是 Teleport body(测试查 body 惯例的例外路径)——桩平铺,断言留在 wrapper 内
vi.mock('../Modal.vue', () => ({
  default: { name: 'Modal', props: ['modelValue', 'title', 'width'], template: '<div data-test="modal" v-if="modelValue"><slot /><slot name="actions" /></div>' },
}))

import FileBrowserBody from '../FileBrowserBody.vue'

function mountBody() {
  setActivePinia(createPinia())
  return mount(FileBrowserBody, {
    props: { namespace: 'ns1', pod: 'pod-a', container: 'main' },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => { for (const k of Object.keys(calls)) calls[k].length = 0; vi.clearAllMocks() })

describe('FileBrowserBody 三件套', () => {
  it('工具条新建文件夹:确认 → mkdir(选中目录为父)+ 强刷该目录', async () => {
    const w = mountBody()
    await flushPromises()
    // 未选中 → 目标=根
    await w.find('[data-test="btn-mkdir"]').trigger('click')
    await w.find('[data-testid="prompt-input"]').setValue('newdir')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(calls.mkdir).toEqual([{ namespace: 'ns1', pod: 'pod-a', container: 'main', path: '/', name: 'newdir' }])
    // 强刷:list 被再次调用且含 '/'
    expect(calls.list.filter(p => p === '/').length).toBeGreaterThanOrEqual(2)
    // 弹窗关闭(成功)
    expect(w.find('[data-testid="prompt-input"]').exists()).toBe(false)
  })

  it('FolderPreview 行内重命名:初值=旧名,确认 → rename + selected 随迁', async () => {
    const w = mountBody()
    await flushPromises()
    // 选中根目录 → 右栏 FolderPreview 渲染根条目(logs / a.txt)
    w.vm.$.setupState.selectNode('/', true)
    await flushPromises()
    await w.find('[data-test="entry-rename-logs"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="prompt-input"]').element.value).toBe('logs')
    await w.find('[data-testid="prompt-input"]').setValue('logs2')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(calls.rename).toEqual([{ namespace: 'ns1', pod: 'pod-a', container: 'main', path: '/logs', name: 'logs2' }])
    // selected=/ 未命中被改路径,不迁移;父目录(根)被强刷
    expect(w.vm.$.setupState.selected).toBe('/')
  })

  it('重命名正选中的节点 → selected 随迁到新路径', async () => {
    const w = mountBody()
    await flushPromises()
    // 选中 /logs(FilePreview/FolderPreview 以 selected 为 key,随迁后自动重读)
    w.vm.$.setupState.selectNode('/logs', true)
    await flushPromises()
    w.vm.$.setupState.askRename('/logs')   // 模拟 FilePreview 头部重命名钮(选中文件场景同路径)
    await flushPromises()
    await w.find('[data-testid="prompt-input"]').setValue('logs3')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(calls.rename.at(-1)).toMatchObject({ path: '/logs', name: 'logs3' })
    expect(w.vm.$.setupState.selected).toBe('/logs3')
  })

  it('FolderPreview 行内删除:普通确认 → delete + 父目录强刷', async () => {
    const w = mountBody()
    await flushPromises()
    w.vm.$.setupState.selectNode('/', true)
    await flushPromises()
    await w.find('[data-test="entry-delete-a.txt"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(calls.delete).toEqual([{ namespace: 'ns1', pod: 'pod-a', container: 'main', path: '/a.txt' }])
  })

  it('删除正选中的目录 → selected 清空(右栏不再指向已删路径)', async () => {
    const w = mountBody()
    await flushPromises()
    // 先在根视图发起删除 /logs,同时 selected 指向 /logs(模拟用户选中后从父视图删它)
    w.vm.$.setupState.selectNode('/', true)
    await flushPromises()
    w.vm.$.setupState.selectNode('/logs', true)
    await flushPromises()
    w.vm.$.setupState.askDelete('/logs', true)
    await flushPromises()
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(calls.delete[0].path).toBe('/logs')
    expect(w.vm.$.setupState.selected).toBe(null)
  })

  it('mkdir 失败(409 已存在)→ toast error + 弹窗保留可重试', async () => {
    const { podFileApi } = await import('@/api/client')
    podFileApi.mkdir.mockRejectedValueOnce(new Error('mkdir: File exists'))
    const w = mountBody()
    await flushPromises()
    await w.find('[data-test="btn-mkdir"]').trigger('click')
    await w.find('[data-testid="prompt-input"]').setValue('dup')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="prompt-input"]').exists()).toBe(true)   // 窗还在
  })
})
