/**
 * The formal form of a requirement, and what is checked about it.
 *
 * Prose can be read two ways, and the review only catches that if the
 * reviewer happens to read it the second way. A formal form answers it once,
 * in a shape a tool can evaluate — and is what tests are derived from, not
 * chosen by whoever writes them (add-test-matrix). It augments the prose; the
 * prose stays what the specs promise, and the two are accepted together.
 *
 * Written in the requirement (or a risk's guard) as a fenced block:
 *
 *     ```formal
 *     decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open
 *     fret: upon archive_requested Archive shall immediately satisfy archive_allowed | refused
 *     asked: Does a deferred task count as open? — No; deferred tasks are excused.
 *     ```
 *
 * Inside the requirement's block, it is part of its hash: changing the formula
 * resets acceptance like changing the words does. `asked:` lines are the
 * questions the formalizing had to answer — the "questions back" that NASA
 * practice counts as the most valuable output of formalizing — and their
 * answers belong in the prose too.
 */

import { buildCodeFenceMask, normalizeContent } from '../markdown.ts';
import { isRequirement, type ReviewItem } from '../requirements.ts';
import {
  conditionKey,
  conditionsOf,
  evaluateConditions,
  inWords,
  parseExpr,
  variablesOf,
  type Expr,
} from './expr.ts';
import { fretInWords, fretVariables, parseFretish, type Fretish } from './fretish.ts';
import { isEnumValue, type Glossary } from './glossary.ts';

export interface Decision {
  output: string;
  expr: Expr;
  source: string;
}

export interface FormalForm {
  decisions: Decision[];
  frets: Fretish[];
  /** The questions formalizing answered, with their answers. */
  asked: string[];
  /** What could not be read at all. */
  syntax: string[];
}

/** More conditions than this in one decision is several behaviours in one. */
export const MAX_CONDITIONS = 6;

/** The `formal` block of an item's text, or null when it has none. */
export function formalOf(item: ReviewItem): FormalForm | null {
  const lines = normalizeContent(item.text).split('\n');
  const mask = buildCodeFenceMask(lines);
  const start = lines.findIndex((l) => /^\s*(```|~~~)\s*formal\s*$/i.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && mask[i]; i++) {
    if (/^\s*(```|~~~)\s*$/.test(lines[i] ?? '')) break;
    body.push(lines[i] ?? '');
  }

  const form: FormalForm = { decisions: [], frets: [], asked: [], syntax: [] };
  for (const raw of body) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(decision|fret|asked):\s*(.+)$/i);
    if (!m) {
      form.syntax.push(`"${line}" is not a decision:, fret: or asked: line`);
      continue;
    }
    const [, kind, rest] = m as unknown as [string, string, string];
    try {
      if (kind.toLowerCase() === 'asked') form.asked.push(rest.trim());
      else if (kind.toLowerCase() === 'fret') form.frets.push(parseFretish(rest));
      else {
        const d = rest.match(/^([A-Za-z_][\w.]*)\s*=(?!=)\s*(.+)$/);
        if (!d) throw new Error('a decision reads "<output> = <condition>"');
        form.decisions.push({ output: d[1]!, expr: parseExpr(d[2]!), source: rest.trim() });
      }
    } catch (err) {
      form.syntax.push(`${kind.toLowerCase()}: ${(err as Error).message}`);
    }
  }
  return form;
}

/** Enum values in an expression become literals, given the glossary. */
export function resolveLiterals(e: Expr, glossary: Glossary | null): Expr {
  const g = glossary?.variables;
  const walk = (x: Expr): Expr => {
    if (x.k === 'var') return g && !g.has(x.name) && isEnumValue(g, x.name) ? { k: 'lit', value: x.name } : x;
    if (x.k === 'not') return { k: 'not', e: walk(x.e) };
    if (x.k === 'bin' || x.k === 'cmp') return { ...x, a: walk(x.a), b: walk(x.b) } as Expr;
    return x;
  };
  return walk(e);
}

function typeProblems(e: Expr, glossary: Glossary): string[] {
  const out: string[] = [];
  const g = glossary.variables;
  const walk = (x: Expr, asBool: boolean) => {
    if (x.k === 'var') {
      const v = g.get(x.name);
      if (v && asBool && v.type !== 'bool') out.push(`${x.name} is ${v.type}, read here as true or false`);
      return;
    }
    if (x.k === 'not') return walk(x.e, true);
    if (x.k === 'bin') {
      walk(x.a, true);
      walk(x.b, true);
      return;
    }
    if (x.k === 'cmp') {
      const [vr, other] = x.a.k === 'var' && g.has(x.a.name) ? [g.get(x.a.name)!, x.b] : x.b.k === 'var' && g.has(x.b.name) ? [g.get(x.b.name)!, x.a] : [null, null];
      if (!vr || !other) return;
      if (vr.type === 'bool') out.push(`${vr.name} is bool, compared with ${other.k === 'lit' ? String(other.value) : 'a value'}`);
      if (vr.type === 'enum' && other.k === 'var' && !g.has(other.name) && !vr.values.includes(other.name)) {
        out.push(`${other.name} is not a value of ${vr.name} (${vr.values.join(', ')})`);
      }
      if (vr.type === 'enum' && x.op !== '=' && x.op !== '!=') out.push(`${vr.name} is an enum, compared with ${x.op}`);
    }
  };
  walk(e, true);
  return out;
}

export interface FormalCheck {
  /** Errors: a form that cannot be trusted as written. They hold up the design. */
  errors: string[];
  /** Advice: too large to test well, or words with no definition. */
  notes: string[];
}

/** What is wrong with a formal form, against the glossary. */
export function checkFormal(form: FormalForm, glossary: Glossary | null): FormalCheck {
  const errors = [...form.syntax];
  const notes: string[] = [];
  const used = new Set<string>();
  for (const d of form.decisions) {
    used.add(d.output);
    for (const v of variablesOf(d.expr)) used.add(v);
  }
  for (const f of form.frets) for (const v of fretVariables(f)) used.add(v);

  if (!glossary) {
    if (used.size > 0) errors.push('there is no glossary yet: its variables are defined in spec-tacular/glossary.yaml');
    return { errors, notes };
  }
  const g = glossary.variables;
  const unknown = [...used].filter((v) => !g.has(v) && !isEnumValue(g, v)).sort();
  if (unknown.length > 0) errors.push(`not in the glossary: ${unknown.join(', ')}`);

  for (const d of form.decisions) {
    const out = g.get(d.output);
    if (out && out.role !== 'output' && out.role !== 'internal') errors.push(`${d.output} is an ${out.role}: a decision defines an output`);
    if (variablesOf(d.expr).has(d.output)) errors.push(`${d.output} is defined in terms of itself`);
    errors.push(...typeProblems(d.expr, glossary));
    const n = conditionsOf(d.expr).size;
    if (n > MAX_CONDITIONS) notes.push(`${n} conditions in one decision: more than ${MAX_CONDITIONS} is usually several behaviours — split it`);
  }
  for (const f of form.frets) {
    if (f.scope) {
      const mode = g.get(f.scope.mode);
      if (mode && mode.role !== 'mode') errors.push(`${f.scope.mode} is used as a mode, but is an ${mode.role}`);
    }
    for (const e of [f.condition?.expr, f.response, f.timing.stop]) if (e) errors.push(...typeProblems(e, glossary));
  }
  return { errors: [...new Set(errors)], notes };
}

/** The formal form in plain words, with what each variable means. */
export function readFormal(form: FormalForm, glossary: Glossary | null): string[] {
  const out: string[] = [];
  for (const d of form.decisions) out.push(`${d.output} is true exactly when ${inWords(d.expr)}.`);
  for (const f of form.frets) out.push(fretInWords(f));
  const names = new Set<string>();
  for (const d of form.decisions) [d.output, ...variablesOf(d.expr)].forEach((v) => names.add(v));
  for (const f of form.frets) fretVariables(f).forEach((v) => names.add(v));
  for (const name of [...names].sort()) {
    const v = glossary?.variables.get(name);
    if (v) out.push(`  ${name} (${v.role}, ${v.type}) — ${v.meaning || 'no meaning given'}`);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Across requirements
// -----------------------------------------------------------------------------

/**
 * Two decisions that define the same output differently: the same kind of
 * contradiction a design agent stops on, found before it is asked to. Both
 * truth tables are compared over the conditions either one reads.
 */
export function decisionConflicts(items: { item: ReviewItem; form: FormalForm }[]): string[] {
  const byOutput = new Map<string, { name: string; d: Decision }[]>();
  for (const { item, form } of items) {
    for (const d of form.decisions) byOutput.set(d.output, [...(byOutput.get(d.output) ?? []), { name: item.name, d }]);
  }
  const out: string[] = [];
  for (const [output, defs] of byOutput) {
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const a = defs[i]!;
        const b = defs[j]!;
        const keys = [...new Set([...conditionsOf(a.d.expr).keys(), ...conditionsOf(b.d.expr).keys()])];
        if (keys.length > 12) continue; // too many to enumerate; the matrix will show it
        for (let mask = 0; mask < 1 << keys.length; mask++) {
          const row = Object.fromEntries(keys.map((k, bit) => [k, (mask & (1 << bit)) !== 0]));
          if (evaluateConditions(a.d.expr, row) !== evaluateConditions(b.d.expr, row)) {
            const when = keys.map((k) => `${k}=${row[k] ? 'T' : 'F'}`).join(', ');
            out.push(`"${a.name}" and "${b.name}" define ${output} differently, e.g. when ${when}`);
            break;
          }
        }
      }
    }
  }
  return out;
}

const VAGUE =
  /\b(promptly|quickly|fast|slow(ly)?|soon|timely|in time|immediately|appropriate(ly)?|reasonabl[ey]|adequate(ly)?|sufficient(ly)?|efficient(ly)?|gracefully|robust(ly)?|user-friendly|intuitive(ly)?|as needed|if possible|where possible|normally|normal|anomal(y|ous)|unusual|etc\.?|and\/or|several|many|large|small|minimal|significant(ly)?)\b/gi;

/**
 * Words a requirement uses without defining them: what formalizing would
 * have to turn into a variable and a threshold ("promptly" — within how
 * long?). Advisory, and only for requirements with no formal form: there the
 * formula answers it.
 */
export function vagueTerms(item: ReviewItem): string[] {
  if (!isRequirement(item) || formalOf(item)) return [];
  const prose = [item.text, ...item.scenarios.flatMap((s) => s.body)].join('\n').replace(/\{\{example:[^}]*\}\}/g, '');
  return [...new Set([...prose.matchAll(VAGUE)].map((m) => m[0].toLowerCase()))];
}

/** What the review shows about an item's formal form, or the words it leaves vague. */
export interface FormalView {
  /** The formula lines as written. */
  source: string[];
  /** The same in plain words, with what each variable means. */
  reading: string[];
  errors: string[];
  notes: string[];
  asked: string[];
  /** For an item without a formal form: undefined words. */
  vague: string[];
  /** The test matrix, one line per row (core/formal/view.ts adds it). */
  matrix?: string[];
}

export function formalView(item: ReviewItem, glossary: Glossary | null): FormalView | null {
  const form = formalOf(item);
  if (!form) {
    const vague = vagueTerms(item);
    return vague.length > 0 ? { source: [], reading: [], errors: [], notes: [], asked: [], vague } : null;
  }
  const { errors, notes } = checkFormal(form, glossary);
  return {
    source: [...form.decisions.map((d) => `decision: ${d.source}`), ...form.frets.map((f) => `fret: ${f.source}`)],
    reading: form.syntax.length > 0 ? [] : readFormal(form, glossary),
    errors,
    notes,
    asked: form.asked,
    vague: [],
  };
}

/** The view as lines, the same on the review screen and in `--print`. */
export function formalLines(view: FormalView): { text: string; tone: 'plain' | 'dim' | 'warn' }[] {
  const out: { text: string; tone: 'plain' | 'dim' | 'warn' }[] = [];
  if (view.reading.length > 0) {
    out.push({ text: '  Reads as:', tone: 'dim' });
    for (const line of view.reading) out.push({ text: `    ${line.trimStart()}`, tone: line.startsWith('  ') ? 'dim' : 'plain' });
  }
  for (const q of view.asked) out.push({ text: `  asked: ${q}`, tone: 'dim' });
  for (const e of view.errors) out.push({ text: `  ! ${e}`, tone: 'warn' });
  for (const n of view.notes) out.push({ text: `  ! ${n}`, tone: 'warn' });
  if (view.vague.length > 0) {
    out.push({ text: `  ! undefined words: ${view.vague.join(', ')} — how much, how soon, compared to what?`, tone: 'warn' });
  }
  for (const line of view.matrix ?? []) {
    out.push({ text: line, tone: line.includes('! ') ? 'warn' : line.includes('×') ? 'dim' : 'plain' });
  }
  return out;
}

export interface ChangeFormal {
  /** Per requirement name: what is wrong with its formal form. */
  errors: { item: string; problems: string[] }[];
  conflicts: string[];
  /** How many of the change's requirements have a formal form. */
  formal: number;
  total: number;
  /** Items whose matrix file is missing or out of date (add-test-matrix). */
  staleMatrices?: string[];
  /** Components whose harness is not shown to reach the code, with why. */
  unconnected?: { component: string; because: string[] }[];
}

/** The formal state of a change's requirements and risks. */
export function changeFormal(items: ReviewItem[], glossary: Glossary | null): ChangeFormal {
  const forms = items.flatMap((item) => {
    const form = formalOf(item);
    return form ? [{ item, form }] : [];
  });
  const errors = forms
    .map(({ item, form }) => ({ item: item.name, problems: checkFormal(form, glossary).errors }))
    .filter((e) => e.problems.length > 0);
  return {
    errors,
    conflicts: decisionConflicts(forms),
    formal: forms.filter((f) => isRequirement(f.item)).length,
    total: items.filter(isRequirement).length,
  };
}

export { conditionKey };
