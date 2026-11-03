/**
 * Verification evidence: which test shows a requirement holds, whether it
 * passed, and whether it passed against the text that was accepted.
 *
 * A ticked task says someone believes the work is done. That is a claim, not
 * evidence. spec-tacular already refuses to trust a stale acceptance; this
 * refuses a missing, failing or stale test result the same way
 * (docs/proposals/add-verification-evidence.md).
 *
 * Tests name what they verify in their own name — `[req:<capability>#<slug>]`
 * or `[risk:<change>#<slug>]` — in any language or framework, so the link
 * lives with the test and needs no registry. spec-tacular runs the project's
 * test command, reads its JUnit report, and appends what it found, per item,
 * with the hash of the item's text and of the test's file at that moment. A
 * record is never rewritten: a new run adds new evidence, and the history of
 * an item's results stays.
 *
 * Not everything is verified by a test. Following NASA's four verification
 * methods, an item may say `**Verified by:** analysis | inspection |
 * demonstration`, and is then verified by a person's recorded sign-off. An
 * item can also be waived, with a reason: the verification matrix shows it
 * as such, never as verified.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { isRequirement, type ReviewItem } from './requirements.ts';
import type { ReviewedItem } from './review.ts';
import { isRisk } from './risks.ts';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface VerificationConfig {
  /** The command that runs the tests and writes a JUnit report. */
  command: string;
  /** Where that report is written, relative to the project. */
  report: string;
}

/**
 * What `init` writes when there is no verification.yaml: every line a
 * comment, so evidence stays off until someone — the developer, or the
 * agent doing the change's first task — picks the project's test runner.
 */
export const VERIFICATION_STARTER = `# How spec-tacular runs this project's tests to collect evidence: every test
# whose name carries [req:<capability>#<slug>] or [risk:<change>#<slug>]
# counts for what it names. Uncomment the lines for your test runner. While
# nothing is uncommented, evidence is neither collected nor required; once it
# is, archiving a change needs every accepted requirement and risk verified.

# Bun
# command: bun test --reporter=junit --reporter-outfile=.spec-tacular/junit.xml
# report: .spec-tacular/junit.xml

# Vitest
# command: npx vitest run --reporter=junit --outputFile=.spec-tacular/junit.xml
# report: .spec-tacular/junit.xml

# Jest (with jest-junit)
# command: JEST_JUNIT_OUTPUT_FILE=.spec-tacular/junit.xml npx jest --reporters=default --reporters=jest-junit
# report: .spec-tacular/junit.xml

# pytest
# command: pytest --junitxml=.spec-tacular/junit.xml
# report: .spec-tacular/junit.xml

# For formal requirements, the matrix tests and the harness check (defaults
# shown, for Bun):
# matrix:
#   run: bun test {tests}
#   coverage: bun test --coverage --coverage-reporter=lcov --coverage-dir=.spec-tacular/coverage {tests}
#   lcov: .spec-tacular/coverage/lcov.info
#   mutation_threshold: 1
#   mutants: 32                 # changes per harness check, shared over the files run
#   exclude: [src/generated]    # never mutated, besides test files and test doubles
`;

export function verificationPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'verification.yaml');
}

/**
 * The project's test command and report. Null when it has none: evidence is
 * then neither collected nor required, which is how every project starts.
 */
export function loadVerification(projectRoot: string): VerificationConfig | { problem: string } | null {
  const path = verificationPath(projectRoot);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { problem: `verification.yaml is not valid YAML: ${(err as Error).message}` };
  }
  const doc = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  // The starter `init` writes says nothing yet: not configured, not broken.
  if (doc['command'] === undefined && doc['report'] === undefined) return null;
  const command = typeof doc['command'] === 'string' ? doc['command'].trim() : '';
  const report = typeof doc['report'] === 'string' ? doc['report'].trim() : '';
  if (!command || !report) return { problem: 'verification.yaml needs a `command` and the `report` it writes' };
  return { command, report };
}

// -----------------------------------------------------------------------------
// Methods
// -----------------------------------------------------------------------------

export type Method = 'test' | 'analysis' | 'inspection' | 'demonstration';
export const METHODS: readonly Method[] = ['test', 'analysis', 'inspection', 'demonstration'];

const VERIFIED_BY = /\*\*Verified by:\*\*\s*([A-Za-z]+)/i;

/** How an item is verified: what its text says, else by test. */
export function methodOf(item: ReviewItem): Method {
  const named = item.text.match(VERIFIED_BY)?.[1]?.toLowerCase();
  return METHODS.includes(named as Method) ? (named as Method) : 'test';
}

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

/** `[req:export#export-data]` and `[risk:add-export#export-leaks]`. */
const TAG = /\[(req|risk):([^\]\s]+)\]/g;

export interface Tag {
  kind: 'req' | 'risk';
  /** `capability#slug` for a requirement, `change#slug` for a risk. */
  ref: string;
}

export function tagsIn(text: string): Tag[] {
  return [...text.matchAll(TAG)].map((m) => ({ kind: m[1] as Tag['kind'], ref: m[2]! }));
}

/** The tag a test uses to name an item of `change`. */
export function tagFor(change: string, item: ReviewItem): string {
  return isRisk(item) ? `[risk:${change}#${item.id.slice('risks#'.length)}]` : `[req:${item.id}]`;
}

function names(change: string, item: ReviewItem, tag: Tag): boolean {
  if (tag.kind === 'risk') return isRisk(item) && tag.ref === `${change}#${item.id.slice('risks#'.length)}`;
  return isRequirement(item) && tag.ref === item.id;
}

// -----------------------------------------------------------------------------
// The JUnit report
// -----------------------------------------------------------------------------

export type Outcome = 'pass' | 'fail' | 'skip';

export interface TestResult {
  /** The test's name with its suite's, so tags on a `describe` count too. */
  name: string;
  file: string | null;
  outcome: Outcome;
}

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m?.[1] === undefined ? null : unescape(m[1]);
}

/**
 * The test cases of a JUnit XML report — the one format nearly every test
 * runner can write (bun, vitest and jest with a reporter, pytest
 * `--junitxml`, go via gotestsum, cargo-nextest).
 */
export function parseJUnit(xml: string): TestResult[] {
  const out: TestResult[] = [];
  const CASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(CASE)) {
    const open = m[1] ?? '';
    const body = m[3] ?? '';
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    const name = [attr(open, 'classname'), attr(open, 'name')].filter(Boolean).join(' ');
    out.push({ name, file: attr(open, 'file'), outcome });
  }
  return out;
}

// -----------------------------------------------------------------------------
// The record
// -----------------------------------------------------------------------------

export type EvidenceRecord =
  | {
      kind: 'run';
      at: string;
      item: string;
      /** The item's hash when the test ran: its text, as verified. */
      hash: string;
      test: string;
      file: string | null;
      /** The test file's content hash, so an edited test is not trusted. */
      fileHash: string | null;
      outcome: Outcome;
    }
  | { kind: 'sign'; at: string; item: string; hash: string; method: Method; note: string }
  | { kind: 'waive'; at: string; item: string; hash: string; reason: string };

export function evidencePath(projectRoot: string, change: string): string {
  return join(projectRoot, '.spec-tacular', 'evidence', `${change}.jsonl`);
}

/** Appends, never rewrites: evidence once recorded is history. */
export function appendEvidence(projectRoot: string, change: string, records: EvidenceRecord[]): void {
  if (records.length === 0) return;
  const path = evidencePath(projectRoot, change);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export function loadEvidence(projectRoot: string, change: string): EvidenceRecord[] {
  let raw: string;
  try {
    raw = readFileSync(evidencePath(projectRoot, change), 'utf8');
  } catch {
    return [];
  }
  const out: EvidenceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EvidenceRecord);
    } catch {
      // A torn last line from an interrupted write: the rest still counts.
    }
  }
  return out;
}

function hashFile(projectRoot: string, file: string | null): string | null {
  if (!file) return null;
  try {
    const content = readFileSync(isAbsolute(file) ? file : join(projectRoot, file));
    return `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
  } catch {
    return null;
  }
}

/**
 * The records one test run adds for one change: every test naming one of its
 * items, bound to that item's text and that test's file as they are now.
 */
export function recordsForRun(
  projectRoot: string,
  change: string,
  items: ReviewItem[],
  results: TestResult[],
  at = new Date().toISOString(),
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const result of results) {
    const tags = tagsIn(result.name);
    for (const item of items) {
      if (!tags.some((t) => names(change, item, t))) continue;
      out.push({
        kind: 'run',
        at,
        item: item.id,
        hash: item.hash,
        test: result.name,
        file: result.file,
        fileHash: hashFile(projectRoot, result.file),
        outcome: result.outcome,
      });
    }
  }
  return out;
}

/** Tags that name no item: tests verifying something that does not exist (any more). */
export function orphanTags(results: TestResult[], known: (tag: Tag) => boolean): { test: string; tag: string }[] {
  const out: { test: string; tag: string }[] = [];
  for (const r of results) {
    for (const t of tagsIn(r.name)) if (!known(t)) out.push({ test: r.name, tag: `[${t.kind}:${t.ref}]` });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export type EvidenceState = 'missing' | 'passing' | 'failing' | 'stale' | 'excepted' | 'not connected';

export interface ItemEvidence {
  item: ReviewItem;
  method: Method;
  state: EvidenceState;
  /** The tests behind a `passing`, `failing` or `stale`. */
  tests: string[];
  /** When the deciding evidence was recorded. */
  at: string | null;
  /** Why it is excepted, or what was signed. */
  note: string | null;
}

/**
 * What the record says about one item now.
 *
 * Only the latest run that named it counts, and only if neither the item's
 * text nor the test's file changed since: passing against text nobody
 * accepted proves nothing. A sign-off counts for analysis, inspection and
 * demonstration, likewise bound to the text it signed. A waiver beats both,
 * and is reported as excepted, never as verified.
 */
export function itemEvidence(
  projectRoot: string,
  item: ReviewItem,
  records: EvidenceRecord[],
  fileHashNow: (file: string | null) => string | null = (f) => hashFile(projectRoot, f),
  /** Matrix rows that must have run, `[row:D7]` in a test's name (add-test-matrix). */
  requiredRows: string[] = [],
): ItemEvidence {
  const method = methodOf(item);
  const mine = records.filter((r) => r.item === item.id);
  const base = { item, method, tests: [] as string[], at: null as string | null, note: null as string | null };

  const waiver = mine.filter((r) => r.kind === 'waive' && r.hash === item.hash).at(-1);
  if (waiver?.kind === 'waive') return { ...base, state: 'excepted', at: waiver.at, note: waiver.reason };

  if (method !== 'test') {
    const signed = mine.filter((r) => r.kind === 'sign').at(-1);
    if (signed?.kind !== 'sign') return { ...base, state: 'missing' };
    return {
      ...base,
      state: signed.hash === item.hash ? 'passing' : 'stale',
      at: signed.at,
      note: signed.note,
    };
  }

  const runs = mine.filter((r): r is Extract<EvidenceRecord, { kind: 'run' }> => r.kind === 'run');
  const last = runs.at(-1)?.at;
  const latest = runs.filter((r) => r.at === last && r.outcome !== 'skip');
  if (latest.length === 0) return { ...base, state: 'missing' };

  const tests = latest.map((r) => r.test);
  const stale = latest.some((r) => r.hash !== item.hash || (r.fileHash !== null && fileHashNow(r.file) !== r.fileHash));
  const failing = latest.some((r) => r.outcome === 'fail');
  // Its matrix says which cases must be shown; passing some of them is not
  // passing the requirement.
  const ran = new Set(latest.flatMap((r) => [...r.test.matchAll(/\[row:([^\]\s]+)\]/g)].map((m) => m[1]!)));
  const notRun = requiredRows.filter((id) => !ran.has(id));
  if (!failing && notRun.length > 0) {
    return { ...base, state: 'missing', tests, at: last ?? null, note: `matrix rows not run: ${notRun.join(', ')}` };
  }
  return { ...base, state: failing ? 'failing' : stale ? 'stale' : 'passing', tests, at: last ?? null };
}

export interface EvidenceSummary {
  total: number;
  passing: number;
  failing: number;
  stale: number;
  missing: number;
  excepted: number;
  /** Passing, through a harness not shown to reach the real code. */
  unconnected: number;
  /** Every item passing or excepted — what archiving requires. */
  complete: boolean;
}

/**
 * The items of a change that need evidence: accepted requirements and
 * accepted risks. A deferred requirement goes to the pending register at
 * archive, so it is excepted by its deferral; a risk left Unmitigated has no
 * guard to verify.
 */
export function needsEvidence(reviewed: ReviewedItem[]): { item: ReviewItem; deferred: string | null }[] {
  const out: { item: ReviewItem; deferred: string | null }[] = [];
  for (const r of reviewed) {
    if (!isRequirement(r.item) && !isRisk(r.item)) continue;
    if (isRisk(r.item) && r.item.unmitigated) continue;
    if (r.state === 'accepted') out.push({ item: r.item, deferred: null });
    else if (r.state === 'deferred') out.push({ item: r.item, deferred: r.review.deferReason ?? 'deferred in review' });
  }
  return out;
}

export function changeEvidence(
  projectRoot: string,
  change: string,
  reviewed: ReviewedItem[],
  /** Per item id, the matrix rows that must have run. */
  requiredRows: ReadonlyMap<string, string[]> = new Map(),
  /**
   * Per item id, why its matrix's harness cannot be trusted
   * (core/formal/harness.ts). Its passing rows then prove nothing.
   */
  unconnected: ReadonlyMap<string, string> = new Map(),
  /**
   * Per item id, why its matrix shows nothing even when every row passes
   * (core/formal/matrix.ts: `vacuous`). Its evidence is missing until fixed.
   */
  vacuous: ReadonlyMap<string, string> = new Map(),
): ItemEvidence[] {
  const records = loadEvidence(projectRoot, change);
  return needsEvidence(reviewed).map(({ item, deferred }): ItemEvidence => {
    if (deferred !== null) return { item, method: methodOf(item), state: 'excepted', tests: [], at: null, note: `deferred: ${deferred}` };
    const e = itemEvidence(projectRoot, item, records, undefined, requiredRows.get(item.id) ?? []);
    const hollow = vacuous.get(item.id);
    if (hollow && (e.state === 'passing' || e.state === 'missing')) return { ...e, state: 'missing', note: hollow };
    const why = unconnected.get(item.id);
    return why && e.state === 'passing' ? { ...e, state: 'not connected', note: why } : e;
  });
}

export function summarizeEvidence(items: ItemEvidence[]): EvidenceSummary {
  const count = (s: EvidenceState) => items.filter((i) => i.state === s).length;
  const passing = count('passing');
  const excepted = count('excepted');
  return {
    total: items.length,
    passing,
    failing: count('failing'),
    stale: count('stale'),
    missing: count('missing'),
    excepted,
    unconnected: count('not connected'),
    complete: items.length > 0 && passing + excepted === items.length,
  };
}

// -----------------------------------------------------------------------------
// Running
// -----------------------------------------------------------------------------

/**
 * Runs the project's test command and reads its report. A failing test exits
 * non-zero, which is a result, not an error; only a missing report is.
 */
export function runTests(projectRoot: string, config: VerificationConfig): { ok: true; results: TestResult[] } | { ok: false; reason: string } {
  const report = isAbsolute(config.report) ? config.report : join(projectRoot, config.report);
  const before = existsSync(report) ? readFileSync(report, 'utf8') : null;
  try {
    execFileSync('sh', ['-c', config.command], { cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    // Failing tests: the report says which.
  }
  if (!existsSync(report)) return { ok: false, reason: `the test command wrote no report at ${config.report}` };
  const xml = readFileSync(report, 'utf8');
  if (before !== null && xml === before) {
    // An old report read as new would pass tests that never ran.
    return { ok: false, reason: `${config.report} was not rewritten by the test command — is it the report it writes?` };
  }
  return { ok: true, results: parseJUnit(xml) };
}

// -----------------------------------------------------------------------------
// Negative scenarios
// -----------------------------------------------------------------------------

const NEGATIVE = /\b(not|never|no|fails?|failing|reject(s|ed)?|refuse[sd]?|invalid|error|denie[sd]|deny|without|unless|cannot|missing|empty|exceed(s|ed)?|forbidden|unauthori[sz]ed|blocked|too)\b/i;

/**
 * Whether a requirement says what must not happen, or how it fails. NASA and
 * ISO 26262 both require negative testing; a requirement whose scenarios are
 * all the happy path gives the tests nothing to check it against. Advisory —
 * the words are a heuristic, and a person decides.
 */
export const NO_NEGATIVE = 'no scenario says what must not happen, or how it fails — a negative test needs one';

export function lacksNegativeScenario(item: ReviewItem): boolean {
  if (!isRequirement(item) || item.scenarios.length === 0) return false;
  return !item.scenarios.some((s) => NEGATIVE.test(`${s.name}\n${s.body.join('\n')}`));
}
