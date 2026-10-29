/**
 * The test matrix: every case a formal form distinguishes, with the outcome
 * it requires, generated rather than chosen.
 *
 * An agent writing tests by hand picks the cases it thought of. The matrix is
 * every case the formula distinguishes (docs/proposals/add-test-matrix.md):
 *
 * - A decision gets its full truth table — every combination of its
 *   conditions, each made concrete (a comparison true or false at a value
 *   just inside or on its boundary) and its expected output computed from
 *   the formula. Rows the glossary's constraints rule out are marked
 *   infeasible, with the constraint, and not run. The rows that show each
 *   condition independently changing the outcome (MC/DC: unique-cause pairs
 *   first, masking pairs where those are impossible) are marked; a condition
 *   with neither is dead, and reported — that is design feedback. Boundary
 *   rows then walk each comparison across its edge: the range's ends, one
 *   step either side, and the boundary itself.
 * - A FRETish requirement gets step sequences — the inputs per step, and
 *   checks over the response: at a step, at some step in a window, at every
 *   step in a window, at no step in a window. Its cases are the trigger
 *   firing once, never, held, again while the first is pending, late, and —
 *   with a scope — outside it. Violating sequences come with it, for the
 *   checker itself: given a response that breaks the formula, a check must
 *   report failure.
 *
 * The matrix is coverage of the formula, not of the code; whether the tests
 * reach the real code is add-harness-assurance's question.
 */

import { createHash } from 'node:crypto';
import {
  conditionKey,
  conditionsOf,
  evaluate,
  evaluateConditions,
  inWords,
  variablesOf,
  type Env,
  type Expr,
  type Value,
} from './expr.ts';
import { checkFormal, resolveLiterals, type FormalForm } from './formal.ts';
import { fretVariables, scopeIntervals, triggers, type Fretish } from './fretish.ts';
import type { Glossary, Variable } from './glossary.ts';

export const GENERATOR_VERSION = 1;

/** One check on the response over the steps a test observed. */
export type Check =
  | { kind: 'at'; step: number; holds: boolean }
  | { kind: 'some' | 'every' | 'none'; from: number; to: number };

export interface MatrixRow {
  id: string;
  /** Inputs per step: one step for a decision. */
  steps: Record<string, Value>[];
  /** A decision: the outputs it must produce. */
  expect?: Record<string, Value>;
  /** A FRETish requirement: what the response must do. */
  checks?: Check[];
  /** The conditions this row is an MC/DC witness for. */
  mcdc?: string[];
  /** Why the row cannot happen, when it cannot; such a row is not run. */
  infeasible?: string;
  /** The row in plain words. */
  words: string;
}

export interface SelfTest {
  id: string;
  /** Whether the response held at each step. */
  response: boolean[];
  checks: Check[];
  /** What a correct checker must say. */
  passes: boolean;
}

export interface Matrix {
  generator: number;
  /** The item it is derived from: `capability#slug` or `risks#slug`. */
  item: string;
  tag: string;
  /** Hashes of what it was derived from, so a stale one is noticed. */
  formulaHash: string;
  glossaryHash: string;
  kind: 'decision' | 'fret';
  source: string;
  component: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  /** For a FRETish requirement: the response, for the runner to evaluate. */
  response?: Expr;
  conditions: string[];
  /** Conditions with no independence pair at all. */
  dead: string[];
  rows: MatrixRow[];
  selfTest: SelfTest[];
  notes: string[];
  /**
   * Why passing it would show nothing, when it would: no row can run, or
   * the output is the same in every row that can — the case it exists for
   * never happens. Such a matrix verifies nothing until its formula or the
   * glossary's constraints are fixed.
   */
  vacuous?: string;
}

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 32)}`;

export function glossaryHash(glossary: Glossary | null): string {
  if (!glossary) return sha('');
  const vars = [...glossary.variables.values()].sort((a, b) => a.name.localeCompare(b.name));
  return sha(JSON.stringify({ vars, constraints: glossary.constraints.map((c) => c.source) }));
}

const typeOf = (v: Variable | undefined) => v?.type ?? 'bool';

/**
 * The constraint that rules `env` out, if one does. Only a constraint whose
 * every variable `env` sets can: one naming a variable the row does not
 * have says nothing about the row — read as false, it would empty a matrix
 * that never mentions that variable.
 */
export function ruledOutBy(glossary: Glossary | null, env: Record<string, Value>): string | null {
  for (const c of glossary?.constraints ?? []) {
    const expr = resolveLiterals(c.expr, glossary);
    if (![...variablesOf(expr)].every((v) => v in env)) continue;
    if (!evaluate(expr, env)) return c.source;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Concrete values
// -----------------------------------------------------------------------------

type Cmp = Extract<Expr, { k: 'cmp' }>;

/** The variable and constant of a `var op constant` comparison, normalised. */
function sides(c: Cmp): { name: string; op: Cmp['op']; value: Value } | null {
  const flip: Record<Cmp['op'], Cmp['op']> = { '=': '=', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
  if (c.a.k === 'var' && c.b.k === 'lit') return { name: c.a.name, op: c.op, value: c.b.value };
  if (c.b.k === 'var' && c.a.k === 'lit') return { name: c.b.name, op: flip[c.op], value: c.a.value };
  return null;
}

function step(v: Variable | undefined): number {
  if (typeOf(v) === 'int') return 1;
  return v?.tolerance ?? 0.01;
}

/** Values worth trying for a numeric variable: each boundary, a step either side, the range's ends. */
function candidates(v: Variable | undefined, constants: number[]): number[] {
  const d = step(v);
  const out = new Set<number>();
  for (const c of constants) [c - d, c, c + d].forEach((x) => out.add(Number(x.toFixed(6))));
  if (v?.range) v.range.forEach((x) => out.add(x));
  if (out.size === 0) [0, 1].forEach((x) => out.add(x));
  return [...out].filter((x) => !v?.range || (x >= v.range[0] && x <= v.range[1])).sort((a, b) => a - b);
}

/**
 * Concrete inputs for one assignment of the conditions: each boolean
 * variable as assigned, each compared variable at a value meeting every
 * comparison on it — or null, with why, when there is none.
 */
function concretize(
  conds: Map<string, Expr>,
  assignment: Record<string, boolean>,
  glossary: Glossary | null,
): { env: Record<string, Value> } | { infeasible: string } {
  const env: Record<string, Value> = {};
  const compared = new Map<string, { op: Cmp['op']; value: Value; truth: boolean }[]>();
  const between: { key: string; e: Cmp; truth: boolean }[] = [];
  for (const [k, e] of conds) {
    if (e.k === 'var') env[e.name] = assignment[k] === true;
    else if (e.k === 'cmp') {
      const s = sides(e);
      if (!s) {
        between.push({ key: k, e, truth: assignment[k] === true });
        continue;
      }
      compared.set(s.name, [...(compared.get(s.name) ?? []), { op: s.op, value: s.value, truth: assignment[k] === true }]);
    }
  }
  for (const [name, cmps] of compared) {
    const v = glossary?.variables.get(name);
    // Nearest a boundary first: "false" for `voltage > 9` is 9, not 0, so
    // the truth table already tests the edge.
    const constants = cmps.map((c) => Number(c.value));
    const nearness = (x: number) => Math.min(...constants.map((c) => Math.abs(x - c)));
    const pool: Value[] =
      typeOf(v) === 'enum'
        ? (v?.values ?? []).length > 0 ? v!.values : [...new Set(cmps.map((c) => c.value))]
        : candidates(v, constants).sort((a, b) => nearness(a) - nearness(b) || a - b);
    const ok = (x: Value) =>
      cmps.every((c) => evaluate({ k: 'cmp', op: c.op, a: { k: 'lit', value: x }, b: { k: 'lit', value: c.value } }, {}) === c.truth);
    const found = pool.find(ok);
    if (found === undefined) {
      return { infeasible: `no value of ${name} makes ${cmps.map((c) => `${name} ${c.op} ${c.value} ${c.truth ? 'true' : 'false'}`).join(' and ')}` };
    }
    env[name] = found;
  }
  // Two variables compared with each other (`entry_start < now`): values for
  // both, near each other, consistent with what is already chosen.
  for (const b of between) {
    if (b.e.a.k !== 'var' || b.e.b.k !== 'var') return { infeasible: `${b.key} is not a comparison generated yet` };
    const [x, y] = [b.e.a.name, b.e.b.name];
    const vx = glossary?.variables.get(x);
    const vy = glossary?.variables.get(y);
    if (typeOf(vx) === 'enum' || typeOf(vy) === 'enum' || typeOf(vx) === 'bool' || typeOf(vy) === 'bool') {
      return { infeasible: `${b.key} compares two non-numeric variables — not generated yet` };
    }
    const pool = (v: Variable | undefined, name: string) =>
      name in env ? [env[name] as number] : candidates(v, v?.range ? [] : [0]);
    let pair: [number, number] | null = null;
    for (const a of pool(vx, x)) {
      for (const c of pool(vy, y)) {
        const holds = evaluate({ k: 'cmp', op: b.e.op, a: { k: 'lit', value: a }, b: { k: 'lit', value: c } }, {});
        const consistent = between.every((o) =>
          o === b || !(o.e.a.k === 'var' && o.e.b.k === 'var') ||
          ![o.e.a.name, o.e.b.name].every((n) => n in env || n === x || n === y) ||
          evaluate(o.e, { ...env, [x]: a, [y]: c }) === o.truth);
        if (holds === b.truth && consistent) {
          pair = [a, c];
          break;
        }
      }
      if (pair) break;
    }
    if (!pair) return { infeasible: `no values of ${x} and ${y} make ${b.key} ${b.truth ? 'true' : 'false'}` };
    env[x] = pair[0];
    env[y] = pair[1];
  }
  const ruled = ruledOutBy(glossary, env);
  if (ruled) return { infeasible: `ruled out by the constraint ${ruled}` };
  return { env };
}

const fmt = (env: Record<string, Value>) =>
  Object.entries(env).map(([k, v]) => `${k}=${v === true ? 'T' : v === false ? 'F' : v}`).join(', ');

// -----------------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------------

/** Above this many conditions the full table is not generated. */
export const MAX_TABLE_CONDITIONS = 10;

function decisionMatrix(d: FormalForm['decisions'][number], glossary: Glossary | null): Omit<Matrix, 'generator' | 'item' | 'tag' | 'formulaHash' | 'glossaryHash'> {
  const expr = resolveLiterals(d.expr, glossary);
  const conds = conditionsOf(expr);
  const keys = [...conds.keys()];
  const notes: string[] = [];
  const inputs: Record<string, string> = {};
  for (const v of variablesOf(expr)) inputs[v] = typeOf(glossary?.variables.get(v));
  const outputs = { [d.output]: typeOf(glossary?.variables.get(d.output)) };
  const base = {
    kind: 'decision' as const,
    source: d.source,
    component: d.output,
    inputs,
    outputs,
    conditions: keys,
    selfTest: [],
  };

  if (keys.length > MAX_TABLE_CONDITIONS) {
    return { ...base, dead: [], rows: [], notes: [`${keys.length} conditions: the full table (${2 ** keys.length} rows) is not generated — split the decision`] };
  }

  type Raw = { assignment: Record<string, boolean>; env?: Record<string, Value>; infeasible?: string; out: boolean };
  const raws: Raw[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const assignment = Object.fromEntries(keys.map((k, bit) => [k, (mask & (1 << (keys.length - 1 - bit))) !== 0]));
    const c = concretize(conds, assignment, glossary);
    const out = evaluateConditions(expr, assignment);
    raws.push('env' in c ? { assignment, env: c.env, out } : { assignment, infeasible: c.infeasible, out });
  }

  // MC/DC: for each condition, a pair of feasible rows where flipping it
  // alone flips the outcome; else a masking pair, where it determines the
  // outcome in both rows though other conditions differ too.
  const mcdc = new Map<number, string[]>();
  const dead: string[] = [];
  const feasible = (i: number) => raws[i]!.infeasible === undefined;
  const determines = (r: Raw, k: string) => evaluateConditions(expr, { ...r.assignment, [k]: !r.assignment[k] }) !== r.out;
  keys.forEach((k, bit) => {
    const flip = 1 << (keys.length - 1 - bit);
    let pair: [number, number] | null = null;
    for (let i = 0; i < raws.length && !pair; i++) {
      const j = i ^ flip;
      if (j > i && feasible(i) && feasible(j) && raws[i]!.out !== raws[j]!.out) pair = [i, j];
    }
    for (let i = 0; i < raws.length && !pair; i++) {
      for (let j = i + 1; j < raws.length && !pair; j++) {
        const a = raws[i]!;
        const b = raws[j]!;
        if (feasible(i) && feasible(j) && a.assignment[k] !== b.assignment[k] && a.out !== b.out && determines(a, k) && determines(b, k)) pair = [i, j];
      }
    }
    if (!pair) {
      dead.push(k);
      return;
    }
    for (const i of pair) mcdc.set(i, [...(mcdc.get(i) ?? []), k]);
  });
  if (dead.length > 0) {
    notes.push(
      `no row shows ${dead.join(', ')} changing the outcome on its own: dead, or coupled to another condition — ` +
        'remove the redundant guard, or merge the coupled ones into one state',
    );
  }

  const rows: MatrixRow[] = raws.map((r, i) => {
    const id = `D${i + 1}`;
    const when = keys.map((k) => `${k}=${r.assignment[k] ? 'T' : 'F'}`).join(', ');
    if (r.infeasible) return { id, steps: [], infeasible: r.infeasible, words: `${when}: cannot happen — ${r.infeasible}` };
    return {
      id,
      steps: [r.env!],
      expect: { [d.output]: r.out },
      ...(mcdc.has(i) ? { mcdc: mcdc.get(i)! } : {}),
      words: `${fmt(r.env!)} → ${d.output}=${r.out ? 'T' : 'F'}`,
    };
  });

  // Boundary rows: each comparison walked across its edge, from a row where
  // it decides the outcome, so the value is what changes the answer.
  let b = 0;
  const seen = new Set(rows.filter((r) => !r.infeasible).map((r) => JSON.stringify(r.steps[0])));
  for (const [k, e] of conds) {
    if (e.k !== 'cmp') continue;
    const s = sides(e);
    const v = s ? glossary?.variables.get(s.name) : undefined;
    if (!s || typeOf(v) === 'enum' || typeof s.value !== 'number') continue;
    const baseIndex = raws.findIndex((r, i) => feasible(i) && determines(r, k)) ;
    const from = raws[baseIndex === -1 ? raws.findIndex((_, i) => feasible(i)) : baseIndex];
    if (!from?.env) continue;
    for (const x of candidates(v, [s.value])) {
      const env = { ...from.env, [s.name]: x };
      if (seen.has(JSON.stringify(env))) continue;
      if (ruledOutBy(glossary, env)) continue;
      seen.add(JSON.stringify(env));
      const out = evaluate(expr, env);
      rows.push({ id: `B${++b}`, steps: [env], expect: { [d.output]: out }, words: `${fmt(env)} → ${d.output}=${out ? 'T' : 'F'}   (edge of ${k})` });
    }
  }
  const outcomes = new Set(rows.filter((r) => !r.infeasible).map((r) => r.expect?.[d.output]));
  const vacuous = outcomes.size === 0
    ? 'no row can happen: every combination is ruled out'
    : outcomes.size === 1
      ? `${d.output} is ${[...outcomes][0] ? 'true' : 'false'} in every row that can happen — no row shows it ${[...outcomes][0] ? 'false' : 'true'}`
      : undefined;
  if (vacuous) notes.push(`tests nothing: ${vacuous} — check the formula and the glossary's constraints`);
  return { ...base, dead, rows, notes, ...(vacuous ? { vacuous } : {}) };
}

// -----------------------------------------------------------------------------
// FRETish
// -----------------------------------------------------------------------------

/** Inputs that make an expression true, and ones that make it false. */
function satisfying(e: Expr, glossary: Glossary | null): { on: Record<string, Value> | null; off: Record<string, Value> | null } {
  const conds = conditionsOf(resolveLiterals(e, glossary));
  const keys = [...conds.keys()];
  let on: Record<string, Value> | null = null;
  let off: Record<string, Value> | null = null;
  for (let mask = 0; mask < 1 << keys.length && (!on || !off); mask++) {
    const assignment = Object.fromEntries(keys.map((k, bit) => [k, (mask & (1 << bit)) !== 0]));
    const c = concretize(conds, assignment, glossary);
    if (!('env' in c)) continue;
    const truth = evaluateConditions(resolveLiterals(e, glossary), assignment);
    if (truth && !on) on = c.env;
    if (!truth && !off) off = c.env;
  }
  return { on, off };
}

function checksFor(f: Fretish, trace: Env[]): Check[] {
  const out: Check[] = [];
  const stop = f.timing.stop;
  for (const interval of scopeIntervals(f, trace)) {
    const [s, e] = interval;
    for (const t of triggers(f, trace, interval)) {
      const n = f.timing.n ?? 0;
      const stopAt = () => {
        for (let i = t; i <= e; i++) if (stop && evaluate(stop, trace[i]!)) return i;
        return -1;
      };
      switch (f.timing.kind) {
        case 'immediately': out.push({ kind: 'at', step: t, holds: true }); break;
        case 'initially': out.push({ kind: 'at', step: s, holds: true }); break;
        case 'next': if (t + 1 <= e) out.push({ kind: 'at', step: t + 1, holds: true }); break;
        case 'finally': out.push({ kind: 'at', step: e, holds: true }); break;
        case 'eventually': out.push({ kind: 'some', from: t, to: e }); break;
        case 'always': out.push({ kind: 'every', from: t, to: e }); break;
        case 'never': out.push({ kind: 'none', from: t, to: e }); break;
        // A window running past the end is judged on the steps there are:
        // within it, nothing is required (fretish.ts `check`).
        case 'within': if (t + n <= e) out.push({ kind: 'some', from: t, to: t + n }); break;
        case 'for': out.push({ kind: 'every', from: t, to: Math.min(t + n, e) }); break;
        case 'after':
          if (n > 0) out.push({ kind: 'none', from: t, to: Math.min(t + n - 1, e) });
          if (t + n <= e) out.push({ kind: 'at', step: t + n, holds: true });
          break;
        case 'until': {
          const c = stopAt();
          const to = c === -1 ? e : c - 1;
          if (to >= t) out.push({ kind: 'every', from: t, to });
          break;
        }
        case 'before': {
          const c = stopAt();
          if (c > t) out.push({ kind: 'some', from: t, to: c - 1 });
          break;
        }
      }
    }
  }
  return out;
}

/** A response that breaks a check, and one that meets it — for the checker's own test. */
function violate(check: Check, length: number): boolean[] {
  if (check.kind === 'none') {
    // Held nowhere but once inside the window.
    const r = new Array<boolean>(length).fill(false);
    r[check.from] = true;
    return r;
  }
  const r = new Array<boolean>(length).fill(true);
  if (check.kind === 'at') r[check.step] = !check.holds;
  else if (check.kind === 'some') for (let i = check.from; i <= check.to; i++) r[i] = false;
  else r[check.to] = false; // every: missing at the window's last step
  return r;
}

function meets(checks: Check[], length: number): boolean[] {
  const r = new Array<boolean>(length).fill(false);
  for (const c of checks) {
    if (c.kind === 'at' && c.holds) r[c.step] = true;
    if (c.kind === 'some') r[c.from] = true;
    if (c.kind === 'every') for (let i = c.from; i <= c.to; i++) r[i] = true;
  }
  // `none` is met by the false default, unless an `every` overlaps it — a
  // contradiction the conflict checks are for, not the checker's test.
  return r;
}

function fretMatrix(f: Fretish, glossary: Glossary | null): Omit<Matrix, 'generator' | 'item' | 'tag' | 'formulaHash' | 'glossaryHash'> {
  const notes: string[] = [];
  const role = (v: string) => glossary?.variables.get(v)?.role;
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  for (const v of fretVariables(f)) {
    const r = role(v);
    if (r === 'output' || r === 'internal') outputs[v] = typeOf(glossary?.variables.get(v));
    else inputs[v] = typeOf(glossary?.variables.get(v));
  }
  const response = resolveLiterals(f.response, glossary);
  const resolved: Fretish = {
    ...f,
    response,
    ...(f.condition ? { condition: { ...f.condition, expr: resolveLiterals(f.condition.expr, glossary) } } : {}),
    timing: { ...f.timing, ...(f.timing.stop ? { stop: resolveLiterals(f.timing.stop, glossary) } : {}) },
  };

  const n = f.timing.n ?? 0;
  const length = Math.max(n, 2) + 5;
  const cond = resolved.condition ? satisfying(resolved.condition.expr, glossary) : { on: {}, off: {} };
  const stop = resolved.timing.stop ? satisfying(resolved.timing.stop, glossary) : null;
  if (resolved.condition && (!cond.on || !cond.off)) notes.push(`the condition ${f.condition!.source} is never ${cond.on ? 'false' : 'true'}`);
  const on = cond.on ?? {};
  const off = cond.off ?? on;
  const mode = f.scope?.mode;

  const build = (fires: number[], inScope = true): Record<string, Value>[] =>
    Array.from({ length }, (_, i) => ({
      ...(fires.includes(i) ? on : off),
      ...(mode ? { [mode]: f.scope!.kind === 'notin' ? !inScope : inScope } : {}),
      // A stop condition, where the timing has one, comes three steps in.
      ...(stop?.on && stop.off ? (i === 3 ? stop.on : stop.off) : {}),
    }));

  const cases: { name: string; steps: Record<string, Value>[] }[] = resolved.condition
    ? [
        { name: 'fires once, at the start', steps: build([0]) },
        { name: 'never fires', steps: build([]) },
        { name: 'held at every step', steps: build(Array.from({ length }, (_, i) => i)) },
        { name: 'fires again while the first is pending', steps: build([0, 2]) },
        { name: 'fires late', steps: build([2]) },
      ]
    : [{ name: 'from the start', steps: build([]) }];
  if (f.scope && f.scope.kind !== 'before' && f.scope.kind !== 'after') {
    cases.push({ name: 'outside the scope', steps: build(resolved.condition ? [0] : [], false) });
  }

  const rows: MatrixRow[] = cases.map((c, i) => {
    const checks = checksFor(resolved, c.steps as Env[]);
    const words = checks.length === 0
      ? `${c.name}: nothing is required`
      : `${c.name}: ${checks.map((k) => (k.kind === 'at' ? `${k.holds ? '' : 'not '}at step ${k.step}` : `${k.kind} of steps ${k.from}–${k.to}`)).join('; ')}`;
    return { id: `T${i + 1}`, steps: c.steps, checks, words };
  });

  const vacuous = resolved.condition && !cond.on
    ? `its trigger ${f.condition!.source} can never be true`
    : rows.every((r) => !r.checks || r.checks.length === 0)
      ? 'no row requires anything of the response'
      : undefined;

  const selfTest: SelfTest[] = [];
  for (const row of rows) {
    if (!row.checks || row.checks.length === 0) continue;
    selfTest.push({ id: `${row.id}-meets`, response: meets(row.checks, length), checks: row.checks, passes: true });
    selfTest.push({ id: `${row.id}-breaks`, response: violate(row.checks[0]!, length), checks: [row.checks[0]!], passes: false });
  }

  return {
    kind: 'fret',
    source: f.source,
    component: f.component,
    inputs,
    outputs,
    response,
    conditions: [...conditionsOf(response).keys()],
    dead: [],
    rows,
    selfTest,
    notes: vacuous ? [...notes, `tests nothing: ${vacuous} — check the formula and the glossary's constraints`] : notes,
    ...(vacuous ? { vacuous } : {}),
  };
}

/** Whether the response checks hold over a response trace — the checker the runners implement. */
export function checksHold(checks: Check[], response: boolean[]): boolean {
  return checks.every((c) => {
    if (c.kind === 'at') return response[c.step] === c.holds;
    const window = response.slice(c.from, c.to + 1);
    if (c.kind === 'some') return window.some(Boolean);
    if (c.kind === 'every') return window.every(Boolean);
    return !window.some(Boolean);
  });
}

/**
 * The matrices of an item's formal form: one per decision and per FRETish
 * line. None when the form has errors — a matrix of a formula that cannot be
 * trusted would be trusted anyway.
 */
export function matricesFor(
  item: { id: string; text: string },
  tag: string,
  form: FormalForm,
  glossary: Glossary | null,
): Matrix[] {
  if (checkFormal(form, glossary).errors.length > 0) return [];
  const header = (i: number) => ({
    generator: GENERATOR_VERSION,
    item: item.id,
    tag,
    formulaHash: sha(i < form.decisions.length ? form.decisions[i]!.source : form.frets[i - form.decisions.length]!.source),
    glossaryHash: glossaryHash(glossary),
  });
  return [
    ...form.decisions.map((d, i) => ({ ...header(i), ...decisionMatrix(d, glossary) })),
    ...form.frets.map((f, i) => ({ ...header(form.decisions.length + i), ...fretMatrix(f, glossary) })),
  ];
}

/**
 * Which rows must pass for the item to count as verified. The full table
 * where the consequence is highest, or where there are no classes; MC/DC
 * and boundary rows for P1; none below — the table is still shown and run.
 */
export function requiredRows(m: Matrix, cls: string | null): string[] {
  const runnable = m.rows.filter((r) => !r.infeasible);
  if (cls === null || cls === 'P0') return runnable.map((r) => r.id);
  if (cls === 'P1') return runnable.filter((r) => r.mcdc || r.id.startsWith('B') || r.id.startsWith('T')).map((r) => r.id);
  return [];
}

/** The matrix as a reviewer reads it, one line per row. */
export function matrixLines(m: Matrix): string[] {
  const out = [`  Matrix (${m.kind === 'decision' ? `${m.conditions.length} conditions` : 'step sequences'}): ${m.source}`];
  for (const r of m.rows) {
    const mark = r.infeasible ? '  ×' : r.mcdc ? ' ◆' : '  ';
    out.push(`  ${mark} ${r.id.padEnd(4)} ${r.words}${r.mcdc ? `   [MC/DC: ${r.mcdc.join(', ')}]` : ''}`);
  }
  for (const n of m.notes) out.push(`  ! ${n}`);
  if (m.kind === 'decision' && m.rows.length >= 4 && !m.rows.some((r) => r.infeasible)) {
    out.push(
      '  · a row that cannot happen needs a constraint in spec-tacular/glossary.yaml',
      '    (e.g. `same_project -> timer_running`): it is then marked × and not run',
    );
  }
  return out;
}

export { conditionKey, inWords };
