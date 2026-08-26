// 多路复用 watch 通道（网关侧）单测：parseResources / tagLine / createMuxStream
import test from 'node:test'
import assert from 'node:assert/strict'
import { WATCH_RESOURCES, parseResources, tagLine, createMuxStream } from './k8s-watch-mux.mjs'

test('WATCH_RESOURCES 覆盖 7 类资源且路径正确', () => {
  assert.equal(Object.keys(WATCH_RESOURCES).length, 7)
  assert.equal(WATCH_RESOURCES.pods, '/api/v1/pods')
  assert.equal(WATCH_RESOURCES.deployments, '/apis/apps/v1/deployments')
  assert.equal(WATCH_RESOURCES.ingresses, '/apis/networking.k8s.io/v1/ingresses')
})

test('parseResources: 多资源 + rv 提取', () => {
  const q = new URL('http://x/y?resources=pods,events&rv_pods=123&rv_events=45')
  const { list, invalid } = parseResources(q)
  assert.deepEqual(invalid, [])
  assert.deepEqual(list.map(x => x.resource), ['pods', 'events'])
  assert.equal(list[0].path, '/api/v1/pods')
  assert.equal(list[0].rv, '123')
  assert.equal(list[1].rv, '45')
})

test('parseResources: 未知资源进 invalid，合法的保留', () => {
  const q = new URL('http://x/y?resources=pods,foo,bar')
  const { list, invalid } = parseResources(q)
  assert.deepEqual(invalid, ['foo', 'bar'])
  assert.deepEqual(list.map(x => x.resource), ['pods'])
  // 无 rv → undefined
  assert.equal(list[0].rv, undefined)
})

test('parseResources: 空/缺参 → 无资源', () => {
  assert.deepEqual(parseResources(new URL('http://x/y')).list, [])
  assert.deepEqual(parseResources(new URL('http://x/y?resources=')).list, [])
})

test('tagLine: ADDED 行 → {r,t,o} 标签线', () => {
  const obj = { metadata: { name: 'nginx' } }
  const out = tagLine('pods', JSON.stringify({ type: 'ADDED', object: obj }))
  assert.deepEqual(JSON.parse(out), { r: 'pods', t: 'ADDED', o: obj })
})

test('tagLine: 垃圾/空行/心跳 → null', () => {
  assert.equal(tagLine('pods', ''), null)
  assert.equal(tagLine('pods', '\n'), null)
  assert.equal(tagLine('pods', 'not-json'), null)
})

// —— createMuxStream ——
// 构造异步生成器 body（按行产出）
function bodyOf(lines) {
  async function* gen() { for (const l of lines) yield l }
  return gen()
}

test('createMuxStream: 两资源事件交错写入 tagged 行；全部正常结束 → end()', async () => {
  const written = []
  const { list } = parseResources(new URL('http://x/y?resources=pods,events'))
  const mux = createMuxStream({
    resources: list,
    fetchUpstream: async (path) => ({
      ok: true, status: 200,
      body: bodyOf(path.includes('pods')
        ? [JSON.stringify({ type: 'ADDED', object: { kind: 'Pod' } }) + '\n']
        : [JSON.stringify({ type: 'MODIFIED', object: { kind: 'Event' } }) + '\n']),
    }),
    write: l => written.push(l),
    end: () => written.push('__END__'),
  })
  await mux.done
  const lines = written.filter(w => w !== '__END__').map(JSON.parse)
  assert.equal(lines.length, 2)
  assert.ok(lines.some(l => l.r === 'pods' && l.t === 'ADDED' && l.o.kind === 'Pod'))
  assert.ok(lines.some(l => l.r === 'events' && l.t === 'MODIFIED'))
  assert.equal(written[written.length - 1], '__END__')
})

test('createMuxStream: 某上游 !ok → err 行 + close 全部 + end', async () => {
  const written = []
  let otherAborted = false
  const { list } = parseResources(new URL('http://x/y?resources=pods,events'))
  const mux = createMuxStream({
    resources: list,
    fetchUpstream: async (path, { signal }) => {
      if (path.includes('pods')) return { ok: false, status: 403, body: null }
      // 另一上游长挂，监听 abort
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { otherAborted = true; resolve() })
      })
      return { ok: true, status: 200, body: bodyOf([]) }
    },
    write: l => written.push(l),
    end: () => written.push('__END__'),
  })
  await mux.done
  const errLines = written.filter(w => w !== '__END__').map(JSON.parse)
  assert.ok(errLines.some(l => l.r === 'pods' && l.err === 403))
  assert.equal(written[written.length - 1], '__END__')
  assert.equal(otherAborted, true)
})

test('createMuxStream: 上游读错误 → err(r,0) + end', async () => {
  const written = []
  const { list } = parseResources(new URL('http://x/y?resources=services'))
  const mux = createMuxStream({
    resources: list,
    fetchUpstream: async () => { throw new Error('boom') },
    write: l => written.push(l),
    end: () => written.push('__END__'),
  })
  await mux.done
  assert.deepEqual(JSON.parse(written[0]), { r: 'services', err: 0 })
  assert.equal(written[written.length - 1], '__END__')
})

test('createMuxStream: close() 中止所有上游', async () => {
  let aborted = false
  const { list } = parseResources(new URL('http://x/y?resources=pods'))
  const mux = createMuxStream({
    resources: list,
    fetchUpstream: async (path, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }))
      return { ok: true, status: 200, body: bodyOf([]) }
    },
    write: () => {},
    end: () => {},
  })
  mux.close()
  await mux.done
  assert.equal(aborted, true)
})
