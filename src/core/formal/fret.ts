/**
 * NASA FRET itself: exporting to it, checking spec-tacular against it, and
 * monitoring recorded runs.
 *
 * spec-tacular reads FRETish with its own semantics (fretish.ts), and every
 * matrix inherits that reading. A tool whose errors would go unnoticed
 * downstream has to earn trust — tool qualification, in the safety
 * standards' terms (docs/proposals/add-fret-interop.md). So:
 *
 * - **Cross-check.** For each FRETish requirement, FRET's own finite-trace
 *   formula (`fretcli formalize -l ft-fin`) is evaluated (mtl.ts) next to
 *   spec-tacular's verdict, on the matrix's step sequences and on many
 *   seeded random traces. Any trace they disagree on is reported. Formulas
 *   come from the FRET command line where it is installed, and are cached in
 *   `spec-tacular/fret/formulas.json` — committed, so the check runs where
 *   FRET is not.
 * - **Export.** The requirements and the glossary, as CSV and JSON, for
 *   FRET's realizability checking, simulator and test generation.
 * - **Monitoring.** A recorded run (JSON lines, one step each) checked
 *   against the formal requirements whose variables it records — the
 *   offline half of runtime verification. And which requirements could be
 *   monitored on a running system at all: an unbounded `eventually` can
 *   never be reported violated while the system runs.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { Env, Value } from './expr.ts';
import { evaluate } from './expr.ts';
import { resolveLiterals, type Decision } from './formal.ts';
import { check, fretVariables, type Fretish } from './fretish.ts';
import type { Glossary } from './glossary.ts';
import { holdsAt, mtlVariables, parseMtl, type Mtl } from './mtl.ts';

// -----------------------------------------------------------------------------
// FRET's formulas
// -----------------------------------------------------------------------------

export function formulasPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'fret', 'formulas.json');
}

interface Cache {
  /** FRETish source → FRET's ft-fin formula. */
  [fretish: string]: { ftFin: string; at: string };
}

function loadCache(projectRoot: string): Cache {
  try {
    return JSON.parse(readFileSync(formulasPath(projectRoot), 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * How to call FRET's command line: `fret.cli` in verification.yaml, else
 * `SPECTACULAR_FRET_CLI` — the part before `formalize`, e.g.
 * `npm run --silent --prefix ~/fret/fret-electron start-cli --`.
 */
export function fretCli(projectRoot: string): string | null {
  if (process.env['SPECTACULAR_FRET_CLI']) return process.env['SPECTACULAR_FRET_CLI'];
  try {
    const raw = parse(readFileSync(join(projectRoot, 'spec-tacular', 'verification.yaml'), 'utf8')) as Record<string, unknown> | null;
    const cli = (raw?.['fret'] as Record<string, unknown> | undefined)?.['cli'];
    return typeof cli === 'string' && cli.trim() ? cli.trim() : null;
  } catch {
    return null;
  }
}

/**
 * How to run `fret.cli` with arguments. The command itself is shell text
 * from the project's own config (like an npm script), but the arguments go
 * to the shell as positional parameters ("$@"), never into the command
 * text, so a quote or `;` in a change name or sentence stays data.
 */
export function fretInvocation(cli: string, args: string[]): [string, string[]] {
  return ['sh', ['-c', `${cli} "$@"`, 'sh', ...args]];
}

export type FormulaSource = { formula: string; from: 'fret' | 'cache' } | { formula: null; why: string };

/**
 * FRET's finite-trace formula for a FRETish sentence: asked of FRET when it
 * is installed (and cached), else read from the cache.
 */
export function fretFormula(projectRoot: string, fretish: string): FormulaSource {
  const cli = fretCli(projectRoot);
  if (cli) {
    const r = spawnSync(...fretInvocation(cli, ['formalize', '-l', 'ft-fin', fretish]), { encoding: 'utf8', timeout: 60_000 });
    const line = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
    if (r.status === 0 && line) {
      const cache = loadCache(projectRoot);
      cache[fretish] = { ftFin: line, at: new Date().toISOString() };
      mkdirSync(dirname(formulasPath(projectRoot)), { recursive: true });
      writeFileSync(formulasPath(projectRoot), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      return { formula: line, from: 'fret' };
    }
    return { formula: null, why: `FRET did not formalize it: ${(r.stderr || r.stdout || 'no output').trim().split('\n').at(-1)}` };
  }
  const cached = loadCache(projectRoot)[fretish];
  if (cached) return { formula: cached.ftFin, from: 'cache' };
  return { formula: null, why: 'FRET is not set up here (fret.cli in verification.yaml) and has no cached formula for it' };
}

// -----------------------------------------------------------------------------
// The cross-check
// -----------------------------------------------------------------------------

/** A small, seeded generator, so a disagreement can be reproduced. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Disagreement {
  trace: Env[];
  fret: boolean;
  ours: boolean;
}

export interface CrossCheck {
  fretish: string;
  formula: string;
  traces: number;
  disagreements: Disagreement[];
}

/**
 * Compares spec-tacular's verdict with FRET's formula on traces over the
 * requirement's variables: the given ones (a matrix's sequences) and seeded
 * random ones of every length up to the timing's window and a few beyond.
 */
export function crossCheck(f: Fretish, formula: string, extra: Env[][] = [], count = 2000, seed = 1): CrossCheck {
  const mtl: Mtl = parseMtl(formula);
  const vars = [...new Set([...fretVariables(f), ...mtlVariables(mtl)])];
  const longest = Math.max((f.timing.n ?? 0) + 4, 6);
  const rand = prng(seed);
  const traces: Env[][] = [...extra];
  for (let k = 0; k < count; k++) {
    const length = 1 + Math.floor(rand() * longest);
    // Sparse and dense traces both: a trigger held is as telling as one that never comes.
    const density = rand();
    traces.push(Array.from({ length }, () => Object.fromEntries(vars.map((v) => [v, rand() < density]))));
  }
  const disagreements: Disagreement[] = [];
  for (const trace of traces) {
    const fret = holdsAt(mtl, trace, 0);
    const ours = check(f, trace).holds;
    if (fret !== ours) disagreements.push({ trace, fret, ours });
  }
  return { fretish: f.source, formula, traces: traces.length, disagreements };
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

export interface ExportRow {
  reqid: string;
  fulltext: string;
  rationale: string;
}

const csv = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

/**
 * FRET's input: one row per FRETish sentence, with the requirement it comes
 * from as rationale; and the glossary as FRET's variable kinds — Mode,
 * Input, Output, Internal — and data types.
 */
export function exportFiles(project: string, rows: ExportRow[], glossary: Glossary | null): Record<string, string> {
  const json = rows.map((r) => ({ reqid: r.reqid, parent_reqid: '', project, rationale: r.rationale, comments: '', fulltext: r.fulltext }));
  const kind = { mode: 'Mode', input: 'Input', output: 'Output', internal: 'Internal' } as const;
  const type = { bool: 'boolean', int: 'integer', float: 'double', enum: 'integer' } as const;
  const vars = [...(glossary?.variables.values() ?? [])].map((v) =>
    csv([v.name, kind[v.role], type[v.type], v.type === 'enum' ? `${v.meaning} (values: ${v.values.join(', ')})` : v.meaning]),
  );
  return {
    'fret-requirements.json': `${JSON.stringify(json, null, 2)}\n`,
    'fret-requirements.csv': [csv(['reqid', 'fulltext', 'rationale', 'project']), ...rows.map((r) => csv([r.reqid, r.fulltext, r.rationale, project]))].join('\n') + '\n',
    'fret-variables.csv': [csv(['name', 'kind', 'type', 'description']), ...vars].join('\n') + '\n',
  };
}

// -----------------------------------------------------------------------------
// Monitoring
// -----------------------------------------------------------------------------

/**
 * Whether a violation could be reported while the system runs, rather than
 * only once a recording ends. An unbounded `eventually`, or `finally` with
 * no scope to end, is decided only at the end of time.
 */
export function monitorability(f: Fretish): string | null {
  const scoped = f.scope !== null && f.scope.kind !== 'before';
  if (f.timing.kind === 'eventually' && !scoped) {
    return 'unbounded "eventually": a running monitor can never report it violated — bound it ("within N ticks")';
  }
  if (f.timing.kind === 'finally' && !scoped) return '"finally" without a scope that ends: decided only when the run ends';
  return null;
}

export interface MonitorVerdict {
  requirement: string;
  form: string;
  /** Not every variable it reads was recorded. */
  unobserved: string[];
  holds: boolean | null;
  /** Steps where it was violated: triggers for FRETish, steps for a decision. */
  violated: number[];
}

/** Reads a recorded run: one JSON object of variable values per line. */
export function readTrace(text: string): Env[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, Value>;
      } catch {
        throw new Error(`line ${i + 1} of the trace is not JSON`);
      }
    });
}

export function monitorFret(name: string, f: Fretish, trace: Env[]): MonitorVerdict {
  const recorded = new Set(trace.flatMap((s) => Object.keys(s)));
  const unobserved = [...fretVariables(f)].filter((v) => !recorded.has(v));
  if (unobserved.length > 0) return { requirement: name, form: f.source, unobserved, holds: null, violated: [] };
  const v = check(f, trace);
  return { requirement: name, form: f.source, unobserved, holds: v.holds, violated: v.violated };
}

export function monitorDecision(name: string, d: Decision, trace: Env[], glossary: Glossary | null): MonitorVerdict {
  const expr = resolveLiterals(d.expr, glossary);
  const recorded = new Set(trace.flatMap((s) => Object.keys(s)));
  const needed = [d.output, ...collect(expr)];
  const unobserved = [...new Set(needed)].filter((v) => !recorded.has(v));
  if (unobserved.length > 0) return { requirement: name, form: d.source, unobserved, holds: null, violated: [] };
  const violated = trace.flatMap((step, i) => (step[d.output] === evaluate(expr, step) ? [] : [i]));
  return { requirement: name, form: d.source, unobserved, holds: violated.length === 0, violated };
}

function collect(e: Decision['expr'], out: string[] = []): string[] {
  if (e.k === 'var') out.push(e.name);
  else if (e.k === 'not') collect(e.e, out);
  else if (e.k === 'bin' || e.k === 'cmp') { collect(e.a, out); collect(e.b, out); }
  return out;
}
