// 类型/语法检查基线脚本（零依赖）
//
// 仓库为纯 JavaScript + Vue SFC（未引入 TypeScript），且非目标禁止新增外部依赖，
// 因此「类型检查基线」采用 Node 内置的 `node --check` 对所有 .js/.mjs 源码做语法/结构校验：
//   - 覆盖 src/ 下的纯 JS 模块与 server/index.mjs（后端入口不在 Vite 构建范围内，单独覆盖）。
//   - .vue 单文件组件的 <script> 编译与全量打包校验由 `npm run build`（Vite）负责。
// 二者共同构成依赖无关的「构建/类型」绿色基线，后续改动若引入语法回归会在此失败。
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 递归收集目录下所有 .js / .mjs 文件（跳过构建产物与依赖）。
function collectJsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectJsFiles(full, acc)
    } else if (st.isFile() && /\.(js|mjs)$/.test(name)) {
      acc.push(full)
    }
  }
  return acc
}

const targets = [...collectJsFiles(join(ROOT, 'src')), ...collectJsFiles(join(ROOT, 'server'))]
const failures = []

for (const file of targets) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    failures.push({ file: relative(ROOT, file), stderr: (res.stderr || '').trim() })
  }
}

if (failures.length) {
  console.error(`\n[typecheck] ✗ ${failures.length} 个文件未通过 node --check：\n`)
  for (const f of failures) {
    console.error(`  ✗ ${f.file}`)
    console.error(String(f.stderr).split('\n').map(l => '      ' + l).join('\n'))
  }
  console.error(`\n[typecheck] 共检查 ${targets.length} 个 .js/.mjs 文件，${failures.length} 个失败。`)
  process.exit(1)
}

console.log(`[typecheck] ✓ ${targets.length} 个 .js/.mjs 文件通过 node --check（.vue 由 npm run build 覆盖）。`)
