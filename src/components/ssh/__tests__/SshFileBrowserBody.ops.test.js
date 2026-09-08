// SshFileBrowserBody 文件三件套接线(mock @/api/client):工具条 mkdir → PromptDialog 确认;
// 目录删除 = 输名字确认(requireText 门);文件删除 = 普通确认;成功后刷新当前目录。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => ({ list: [], mkdir: [], rename: [], delete: [] }))
vi.mock('@/api/client', () => ({
  sshFileApi: {
    list: vi.fn(async (serverId, path) => { calls.list.push(path); return { path, entries: [{ name: 'logs', type: 'dir' }, { name: 'a.txt', type: 'file' }] } }),
    mkdir: vi.fn(async p => { calls.mkdir.push(p); return { ok: true } }),
    rename: vi.fn(async p => { calls.rename.push(p); return { ok: true } }),
    delete: vi.fn(async p => { calls.delete.push(p); return { ok: true } }),
  },
}))
// Modal 是 Teleport body——桩平铺,断言留在 wrapper 内
vi.mock('@/components/common/Modal.vue', () => ({
  default: { name: 'Modal', props: ['modelValue', 'title', 'width'], template: '<div data-test="modal" v-if="modelValue"><slot /><slot name="actions" /></div>' },
}))

import SshFileBrowserBody from '../SshFileBrowserBody.vue'

function mountBody() {
  return mount(SshFileBrowserBody, {
    props: { serverId: 'sv1', serverName: 'gw-1' },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => { for (const k of Object.keys(calls)) calls[k].length = 0; vi.clearAllMocks() })

describe('SshFileBrowserBody 三件套', () => {
  it('工具条新建文件夹:确认 → mkdir(当前目录)+ 刷新', async () => {
    const w = mountBody()
    await flushPromises()
    await w.find('[data-test="btn-mkdir"]').trigger('click')
    await w.find('[data-testid="prompt-input"]').setValue('newdir')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(calls.mkdir).toEqual([{ serverId: 'sv1', path: '/', name: 'newdir' }])
    expect(calls.list.filter(p => p === '/').length).toBeGreaterThanOrEqual(2)   // 完成后刷新
    expect(w.find('[data-testid="prompt-input"]').exists()).toBe(false)
  })

  it('行内重命名(文件):初值=旧名,确认 → rename', async () => {
    const w = mountBody()
    await flushPromises()
    await w.find('[data-test="entry-rename-a.txt"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="prompt-input"]').element.value).toBe('a.txt')
    await w.find('[data-testid="prompt-input"]').setValue('b.txt')
    await w.find('[data-testid="prompt-ok"]').trigger('click')
    await flushPromises()
    expect(calls.rename).toEqual([{ serverId: 'sv1', path: '/a.txt', name: 'b.txt' }])
  })

  it('文件删除:普通确认 → delete', async () => {
    const w = mountBody()
    await flushPromises()
    await w.find('[data-test="entry-delete-a.txt"]').trigger('click')
    await flushPromises()
    // 文件删除=ConfirmDialog(不是输名字)
    expect(w.find('[data-testid="confirm-ok"]').exists()).toBe(true)
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(calls.delete).toEqual([{ serverId: 'sv1', path: '/a.txt' }])
  })

  it('目录删除:输名字确认门——输错禁用,输对目录名才发 delete(真机最后一道闸)', async () => {
    const w = mountBody()
    await flushPromises()
    await w.find('[data-test="entry-delete-logs"]').trigger('click')
    await flushPromises()
    const ok = w.find('[data-testid="prompt-ok"]')
    expect(w.find('[data-testid="prompt-input"]').exists()).toBe(true)   // PromptDialog(输名字),非 ConfirmDialog
    await w.find('[data-testid="prompt-input"]').setValue('log')
    expect(ok.attributes('disabled')).toBeDefined()
    await w.find('[data-testid="prompt-input"]').setValue('logs')
    expect(ok.attributes('disabled')).toBeUndefined()
    await ok.trigger('click')
    await flushPromises()
    expect(calls.delete).toEqual([{ serverId: 'sv1', path: '/logs' }])
  })
})
