/**
 * FRET's future-time metric temporal logic over finite traces (`ft-fin`), as
 * `fretcli formalize -l ft-fin` prints it — and its meaning, so spec-tacular's
 * own reading of FRETish (fretish.ts) can be checked against FRET's.
 *
 *     sw shall within 500 ticks satisfy x   →   ((F[0,500] x) | (F[0,499] LAST))
 *
 * Operators: `X` (next), `F` (eventually), `G` (always), `U` (until), `V` /
 * `R` (release), `F[a,b]` / `G[a,b]` / `U[a,b]` bounded, `LAST` (the last
 * step), the boolean operators of expr.ts, and comparisons. Over a finite
 * trace `X` is strong — false at the last step — and `F`/`G` range over the
 * steps there are: FRET encodes everything else about a trace ending with
 * `LAST` explicitly, which is what makes its finite-trace formulas comparable
 * step by step.
 */

import { evaluate, type CmpOp, type Env, type Expr as BoolExpr } from './expr.ts';

export type Mtl =
  | { k: 'atom'; expr: BoolExpr }
  | { k: 'last' }
  | { k: 'bool'; value: boolean }
  | { k: 'not'; e: Mtl }
  | { k: 'and' | 'or' | 'xor' | 'implies' | 'iff'; a: Mtl; b: Mtl }
  | { k: 'X'; e: Mtl }
  | { k: 'F' | 'G'; e: Mtl; lo: number; hi: number | null }
  | { k: 'U' | 'V'; a: Mtl; b: Mtl; lo: number; hi: number | null };

type Tok = { t: 'id' | 'num' | 'op' | 'lp' | 'rp' | 'bound'; v: string; lo?: number; hi?: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const sp = rest.match(/^\s+/);
    if (sp) { i += sp[0].length; continue; }
    const bound = rest.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
    if (bound) { out.push({ t: 'bound', v: bound[0], lo: Number(bound[1]), hi: Number(bound[2]) }); i += bound[0].length; continue; }
    const op = rest.match(/^(<->|<=>|->|=>|&&|\|\||==|!=|<=|>=|[&|!<>=])/);
    if (op) { out.push({ t: 'op', v: op[1] === '==' ? '=' : op[1]! }); i += op[1]!.length; continue; }
    if (rest[0] === '(') { out.push({ t: 'lp', v: '(' }); i++; continue; }
    if (rest[0] === ')') { out.push({ t: 'rp', v: ')' }); i++; continue; }
    const num = rest.match(/^-?\d+(\.\d+)?/);
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = rest.match(/^[A-Za-z_][\w.]*/);
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new Error(`unexpected '${rest[0]}' in the formula at "${rest.slice(0, 12)}"`);
  }
  return out;
}

const UNARY = new Set(['X', 'F', 'G']);
const BINARY_TEMPORAL = new Set(['U', 'V', 'R']);

export function parseMtl(src: string): Mtl {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (...v: string[]) => peek()?.t === 'op' && v.includes(peek()!.v);
  const isWord = (...v: string[]) => peek()?.t === 'id' && v.includes(peek()!.v);
  const bounds = (): { lo: number; hi: number | null } => {
    if (peek()?.t === 'bound') {
      const b = toks[pos++]!;
      return { lo: b.lo!, hi: b.hi! };
    }
    return { lo: 0, hi: null };
  };

  const atom = (): Mtl => {
    const t = peek();
    if (!t) throw new Error('the formula ends too early');
    if (t.t === 'lp') {
      pos++;
      const e = iff();
      if (peek()?.t !== 'rp') throw new Error('a "(" is not closed');
      pos++;
      return e;
    }
    if (t.t === 'id') {
      pos++;
      const word = t.v;
      if (word === 'LAST') return { k: 'last' };
      if (/^(true|TRUE)$/.test(word)) return { k: 'bool', value: true };
      if (/^(false|FALSE)$/.test(word)) return { k: 'bool', value: false };
      // A comparison is one atom: `voltage > 9`.
      if (isOp('=', '!=', '<', '>', '<=', '>=')) {
        const op = toks[pos++]!.v as CmpOp;
        const rhs = toks[pos++];
        if (!rhs || (rhs.t !== 'num' && rhs.t !== 'id')) throw new Error(`a comparison with ${word} has no right-hand side`);
        const b: BoolExpr = rhs.t === 'num' ? { k: 'lit', value: Number(rhs.v) } : { k: 'var', name: rhs.v };
        return { k: 'atom', expr: { k: 'cmp', op, a: { k: 'var', name: word }, b } };
      }
      return { k: 'atom', expr: { k: 'var', name: word } };
    }
    if (t.t === 'num') {
      pos++;
      return { k: 'atom', expr: { k: 'lit', value: Number(t.v) } };
    }
    throw new Error(`unexpected "${t.v}"`);
  };

  const unary = (): Mtl => {
    if (isOp('!')) { pos++; return { k: 'not', e: unary() }; }
    // `X`, `F`, `G` are operators unless they stand as a variable: followed
    // by a binary operator, a closing parenthesis, or nothing.
    const after = toks[pos + 1];
    const asVariable = !after || after.t === 'rp' || (after.t === 'op' && after.v !== '!');
    if (peek()?.t === 'id' && UNARY.has(peek()!.v) && !asVariable) {
      const op = toks[pos++]!.v;
      if (op === 'X') return { k: 'X', e: unary() };
      const { lo, hi } = bounds();
      return { k: op as 'F' | 'G', e: unary(), lo, hi };
    }
    return atom();
  };
  const left = (next: () => Mtl, ops: string[], k: 'and' | 'or' | 'xor'): (() => Mtl) => () => {
    let a = next();
    while (isOp(...ops) || (k === 'xor' && isWord('xor'))) {
      pos++;
      a = { k, a, b: next() };
    }
    return a;
  };
  const and = left(unary, ['&', '&&'], 'and');
  const xor = left(and, [], 'xor');
  const or = left(xor, ['|', '||'], 'or');
  const temporal = (): Mtl => {
    const a = or();
    if (peek()?.t === 'id' && BINARY_TEMPORAL.has(peek()!.v)) {
      const op = toks[pos++]!.v;
      const { lo, hi } = bounds();
      return { k: op === 'U' ? 'U' : 'V', a, b: temporal(), lo, hi };
    }
    return a;
  };
  const implies = (): Mtl => {
    const a = temporal();
    if (isOp('->', '=>')) { pos++; return { k: 'implies', a, b: implies() }; }
    return a;
  };
  const iff = (): Mtl => {
    let a = implies();
    while (isOp('<->', '<=>')) { pos++; a = { k: 'iff', a, b: implies() }; }
    return a;
  };

  const e = iff();
  if (pos < toks.length) throw new Error(`unexpected "${toks[pos]!.v}" after the formula`);
  return e;
}

/** Whether `f` holds at step `i` of a finite trace. */
export function holdsAt(f: Mtl, trace: readonly Env[], i: number): boolean {
  const n = trace.length;
  const end = (hi: number | null) => (hi === null ? n - 1 : Math.min(i + hi, n - 1));
  switch (f.k) {
    case 'atom': return evaluate(f.expr, trace[i]!);
    case 'last': return i === n - 1;
    case 'bool': return f.value;
    case 'not': return !holdsAt(f.e, trace, i);
    case 'and': return holdsAt(f.a, trace, i) && holdsAt(f.b, trace, i);
    case 'or': return holdsAt(f.a, trace, i) || holdsAt(f.b, trace, i);
    case 'xor': return holdsAt(f.a, trace, i) !== holdsAt(f.b, trace, i);
    case 'implies': return !holdsAt(f.a, trace, i) || holdsAt(f.b, trace, i);
    case 'iff': return holdsAt(f.a, trace, i) === holdsAt(f.b, trace, i);
    case 'X': return i + 1 < n && holdsAt(f.e, trace, i + 1);
    case 'F': {
      for (let j = i + f.lo; j <= end(f.hi); j++) if (holdsAt(f.e, trace, j)) return true;
      return false;
    }
    case 'G': {
      for (let j = i + f.lo; j <= end(f.hi); j++) if (!holdsAt(f.e, trace, j)) return false;
      return true;
    }
    case 'U': {
      for (let j = i; j <= end(f.hi); j++) {
        if (j >= i + f.lo && holdsAt(f.b, trace, j)) return true;
        if (!holdsAt(f.a, trace, j)) return false;
      }
      return false;
    }
    case 'V': {
      // a V b: b holds up to and including the first a, or to the end.
      for (let j = i; j <= end(f.hi); j++) {
        if (j >= i + f.lo && !holdsAt(f.b, trace, j)) return false;
        if (j >= i + f.lo && holdsAt(f.a, trace, j)) return true;
      }
      return true;
    }
  }
}

/** Every variable the formula reads. */
export function mtlVariables(f: Mtl, out = new Set<string>()): Set<string> {
  const expr = (e: BoolExpr) => {
    if (e.k === 'var') out.add(e.name);
    else if (e.k === 'not') expr(e.e);
    else if (e.k === 'bin' || e.k === 'cmp') { expr(e.a); expr(e.b); }
  };
  switch (f.k) {
    case 'atom': expr(f.expr); break;
    case 'not': case 'X': case 'F': case 'G': mtlVariables(f.e, out); break;
    case 'and': case 'or': case 'xor': case 'implies': case 'iff': case 'U': case 'V':
      mtlVariables(f.a, out);
      mtlVariables(f.b, out);
      break;
  }
  return out;
}
