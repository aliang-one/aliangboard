# Ingress 字段单位选择与格式校验 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingress 性能面板与注解编辑的字段获得「纯数值→单位选择、格式受限→格式提示+提交拦截」能力,并交付全应用表单审计报告。

**Architecture:** `useIngressPerf.js` 的字段定义增加 `vt` 值类型元信息(单一事实源,模块保持纯净不引 vue/i18n);新组件 `IngressPerfField.vue` 按元信息渲染(数字框+只读单位后缀 / 数字+单位下拉 / 文本+hint,仿既有 `ResourceInput` 先例);`NsIngress.vue` / `DeployApp.vue` 两处重复渲染收敛为该组件;三个提交口(NsIngress 创建、DeployApp 向导、NsIngressDetail 注解弹窗)统一走 `validateIngressAdv` / `validateCustomAnnotations` 提交拦截。

**Tech Stack:** Vue 3 `<script setup>` + vitest + @vue/test-utils(既有栈,零新依赖)。

## Global Constraints

- 仓库零新外部依赖(CLAUDE.md 依赖政策)。
- `useIngressPerf.js` 保持纯模块:不 import vue/vue-i18n/`@/` 别名(`scripts/test.mjs` 直 import 它,见该文件头注释)。i18n 一律存键字符串,由消费方 `t()`。
- `adv` 值仍为规范串(`'4k'`/`'60'`/`'50s'`);`buildIngressAnnotations` 输出契约零改动。
- 新 i18n 键全部在 `ingressPerf.*` 命名空间,zh/en 同步(`src/locales/zh.json` + `src/locales/en.json`),过 `npm run i18n:check`。
- 既有测试的选择器依赖 placeholder(如 `input[placeholder="web"]`)——所有输入控件必须保留 `:placeholder="fld.ph"`。
- 每个任务结束跑该任务测试并 commit;全量回归在 Task 6。
- 在 worktree `feat-ingress-field-units`(分支 `worktree-feat-ingress-field-units`)内开发。

---

### Task 1: vt 元信息 + 校验器 + 辅助函数 + i18n 键

**Files:**
- Modify: `src/composables/useIngressPerf.js`(INGRESS_DIALECTS 全字段标 vt;文件尾新增 FIELD_VTS/校验器/辅助函数)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(ingressPerf 命名空间追加键)
- Test: `src/composables/__tests__/useIngressPerf.validation.test.js`(新建)

**Interfaces(后续任务依赖的精确签名):**
- `export const FIELD_VTS = { int, size, hpxTime, csvInt, path, csv, free }`(每项含 `input`,可含 `units/defUnit/re/errKey/hintKey`)
- `export function validateAdvValue(fld, raw)` → `null`(合法或空)或错误 i18n key 字符串;`fld` 为 INGRESS_DIALECTS 字段对象(含 `vt/min/max/options`)
- `export function validateIngressAdv(dialect, adv = {})` → `[{ key, labelKey, msgKey }]`
- `export function validateCustomAnnotations(rows = [])` → `[{ index, key, labelKey, msgKey }]`(rows: `[{key, value}]`)
- `export function vfmtOfKey(key)` → INGRESS_DIALECTS 字段对象或 `undefined`(按注解前缀+后缀匹配)
- `export function hintKeyOfKey(key)` → hint i18n key 或 `''`
- `export function placeholderOfKey(key)` → 该注解的示例 placeholder(如 `'4k'`)或 `''`

- [ ] **Step 1: 写失败测试**

新建 `src/composables/__tests__/useIngressPerf.validation.test.js`:

```js
// vt 元信息与校验器真相表。领域事实:nginx 大小单位 k/m/g(大小写不敏感,裸数字=字节);
// haproxy 时间须带单位(ms/s/m);annotations 值最终都是字符串。
import { describe, it, expect } from 'vitest'
import { FIELD_VTS, validateAdvValue, validateIngressAdv, validateCustomAnnotations, vfmtOfKey, hintKeyOfKey, placeholderOfKey, INGRESS_DIALECTS } from '@/composables/useIngressPerf'

describe('validateAdvValue 真相表', () => {
  const sec = { key: 'proxy-send-timeout', vt: 'int', unitKey: 'ingressPerf.unitSeconds' }
  const size = { key: 'proxy-buffer-size', vt: 'size' }
  const hpx = { key: 'timeout-server', vt: 'hpxTime' }
  const lvl = { key: 'compression-level', vt: 'int', min: 1, max: 9 }
  const csvInt = { key: 'custom-http-errors', vt: 'csvInt' }
  const path = { key: 'rewrite-target', vt: 'path' }
  const bool = { key: 'ssl-redirect', options: ['', 'true', 'false'] }
  const snippet = { key: 'server-snippet', area: true }

  it('空值跳过(空=控制器默认)', () => {
    for (const fld of [sec, size, hpx, csvInt]) expect(validateAdvValue(fld, '')).toBe(null)
    expect(validateAdvValue(sec, undefined)).toBe(null)
  })
  it('int: 合法整数过,非整数拒', () => {
    expect(validateAdvValue(sec, '60')).toBe(null)
    expect(validateAdvValue(sec, '3600')).toBe(null)
    expect(validateAdvValue(sec, '6o')).toBe('ingressPerf.errInt')
    expect(validateAdvValue(sec, '-5')).toBe('ingressPerf.errInt')
    expect(validateAdvValue(sec, '1.5')).toBe('ingressPerf.errInt')
  })
  it('int + min/max: 区间外拒', () => {
    expect(validateAdvValue(lvl, '5')).toBe(null)
    expect(validateAdvValue(lvl, '0')).toBe('ingressPerf.errRange')
    expect(validateAdvValue(lvl, '10')).toBe('ingressPerf.errRange')
  })
  it('size: 数字[+k/m/g] 过,怪单位拒', () => {
    expect(validateAdvValue(size, '4k')).toBe(null)
    expect(validateAdvValue(size, '10m')).toBe(null)
    expect(validateAdvValue(size, '1G')).toBe(null)
    expect(validateAdvValue(size, '100')).toBe(null)          // 裸数字=字节,nginx 合法
    expect(validateAdvValue(size, '4kb')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(size, '4 k')).toBe('ingressPerf.errSize')
    expect(validateAdvValue(size, 'x')).toBe('ingressPerf.errSize')
  })
  it('hpxTime: 数字+单位 过,裸数字拒', () => {
    expect(validateAdvValue(hpx, '50s')).toBe(null)
    expect(validateAdvValue(hpx, '5ms')).toBe(null)
    expect(validateAdvValue(hpx, '5')).toBe('ingressPerf.errTime')
    expect(validateAdvValue(hpx, '5s5')).toBe('ingressPerf.errTime')
  })
  it('csvInt: 逗号分隔状态码', () => {
    expect(validateAdvValue(csvInt, '404')).toBe(null)
    expect(validateAdvValue(csvInt, '404,503')).toBe(null)
    expect(validateAdvValue(csvInt, '404,x')).toBe('ingressPerf.errCsvInt')
    expect(validateAdvValue(csvInt, '404,')).toBe('ingressPerf.errCsvInt')
  })
  it('path: 须以 / 开头', () => {
    expect(validateAdvValue(path, '/$1')).toBe(null)
    expect(validateAdvValue(path, 'app')).toBe('ingressPerf.errPath')
  })
  it('options 字段(注解弹窗自由输入时兜底): 值须在列表内', () => {
    expect(validateAdvValue(bool, 'true')).toBe(null)
    expect(validateAdvValue(bool, 'ture')).toBe('ingressPerf.errEnum')
  })
  it('area/free 不校验', () => {
    expect(validateAdvValue(snippet, 'any raw nginx conf')).toBe(null)
  })
})

describe('validateIngressAdv: 按方言聚合', () => {
  it('nginx: 一个坏值 → 1 条错,labelKey 可翻译', () => {
    const errs = validateIngressAdv('nginx', { 'proxy-buffer-size': '4kb', 'proxy-send-timeout': '60' })
    expect(errs).toHaveLength(1)
    expect(errs[0].key).toBe('proxy-buffer-size')
    expect(errs[0].labelKey).toBe('ingressPerf.responseBufferSize')
    expect(errs[0].msgKey).toBe('ingressPerf.errSize')
  })
  it('全部合法 → 空', () => {
    expect(validateIngressAdv('nginx', { 'proxy-buffer-size': '4k' })).toEqual([])
  })
})

describe('vfmtOfKey / hintKeyOfKey / placeholderOfKey: 注解 key → 元信息', () => {
  it('已知 nginx key → 字段对象', () => {
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/proxy-send-timeout').vt).toBe('int')
    expect(vfmtOfKey('nginx.ingress.kubernetes.io/custom-http-errors').vt).toBe('csvInt')
    expect(vfmtOfKey('haproxy-ingress.github.io/timeout-server').vt).toBe('hpxTime')
  })
  it('未知 key → undefined,不限制', () => {
    expect(vfmtOfKey('custom.example/x')).toBeUndefined()
    expect(vfmtOfKey('')).toBeUndefined()
  })
  it('hint/placeholder 派生', () => {
    expect(hintKeyOfKey('nginx.ingress.kubernetes.io/custom-http-errors')).toBe('ingressPerf.hintCsvInt')
    expect(hintKeyOfKey('nginx.ingress.kubernetes.io/proxy-send-timeout')).toBe('')
    expect(placeholderOfKey('nginx.ingress.kubernetes.io/proxy-buffer-size')).toBe('4k')
    expect(placeholderOfKey('custom.example/x')).toBe('')
  })
})

describe('validateCustomAnnotations: 自定义注解行', () => {
  it('已知 key 值不合格 → 带 labelKey 的错', () => {
    const errs = validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4kb' }])
    expect(errs).toHaveLength(1)
    expect(errs[0].labelKey).toBe('ingressPerf.responseBufferSize')
    expect(errs[0].msgKey).toBe('ingressPerf.errSize')
  })
  it('未知 key / 合法值 / 空值 → 不报', () => {
    expect(validateCustomAnnotations([{ key: 'custom.example/x', value: '随便' }])).toEqual([])
    expect(validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4k' }])).toEqual([])
    expect(validateCustomAnnotations([{ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '' }])).toEqual([])
  })
})

describe('元信息全量覆盖(47 字段一个不漏)', () => {
  it('每个字段必有 vt 或 options 或 area', () => {
    for (const d of Object.values(INGRESS_DIALECTS)) for (const g of d.groups) for (const f of g.fields) {
      expect(Boolean(f.options || f.area || FIELD_VTS[f.vt]), `${d.prefix}/${f.key}`).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useIngressPerf.validation.test.js`
Expected: FAIL(FIELD_VTS 未导出 / 字段无 vt)

- [ ] **Step 3: 实现——INGRESS_DIALECTS 全字段标 vt**

`src/composables/useIngressPerf.js` 中,给字段加 `vt` / `min` / `max` / `unitKey`(options/area 字段不动)。**逐组替换为**(只列变更行,其余原样;`ph` 保持不变):

nginx「超时」组:
```js
      { key: 'proxy-connect-timeout', labelKey: 'ingressPerf.upstreamConnectTimeout', ph: '5', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'proxy-send-timeout', labelKey: 'ingressPerf.sendTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'proxy-read-timeout', labelKey: 'ingressPerf.readTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
```
nginx「缓冲」组:
```js
      { key: 'proxy-body-size', labelKey: 'ingressPerf.maxBodySize', ph: '10m', vt: 'size' },
      { key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k', vt: 'size' },
```
(proxy-buffering / proxy-request-buffering 保持 options 不动)

nginx「限流」组:
```js
      { key: 'limit-connections', labelKey: 'ingressPerf.maxConcurrentConnections', ph: '100', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-rps', labelKey: 'ingressPerf.rps', ph: '50', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-burst', labelKey: 'ingressPerf.burst', ph: '100', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-rate', labelKey: 'ingressPerf.rateLimit', ph: '0', vt: 'int', unitKey: 'ingressPerf.unitKbPerSec' },
```
nginx「负载均衡」组:
```js
      { key: 'upstream-keepalive-connections', labelKey: 'ingressPerf.upstreamKeepaliveConnections', ph: '320', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'upstream-keepalive-timeout', labelKey: 'ingressPerf.upstreamKeepaliveTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'upstream-keepalive-requests', labelKey: 'ingressPerf.upstreamKeepaliveRequests', ph: '10000', vt: 'int', unitKey: 'ingressPerf.unitCount' },
```
nginx「亲和」组:`session-cookie-name` 加 `, vt: 'free'`;backend-protocol/affinity/affinity-mode 保持 options。

nginx「安全」组:
```js
      { key: 'hsts-max-age', labelKey: 'ingressPerf.hstsMaxAge', ph: '31536000', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
```
(ssl-redirect 等保持 options)

nginx「压缩/CORS」组:
```js
      { key: 'compression-level', labelKey: 'ingressPerf.compressionLevel', ph: '5', vt: 'int', min: 1, max: 9 },
```
(cors-allow-origin 加 `vt: 'free'`;enable-* 保持 options)

nginx「重写」组:
```js
      { key: 'rewrite-target', labelKey: 'ingressPerf.rewriteTarget', ph: '/$1', vt: 'path' },
      { key: 'app-root', labelKey: 'ingressPerf.appRoot', ph: '/app', vt: 'path' },
      { key: 'custom-http-errors', labelKey: 'ingressPerf.customHttpErrors', ph: '404,503', vt: 'csvInt' },
```
(use-regex 保持 options;两个 snippet 保持 area 不动)

haproxy 全组:
```js
      { key: 'timeout-connect', labelKey: 'ingressPerf.hpx.timeoutConnect', ph: '5s', vt: 'hpxTime' },
      { key: 'timeout-server', labelKey: 'ingressPerf.hpx.timeoutServer', ph: '50s', vt: 'hpxTime' },
      { key: 'timeout-http-request', labelKey: 'ingressPerf.hpx.timeoutHttpRequest', ph: '5s', vt: 'hpxTime' },
      { key: 'timeout-queue', labelKey: 'ingressPerf.hpx.timeoutQueue', ph: '5s', vt: 'hpxTime' },
      { key: 'maxconn-server', labelKey: 'ingressPerf.hpx.maxconnServer', ph: '500', vt: 'int', unitKey: 'ingressPerf.unitCount' },
```
(balance-algorithm/ssl-redirect/hsts 保持 options)

traefik 组:
```js
      { key: 'router.entrypoints', labelKey: 'ingressPerf.tf.entrypoints', ph: 'web', vt: 'csv' },
      { key: 'router.middlewares', labelKey: 'ingressPerf.tf.middlewares', ph: 'auth@file,ratelimit@file', vt: 'csv' },
```
(router.tls 保持 options)

kong 组:
```js
      { key: 'regex-priority', labelKey: 'ingressPerf.kong.regexPriority', ph: '100', vt: 'int' },
      { key: 'methods', labelKey: 'ingressPerf.kong.methods', ph: 'GET,POST', vt: 'csv' },
```
(strip-path 保持 options)

- [ ] **Step 4: 实现——文件尾追加元信息表与校验器**

在 `src/composables/useIngressPerf.js` 末尾(`buildIngressAnnotations` 之后)追加:

```js
// === 字段值类型(vt):渲染形态 + 校验,单一事实源 ===
// IngressPerfField 按 input 渲染(number=数字框+fld.unitKey 只读后缀、number-unit=数字+单位下拉、
// text=文本/textarea+hint);validateAdvValue 按 re/min/max/options 校验。
// haproxy 时间注释:值原样进 HAProxy 配置,须带单位;nginx 大小裸数字=字节,合法。
export const FIELD_VTS = {
  int:    { input: 'number' },
  size:   { input: 'number-unit', units: ['k', 'm', 'g'], defUnit: 'm', re: /^\d+([kmgKMG])?$/, errKey: 'ingressPerf.errSize', hintKey: 'ingressPerf.hintSize' },
  hpxTime:{ input: 'number-unit', units: ['ms', 's', 'm'], defUnit: 's', re: /^\d+(ms|s|m)$/, errKey: 'ingressPerf.errTime' },
  csvInt: { input: 'text', re: /^\d+(,\d+)*$/, errKey: 'ingressPerf.errCsvInt', hintKey: 'ingressPerf.hintCsvInt' },
  path:   { input: 'text', re: /^\//, errKey: 'ingressPerf.errPath', hintKey: 'ingressPerf.hintPath' },
  csv:    { input: 'text', hintKey: 'ingressPerf.hintCsv' },
  free:   { input: 'text' },
}

// 单字段校验:返回 null(空值=控制器默认,跳过)或错误 i18n key。fld 为上方字段对象。
export function validateAdvValue(fld, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (fld.options) return fld.options.includes(s) ? null : 'ingressPerf.errEnum'
  if (fld.vt === 'int') {
    if (!/^\d+$/.test(s)) return 'ingressPerf.errInt'
    const n = Number(s)
    if ((fld.min != null && n < fld.min) || (fld.max != null && n > fld.max)) return 'ingressPerf.errRange'
    return null
  }
  const vt = FIELD_VTS[fld.vt]
  if (!vt || !vt.re) return null
  return vt.re.test(s) ? null : vt.errKey
}

// 整表校验:方言下全部性能字段。返回 [{ key, labelKey, msgKey }](labelKey 供 toast 指名字段)。
export function validateIngressAdv(dialect, adv = {}) {
  const errs = []
  for (const g of dialectGroups(dialect)) for (const fld of g.fields) {
    const msgKey = validateAdvValue(fld, adv[fld.key])
    if (msgKey) errs.push({ key: fld.key, labelKey: fld.labelKey, msgKey })
  }
  return errs
}

// 注解完整 key(如 nginx.ingress.kubernetes.io/proxy-send-timeout)→ 字段元信息。
// 从 INGRESS_DIALECTS 派生(单一事实源),注解编辑 3 处按 key 提示/校验共用。未知 key → undefined(不限制)。
export function vfmtOfKey(key) {
  const s = String(key || '')
  const i = s.lastIndexOf('/')
  if (i <= 0) return undefined
  const prefix = s.slice(0, i), suffix = s.slice(i + 1)
  for (const d of Object.values(INGRESS_DIALECTS)) {
    if (d.prefix !== prefix) continue
    for (const g of d.groups) for (const f of g.fields) if (f.key === suffix) return f
  }
  return undefined
}

// 已知注解 key 的常显 hint / 示例 placeholder(未知 key 返回 '')
export function hintKeyOfKey(key) { return FIELD_VTS[vfmtOfKey(key)?.vt]?.hintKey || '' }
export function placeholderOfKey(key) { return vfmtOfKey(key)?.ph || '' }

// 自定义注解行校验:key 已知且 value 非空不合格 → 错。返回 [{ index, key, labelKey, msgKey }]
export function validateCustomAnnotations(rows = []) {
  const errs = []
  rows.forEach((a, index) => {
    const fld = vfmtOfKey(a.key)
    if (!fld) return
    const msgKey = validateAdvValue(fld, a.value)
    if (msgKey) errs.push({ index, key: a.key, labelKey: fld.labelKey, msgKey })
  })
  return errs
}
```

- [ ] **Step 5: i18n 键(zh + en)**

`src/locales/zh.json` 的 `ingressPerf` 对象内追加:
```json
    "unitSeconds": "秒",
    "unitCount": "个",
    "unitKbPerSec": "KB/s",
    "hintSize": "数字 + 单位(k/m/g),留空=控制器默认",
    "hintCsvInt": "逗号分隔状态码,如 404,503",
    "hintCsv": "多个值用逗号分隔",
    "hintPath": "以 / 开头的路径",
    "hintSnippet": "原样注入控制器配置;语法错误会被 admission 拒绝",
    "errInt": "须为整数(留空=控制器默认)",
    "errRange": "数值超出允许范围",
    "errSize": "须为数字,可选单位 k/m/g",
    "errTime": "须为数字 + 单位(ms/s/m)",
    "errCsvInt": "须为逗号分隔的状态码,如 404,503",
    "errPath": "须以 / 开头",
    "errEnum": "值不在允许列表内",
    "invalidField": "「{field}」{msg}"
```
`src/locales/en.json` 的 `ingressPerf` 对象内追加:
```json
    "unitSeconds": "s",
    "unitCount": "",
    "unitKbPerSec": "KB/s",
    "hintSize": "number + unit (k/m/g); empty = controller default",
    "hintCsvInt": "comma-separated status codes, e.g. 404,503",
    "hintCsv": "separate multiple values with commas",
    "hintPath": "path starting with /",
    "hintSnippet": "injected verbatim into controller config; syntax errors are rejected by admission",
    "errInt": "must be an integer (empty = controller default)",
    "errRange": "value out of allowed range",
    "errSize": "must be a number, optionally with k/m/g unit",
    "errTime": "must be number + unit (ms/s/m)",
    "errCsvInt": "must be comma-separated status codes, e.g. 404,503",
    "errPath": "must start with /",
    "errEnum": "value not in allowed list",
    "invalidField": "\"{field}\": {msg}"
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useIngressPerf.validation.test.js`
Expected: PASS 全部

- [ ] **Step 7: 跑 i18n 门禁 + 提交**

Run: `npm run i18n:check`(在 npm scripts 内则用 `node scripts/i18n-check.mjs` 或既有等价命令)
Expected: 通过(残存中文 0 / 键对齐 / 缺失 0)

```bash
git add src/composables/useIngressPerf.js src/composables/__tests__/useIngressPerf.validation.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(ingress): 字段 vt 元信息+校验器——单一事实源驱动渲染/提示/校验(47 字段全覆盖)"
```

---

### Task 2: IngressPerfField.vue 组件

**Files:**
- Create: `src/components/common/IngressPerfField.vue`
- Test: `src/components/common/__tests__/IngressPerfField.test.js`(新建)

**Interfaces:**
- Consumes: `FIELD_VTS`(Task 1)
- Produces: 组件 `IngressPerfField`,props `{ fld: Object, modelValue: String }`,emit `update:modelValue`(规范串);area/options 分支语义与原视图渲染一致(textarea/select)

- [ ] **Step 1: 写失败测试**

新建 `src/components/common/__tests__/IngressPerfField.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import IngressPerfField from '../IngressPerfField.vue'

const mountFld = (fld, modelValue = '') => mount(IngressPerfField, {
  props: { fld, modelValue },
  global: { plugins: [i18n] },
})

describe('IngressPerfField: size(数字+单位下拉)', () => {
  const fld = { key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k', vt: 'size' }
  it('渲染 number 输入 + 单位 select(placeholder 保留)', () => {
    const w = mountFld(fld)
    expect(w.find('input[type="number"]').exists()).toBe(true)
    const units = w.findAll('select option').map(o => o.element.value)
    expect(units).toEqual(['k', 'm', 'g'])
    expect(w.find('input').attributes('placeholder')).toBe('4k')
  })
  it('回显拆合:10m → 10 + m;改 4+k → emit "4k"', async () => {
    const w = mountFld(fld, '10m')
    expect(w.find('input[type="number"]').element.value).toBe('10')
    expect(w.find('select').element.value).toBe('m')
    await w.find('input[type="number"]').setValue('4')
    await w.find('select').setValue('k')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('4k')
  })
  it('外部重填:8m → 8 + m(编辑回显)', async () => {
    const w = mountFld(fld, '10m')
    await w.setProps({ modelValue: '8m' })
    expect(w.find('input[type="number"]').element.value).toBe('8')
    expect(w.find('select').element.value).toBe('m')
  })
  it('旧值无单位(裸数字 100)→ 数字保留,单位取默认 m', () => {
    const w = mountFld(fld, '100')
    expect(w.find('input[type="number"]').element.value).toBe('100')
    expect(w.find('select').element.value).toBe('m')
  })
})

describe('IngressPerfField: int(数字框+只读单位后缀)', () => {
  it('unitKey → 渲染后缀 span(秒);emit 纯数字', async () => {
    const fld = { key: 'proxy-send-timeout', labelKey: 'ingressPerf.sendTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' }
    const w = mountFld(fld, '3600')
    expect(w.find('span').text()).toBe('秒')
    expect(w.find('input[type="number"]').element.value).toBe('3600')
    await w.find('input[type="number"]').setValue('60')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('60')
  })
  it('min/max 透传(compression-level 1-9)', () => {
    const fld = { key: 'compression-level', labelKey: 'ingressPerf.compressionLevel', ph: '5', vt: 'int', min: 1, max: 9 }
    const w = mountFld(fld)
    expect(w.find('input[type="number"]').attributes('min')).toBe('1')
    expect(w.find('input[type="number"]').attributes('max')).toBe('9')
  })
})

describe('IngressPerfField: hpxTime / csvInt / options / area', () => {
  it('hpxTime: 50s → 50 + s;emit 带', async () => {
    const w = mountFld({ key: 'timeout-server', labelKey: 'ingressPerf.hpx.timeoutServer', ph: '50s', vt: 'hpxTime' }, '50s')
    expect(w.find('input[type="number"]').element.value).toBe('50')
    expect(w.find('select').element.value).toBe('s')
    await w.find('input[type="number"]').setValue('5')
    expect(w.emitted('update:modelValue').at(-1)[0]).toBe('5s')
  })
  it('csvInt: 文本框 + 常显 hint(placeholder 保留)', () => {
    const w = mountFld({ key: 'custom-http-errors', labelKey: 'ingressPerf.customHttpErrors', ph: '404,503', vt: 'csvInt' })
    const input = w.find('input:not([type="number"])')
    expect(input.attributes('placeholder')).toBe('404,503')
    expect(w.text()).toContain('404,503')
  })
  it('options: 渲染 select,空选项显示「默认(不设置)」', () => {
    const w = mountFld({ key: 'ssl-redirect', labelKey: 'ingressPerf.httpsRedirect', options: ['', 'true', 'false'] })
    expect(w.findAll('option')).toHaveLength(3)
    expect(w.find('option').text()).toContain('默认')
  })
  it('area: textarea + snippet hint', () => {
    const w = mountFld({ key: 'server-snippet', labelKey: 'ingressPerf.serverSnippet', ph: '# raw nginx server snippet', area: true })
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('admission')
  })
})
```

注:`option` 空选项文案键沿用 `ns.ingress.defaultOpt`(与原 NsIngress 渲染一致,该键已存在)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/IngressPerfField.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现组件**

新建 `src/components/common/IngressPerfField.vue`:

```vue
<script setup>
// Ingress 性能字段渲染器:按 useIngressPerf.FIELD_VTS[fld.vt] 元信息渲染——
// number=数字框(+fld.unitKey 只读单位后缀,int 的 min/max 透传)、number-unit=数字+单位下拉(仿
// ResourceInput 先例)、text=文本+常显 hint、area/options 分支语义同原视图渲染。
// v-model 承载规范串('4k'/'60'/'50s'),内部拆合;buildIngressAnnotations 契约不变。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FIELD_VTS } from '@/composables/useIngressPerf'

const props = defineProps({
  fld: { type: Object, required: true },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const vt = computed(() => FIELD_VTS[props.fld.vt] || FIELD_VTS.free)
const isUnit = computed(() => vt.value.input === 'number-unit')
// text/select 分支无内部状态,直接 computed 代理;number 系用 num/unit 拆合
const raw = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })
const num = ref('')
const unit = ref('')

function sync(v) {
  const s = String(v ?? '').trim()
  const m = isUnit.value ? s.match(/^(\d+)([a-z]+)?$/) : null
  if (m) {
    num.value = m[1]
    unit.value = (m[2] && vt.value.units.includes(m[2])) ? m[2] : vt.value.defUnit
  } else {
    num.value = ''
  }
}
sync(props.modelValue)
// 外部重填(编辑回显)时同步数字框/单位
watch(() => props.modelValue, v => sync(v))

function emitVal() { emit('update:modelValue', num.value ? num.value + (isUnit.value ? unit.value : '') : '') }

const inputCls = 'w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary'
const unitCls = 'bg-surface-container-low border border-l-0 border-outline-variant rounded-r-lg px-sm text-xs text-on-surface-variant'
</script>

<template>
  <div class="flex flex-col gap-xs">
    <textarea v-if="fld.area" v-model="raw" rows="2" :class="inputCls" :placeholder="fld.ph"></textarea>
    <select v-else-if="fld.options" v-model="raw" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm">
      <option v-for="o in fld.options" :key="o" :value="o">{{ o || t('ns.ingress.defaultOpt') }}</option>
    </select>
    <div v-else-if="isUnit" class="flex items-stretch">
      <input type="number" min="0" v-model="num" @input="emitVal" :class="inputCls + ' rounded-r-none'" :placeholder="fld.ph" />
      <select v-model="unit" @change="emitVal" :data-testid="'unit-' + fld.key" :class="unitCls + ' font-mono'">
        <option v-for="u in vt.units" :key="u" :value="u">{{ u }}</option>
      </select>
    </div>
    <div v-else-if="vt.input === 'number'" class="flex items-stretch">
      <input type="number" :min="fld.min" :max="fld.max" v-model="num" @input="emitVal" :class="inputCls + (fld.unitKey ? ' rounded-r-none' : '')" :placeholder="fld.ph" />
      <span v-if="fld.unitKey" :class="unitCls + ' flex items-center'">{{ t(fld.unitKey) }}</span>
    </div>
    <input v-else v-model="raw" :class="inputCls" :placeholder="fld.ph" />
    <p v-if="fld.area" class="text-xs text-on-surface-variant">{{ t('ingressPerf.hintSnippet') }}</p>
    <p v-else-if="vt.hintKey" class="text-xs text-on-surface-variant">{{ t(vt.hintKey) }}</p>
  </div>
</template>
```

(样式类取自原 NsIngress.vue 的字段渲染;DeployApp 侧原用更紧凑的 padding,统一为本组件样式——视觉差异可接受,换取两处收敛。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/IngressPerfField.test.js`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src/components/common/IngressPerfField.vue src/components/common/__tests__/IngressPerfField.test.js
git commit -m "feat(ingress): IngressPerfField 组件——按 vt 元信息渲染数字+单位/文本+hint(仿 ResourceInput)"
```

---

### Task 3: NsIngress.vue 接入(渲染收敛 + 提交拦截 + 注解行 hint)

**Files:**
- Modify: `src/views/NsIngress.vue`(imports、handleCreate 门、字段循环替换、自定义注解值输入)
- Test: `src/views/__tests__/NsIngress.dialect.test.js`(追加用例)

**Interfaces:**
- Consumes: `IngressPerfField`(Task 2)、`validateIngressAdv`/`validateCustomAnnotations`/`hintKeyOfKey`/`placeholderOfKey`(Task 1)

- [ ] **Step 1: 写失败测试**

在 `src/views/__tests__/NsIngress.dialect.test.js` 顶部 mock 区追加:
```js
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
```
并 `import { notify } from '@/composables/useToast'`。文件尾追加:

```js
// vt 元信息落地:size 字段=数字+单位下拉,emit 规范串;非法值提交被拦截
test('proxy-buffer-size 渲染单位下拉,4+k → 注解值 "4k"', async () => {
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'sz'; w.vm.createForm.host = 'a.test'; w.vm.createForm.serviceName = 's'
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  await w.find('[data-testid="tab-perf"]').trigger('click')
  await flushPromises()
  const num = w.find('[data-testid="perf-panel"] input[placeholder="4k"]')
  await num.setValue('4')
  await w.find('[data-testid="unit-proxy-buffer-size"]').setValue('k')
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['nginx.ingress.kubernetes.io/proxy-buffer-size']).toBe('4k')
})

test('非法值(自定义注解 proxy-buffer-size=4kb)→ 拦截:addIngress 不被调、弹窗保留、toast 报错', async () => {
  addIngress.mockClear()
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'bad'; w.vm.createForm.host = 'a.test'; w.vm.createForm.serviceName = 's'
  w.vm.customAnnotations.push({ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4kb' })
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  expect(addIngress).not.toHaveBeenCalled()
  expect(w.vm.showCreateModal).toBe(true)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('k/m/g'))
})

test('非法性能字段值(proxy-send-timeout=6o)→ 拦截且 toast 指名字段', async () => {
  addIngress.mockClear()
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'bad2'; w.vm.createForm.host = 'a.test'; w.vm.createForm.serviceName = 's'
  w.vm.adv['proxy-send-timeout'] = '6o'   // 数字框拦不住脚本注入,走校验器兜底
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  expect(addIngress).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('发送超时'))
})
```

(「发送超时」= `ingressPerf.sendTimeout` 的 zh 文案,断言 toast 指名字段。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsIngress.dialect.test.js`
Expected: 新增 3 例 FAIL(无单位下拉/无拦截)

- [ ] **Step 3: 实现视图接入**

`src/views/NsIngress.vue`:

(a) import 区(第 16 行既有 useIngressPerf import 扩展,并新增):
```js
import { dialectGroups, dialectHint, detectDialect, buildIngressAnnotations, validateIngressAdv, validateCustomAnnotations, hintKeyOfKey, placeholderOfKey } from '@/composables/useIngressPerf'
import IngressPerfField from '@/components/common/IngressPerfField.vue'
import { notify } from '@/composables/useToast'
```

(b) `handleCreate`(约 112 行)函数体开头插入门:
```js
async function handleCreate() {
  const f = createForm.value
  const errs = [...validateIngressAdv(createDialect.value, adv.value), ...validateCustomAnnotations(customAnnotations.value)]
  if (errs.length) {
    notify('error', t('ingressPerf.invalidField', { field: t(errs[0].labelKey), msg: t(errs[0].msgKey) }))
    return
  }
  const r = await store.addIngress({
```

(c) 字段循环(约 317-324 行)整块替换为:
```html
          <div v-for="fld in g.fields" :key="fld.key">
            <IngressPerfField v-model="adv[fld.key]" :fld="fld" />
          </div>
```
(删除原 textarea/select/input 三分支。)

(d) 自定义注解值输入(约 336 行)替换为(带 hint/示例 placeholder):
```html
          <div class="flex-1 flex flex-col gap-xs">
            <input v-model="a.value" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="placeholderOfKey(a.key) || t('ns.ingress.valuePlaceholder')" />
            <p v-if="hintKeyOfKey(a.key)" class="text-xs text-on-surface-variant">{{ t(hintKeyOfKey(a.key)) }}</p>
          </div>
```

- [ ] **Step 4: 跑测试确认通过(含既有回归)**

Run: `npx vitest run src/views/__tests__/NsIngress.dialect.test.js`
Expected: PASS 全部(既有 4 例不受影响——entrypoints 字段仍是有 placeholder 的文本框)

- [ ] **Step 5: 提交**

```bash
git add src/views/NsIngress.vue src/views/__tests__/NsIngress.dialect.test.js
git commit -m "feat(ingress): NsIngress 创建接入 vt 渲染+提交拦截——性能面板/自定义注解非法值客户端拦截"
```

---

### Task 4: DeployApp.vue 接入(渲染收敛 + validate() 第 5 步校验)

**Files:**
- Modify: `src/views/DeployApp.vue`(imports、validate() 追加 step 4 校验、字段循环替换、自定义注解值输入)

**Interfaces:**
- Consumes: 同 Task 3(组件+校验器+hint 辅助)

(本任务不改测试——视图接线为 4 行,校验逻辑已被 Task 1/3 测试覆盖;DeployApp 组件过重不宜 mount。接线正确性由 Task 6 全量回归与手测保障。)

- [ ] **Step 1: 实现接入**

(a) 第 9 行既有 useIngressPerf import 扩展,并新增组件 import:
```js
import { dialectGroups, dialectHint, detectDialect, buildIngressAnnotations, validateIngressAdv, validateCustomAnnotations, hintKeyOfKey, placeholderOfKey } from '@/composables/useIngressPerf'
import IngressPerfField from '@/components/common/IngressPerfField.vue'
```

(b) `validate()`(659 行起)在 `return errs` 前追加(perf 面板在 `currentStep === 4`,即向导第 5 步;handleDeploy 既有逻辑会跳到该步并列错):
```js
  if (f.createIngress) {
    for (const e of validateIngressAdv(ingressDialect.value, f.ingressAdv)) errs.push({ step: 4, msg: t('ingressPerf.invalidField', { field: t(e.labelKey), msg: t(e.msgKey) }) })
    for (const e of validateCustomAnnotations(f.ingressCustomAnnotations)) errs.push({ step: 4, msg: t('ingressPerf.invalidField', { field: t(e.labelKey), msg: t(e.msgKey) }) })
  }
  return errs
```

(c) 字段循环(约 1489-1496 行)整块替换为:
```html
                    <div v-for="fld in g.fields" :key="fld.key">
                      <IngressPerfField v-model="form.ingressAdv[fld.key]" :fld="fld" />
                    </div>
```

(d) 自定义注解值输入(约 1507 行)替换为:
```html
                    <div class="flex-1 flex flex-col gap-xs">
                      <input v-model="a.value" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="placeholderOfKey(a.key) || 'value'" />
                      <p v-if="hintKeyOfKey(a.key)" class="text-xs text-on-surface-variant">{{ $t(hintKeyOfKey(a.key)) }}</p>
                    </div>
```

- [ ] **Step 2: 语法与回归确认**

Run: `npx vitest run src/stores src/composables`(基线无破坏)+ `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/views/DeployApp.vue
git commit -m "feat(ingress): DeployApp 向导接入 vt 渲染+第 5 步校验(复用 handleDeploy 跳步机制)"
```

---

### Task 5: NsIngressDetail.vue 注解弹窗(按已知 key 提示 + 保存校验)

**Files:**
- Modify: `src/views/NsIngressDetail.vue`(imports、addAnnotation/saveAnn 校验门、添加/编辑弹窗 value 输入)

**Interfaces:**
- Consumes: `validateAdvValue`/`vfmtOfKey`/`hintKeyOfKey`/`placeholderOfKey`(Task 1);`notify` 该文件已 import(第 8 行)

(不改测试:接线 4 行,校验器已单测;NsIngressDetail mount 成本高。)

- [ ] **Step 1: 实现接入**

(a) import 区新增:
```js
import { validateAdvValue, vfmtOfKey, hintKeyOfKey, placeholderOfKey } from '@/composables/useIngressPerf'
```

(b) `addAnnotation`(约 218 行)与 `saveEditAnn`(约 233 行)开头插入门:
```js
function addAnnotation() {
  if (!newAnnKey.value) return
  const fld = vfmtOfKey(newAnnKey.value)
  const msgKey = fld ? validateAdvValue(fld, newAnnValue.value) : null
  if (msgKey) { notify('error', t('ingressPerf.invalidField', { field: t(fld.labelKey), msg: t(msgKey) })); return }
  // ……原有写注解逻辑不动
}
function saveEditAnn() {
  if (editingAnn.value === null) return
  const fld = vfmtOfKey(editingAnn.value)
  const msgKey = fld ? validateAdvValue(fld, editAnnValue.value) : null
  if (msgKey) { notify('error', t('ingressPerf.invalidField', { field: t(fld.labelKey), msg: t(msgKey) })); return }
  // ……原有写注解逻辑不动
}
```

(c) 添加注解弹窗 value textarea(约 472 行)替换:
```html
        <div class="flex-1 flex flex-col gap-xs">
          <textarea v-model="newAnnValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-20 resize-y focus:ring-2 focus:ring-primary" :placeholder="placeholderOfKey(newAnnKey) || t('ns.ingressDetail.valuePlaceholder')"></textarea>
          <p v-if="hintKeyOfKey(newAnnKey)" class="text-xs text-on-surface-variant">{{ t(hintKeyOfKey(newAnnKey)) }}</p>
        </div>
```

(d) 行内编辑 textarea(约 443 行,`v-model="editAnnValue"` 所在行)替换:
```html
              <div v-if="editingAnn === key" class="flex flex-col gap-xs mt-1">
                <div class="flex gap-xs">
                  <textarea v-model="editAnnValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-xs font-mono min-h-[48px] resize-y focus:ring-1 focus:ring-primary" :placeholder="placeholderOfKey(editingAnn) || ''"></textarea>
                  <!-- 原 443 行 textarea;其后的保存/取消按钮行保持不动 -->
                </div>
                <p v-if="hintKeyOfKey(editingAnn)" class="text-xs text-on-surface-variant">{{ $t(hintKeyOfKey(editingAnn)) }}</p>
              </div>
```
(原 442 行外层 `div.flex.gap-xs.mt-1` 内含 textarea + 保存 + 取消按钮;改为上述结构时保存/取消按钮保持在 `div.flex.gap-xs` 内。)

- [ ] **Step 2: 语法与回归确认**

Run: `npx vitest run src/stores src/composables` + `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/views/NsIngressDetail.vue
git commit -m "feat(ingress): 注解编辑弹窗按已知 key 给格式提示+保存校验(编辑侧同享单一事实源)"
```

---

### Task 6: 全应用表单审计报告 + 全量回归

**Files:**
- Create: `docs/form-field-audit-2026-08-16.md`
- 无代码改动

- [ ] **Step 1: 系统性扫描**

```bash
grep -rn 'type="number"' src/views src/components --include='*.vue' | grep -v __tests__
grep -rn 'placeholder="[^"]*[0-9][mMgGiK]' src/views src/components --include='*.vue' | grep -v __tests__
grep -rln 'ResourceInput' src/views src/components --include='*.vue' | grep -v __tests__
grep -rn '<input' src/views --include='*.vue' | grep -v __tests__ | grep -vE 'type="(checkbox|radio)"' | wc -l
```
对 grep 结果逐视图归类(重点核对:PVC 大小、HPA 目标值、ResourceQuota hard、LimitRange、Service 端口、ConfigMap/Secret 编辑、NetworkPolicy 端口、DeployApp 资源/端口/环境变量)。

- [ ] **Step 2: 写审计报告**

`docs/form-field-audit-2026-08-16.md` 结构:

```markdown
# 全应用表单字段审计——「纯数值选单位 / 格式受限给提示」合规清单

日期:2026-08-16 | 规则:纯数值字段应提供单位选择;格式受限字段应提示输入格式 | Ingress 面已于本日修复(见 spec)

## 结论摘要
- 已合规(有单位选择/结构化约束):N 处
- 不合规(纯数值裸文本/缺格式提示):N 处,按风险排序
- 自由文本(规则不适用):N 处

## 明细
| 视图/组件 | 字段 | 分类 | 现状 | 建议 | 风险 |
|---|---|---|---|---|---|
| Ingress 性能面板(4 方言) | 47 字段 | 数值+单位/格式受限 | ✅ 已修(vt 元信息) | — | — |
| CreatePvcDialog | 容量 | 数值+单位 | <实测填写> | 数字框+Gi/Mi 下拉 | 中(错值创建失败,远端有报错兜底) |
| ……(逐行补齐扫描结果) | | | | | |

## Backlog 建议(按风险排序)
1. ……
```

分类枚举:`数值+单位`(应数字框+单位)/ `纯数值`(应数字框+固定单位后缀)/ `格式受限`(应 hint+校验)/ `已合规`(已有 ResourceInput/select/校验)/ `自由文本`(不适用)。风险列写「错值后果 + 有无远端兜底」。

- [ ] **Step 3: 全量回归**

Run: `npm test`(server + unit 全量)+ `npm run typecheck` + i18n 门禁(同 Task 1 Step 7 命令)
Expected: 全绿(93+ 测试文件,0 fail)

- [ ] **Step 4: 提交**

```bash
git add docs/form-field-audit-2026-08-16.md
git commit -m "docs: 全应用表单字段审计——单位选择/格式提示合规清单与 backlog"
```

---

## 任务间依赖

Task 1 → Task 2 → Task 3/4/5(依赖 1+2)→ Task 6(独立,可并行)。Task 3/4/5 相互独立。
