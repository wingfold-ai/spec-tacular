import { defineCollection, defineContentConfig, z } from '@nuxt/content'

// One markdown file per page. The landing page is content/index.md:
// frontmatter for SEO, body made of MDC section components.
export default defineContentConfig({
  collections: {
    pages: defineCollection({
      type: 'page',
      source: { include: '*.md' },
      schema: z.object({
        seoTitle: z.string().optional(),
        status: z.enum(['draft', 'published']).default('published'),
      }),
    }),
    // In-depth documentation under /docs. Folder and file names carry a
    // numeric prefix for ordering (1.getting-started/2.installation.md →
    // /docs/getting-started/installation); .navigation.yml titles a folder.
    docs: defineCollection({
      type: 'page',
      source: 'docs/**/*.md',
      schema: z.object({
        navTitle: z.string().optional(),
      }),
    }),
    meta: defineCollection({
      type: 'data',
      source: 'meta/site.yml',
      schema: z.object({
        version: z.string(),
        repo: z.string(),
        install: z.string(),
        installNote: z.string(),
        nav: z.array(z.object({ label: z.string(), to: z.string() })),
        footer: z.array(z.object({ label: z.string(), to: z.string() })),
      }),
    }),
  },
})
