// spec-tacular.app — the landing page for the spec-tacular TUI.
// Static site: `pnpm generate` writes .output/public for GitHub Pages.
import { readFileSync } from 'node:fs'
import { llmsTxt } from './llms.config'

// The release this site describes: the repository's own version.
const version = `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`

export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: true,

  runtimeConfig: {
    public: { version },
  },

  modules: ['@nuxt/ui', '@nuxt/content', '@nuxtjs/seo', '@nuxt/fonts'],

  css: ['~/assets/css/main.css'],

  // Flat, prefix-free components so they resolve as MDC tags in content/*.md.
  components: [{ path: '~/components', pathPrefix: false }],

  // Dark first: the product is a dark terminal UI.
  colorMode: { preference: 'dark', fallback: 'dark' },

  site: {
    url: 'https://spec-tacular.app',
    name: 'spec-tacular',
    description: 'Review every requirement your coding agent writes, before it builds anything. A terminal UI for spec-driven development on top of OpenSpec.',
    defaultLocale: 'en',
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'theme-color', content: '#1a1b26', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#f5f6fb', media: '(prefers-color-scheme: light)' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      script: [
        // Cookieless, self-hosted Plausible (same setup as the other sites).
        { 'src': 'https://stats.marius-hoegger.ch/js/script.js', 'defer': true, 'data-domain': 'spec-tacular.app' },
      ],
    },
  },

  fonts: {
    families: [
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500, 700, 800], styles: ['normal', 'italic'] },
    ],
  },

  ui: { fonts: false },

  content: {
    build: {
      markdown: {
        highlight: { theme: { default: 'tokyo-night', light: 'github-light' }, langs: ['bash', 'yaml', 'md'] },
      },
    },
  },

  // /llms.txt: key facts, then the docs grouped like the sidebar (llms.config.ts).
  aiReady: { llmsTxt: llmsTxt() },

  schemaOrg: {
    identity: { type: 'Person', name: 'Marius Högger', url: 'https://marius-hoegger.ch' },
  },

  ogImage: { enabled: false },

  // A static landing page needs no deploy-skew service worker (it served stale
  // content during development).
  skewProtection: { enabled: false },

  nitro: {
    preset: 'static',
    prerender: { routes: ['/', '/sitemap.xml'], crawlLinks: true },
  },
})
