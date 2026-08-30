// CSO #17:解码后的 Secret 值经 vue-i18n 插值进 v-html = 存储型 HTML 注入(CSP 挡 JS 不挡钓鱼表单)。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'NsSecretDetail.vue'), 'utf8')
describe('Secret 详情页 v-html 守卫', () => {
  it('解码 Secret 值不得进入 v-html', () => {
    expect(src).not.toMatch(/v-html="[^"]*decode\(/)
  })
  it('basic-auth 分支用文本插值渲染用户名', () => {
    expect(src).toContain('secret.basicAuthUsernameLabel')
  })
  it('decode 调用所在行不得含 v-html', () => {
    for (const line of src.split('\n')) {
      if (line.includes('decode(')) expect(line).not.toContain('v-html')
    }
  })
})
