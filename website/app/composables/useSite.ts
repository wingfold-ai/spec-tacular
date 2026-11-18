// Site-wide facts (version, install command, nav) from content/meta/site.yml.
export function useSite() {
  return useAsyncData('site-meta', () => queryCollection('meta').first())
}
