// taskbarFit.nextFitStep 用例表:三层递进(收窄→折叠→回收)判定
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { nextFitStep } from './taskbarFit.js'

const cases = [
  // [name, input, expected action]
  ['空间充足且无折叠 → done', { scrollWidth: 100, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'done'],
  ['溢出且未收窄 → set-icon(第一层)', { scrollWidth: 500, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'set-icon'],
  ['已收窄仍溢出 → fold-one(第二层)', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3 }, 'fold-one'],
  ['已收窄且已折 2/3 仍溢出 → 继续 fold-one', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 2, total: 3 }, 'fold-one'],
  ['全部折叠仍溢出 → done(兜底,接受滚动裁切)', { scrollWidth: 500, clientWidth: 400, iconMode: true, overflowCount: 3, total: 3 }, 'done'],
  ['折叠后空间回富 → unfold-one(逆向回收)', { scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 2, total: 3 }, 'unfold-one'],
  ['收窄后空间回富且无折叠 → unset-icon(恢复名称)', { scrollWidth: 200, clientWidth: 400, iconMode: true, overflowCount: 0, total: 3 }, 'unset-icon'],
  ['恰好临界(+1px 在容差内)→ done', { scrollWidth: 401, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'done'],
  ['超容差 2px → set-icon', { scrollWidth: 402, clientWidth: 400, iconMode: false, overflowCount: 0, total: 3 }, 'set-icon'],
]

for (const [name, input, expected] of cases) {
  test(`taskbarFit: ${name}`, () => {
    assert.equal(nextFitStep(input).action, expected)
  })
}
