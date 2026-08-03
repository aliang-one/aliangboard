import { ref, computed, watch } from 'vue'

// 客户端分页工具：传入响应式源列表（通常是 filtered 计算属性），返回分页状态。
// 用法：
//   const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [typeFilter, searchQuery] })
//   模板：v-for 用 paginated；表格外加 <Pagination v-if="total > pageSize" .../>（小列表不显示分页栏，保持原貌）。
// resetDeps：过滤条件变化时回到第 1 页（传过滤相关的 ref 数组）；不传则仅防越界空页。
export function usePagination(source, opts = {}) {
  const pageSize = ref(opts.pageSize ?? 10)
  const currentPage = ref(1)
  const total = computed(() => source.value?.length || 0)
  const paginated = computed(() => {
    const s = source.value || []
    const start = (currentPage.value - 1) * pageSize.value
    return start < s.length ? s.slice(start, start + pageSize.value) : []
  })
  if (opts.resetDeps) watch(opts.resetDeps, () => { currentPage.value = 1 })
  // 防越界：总数缩小到当前页之外时，回退到最后一个有效页（避免空白页）
  watch(total, () => {
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (currentPage.value > maxPage) currentPage.value = maxPage
  })
  return { currentPage, pageSize, paginated, total }
}
