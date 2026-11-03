/**
 * Consequence classes: how much a failure would cost, and so how much rigor
 * a change has to show.
 *
 * Every change used to get the same treatment, and the checks still to come
 * (formal forms, test matrices, mutation runs) would make that ceremony for a
 * settings screen and too little for an authorization gate. Safety-critical
 * engineering classifies first — NASA's software classes, ISO 26262's ASIL —
 * and scales the rigor to the class (docs/proposals/add-consequence-classes.md).
 *
 * The project maps its code to classes in `spec-tacular/classes.yaml`. A
 * change is in the highest class it touches, by its declared boundary and by
 * the files it actually changed: "higher consequence wins". Each class turns
 * rules on; a project may waive one for a class, but only by writing why, and
 * the reason is shown wherever the rule would have applied.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withinBoundary } from './boundary.ts';

/** P0 is the highest consequence, P3 the lowest. */
export type ConsequenceClass = 'P0' | 'P1' | 'P2' | 'P3';
export const CLASSES: readonly ConsequenceClass[] = ['P0', 'P1', 'P2', 'P3'];

export interface ClassArea {
  class: ConsequenceClass;
  paths: string[];
  /** Why this code is in this class: what a failure in it would cost. */
  why: string;
}

export interface Tailoring {
  class: ConsequenceClass;
  rule: RuleId;
  reason: string;
}

export interface ClassMap {
  /** The class of code no area names. Null: such code adds no class. */
  default: ConsequenceClass | null;
  areas: ClassArea[];
  tailoring: Tailoring[];
  /** What in the file could not be read, so it is reported, not ignored. */
  problems: string[];
}

/**
 * The rules a class turns on. Only rules spec-tacular can check today are
 * here; the formal forms, matrices and harness checks of the later proposals
 * add theirs to this table.
 */
export const RULES = {
  'diff-review': {
    classes: ['P0'] as ConsequenceClass[],
    text: 'a person reads and accepts the implementation diff before the change counts as implemented',
  },
  'guard-high-risks': {
    classes: ['P0', 'P1'] as ConsequenceClass[],
    text: 'a high-severity risk cannot be left unmitigated',
  },
} as const;
export type RuleId = keyof typeof RULES;

export function classesPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'classes.yaml');
}

const isClass = (v: unknown): v is ConsequenceClass => CLASSES.includes(v as ConsequenceClass);
const isRule = (v: unknown): v is RuleId => typeof v === 'string' && v in RULES;

/** Lower is higher consequence. */
const rank = (c: ConsequenceClass) => CLASSES.indexOf(c);

export function highest(classes: (ConsequenceClass | null)[]): ConsequenceClass | null {
  return classes.reduce<ConsequenceClass | null>((top, c) => (c && (!top || rank(c) < rank(top)) ? c : top), null);
}

/**
 * Reads the class map. Null when the project has none: then no change has a
 * class and no class rule applies, which is how every project starts.
 */
export function loadClasses(projectRoot: string): ClassMap | null {
  const path = classesPath(projectRoot);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { default: null, areas: [], tailoring: [], problems: [`classes.yaml is not valid YAML: ${(err as Error).message}`] };
  }
  return readClassMap(raw);
}

export function readClassMap(raw: unknown): ClassMap {
  const problems: string[] = [];
  const doc = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const def = doc['default'];
  if (def !== undefined && def !== null && !isClass(def)) problems.push(`default: '${String(def)}' is not one of ${CLASSES.join(', ')}`);

  const areas: ClassArea[] = [];
  const classes = (typeof doc['classes'] === 'object' && doc['classes'] !== null ? doc['classes'] : {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(classes)) {
    if (!isClass(name)) {
      problems.push(`classes: '${name}' is not one of ${CLASSES.join(', ')}`);
      continue;
    }
    const area = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const paths = Array.isArray(area['paths']) ? area['paths'].filter((p): p is string => typeof p === 'string') : [];
    if (paths.length === 0) problems.push(`classes: ${name} names no paths`);
    areas.push({ class: name, paths, why: typeof area['why'] === 'string' ? area['why'].trim() : '' });
  }

  const tailoring: Tailoring[] = [];
  for (const entry of Array.isArray(doc['tailoring']) ? doc['tailoring'] : []) {
    const t = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const reason = typeof t['reason'] === 'string' ? t['reason'].trim() : '';
    if (!isClass(t['class']) || !isRule(t['rule'])) {
      problems.push(`tailoring: needs a class (${CLASSES.join(', ')}) and a rule (${Object.keys(RULES).join(', ')})`);
    } else if (!reason) {
      // A waiver without a reason is exactly what tailoring must not be.
      problems.push(`tailoring: ${t['rule']} for ${t['class']} gives no reason, so it is not applied`);
    } else {
      tailoring.push({ class: t['class'], rule: t['rule'], reason });
    }
  }

  return { default: isClass(def) ? def : null, areas, tailoring, problems };
}

/** The class of one file: the highest area that covers it, else the default. */
export function classOfFile(map: ClassMap, file: string): ConsequenceClass | null {
  const covering = map.areas.filter((a) => withinBoundary(file, a.paths)).map((a) => a.class);
  return covering.length > 0 ? highest(covering) : map.default;
}

/** The part of a pattern before its first wildcard. */
function literalPrefix(pattern: string): string {
  const at = pattern.search(/[*?]/);
  return (at === -1 ? pattern : pattern.slice(0, at)).replace(/^\.\//, '');
}

/**
 * Whether a boundary pattern and an area's pattern can name the same file.
 * Exact for plain paths and directories; for wildcards it compares what
 * precedes them, which errs toward overlapping — toward the higher class.
 */
function overlaps(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return (pa !== '' && withinBoundary(pa, [b])) || (pb !== '' && withinBoundary(pb, [a])) || pa.startsWith(pb) || pb.startsWith(pa);
}

/** The highest class a boundary reaches into, else the default. */
export function classOfBoundary(map: ClassMap, boundary: string[]): ConsequenceClass | null {
  const reached = map.areas.filter((area) => boundary.some((b) => area.paths.some((p) => overlaps(b, p)))).map((a) => a.class);
  return highest([...reached, map.default]);
}

export interface ChangeClass {
  class: ConsequenceClass | null;
  /** The class the boundary declares. */
  declared: ConsequenceClass | null;
  /** Changed files in a higher class than the boundary declared. */
  raisedBy: string[];
  /** Rules that apply to this change. */
  rules: RuleId[];
  /** Rules this class would apply but the project waived, with why. */
  waived: Tailoring[];
}

/**
 * The class of a change. Without a boundary its declared class is the
 * default; once it has changed files, those count too, and any in a higher
 * class are named — the change reached further than it said.
 */
export function classOfChange(map: ClassMap, boundary: string[] | null, changed: string[] | null): ChangeClass {
  const declared = boundary ? classOfBoundary(map, boundary) : map.default;
  const files = (changed ?? []).map((f) => ({ f, c: classOfFile(map, f) }));
  const actual = highest(files.map((x) => x.c));
  const cls = highest([declared, actual]);
  const raisedBy =
    cls && cls !== declared ? files.filter((x) => x.c === cls).map((x) => x.f).sort() : [];
  return { class: cls, declared, raisedBy, ...rulesFor(map, cls) };
}

export function rulesFor(map: ClassMap, cls: ConsequenceClass | null): { rules: RuleId[]; waived: Tailoring[] } {
  if (!cls) return { rules: [], waived: [] };
  const rules: RuleId[] = [];
  const waived: Tailoring[] = [];
  for (const id of Object.keys(RULES) as RuleId[]) {
    if (!RULES[id].classes.includes(cls)) continue;
    const tailored = map.tailoring.find((t) => t.class === cls && t.rule === id);
    if (tailored) waived.push(tailored);
    else rules.push(id);
  }
  return { rules, waived };
}

/** The class map as agents read it: what each class covers, and what it demands. */
export function renderClasses(map: ClassMap): string {
  const out = ['# Consequence classes', '', 'How much a failure would cost, by area of code. A change is in the', 'highest class it touches; its class decides what it must show.', ''];
  for (const area of [...map.areas].sort((a, b) => rank(a.class) - rank(b.class))) {
    out.push(`- ${area.class}: ${area.paths.map((p) => `\`${p}\``).join(', ')}${area.why ? ` — ${area.why}` : ''}`);
  }
  if (map.default) out.push(`- everything else: ${map.default}`);
  out.push('');
  for (const cls of CLASSES) {
    const { rules, waived } = rulesFor(map, cls);
    if (rules.length + waived.length === 0) continue;
    for (const id of rules) out.push(`- ${cls}: ${RULES[id].text}`);
    for (const t of waived) out.push(`- ${cls}: (waived: ${t.reason}) ${RULES[t.rule].text}`);
  }
  return out.join('\n').trimEnd();
}
