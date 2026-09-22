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

/** One ground-rule question, and what a useful answer to it looks like. */
export interface FoundationQuestion {
  /** Becomes the section heading, so it is also the question's identity. */
  ask: string;
  /**
   * Shown while answering, never written to disk. Phrased as examples of
   * *kinds* of answer so that nobody mistakes one for a recommended default.
   */
  hint: string;
}

export interface FoundationDoc {
  name: string;
  title: string;
  /** What this document settles, in one line, for the guided setup. */
  purpose: string;
  questions: FoundationQuestion[];
}

/**
 * The documents `spectacular init` scaffolds, and what each must answer.
 *
 * Ordered as the guided setup asks them: what it is built with, what it is
 * about, how it is shaped, and how the team works on it.
 */
export const FOUNDATION_DOCS: FoundationDoc[] = [
  {
    name: 'stack.md',
    title: 'Stack',
    purpose: 'What the project is built with.',
    questions: [
      {
        ask: 'Language and runtime, with versions.',
        hint: 'e.g. "TypeScript 5.6 on Bun 1.4" or "Python 3.12, CPython"',
      },
      {
        ask: 'Framework, if any, and why it over the alternatives.',
        hint: 'e.g. "Hono — small, runs on Bun; Express ruled out for its middleware model", or "none"',
      },
      {
        ask: 'Datastore and how schema changes are managed.',
        hint: 'e.g. "Postgres 16, migrations via drizzle-kit, never edited by hand", or "no persistence"',
      },
      {
        ask: 'Package manager, test runner, linter, formatter.',
        hint: 'e.g. "bun, bun test, eslint, prettier"',
      },
      {
        ask: 'Anything explicitly ruled out, and why.',
        hint: 'e.g. "no ORM — queries stay visible", "no client-side state library"',
      },
    ],
  },
  {
    name: 'domain.md',
    title: 'Domain',
    purpose: 'What the project is about, in its own words.',
    questions: [
      {
        ask: 'What the system is for, and who uses it.',
        hint: 'Two sentences. e.g. "Lets clinic staff book rooms. Used by receptionists, not patients."',
      },
      {
        ask: 'The core terms, each with a one-line meaning.',
        hint: 'The shared vocabulary. e.g. "Booking: a room held for a time slot. Slot: 15 minutes, never split."',
      },
      {
        ask: 'Rules about the domain that must always hold.',
        hint: 'Invariants. e.g. "A room is never double-booked. A cancelled booking is kept, not deleted."',
      },
      {
        ask: 'What is explicitly out of scope.',
        hint: 'e.g. "Billing. Patient records. Anything a patient does themselves."',
      },
    ],
  },
  {
    name: 'architecture.md',
    title: 'Architecture',
    purpose: 'How the code is shaped, and which way dependencies point.',
    questions: [
      {
        ask: 'Architecture style (layered, hexagonal, vertical slice, ...) and why.',
        hint: 'e.g. "Clean architecture: domain in the centre, use cases around it, adapters at the edge"',
      },
      {
        ask: 'The layers or modules, and which may depend on which.',
        hint: 'e.g. "domain ← application ← adapters ← main. Inner layers never import outer ones."',
      },
      {
        ask: 'Where business rules live, and what must never leak into them.',
        hint: 'e.g. "In domain/. No HTTP, SQL, framework types or clocks — those are passed in."',
      },
      {
        ask: 'How errors are represented and propagated.',
        hint: 'e.g. "Result types in the domain; exceptions only for bugs; mapped to HTTP at the edge"',
      },
      {
        ask: 'How the system is configured and how secrets are handled.',
        hint: 'e.g. "Env vars validated once at startup; secrets never logged or committed"',
      },
    ],
  },
  {
    name: 'conventions.md',
    title: 'Conventions',
    purpose: 'How the team works on it day to day.',
    questions: [
      {
        ask: 'Naming: files, types, functions, tests.',
        hint: 'e.g. "kebab-case files, PascalCase types, verbs for functions, tests named after behaviour"',
      },
      {
        ask: 'What a test must cover before a change is considered done.',
        hint: 'e.g. "Every requirement\'s scenarios as tests; no mocks of our own code"',
      },
      {
        ask: 'How code is reviewed and what blocks a merge.',
        hint: 'e.g. "One approval; failing typecheck or tests block; style never blocks"',
      },
      {
        ask: 'Comment style: what is worth writing down and what is noise.',
        hint: 'e.g. "Explain why, never what; link the requirement a non-obvious rule comes from"',
      },
      {
        ask: 'Anything a new contributor reliably gets wrong.',
        hint: 'e.g. "Timezones: store UTC, convert only for display"',
      },
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
      ...doc.questions.flatMap((q) => [`## ${q.ask}`, '', 'TBD', '']),
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

/** A Foundation section as the guided setup asks it. */
export interface GuidedQuestion {
  item: ReviewItem;
  /** The document it belongs to, e.g. `Architecture`. */
  title: string;
  purpose: string;
  /** Empty for a section a human added that the scaffold never asked. */
  hint: string;
  answered: boolean;
}

/**
 * Every Foundation section in the order the guided setup asks them.
 *
 * The files are the source of truth, not `FOUNDATION_DOCS`: a question a human
 * deleted is not asked again, and one they added is asked too — after the
 * scaffold's own, since nothing says where it belongs.
 */
export function guidedQuestions(projectRoot: string): GuidedQuestion[] {
  const items = loadFoundation(projectRoot);
  const byDoc = (name: string) =>
    items.filter((item) => item.capability === `foundation/${name.replace(/\.md$/, '')}`);

  const known = new Set(FOUNDATION_DOCS.map((d) => d.name));
  const extra = [...new Set(items.map((i) => i.file.replace(/.*[\\/]/, '')))]
    .filter((name) => !known.has(name))
    .sort();

  const docs: FoundationDoc[] = [
    ...FOUNDATION_DOCS,
    ...extra.map((name) => ({
      name,
      title: name.replace(/\.md$/, ''),
      purpose: '',
      questions: [],
    })),
  ];

  return docs.flatMap((doc) =>
    byDoc(doc.name).map((item) => ({
      item,
      title: doc.title,
      purpose: doc.purpose,
      hint: doc.questions.find((q) => q.ask === item.name)?.hint ?? '',
      answered: !isUnanswered(item),
    })),
  );
}

/**
 * Writes an answer into its section, replacing whatever the section held.
 *
 * Located by heading rather than trusted by line number alone: the file may
 * have been edited since it was parsed, and writing an answer under the wrong
 * question is worse than refusing.
 */
export function answerFoundation(
  item: ReviewItem,
  answer: string,
): { ok: true } | { ok: false; reason: string } {
  const text = answer.trim();
  if (text === '') return { ok: false, reason: 'An empty answer would leave the question open' };

  let content: string;
  try {
    content = normalizeContent(readFileSync(item.file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `Could not read ${item.file}: ${(err as Error).message}` };
  }

  const lines = content.split('\n');
  const mask = buildCodeFenceMask(lines);
  const isHeading = (i: number) =>
    !mask[i] && SECTION_HEADER.test(lines[i] ?? '') &&
    (lines[i] ?? '').replace(/^##\s+/, '').trim() === item.name;

  const hinted = item.line - 1;
  const start = isHeading(hinted) ? hinted : lines.findIndex((_, i) => isHeading(i));
  if (start < 0) return { ok: false, reason: `"${item.name}" is no longer in ${item.file}` };

  let end = start + 1;
  while (end < lines.length && (mask[end] || !SECTION_HEADER.test(lines[end] ?? ''))) end++;

  const next = [...lines.slice(0, start + 1), '', text, '', ...lines.slice(end)];
  writeFileSync(item.file, next.join('\n'), 'utf8');
  return { ok: true };
}
