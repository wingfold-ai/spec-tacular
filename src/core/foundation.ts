/**
 * The Foundation: ground rules decided before the first change.
 *
 * OpenSpec's `init` scaffolds directories and agent instructions. It does not
 * ask what the project *is* — language, framework, architecture style, testing
 * strategy, layering — so the first change's design invents them implicitly
 * and every later change inherits an accident (docs/problem-analysis.md §9).
 *
 * Foundation documents are reviewed through the same accept loop as anything
 * else, and enter every agent's context bundle once accepted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeContent, SECTION_HEADER } from './markdown.ts';
import { buildCodeFenceMask } from './markdown.ts';
import { hashBlock, slugify, type ReviewItem } from './requirements.ts';

export function foundationDir(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'foundation');
}

/** The documents `spectacular init` scaffolds, and what each must answer. */
export const FOUNDATION_DOCS: { name: string; title: string; prompts: string[] }[] = [
  {
    name: 'stack.md',
    title: 'Stack',
    prompts: [
      'Language and runtime, with versions.',
      'Framework, if any, and why it over the alternatives.',
      'Datastore and how schema changes are managed.',
      'Package manager, test runner, linter, formatter.',
      'Anything explicitly ruled out, and why.',
    ],
  },
  {
    name: 'architecture.md',
    title: 'Architecture',
    prompts: [
      'Architecture style (layered, hexagonal, vertical slice, ...) and why.',
      'The layers or modules, and which may depend on which.',
      'Where business rules live, and what must never leak into them.',
      'How errors are represented and propagated.',
      'How the system is configured and how secrets are handled.',
    ],
  },
  {
    name: 'conventions.md',
    title: 'Conventions',
    prompts: [
      'Naming: files, types, functions, tests.',
      'What a test must cover before a change is considered done.',
      'How code is reviewed and what blocks a merge.',
      'Comment style: what is worth writing down and what is noise.',
      'Anything a new contributor reliably gets wrong.',
    ],
  },
];

/**
 * Writes the Foundation scaffold.
 *
 * Every question is left visibly unanswered rather than pre-filled with a
 * plausible default. A default nobody chose is indistinguishable from a
 * decision, which is precisely the failure this phase exists to prevent.
 */
export function scaffoldFoundation(projectRoot: string): { created: string[]; skipped: string[] } {
  const dir = foundationDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  for (const doc of FOUNDATION_DOCS) {
    const file = join(dir, doc.name);
    if (existsSync(file)) {
      // Never overwrite: these hold decisions a human made.
      skipped.push(doc.name);
      continue;
    }
    const body = [
      `# ${doc.title}`,
      '',
      ...doc.prompts.flatMap((prompt) => [`## ${prompt}`, '', 'TBD', '']),
    ];
    writeFileSync(file, body.join('\n'), 'utf8');
    created.push(doc.name);
  }
  return { created, skipped };
}

/** A Foundation section, reviewable one at a time like any other item. */
export function parseFoundationDoc(content: string, file: string, name: string): ReviewItem[] {
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);
  const group = `foundation/${name.replace(/\.md$/, '')}`;

  const items: ReviewItem[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (mask[i] || !SECTION_HEADER.test(line)) continue;

    const title = line.replace(/^##\s+/, '').trim();
    const bodyLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && SECTION_HEADER.test(next)) break;
      bodyLines.push(next);
    }

    const base = slugify(title);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    items.push({
      id: `${group}#${count === 1 ? base : `${base}~${count}`}`,
      capability: group,
      name: title,
      text: bodyLines.join('\n').trim(),
      file,
      line: i + 1,
      hash: hashBlock([line, ...bodyLines].join('\n')),
    });

    i = j - 1;
  }

  return items;
}

/** Every Foundation section across every document, in a stable order. */
export function loadFoundation(projectRoot: string): ReviewItem[] {
  const dir = foundationDir(projectRoot);
  if (!existsSync(dir)) return [];

  const items: ReviewItem[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = join(dir, entry);
    try {
      items.push(...parseFoundationDoc(readFileSync(file, 'utf8'), file, entry));
    } catch {
      // An unreadable document is better skipped than fatal — the rest of the
      // Foundation is still worth reviewing.
    }
  }
  return items;
}

/** A section still holding the scaffold's placeholder. */
export function isUnanswered(item: ReviewItem): boolean {
  return item.text.trim() === '' || item.text.trim().toUpperCase() === 'TBD';
}

export function foundationExists(projectRoot: string): boolean {
  return existsSync(foundationDir(projectRoot));
}
