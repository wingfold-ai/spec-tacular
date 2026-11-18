<script setup lang="ts">
// The TUI home screen's logo: OpenTUI's `block` font (rendered from @opentui/core,
// so it is the same glyphs the terminal draws), typed in, then the logo gradient
// (THEME GRADIENT in src/tui/theme.ts) keeps drifting. Narrow screens get `tiny`,
// as narrow terminals do.
const BLOCK = [
  '███████╗ ██████╗  ███████╗  ██████╗        ████████╗  █████╗   ██████╗ ██╗   ██╗ ██╗       █████╗  ██████╗',
  '██╔════╝ ██╔══██╗ ██╔════╝ ██╔════╝        ╚══██╔══╝ ██╔══██╗ ██╔════╝ ██║   ██║ ██║      ██╔══██╗ ██╔══██╗',
  '███████╗ ██████╔╝ █████╗   ██║      █████╗    ██║    ███████║ ██║      ██║   ██║ ██║      ███████║ ██████╔╝',
  '╚════██║ ██╔═══╝  ██╔══╝   ██║      ╚════╝    ██║    ██╔══██║ ██║      ██║   ██║ ██║      ██╔══██║ ██╔══██╗',
  '███████║ ██║      ███████╗ ╚██████╗           ██║    ██║  ██║ ╚██████╗ ╚██████╔╝ ███████╗ ██║  ██║ ██║  ██║',
  '╚══════╝ ╚═╝      ╚══════╝  ╚═════╝           ╚═╝    ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝',
].join('\n')
const TINY = [
  '█▀▀ █▀█ █▀▀ █▀▀ ▄▄ ▀█▀ ▄▀█ █▀▀ █ █ █   ▄▀█ █▀█',
  '▄▄█ █▀▀ ██▄ █▄▄     █  █▀█ █▄▄ █▄█ █▄▄ █▀█ █▀▄',
].join('\n')
</script>

<template>
  <div class="logo select-none" role="img" aria-label="spec-tacular">
    <pre class="logo-art hidden sm:block" aria-hidden="true">{{ BLOCK }}</pre>
    <pre class="logo-art logo-tiny sm:hidden" aria-hidden="true">{{ TINY }}</pre>
  </div>
</template>

<style scoped>
.logo-art {
  margin: 0 auto;
  width: max-content;
  font-family: var(--font-mono);
  line-height: 1;
  letter-spacing: 0;
  /* 107 columns: scale so the block font fits the container on every width. */
  font-size: clamp(5px, 1vw, 13px);
  background: linear-gradient(90deg, #7aa2f7, #7da6ff, #89b4fa, #9d7cd8, #bb9af7, #c0a8ff, #bb9af7, #9d7cd8, #89b4fa, #7da6ff, #7aa2f7);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* type in left to right in 24 column steps, then let the gradient drift */
  clip-path: inset(0 100% 0 0);
  animation: logo-type 0.9s steps(24, end) 0.15s forwards, logo-drift 9s linear 1.1s infinite;
}
.logo-tiny { font-size: clamp(8px, 3.05vw, 15px); line-height: 1.15; }
@keyframes logo-type { to { clip-path: inset(0 0 0 0); } }
@keyframes logo-drift { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .logo-art { animation: none; clip-path: none; }
}
</style>
