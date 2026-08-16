// 存储用量统计(工作台「记录」页空间面板):data 目录/SQLite 库/工作台 git 仓库
// + 每集群(台账)·每项目(repo)明细 + 主机磁盘余量。抽独立模块便于单测(fs 走注入可换)。
import { statSync, readdirSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join, dirname } from 'node:path'

// 目录递归大小(带文件数;上限 maxEntries 防病态仓库拖死请求)
export function dirSize(dirPath, { maxEntries = 100000 } = {}) {
  let size = 0, files = 0
  const walk = p => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (files++ > maxEntries) return // 仅计文件;上限防病态仓库
      try { size += statSync(full).size } catch { /* 并发变更,跳过 */ }
    }
  }
  walk(dirPath)
  return { size, files }
}

// 聚合存储信息。db 仅用于把 clusterId/projectId 映射成可读名(表查不到则截断 id)。
export async function computeStorageInfo({ dbPath, workbenchDir, db }) {
  let dbSize = 0
  try { dbSize = statSync(dbPath).size } catch { /* 库文件不可读,显示 0 */ }
  const wb = dirSize(workbenchDir)
  const dataDir = dirname(dbPath)
  const dataTotal = dirSize(dataDir)

  // workbench/<clusterId>/{cluster-context(台账), projects/<pid>(项目 repo)} 逐级明细
  const clusters = []
  let clusterDirs = []
  try { clusterDirs = readdirSync(workbenchDir, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { /* 目录不可读 */ }
  for (const c of clusterDirs) {
    const cid = c.name
    const entry = {
      clusterId: cid,
      clusterName: db.prepare('SELECT name FROM clusters WHERE id=?').get(cid)?.name || cid.slice(0, 8),
      ledgerSize: dirSize(join(workbenchDir, cid, 'cluster-context')).size,
      projects: [],
    }
    let pdirs = []
    try { pdirs = readdirSync(join(workbenchDir, cid, 'projects'), { withFileTypes: true }).filter(e => e.isDirectory()) } catch { /* 无 projects */ }
    for (const p of pdirs) {
      const pid = p.name
      const prow = db.prepare('SELECT name FROM workbench_projects WHERE id=?').get(pid)
      entry.projects.push({ projectId: pid, projectName: prow?.name || pid.slice(0, 8), size: dirSize(join(workbenchDir, cid, 'projects', pid)).size })
    }
    entry.projects.sort((a, b) => b.size - a.size)
    clusters.push(entry)
  }
  const totalOf = e => e.ledgerSize + e.projects.reduce((s, p) => s + p.size, 0)
  clusters.sort((a, b) => totalOf(b) - totalOf(a))

  // 主机磁盘(所在卷):statfs 不支持的平台/文件系统 → null,前端隐藏该行
  let diskTotal = null, diskFree = null
  try {
    const st = await statfs(dataDir)
    diskTotal = Number(st.blocks) * Number(st.bsize)
    diskFree = Number(st.bavail) * Number(st.bsize)
  } catch { /* 不支持 */ }

  return {
    dataDir, dataTotalSize: dataTotal.size, dataTotalFiles: dataTotal.files,
    dbPath, dbSize,
    workbenchDir, workbenchSize: wb.size, workbenchFiles: wb.files,
    diskTotal, diskFree,
    clusters,
  }
}
