// SQLite 连接性能批(2026-09-08):部署实例实测 journal_mode=delete(默认)下每条 INSERT
// 同步阻塞事件循环 ~20ms(回滚日志 = 2+ 次 fsync + journal 文件建删;该 PVC 上单次 fsync
// 实测 4.8ms)。审计 started/finalized 双写、会话持久化等都在热路径上串行吃这笔开销,
// 并发请求在事件循环上排队(6 并发 burst 实测 ~40ms/个间隔串行完成)。
// WAL + synchronous=NORMAL 把单写降到 <1ms(写入仍持久,WAL checkpoint 兜底崩溃一致性;
// 单进程不变式不受影响——写者仍唯一,<db>.lock 启动锁防线不动)。
export function enableFastJournal(db) {
  const row = db.prepare('PRAGMA journal_mode=WAL').get()
  db.exec('PRAGMA synchronous=NORMAL')
  return row?.journal_mode || null
}
