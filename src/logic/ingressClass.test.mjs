// src/logic/ingressClass.test.mjs —— IngressClass 具体类选择零依赖用例(node --test,进 package.json test:server 链)
// 背景:「集群默认」概念退役(2026-09-01)——三个 Ingress 创建入口曾默认 className='',
// 生成 YAML 不写 ingressClassName 指望 API server 按 is-default-class 默认化;但集群经常没有任何
// 被标记默认的类(平台自带的 4 份控制器清单全部刻意不标)→ Ingress 落地无类,控制器不接。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickIngressClassName } from './ingressClass.js'

test('pickIngressClassName: isDefault 标记的类优先', () => {
  const classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }, { name: 'apisix' }]
  assert.equal(pickIngressClassName(classes), 'nginx')
})

test('pickIngressClassName: 无 isDefault → 字母序第一(确定性,不依赖接口返回顺序)', () => {
  assert.equal(pickIngressClassName([{ name: 'traefik' }, { name: 'nginx' }, { name: 'apisix' }]), 'apisix')
  assert.equal(pickIngressClassName([{ name: 'nginx' }, { name: 'traefik' }]), 'nginx')
})

test('pickIngressClassName: 仅一个类 → 即该类', () => {
  assert.equal(pickIngressClassName([{ name: 'nginx', isDefault: false }]), 'nginx')
})

test('pickIngressClassName: 无类/脏数据 → 空串(调用方回退「集群无 IngressClass」)', () => {
  assert.equal(pickIngressClassName([]), '')
  assert.equal(pickIngressClassName(undefined), '')
  assert.equal(pickIngressClassName(null), '')
  assert.equal(pickIngressClassName([{}, { isDefault: true }, { name: '' }]), '')   // 无有效 name 的条目全忽略
})

test('pickIngressClassName: 脏数据混入仍能选中有效类', () => {
  assert.equal(pickIngressClassName([null, { name: '' }, { name: 'kong', isDefault: true }]), 'kong')
})
