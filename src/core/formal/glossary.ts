/**
 * The glossary: the variables formal requirements are written over.
 *
 * FRET types each variable by its role — a mode, an input the environment
 * sets, an output the component produces, an internal value — and that role
 * later decides which variables a test drives and which it observes
 * (add-test-matrix). Each one also says where its value comes from in the
 * system and who owns it: the seed of a signals catalog, so a requirement
 * whose variables have no source is known to be unmonitorable.
 *
 * Constraints say which combinations cannot happen (`token_valid ->
 * NOT token_expired`), so a truth table can mark those rows impossible rather
 * than demand tests for them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { parseExpr, variablesOf, type Expr } from './expr.ts';

export type Role = 'mode' | 'input' | 'output' | 'internal';
export type DataType = 'bool' | 'int' | 'float' | 'enum';
const ROLES: readonly Role[] = ['mode', 'input', 'output', 'internal'];
const TYPES: readonly DataType[] = ['bool', 'int', 'float', 'enum'];
/**
 * The spellings people (and agents) write for the same types: read as the
 * type they mean, never silently as bool.
 */
const TYPE_ALIASES: Record<string, DataType> = {
  boolean: 'bool',
  integer: 'int',
  number: 'float',
  double: 'float',
  real: 'float',
  enumeration: 'enum',
};

export interface Variable {
  name: string;
  role: Role;
  type: DataType;
  meaning: string;
  values: string[];
  range: [number, number] | null;
  tolerance: number | null;
  /** Where its value comes from in the system. */
  source: string;
  owner: string;
  waysTrue: string[];
  waysFalse: string[];
}

export interface Glossary {
  variables: Map<string, Variable>;
  constraints: { source: string; expr: Expr }[];
  problems: string[];
}

export function glossaryPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'glossary.yaml');
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function readGlossary(raw: unknown): Glossary {
  const problems: string[] = [];
  const doc = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const variables = new Map<string, Variable>();
  const vars = (typeof doc['variables'] === 'object' && doc['variables'] !== null ? doc['variables'] : {}) as Record<string, unknown>;

  for (const [name, value] of Object.entries(vars)) {
    const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const role = String(v['role'] ?? '').toLowerCase();
    const written = String(v['type'] ?? 'bool').toLowerCase().trim();
    const type = TYPE_ALIASES[written] ?? written;
    if (!ROLES.includes(role as Role)) problems.push(`${name}: role must be one of ${ROLES.join(', ')}`);
    if (!TYPES.includes(type as DataType)) problems.push(`${name}: type must be one of ${TYPES.join(', ')}`);
    const values = strings(v['values']);
    if (type === 'enum' && values.length === 0) problems.push(`${name}: an enum lists its values`);
    const range = Array.isArray(v['range']) && v['range'].length === 2 && v['range'].every((x) => typeof x === 'number')
      ? (v['range'] as [number, number])
      : null;
    if (!v['meaning']) problems.push(`${name}: says nothing about what it means`);
    variables.set(name, {
      name,
      role: (ROLES.includes(role as Role) ? role : 'internal') as Role,
      type: (TYPES.includes(type as DataType) ? type : 'bool') as DataType,
      meaning: typeof v['meaning'] === 'string' ? v['meaning'].trim() : '',
      values,
      range,
      tolerance: typeof v['tolerance'] === 'number' ? v['tolerance'] : null,
      source: typeof v['source'] === 'string' ? v['source'].trim() : '',
      owner: typeof v['owner'] === 'string' ? v['owner'].trim() : '',
      waysTrue: strings(v['ways_true']),
      waysFalse: strings(v['ways_false']),
    });
  }

  const constraints: Glossary['constraints'] = [];
  for (const c of strings(doc['constraints'])) {
    try {
      const expr = parseExpr(c);
      const unknown = [...variablesOf(expr)].filter((v) => !variables.has(v) && !isEnumValue(variables, v));
      if (unknown.length > 0) problems.push(`constraint "${c}" names ${unknown.join(', ')}, not in the glossary`);
      constraints.push({ source: c, expr });
    } catch (err) {
      problems.push(`constraint "${c}": ${(err as Error).message}`);
    }
  }
  return { variables, constraints, problems };
}

/** The glossary, or null when the project has none yet. */
export function loadGlossary(projectRoot: string): Glossary | null {
  const path = glossaryPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return readGlossary(parse(readFileSync(path, 'utf8')));
  } catch (err) {
    return { variables: new Map(), constraints: [], problems: [`glossary.yaml is not valid YAML: ${(err as Error).message}`] };
  }
}

export function isEnumValue(variables: Map<string, Variable>, name: string): boolean {
  for (const v of variables.values()) if (v.type === 'enum' && v.values.includes(name)) return true;
  return false;
}

/**
 * One glossary entry a revision adds or replaces, whole — what revising a
 * formal requirement needs when its formula names a variable the glossary
 * does not have, or one whose type or range is wrong.
 */
export interface GlossaryChange {
  name: string;
  role: string;
  type: string;
  meaning: string;
  range?: [number, number];
  values?: string[];
  source?: string;
}

/** What is wrong with the changes, read as the glossary would read them. */
export function glossaryChangeProblems(changes: GlossaryChange[]): string[] {
  const vars = Object.fromEntries(changes.map((c) => [c.name, entryOf(c)]));
  return readGlossary({ variables: vars }).problems;
}

function entryOf(c: GlossaryChange): Record<string, unknown> {
  return {
    role: c.role,
    type: c.type,
    meaning: c.meaning,
    ...(c.range ? { range: c.range } : {}),
    ...(c.values && c.values.length > 0 ? { values: c.values } : {}),
    ...(c.source ? { source: c.source } : {}),
  };
}

/** Reads the changes an agent returned; anything malformed is left out. */
export function parseGlossaryChanges(raw: unknown): GlossaryChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): GlossaryChange[] => {
    if (typeof r !== 'object' || r === null) return [];
    const e = r as Record<string, unknown>;
    const name = typeof e['name'] === 'string' ? e['name'].trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return [];
    const range = Array.isArray(e['range']) && e['range'].length === 2 && e['range'].every((x) => typeof x === 'number')
      ? (e['range'] as [number, number])
      : undefined;
    const values = Array.isArray(e['values']) ? e['values'].filter((v): v is string => typeof v === 'string') : undefined;
    return [{
      name,
      role: String(e['role'] ?? '').trim(),
      type: String(e['type'] ?? '').trim(),
      meaning: String(e['meaning'] ?? '').trim(),
      ...(range ? { range } : {}),
      ...(values && values.length > 0 ? { values } : {}),
      ...(typeof e['source'] === 'string' && e['source'].trim() ? { source: e['source'].trim() } : {}),
    }];
  });
}

/** One change as a reviewer reads it: `+ name (input, int 0–3) — meaning`. */
export function describeGlossaryChange(c: GlossaryChange, existing: Glossary | null): string {
  const kind = [c.type, c.range ? `${c.range[0]}–${c.range[1]}` : '', c.values?.length ? `{${c.values.join(', ')}}` : '']
    .filter(Boolean)
    .join(' ');
  return `${existing?.variables.has(c.name) ? '~' : '+'} ${c.name} (${c.role}, ${kind}) — ${c.meaning}`;
}

/**
 * Writes the changes into glossary.yaml: each entry added or replaced
 * whole, everything else — other entries, constraints, comments — kept.
 */
export function applyGlossaryChanges(projectRoot: string, changes: GlossaryChange[]): void {
  if (changes.length === 0) return;
  const path = glossaryPath(projectRoot);
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument('variables: {}\n');
  if (!doc.has('variables') || doc.get('variables') === null) doc.set('variables', doc.createNode({}));
  for (const c of changes) doc.setIn(['variables', c.name], doc.createNode(entryOf(c)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(doc), 'utf8');
}
