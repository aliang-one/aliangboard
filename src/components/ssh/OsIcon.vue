<script setup>
// 服务器 OS 发行版图标:simple-icons(CC0)SVG 已 vendor 进 src/assets/os/,离线可用。
// osId 来自服务端 OS 探测(normalizeOsId 归一后的 slug),未知发行版回退 Tux(linux)。
import { computed } from 'vue'

const props = defineProps({
  osId: { type: String, default: '' },
  osName: { type: String, default: '' },
  size: { type: Number, default: 18 },
})

const files = import.meta.glob('../../assets/os/*.svg', { query: '?raw', import: 'default', eager: true })

// 品牌色(近似官方,单色 SVG 注入 fill)
const META = {
  ubuntu: { color: '#E95420' }, archlinux: { color: '#1793D1' }, debian: { color: '#C70036' },
  centos: { color: '#9CCD2A' }, rockylinux: { color: '#10B981' }, almalinux: { color: '#243877' },
  fedora: { color: '#51A2DA' }, opensuse: { color: '#73BA25' }, alpinelinux: { color: '#0D597F' },
  redhat: { color: '#EE0000' }, kalilinux: { color: '#367C9B' }, gentoo: { color: '#54487A' },
  nixos: { color: '#5277C3' }, raspberrypi: { color: '#C51A4A' }, apple: { color: '#A2AAAD' },
  linux: { color: '#F9BC00' },
}

const slug = computed(() => (props.osId && files[`../../assets/os/${props.osId}.svg`]) ? props.osId : 'linux')
const svg = computed(() => {
  const raw = files[`../../assets/os/${slug.value}.svg`] || ''
  const color = META[slug.value]?.color || '#8A8F98'
  return raw
    .replace('<svg', `<svg fill="${color}" width="${props.size}" height="${props.size}"`)
    .replace(/\n/g, ' ')
})
const tip = computed(() => props.osName || props.osId || '')
</script>

<template>
  <span class="inline-flex items-center justify-center shrink-0" :title="tip" data-test="os-icon" v-html="svg"></span>
</template>
