/** One palette, shared by every screen so the UI reads as one system. */
export const THEME = {
  accent: '#7aa2f7',
  accent2: '#bb9af7',
  dim: '#565f89',
  text: '#c0caf5',
  warn: '#e0af68',
  err: '#f7768e',
  ok: '#9ece6a',
  bg: '#1a1b26',
  /** Panels sit one step above the background. */
  panel: '#1f2335',
  border: '#3b4261',
  /** A selected row or a focused button. */
  highlight: '#2f3549',
  /** Text on an accent-filled button. */
  onAccent: '#1a1b26',
} as const;

/** The logo's gradient, cycled to animate it. */
export const GRADIENT = [
  '#7aa2f7', '#7da6ff', '#89b4fa', '#9d7cd8', '#bb9af7', '#c0a8ff', '#bb9af7', '#9d7cd8', '#89b4fa', '#7da6ff',
] as const;
