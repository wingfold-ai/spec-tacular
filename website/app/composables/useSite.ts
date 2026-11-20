// Site-wide facts: install command and nav from content/meta/site.yml, and
// the version from the repository's package.json (nuxt.config.ts), so a
// release never needs the site edited by hand.
export function useSite() {
  const version = useRuntimeConfig().public.version as string
  return useAsyncData('site-meta', async () => {
    const meta = await queryCollection('meta').first()
    return meta ? { ...meta, version } : null
  })
}
