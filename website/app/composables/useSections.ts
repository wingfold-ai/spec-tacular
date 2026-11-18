/**
 * Scroll state of the page, shared by the pipeline bar (top), the status bar
 * (bottom) and the keyboard navigation: which section is current, and which
 * ones the reader has already passed (drawn ✓ like accepted stages in the TUI).
 */
export interface SectionItem { id: string, label: string }

// Until this time (ms) the scroll spy leaves `current` alone: a jump is animating.
let spyPausedUntil = 0

export function useSections() {
  const { data: site } = useSite() // same key as the layout's awaited call: shared data
  const sections = computed<SectionItem[]>(() =>
    (site.value?.nav ?? []).map(n => ({ id: n.to.replace(/^#/, ''), label: n.label })),
  )
  const current = useState<number>('section-current', () => -1)
  const seen = useState<number>('section-seen', () => -1) // furthest section reached

  function indexOf(id: string) {
    return sections.value.findIndex(s => s.id === id)
  }

  function go(i: number) {
    if (!import.meta.client) return
    // Set the target at once, so j j j during a smooth scroll moves three sections.
    const target = Math.max(-1, Math.min(i, sections.value.length - 1))
    current.value = target
    if (target > seen.value) seen.value = target
    spyPausedUntil = Date.now() + 900
    if (target < 0) {
      window.scrollTo({ top: 0 })
      return
    }
    const s = sections.value[target]
    document.getElementById(s?.id ?? '')?.scrollIntoView()
  }

  return { sections, current, seen, indexOf, go }
}

/** Installs the scroll spy once (from the layout). */
export function useSectionSpy() {
  const { sections, current, seen } = useSections()
  onMounted(() => {
    const update = () => {
      if (Date.now() < spyPausedUntil) return
      const line = window.innerHeight * 0.35
      let idx = -1
      sections.value.forEach((s, i) => {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= line) idx = i
      })
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4)
        idx = sections.value.length - 1
      current.value = idx
      if (idx > seen.value) seen.value = idx
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update, { passive: true })
    onBeforeUnmount(() => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    })
  })
}
