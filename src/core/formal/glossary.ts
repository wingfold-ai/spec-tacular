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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
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
