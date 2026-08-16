# 容器文件传输进度化 + 文件浏览窗口化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 容器文件上传/下载全程进度化(任务栏百分比+传输面板),文件浏览照终端逻辑浮动窗口化(可最小化/持久化/状态同步),限额 1GB 全局可配。

**Architecture:** 服务端下载改流式(容器内 base64 编码输出 → 网关逐行解码转发,规避 tty CR 清洗对二进制的损坏),上传新增二进制流式端点(req pipe → exec stdin)。前端 transfers store 内存态驱动进度,XHR/fetch 原语进 http.js;FloatingWindow 壳从 TerminalWindow 抽出,fileBrowsers store + SQLite 表照 terminals 平行;任务栏扩三分区。

**Tech Stack:** Vue 3 + Pinia + vitest(happy-dom);Node gateway + @kubernetes/client-node exec + node:test。

**Spec:** `docs/superpowers/specs/2026-08-16-podfile-transfer-progress-design.md`

## Global Constraints

- 分支 `worktree-feat-podfile-transfer`(已在 worktree,勿切 main;提交信息中文,风格照 `git log --oneline`)
- **零新增依赖**(CLAUDE.md 依赖政策;XHR/fetch/Blob 均原生)
- **i18n**:所有新 UI 文案 zh+en 双语加进 `src/locales/{zh,en}.json`,每个前端任务自带其键;最终 `npm run i18n:check` 必须过
- **exec tty 约束**(代码库实证,见 `server/index.mjs:804` 注释):stdout 收集必须 tty=true(本集群 tty=false 立即 close 无数据);**tty 输出带 CR/ANSI,二进制必须容器内 base64 后网关解码**(现有 `/api/podfile/download` 经 execCapture raw=false 剥 \r,二进制本就有损坏风险——本计划顺带修复)
- stdin-only exec(上传 cat >)用 tty=false(现有 `/api/podfile/write` 同路径,已验证)
- 服务端纯逻辑抽 `server/*.mjs` 模块 + 注入 openConn(node:test,照 `server/exec-bounds.mjs` 模式);前端测试 vitest
- 每个 task 结束跑该 task 的测试 + 提交;提交信息尾部加 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 涉及 .vue 的任务最后跑 `npm run build` 验证(node --check 不覆盖 .vue)

---

### Task 1: server/podfile-stream.mjs —— 流式传输纯逻辑(base64 行解码 + 下载/上传编排)

**Files:**
- Create: `server/podfile-stream.mjs`
- Test: `server/podfile-stream.test.mjs`

**Interfaces:**
- Consumes: 无(纯逻辑,依赖全注入)
- Produces(Task 2 消费,签名精确):
  - `createBase64LineDecoder(onChunk: (Buffer)=>void): Writable` —— base64 行流→二进制 chunk
  - `streamDownload({ statBytes, limitBytes, openConn, res, filename }): Promise<void>` —— openConn(stdoutSink, stderrSink)→Promise<conn(EventEmitter+close)>;头部未发时失败抛 `{status}`;已发→res.destroy()
  - `streamUpload({ contentLength, limitBytes, openConn, req }): Promise<{ok:true, bytes:number}>` —— openConn(stdin, stderrSink);缺 content-length 抛 411、超限抛 413、req 中断抛 `{status:499, canceled:true}`
  - `limitMbFromValue(v): number|null` —— 解析限额 MB,1-10240 外返 null
  - `PODFILE_LIMIT_DEFAULT_MB = 1024`、`fmtMB(bytes): string`

- [ ] **Step 1: 写失败测试**

```js
// server/podfile-stream.test.mjs
// 流式传输纯逻辑:base64 行解码 / 下载编排(头/限/流/中断) / 上传编排(pipe/411/413/中断)。
// 全部注入 fake conn/req/res,无 k8s 依赖(照 exec-bounds.test.mjs 模式)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import {
  createBase64LineDecoder, streamDownload, streamUpload,
  limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB, fmtMB,
} from './podfile-stream.mjs'

function fakeConn() {
  const c = new EventEmitter()
  c.closed = false
  c.close = () => { if (c.closed) return; c.closed = true; c.emit('close') }
  return c
}
function fakeRes() {
  return {
    headers: null, chunks: [], ended: false, destroyed: false, headersSent: false,
    writeHead(status, h) { this.headersSent = true; this.status = status; this.headers = h },
    write(c) { this.chunks.push(Buffer.from(c)) },
    end() { this.ended = true },
    destroy() { this.destroyed = true },
  }
}
const sinkWrite = (sink, data) => new Promise(r => sink.write(data, r))

test('createBase64LineDecoder: 跨 chunk 半行/\\r\\n/无换行尾段 → 解码拼接=原文', async () => {
  const data = Buffer.concat([Buffer.from('hello 二进制 \x00\xff\x0d\x0a tail'), Buffer.alloc(64, 7)])
  const b64 = data.toString('base64')
  const wrapped = b64.match(/.{1,76}/g).join('\r\n')            // busybox base64 行宽 + pty 的 \r\n
  const parts = [wrapped.slice(0, 100), wrapped.slice(100, 201), wrapped.slice(201) + '\r\n'] // 任意切分
  const out = []
  const dec = createBase64LineDecoder(c => out.push(c))
  for (const p of parts) await sinkWrite(dec, p)
  await new Promise(r => dec.end(r))
  assert.deepEqual(Buffer.concat(out), data)
})

test('streamDownload: 正常 → 200 头(content-length=statBytes)+块序解码+end', async () => {
  const data = Buffer.alloc(3000, 0xab)
  const conn = fakeConn()
  let so
  const res = fakeRes()
  const p = streamDownload({
    statBytes: data.length, limitBytes: 1024 * 1024, res, filename: 'a.bin',
    openConn: (stdoutSink) => { so = stdoutSink; return Promise.resolve(conn) },
  })
  await sinkWrite(so, data.toString('base64').match(/.{1,76}/g).join('\n') + '\n')
  conn.close()
  await p
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], String(data.length))
  assert.equal(res.headers['content-disposition'], 'attachment; filename="a.bin"')
  assert.deepEqual(Buffer.concat(res.chunks), data)
  assert.ok(res.ended && !res.destroyed)
})

test('streamDownload: 空文件(statBytes=0)→ 直接 200+end,不启 exec', async () => {
  let opened = 0
  const res = fakeRes()
  await streamDownload({ statBytes: 0, limitBytes: 100, res, filename: 'e',
    openConn: async () => { opened++; return fakeConn() } })
  assert.equal(opened, 0)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], '0')
  assert.ok(res.ended)
})

test('streamDownload: 超限 → 抛 413,头部未写', async () => {
  await assert.rejects(
    streamDownload({ statBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, res: fakeRes(), filename: 'x', openConn: async () => fakeConn() }),
    e => e.status === 413 && !/TBD/.test(e.message),
  )
})

test('streamDownload: conn 早关无数据(stderr 有错) → 抛 404(头部未发)', async () => {
  const conn = fakeConn()
  let se
  const p = streamDownload({ statBytes: 10, limitBytes: 100, res: fakeRes(), filename: 'x',
    openConn: (_so, stderrSink) => { se = stderrSink; return Promise.resolve(conn) } })
  await sinkWrite(se, 'cat: can\'t open \'x\': No such file')
  conn.close()
  await assert.rejects(p, e => e.status === 404)
})

test('streamDownload: 头部已发后 conn error → res.destroy 不抛', async () => {
  const conn = fakeConn()
  let so
  const res = fakeRes()
  const p = streamDownload({ statBytes: 100, limitBytes: 1000, res, filename: 'x',
    openConn: (stdoutSink) => { so = stdoutSink; return Promise.resolve(conn) } })
  await sinkWrite(so, Buffer.alloc(50, 1).toString('base64') + '\n')
  assert.ok(res.headersSent)
  conn.emit('error', new Error('ws broke'))
  conn.close()
  await p                                       // 不 reject:已发头只能 destroy
  assert.ok(res.destroyed)
})

test('streamUpload: 缺 content-length → 411;超限 → 413;均不启 exec', async () => {
  let opened = 0
  const openConn = () => { opened++; return Promise.resolve(fakeConn()) }
  await assert.rejects(streamUpload({ contentLength: NaN, limitBytes: 100, openConn, req: Readable.from([]) }), e => e.status === 411)
  await assert.rejects(streamUpload({ contentLength: 200, limitBytes: 100, openConn, req: Readable.from([]) }), e => e.status === 413)
  assert.equal(opened, 0)
})

test('streamUpload: req 全量进 stdin,conn close 后 → {ok, bytes}', async () => {
  const conn = fakeConn()
  let got
  const req = Readable.from([Buffer.from('abc'), Buffer.from('de')])
  const p = streamUpload({ contentLength: 5, limitBytes: 100, req,
    openConn: (stdinSink) => { got = new Promise(r => { const cs = []; stdinSink.on('data', c => cs.push(c)); stdinSink.on('end', () => r(Buffer.concat(cs))) }); return Promise.resolve(conn) } })
  assert.deepEqual(await p, { ok: true, path: '', bytes: 5 })
  assert.equal((await got).toString(), 'abcde')
})

test('streamUpload: req 中途 aborted → conn.close 被调 + 抛 canceled', async () => {
  const conn = fakeConn()
  const req = new Readable({ read() {} })
  const p = streamUpload({ contentLength: 100, limitBytes: 1000, req,
    openConn: (stdinSink) => { stdinSink.on('error', () => {}); return Promise.resolve(conn) } })
  req.push('partial')
  req.destroy(new Error('client aborted'))   // destroy(err) → 'error' 事件(裸 destroy 只发 close,不够)
  await assert.rejects(p, e => e.canceled === true)
  assert.ok(conn.closed)
})

test('limitMbFromValue/fmtMB: 边界', () => {
  assert.equal(PODFILE_LIMIT_DEFAULT_MB, 1024)
  assert.equal(limitMbFromValue('2048'), 2048)
  assert.equal(limitMbFromValue(0), null)
  assert.equal(limitMbFromValue(999999), null)
  assert.equal(limitMbFromValue(null), null)
  assert.equal(fmtMB(1024 * 1024 * 1024), '1.0 GB')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/podfile-stream.test.mjs`
Expected: FAIL —— `Cannot find module './podfile-stream.mjs'`

- [ ] **Step 3: 写实现**

```js
// server/podfile-stream.mjs
// Pod 文件流式传输核心(纯逻辑,依赖注入,照 exec-bounds.mjs 模式):
//  - 下载:容器内 base64 输出 → 网关逐行解码回二进制流式写响应。base64 字母表不含 \r/ESC,
//    pty 的 \n→\r\n 翻译与 ANSI 清洗都不损数据(规避 execCapture raw=false 剥 \r 的二进制损坏)。
//  - 上传:请求体原始二进制 pipe → exec stdin(tty=false,与 /api/podfile/write 同路径)。
import { Writable } from 'node:stream'

export const PODFILE_LIMIT_DEFAULT_MB = 1024
export const PODFILE_LIMIT_MAX_MB = 10240

// 限额 MB 解析:1-10240 整数,非法/null → null(调用方回退默认)
export function limitMbFromValue(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n >= 1 && n <= PODFILE_LIMIT_MAX_MB ? n : null
}

export function fmtMB(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

// base64 行解码 Writable:任意 chunk 切分下按行(\n 分隔,\r 等杂散字节剔除)解码;尾段无换行也解码。
export function createBase64LineDecoder(onChunk) {
  let buf = ''
  return new Writable({
    write(c, _e, cb) {
      buf += c.toString('ascii')
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const clean = line.replace(/[^A-Za-z0-9+/=]/g, '')
        if (clean) onChunk(Buffer.from(clean, 'base64'))
      }
      cb()
    },
    final(cb) {
      const clean = buf.replace(/[^A-Za-z0-9+/=]/g, '')
      if (clean) onChunk(Buffer.from(clean, 'base64'))
      cb()
    },
  })
}

const cleanTty = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim()

// 下载编排:stat 已由调用方完成(statBytes>=0 才进来;NaN 也按 404 处理)。
// 超限→413;openConn 后 conn 早关且零数据+stderr 非空→404;头部已发后的失败→res.destroy(不抛)。
export async function streamDownload({ statBytes, limitBytes, openConn, res, filename }) {
  if (!(statBytes >= 0)) throw Object.assign(new Error('文件不存在或不可读'), { status: 404 })
  if (statBytes > limitBytes) {
    throw Object.assign(new Error(`文件过大(${fmtMB(statBytes)} > 限额 ${fmtMB(limitBytes)});管理员可在 设置→文件传输 调整`), { status: 413 })
  }
  if (statBytes === 0) {   // 空文件:无 base64 输出,直接 200 空体(不走「零数据=失败」判定)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${filename}"`, 'content-length': 0 })
    res.end()
    return
  }
  const errChunks = []
  const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb() } })
  let received = false
  let headSent = false
  const decoder = createBase64LineDecoder((chunk) => {
    if (!headSent) {
      headSent = true
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': statBytes,
      })
    }
    received = true
    res.write(chunk)
  })
  const conn = await openConn(decoder, stderrSink)
  await new Promise((resolve) => {
    conn.on('close', resolve)
    conn.on('error', resolve)
    decoder.on('close', resolve)   // 上游 end() 兜底
  })
  try { conn.close() } catch { /* 已关 */ }
  if (!headSent) {
    const errText = cleanTty(Buffer.concat(errChunks).toString('utf8'))
    throw Object.assign(new Error(errText || '文件读取失败'), { status: 404 })
  }
  if (received) res.end()
  else { res.destroy(); return }  // 头都发了却零数据:毁连接让浏览器报错,而非挂空文件
}

// 上传编排:contentLength 缺失→411、超限→413(都不启 exec);req.pipe(stdin);req aborted→conn.close+canceled。
export function streamUpload({ contentLength, limitBytes, openConn, req }) {
  return new Promise((resolve, reject) => {
    if (!(contentLength >= 0)) return reject(Object.assign(new Error('缺少 content-length'), { status: 411 }))
    if (contentLength > limitBytes) {
      return reject(Object.assign(new Error(`文件过大(${fmtMB(contentLength)} > 限额 ${fmtMB(limitBytes)});管理员可在 设置→文件传输 调整`), { status: 413 }))
    }
    const errChunks = []
    const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb() } })
    let conn = null
    let settled = false
    const fail = (e) => { if (settled) return; settled = true; try { conn?.close() } catch { /* noop */ } reject(e) }
    openConn(req, stderrSink)          // 注意:openConn 的第一参即 stdin(=req 原样传给 exec 也可,但为对齐 seam 统一由调用方 pipe)
      .then(c => {
        conn = c
        conn.on('close', () => {
          if (settled) return
          settled = true
          const errText = cleanTty(Buffer.concat(errChunks).toString('utf8'))
          if (errText) reject(Object.assign(new Error(errText), { status: 502 }))
          else resolve({ ok: true, path: '', bytes: contentLength })
        })
        conn.on('error', () => fail(Object.assign(new Error('exec 连接错误'), { status: 502 })))
      })
      .catch(e => fail(Object.assign(new Error(e?.message || 'exec 失败'), { status: 502 })))
    req.on('error', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
    req.on('aborted', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
  })
}
```

注意:测试里 `streamUpload` 的 openConn 收到 `(stdinSink)` —— 实现传的是 `req`(网关层直接把 ServerRequest pipe 给 stdin 的 PassThrough 由 index.mjs 完成,见 Task 2)。若实现按上面把 `req` 作为第一参传 openConn,则 Task 2 的 openConn 形如 `(reqStream, stderrSink) => { const stdin = new PassThrough(); reqStream.pipe(stdin); return exec.exec(..., stdin, false) }`。**保持测试与实现签名一致**:openConn(input, stderrSink),input=请求流。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/podfile-stream.test.mjs`
Expected: PASS(全部 ~9 test)

- [ ] **Step 5: 提交**

```bash
git add server/podfile-stream.mjs server/podfile-stream.test.mjs
git commit -m "feat(server): podfile 流式传输纯逻辑——base64 行解码/下载上传编排/限额解析"
```

---

### Task 2: server/index.mjs + routes/admin.mjs 接线 —— 流式下载/上传端点 + 限额设置端点

**Files:**
- Modify: `server/index.mjs`(`/api/podfile/` 块约 1628-1690 行;terminals 建表区约 75-85 行)
- Modify: `server/routes/admin.mjs`(mcp-config 之后)

**Interfaces:**
- Consumes(Task 1):`{ streamDownload, streamUpload, limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB }`
- Produces(Task 3/10 消费):
  - `POST /api/podfile/download` —— 200 流式二进制(content-length=stat 大小)/ 404 / 413
  - `POST /api/podfile/upload?namespace=&pod=&container=&path=` —— 请求体原始字节 → `{ok, path, bytes}` / 400/404/411/413/502
  - `GET/PUT /api/admin/podfile-config` —— `{limitMb}` / `{ok, limitMb}`(PUT 校验 1-10240)
  - 设置键 `podfile.limitMb`(platform_settings)

- [ ] **Step 1: index.mjs 顶部 import + 限额读取 + 建表**

在 `server/index.mjs` 既有 import 区(`import { createLlmClient ... }` 附近)加:

```js
import { streamDownload, streamUpload, limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB } from './podfile-stream.mjs'
```

在 `getSetting/setSetting` 定义(约 139-140 行)之后加:

```js
// Pod 文件传输限额(单文件,上传下载共用):默认 1GB,admin 可经 /api/admin/podfile-config 调整
function getPodfileLimitBytes() {
  const mb = limitMbFromValue(getSetting('podfile.limitMb')) ?? PODFILE_LIMIT_DEFAULT_MB
  return mb * 1024 * 1024
}
```

- [ ] **Step 2: 重写 download action + 新增 upload action**

`/api/podfile/` 块内,`const action = url.pathname.slice('/api/podfile/'.length)` 之后、`const input = await readBody(req)` **之前**插入 upload 分支(readBody 会缓冲整个请求体,必须绕开):

```js
      // upload:二进制流式(元信息走查询串,请求体 pipe → exec stdin,不经 base64/不整包缓冲)
      if (action === 'upload') {
        const q = url.searchParams
        const namespace = q.get('namespace'), pod = q.get('pod')
        const container = q.get('container') || '', path = q.get('path') || ''
        if (!namespace || !pod || !path) return sendJson(res, 400, { message: '缺少 namespace / pod / path' })
        const contentLength = parseInt(req.headers['content-length'] || '', 10)
        const { KubeConfig, Exec } = await k8sClient()
        const exec = new Exec(buildKubeConfig(KubeConfig, session))
        try {
          const r = await streamUpload({
            contentLength, limitBytes: getPodfileLimitBytes(), req,
            openConn: (input, stderrSink) => {
              const stdin = new PassThrough()   // 过早 EOF 会让 kubelet 提前关 exec(见 execCapture 注释),pipe 保持到 req end
              input.pipe(stdin)
              return exec.exec(namespace, pod, container, ['sh', '-c', 'cat > "$1"', 'podfile-upload', path], null, stderrSink, stdin, false)
            },
          })
          return sendJson(res, 200, { ...r, path })
        } catch (error) {
          console.error('[podfile/upload]', error?.status || '', error?.message || error)
          if (error.canceled) return sendJson(res, 499, { message: '客户端中断上传' })
          return sendJson(res, error.status || 502, { message: error?.message || '上传失败' })
        }
      }
```

替换既有 `if (action === 'download')` 分支(原 execCapture cat + 16MB 硬编码整块删除):

```js
      if (action === 'download') {
        // 流式:先 stat 大小(404/413 在头部发出前判定),再 exec base64 输出逐行解码转发(见 podfile-stream)
        const stat = await execCapture(session, namespace, pod, container, ['sh', '-c', 'wc -c < "$1"', 'wc', path], true)
        const statBytes = parseInt(stat.stdout.toString('utf8').trim(), 10)
        const base = ((path.split('/').pop() || 'download').replace(/[^\w.-]/g, '_')) || 'download'
        try {
          await streamDownload({
            statBytes, limitBytes: getPodfileLimitBytes(), res, filename: base,
            openConn: async (stdoutSink, stderrSink) => {   // async:streamDownload 内 await openConn,兼容 k8sClient() 异步加载
              const { KubeConfig, Exec } = await k8sClient()
              const exec = new Exec(buildKubeConfig(KubeConfig, session))
              return exec.exec(namespace, pod, container, ['sh', '-c', 'base64 "$1"', 'base64', path], stdoutSink, stderrSink, new PassThrough(), true)
            },
          })
        } catch (error) {
          console.error('[podfile/download]', error?.status || '', error?.message || error)
          if (!res.headersSent) return sendJson(res, error.status || 502, { message: error?.message || '下载失败' })
        }
        return
      }
```

- [ ] **Step 3: admin.mjs 加 podfile-config 端点**

`server/routes/admin.mjs` 的 mcp-config PUT 块之后加(依赖均已注入 deps):

```js
    if (url.pathname === '/api/admin/podfile-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const mb = limitMbFromValue(getSetting('podfile.limitMb')) ?? PODFILE_LIMIT_DEFAULT_MB
      sendJson(res, 200, { limitMb: mb })
      return true
    }
    if (url.pathname === '/api/admin/podfile-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const mb = limitMbFromValue(input.limitMb)
        if (!mb) { sendJson(res, 400, { message: 'limitMb 须为 1-10240 的整数(MB)' }); return true }
        setSetting('podfile.limitMb', String(mb))
        sendJson(res, 200, { ok: true, limitMb: mb })
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
```

admin.mjs 顶部 import + deps 解构各加一行:

```js
import { limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB } from '../podfile-stream.mjs'
```

- [ ] **Step 4: 验证**

Run: `npm test`、`npm run typecheck`
Expected: 全绿(既有 server 测试无回归;node --check 过)

- [ ] **Step 5: 提交**

```bash
git add server/index.mjs server/routes/admin.mjs
git commit -m "feat(server): podfile 下载流式化+二进制流式上传端点+限额设置(默认1GB,admin可调)"
```

---

### Task 3: src/api/http.js —— downloadStream / uploadBinary 原语

**Files:**
- Modify: `src/api/http.js`(createHttp 内,`blob` 之后)
- Test: `src/api/__tests__/http.stream.test.js`

**Interfaces:**
- Consumes: 既有 `authHeaders/parseBody/onUnauthorized/i18n`
- Produces(Task 4 经 client.js 消费,挂到 createHttp 返回对象):
  - `downloadStream(path, { body, onProgress, signal }): Promise<Blob>` —— onProgress({received, total}),total=0 表不确定
  - `uploadBinary(path, file, { onProgress, signal }, createXhr = () => new XMLHttpRequest()): Promise<解析后JSON>` —— 错误抛带 `.status`;abort 抛 `{aborted:true}`

- [ ] **Step 1: 写失败测试**

```js
// src/api/__tests__/http.stream.test.js
// http 流式原语:downloadStream(stub fetch+reader 逐块)/ uploadBinary(注入 fake XHR)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHttp } from '../http'

// 可控 Response fake:ok 流按 chunks 顺序出块
function streamResponse(chunks, { total }) {
  let i = 0
  return {
    ok: true, status: 200,
    headers: { get: k => (k === 'content-length' ? (total ? String(total) : null) : 'application/octet-stream') },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
  }
}
const enc = s => new TextEncoder().encode(s)
describe('downloadStream', () => {
  beforeEach(() => vi.unstubAllGlobals())
  it('逐块 onProgress + Blob', async () => {
    const http = createHttp({ resolveAuth: () => ({ authorization: 'Bearer t' }) })
    const progress = []
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([enc('ab'), enc('cd')], { total: 4 })))
    const blob = await http.downloadStream('/d', { body: {}, onProgress: p => progress.push({ ...p }) })
    expect(progress).toEqual([{ received: 2, total: 4 }, { received: 4, total: 4 }])
    expect(blob.size).toBe(4)
    expect(await blob.text()).toBe('abcd')
  })
  it('非 2xx 抛 status', async () => {
    const http = createHttp({})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 413,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: '文件过大' }),
    })))
    await expect(http.downloadStream('/d', {})).rejects.toMatchObject({ status: 413, message: '文件过大' })
  })
})

describe('uploadBinary', () => {
  function fakeXhrFactory() {
    const made = []
    const factory = () => {
      const x = {
        status: 0, responseText: '', upload: {}, sent: null, headers: {},
        open(_m, u) { x.url = u }, setRequestHeader(k, v) { x.headers[k] = v },
        send(b) { made.push(x); x.sent = b },
        abort() { x.aborted = true; x.onabort?.() },
        ok(json, status = 200) { x.status = status; x.responseText = JSON.stringify(json); x.onload?.() },
      }
      return x
    }
    factory.made = made
    return factory
  }
  it('进度透传 + resolve JSON + auth 头', async () => {
    const http = createHttp({ resolveAuth: () => ({ authorization: 'Bearer t' }) })
    const f = fakeXhrFactory()
    const progress = []
    const p = http.uploadBinary('/u', new Blob(['xy']), { onProgress: pr => progress.push({ ...pr }) }, f)
    const x = f.made[0]
    expect(x.headers.authorization).toBe('Bearer t')
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    x.ok({ ok: true, bytes: 2 })
    await expect(p).resolves.toEqual({ ok: true, bytes: 2 })
    expect(progress).toEqual([{ received: 1, total: 2 }])
  })
  it('abort → {aborted:true}', async () => {
    const http = createHttp({})
    const f = fakeXhrFactory()
    const p = http.uploadBinary('/u', new Blob(['x']), {}, f)
    const ctl = { listeners: {}, addEventListener(_, fn) { this.listeners.ab = fn } }
    // 直接调 abort 路径:send 后立刻 abort
    const x = f.made[0]
    const p2 = http.uploadBinary('/u', new Blob(['x']), { signal: ctl }, f)
    ctl.listeners.ab()                       // signal abort → xhr.abort()
    await expect(p2).rejects.toMatchObject({ aborted: true })
    x.ok({})                                 // p 未 abort,正常完成
    await expect(p).resolves.toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/api/__tests__/http.stream.test.js`
Expected: FAIL —— `http.downloadStream is not a function`

- [ ] **Step 3: 实现(createHttp 内 blob 之后,return 加两项)**

```js
  // 流式下载:fetch + reader 逐块读,onProgress({received,total});完成返回 Blob。
  // total 来自 content-length(缺失/0 → 不确定态,调用方只显示已收字节)。
  async function downloadStream(path, { body, onProgress, signal } = {}) {
    const headers = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
    }
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined, signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) onUnauthorized?.(path, response)
      const b = parseBody(text)
      throw Object.assign(new Error(b?.message || i18n.global.t('api.downloadFailed', { status: response.status })), { status: response.status, details: b })
    }
    const total = parseInt(response.headers.get('content-length') || '0', 10) || 0
    const reader = response.body?.getReader?.()
    if (!reader) return response.blob()
    const chunks = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      onProgress?.({ received, total })
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' })
  }

  // 二进制流式上传:XHR(fetch 拿不到上传进度)。createXhr 可注入(测试)。
  function uploadBinary(path, file, { onProgress, signal } = {}, createXhr = () => new XMLHttpRequest()) {
    return new Promise((resolve, reject) => {
      const xhr = createXhr()
      const onAbort = () => xhr.abort()
      signal?.addEventListener('abort', onAbort)
      const detach = () => signal?.removeEventListener?.('abort', onAbort)
      xhr.open('POST', `${baseUrl}${path}`)
      for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.({ received: e.loaded, total: e.total }) }
      xhr.onload = () => {
        detach()
        const b = parseBody(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) return resolve(b)
        if (xhr.status === 401) onUnauthorized?.(path, { status: 401 })
        reject(Object.assign(new Error(b?.message || i18n.global.t('api.requestFailed', { status: xhr.status })), { status: xhr.status, details: b }))
      }
      xhr.onerror = () => { detach(); reject(Object.assign(new Error(i18n.global.t('api.downloadFailed', { status: 0 })), { status: 0 })) }
      xhr.onabort = () => { detach(); reject(Object.assign(new Error('aborted'), { aborted: true })) }
      xhr.send(file)
    })
  }

  return { request, blob, downloadStream, uploadBinary, authHeaders, baseUrl }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/api/__tests__/http.stream.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/http.js src/api/__tests__/http.stream.test.js
git commit -m "feat(api): http 原语 downloadStream(流式进度 Blob)/uploadBinary(XHR 上传进度)"
```

---

### Task 4: client.js 扩展 + stores/transfers.js —— 传输任务 store

**Files:**
- Modify: `src/api/client.js`(podFileApi 增两方法)
- Create: `src/stores/transfers.js`
- Test: `src/stores/__tests__/transfers.test.js`

**Interfaces:**
- Consumes(Task 3 原语,经 k8sHttp 实例):client.js 内部持有
- Produces(Task 8/9 消费):
  - `podFileApi.downloadStream(payload, { onProgress, signal }): Promise<Blob>`、`podFileApi.uploadStream({ namespace, pod, container, path }, file, { onProgress, signal }): Promise<{ok,path,bytes}>`
  - `useTransferStore`:`{ tasks, panelOpen, openPanel(), startDownload(ctx, path), startUpload(ctx, { dir, path, file }), cancel(id), remove(id), clearFinished(), aggregate }`
  - task 字段:`{ id, kind:'download'|'upload', name, namespace, pod, container, path, dir(仅upload), received, total, status:'active'|'done'|'error'|'canceled', error, startedAt, finishedAt, speed }`
  - `aggregate` computed:`{ count, doneCount, activeCount, received, total, pct|null }`(pct 排除 total=0 任务,无已知总量→null)
  - 纯函数导出:`fmtBytes(n): string`、`speedFromSamples(samples, now): number`

- [ ] **Step 1: client.js 扩展(podFileApi 对象内加)**

```js
export const podFileApi = {
  list: ..., read: ..., write: ..., download: ...,        // 既有不动(download 兜底保留)
  // 流式下载(进度):POST JSON → Blob,onProgress({received,total})
  downloadStream: (payload, { onProgress, signal } = {}) =>
    k8sHttp.downloadStream('/api/podfile/download', { body: payload, onProgress, signal }),
  // 流式上传(进度):元信息查询串 + 原始文件体
  uploadStream: ({ namespace, pod, container, path }, file, { onProgress, signal } = {}) => {
    const q = new URLSearchParams({ namespace, pod, container: container || '', path })
    return k8sHttp.uploadBinary(`/api/podfile/upload?${q}`, file, { onProgress, signal })
  },
}
```

- [ ] **Step 2: 写失败测试**

```js
// src/stores/__tests__/transfers.test.js
// transfers store:任务状态机(active→done/error/canceled)/进度速度/取消/汇总;client 全 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { fmtBytes, speedFromSamples } from '../transfers'

vi.mock('@/api/client', () => ({
  podFileApi: {
    downloadStream: vi.fn(),
    uploadStream: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
import { useTransferStore } from '../transfers'

function deferred() { let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j }); return { p, resolve, reject } }

describe('fmtBytes/speedFromSamples', () => {
  it('fmtBytes', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
  it('speedFromSamples:3s 窗口内 Δbytes/Δt', () => {
    const s = [{ t: 1000, received: 0 }, { t: 2000, received: 1024 }, { t: 4000, received: 1024 + 3 * 1024 }]
    expect(speedFromSamples(s, 4000)).toBeCloseTo(2048, 5)   // (4096-0)/2s
  })
})

describe('useTransferStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('startDownload:active 任务 + 进度更新 + 完成 done + 落盘', async () => {
    const d = deferred()
    podFileApi.downloadStream.mockImplementation((_p, { onProgress }) => {
      onProgress({ received: 5, total: 10 }); onProgress({ received: 10, total: 10 })
      return d.p
    })
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const s = useTransferStore()
    s.startDownload({ namespace: 'ns', pod: 'p', container: 'c' }, '/etc/app.conf')
    const t = s.tasks[0]
    expect(t).toMatchObject({ kind: 'download', name: 'app.conf', status: 'active', received: 10, total: 10, namespace: 'ns' })
    d.resolve(new Blob(['x']))
    await vi.waitFor(() => expect(s.tasks[0].status).toBe('done'))
    expect(save).toHaveBeenCalled()
    urlSpy.mockRestore(); save.mockRestore()
  })

  it('下载失败 → error + error message;aborted → canceled', async () => {
    const d1 = deferred(), d2 = deferred()
    let n = 0
    podFileApi.downloadStream.mockImplementation(() => (++n === 1 ? d1.p : d2.p))
    const s = useTransferStore()
    s.startDownload({ namespace: 'ns', pod: 'p', container: '' }, '/a')
    s.startDownload({ namespace: 'ns', pod: 'p', container: '' }, '/b')
    d1.reject(Object.assign(new Error('超限'), { status: 413 }))
    d2.reject(Object.assign(new Error('aborted'), { aborted: true }))
    await vi.waitFor(() => expect(s.tasks.every(t => t.status !== 'active')).toBe(true))
    expect(s.tasks[0]).toMatchObject({ status: 'error', error: '超限' })
    expect(s.tasks[1].status).toBe('canceled')
  })

  it('startUpload:进度/完成 dir 记录;cancel 走 abort', async () => {
    const d = deferred()
    podFileApi.uploadStream.mockImplementation((_meta, _f, { onProgress, signal }) => {
      onProgress({ received: 3, total: 3 })
      signal.addEventListener('abort', () => d.reject(Object.assign(new Error('aborted'), { aborted: true })))
      return d.p
    })
    const s = useTransferStore()
    s.startUpload({ namespace: 'ns', pod: 'p', container: 'c' }, { dir: '/data', path: '/data/f.bin', file: { name: 'f.bin', size: 3 } })
    expect(s.tasks[0]).toMatchObject({ kind: 'upload', status: 'active', received: 3, total: 3, dir: '/data' })
    s.cancel(s.tasks[0].id)
    await vi.waitFor(() => expect(s.tasks[0].status).toBe('canceled'))
  })

  it('aggregate:多任务字节加权,total=0 不入分母;clearFinished/remove', () => {
    const s = useTransferStore()
    s.tasks.push(
      { id: '1', kind: 'download', status: 'done', received: 100, total: 100 },
      { id: '2', kind: 'download', status: 'active', received: 50, total: 200 },
      { id: '3', kind: 'download', status: 'active', received: 7, total: 0 },
    )
    const a = s.aggregate
    expect(a).toMatchObject({ count: 3, doneCount: 1, activeCount: 2, received: 150, total: 300 })
    expect(a.pct).toBe(50)
    s.clearFinished()
    expect(s.tasks.length).toBe(2)
    s.remove('2')
    expect(s.tasks.length).toBe(1)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/transfers.test.js`
Expected: FAIL —— `Cannot find module '../transfers'`

- [ ] **Step 4: 实现 stores/transfers.js**

```js
// 传输任务 store(内存态):下载 fetch 流式 / 上传 XHR 进度,任务跑在 store 里与组件生命周期解耦。
// 刷新即清(fetch/XHR 无法幸存,不做持久化);完成下载经 Blob+a.download 落盘(浏览器下载栏即刻出现完整文件)。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { podFileApi } from '@/api/client'

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// samples: [{t(ms), received}],取最近 ~3s 窗口算 bytes/s;样本不足 → 0
export function speedFromSamples(samples, now) {
  if (samples.length < 2) return 0
  const first = samples.find(s => now - s.t <= 3000) || samples[0]
  const last = samples[samples.length - 1]
  const dt = (last.t - first.t) / 1000
  if (dt <= 0) return 0
  return Math.max(0, (last.received - first.received) / dt)
}

let seq = 0
const controllers = new Map()   // id → AbortController

// Blob 落盘:浏览器下载栏瞬间出现完整文件(流式期间用户一直看的是应用内进度)
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

export const useTransferStore = defineStore('transfers', () => {
  const tasks = ref([])
  const panelOpen = ref(false)

  function patch(id, p) {
    const t = tasks.value.find(x => x.id === id)
    if (t) Object.assign(t, p)   // 经 tasks.value 代理改,保证响应式
  }
  function pushSample(t, received) {
    const samples = t._samples || (t._samples = [])
    samples.push({ t: Date.now(), received })
    while (samples.length > 60) samples.shift()
    t.speed = speedFromSamples(samples, Date.now())
  }
  // 注意:pushSample 需拿代理对象 —— 调用方统一从 tasks.value find 后再传
  function tracked(id) { return tasks.value.find(x => x.id === id) }

  function startDownload(ctx, path) {
    const id = `dl-${Date.now().toString(36)}-${++seq}`
    const name = (path.split('/').pop() || path)
    tasks.value.push({ id, kind: 'download', name, namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path, dir: '', received: 0, total: 0, status: 'active', error: '', startedAt: Date.now(), finishedAt: 0, speed: 0 })
    const ctl = new AbortController()
    controllers.set(id, ctl)
    podFileApi.downloadStream({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path }, {
      onProgress: ({ received, total }) => { const t = tracked(id); if (t) { t.received = received; t.total = total; pushSample(t, received) } },
      signal: ctl.signal,
    })
      .then(blob => { const t = tracked(id); if (t) { patch(id, { status: 'done', finishedAt: Date.now() }) ; saveBlob(blob, name) } })
      .catch(e => { const t = tracked(id); if (t) patch(id, { status: e?.aborted ? 'canceled' : 'error', error: e?.message || '', finishedAt: Date.now() }) })
      .finally(() => controllers.delete(id))
    return tracked(id)
  }

  function startUpload(ctx, { dir, path, file }) {
    const id = `ul-${Date.now().toString(36)}-${++seq}`
    tasks.value.push({ id, kind: 'upload', name: file.name, namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path, dir, received: 0, total: file.size || 0, status: 'active', error: '', startedAt: Date.now(), finishedAt: 0, speed: 0 })
    const ctl = new AbortController()
    controllers.set(id, ctl)
    podFileApi.uploadStream({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container || '', path }, file, {
      onProgress: ({ received, total }) => { const t = tracked(id); if (t) { t.received = received; t.total = total || t.total; pushSample(t, received) } },
      signal: ctl.signal,
    })
      .then(() => patch(id, { status: 'done', received: file.size || 0, finishedAt: Date.now() }))
      .catch(e => patch(id, { status: e?.aborted ? 'canceled' : 'error', error: e?.message || '', finishedAt: Date.now() }))
      .finally(() => controllers.delete(id))
    return tracked(id)
  }

  function cancel(id) { controllers.get(id)?.abort() }
  function remove(id) { const i = tasks.value.findIndex(t => t.id === id); if (i !== -1) tasks.value.splice(i, 1) }
  function clearFinished() { tasks.value = tasks.value.filter(t => t.status === 'active') }
  function openPanel() { panelOpen.value = true }

  const aggregate = computed(() => {
    const known = tasks.value.filter(t => t.total > 0)
    const received = known.reduce((s, t) => s + t.received, 0)
    const total = known.reduce((s, t) => s + t.total, 0)
    return {
      count: tasks.value.length,
      doneCount: tasks.value.filter(t => t.status === 'done').length,
      activeCount: tasks.value.filter(t => t.status === 'active').length,
      received, total,
      pct: total > 0 ? Math.round((received / total) * 100) : null,
    }
  })

  return { tasks, panelOpen, openPanel, startDownload, startUpload, cancel, remove, clearFinished, aggregate }
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/transfers.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/api/client.js src/stores/transfers.js src/stores/__tests__/transfers.test.js
git commit -m "feat(store): transfers 传输任务——进度/速度/取消/汇总,下载落盘/上传任务化"
```

---

### Task 5: FloatingWindow.vue 抽壳 + TerminalWindow 重构

**Files:**
- Create: `src/components/common/FloatingWindow.vue`
- Modify: `src/components/terminal/TerminalWindow.vue`(整文件重写为壳+终端体)
- Test: `src/components/common/__tests__/FloatingWindow.test.js`

**Interfaces:**
- Consumes: 无
- Produces(Task 7/8 消费):
  - props:`{ title, subtitle='', icon='window', zIndex=40, width='720px', height='460px', cascadeIndex=0, maximizeTitle='', minimizeTitle='', closeTitle='' }`
  - emits:`['focus', 'minimize', 'close']`(单击任意处即 focus)
  - slots:`default`(窗体)、`title`(自定义标题区,终端放可编辑名)、`title-actions`(标题栏按钮区左侧扩展)
  - 内置:标题栏拖拽、最大化/还原按钮(内部 isMax,双击语义不占用——终端双击=改名保持)

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/FloatingWindow.test.js
// 壳组件契约:按钮 emits/最大化切换/拖拽位移/slot 透传。
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'

const props = { title: 'T', zIndex: 42 }

describe('FloatingWindow', () => {
  it('最小化/关闭按钮 emit;mousedown emit focus', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    await w.find('[data-test="btn-minimize"]').trigger('click')
    await w.find('[data-test="btn-close"]').trigger('click')
    await w.find('[data-test="window"]').trigger('mousedown')
    expect(w.emitted('minimize')).toHaveLength(1)
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('focus')).toHaveLength(1)
    w.unmount()
  })
  it('最大化切换:winStyle 从定位尺寸变为 inset 铺满', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    expect(w.vm.winStyle).toMatchObject({ left: '80px', width: '720px' })
    await w.find('[data-test="btn-maximize"]').trigger('click')
    expect(w.vm.winStyle).toMatchObject({ right: '8px', zIndex: 42 })
    w.unmount()
  })
  it('拖拽:标题栏 mousedown + document mousemove 改 left/top', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    await w.find('[data-test="titlebar"]').trigger('mousedown', { clientX: 100, clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '140px', top: '120px' })
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })
  it('slots:default 与 title-actions 渲染', () => {
    const w = mount(FloatingWindow, {
      props,
      slots: { default: '<div id="body">BODY</div>', 'title-actions': '<button id="x">X</button>' },
    })
    expect(w.find('#body').exists()).toBe(true)
    expect(w.find('#x').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/FloatingWindow.test.js`
Expected: FAIL —— `Cannot find module '../FloatingWindow.vue'`

- [ ] **Step 3: 实现 FloatingWindow.vue**

```vue
<script setup>
// 通用浮动窗口壳:标题栏拖拽/最大化/最小化/关闭/z-index 置顶。从 TerminalWindow 抽取,
// 终端与文件浏览窗口共用。双击语义留给内容方(终端标题双击=改名);title/title-actions 插槽自定义。
import { ref, computed, onUnmounted } from 'vue'

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  icon: { type: String, default: 'window' },
  zIndex: { type: Number, default: 40 },
  width: { type: String, default: '720px' },
  height: { type: String, default: '460px' },
  cascadeIndex: { type: Number, default: 0 },
  maximizeTitle: { type: String, default: '' },
  minimizeTitle: { type: String, default: '' },
  closeTitle: { type: String, default: '' },
})
const emit = defineEmits(['focus', 'minimize', 'close'])

const isMax = ref(false)
const pos = ref({
  x: Math.min(80 + (props.cascadeIndex % 5) * 30, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 740),
  y: Math.min(80 + (props.cascadeIndex % 5) * 25, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 480),
})

// —— 拖拽(仅非全屏) ——
let dragging = false, dragStart = null
function onDragStart(e) {
  if (isMax.value) return
  dragging = true
  dragStart = { x: e.clientX - pos.value.x, y: e.clientY - pos.value.y }
  emit('focus')
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
}
function onDragMove(e) { if (dragging) pos.value = { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y } }
function onDragEnd() {
  dragging = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}
onUnmounted(() => { document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd) })

const winStyle = computed(() => isMax.value
  ? { left: '8px', top: '8px', right: '8px', bottom: '44px', zIndex: props.zIndex }
  : { left: pos.value.x + 'px', top: pos.value.y + 'px', width: props.width, height: props.height, zIndex: props.zIndex })
</script>
<template>
  <div data-test="window" class="fixed flex flex-col bg-surface-container-lowest rounded-lg shadow-2xl border border-outline-variant overflow-hidden"
       :style="winStyle" @mousedown="emit('focus')">
    <div data-test="titlebar" class="flex items-center gap-xs px-md py-1.5 bg-surface-container-high border-b border-outline-variant cursor-move select-none shrink-0" @mousedown="onDragStart">
      <span class="material-symbols-outlined text-base text-primary">{{ icon }}</span>
      <slot name="title">
        <span class="flex-1 text-body-sm font-medium text-on-surface truncate" :title="title">
          {{ title }}<span v-if="subtitle" class="text-on-surface-variant/50 text-body-xs ml-xs">{{ subtitle }}</span>
        </span>
      </slot>
      <slot name="title-actions" />
      <button data-test="btn-maximize" @click="isMax = !isMax" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" :title="maximizeTitle">
        <span class="material-symbols-outlined text-base">{{ isMax ? 'fullscreen_exit' : 'fullscreen' }}</span>
      </button>
      <button data-test="btn-minimize" @click="emit('minimize')" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface" :title="minimizeTitle">
        <span class="material-symbols-outlined text-base">remove</span>
      </button>
      <button data-test="btn-close" @click="emit('close')" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error" :title="closeTitle">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
    <div class="flex-1 min-h-0 p-0"><slot /></div>
  </div>
</template>
```

- [ ] **Step 4: 重写 TerminalWindow.vue(行为不变:改名/新标签页/refit/全屏)**

```vue
<script setup>
// 浮动终端窗口:FloatingWindow 壳 + InteractiveTerminal。改名(双击标题)/新标签页在插槽注入。
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { useTerminalStore } from '@/stores/terminals'

const { t } = useI18n()
const props = defineProps({ terminal: { type: Object, required: true } })
const termStore = useTerminalStore()
const termRef = ref(null)

const editing = ref(false)
const nameInput = ref(props.terminal.name)

// minimized → open:xterm 重新 fit(display:none→block 时 ResizeObserver 可能漏触发)
let refitTimer = null
watch(() => props.terminal.status, (s) => {
  if (s === 'open') {
    if (refitTimer) clearTimeout(refitTimer)
    nextTick(() => {
      refitTimer = setTimeout(() => {
        try { termRef.value?.refit() } catch { /* noop */ }
        refitTimer = null
      }, 50)
    })
  }
})

function saveName() {
  const v = nameInput.value.trim()
  if (v && v !== props.terminal.name) termStore.renameTerminal(props.terminal.id, v)
  editing.value = false
}
</script>

<template>
  <FloatingWindow
    :z-index="terminal.zIndex" icon="terminal" width="720px" height="460px"
    :cascade-index="termStore.terminals.indexOf(terminal)"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('terminal.closeTerminalTitle')"
    @focus="termStore.focusTerminal(terminal.id)"
    @minimize="termStore.minimizeTerminal(terminal.id)"
    @close="termStore.closeTerminal(terminal.id)"
  >
    <template #title>
      <input v-if="editing" v-model="nameInput" @blur="saveName" @keydown.enter="saveName" @keydown.esc="editing = false"
             class="flex-1 bg-surface-container-lowest border border-primary rounded px-sm py-0.5 text-body-sm font-mono focus:outline-none" />
      <span v-else @dblclick="editing = true; nameInput = terminal.name" class="flex-1 text-body-sm font-medium text-on-surface truncate" :title="t('terminal.dblClickRename', { name: terminal.name })">
        {{ terminal.name.length > 30 ? terminal.name.slice(0, 28) + '…' : terminal.name }}
        <span class="text-on-surface-variant/50 text-body-xs ml-xs">{{ terminal.namespace }}</span>
      </span>
    </template>
    <template #title-actions>
      <button @click="termStore.openExternal(terminal.id)" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" :title="t('terminal.openInNewTabTitle')">
        <span class="material-symbols-outlined text-base">open_in_new</span>
      </button>
    </template>
    <InteractiveTerminal ref="termRef" :pod-name="terminal.podName" :namespace="terminal.namespace" :container="terminal.container" :session-id="terminal.id" :auto-connect="true" />
  </FloatingWindow>
</template>
```

- [ ] **Step 5: 跑测试 + 终端回归**

Run: `npx vitest run src/components/common/__tests__/FloatingWindow.test.js && npm run test:unit && npm run build`
Expected: 全绿(既有终端相关单测若有亦不回归;build 验证 .vue 编译)

- [ ] **Step 6: 提交**

```bash
git add src/components/common/FloatingWindow.vue src/components/common/__tests__/FloatingWindow.test.js src/components/terminal/TerminalWindow.vue
git commit -m "refactor(ui): 抽 FloatingWindow 壳,TerminalWindow 改为壳+终端体(行为不变)"
```

---

### Task 6: file_browsers 表 + CRUD 端点 + fileBrowserApi

**Files:**
- Modify: `server/index.mjs`(terminals 建表后 + terminals 路由后)
- Modify: `src/api/client.js`(terminalApi 后)

**Interfaces:**
- Consumes: 既有 `db/sendJson/readBody/sessionFromRequest/randomUUID`
- Produces(Task 7 消费):
  - `GET /api/file-browsers` → `{ browsers: [...] }`(全部 minimized)
  - `POST /api/file-browsers`(body: 前端生成的完整 session 对象)→ 原样入库回显
  - `PATCH /api/file-browsers/:id`(body: `{name?, status?}`)→ `{ok:true}`
  - `DELETE /api/file-browsers/:id` → `{ok:true}`
  - `fileBrowserApi.{list, create, update, remove}`(client.js,签名同 terminalApi)

- [ ] **Step 1: 建表(terminals 表定义之后)**

```js
db.exec(`CREATE TABLE IF NOT EXISTS file_browsers (
  id TEXT PRIMARY KEY,
  sessionToken TEXT NOT NULL,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  podName TEXT NOT NULL,
  container TEXT,
  status TEXT DEFAULT 'minimized',
  createdAt INTEGER NOT NULL
)`)
```

- [ ] **Step 2: CRUD 路由(terminals 路由块之后,同构简化——无 tmux/external 逻辑)**

```js
  // === 文件浏览窗口管理(任务栏:CRUD + 持久化,与 terminals 同构;无 WS 会话,DELETE 仅删行) ===
  if (url.pathname === '/api/file-browsers') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    try {
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM file_browsers WHERE sessionToken = ? ORDER BY createdAt').all(token)
        return sendJson(res, 200, { browsers: rows.map(r => ({ ...r, status: 'minimized' })) })  // 刷新后全部最小化
      }
      if (req.method === 'POST') {
        const input = await readBody(req)
        const b = {
          id: input.id || `fb-${randomUUID().slice(0, 8)}`, sessionToken: token,
          name: input.name || `${input.podName}/${input.container || 'main'}`,
          namespace: input.namespace, podName: input.podName, container: input.container || '',
          status: 'open', createdAt: Date.now(),
        }
        db.prepare('INSERT INTO file_browsers (id, sessionToken, name, namespace, podName, container, status, createdAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(b.id, b.sessionToken, b.name, b.namespace, b.podName, b.container, b.status, b.createdAt)
        return sendJson(res, 200, b)
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '文件窗口操作失败' }) }
  }
  if (url.pathname.startsWith('/api/file-browsers/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const id = decodeURIComponent(url.pathname.slice('/api/file-browsers/'.length))
    try {
      if (req.method === 'PATCH') {
        const input = await readBody(req)
        const fields = [], vals = []
        for (const k of ['name', 'status']) { if (input[k] != null) { fields.push(`${k} = ?`); vals.push(input[k]) } }
        if (!fields.length) return sendJson(res, 400, { message: '无更新字段' })
        vals.push(id, token)
        db.prepare(`UPDATE file_browsers SET ${fields.join(', ')} WHERE id = ? AND sessionToken = ?`).run(...vals)
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM file_browsers WHERE id = ? AND sessionToken = ?').run(id, token)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '文件窗口操作失败' }) }
  }
```

- [ ] **Step 3: client.js fileBrowserApi(terminalApi 之后)**

```js
// 文件浏览窗口管理(任务栏:CRUD + 持久化,与 terminalApi 同构)
export const fileBrowserApi = {
  list: () => k8sHttp.request('/api/file-browsers'),
  create: b => k8sHttp.request('/api/file-browsers', { method: 'POST', body: JSON.stringify(b) }),
  update: (id, patch) => k8sHttp.request(`/api/file-browsers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: id => k8sHttp.request(`/api/file-browsers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
```

- [ ] **Step 4: 验证 + 提交**

Run: `npm run typecheck && npm run test:unit`
Expected: 全绿(client.js 被既有测试 import,不应回归)

```bash
git add server/index.mjs src/api/client.js
git commit -m "feat(server/api): file_browsers 表+CRUD 端点+fileBrowserApi(照 terminals 同构)"
```

---

### Task 7: fileBrowsers store + FileBrowserWindow + 入口改造

**Files:**
- Create: `src/stores/fileBrowsers.js`、`src/components/common/FileBrowserWindow.vue`
- Modify: `src/components/layout/AppLayout.vue`、`src/components/common/PodCard.vue`、`src/views/NsWorkloadDetail.vue`
- Delete: `src/components/common/FileBrowser.vue`
- Test: `src/stores/__tests__/fileBrowsers.test.js`

**Interfaces:**
- Consumes: Task 5 `FloatingWindow`、Task 6 `fileBrowserApi`、既有 `FileBrowserBody`(props: namespace/pod/container)
- Produces(Task 8 消费):
  - `useFileBrowserStore`:`{ browsers, loadPersisted(), openBrowser({namespace,podName,container}), closeBrowser(id), minimizeBrowser(id), restoreBrowser(id), focusBrowser(id) }`
  - FileBrowserWindow props:`{ browser }`(store 里的 session 对象)

- [ ] **Step 1: 写失败测试**

```js
// src/stores/__tests__/fileBrowsers.test.js
// fileBrowsers store:去重聚焦/最小化恢复/持久化调用(api 全 mock)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({
  fileBrowserApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
import { fileBrowserApi } from '@/api/client'
import { useFileBrowserStore } from '../fileBrowsers'

describe('useFileBrowserStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('openBrowser:新建 open 任务并持久化;同 pod+container 去重聚焦', () => {
    const s = useFileBrowserStore()
    s.openBrowser({ namespace: 'ns', podName: 'p1', container: 'c1' })
    expect(s.browsers).toHaveLength(1)
    expect(s.browsers[0]).toMatchObject({ namespace: 'ns', podName: 'p1', container: 'c1', status: 'open' })
    expect(fileBrowserApi.create).toHaveBeenCalledTimes(1)
    s.minimizeBrowser(s.browsers[0].id)
    const again = s.openBrowser({ namespace: 'ns', podName: 'p1', container: 'c1' })
    expect(s.browsers).toHaveLength(1)
    expect(again.status).toBe('open')
    expect(fileBrowserApi.create).toHaveBeenCalledTimes(1)          // 未重复建
    expect(fileBrowserApi.update).toHaveBeenCalledWith(s.browsers[0].id, { status: 'open' })
  })
  it('minimize/restore/close:状态流转 + 持久化', () => {
    const s = useFileBrowserStore()
    const b = s.openBrowser({ namespace: 'ns', podName: 'p', container: '' })
    s.minimizeBrowser(b.id)
    expect(s.browsers[0].status).toBe('minimized')
    s.restoreBrowser(b.id)
    expect(s.browsers[0].status).toBe('open')
    s.closeBrowser(b.id)
    expect(s.browsers).toHaveLength(0)
    expect(fileBrowserApi.remove).toHaveBeenCalledWith(b.id)
  })
  it('loadPersisted:恢复为 minimized', async () => {
    fileBrowserApi.list.mockResolvedValue({ browsers: [{ id: 'x', name: 'p/c', namespace: 'ns', podName: 'p', container: 'c', status: 'open', createdAt: 1 }] })
    const s = useFileBrowserStore()
    await s.loadPersisted()
    expect(s.browsers[0].status).toBe('minimized')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/fileBrowsers.test.js`
Expected: FAIL —— `Cannot find module '../fileBrowsers'`

- [ ] **Step 3: 实现 stores/fileBrowsers.js**

```js
// 文件浏览窗口管理:照 terminals 平行(浮动窗口/最小化任务栏/SQLite 持久化刷新恢复)。
// 窗口体(FileBrowserBody)经 AppLayout v-show 挂载,最小化不销毁 → 树展开/选中状态天然同步。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fileBrowserApi } from '@/api/client'

export const useFileBrowserStore = defineStore('fileBrowsers', () => {
  const browsers = ref([])   // [{id, name, namespace, podName, container, status, zIndex, createdAt}]
  let nextZ = 40             // 与终端同一层级:内容之上、模态框(z-100)之下

  async function persistCreate(b) { try { await fileBrowserApi.create(b) } catch { /* 离线静默 */ } }
  async function persistUpdate(id, patch) { try { await fileBrowserApi.update(id, patch) } catch { /* noop */ } }
  async function persistDelete(id) { try { await fileBrowserApi.remove(id) } catch { /* noop */ } }

  async function loadPersisted() {
    try {
      const res = await fileBrowserApi.list()
      const loaded = (res?.browsers || []).map(b => ({ ...b, status: 'minimized', zIndex: 0 }))  // 刷新后全最小化
      browsers.value = loaded
      if (loaded.length) nextZ = 100 + loaded.length
    } catch { /* 离线静默 */ }
  }

  // 打开(同 pod+container 去重聚焦)
  function openBrowser({ namespace, podName, container }) {
    const existing = browsers.value.find(b =>
      b.namespace === namespace && b.podName === podName && (b.container || '') === (container || ''))
    if (existing) {
      existing.status = 'open'
      existing.zIndex = ++nextZ
      persistUpdate(existing.id, { status: 'open' })
      return existing
    }
    const b = {
      id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${podName}/${container || 'main'}`,
      namespace, podName, container: container || '',
      status: 'open', zIndex: ++nextZ, createdAt: Date.now(),
    }
    browsers.value.push(b)
    persistCreate(b)
    return b
  }

  function closeBrowser(id) {
    const idx = browsers.value.findIndex(b => b.id === id)
    if (idx !== -1) { browsers.value.splice(idx, 1); persistDelete(id) }
  }
  function minimizeBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
  }
  function restoreBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'open'; b.zIndex = ++nextZ; persistUpdate(id, { status: 'open' }) }
  }
  function focusBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) b.zIndex = ++nextZ
  }

  return { browsers, loadPersisted, openBrowser, closeBrowser, minimizeBrowser, restoreBrowser, focusBrowser }
})
```

- [ ] **Step 4: FileBrowserWindow.vue**

```vue
<script setup>
// 浮动文件浏览窗口:FloatingWindow 壳 + FileBrowserBody。最小化不销毁(v-show 由 AppLayout 控制),
// 树展开/选中状态保留;容器由打开方固定,窗口内不切换。
import { useI18n } from 'vue-i18n'
import FloatingWindow from './FloatingWindow.vue'
import FileBrowserBody from './FileBrowserBody.vue'
import { useFileBrowserStore } from '@/stores/fileBrowsers'

const { t } = useI18n()
const props = defineProps({ browser: { type: Object, required: true } })
const fbStore = useFileBrowserStore()
</script>

<template>
  <FloatingWindow
    :title="browser.name" :subtitle="browser.namespace" icon="folder_open"
    width="860px" height="540px" :z-index="browser.zIndex"
    :cascade-index="fbStore.browsers.indexOf(browser)"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('terminal.closeTerminalTitle')"
    @focus="fbStore.focusBrowser(browser.id)"
    @minimize="fbStore.minimizeBrowser(browser.id)"
    @close="fbStore.closeBrowser(browser.id)"
  >
    <FileBrowserBody :namespace="browser.namespace" :pod="browser.podName" :container="browser.container" style="height: 100%" />
  </FloatingWindow>
</template>
```

- [ ] **Step 5: AppLayout 挂载 + loadPersisted**

`src/components/layout/AppLayout.vue`:

script 增:
```js
import { useFileBrowserStore } from '@/stores/fileBrowsers'
const FileBrowserWindow = defineAsyncComponent(() => import('@/components/common/FileBrowserWindow.vue'))
const fbStore = useFileBrowserStore()
```
`onMounted` 的 `if (getSession())` 块内加一行:`fbStore.loadPersisted()`

template 终端窗口行之后加:
```html
    <!-- 浮动文件浏览窗口:v-show 保持挂载,最小化状态同步 -->
    <FileBrowserWindow v-for="b in fbStore.browsers" :key="b.id" :browser="b" v-show="b.status === 'open'" />
```

- [ ] **Step 6: 入口改造**

`src/components/common/PodCard.vue`:import 加 `import { useFileBrowserStore } from '@/stores/fileBrowsers'`,`const fbStore = useFileBrowserStore()`;`goPodTab` 函数删除(仅 files 按钮在用),改:

```js
// 文件浏览:弹浮动窗口(复用全局窗口系统:可最小化到任务栏、刷新恢复、状态同步)
function openFiles() {
  if (!canExec.value) return
  const c = containers.value?.[0]
  fbStore.openBrowser({ namespace: pod.value.namespace, podName: pod.value.name, container: (c && (c.name || c)) || 'main' })
}
```
files 按钮 `@click.stop="goPodTab('#files')"` → `@click.stop="openFiles"`。

`src/views/NsWorkloadDetail.vue`:删 `import FileBrowser from '@/components/common/FileBrowser.vue'`、`showFileBrowser` ref、模板 `<FileBrowser ... />` 行;原触发 `showFileBrowser.value = true` 处(约 547 行)改为:

```js
  fbStore.openBrowser({ namespace: route.params.namespace, podName: selectedPod.value?.name, container: fileBrowserContainer.value })
```
(补 `import { useFileBrowserStore } from '@/stores/fileBrowsers'` + `const fbStore = useFileBrowserStore()`;`fileBrowserContainer` computed 保留。)

删除 `src/components/common/FileBrowser.vue`(`git rm`)。检查无残留引用:`grep -rn "common/FileBrowser.vue" src/` 应为空。

- [ ] **Step 7: 跑测试 + 提交**

Run: `npx vitest run src/stores/__tests__/fileBrowsers.test.js && npm run test:unit && npm run build`
Expected: 全绿

```bash
git add -A
git commit -m "feat(ui): 文件浏览浮动窗口化——fileBrowsers store/窗口组件/入口改造(PodCard 弹窗,删 Modal 壳)"
```

---

### Task 8: 任务栏三分区 + TransfersPanel

**Files:**
- Modify: `src/components/terminal/TerminalTaskbar.vue`、`src/components/layout/AppLayout.vue`
- Create: `src/components/common/TransfersPanel.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(新 `transfers` 组)

**Interfaces:**
- Consumes: Task 4 `useTransferStore`(aggregate/fmtBytes)、Task 7 `useFileBrowserStore`、Task 5 `FloatingWindow`
- Produces: 任务栏三分区渲染;TransfersPanel(AppLayout 按 `transferStore.panelOpen` v-if 渲染)

- [ ] **Step 1: i18n 键(zh.json 顶层加 `transfers` 组;en.json 同结构英文)**

zh:
```json
"transfers": {
  "panelTitle": "传输任务",
  "empty": "暂无传输任务",
  "downloadLabel": "下载",
  "uploadLabel": "上传",
  "cancelTitle": "取消传输",
  "removeTitle": "从列表移除",
  "clearFinished": "清除已结束",
  "statusActive": "传输中",
  "statusDone": "已完成",
  "statusError": "失败",
  "statusCanceled": "已取消",
  "indeterminate": "已接收 {received}",
  "progressLabel": "{received} / {total}",
  "speedLabel": "{speed}/s",
  "summaryMulti": "传输 {done}/{count}",
  "openPanelTitle": "打开传输面板",
  "closeAllConfirm": "确定关闭 {count} 个会话(终端与文件窗口)?"
}
```
en:
```json
"transfers": {
  "panelTitle": "Transfers",
  "empty": "No transfers",
  "downloadLabel": "Download",
  "uploadLabel": "Upload",
  "cancelTitle": "Cancel transfer",
  "removeTitle": "Remove from list",
  "clearFinished": "Clear finished",
  "statusActive": "Transferring",
  "statusDone": "Done",
  "statusError": "Failed",
  "statusCanceled": "Canceled",
  "indeterminate": "Received {received}",
  "progressLabel": "{received} / {total}",
  "speedLabel": "{speed}/s",
  "summaryMulti": "Transfers {done}/{count}",
  "openPanelTitle": "Open transfers panel",
  "closeAllConfirm": "Close {count} sessions (terminals & file windows)?"
}
```

- [ ] **Step 2: TransfersPanel.vue**

```vue
<script setup>
// 传输面板:任务列表(进度条/速度/取消/移除)。FloatingWindow 壳,× 即关(panelOpen=false)。
import { useI18n } from 'vue-i18n'
import FloatingWindow from './FloatingWindow.vue'
import ProgressBar from './ProgressBar.vue'
import { useTransferStore, fmtBytes } from '@/stores/transfers'

const { t } = useI18n()
const tr = useTransferStore()

function pct(task) { return task.total > 0 ? Math.round((task.received / task.total) * 100) : null }
function statusLabel(s) {
  return s === 'active' ? t('transfers.statusActive') : s === 'done' ? t('transfers.statusDone')
    : s === 'canceled' ? t('transfers.statusCanceled') : t('transfers.statusError')
}
const kindIcon = k => (k === 'download' ? 'download' : 'upload')
</script>

<template>
  <FloatingWindow
    :title="t('transfers.panelTitle')" icon="swap_vert" width="480px" height="360px" :z-index="120"
    :cascade-index="9"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('common.close')"
    @focus="() => {}" @minimize="tr.panelOpen = false" @close="tr.panelOpen = false"
  >
    <div class="h-full flex flex-col min-h-0">
      <div class="flex-1 overflow-auto p-sm space-y-sm min-h-0">
        <p v-if="!tr.tasks.length" class="text-body-sm text-on-surface-variant/60 text-center py-md">{{ t('transfers.empty') }}</p>
        <div v-for="task in tr.tasks" :key="task.id" class="px-sm py-2 rounded-lg border border-outline-variant/50 bg-surface-container-low flex flex-col gap-1">
          <div class="flex items-center gap-xs">
            <span class="material-symbols-outlined text-base shrink-0" :class="task.status === 'error' ? 'text-error' : task.status === 'done' ? 'text-primary' : 'text-on-surface-variant'">{{ kindIcon(task.kind) }}</span>
            <span class="font-mono text-xs truncate flex-1" :title="`${task.namespace}/${task.pod}/${task.container}${task.path}`">{{ task.name }}</span>
            <span class="text-[10px] px-1 rounded shrink-0" :class="task.status === 'error' ? 'bg-error/10 text-error' : task.status === 'done' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ statusLabel(task.status) }}</span>
            <button v-if="task.status === 'active'" @click="tr.cancel(task.id)" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error shrink-0" :title="t('transfers.cancelTitle')">
              <span class="material-symbols-outlined text-base">close</span>
            </button>
            <button v-else @click="tr.remove(task.id)" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error shrink-0" :title="t('transfers.removeTitle')">
              <span class="material-symbols-outlined text-base">delete</span>
            </button>
          </div>
          <ProgressBar v-if="pct(task) !== null" :value="pct(task)" :show-label="false" />
          <div class="flex items-center gap-sm text-[11px] text-on-surface-variant">
            <span v-if="pct(task) !== null">{{ t('transfers.progressLabel', { received: fmtBytes(task.received), total: fmtBytes(task.total) }) }} · {{ pct(task) }}%</span>
            <span v-else>{{ t('transfers.indeterminate', { received: fmtBytes(task.received) }) }}</span>
            <span v-if="task.status === 'active' && task.speed > 0">{{ t('transfers.speedLabel', { speed: fmtBytes(task.speed) }) }}</span>
            <span v-if="task.error" class="text-error truncate" :title="task.error">{{ task.error }}</span>
          </div>
        </div>
      </div>
      <div v-if="tr.tasks.some(x => x.status !== 'active')" class="px-sm py-1.5 border-t border-outline-variant/40 shrink-0">
        <button @click="tr.clearFinished()" class="px-sm py-1 rounded-md bg-surface-container text-on-surface-variant text-xs hover:bg-surface-container-high">{{ t('transfers.clearFinished') }}</button>
      </div>
    </div>
  </FloatingWindow>
</template>
```

(若 ProgressBar 的 props 与上面不符——实现时以 `src/components/common/ProgressBar.vue` 实际 props 为准,只传存在的。`common.close` 若无此键,en/zh 各加 `"close": "关闭"/"Close"` 到 common 组。)

- [ ] **Step 3: TerminalTaskbar.vue 三分区(整文件重写)**

```vue
<script setup>
// 底部任务栏(Windows taskbar 式)三分区:终端 | 文件窗口 | 传输(百分比汇总,点击开面板)。
// 「全部关闭」作用于终端+文件窗口;传输清理在 TransfersPanel。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'
import { useTransferStore } from '@/stores/transfers'

const { t } = useI18n()
const termStore = useTerminalStore()
const fbStore = useFileBrowserStore()
const trStore = useTransferStore()

function onTermClick(item) {
  if (item.status === 'external') {
    if (!termStore.focusExternal(item.id)) termStore.restoreTerminal(item.id)
  } else if (item.status === 'minimized') termStore.restoreTerminal(item.id)
  else termStore.focusTerminal(item.id)
}
function onFilesClick(b) { b.status === 'minimized' ? fbStore.restoreBrowser(b.id) : fbStore.focusBrowser(b.id) }

const sessionCount = computed(() => termStore.terminals.length + fbStore.browsers.length)
const hasAny = computed(() => sessionCount.value > 0 || trStore.tasks.length > 0)
const agg = computed(() => trStore.aggregate)
// 单任务直显名称+%;多任务汇总「done/count · 加权%」
const transferText = computed(() => {
  const a = agg.value
  if (a.count === 1) {
    const tk = trStore.tasks[0]
    const pct = tk.total > 0 ? Math.round((tk.received / tk.total) * 100) + '%' : fmt0(tk.received)
    return `${tk.name} ${pct}`
  }
  const pct = a.pct !== null ? ` · ${a.pct}%` : ''
  return `${t('transfers.summaryMulti', { done: a.doneCount, count: a.count })}${pct}`
})
function fmt0(n) { return (n / 1024).toFixed(0) + ' KB' }

function closeAll() {
  if (!sessionCount.value) return
  if (confirm(t('transfers.closeAllConfirm', { count: sessionCount.value }))) {
    [...termStore.terminals].forEach(item => termStore.closeTerminal(item.id))
    ;[...fbStore.browsers].forEach(b => fbStore.closeBrowser(b.id))
  }
}
</script>

<template>
  <div v-if="hasAny" class="flex items-center gap-xs px-md bg-surface-container-highest border-t border-outline-variant shadow-lg shrink-0" style="height: 32px">
    <button v-if="sessionCount" @click="closeAll" class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs bg-error/10 text-error hover:bg-error/20 border border-error/20 transition-colors shrink-0" :title="t('terminal.closeAllTitle')">
      <span class="material-symbols-outlined text-sm">delete_sweep</span>{{ t('terminal.closeAll') }}
    </button>
    <span v-if="sessionCount" class="w-px h-4 bg-outline-variant/40 shrink-0"></span>
    <!-- 分区1:终端 -->
    <button v-for="item in termStore.terminals" :key="'t-' + item.id" @click="onTermClick(item)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="item.status === 'open' ? 'bg-primary/15 text-primary border border-primary/30' : item.status === 'external' ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${item.name}（${item.status === 'open' ? t('terminal.statusFloating') : item.status === 'external' ? t('terminal.statusExternal') : t('terminal.statusMinimized')}）`">
      <span class="material-symbols-outlined text-sm">{{ item.status === 'open' ? 'terminal' : item.status === 'external' ? 'open_in_new' : 'hide_source' }}</span>
      <span class="truncate">{{ item.name }}</span>
      <span @click.stop="termStore.closeTerminal(item.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" :title="t('terminal.closeThisTitle')">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <!-- 分区2:文件窗口 -->
    <button v-for="b in fbStore.browsers" :key="'f-' + b.id" @click="onFilesClick(b)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="b.status === 'open' ? 'bg-tertiary-container/15 text-tertiary-container border border-tertiary-container/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${b.name}（${b.status === 'open' ? t('terminal.statusFloating') : t('terminal.statusMinimized')}）`">
      <span class="material-symbols-outlined text-sm">{{ b.status === 'open' ? 'folder_open' : 'hide_source' }}</span>
      <span class="truncate">{{ b.name }}</span>
      <span @click.stop="fbStore.closeBrowser(b.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" :title="t('terminal.closeThisTitle')">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <!-- 分区3:传输(百分比) -->
    <button v-if="trStore.tasks.length" @click="trStore.openPanel()"
      class="flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs shrink-0 transition-all max-w-[260px]"
      :class="agg.activeCount ? 'bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20' : 'bg-surface-container-low text-on-surface-variant border border-transparent hover:bg-surface-container'"
      :title="t('transfers.openPanelTitle')">
      <span class="material-symbols-outlined text-sm" :class="agg.activeCount ? 'animate-spin' : ''">{{ agg.count > 1 ? 'swap_vert' : (trStore.tasks[0].kind === 'download' ? 'download' : 'upload') }}</span>
      <span class="truncate">{{ transferText }}</span>
      <span v-if="!agg.activeCount" class="material-symbols-outlined text-sm">check_circle</span>
    </button>
    <span class="ml-auto text-body-xs text-on-surface-variant/40 shrink-0">{{ t('terminal.countLabel', { count: sessionCount }) }}</span>
  </div>
</template>
```

AppLayout template 加(终端窗口行后):

```html
    <TransfersPanel v-if="trStore.panelOpen" />
```
script:`const TransfersPanel = defineAsyncComponent(() => import('@/components/common/TransfersPanel.vue'))`、`import { useTransferStore } from '@/stores/transfers'`、`const trStore = useTransferStore()`。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run test:unit && npm run build && npm run i18n:check`
Expected: 全绿

```bash
git add -A
git commit -m "feat(ui): 任务栏三分区(终端|文件窗口|传输百分比)+ TransfersPanel 传输面板"
```

---

### Task 9: FilePreview 下载 / FileBrowserBody 上传接 transfers + 完成目录刷新

**Files:**
- Modify: `src/components/common/FileBrowserBody.vue`、`src/components/common/FilePreview.vue`

**Interfaces:**
- Consumes: Task 4 `useTransferStore.startDownload/startUpload`;既有 provide('fileExplorer')
- Produces: 文件浏览内所有上传/下载都任务化(任务栏可见进度);上传完成自动刷新目录(toast)

- [ ] **Step 1: FileBrowserBody 改造**

script:import `useTransferStore` + `useToast`(已有);`const transferStore = useTransferStore()`。

`onUpload` 整函数替换(不再直接 writeFile;target 计算保留):

```js
async function onUpload(e) {
  const f = e.target.files?.[0]; if (!f) return
  const dir = selectedIsDir.value ? selected.value : (selected.value ? parentDir(selected.value) : '/')
  const target = joinPath(dir, f.name)
  transferStore.startUpload(ctx.value, { dir, path: target, file: f })   // 进度走任务栏;完成经下方 watcher 刷目录+toast
  e.target.value = ''
}
```

provide('fileExplorer') 增一项 `ctx: ctx`(FilePreview 拿它起下载任务):

```js
provide('fileExplorer', {
  selected, isExpanded, isLoading, childrenOf, selectNode, toggleNode,
  listDir: (path, opts) => files.listDir(ctx.value, path, opts),
  readFile: (path, opts) => files.readFile(ctx.value, path, opts),
  writeFile: (path, bytes) => files.writeFile(ctx.value, path, bytes),
  ctx,
  dirCache: files.dirCache,
})
```
(provide 里原 `download: (path) => files.download(ctx.value, path)` **删除**。)

script 末尾加完成监听(上传任务完成→强制重拉该目录+toast;失败也 toast):

```js
// 传输完成联动:本窗口(ns/pod/container 匹配)的上传任务完成 → 强制重拉目录 + 成功/失败 toast。
// usePodFiles 是每个 FileBrowserBody 各自实例化,store 无法直达缓存,故由各窗口自行监听刷新。
const seenFinished = new Set()
watch(() => transferStore.tasks, (ts) => {
  for (const tk of ts) {
    if (tk.kind !== 'upload' || (tk.status !== 'done' && tk.status !== 'error') || seenFinished.has(tk.id)) continue
    if (tk.namespace !== props.namespace || tk.pod !== props.pod || (tk.container || '') !== (props.container || '')) continue
    seenFinished.add(tk.id)
    if (tk.status === 'done') {
      notify('success', t('component.fileBrowser.uploaded', { name: tk.name, size: fmtBytes(tk.total) }))
      files.listDir(ctx.value, tk.dir || '/', { force: true }).catch(() => {})
    } else if (tk.status === 'error') {
      notify('error', tk.error || t('component.fileBrowser.uploadFailed'))
    }
  }
}, { deep: true })
```
(import 加 `watch`(已有)与 `import { fmtBytes } from '@/stores/transfers'`。)

- [ ] **Step 2: FilePreview 下载按钮接 store**

script:import `useTransferStore`;`const transferStore = useTransferStore()`。`download()` 函数替换:

```js
function download() {
  transferStore.startDownload(x.ctx.value, file.value.path)   // 进度走任务栏+面板;完成自动落盘
}
```
(删原 blob/a.click 逻辑;`x.download` 已不存在于 provide。)

- [ ] **Step 3: 验证 + 提交**

Run: `npm run test:unit && npm run build`
Expected: 全绿

```bash
git add -A
git commit -m "feat(ui): 文件浏览上传/下载任务化——进度入任务栏,上传完成自动刷目录"
```

---

### Task 10: Settings 限额 tab + adminApi + 全门禁收尾

**Files:**
- Modify: `src/api/client.js`(adminApi 增 podfileConfig)、`src/views/Settings.vue`、`src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: Task 2 `GET/PUT /api/admin/podfile-config`
- Produces: admin 可在 设置→文件传输 调整单文件限额(1-10240MB)

- [ ] **Step 1: client.js adminApi 增(mcpConfig 之后)**

```js
  // Pod 文件传输限额(单文件 MB,上传下载共用)
  podfileConfig: {
    get: () => platformHttp.request('/api/admin/podfile-config'),
    update: limitMb => platformHttp.request('/api/admin/podfile-config', { method: 'PUT', body: JSON.stringify({ limitMb }) }),
  },
```

- [ ] **Step 2: i18n 键**

zh(`settings` 组内):
```json
"tabs.transfers": "文件传输",
"transfersTitle": "文件传输限额",
"transfersLimitLabel": "单文件大小上限(MB)",
"transfersLimitHint": "容器文件上传/下载共用的单文件上限;默认 1024(1GB),可调 1-10240。超限时传输任务会提示当前限额。",
"transfersSaved": "已保存",
"transfersInvalid": "请输入 1-10240 的整数",
"transfersLoadFailed": "读取配置失败"
```
en:
```json
"tabs.transfers": "File Transfers",
"transfersTitle": "File Transfer Limit",
"transfersLimitLabel": "Per-file size limit (MB)",
"transfersLimitHint": "Shared limit for container file upload/download; default 1024 (1GB), range 1-10240. Oversized transfers fail with the current limit shown.",
"transfersSaved": "Saved",
"transfersInvalid": "Enter an integer between 1 and 10240",
"transfersLoadFailed": "Failed to load config"
```
(注:vue-i18n JSON 键形如 `"tabs": { "transfers": … }` 嵌套,按 zh.json 现有 settings.tabs 结构追加,不是字面平键。)

- [ ] **Step 3: Settings.vue 加 tab + 区块**

tabs computed 的 mcp 项后追加:

```js
  ...(auth.isAdmin ? [{ key: 'transfers', label: t('settings.tabs.transfers'), icon: 'swap_vert' }] : []),
```

script 增(照 mcp 区块模式):

```js
// 文件传输限额(admin)
const tfLimit = ref(1024)
const tfSaving = ref(false)
const tfLoaded = ref(false)
async function loadTransfersConfig() {
  try { const r = await adminApi.podfileConfig.get(); tfLimit.value = r.limitMb; tfLoaded.value = true }
  catch { /* 非 admin/无权限静默 */ }
}
async function saveTransfersConfig() {
  const v = parseInt(tfLimit.value, 10)
  if (!(v >= 1 && v <= 10240)) { notify('error', t('settings.transfersInvalid')); return }
  tfSaving.value = true
  try {
    const r = await adminApi.podfileConfig.update(v)
    tfLimit.value = r.limitMb; notify('success', t('settings.transfersSaved'))
  } catch (e) { notify('error', e.message || t('settings.transfersLoadFailed')) }
  finally { tfSaving.value = false }
}
```
onMounted 的 `if (auth.isAdmin) loadMcpConfig()` 改为 `if (auth.isAdmin) { loadMcpConfig(); loadTransfersConfig() }`。

template(mcp 区块之后,同卡片风格):

```html
        <div v-if="activeTab === 'transfers'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">swap_vert</span>
            <span class="text-body-sm font-semibold">{{ t('settings.transfersTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex items-center gap-sm">
              <label class="text-body-sm text-on-surface-variant shrink-0">{{ t('settings.transfersLimitLabel') }}</label>
              <input v-model="tfLimit" type="number" min="1" max="10240" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              <button @click="saveTransfersConfig" :disabled="tfSaving" class="px-sm py-1 rounded-md bg-primary text-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50">
                {{ t('common.save') }}
              </button>
            </div>
            <p class="text-body-xs text-on-surface-variant">{{ t('settings.transfersLimitHint') }}</p>
          </div>
        </div>
```

- [ ] **Step 4: 全门禁**

Run: `npm test && npm run test:unit && npm run typecheck && npm run i18n:check && npm run build`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(settings): 文件传输限额 admin 配置页(默认1GB,1-10240MB)"
```

---

## 手测清单(需真集群,交付用户)

1. PodCard 文件夹按钮 → 浮动窗口打开(不再跳详情页);同 pod+container 再点 → 聚焦不重复
2. 窗口最小化 → 任务栏出现;点击恢复,树展开/选中与最小化前一致
3. 刷新页面 → 终端+文件窗口均以最小化恢复;点开文件窗口正常浏览
4. 下载 >100MB 文件:任务栏出现 `↓ name N%` 递增;点开面板看速度;完成瞬间浏览器下载栏出现完整文件;文件 diff 校验一致(重点验证二进制,含 0x0d 字节)
5. 上传大文件:任务栏百分比;取消 → 任务变已取消;完成 → 目录自动刷新 + toast
6. 限额:admin 改成 1MB → >1MB 传输失败,提示含限额;改回 1024 生效
7. NsWorkloadDetail 文件按钮 → 浮动窗口;PodDetail Files tab 仍内嵌正常

## Self-Review 记录

- Spec 覆盖:流式下载(T1/T2)、上传端点(T1/T2)、限额设置+admin UI(T1/T2/T10)、原语(T3)、transfers store(T4)、FloatingWindow(T5)、fileBrowsers+窗口+入口(T6/T7)、任务栏三分区+面板(T8)、浏览内接线+目录刷新(T9)、持久化(T6/T7)——全对应。
- 冲突修正:spec「双击标题最大化」与终端「双击=改名」冲突 → 已改 spec 为按钮最大化、双击留给内容方。
- 类型一致:openConn 下载(stdout,stderr)/上传(input,stderr)两形,Task 1 测试与 Task 2 接线一致;`startUpload(ctx, { dir, path, file })` 在 T4 定义 T9 消费一致;`fmtBytes` T4 导出 T8/T9 消费。
