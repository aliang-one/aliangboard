// SSH 凭据静态加密:AES-256-GCM 字段级加解密。密钥文件与 DB 分离(库泄露 ≠ 凭据泄露)。
// 密文格式 v1:<iv_b64>:<tag_b64>:<data_b64>;空值加密返 null(字段可选语义)。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

export function loadOrCreateKey(keyPath) {
  if (existsSync(keyPath)) {
    const k = readFileSync(keyPath)
    if (k.length !== 32) throw new Error(`SSH 凭据密钥文件损坏(应为 32 字节,实际 ${k.length}): ${keyPath}`)
    return k
  }
  mkdirSync(dirname(keyPath), { recursive: true })
  const k = randomBytes(32)
  const fd = openSync(keyPath, 'wx', 0o600)   // 'wx' + mode:新建即 0600
  try { writeFileSync(fd, k) } finally { closeSync(fd) }
  return k
}

export function encryptField(key, plaintext) {
  if (plaintext == null || plaintext === '') return null
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()])
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`
}

export function decryptField(key, enc) {
  if (!enc) return null
  const parts = String(enc).split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('SSH 凭据密文格式非法')
  const [, ivB64, tagB64, dataB64] = parts
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  d.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8')
}
