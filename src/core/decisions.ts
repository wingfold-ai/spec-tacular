/**
 * Design decisions, and promoting them to project-wide ADRs.
 *
 * A `design.md` holds Decisions with rationale. When one is genuinely
 * architectural — auth strategy, error model, persistence choice — it belongs
 * to the project, but OpenSpec has no project-level decision record, so the
 * next change's design re-decides it, differently
 * (docs/problem-analysis.md §6).
 *
 * Decisions are parsed as `ReviewItem`s, so the review loop, the sidecar and
 * drift detection work on them unchanged.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodeFenceMask, normalizeContent, SECTION_HEADER } from './markdown.ts';
import { hashBlock, slugify, type ReviewItem } from './requirements.ts';

/** Where a decision applies. Global ones are candidates for promotion. */
export type DecisionScope = 'local' | 'global';

export interface Decision extends ReviewItem {
  scope: DecisionScope;
  /** The decision's body, header excluded. */
  body: string;
}

const DECISIONS_SECTION = /^##\s+Decisions\s*$/i;
const DECISION_HEADER = /^###\s+(.+?)\s*$/;
const SCOPE_MARKER = /\*\*Scope:\s*(local|global)\s*\*\*/i;

/**
 * Parses the Decisions section of a design document.
 *
 * Scope defaults to `local` when unmarked: promoting something project-wide
 * without anyone saying so would be the more damaging guess.
 */
export function parseDecisions(content: string, file: string): Decision[] {
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i] && DECISIONS_SECTION.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (!mask[i] && SECTION_HEADER.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }

  const decisions: Decision[] = [];
  const seen = new Map<string, number>();

  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    if (mask[i]) continue;
    const header = line.match(DECISION_HEADER);
    if (!header?.[1]) continue;

    const name = header[1].trim();
    const bodyLines: string[] = [];
    let j = i + 1;
    for (; j < end; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && DECISION_HEADER.test(next)) break;
      bodyLines.push(next);
    }

    const body = bodyLines.join('\n').trim();
    const scopeMatch = body.match(SCOPE_MARKER);
    const base = slugify(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    decisions.push({
      id: `design#${count === 1 ? base : `${base}~${count}`}`,
      capability: 'design',
      name,
      text: body,
      body,
      scope: (scopeMatch?.[1]?.toLowerCase() as DecisionScope | undefined) ?? 'local',
      file,
      line: i + 1,
      hash: hashBlock([line, ...bodyLines].join('\n')),
    });

    i = j - 1;
  }

  return decisions;
}

/** Reads a change's design decisions, if it has a design yet. */
export function loadDecisions(designPath: string): Decision[] {
  if (!existsSync(designPath)) return [];
  try {
    return parseDecisions(readFileSync(designPath, 'utf8'), designPath);
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------------
// The ADR store
// -----------------------------------------------------------------------------

export interface Adr {
  number: number;
  slug: string;
  title: string;
  file: string;
  content: string;
  status: 'accepted' | 'superseded';
  /** The ADR number that replaced this one, when superseded. */
  supersededBy?: number;
}

export function decisionsDir(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'decisions');
}

const ADR_FILE = /^(\d{4})-(.+)\.md$/;
const STATUS_LINE = /^\*\*Status:\*\*\s*(accepted|superseded(?:\s+by\s+ADR-(\d+))?)\s*$/im;

export function listAdrs(projectRoot: string): Adr[] {
  const dir = decisionsDir(projectRoot);
  if (!existsSync(dir)) return [];

  const adrs: Adr[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const match = entry.match(ADR_FILE);
    if (!match?.[1] || !match[2]) continue;
    const file = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const status = content.match(STATUS_LINE);
    const title = content.match(/^#\s*(?:ADR-\d+:\s*)?(.+)$/m)?.[1]?.trim() ?? match[2];
    adrs.push({
      number: Number(match[1]),
      slug: match[2],
      title,
      file,
      content,
      status: status?.[1]?.toLowerCase().startsWith('superseded') ? 'superseded' : 'accepted',
      ...(status?.[2] ? { supersededBy: Number(status[2]) } : {}),
    });
  }
  return adrs.sort((a, b) => a.number - b.number);
}

/** Only accepted ADRs are binding; superseded ones are history. */
export function acceptedAdrs(projectRoot: string): Adr[] {
  return listAdrs(projectRoot).filter((a) => a.status === 'accepted');
}

/**
 * One past the highest number in the store.
 *
 * Max rather than count, so a gap in the middle — an ADR deleted by hand —
 * never causes a number to be reused while newer ones still reference it.
 *
 * Deleting the *newest* ADR does free its number, and that is not defended
 * against: an ADR is meant to be superseded, not removed. `markSuperseded`
 * keeps the record and the number intact, which is why it exists.
 */
function nextNumber(projectRoot: string): number {
  return listAdrs(projectRoot).reduce((max, a) => Math.max(max, a.number), 0) + 1;
}

export interface PromoteResult {
  adr: Adr;
  /** The reference left behind in design.md. */
  reference: string;
}

/**
 * Lifts a design decision to a project-wide ADR.
 *
 * The decision's body is copied into the ADR and a reference is left in
 * `design.md`, so the change still records what it decided while the project
 * gains the durable rule.
 */
export function promoteDecision(
  projectRoot: string,
  decision: Decision,
  options: { change?: string; supersedes?: number } = {},
): PromoteResult {
  const dir = decisionsDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const number = nextNumber(projectRoot);
  const slug = slugify(decision.name);
  const padded = String(number).padStart(4, '0');
  const file = join(dir, `${padded}-${slug}.md`);

  const lines = [
    `# ADR-${padded}: ${decision.name}`,
    '',
    '**Status:** accepted',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    ...(options.change ? [`**Origin:** change \`${options.change}\``] : []),
    ...(options.supersedes ? [`**Supersedes:** ADR-${String(options.supersedes).padStart(4, '0')}`] : []),
    '',
    // The body carries the scope marker, which is meaningless once promoted —
    // an ADR is global by definition.
    decision.body.replace(SCOPE_MARKER, '').trimStart(),
    '',
  ];
  writeFileSync(file, lines.join('\n'), 'utf8');

  if (options.supersedes) markSuperseded(projectRoot, options.supersedes, number);

  const adr: Adr = {
    number,
    slug,
    title: decision.name,
    file,
    content: lines.join('\n'),
    status: 'accepted',
  };
  return { adr, reference: `See ADR-${padded} (\`spec-tacular/decisions/${padded}-${slug}.md\`).` };
}

/** Marks an ADR superseded, in place. */
export function markSuperseded(projectRoot: string, number: number, by: number): boolean {
  const adr = listAdrs(projectRoot).find((a) => a.number === number);
  if (!adr) return false;
  const padded = String(by).padStart(4, '0');
  const updated = STATUS_LINE.test(adr.content)
    ? adr.content.replace(STATUS_LINE, `**Status:** superseded by ADR-${padded}`)
    : `${adr.content}\n\n**Status:** superseded by ADR-${padded}\n`;
  writeFileSync(adr.file, updated, 'utf8');
  return true;
}

/**
 * Replaces a promoted decision's body with a reference to its ADR.
 *
 * The change keeps a record of what it decided; the rule itself now lives in
 * one place. Leaving the full text behind would let the two drift, which is
 * the duplication the ADR store exists to end.
 */
export function replaceDecisionBody(
  decision: Decision,
  reference: string,
): { ok: true } | { ok: false; reason: string } {
  let original: string;
  try {
    original = readFileSync(decision.file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read design.md: ${(err as Error).message}` };
  }

  const lines = normalizeContent(original).split('\n');
  const headerIndex = decision.line - 1;
  const header = lines[headerIndex];
  // Editing by a stale offset would corrupt the design document.
  if (header === undefined || !DECISION_HEADER.test(header)) {
    return { ok: false, reason: 'design.md changed since it was read — reopen the change' };
  }

  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (DECISION_HEADER.test(line) || SECTION_HEADER.test(line)) {
      end = i;
      break;
    }
  }

  const replacement = [header, '', reference, ''];
  const updated = [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(end)].join('\n');
  try {
    writeFileSync(decision.file, updated, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not write design.md: ${(err as Error).message}` };
  }
  return { ok: true };
}
