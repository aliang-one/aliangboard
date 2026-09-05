// 头像文件 → 256×256 data URL(2026-09-04 Wave1 §3.5)。前端 canvas 中心裁剪+压缩,服务端只做兜底校验。
// squareCrop 是纯函数(单测);fileToAvatarDataUrl 依赖 Image/canvas(真浏览器路径,happy-dom 不测)。
export const AVATAR_SIZE = 256

export function squareCrop(w, h) {
  const s = Math.min(w, h)
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s }
}

export function isSupportedImage(file) {
  return !!file && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
}

export function fileToAvatarDataUrl(file) {
  return new Promise((resolve) => {
    if (!isSupportedImage(file)) { resolve(null); return }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const { sx, sy, s } = squareCrop(img.naturalWidth, img.naturalHeight)
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE; canvas.height = AVATAR_SIZE
        canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch { resolve(null) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}
