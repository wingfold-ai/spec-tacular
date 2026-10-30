/**
 * The risks of a change: what it could break, and how a test shows it did not.
 *
 * A change is reviewed for what it should do, never for what it could break.
 * A design's "Risks / Trade-offs" section is prose nobody accepts and nothing
 * tests, so a risk written there gives the same false comfort as a ticked task
 * nobody ran. Here a risk is a reviewable item like a requirement — accepted
 * one at a time, reset by an edit — and it is followed through: the design must
 * answer it, and the tasks must guard it with a test shown to fail without the
 * mitigation (docs/proposals/add-change-risks.md).
 */

import { hasMarker, SHOWN_RED } from './markers.ts';
import { existsSync, readFileSync } from 'node:fs';
import { buildCodeFenceMask, normalizeContent } from './markdown.ts';
import { hashBlock, slugify, type ReviewItem } from './requirements.ts';

export interface Risk extends ReviewItem {
  /** What must not happen, as an observable outcome. */
  hazard: string;
  /** The requirements and capabilities it threatens. */
  affects: string;
  /** The situation in which it arises. */
  boundary: string;
  /** What could bring it about: the failure modes behind the hazard. Optional. */
  causes: string;
  severity: string;
  /** The property that rules it out. */
  guard: string;
  /** How a test shows the guard holds. */
  check: string;
  /**
   * Why the risk is knowingly left unmitigated, when it is. Such a risk needs
   * no answer in the design and no guard test: the reason is the answer.
   *
   * Not called "accepted": in the review, accepting a risk means agreeing it
   * is stated right, and the two must not read alike.
   */
  unmitigated?: string;
  /**
   * The register entry this risk is an instance of, `HAZ-0003`, or empty.
   * At archive it updates that entry instead of starting a new one
   * (core/hazards.ts).
   */
  knownHazard: string;
}

/** `### Risk: <name>`, the same shape as a requirement header. */
export const RISK_HEADER = /^###\s*Risk:\s*(.+?)\s*$/i;

/** `- **Hazard:** text` — a field of a risk. */
const FIELD = /^\s*[-*]\s+\*\*([A-Za-z][A-Za-z ]*?):\*\*\s*(.*)$/;

const FIELDS = ['hazard', 'affects', 'boundary', 'causes', 'severity', 'guard', 'check', 'unmitigated', 'known hazard'] as const;
type Field = (typeof FIELDS)[number];

/** Narrows a review item to a risk. */
export function isRisk(item: ReviewItem): item is Risk {
  return item.capability === 'risks';
}

function readFields(lines: string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  let current: Field | null = null;
  for (const line of lines) {
    const field = line.match(FIELD);
    if (field?.[1]) {
      const key = field[1].trim().toLowerCase() as Field;
      current = (FIELDS as readonly string[]).includes(key) ? key : null;
      if (current) out[current] = (field[2] ?? '').trim();
      continue;
    }
    // An indented line continues the field above it; anything else ends it.
    if (current && /^\s+\S/.test(line)) out[current] = `${out[current]} ${line.trim()}`.trim();
    else if (line.trim() !== '') current = null;
  }
  return out;
}

/** Parses every `### Risk:` block of a risks document. */
export function parseRisks(content: string, file: string): Risk[] {
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);
  const risks: Risk[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const header = (lines[i] ?? '').match(RISK_HEADER);
    if (!header?.[1]) continue;

    const bodyLines: string[] = [];
    let j = i + 1;
    // A risk ends at the next risk or at any heading of its level or above.
    for (; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && /^#{1,3}\s/.test(next)) break;
      bodyLines.push(next);
    }

    const name = header[1].trim();
    const base = slugify(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const fields = readFields(bodyLines);
    const body = bodyLines.join('\n').trim();

    risks.push({
      id: `risks#${count === 1 ? base : `${base}~${count}`}`,
      capability: 'risks',
      name,
      text: body,
      file,
      line: i + 1,
      hash: hashBlock([lines[i] ?? '', ...bodyLines].join('\n')),
      hazard: fields.hazard ?? '',
      affects: fields.affects ?? '',
      boundary: fields.boundary ?? '',
      causes: fields.causes ?? '',
      severity: fields.severity ?? '',
      guard: fields.guard ?? '',
      check: fields.check ?? '',
      ...(fields.unmitigated ? { unmitigated: fields.unmitigated } : {}),
      knownHazard: fields['known hazard'] ?? '',
    });
    i = j - 1;
  }
  return risks;
}

/** Reads a change's risks, if it has written them yet. */
export function loadRisks(path: string): Risk[] {
  if (!existsSync(path)) return [];
  try {
    return parseRisks(readFileSync(path, 'utf8'), path);
  } catch {
    return [];
  }
}

/** Fields a risk cannot be reviewed without. */
export function missingFields(risk: Risk): string[] {
  const required: ('hazard' | 'guard' | 'check')[] = risk.unmitigated ? ['hazard'] : ['hazard', 'guard', 'check'];
  return required.filter((f) => (risk[f] ?? '').trim() === '');
}

/** Case and spacing do not matter when looking for a name in prose. */
function mentions(text: string, name: string): boolean {
  const squash = (s: string) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ');
  return squash(text).includes(squash(name));
}

/**
 * Risks the design does not answer by name.
 *
 * A name is the cheapest link a human can check, and the one an agent can
 * least plausibly forget when it is told to use it. A risk left unmitigated
 * on purpose carries its reason already, so it needs no answer.
 */
export function unansweredRisks(risks: Risk[], design: string): Risk[] {
  return risks.filter((r) => !r.unmitigated && !mentions(design, r.name));
}

// -----------------------------------------------------------------------------
// Guard tasks
// -----------------------------------------------------------------------------

/** `(guard: <risk name>)` on a task: the test that verifies that risk's guard. */
export const GUARD_MARKER = /\(guard:\s*([^)]+?)\s*\)/i;

/**
 * `(shown red: <how>)`: the guard test was run with the mitigation removed,
 * and failed. A test that passes either way does not guard anything. Read
 * with its parentheses balanced, and qualified or not (core/markers.ts).
 */

export interface GuardTask {
  risk: string;
  done: boolean;
  shownRed: boolean;
  /** The task's text, for saying which one. */
  text: string;
}

const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

/** Every guard task of a task list, with its following indented lines. */
export function guardTasks(content: string): GuardTask[] {
  const lines = normalizeContent(content).split('\n');
  const out: GuardTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const task = TASK.exec(lines[i] ?? '');
    if (!task) continue;
    // A long task wraps; the proof may sit on a continuation line.
    let text = task[2] ?? '';
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j] ?? '') && !TASK.test(lines[j] ?? ''); j++) {
      text += ` ${(lines[j] ?? '').trim()}`;
    }
    const guard = text.match(GUARD_MARKER);
    if (!guard?.[1]) continue;
    out.push({ risk: guard[1], done: task[1] !== ' ', shownRed: hasMarker(text, SHOWN_RED), text });
  }
  return out;
}

/** Risks that need a guard and have no guard task naming them. */
export function unguardedRisks(risks: Risk[], tasks: string): Risk[] {
  const guards = guardTasks(tasks);
  return risks.filter((r) => !r.unmitigated && !guards.some((g) => mentions(g.risk, r.name)));
}

/** Guard tasks ticked off without a record of the test failing. */
export function unprovenGuards(tasks: string): GuardTask[] {
  return guardTasks(tasks).filter((g) => g.done && !g.shownRed);
}
