// 批量操作结果汇总:Promise.allSettled 输出与输入数组按索引对齐。
// 返回 { okNames, failedNames } 供调用方拼 notify 文案与保留失败项选中。
export function summarizeResults(results, items, nameOf = it => it?.name ?? '') {
  const okNames = [], failedNames = []
  results.forEach((r, i) => {
    const name = nameOf(items[i])
    if (r.status === 'fulfilled') okNames.push(name)
    else failedNames.push(name)
  })
  return { okNames, failedNames }
}
