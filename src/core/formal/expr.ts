/**
 * Boolean expressions: the language of a decision and of FRETish conditions
 * and responses.
 *
 * FRET's operators, written either way: `!`/`NOT`, `&`/`&&`/`AND`,
 * `|`/`||`/`OR`, `XOR`, `->`/`=>`, `<->`/`<=>`, and comparisons `=` `!=` `<`
 * `>` `<=` `>=` against numbers or enum values. A call such as `isValid()` is
 * one atomic condition, as DO-178C counts conditions: its own logic is tested
 * at its own level. And `x` and `NOT x` are one condition, not two.
 */

export type BinOp = 'and' | 'or' | 'xor' | 'implies' | 'iff';
export type CmpOp = '=' | '!=' | '<' | '>' | '<=' | '>=';
export type Value = boolean | number | string;

export type Expr =
  | { k: 'var'; name: string }
  | { k: 'lit'; value: Value }
  | { k: 'not'; e: Expr }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { k: 'cmp'; op: CmpOp; a: Expr; b: Expr };

type Token = { t: 'id' | 'num' | 'op' | 'lp' | 'rp'; v: string };

const WORDS: Record<string, string> = { and: '&', or: '|', not: '!', xor: 'xor' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const space = rest.match(/^\s+/);
    if (space) {
      i += space[0].length;
      continue;
    }
    const op = rest.match(/^(<->|<=>|->|=>|&&|\|\||==|!=|<=|>=|[&|!<>=])/);
    if (op) {
      out.push({ t: 'op', v: op[1] === '==' ? '=' : op[1]! });
      i += op[1]!.length;
      continue;
    }
    if (rest[0] === '(') { out.push({ t: 'lp', v: '(' }); i++; continue; }
    if (rest[0] === ')') { out.push({ t: 'rp', v: ')' }); i++; continue; }
    const num = rest.match(/^-?\d+(\.\d+)?/);
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = rest.match(/^[A-Za-z_][\w.]*(\(\))?/);
    if (id) {
      const word = WORDS[id[0].toLowerCase()];
      out.push(word ? { t: 'op', v: word } : { t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`unexpected '${rest[0]}' at "${rest.slice(0, 12)}"`);
  }
  return out;
}

/**
 * Parses an expression. Precedence, loosest first, as in FRET:
 * `<->`, `->`, `|`, `xor`, `&`, `!`, comparisons.
 */
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => peek()?.t === 'op' && ops.includes(peek()!.v);

  const binary = (next: () => Expr, ops: string[], op: BinOp, rightAssoc = false): (() => Expr) => () => {
    let a = next();
    while (isOp(...ops)) {
      pos++;
      const b = rightAssoc ? binary(next, ops, op, true)() : next();
      a = { k: 'bin', op, a, b };
      if (rightAssoc) break;
    }
    return a;
  };

  const atom = (): Expr => {
    const tok = peek();
    if (!tok) throw new Error('the expression ends too early');
    pos++;
    if (tok.t === 'lp') {
      const e = iff();
      if (peek()?.t !== 'rp') throw new Error('a "(" is not closed');
      pos++;
      return e;
    }
    if (tok.t === 'num') return { k: 'lit', value: Number(tok.v) };
    if (tok.t === 'id') {
      const lower = tok.v.toLowerCase();
      if (lower === 'true' || lower === 'false') return { k: 'lit', value: lower === 'true' };
      return { k: 'var', name: tok.v };
    }
    throw new Error(`unexpected "${tok.v}"`);
  };

  const comparison = (): Expr => {
    const a = atom();
    if (isOp('=', '!=', '<', '>', '<=', '>=')) {
      const op = tokens[pos++]!.v as CmpOp;
      return { k: 'cmp', op, a, b: atom() };
    }
    return a;
  };
  const negation = (): Expr => {
    if (isOp('!')) {
      pos++;
      return { k: 'not', e: negation() };
    }
    return comparison();
  };
  const and = binary(negation, ['&', '&&'], 'and');
  const xor = binary(and, ['xor'], 'xor');
  const or = binary(xor, ['|', '||'], 'or');
  const implies = binary(or, ['->', '=>'], 'implies', true);
  const iff: () => Expr = binary(implies, ['<->', '<=>'], 'iff');

  const e = iff();
  if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos]!.v}" after the expression`);
  return e;
}

/** Every variable the expression reads. */
export function variablesOf(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === 'var') out.add(e.name);
  else if (e.k === 'not') variablesOf(e.e, out);
  else if (e.k === 'bin' || e.k === 'cmp') {
    variablesOf(e.a, out);
    variablesOf(e.b, out);
  }
  return out;
}

const key = (e: Expr): string =>
  e.k === 'var' ? e.name : e.k === 'lit' ? String(e.value) : e.k === 'cmp' ? `${key(e.a)} ${e.op} ${key(e.b)}` : '?';

/**
 * The atomic conditions of a decision, as MC/DC counts them: each variable
 * read as a boolean, and each comparison, once — negation is not a
 * condition of its own.
 */
export function conditionsOf(e: Expr, out = new Map<string, Expr>()): Map<string, Expr> {
  if (e.k === 'var' || e.k === 'cmp') out.set(key(e), e);
  else if (e.k === 'not') conditionsOf(e.e, out);
  else if (e.k === 'bin') {
    conditionsOf(e.a, out);
    conditionsOf(e.b, out);
  }
  return out;
}

export type Env = Readonly<Record<string, Value | undefined>>;

function value(e: Expr, env: Env): Value {
  if (e.k === 'lit') return e.value;
  if (e.k === 'var') return env[e.name] ?? false;
  return evaluate(e, env);
}

export function evaluate(e: Expr, env: Env): boolean {
  switch (e.k) {
    case 'lit':
      return e.value === true;
    case 'var':
      return env[e.name] === true;
    case 'not':
      return !evaluate(e.e, env);
    case 'bin': {
      const a = evaluate(e.a, env);
      const b = evaluate(e.b, env);
      return e.op === 'and' ? a && b : e.op === 'or' ? a || b : e.op === 'xor' ? a !== b : e.op === 'implies' ? !a || b : a === b;
    }
    case 'cmp': {
      const a = value(e.a, env);
      const b = value(e.b, env);
      switch (e.op) {
        case '=': return a === b;
        case '!=': return a !== b;
        case '<': return Number(a) < Number(b);
        case '>': return Number(a) > Number(b);
        case '<=': return Number(a) <= Number(b);
        case '>=': return Number(a) >= Number(b);
      }
    }
  }
}

/**
 * Evaluates with the atomic conditions given directly, by their key — how a
 * truth table is enumerated, comparisons included, without inventing values
 * that would make each comparison true or false.
 */
export function evaluateConditions(e: Expr, conditions: Readonly<Record<string, boolean>>): boolean {
  switch (e.k) {
    case 'lit':
      return e.value === true;
    case 'var':
    case 'cmp':
      return conditions[key(e)] === true;
    case 'not':
      return !evaluateConditions(e.e, conditions);
    case 'bin': {
      const a = evaluateConditions(e.a, conditions);
      const b = evaluateConditions(e.b, conditions);
      return e.op === 'and' ? a && b : e.op === 'or' ? a || b : e.op === 'xor' ? a !== b : e.op === 'implies' ? !a || b : a === b;
    }
  }
}

export const conditionKey = key;

const CMP_WORDS: Record<CmpOp, string> = {
  '=': 'is', '!=': 'is not', '<': 'is less than', '>': 'is greater than', '<=': 'is at most', '>=': 'is at least',
};

/** The expression in plain words, so a reviewer can check what it says. */
export function inWords(e: Expr, top = true): string {
  switch (e.k) {
    case 'lit':
      return String(e.value);
    case 'var':
      return e.name;
    case 'cmp':
      return `${inWords(e.a, false)} ${CMP_WORDS[e.op]} ${inWords(e.b, false)}`;
    case 'not':
      return e.e.k === 'var' ? `not ${e.e.name}` : e.e.k === 'cmp' ? `not (${inWords(e.e, false)})` : `not (${inWords(e.e, false)})`;
    case 'bin': {
      const wrap = (x: Expr) => (x.k === 'bin' && x.op !== e.op ? `(${inWords(x, false)})` : inWords(x, false));
      const text =
        e.op === 'and' ? `${wrap(e.a)} and ${wrap(e.b)}`
        : e.op === 'or' ? `${wrap(e.a)} or ${wrap(e.b)}`
        : e.op === 'xor' ? `either ${wrap(e.a)} or ${wrap(e.b)}, not both`
        : e.op === 'implies' ? `if ${wrap(e.a)} then ${wrap(e.b)}`
        : `${wrap(e.a)} exactly when ${wrap(e.b)}`;
      return top ? text : text;
    }
  }
}
