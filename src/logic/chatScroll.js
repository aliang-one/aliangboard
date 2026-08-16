// 聊天滚动判定的纯函数(WorkbenchChat 消费;抽出便于单测)。
// 「贴底」阈值:距底部 < 100px 视为用户在底部(标准聊天跟随判定,读历史不打扰)。
export const NEAR_BOTTOM_PX = 100
export function isNearBottomCalc(scrollHeight, scrollTop, clientHeight) {
  return scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX
}
