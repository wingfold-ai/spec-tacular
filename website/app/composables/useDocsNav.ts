import type { ContentNavigationItem } from '@nuxt/content'

// The docs tree flattened to reading order: what the pager, the status bar and
// the page keys (n / p) walk through. Folders are skipped, their pages kept.
export function flattenDocs(items: ContentNavigationItem[]): { path: string, title: string }[] {
  const out: { path: string, title: string }[] = []
  const walk = (list: ContentNavigationItem[]) => {
    for (const it of list) {
      if (it.page !== false && !it.children?.length) out.push({ path: it.path, title: it.title })
      if (it.children?.length) {
        // a folder with its own index page lists it first
        if (it.page !== false && it.children.every(c => c.path !== it.path)) out.push({ path: it.path, title: it.title })
        walk(it.children)
      }
    }
  }
  walk(items)
  return out
}
