// 关键路径守卫(2026-09-09 LCP 5.96s 根因修复的组成部分):
// api/client.js 是入口静态图成员,顶层 import js-yaml 会让 client chunk 持有 YAML 解析器
// 的静态边——而它在 client.js 内只有 exportYaml(导出下载)一个使用点,已改动态 import。
// 注意:js-yaml 当前仍在入口 modulepreload(stores/cluster.js / stores/cluster/yaml.js /
// composables/useYaml.js 三个急加载引入者,generateYAML 同步调用面广,异步化是独立后续项);
// 本守卫锁 client.js 不再成为静态边的「再入口」。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', 'client.js')

test('api/client.js 不得静态 import js-yaml(登录页关键路径守卫)', () => {
  const src = readFileSync(CLIENT, 'utf8')
  const staticImport = /^import\s[^;]*['"]js-yaml['"]/m
  assert.ok(!staticImport.test(src),
    'api/client.js 出现 js-yaml 静态 import——请在唯一使用点(exportYaml)改为 '
    + 'const { dump } = await import("js-yaml") 动态加载,让构建器把它切出首屏关键路径')
})
