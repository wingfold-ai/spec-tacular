/**
 * A subset of NASA FRET's requirement language, FRETish:
 *
 *     [scope] [condition] component shall [timing] satisfy response
 *
 *     upon request_sent Client shall within 3 ticks satisfy response | timeout_error
 *     in flight mode Battery shall always satisfy voltage > 9
 *
 * - scope: `in M`, `not in M`, `before M`, `after M` (with or without "mode")
 * - condition: `upon` / `when` / `if` (when it becomes true) or `whenever`
 *   (at every step it holds)
 * - timing: `immediately`, `initially`, `at the next timepoint`, `finally`,
 *   `eventually`, `always` (the default), `never`, `within N`, `for N`,
 *   `after N`, `until C`, `before C`
 *
 * and its meaning over a finite sequence of steps, which is what tests can
 * observe. The meaning follows FRET's definitions; where a finite sequence
 * leaves FRET's answer open — a window that runs past the end, a stop
 * condition that never comes — the choice is written next to it, to be
 * pinned against FRET itself (docs/proposals/add-fret-interop.md).
 */

import { evaluate, inWords, parseExpr, type Env, type Expr } from './expr.ts';

export type ScopeKind = 'in' | 'notin' | 'before' | 'after';
export type TimingKind =
  | 'immediately' | 'initially' | 'next' | 'finally' | 'eventually' | 'always' | 'never'
  | 'within' | 'for' | 'after' | 'until' | 'before';

export interface Fretish {
  scope: { kind: ScopeKind; mode: string } | null;
  condition: { kind: 'upon' | 'whenever'; expr: Expr; source: string } | null;
  component: string;
  timing: { kind: TimingKind; n?: number; stop?: Expr };
  response: Expr;
  source: string;
}

const UNIT = '(?:\\s+(?:ticks?|time\\s+units?|timepoints?|steps?|seconds?|ms))?';

function parseTiming(text: string): Fretish['timing'] {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'always') return { kind: 'always' };
  if (/^(immediately|at the same timepoint)$/.test(t)) return { kind: 'immediately' };
  if (/^(initially|at the first timepoint)$/.test(t)) return { kind: 'initially' };
  if (t === 'at the next timepoint') return { kind: 'next' };
  if (/^(finally|at the last timepoint)$/.test(t)) return { kind: 'finally' };
  if (t === 'eventually') return { kind: 'eventually' };
  if (t === 'never') return { kind: 'never' };
  const n = t.match(new RegExp(`^(within|for|after)\\s+(\\d+)${UNIT}$`));
  if (n) return { kind: n[1] as 'within' | 'for' | 'after', n: Number(n[2]) };
  const stop = text.trim().match(/^(until|before)\s+(.+)$/i);
  if (stop) return { kind: stop[1]!.toLowerCase() as 'until' | 'before', stop: parseExpr(stop[2]!) };
  throw new Error(`unknown timing "${text.trim()}"`);
}

export function parseFretish(source: string): Fretish {
  const text = source.trim().replace(/\.$/, '');
  const shall = text.match(/^(.*?)\bshall\b(.*?)\bsatisfy\b(.+)$/i);
  if (!shall) throw new Error('a FRETish requirement reads "… <component> shall [timing] satisfy <response>"');
  const before = shall[1]!.trim().replace(/,\s*$/, '');
  const component = before.match(/(?:\bthe\s+)?([A-Za-z_][\w.]*)$/i)?.[1];
  if (!component) throw new Error('no component before "shall"');
  let head = before.slice(0, before.length - component.length).replace(/\bthe\s*$/i, '').trim().replace(/,\s*$/, '');

  let scope: Fretish['scope'] = null;
  const sc = head.match(/^(not\s+in|in|before|after)\s+([A-Za-z_][\w.]*)(?:\s+mode)?\b\s*,?\s*/i);
  if (sc) {
    scope = { kind: sc[1]!.toLowerCase().replace(/\s+/, '') as ScopeKind, mode: sc[2]! };
    head = head.slice(sc[0].length).trim();
  }

  let condition: Fretish['condition'] = null;
  const cond = head.match(/^(upon|whenever|when|if)\s+(.+?)\s*,?$/i);
  if (cond) {
    condition = {
      kind: cond[1]!.toLowerCase() === 'whenever' ? 'whenever' : 'upon',
      expr: parseExpr(cond[2]!),
      source: cond[2]!,
    };
  } else if (head !== '') {
    throw new Error(`cannot read "${head}" before the component — a scope is "in/before/after M", a condition "upon/whenever C"`);
  }

  return { scope, condition, component, timing: parseTiming(shall[2]!), response: parseExpr(shall[3]!), source };
}

/** The variables a FRETish requirement reads, mode included. */
export function fretVariables(f: Fretish): Set<string> {
  const out = new Set<string>();
  const add = (e: Expr | undefined) => {
    if (!e) return;
    if (e.k === 'var') out.add(e.name);
    else if (e.k === 'not') add(e.e);
    else if (e.k === 'bin' || e.k === 'cmp') { add(e.a); add(e.b); }
  };
  if (f.scope) out.add(f.scope.mode);
  add(f.condition?.expr);
  add(f.timing.stop);
  add(f.response);
  return out;
}

// -----------------------------------------------------------------------------
// Meaning over a finite sequence of steps
// -----------------------------------------------------------------------------

export type Trace = readonly Env[];

/** The stretches of the trace the requirement applies to, inclusive. */
export function scopeIntervals(f: Fretish, trace: Trace): [number, number][] {
  const n = trace.length;
  if (n === 0) return [];
  if (!f.scope) return [[0, n - 1]];
  const inMode = (i: number) => trace[i]![f.scope!.mode] === true;
  const runs = (want: boolean): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && inMode(i) === want;
      if (on && start === -1) start = i;
      if (!on && start !== -1) { out.push([start, i - 1]); start = -1; }
    }
    return out;
  };
  switch (f.scope.kind) {
    case 'in':
      return runs(true);
    case 'notin':
      return runs(false);
    case 'before': {
      // Up to the first time the mode holds; all of it if it never does.
      const first = trace.findIndex((_, i) => inMode(i));
      return first === -1 ? [[0, n - 1]] : first === 0 ? [] : [[0, first - 1]];
    }
    case 'after': {
      // From the end of the first time the mode holds; nothing if it never does.
      const first = runs(true)[0];
      return first && first[1] + 1 <= n - 1 ? [[first[1] + 1, n - 1]] : [];
    }
  }
}

/** The steps an obligation starts at, within one scope interval. */
export function triggers(f: Fretish, trace: Trace, [s, e]: [number, number]): number[] {
  if (!f.condition) return [s];
  const holds = (i: number) => evaluate(f.condition!.expr, trace[i]!);
  const out: number[] = [];
  for (let t = s; t <= e; t++) {
    if (!holds(t)) continue;
    // `upon`: when it becomes true — at the interval's start, holding counts.
    if (f.condition.kind === 'whenever' || t === s || !holds(t - 1)) out.push(t);
  }
  return out;
}

export interface Verdict {
  holds: boolean;
  /** The trigger steps whose obligation was not met. */
  violated: number[];
}

/**
 * Whether a finite trace satisfies the requirement. Windows are inclusive:
 * `within 3` from step t is t..t+3, `for 3` is t..t+3, `after 3` means not
 * before t+3, and at t+3.
 *
 * Choices for a finite trace, pinned against FRET by `spec-tacular fret
 * check` (core/formal/fret.ts):
 * - a `within`/`for`/`after` window that runs past the end of the scope is
 *   judged on the steps there are: `within` fails only if the whole window
 *   was observed without the response. For `within` this is FRET's own
 *   reading: its ft-fin formula for `sw shall within 500 ticks satisfy x` is
 *   `((F[0,500] x) | (F[0,499] LAST))`, inclusive bounds and all, and the
 *   two agree on every trace tried (test/fret.test.ts);
 * - `until C` with C never coming holds the response to the end of scope;
 * - `before C` with C never coming is met.
 */
export function check(f: Fretish, trace: Trace): Verdict {
  const violated: number[] = [];
  const r = (i: number) => evaluate(f.response, trace[i]!);
  const stopAt = (from: number, e: number) => {
    for (let i = from; i <= e; i++) if (evaluate(f.timing.stop!, trace[i]!)) return i;
    return -1;
  };
  const all = (a: number, b: number, p: (i: number) => boolean) => {
    for (let i = a; i <= b; i++) if (!p(i)) return false;
    return true;
  };
  const any = (a: number, b: number, p: (i: number) => boolean) => {
    for (let i = a; i <= b; i++) if (p(i)) return true;
    return false;
  };

  for (const interval of scopeIntervals(f, trace)) {
    const [s, e] = interval;
    for (const t of triggers(f, trace, interval)) {
      const n = f.timing.n ?? 0;
      let ok: boolean;
      switch (f.timing.kind) {
        case 'immediately': ok = r(t); break;
        case 'initially': ok = r(s); break;
        case 'next': ok = t + 1 > e || r(t + 1); break;
        case 'finally': ok = r(e); break;
        case 'eventually': ok = any(t, e, r); break;
        case 'always': ok = all(t, e, r); break;
        case 'never': ok = all(t, e, (i) => !r(i)); break;
        case 'within': ok = any(t, Math.min(t + n, e), r) || t + n > e; break;
        case 'for': ok = all(t, Math.min(t + n, e), r); break;
        case 'after':
          ok = all(t, Math.min(t + n - 1, e), (i) => !r(i)) && (t + n > e || r(t + n));
          break;
        case 'until': {
          const c = stopAt(t, e);
          ok = all(t, c === -1 ? e : c - 1, r);
          break;
        }
        case 'before': {
          const c = stopAt(t, e);
          ok = c === -1 || any(t, c - 1, r);
          break;
        }
      }
      if (!ok) violated.push(t);
    }
  }
  return { holds: violated.length === 0, violated };
}

const TIMING_WORDS: Record<TimingKind, (f: Fretish) => string> = {
  immediately: () => 'at that same step',
  initially: () => 'at the first step of the scope',
  next: () => 'at the very next step',
  finally: () => 'at the last step of the scope',
  eventually: () => 'at some step before the scope ends',
  always: () => 'at every step from then until the scope ends',
  never: () => 'at any step from then until the scope ends',
  within: (f) => `within ${f.timing.n} steps (by step +${f.timing.n} at the latest)`,
  for: (f) => `at every step for the next ${f.timing.n} steps`,
  after: (f) => `not before ${f.timing.n} steps have passed, and then at step +${f.timing.n}`,
  until: (f) => `at every step until ${inWords(f.timing.stop!)}`,
  before: (f) => `at some step before ${inWords(f.timing.stop!)}`,
};

/** The requirement in plain words: what a reviewer checks it says. */
export function fretInWords(f: Fretish): string {
  const scope = !f.scope
    ? ''
    : f.scope.kind === 'in' ? `While in ${f.scope.mode}, `
    : f.scope.kind === 'notin' ? `While not in ${f.scope.mode}, `
    : f.scope.kind === 'before' ? `Until ${f.scope.mode} first holds, `
    : `Once ${f.scope.mode} has held and ended, `;
  const when = !f.condition
    ? 'from the start'
    : f.condition.kind === 'upon' ? `each time ${inWords(f.condition.expr)} becomes true`
    : `at every step where ${inWords(f.condition.expr)}`;
  const must = f.timing.kind === 'never' ? 'must not make' : 'must make';
  return `${scope}${when}, ${f.component} ${must} "${inWords(f.response)}" true ${TIMING_WORDS[f.timing.kind](f)}.`;
}
