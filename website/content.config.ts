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
