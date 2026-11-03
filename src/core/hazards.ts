/**
 * The project hazard register: what could go wrong, kept for the life of the
 * system rather than the life of a change.
 *
 * A change's risks used to live and die with it. Once archived, the next
 * change touching the same capability started from nothing and rediscovered
 * the same hazards, or missed them — the problem ADRs solved for decisions.
 * NASA keeps every hazard in a tracking system with its causes, controls,
 * verification and status; a mitigation counts only while its verification
 * holds (docs/proposals/add-hazard-register.md).
 *
 * So at archive each accepted risk joins the register, or updates the entry
 * it names with `**Known hazard:** HAZ-0003`. An entry's verification is its
 * guard tests' tags, and its status follows their results: "mitigated" is a
 * claim the evidence must keep making, and a failing guard sends the hazard
 * back to open, visibly. Modelled on the ADR store (core/decisions.ts):
 * numbered Markdown files, one per hazard, readable without the tool.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvidence, loadEvidence, tagFor, tagsIn, type EvidenceRecord, type TestResult } from './evidence.ts';
import { slugify } from './requirements.ts';
import type { Risk } from './risks.ts';
import { readPrevious, withMarker } from './provenance.ts';

/** What the entry claims. `mitigated` is checked against the evidence. */
export type StatedStatus = 'open' | 'mitigated' | 'unmitigated' | 'closed';
const STATED: readonly StatedStatus[] = ['open', 'mitigated', 'unmitigated', 'closed'];

export interface Hazard {
  number: number;
  /** `HAZ-0003`. */
  id: string;
  title: string;
  file: string;
  stated: StatedStatus;
  severity: string;
  /** ISO date of the last look at it. */
  reviewed: string | null;
  hazard: string;
  causes: string;
  affects: string;
  /** One line per control: the change and the guard it put in place. */
  controls: string[];
  /** The tags of the tests that verify the controls. */
  verification: string[];
  /** Why it is knowingly left unmitigated, when it is. */
  unmitigated: string;
  history: string[];
}

export function hazardsDir(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'hazards');
}

const FILE = /^(\d{4})-(.+)\.md$/;
export const hazardId = (n: number) => `HAZ-${String(n).padStart(4, '0')}`;

function field(content: string, name: string): string {
  return content.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'im'))?.[1]?.trim() ?? '';
}

/** The text under `## <name>`, up to the next section. */
function section(content: string, name: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (start === -1) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    out.push(line);
  }
  const text = out.join('\n').trim();
  // What renderHazard writes for an empty section is not content.
  return PLACEHOLDERS.includes(text) ? '' : text;
}

const PLACEHOLDERS = ['(none)', '(not stated)'];

const bullets = (text: string) =>
  text.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter((l) => l !== '');

export function parseHazard(content: string, file: string, number: number): Hazard {
  const stated = field(content, 'Status').toLowerCase();
  return {
    number,
    id: hazardId(number),
    title: content.match(/^#\s*(?:HAZ-\d+:\s*)?(.+)$/m)?.[1]?.trim() ?? '',
    file,
    stated: STATED.includes(stated as StatedStatus) ? (stated as StatedStatus) : 'open',
    severity: field(content, 'Severity'),
    reviewed: field(content, 'Reviewed') || null,
    hazard: section(content, 'Hazard'),
    causes: section(content, 'Causes'),
    affects: section(content, 'Affects'),
    controls: bullets(section(content, 'Controls')),
    verification: bullets(section(content, 'Verification')).map((l) => l.replace(/`/g, '')),
    unmitigated: section(content, 'Unmitigated'),
    history: bullets(section(content, 'History')),
  };
}

export function listHazards(projectRoot: string): Hazard[] {
  const dir = hazardsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: Hazard[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const m = entry.match(FILE);
    if (!m?.[1]) continue;
    try {
      out.push(parseHazard(readFileSync(join(dir, entry), 'utf8'), join(dir, entry), Number(m[1])));
    } catch {
      // Unreadable entry: the rest of the register still counts.
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

export function renderHazard(h: Omit<Hazard, 'file' | 'number' | 'id'>, id: string): string {
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '(none)');
  return [
    `# ${id}: ${h.title}`,
    '',
    `**Status:** ${h.stated}`,
    `**Severity:** ${h.severity || 'unrated'}`,
    `**Reviewed:** ${h.reviewed ?? 'never'}`,
    '',
    '## Hazard',
    '',
    h.hazard || '(not stated)',
    '',
    '## Causes',
    '',
    h.causes || '(not stated)',
    '',
    '## Affects',
    '',
    h.affects || '(not stated)',
    '',
    '## Controls',
    '',
    list(h.controls),
    '',
    '## Verification',
    '',
    h.verification.length > 0 ? h.verification.map((t) => `- \`${t}\``).join('\n') : '(none)',
    '',
    ...(h.unmitigated ? ['## Unmitigated', '', h.unmitigated, ''] : []),
    '## History',
    '',
    list(h.history),
    '',
  ].join('\n');
}

const today = () => new Date().toISOString().slice(0, 10);
const RANK: Record<string, number> = { catastrophic: 0, critical: 1, high: 2, medium: 3, marginal: 3, low: 4, negligible: 5 };
const worse = (a: string, b: string) => ((RANK[b.toLowerCase()] ?? 9) < (RANK[a.toLowerCase()] ?? 9) ? b : a);

export interface Promotion {
  hazard: string;
  risk: string;
  created: boolean;
}

/**
 * Brings a change's accepted risks into the register at archive.
 *
 * A risk naming a hazard (`**Known hazard:** HAZ-0003`) adds its control and
 * its guard test to that entry; any other becomes a new entry. The guard's
 * latest results in the change's evidence come along, so the new entry's
 * status does not start from nothing.
 */
export function promoteRisks(projectRoot: string, change: string, risks: Risk[]): Promotion[] {
  const dir = hazardsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const existing = listHazards(projectRoot);
  let next = existing.reduce((max, h) => Math.max(max, h.number), 0) + 1;
  const evidence = loadEvidence(projectRoot, change);
  const out: Promotion[] = [];

  for (const risk of risks) {
    const tag = tagFor(change, risk);
    const control = risk.unmitigated ? null : `change \`${change}\`: ${risk.guard || risk.name}`;
    const known = existing.find((h) => h.id.toLowerCase() === risk.knownHazard.trim().toLowerCase());
    const event = `${today()} ${change}: ${known ? 'updated' : 'created'} from risk "${risk.name}"`;

    let id: string;
    let file: string;
    let entry: Omit<Hazard, 'file' | 'number' | 'id'>;
    if (known) {
      ({ id, file } = known);
      entry = {
        ...known,
        severity: worse(known.severity, risk.severity),
        reviewed: today(),
        causes: [known.causes, risk.causes].filter(Boolean).join('\n\n'),
        controls: control ? [...known.controls, control] : known.controls,
        verification: risk.unmitigated || known.verification.includes(tag) ? known.verification : [...known.verification, tag],
        // A new control reopens the question of whether it holds; the
        // evidence answers it.
        stated: known.stated === 'closed' ? 'closed' : control ? 'mitigated' : known.stated,
        history: [...known.history, event],
      };
    } else {
      id = hazardId(next);
      file = join(dir, `${String(next).padStart(4, '0')}-${slugify(risk.name)}.md`);
      next++;
      entry = {
        title: risk.name,
        stated: risk.unmitigated ? 'unmitigated' : 'mitigated',
        severity: risk.severity,
        reviewed: today(),
        hazard: risk.hazard,
        causes: risk.causes,
        affects: risk.affects,
        controls: control ? [control] : [],
        verification: risk.unmitigated ? [] : [tag],
        unmitigated: risk.unmitigated ?? '',
        history: [event],
      };
    }
    writeFileSync(file, withMarker(renderHazard(entry, id), 'markdown', readPrevious(file)), 'utf8');

    // The guard's latest results, carried over under the hazard.
    const runs = evidence.filter((r): r is Extract<EvidenceRecord, { kind: 'run' }> => r.kind === 'run' && r.item === risk.id);
    const last = runs.at(-1)?.at;
    // And a waiver, when its evidence was waived rather than shown: the
    // register must not call a waived guard verified.
    const waiver = evidence.filter((r) => r.kind === 'waive' && r.item === risk.id && r.hash === risk.hash).at(-1);
    appendEvidence(
      projectRoot,
      HAZARD_EVIDENCE,
      [
        ...runs.filter((r) => r.at === last).map((r) => ({ ...r, item: tag })),
        ...(waiver ? [{ ...waiver, item: tag, hash: '' }] : []),
      ],
    );
    out.push({ hazard: id, risk: risk.name, created: !known });
  }
  return out;
}

/** Hazard evidence is kept like a change's, under this name, keyed by tag. */
export const HAZARD_EVIDENCE = '_hazards';

/**
 * The records a test run adds for the register: every test carrying a tag
 * some hazard is verified by. Changes come and go; the hazard's guards keep
 * running, and keep being recorded, after the change that wrote them.
 */
export function hazardRecordsForRun(hazards: Hazard[], results: TestResult[], at: string): EvidenceRecord[] {
  const tags = new Set(hazards.flatMap((h) => h.verification));
  const out: EvidenceRecord[] = [];
  for (const r of results) {
    for (const t of tagsIn(r.name)) {
      const tag = `[${t.kind}:${t.ref}]`;
      if (tags.has(tag)) out.push({ kind: 'run', at, item: tag, hash: '', test: r.name, file: r.file, fileHash: null, outcome: r.outcome });
    }
  }
  return out;
}

/**
 * Where a hazard stands. Closed and unmitigated are what the entry says.
 * Otherwise it is mitigated only while every guard's latest run passed;
 * a failing guard makes it open again, and one never run leaves it
 * unverified — a claim with nothing behind it.
 */
export type HazardStatus = 'mitigated' | 'open' | 'unverified' | 'unmitigated' | 'closed';

export interface HazardState {
  hazard: Hazard;
  status: HazardStatus;
  /** Why, in words: which guard fails or was never run. */
  because: string;
  /** Not looked at for longer than the review period. */
  dueForReview: boolean;
}

export const REVIEW_DAYS = 90;

export function hazardState(hazard: Hazard, records: EvidenceRecord[], now = new Date()): HazardState {
  const age = hazard.reviewed ? (now.getTime() - Date.parse(hazard.reviewed)) / 86_400_000 : Infinity;
  const dueForReview = hazard.stated !== 'closed' && !(age <= REVIEW_DAYS);
  const base = { hazard, dueForReview };
  if (hazard.stated === 'closed') return { ...base, status: 'closed', because: 'closed' };
  if (hazard.stated === 'unmitigated') return { ...base, status: 'unmitigated', because: hazard.unmitigated || 'left unmitigated' };
  if (hazard.verification.length === 0) return { ...base, status: 'open', because: 'no control is verified by a test' };

  const failing: string[] = [];
  const never: string[] = [];
  const waived: string[] = [];
  for (const tag of hazard.verification) {
    const runs = records.filter((r) => r.kind === 'run' && r.item === tag && r.outcome !== 'skip');
    const last = runs.at(-1)?.at;
    const latest = runs.filter((r) => r.at === last);
    // A waiver stands until a run after it: a later pass is evidence again.
    const waiver = records.filter((r) => r.kind === 'waive' && r.item === tag).at(-1);
    if (latest.length === 0 && !waiver) never.push(tag);
    else if (latest.some((r) => r.kind === 'run' && r.outcome === 'fail')) failing.push(tag);
    else if (waiver?.kind === 'waive' && (!last || waiver.at >= last)) waived.push(`${tag} (${waiver.reason})`);
  }
  if (failing.length > 0) return { ...base, status: 'open', because: `guard failing: ${failing.join(', ')}` };
  if (never.length > 0) return { ...base, status: 'unverified', because: `guard never run: ${never.join(', ')}` };
  if (waived.length > 0) return { ...base, status: 'unverified', because: `guard waived, not shown: ${waived.join('; ')}` };
  return { ...base, status: 'mitigated', because: 'every guard passed its latest run' };
}

export function registerStates(projectRoot: string, now = new Date()): HazardState[] {
  const records = loadEvidence(projectRoot, HAZARD_EVIDENCE);
  return listHazards(projectRoot).map((h) => hazardState(h, records, now));
}

/** Records that a person looked at a hazard again. */
export function markReviewed(projectRoot: string, id: string, note?: string): Hazard | null {
  const hazard = listHazards(projectRoot).find((h) => h.id.toLowerCase() === id.toLowerCase());
  if (!hazard) return null;
  const updated = {
    ...hazard,
    reviewed: today(),
    history: [...hazard.history, `${today()} reviewed${note ? `: ${note}` : ''}`],
  };
  writeFileSync(hazard.file, withMarker(renderHazard(updated, hazard.id), 'markdown', readPrevious(hazard.file)), 'utf8');
  return updated;
}

/** The register as agents read it before writing a change's risks. */
export function renderRegister(states: HazardState[]): string {
  const live = states.filter((s) => s.status !== 'closed');
  if (live.length === 0) return '';
  const out = [
    '# Known hazards',
    '',
    'What has gone, or could go, wrong in this project before. When writing',
    "risks, say for each hazard this change touches whether it affects it, and",
    'name it in the risk with `**Known hazard:** HAZ-NNNN`. A change that',
    'weakens one of their controls says so as a risk.',
    '',
  ];
  for (const s of live) {
    out.push(`- ${s.hazard.id} ${s.hazard.title} — ${s.status}${s.hazard.affects ? `; affects ${s.hazard.affects.replace(/\s+/g, ' ')}` : ''}`);
  }
  return out.join('\n');
}
