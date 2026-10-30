/**
 * Whether the matrix tests the real code.
 *
 * The matrix says what should happen; the harness decides whether a test
 * checks the system. It sets each input and reads each output, and it is the
 * one part written by hand. The matrix catches some harness mistakes itself —
 * an input with no effect breaks its MC/DC pair, an output that never changes
 * breaks a row expecting the other — but not the ones that pass every row
 * while the code is wrong: a harness that computes the answer itself, one
 * that reads a sibling code path, one whose drive moves two inputs at once
 * (docs/proposals/add-harness-assurance.md).
 *
 * FRET's answer is to bind variables declaratively and prove rather than
 * test; where its tests reach code, NASA relies on coverage of the real code
 * and independent review. Here, in that order:
 *
 * - a **mapping** (`<component>.mapping.yaml`) binds each variable to an
 *   export or a field — data, so it cannot compute an answer; hand-written
 *   harness code is the fallback, held to static rules;
 * - the runner reads every input back after each drive (`probe`);
 * - the **check** runs the matrix tests with coverage — the production code
 *   the harness names must be executed — and with mutants: small changes to
 *   that code, each of which a row must catch, run in a scratch copy of the
 *   project so the real source is never touched;
 * - each mapped variable is **reviewed**, one item each: is this what the
 *   word means?
 *
 * A component whose harness has not passed all of it is *not connected*, and
 * its matrix rows do not count as evidence.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { hashBlock, type ReviewItem } from '../requirements.ts';
import { matrixConfig, type MatrixConfig } from './config.ts';
import type { Glossary } from './glossary.ts';
import type { Matrix } from './matrix.ts';

const sha = (s: string | Buffer) => `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 32)}`;

// -----------------------------------------------------------------------------
// Mappings
// -----------------------------------------------------------------------------

export interface MappingFile {
  /** The production module it binds to, relative to the project. */
  module: string;
  create?: string;
  tick?: string;
  inputs: Record<string, Record<string, string>>;
  outputs: Record<string, Record<string, string>>;
  /** Line of each variable in the file, for the editor and the review. */
  lines: Record<string, number>;
  text: string;
}

export const mappingPath = (config: MatrixConfig, component: string) => join(config.harness, `${component}.mapping.yaml`);
export const codePath = (config: MatrixConfig, component: string) => join(config.harness, `${component}.ts`);

const INPUT_KINDS = ['arg', 'set', 'call', 'on_rise', 'on_fall', 'probe'];
const OUTPUT_KINDS = ['call', 'read', 'field'];

export function loadMapping(projectRoot: string, path: string): { mapping: MappingFile | null; problems: string[] } {
  const file = join(projectRoot, path);
  if (!existsSync(file)) return { mapping: null, problems: [] };
  let raw: Record<string, unknown>;
  const text = readFileSync(file, 'utf8');
  try {
    raw = (parse(text) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { mapping: null, problems: [`${path} is not valid YAML: ${(err as Error).message}`] };
  }
  const problems: string[] = [];
  const obj = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, Record<string, string>>) : {});
  const mapping: MappingFile = {
    module: typeof raw['module'] === 'string' ? raw['module'] : '',
    ...(typeof raw['create'] === 'string' ? { create: raw['create'] } : {}),
    ...(typeof raw['tick'] === 'string' ? { tick: raw['tick'] } : {}),
    inputs: obj(raw['inputs']),
    outputs: obj(raw['outputs']),
    lines: {},
    text,
  };
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s{2,}([A-Za-z_][\w.]*)\s*:/);
    if (m?.[1] && (m[1] in mapping.inputs || m[1] in mapping.outputs) && !(m[1] in mapping.lines)) mapping.lines[m[1]] = i + 1;
  });
  if (!mapping.module) problems.push(`${path} names no module`);
  else if (!existsSync(join(projectRoot, mapping.module))) problems.push(`${path}: module ${mapping.module} does not exist`);
  else if (/(^|\/)(test|tests|spec|__tests__)\//.test(mapping.module)) problems.push(`${path}: module ${mapping.module} is test code, not the code under test`);
  for (const [name, m] of Object.entries(mapping.inputs)) {
    if (!Object.keys(m ?? {}).some((k) => INPUT_KINDS.includes(k))) problems.push(`${path}: input ${name} says neither arg, set, call, on_rise nor on_fall`);
  }
  for (const [name, m] of Object.entries(mapping.outputs)) {
    if (!m?.['call'] && !m?.['read']) problems.push(`${path}: output ${name} says neither call nor read`);
    for (const k of Object.keys(m ?? {})) if (!OUTPUT_KINDS.includes(k)) problems.push(`${path}: output ${name}: unknown key ${k}`);
  }
  return { mapping, problems };
}

/** The mapping as the runner's `harnessFromMapping` takes it. */
export function compiledMapping(m: MappingFile): object {
  return {
    ...(m.create ? { create: m.create } : {}),
    ...(m.tick ? { tick: m.tick } : {}),
    inputs: m.inputs,
    outputs: m.outputs,
  };
}

// -----------------------------------------------------------------------------
// Static rules on harness code
// -----------------------------------------------------------------------------

/** Relative import specifiers of a source file. */
function importsOf(text: string): { spec: string; typeOnly: boolean }[] {
  return [...text.matchAll(/import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => ({ spec: m[2]!, typeOnly: Boolean(m[1]) }));
}

function resolveImport(projectRoot: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(projectRoot, dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(projectRoot, candidate);
  }
  return null;
}

/**
 * Test code, never the code under test: test directories, test files, and
 * test doubles — wherever a project keeps them (`src/test-support/`, a
 * `fakes/` folder). Mutating a fake shows nothing about the system.
 */
const isTestPath = (p: string, config: MatrixConfig) =>
  /(^|\/)(test|tests|spec|specs|__tests__|__mocks__|test-?support|testing|fixtures|fakes?|mocks?|stubs?)\//i.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)(fake|mock|stub|in-?memory)[-_.][^/]*$/i.test(p) ||
  p.startsWith(normalize(config.harness)) ||
  p.startsWith(normalize(config.tests)) ||
  p === normalize(config.runner) ||
  config.exclude.some((x) => p === normalize(x) || p.startsWith(`${normalize(x).replace(/\/$/, '')}/`));

export interface HarnessCode {
  path: string;
  text: string;
  /** Production files it imports — the code under test. */
  production: string[];
  problems: string[];
}

/**
 * Hand-written harness code, held to what a mapping guarantees by
 * construction: it reaches production code, it does not read the matrix —
 * whose expected values would let it answer for the system — and it does not
 * reach into the runner beyond its types.
 */
export function checkHarnessCode(projectRoot: string, path: string, config: MatrixConfig): HarnessCode | null {
  const file = join(projectRoot, path);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const problems: string[] = [];
  const production: string[] = [];
  for (const imp of importsOf(text)) {
    const target = resolveImport(projectRoot, path, imp.spec);
    if (imp.spec.includes('spec-tacular/matrix') || imp.spec.endsWith('.json')) {
      problems.push(`${path} imports ${imp.spec}: a harness never reads the matrix or its expected values`);
    }
    if (target && target === normalize(config.runner) && !imp.typeOnly) {
      problems.push(`${path} imports the runner's code: a harness only implements its interface (import type)`);
    }
    if (target && !isTestPath(target, config) && !imp.typeOnly) production.push(target);
  }
  if (/spec-tacular\/matrix|readFileSync\([^)]*\.json/.test(text)) {
    problems.push(`${path} reads a matrix file: a harness never sees the expected values`);
  }
  if (production.length === 0) problems.push(`${path} imports no production code: it cannot be testing the system`);
  return { path, text, production: [...new Set(production)], problems: [...new Set(problems)] };
}

// -----------------------------------------------------------------------------
// The harness of a component
// -----------------------------------------------------------------------------

export interface ComponentHarness {
  component: string;
  kind: 'mapping' | 'code' | 'missing';
  path: string | null;
  /** The production files the matrix must reach. */
  production: string[];
  problems: string[];
  /** Hash of the harness itself, to tell when a check or a review is stale. */
  hash: string | null;
  mapping?: MappingFile;
}

export function componentHarness(projectRoot: string, component: string, config = matrixConfig(projectRoot)): ComponentHarness {
  const mPath = mappingPath(config, component);
  const { mapping, problems } = loadMapping(projectRoot, mPath);
  if (mapping || problems.length > 0) {
    return {
      component,
      kind: 'mapping',
      path: mPath,
      production: mapping?.module ? [normalize(mapping.module)] : [],
      problems,
      hash: mapping ? sha(mapping.text) : null,
      ...(mapping ? { mapping } : {}),
    };
  }
  const code = checkHarnessCode(projectRoot, codePath(config, component), config);
  if (code) {
    return { component, kind: 'code', path: code.path, production: code.production, problems: code.problems, hash: sha(code.text) };
  }
  return { component, kind: 'missing', path: null, production: [], problems: [`no harness for ${component} yet`], hash: null };
}

/** A mapping must bind every variable its matrices drive or read. */
export function unmappedVariables(h: ComponentHarness, matrices: Matrix[]): string[] {
  if (h.kind !== 'mapping' || !h.mapping) return [];
  const missing: string[] = [];
  for (const m of matrices) {
    for (const v of Object.keys(m.inputs)) if (!h.mapping.inputs[v] && !missing.includes(v)) missing.push(v);
    for (const v of Object.keys(m.outputs)) if (!h.mapping.outputs[v] && !missing.includes(v)) missing.push(v);
  }
  return missing;
}

// -----------------------------------------------------------------------------
// Review: one item per mapped variable
// -----------------------------------------------------------------------------

/**
 * What a person reviews of a harness: for a mapping, each variable — its
 * meaning beside how it is set or read; for code, the file as a whole. Is
 * this what the word means? An edit sends it back to pending, like any item.
 */
export function harnessItems(projectRoot: string, h: ComponentHarness, glossary: Glossary | null): ReviewItem[] {
  if (!h.path || !h.hash) return [];
  const capability = `harness/${h.component}`;
  const file = join(projectRoot, h.path);
  if (h.kind === 'code') {
    const text = readFileSync(file, 'utf8');
    return [{ id: `${capability}#harness`, capability, name: `harness code for ${h.component}`, text, file, line: 1, hash: hashBlock(text) }];
  }
  const m = h.mapping!;
  const items: ReviewItem[] = [];
  const describe = (role: 'input' | 'output', name: string, binding: Record<string, string>) => {
    const meaning = glossary?.variables.get(name)?.meaning ?? '(not in the glossary)';
    const how = Object.entries(binding).map(([k, v]) => `${k} ${v}`).join(', ');
    return [
      `Means: ${meaning}`,
      `${role === 'input' ? 'Set by' : 'Read by'}: ${how} — in ${m.module}${m.create ? `, on a new ${m.create}` : ''}`,
    ].join('\n');
  };
  for (const [name, binding] of Object.entries(m.inputs)) {
    const text = describe('input', name, binding);
    items.push({ id: `${capability}#${name}`, capability, name, text, file, line: m.lines[name] ?? 1, hash: hashBlock(text) });
  }
  for (const [name, binding] of Object.entries(m.outputs)) {
    const text = describe('output', name, binding);
    items.push({ id: `${capability}#${name}`, capability, name, text, file, line: m.lines[name] ?? 1, hash: hashBlock(text) });
  }
  return items;
}

export const isHarnessItem = (item: ReviewItem) => item.capability.startsWith('harness/');

// -----------------------------------------------------------------------------
// The check: coverage and mutants
// -----------------------------------------------------------------------------

/** Lines and functions hit per file, from an lcov report. */
export interface LcovFile {
  lines: number;
  functions: number;
  fnFound: number;
  /** The lines that ran at least once. */
  hit: Set<number>;
}

export function parseLcov(text: string, projectRoot: string): Map<string, LcovFile> {
  const out = new Map<string, LcovFile>();
  let file: string | null = null;
  let cur: LcovFile = { lines: 0, functions: 0, fnFound: 0, hit: new Set() };
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const p = line.slice(3).trim();
      file = normalize(isAbsolute(p) ? relative(projectRoot, p) : p);
      cur = { lines: 0, functions: 0, fnFound: 0, hit: new Set() };
    } else if (line.startsWith('DA:')) {
      const [n, count] = line.slice(3).split(',');
      if (Number(count) > 0) cur.hit.add(Number(n));
    } else if (line.startsWith('LH:')) cur.lines = Number(line.slice(3));
    else if (line.startsWith('FNH:')) cur.functions = Number(line.slice(4));
    else if (line.startsWith('FNF:')) cur.fnFound = Number(line.slice(4));
    else if (line.startsWith('end_of_record') && file) {
      out.set(file, cur);
      file = null;
    }
  }
  return out;
}

export interface Mutant {
  file: string;
  line: number;
  /** Where on the line the operator starts. */
  column: number;
  from: string;
  to: string;
}

/** Operators to swap, each meaningful to a decision. Spaced, so generics and arrows are left alone. */
const OPERATORS: [RegExp, string][] = [
  [/ && /, ' || '],
  [/ \|\| /, ' && '],
  [/ === /, ' !== '],
  [/ !== /, ' === '],
  [/ >= /, ' > '],
  [/ <= /, ' < '],
  [/ > /, ' >= '],
  [/ < /, ' <= '],
  [/!(?=[A-Za-z_(])/, ''],
  [/\btrue\b/, 'false'],
  [/\bfalse\b/, 'true'],
];

/**
 * Small changes to the code under test, spread over its lines. Each changes
 * one operator once: a condition dropped, an operator swapped, a comparison
 * shifted by its edge. Comments, imports and type-only lines are skipped.
 */
export function mutantsOf(file: string, text: string, max: number, executed?: Set<number>): Mutant[] {
  const all: Mutant[] = [];
  text.split('\n').forEach((line, i) => {
    // A line the matrix never runs survives any change: no news in that.
    if (executed && !executed.has(i + 1)) return;
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ') || /^(export\s+)?(type|interface)\b/.test(t)) return;
    const code = line.replace(/(['"`]).*?\1/g, (s) => ' '.repeat(s.length)).replace(/\/\/.*$/, '');
    // Every occurrence: `a && b && !c` is three conditions, each a mutant.
    for (const [re, to] of OPERATORS) {
      for (const m of code.matchAll(new RegExp(re.source, 'g'))) {
        all.push({ file, line: i + 1, column: m.index!, from: m[0], to });
      }
    }
  });
  if (all.length <= max) return all;
  // Spread over the file rather than the first few lines.
  return Array.from({ length: max }, (_, k) => all[Math.floor((k * all.length) / max)]!);
}

export function applyMutant(text: string, m: Mutant): string {
  const lines = text.split('\n');
  const line = lines[m.line - 1]!;
  lines[m.line - 1] = line.slice(0, m.column) + m.to + line.slice(m.column + m.from.length);
  return lines.join('\n');
}

/** A scratch copy of the project: its files, with node_modules linked, never the real tree. */
function scratchCopy(projectRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-tacular-mutants-'));
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: projectRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    files = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(projectRoot, rel))) {
        if (e === 'node_modules' || e === '.git') continue;
        const p = join(rel, e);
        if (statSync(join(projectRoot, p)).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('');
  }
  for (const f of files) {
    const src = join(projectRoot, f);
    if (!existsSync(src) || statSync(src).isDirectory()) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(src, join(dir, f));
  }
  if (existsSync(join(projectRoot, 'node_modules'))) symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

function runTests(cwd: string, command: string, tests: string[]): { ok: boolean; output: string } {
  const r = spawnSync('sh', ['-c', command.replace('{tests}', tests.map((t) => `'${t}'`).join(' '))], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface HarnessCheck {
  component: string;
  at: string;
  /** What it was run against, so a change to either makes it stale. */
  harnessHash: string;
  production: Record<string, string>;
  /** The matrix tests pass on the code as it is. */
  green: boolean;
  /** Production files the matrix tests did not execute. */
  unexecuted: string[];
  mutants: number;
  killed: number;
  survivors: Mutant[];
  /** Per file mutated: how many changes it got, and how many some row caught. */
  perFile?: Record<string, { mutants: number; killed: number }>;
  /**
   * Per matrix test file, whether it alone catches at least one of the
   * mutants the matrix catches. A file that catches none is passing however
   * the code behaves: its harness answers for the code, or reads nothing.
   */
  killers?: Record<string, boolean>;
  problems: string[];
  passed: boolean;
}

/** Surviving mutants the developer allowed, with why: the code is free to differ there. */
export interface AllowedSurvivors {
  component: string;
  at: string;
  reason: string;
  /** The survivors allowed, `file:line from → to`: different ones are not. */
  survivors: string[];
}

const survivorKey = (m: Mutant) => `${m.file}:${m.line} ${m.from.trim()} → ${m.to.trim()}`;

function allowedPath(projectRoot: string, component: string): string {
  return join(projectRoot, '.spec-tacular', 'harness', `${component}.allowed.json`);
}

export function loadAllowed(projectRoot: string, component: string): AllowedSurvivors | null {
  try {
    return JSON.parse(readFileSync(allowedPath(projectRoot, component), 'utf8')) as AllowedSurvivors;
  } catch {
    return null;
  }
}

/** Allows the survivors of the component's last check; null when there are none. */
export function allowSurvivors(projectRoot: string, component: string, reason: string): AllowedSurvivors | null {
  const check = loadCheck(projectRoot, component);
  if (!check || check.survivors.length === 0) return null;
  // Nothing caught is not code free to differ: the matrix does not reach it.
  if (check.killed === 0) throw new Error(`${component}'s matrix caught none of ${check.mutants} changes to the code — its harness does not reach it, which is not allowed away`);
  const allowed: AllowedSurvivors = {
    component,
    at: new Date().toISOString(),
    reason,
    survivors: check.survivors.map(survivorKey),
  };
  mkdirSync(dirname(allowedPath(projectRoot, component)), { recursive: true });
  writeFileSync(allowedPath(projectRoot, component), `${JSON.stringify(allowed, null, 2)}\n`, 'utf8');
  return allowed;
}

/** The survivors of a check nobody allowed. */
export function unallowedSurvivors(projectRoot: string, check: HarnessCheck): Mutant[] {
  const allowed = new Set(loadAllowed(projectRoot, check.component)?.survivors ?? []);
  return check.survivors.filter((m) => !allowed.has(survivorKey(m)));
}

export function checkPath(projectRoot: string, component: string): string {
  return join(projectRoot, '.spec-tacular', 'harness', `${component}.json`);
}

export function loadCheck(projectRoot: string, component: string): HarnessCheck | null {
  try {
    return JSON.parse(readFileSync(checkPath(projectRoot, component), 'utf8')) as HarnessCheck;
  } catch {
    return null;
  }
}

function productionHashes(projectRoot: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f, existsSync(join(projectRoot, f)) ? sha(readFileSync(join(projectRoot, f))) : 'missing']));
}

/**
 * Runs the check for one component: its matrix tests green, the production
 * code they name executed, and every mutant of it caught by some row.
 * Mutants run in a scratch copy; the real tree is never written.
 */
export function runHarnessCheck(projectRoot: string, h: ComponentHarness, tests: string[], config = matrixConfig(projectRoot)): HarnessCheck {
  const base = {
    component: h.component,
    at: new Date().toISOString(),
    harnessHash: h.hash ?? '',
    production: productionHashes(projectRoot, h.production),
  };
  const problems = [...h.problems];
  const fail = (why: string): HarnessCheck => ({ ...base, green: false, unexecuted: [], mutants: 0, killed: 0, survivors: [], problems: [...problems, why], passed: false });
  if (h.kind === 'missing' || h.production.length === 0) return fail('no production code to check against');
  if (tests.length === 0) return fail('no matrix tests for this component — run `spec-tacular matrix --write`');

  // Coverage: the matrix must execute the code it claims to test.
  const covered = runTests(projectRoot, config.coverage, tests);
  if (!covered.ok) return fail(`the matrix tests fail on the code as it is:\n${covered.output.split('\n').slice(-12).join('\n')}`);
  let unexecuted: string[] = [];
  let lcov: Map<string, LcovFile> | null = null;
  const lcovFile = join(projectRoot, config.lcov);
  if (existsSync(lcovFile)) {
    lcov = parseLcov(readFileSync(lcovFile, 'utf8'), projectRoot);
    unexecuted = h.production.filter((f) => {
      const c = lcov!.get(normalize(f));
      return !c || (c.fnFound > 0 ? c.functions === 0 : c.lines === 0);
    });
  } else {
    problems.push(`no coverage report at ${config.lcov} — set matrix.coverage and matrix.lcov in verification.yaml`);
  }

  // What is mutated is the code the matrix runs, not only what the harness
  // imports: the decision logic is usually a layer further in.
  const targets = codeUnderTest(projectRoot, h, lcov, config);
  base.production = productionHashes(projectRoot, targets);
  const mutants = spreadMutants(projectRoot, targets, lcov, config.mutants);
  const survivors: Mutant[] = [];
  const killers: Record<string, boolean> = {};
  if (mutants.length > 0) {
    const copy = scratchCopy(projectRoot);
    const withMutant = (m: Mutant, run: () => boolean): boolean => {
      const file = join(copy, m.file);
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, applyMutant(original, m), 'utf8');
      try {
        return run();
      } finally {
        writeFileSync(file, original, 'utf8');
      }
    };
    try {
      for (const m of mutants) {
        if (withMutant(m, () => runTests(copy, config.run, tests).ok)) survivors.push(m);
      }
      // Which file catches what: each matrix's own tests must catch some
      // change, or its results say nothing about the code.
      const caught = mutants.filter((m) => !survivors.includes(m));
      if (tests.length > 1) {
        for (const t of tests) killers[t] = caught.some((m) => withMutant(m, () => !runTests(copy, config.run, [t]).ok));
      } else if (tests.length === 1) killers[tests[0]!] = caught.length > 0;
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  const killed = mutants.length - survivors.length;
  const score = mutants.length === 0 ? 1 : killed / mutants.length;
  if (mutants.length === 0) problems.push('no mutable operators in the code under test — nothing to show the matrix reaches it');
  const perFile: Record<string, { mutants: number; killed: number }> = {};
  for (const m of mutants) {
    const f = (perFile[m.file] ??= { mutants: 0, killed: 0 });
    f.mutants++;
    if (!survivors.includes(m)) f.killed++;
  }
  const passed = problems.length === 0 && unexecuted.length === 0 && score >= config.mutationThreshold;
  return { ...base, green: true, unexecuted, mutants: mutants.length, killed, survivors, perFile, killers, problems, passed };
}

const SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * The production files the matrix tests run — every non-test source file
 * the coverage report shows executed, besides what the harness names —
 * or, without a report, what the harness names alone.
 */
export function codeUnderTest(projectRoot: string, h: ComponentHarness, lcov: Map<string, LcovFile> | null, config: MatrixConfig): string[] {
  const out = new Set(h.production.map((f) => normalize(f)));
  for (const [file, c] of lcov ?? []) {
    if (c.hit.size === 0 && c.lines === 0) continue;
    if (!SOURCE.test(file) || file.startsWith('..') || isAbsolute(file) || /(^|\/)node_modules\//.test(file)) continue;
    if (isTestPath(file, config) || !existsSync(join(projectRoot, file))) continue;
    out.add(file);
  }
  return [...out].sort();
}

/**
 * At most `max` mutants over the files, the decision-dense ones first and
 * every file its share: one file with many operators must not use up the
 * budget before the domain is reached. Only executed lines, where known.
 */
export function spreadMutants(projectRoot: string, files: string[], lcov: Map<string, LcovFile> | null, max: number): Mutant[] {
  const pools = files
    .map((f) => {
      const hit = lcov?.get(normalize(f))?.hit;
      return mutantsOf(f, readFileSync(join(projectRoot, f), 'utf8'), Number.MAX_SAFE_INTEGER, hit && hit.size > 0 ? hit : undefined);
    })
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  // Every file a share; what a small one cannot use goes to the others.
  const quota = pools.map(() => 0);
  for (let left = max; left > 0 && quota.some((q, i) => q < pools[i]!.length); ) {
    for (let i = 0; i < pools.length && left > 0; i++) {
      if (quota[i]! < pools[i]!.length) {
        quota[i]!++;
        left--;
      }
    }
  }
  // Spread over each file rather than its first few lines.
  const out: Mutant[] = [];
  pools.forEach((pool, i) => {
    for (let k = 0; k < quota[i]!; k++) out.push(pool[Math.floor((k * pool.length) / quota[i]!)]!);
  });
  return out;
}

export function saveCheck(projectRoot: string, check: HarnessCheck): void {
  const path = checkPath(projectRoot, check.component);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(check, null, 2)}\n`, 'utf8');
}

// -----------------------------------------------------------------------------
// Connected or not
// -----------------------------------------------------------------------------

export interface Connection {
  component: string;
  connected: boolean;
  /** Why not, in words. Empty when connected. */
  because: string[];
}

/**
 * Whether a component's matrix results can be trusted: its harness exists
 * and keeps the rules, binds every variable, has been reviewed, and passed
 * its check against the harness and the code as they are now.
 */
export function connection(
  projectRoot: string,
  h: ComponentHarness,
  matrices: Matrix[],
  reviewed: { accepted: boolean }[],
  /**
   * The test files of the one item asked about: then its own tests must
   * catch a change to the code, and a mutant no matrix catches is the
   * component's finding, not this item's.
   */
  tests?: string[],
  config = matrixConfig(projectRoot),
): Connection {
  const because = [...h.problems];
  const unmapped = unmappedVariables(h, matrices);
  if (unmapped.length > 0) because.push(`the mapping does not bind ${unmapped.join(', ')}`);
  if (h.kind !== 'missing' && (reviewed.length === 0 || reviewed.some((r) => !r.accepted))) {
    because.push(
      h.kind === 'mapping'
        ? 'its mapping has not been reviewed — is each variable bound to what the word means?'
        : 'its harness code has not been reviewed — does it set and read what each word means?',
    );
  }
  const check = loadCheck(projectRoot, h.component);
  if (h.kind !== 'missing') {
    if (!check) because.push(`no harness check yet — run \`spec-tacular harness --check\``);
    else {
      const stale =
        check.harnessHash !== h.hash ||
        Object.entries(productionHashes(projectRoot, h.production)).some(([f, hash]) => check.production[f] !== hash) ||
        Object.entries(productionHashes(projectRoot, Object.keys(check.production))).some(([f, hash]) => check.production[f] !== hash);
      if (stale) because.push('the harness or the code changed since its check — run it again');
      else {
        if (check.unexecuted.length > 0) because.push(`the matrix tests never execute ${check.unexecuted.join(', ')}`);
        // A survivor is a change no row noticed: a missing requirement, or a
        // harness that does not observe it. One finding for the component,
        // settled once — by a requirement, or by allowing it with a reason.
        const open = unallowedSurvivors(projectRoot, check);
        const score = check.mutants === 0 ? 1 : (check.mutants - open.length) / check.mutants;
        if (open.length > 0 && score < config.mutationThreshold) {
          because.push(
            `${open.length} of ${check.mutants} changes to the code went unnoticed — the matrix does not reach ` +
              'that code, or the requirements allow what the change does (then a requirement is missing): ' +
              open.slice(0, 3).map((s) => `${s.file}:${s.line} ${s.from.trim() || '!'} → ${s.to.trim() || '(removed)'}`).join('; ') +
              ` — add the requirement, or allow them: \`spec-tacular harness <change> --allow-survivors "<why>"\``,
          );
        }
        because.push(...check.problems.filter((p) => !because.includes(p)));
        const mine = (tests ?? []).filter((t) => check.killers && t in check.killers);
        if (mine.length > 0 && !mine.some((t) => check.killers![t]) && check.killed > 0) {
          because.push(
            'its own matrix tests catch none of the changes to the code the other matrices catch — ' +
              'its harness may compute the answer itself, or read the wrong place',
          );
        }
      }
    }
  }
  return { component: h.component, connected: because.length === 0, because };
}
