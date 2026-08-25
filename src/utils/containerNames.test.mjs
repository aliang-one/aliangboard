// sanitizeImageToName:镜像串 → DNS-1123 容器名基名(纯变换,无 fallback/去重)。
// 从 DeployApp derivedContainerName 抽出单源:YAML 生成与「完整编辑」弹窗自动命名预览共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeImageToName } from './containerNames.js'

test('sanitizeImageToName: registry 前缀/tag/大写/下划线/点 → DNS-1123', () => {
  assert.equal(sanitizeImageToName('ghcr.io/Org/My_App:v1.2'), 'my-app')
  assert.equal(sanitizeImageToName('nginx'), 'nginx')
  assert.equal(sanitizeImageToName('docker.io/library/app:1'), 'app')
})

test('sanitizeImageToName: 空串/null/全非法 → 空串(fallback 由调用方)', () => {
  assert.equal(sanitizeImageToName(''), '')
  assert.equal(sanitizeImageToName(null), '')
  assert.equal(sanitizeImageToName('???'), '')
})

test('sanitizeImageToName: 首尾连字符修剪 + 63 截断 + 尾连字符再修剪', () => {
  assert.equal(sanitizeImageToName('-nginx-'), 'nginx')
  assert.equal(sanitizeImageToName('a'.repeat(80)).length, 63)
})
