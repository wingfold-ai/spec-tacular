import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MATRIX_CONFIG } from '../src/core/formal/config.ts';
import {
  applyMutant,
  checkHarnessCode,
  componentHarness,
  connection,
  harnessItems,
  loadMapping,
  mutantsOf,
  parseLcov,
  runHarnessCheck,
  saveCheck,
  unmappedVariables,
} from '../src/core/formal/harness.ts';
import { changeMatrices, writeMatrices, writeTests, testFileFor } from '../src/core/formal/files.ts';
import { readGlossary } from '../src/core/formal/glossary.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { harnessFromMapping, matrixCases, type Harness, type Value } from '../runners/spec-tacular-matrix.ts';

const dirs: string[] = [];
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-harness-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

const DECIDE = `export function archiveAllowed(s: { tasksApplied: boolean; specsAccepted: boolean; stopOpen: boolean }): boolean {
  return s.tasksApplied && s.specsAccepted && !s.stopOpen;
}
`;
const MAPPING = `module: src/archive/decide.ts
inputs:
  tasks_applied: { arg: tasksApplied }
  specs_accepted: { arg: specsAccepted }
  stop_open: { arg: stopOpen }
outputs:
  archive_allowed: { call: archiveAllowed }
`;
const GLOSSARY = readGlossary({
  variables: {
    tasks_applied: { role: 'input', type: 'bool', meaning: 'every task ticked or deferred' },
    specs_accepted: { role: 'input', type: 'bool', meaning: 'every requirement accepted' },
    stop_open: { role: 'input', type: 'bool', meaning: 'a stop report is open' },
    archive_allowed: { role: 'output', type: 'bool', meaning: 'archiving goes ahead' },
  },
});
const REQUIREMENT = parseSpecFile(
  '## ADDED Requirements\n\n### Requirement: Archive only closed work\nThe system SHALL x.\n\n```formal\ndecision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open\n```\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** not b\n',
  'archive',
  'f',
).requirements[0]!;

describe('mappings', () => {
  test('bind each variable to an export or a field, and say what is wrong', () => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    put(d, 'test/support/harness/archive.mapping.yaml', MAPPING);
    const { mapping, problems } = loadMapping(d, 'test/support/harness/archive.mapping.yaml');
    expect(problems).toEqual([]);
    expect(mapping?.inputs.tasks_applied).toEqual({ arg: 'tasksApplied' });
    expect(mapping?.lines.stop_open).toBe(5);

    put(d, 'test/support/harness/bad.mapping.yaml', 'module: test/fake.ts\ninputs:\n  x: { maybe: y }\noutputs:\n  z: {}\n');
    put(d, 'test/fake.ts', '');
    expect(loadMapping(d, 'test/support/harness/bad.mapping.yaml').problems).toEqual([
      'test/support/harness/bad.mapping.yaml: module test/fake.ts is test code, not the code under test',
      'test/support/harness/bad.mapping.yaml: input x says neither arg, set, call, on_rise nor on_fall',
      'test/support/harness/bad.mapping.yaml: output z says neither call nor read',
    ]);
  });

  test('a mapping must bind every variable its matrices use', () => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    put(d, 'test/support/harness/archive.mapping.yaml', MAPPING.replace('  stop_open: { arg: stopOpen }\n', ''));
    const [entry] = changeMatrices(d, 'c', [REQUIREMENT], GLOSSARY);
    expect(unmappedVariables(componentHarness(d, 'archive'), [entry!.matrix])).toEqual(['stop_open']);
  });

  test('are reviewed one variable at a time, beside what the word means', () => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    put(d, 'test/support/harness/archive.mapping.yaml', MAPPING);
    const items = harnessItems(d, componentHarness(d, 'archive'), GLOSSARY);
    expect(items.map((i) => i.id)).toEqual([
      'harness/archive#tasks_applied', 'harness/archive#specs_accepted', 'harness/archive#stop_open', 'harness/archive#archive_allowed',
    ]);
    expect(items[0]!.text).toBe('Means: every task ticked or deferred\nSet by: arg tasksApplied — in src/archive/decide.ts');
  });

  test('drive the real code through the runner, holding no logic of their own', async () => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    put(d, 'test/support/harness/archive.mapping.yaml', MAPPING);
    const [entry] = changeMatrices(d, 'c', [REQUIREMENT], GLOSSARY);
    const mod = { archiveAllowed: (s: { tasksApplied: boolean; specsAccepted: boolean; stopOpen: boolean }) => s.tasksApplied && s.specsAccepted && !s.stopOpen };
    const mapping = loadMapping(d, 'test/support/harness/archive.mapping.yaml').mapping!;
    for (const c of matrixCases(entry!.matrix as never, harnessFromMapping(mapping as never, mod))) await c.run();
  });
});

describe('input isolation', () => {
  test('a drive that moves another input fails the row', async () => {
    const [m] = changeMatrices(project(), 'c', [REQUIREMENT], GLOSSARY);
    // Setting stop_open also unticks the tasks: D8 would pass for the wrong reason.
    const confounded = (): Harness => {
      const s: Record<string, Value> = {};
      return {
        drive: (n, v) => { s[n] = v; if (n === 'stop_open' && v === true) s.tasks_applied = false; },
        probe: (n) => s[n]!,
        observe: () => s.tasks_applied === true && s.specs_accepted === true && s.stop_open !== true,
      };
    };
    const d8 = matrixCases(m!.matrix as never, confounded).find((c) => c.name.includes('[row:D8]'))!;
    await expect(d8.run()).rejects.toThrow('driving stop_open=true changed tasks_applied to false');
  });
});

describe('harness code', () => {
  const config = DEFAULT_MATRIX_CONFIG;

  test('must reach production code and never read the matrix', () => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    put(d, 'test/support/harness/good.ts', "import { archiveAllowed } from '../../../src/archive/decide.ts';\nimport type { Harness } from '../spec-tacular-matrix.ts';\n");
    expect(checkHarnessCode(d, 'test/support/harness/good.ts', config)).toMatchObject({ production: ['src/archive/decide.ts'], problems: [] });

    put(d, 'test/support/harness/answers.ts', "import matrix from '../../../spec-tacular/matrix/archive/x.json';\n");
    expect(checkHarnessCode(d, 'test/support/harness/answers.ts', config)!.problems).toEqual([
      'test/support/harness/answers.ts imports ../../../spec-tacular/matrix/archive/x.json: a harness never reads the matrix or its expected values',
      'test/support/harness/answers.ts reads a matrix file: a harness never sees the expected values',
      'test/support/harness/answers.ts imports no production code: it cannot be testing the system',
    ]);
  });
});

describe('mutants', () => {
  test('one per operator occurrence, comments, strings and imports left alone', () => {
    const text = "import x from 'a && b';\n// a && b\nconst ok = a && b && !c;\nconst s = 'x > y';\n";
    const ms = mutantsOf('f.ts', text, 20);
    expect(ms.map((m) => [m.line, m.from, m.to])).toEqual([[3, ' && ', ' || '], [3, ' && ', ' || '], [3, '!', '']]);
    expect(applyMutant(text, ms[1]!).split('\n')[2]).toBe('const ok = a && b || !c;');
    expect(applyMutant(text, ms[2]!).split('\n')[2]).toBe('const ok = a && b && c;');
  });

  test('spread over the file when there are more than the limit', () => {
    const text = Array.from({ length: 10 }, (_, i) => `const v${i} = a${i} && b;`).join('\n');
    expect(mutantsOf('f.ts', text, 3).map((m) => m.line)).toEqual([1, 4, 7]);
  });
});

describe('coverage', () => {
  test('reads functions and lines hit per file from lcov', () => {
    const lcov = 'SF:src/a.ts\nFNF:2\nFNH:1\nLF:10\nLH:4\nend_of_record\nSF:/abs/root/src/b.ts\nFNF:1\nFNH:0\nLH:0\nend_of_record\n';
    const out = parseLcov(lcov, '/abs/root');
    expect(out.get('src/a.ts')).toEqual({ lines: 4, functions: 1, fnFound: 2 });
    expect(out.get('src/b.ts')).toEqual({ lines: 0, functions: 0, fnFound: 1 });
  });
});

describe('the check, end to end', () => {
  /** A real project: code, a mapping or a harness, the generated tests, bun. */
  const setup = (harness: { mapping?: string; code?: string }) => {
    const d = project();
    put(d, 'src/archive/decide.ts', DECIDE);
    if (harness.mapping) put(d, 'test/support/harness/archive.mapping.yaml', harness.mapping);
    if (harness.code) put(d, 'test/support/harness/archive.ts', harness.code);
    const entries = changeMatrices(d, 'c', [REQUIREMENT], GLOSSARY);
    writeMatrices(d, entries);
    writeTests(d, entries);
    const h = componentHarness(d, 'archive');
    const tests = entries.map((e) => testFileFor(d, e).path);
    return { d, h, entries, tests };
  };

  test('a mapping onto the real code is executed and catches every mutant', () => {
    const { d, h, tests } = setup({ mapping: MAPPING });
    const check = runHarnessCheck(d, h, tests);
    expect(check).toMatchObject({ green: true, unexecuted: [], mutants: 3, killed: 3, passed: true });
    // The real source was never touched.
    expect(readFileSync(join(d, 'src/archive/decide.ts'), 'utf8')).toBe(DECIDE);
  }, 60_000);

  test('a harness that answers for the code passes every row, and is caught', () => {
    const cheat = `import { archiveAllowed } from '../../../src/archive/decide.ts';
import type { Harness, Value } from '../spec-tacular-matrix.ts';
void archiveAllowed;
export const harness = (): Harness => {
  const i: Record<string, Value> = {};
  return { drive: (n, v) => { i[n] = v; }, observe: () => i.tasks_applied === true && i.specs_accepted === true && i.stop_open !== true };
};
`;
    const { d, h, entries, tests } = setup({ code: cheat });
    const check = runHarnessCheck(d, h, tests);
    expect(check).toMatchObject({ green: true, unexecuted: ['src/archive/decide.ts'], killed: 0, passed: false });
    saveCheck(d, check);
    const c = connection(d, h, entries.map((e) => e.matrix), [{ accepted: true }]);
    expect(c.connected).toBe(false);
    expect(c.because.join('\n')).toContain('the matrix tests never execute src/archive/decide.ts');
  }, 60_000);

  test('connected needs a review, and a check still matching the harness and the code', () => {
    const { d, h, entries, tests } = setup({ mapping: MAPPING });
    const matrices = entries.map((e) => e.matrix);
    expect(connection(d, h, matrices, [{ accepted: true }]).because).toEqual(['no harness check yet — run `spec-tacular harness --check`']);
    saveCheck(d, runHarnessCheck(d, h, tests));
    expect(connection(d, h, matrices, [{ accepted: false }]).because[0]).toContain('has not been reviewed');
    expect(connection(d, h, matrices, [{ accepted: true }])).toEqual({ component: 'archive', connected: true, because: [] });
    put(d, 'src/archive/decide.ts', DECIDE.replace('&& !s.stopOpen', '&& !s.stopOpen '));
    expect(connection(d, h, matrices, [{ accepted: true }]).because).toEqual(['the harness or the code changed since its check — run it again']);
  }, 60_000);
});
