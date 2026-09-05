// 每页行数全局默认单源(2026-09-04 Wave1 §3.4)。preferences store hydrate/set 时推进;
// usePagination 等无 pinia 消费方直接 import,避免 composable 依赖 store(无 pinia 测试消费者历史事故)。
import { ref } from 'vue'

export const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100]
export const rowsPerPageDefault = ref(10)

export function setRowsPerPageDefault(n) {
  const v = Number(n)
  rowsPerPageDefault.value = ROWS_PER_PAGE_OPTIONS.includes(v) ? v : 10
}
