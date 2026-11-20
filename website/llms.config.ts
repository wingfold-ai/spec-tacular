// The curated /llms.txt (https://llmstxt.org), built at build time from the
// docs' own files, so it can never drift from them:
//   - key facts first, for a model answering questions about spec-tacular;
//   - then the docs, grouped and ordered like the sidebar (numeric prefixes,
//     .navigation.yml titles), each page with its full frontmatter description;
//   - "Advanced" under ## Optional: skippable for most questions.
// Links point at the Markdown version of each page (/docs/….md).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = 'https://spec-tacular.app'
const DOCS = 'content/docs'

interface Link { title: string, description?: string, href: string }
interface Section { title: string, description?: string | string[], links?: Link[], optional?: boolean }

/** title/description from a page's frontmatter (plain, '…' or "…" values). */
function frontmatter(file: string): Record<string, string> {
  const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2]!.trim()
    if (v.startsWith('\'') && v.endsWith('\'')) v = v.slice(1, -1).replace(/''/g, '\'')
    else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"')
    out[kv[1]!] = v
  }
  return out
}

const strip = (name: string) => name.replace(/^\d+\./, '').replace(/\.md$/, '')
const sorted = (names: string[]) => [...names].sort((a, b) => Number.parseInt(a) - Number.parseInt(b))

function docsSection(folder: string): Section {
  const dir = join(DOCS, folder)
  const nav = join(dir, '.navigation.yml')
  const title = existsSync(nav) ? (readFileSync(nav, 'utf8').match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? strip(folder)) : strip(folder)
  const links = sorted(readdirSync(dir).filter(f => f.endsWith('.md'))).map((f) => {
    const fm = frontmatter(join(dir, f))
    return { title: fm.title ?? strip(f), description: fm.description, href: `${SITE}/docs/${strip(folder)}/${strip(f)}.md` }
  })
  return { title, links }
}

export function llmsTxt() {
  const version = `v${JSON.parse(readFileSync('../package.json', 'utf8')).version}`
  const folders = sorted(readdirSync(DOCS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name))
  const docs = folders.map(docsSection)
  const intro = frontmatter(join(DOCS, 'index.md'))

  const sections: Section[] = [
    {
      title: 'Key facts',
      description: [
        'spec-tacular is a terminal UI (TUI) for spec-driven development on top of OpenSpec (https://github.com/Fission-AI/OpenSpec). It does not replace OpenSpec: it drives the OpenSpec CLI and works in the project\'s openspec/ folder, so specs and change history stay plain OpenSpec.',
        'Core idea: an artifact counts as complete only when a person accepted it. Every change moves through proposal → specs → risks → design → tasks → implement → archive, and each artifact is drafted only from the accepted one before it. Specs are reviewed one requirement at a time: accept (a), reject (x), defer (d) or revise that one requirement with AI (r). Decisions are kept in git, in openspec/changes/<change>/review.md.',
        'Agents: Claude Code (the default) or opencode (start with --driver opencode). spec-tacular calls no model itself; drafting runs through the agent in the background, and implementing opens the agent in a terminal tab of its own with the accepted tasks.',
        `Platforms and status: Linux and macOS, x64 and arm64, a single binary; needs the OpenSpec CLI 1.11 or newer, OpenSpec 2 included (npm i -g @fission-ai/openspec). Early access, ${version}, MIT licence. The repository is private for now, so installing needs the GitHub CLI with access; once it is public: curl -fsSL ${SITE}/install.sh | sh. Also on npm: npm i -g @spec-tacular/cli (a launcher plus one package per platform with the binary).`,
      ],
    },
    {
      title: 'Start here',
      links: [
        { title: 'Landing page', description: 'What spec-tacular is, the problem it solves, the pipeline and an honest comparison with OpenSpec alone, Spec Kit and Kiro.', href: `${SITE}/index.md` },
        { title: intro.title ?? 'Introduction', description: intro.description, href: `${SITE}/docs.md` },
      ],
    },
    ...docs.map(s => ({ ...s, optional: s.title.toLowerCase() === 'advanced' })),
  ]
  return { pages: false as const, sections }
}
