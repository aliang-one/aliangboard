// 消息表基础设施单测：t 插值/回退、pickLang 头解析、msg 按请求语言。
// 各路由文件的消息条目由既有路由测试覆盖（zh 默认不变）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { t, pickLang, msg, tables } from './messages.mjs'

const FIXTURE = {
  'x.hello': { zh: '你好 {name}', en: 'Hello {name}' },
  'x.zhOnly': { zh: '仅中文' },
}

test('t 按 locale 取值 + {param} 插值', () => {
  assert.equal(t('zh', 'x.hello', { name: '李' }, FIXTURE), '你好 李')
  assert.equal(t('en', 'x.hello', { name: 'Li' }, FIXTURE), 'Hello Li')
})

test('t 缺 en 回退 zh；缺 code 返回键本身', () => {
  assert.equal(t('en', 'x.zhOnly', undefined, FIXTURE), '仅中文')
  assert.equal(t('zh', 'x.missing', undefined, FIXTURE), 'x.missing')
})

test('t 参数值含特殊字符不破坏插值', () => {
  assert.equal(t('zh', 'x.hello', { name: 'a{b}c' }, FIXTURE), '你好 a{b}c')
})

test('pickLang：无头/zh 头 → zh；en 头 → en', () => {
  assert.equal(pickLang({ headers: {} }), 'zh', '无头默认 zh(既有测试与服务端行为兼容)')
  assert.equal(pickLang({ headers: { 'accept-language': 'zh-CN,zh;q=0.9' } }), 'zh')
  assert.equal(pickLang({ headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'en')
  assert.equal(pickLang({ headers: { 'accept-language': 'en' } }), 'en')
  assert.equal(pickLang(undefined), 'zh')
})

test('msg：按请求头取语；缺 code 返回键', () => {
  assert.equal(msg({ headers: { 'accept-language': 'en' } }, 'x.hello', { name: 'A' }, FIXTURE), 'Hello A')
  assert.equal(msg({ headers: {} }, 'x.hello', { name: 'A' }, FIXTURE), '你好 A')
  assert.equal(msg({ headers: {} }, 'x.none', undefined, FIXTURE), 'x.none')
})

test('真实合并表：五个命名空间各至少一条 + zh/en 双值', () => {
  for (const ns of ['api', 'auth', 'admin', 'wbc', 'wbp']) {
    const keys = Object.keys(tables).filter(k => k.startsWith(ns + '.'))
    assert.ok(keys.length > 0, `命名空间 ${ns} 应有条目`)
    for (const k of keys) assert.ok(tables[k].zh && tables[k].en, `${k} 需 zh/en 双值`)
  }
})
