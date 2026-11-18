<script setup lang="ts">
/**
 * The page background: a terminal character grid, like an idle TUI.
 * - every cell is a faint `·`; a slow diagonal wave of the logo gradient
 *   (accent → accent2) brightens it as it passes;
 * - cells near the pointer light up and show a glyph (○ ● ✓ │ ─ ░ …);
 * - now and then a cell flashes a green ✓ — a requirement being accepted.
 * Drawn on one fixed canvas, behind the content, at low contrast.
 * Reduced motion: one still frame, no animation.
 */
const canvas = ref<HTMLCanvasElement | null>(null)

const GLYPHS = ['○', '●', '✓', '│', '─', '░', '▸', '┼', '◐', '✗', '·', '+']
const CELL_W = 18
const CELL_H = 26

onMounted(() => {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const css = getComputedStyle(document.documentElement)
  let colors = readColors()
  function readColors() {
    const v = (n: string) => css.getPropertyValue(n).trim()
    return {
      faint: hexToRgb(v('--st-faint') || '#565f89'),
      a: hexToRgb(v('--st-accent') || '#7aa2f7'),
      b: hexToRgb(v('--st-accent2') || '#bb9af7'),
      ok: hexToRgb(v('--st-ok') || '#9ece6a'),
      err: hexToRgb(v('--st-err') || '#f7768e'),
      warn: hexToRgb(v('--st-warn') || '#e0af68'),
      light: document.documentElement.classList.contains('light'),
    }
  }

  let cols = 0
  let rows = 0
  let glyph: Uint8Array = new Uint8Array(0) // glyph index per cell, shown near the pointer
  let dpr = 1
  // a review running across the screen: mostly accepted, some rejected or deferred
  const DECISIONS = [['✓', 'ok'], ['✓', 'ok'], ['✓', 'ok'], ['✓', 'ok'], ['✗', 'err'], ['⏸', 'warn']] as const
  const flashes: { c: number, r: number, t: number, d: number }[] = []
  const pointer = { x: -9999, y: -9999 }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = window.innerWidth
    const h = window.innerHeight
    el!.width = w * dpr
    el!.height = h * dpr
    el!.style.width = `${w}px`
    el!.style.height = `${h}px`
    cols = Math.ceil(w / CELL_W) + 1
    rows = Math.ceil(h / CELL_H) + 1
    glyph = new Uint8Array(cols * rows)
    for (let i = 0; i < glyph.length; i++) glyph[i] = Math.floor(Math.random() * GLYPHS.length)
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx!.font = '13px "JetBrains Mono", ui-monospace, monospace'
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
  }

  function draw(t: number) {
    const { faint, a, b, light } = colors
    const base = light ? 0.22 : 0.16
    ctx!.clearRect(0, 0, window.innerWidth, window.innerHeight)
    // the page scrolls past a fixed field: offset rows a little for parallax
    const shift = (window.scrollY * 0.15) % CELL_H
    // keep the content column calm: the field lives in the margins
    const mid = window.innerWidth / 2
    const half = Math.min(window.innerWidth, 1216) / 2 - 16
    for (let r = 0; r < rows; r++) {
      const y = r * CELL_H - shift + CELL_H / 2
      for (let c = 0; c < cols; c++) {
        const x = c * CELL_W + CELL_W / 2
        const edge = Math.min(1, Math.max(0, (Math.abs(x - mid) - half + 60) / 120))
        const calm = 0.18 + 0.82 * edge // 0.18 under the content, 1 in the margins
        // slow diagonal wave
        const wave = Math.max(0, Math.sin(c * 0.11 + r * 0.17 - t * 0.0006)) ** 6
        // pointer halo
        const dx = x - pointer.x
        const dy = y - pointer.y
        const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 170)
        const glow = Math.max(wave * 0.8 * calm, near * (0.35 + 0.65 * calm))
        const mix = c / cols
        const col = glow > 0.02 ? lerp(a, b, mix) : faint
        const alpha = base * (0.5 + 0.5 * calm) + glow * (light ? 0.5 : 0.62)
        ctx!.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`
        // the wave's crest and the pointer halo reveal each cell's glyph
        ctx!.fillText((near > 0.25 && calm > 0.5) || wave * calm > 0.72 ? GLYPHS[glyph[r * cols + c]!]! : '·', x, y)
      }
    }
    // accepted ✓ flashes
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]!
      const age = (t - f.t) / 1600
      if (age >= 1) { flashes.splice(i, 1); continue }
      const alpha = (1 - age) * (light ? 0.75 : 0.85)
      const [g, tone] = DECISIONS[f.d]!
      const rgb = colors[tone]
      ctx!.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
      ctx!.fillText(g, f.c * CELL_W + CELL_W / 2, f.r * CELL_H - shift + CELL_H / 2)
    }
  }

  let raf = 0
  let last = 0
  let nextFlash = 0
  function loop(t: number) {
    raf = requestAnimationFrame(loop)
    if (document.hidden || t - last < 50) return // ~20 fps is plenty for a background
    last = t
    if (t > nextFlash) {
      // flashes land in the margins (outside the content column) where there is room
      const half = Math.min(window.innerWidth, 1216) / 2
      const free = Math.max(1, Math.floor((window.innerWidth / 2 - half) / CELL_W))
      const side = Math.random() < 0.5
      const c = window.innerWidth - 2 * half < 4 * CELL_W
        ? Math.floor(Math.random() * cols)
        : side ? Math.floor(Math.random() * free) : cols - 1 - Math.floor(Math.random() * free)
      flashes.push({ c, r: Math.floor(Math.random() * rows), t, d: Math.floor(Math.random() * DECISIONS.length) })
      nextFlash = t + 250 + Math.random() * 650
    }
    draw(t)
  }

  const onMove = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY }
  const onLeave = () => { pointer.x = -9999; pointer.y = -9999 }
  const onResize = () => { resize(); if (reduced) draw(0) }
  // re-read the tokens when the theme class on <html> changes
  const themeObserver = new MutationObserver(() => { colors = readColors(); if (reduced) draw(0) })

  resize()
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', onResize)
  if (reduced) {
    draw(0)
  }
  else {
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    raf = requestAnimationFrame(loop)
  }

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf)
    themeObserver.disconnect()
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerleave', onLeave)
  })
})

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = Number.parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lerp(a: number[], b: number[], t: number): [number, number, number] {
  return [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as [number, number, number]
}
</script>

<template>
  <canvas ref="canvas" class="pointer-events-none fixed inset-0 z-0" aria-hidden="true" />
</template>
