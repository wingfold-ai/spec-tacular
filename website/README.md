# spec-tacular.app

The landing page for spec-tacular. Nuxt 4.6, Nuxt Content 3, Nuxt UI 4 / Tailwind 4,
prerendered to static HTML and hosted on Infomaniak.

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm generate   # static site in .output/public
```

## Editing content

All copy lives in Markdown. Edit it there, not in the components.

| File | What |
| --- | --- |
| `content/index.md` | The landing page: SEO frontmatter, then one MDC block per section |
| `content/meta/site.yml` | Version, install command, nav and footer links |
| `content/docs/**` | The documentation at `/docs`: numeric prefixes order folders and pages (`1.getting-started/2.quickstart.md` → `/docs/getting-started/quickstart`), `.navigation.yml` titles a folder |


`/llms.txt`, `/llms-full.txt`, the sitemap and robots.txt are generated from the
content by `@nuxtjs/seo` (nuxt-ai-ready, sitemap, robots).

YAML gotcha: inside `{ … }` flow mappings, quote any value that contains a
comma, or it is silently split into a second key and the text is cut off.

Each `::name` / `:::name` block maps to `app/components/Name.vue`; its YAML
between the `---` fences are the component's props.

| Block | Component |
| --- | --- |
| `hero-section` + `review-demo` | Hero with the interactive review screen (`a` `x` `d` `r` work in the browser) |
| `page-section` | A section wrapper: `id`, `eyebrow`, `title`, `lead`, `band` |
| `problem-list`, `pipeline-flow`, `feature-grid` | Problem, gated pipeline, features |
| `terminal-block`, `file-tree` | Real CLI output, files written to the repo |
| `compare-table`, `evidence-table` | Comparison with alternatives, eval results |
| `install-steps`, `faq-list`, `cta-banner` | Install, FAQ, closing call to action |

## Docs

`/docs` is rendered by `app/pages/docs/[...slug].vue` in `app/layouts/docs.vue`:
a page tree (`DocsSidebar`), an outline (`DocsToc`), previous/next (`DocsPager`)
and a status bar with page keys (`DocsStatusBar`: `p`/`n`, `h` home, `t` theme).
Pages can use Nuxt UI's prose components (`::note`, `::tip`, `::warning`,
`::caution`, `::steps`, `::code-group`) and the site's own (`:key-cap{k="a"}`,
`::terminal-block`, `::file-tree`). Every claim is checked against `src/` and
the README; on-screen strings are quoted from the source.

## Design

The page is drawn like a spec-tacular session: the TUI's block-font logo
(`AsciiLogo.vue`, glyphs rendered from `@opentui/core`), the section pipeline as
the top bar (`SiteHeader.vue`), a fixed status bar with keyboard navigation
(`StatusBar.vue`: `j`/`k`, `1`–`9`, `g`/`G`, `t`, `?`), titled square boxes
(`TuiPanel.vue`) and a character-grid background (`BackgroundField.vue`).

Colours are the TUI's own `THEME` (`src/tui/theme.ts`) as CSS tokens in
`app/assets/css/main.css` (`--st-*`, Tailwind `bg-st-*`/`text-st-*`). Dark is
the default; light is Tokyo Night Day. One font: JetBrains Mono, self-hosted by
`@nuxt/fonts`.

Brand: `public/brand/icon.svg` (app icon), `icon-mono.svg`, `logo-lockup.svg`
(wordmark is live text in JetBrains Mono), and `public/favicon.svg` (a copy of
the icon).

## Positioning

- **For:** developers and teams who code with Claude Code or opencode and want
  to stay in control. The first audience is existing OpenSpec users. Next come
  teams adopting spec-driven development, then solo devs.
- **Promise:** accept, reject or defer every requirement your agent writes,
  before it builds anything.
- **Proof:** the review loop itself, shown live in the hero. No competitor
  page shows review. Claims are backed by the eval runs in `../evals/`.
- **Rules for copy:** say "evidence", not "proof". The boundary is flagged, not
  enforced. Do not claim Windows support, other agents or 1.0
  before they exist.

## Deployment

`.github/workflows/deploy-website.yml` builds the site and uploads
`.output/public` to the Infomaniak web hosting of spec-tacular.app by FTPS,
like bundlemcp's docs. It runs on every push to `main` that touches
`website/`, and by hand (Actions → Deploy website → Run workflow). Pull
requests only build and check the size: the hosting quota is 10 MB, the
workflow fails above 9 MiB.

| Setting | Kind | Value |
| --- | --- | --- |
| `INFOMANIAK_FTP_SERVER` | secret | FTP host from the Infomaniak manager |
| `INFOMANIAK_FTP_USERNAME` | secret | FTP account user |
| `INFOMANIAK_FTP_PASSWORD` | secret | FTP account password |
| `INFOMANIAK_FTP_SERVER_DIR` | variable, optional | site folder on the server, ending in `/` (default `./`) |
| `INFOMANIAK_FTP_PROTOCOL` | variable, optional | `ftps` (default) or `ftp` |
| `SITE_AUTH_USER`, `SITE_AUTH_PASSWORD` | secrets, optional | while set, the site asks for this login (`deploy/basic-auth.htaccess`) |

`public/.htaccess` redirects to HTTPS and to the bare domain, serves
`/404.html`, and caches `/_nuxt/` (hashed files) for a year.

## Before launch

- [ ] Repo public → swap `install` in `site.yml` for the public `curl … | sh` one-liner
- [ ] `public/og-image.png` (1200×630), from the icon and lockup
- [ ] Replace the faithful HTML demo with a VHS/asciinema recording as well, if wanted
- [ ] Remove the `SITE_AUTH_*` secrets to make the site public
- [ ] Re-check the compare table against the current OpenSpec, Spec Kit and Kiro docs
