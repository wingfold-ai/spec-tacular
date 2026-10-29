import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formalOf } from '../src/core/formal/formal.ts';
import { readGlossary } from '../src/core/formal/glossary.ts';
import { checksHold, matricesFor, requiredRows, type Matrix } from '../src/core/formal/matrix.ts';
import { changeMatrices, staleMatrices, testFileFor, writeMatrices, writeTests } from '../src/core/formal/files.ts';
import { itemEvidence, type EvidenceRecord } from '../src/core/evidence.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { matrixCases, type Harness, type Value } from '../runners/spec-tacular-matrix.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const G = readGlossary({
  variables: {
    tasks_applied: { role: 'input', type: 'bool', meaning: 'x' },
    specs_accepted: { role: 'input', type: 'bool', meaning: 'x' },
    stop_open: { role: 'input', type: 'bool', meaning: 'x' },
    archive_allowed: { role: 'output', type: 'bool', meaning: 'x' },
    token_valid: { role: 'input', type: 'bool', meaning: 'x' },
    token_expired: { role: 'input', type: 'bool', meaning: 'x' },
    allow: { role: 'output', type: 'bool', meaning: 'x' },
    armed: { role: 'input', type: 'bool', meaning: 'x' },
    voltage: { role: 'input', type: 'int', range: [0, 24], meaning: 'x' },
    alarm: { role: 'output', type: 'bool', meaning: 'x' },
    req: { role: 'input', type: 'bool', meaning: 'x' },
    done: { role: 'output', type: 'bool', meaning: 'x' },
  },
  constraints: ['token_valid -> !token_expired'],
});

const req = (formal: string, name = 'R') =>
  parseSpecFile(
    `## ADDED Requirements\n\n### Requirement: ${name}\nThe system SHALL x.\n\n\`\`\`formal\n${formal}\n\`\`\`\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** not b\n`,
    'archive',
    'f',
  ).requirements[0]!;
const matrix = (formal: string): Matrix => {
  const r = req(formal);
  return matricesFor(r, '[req:archive#r]', formalOf(r)!, G)[0]!;
};

describe('a decision\'s matrix', () => {
  const m = matrix('decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open');

  test('is the full truth table, each row with the output the formula requires', () => {
    expect(m.rows.map((r) => [r.id, r.expect?.archive_allowed])).toEqual([
      ['D1', false], ['D2', false], ['D3', false], ['D4', false],
      ['D5', false], ['D6', false], ['D7', true], ['D8', false],
    ]);
    expect(m.rows[6]!.steps[0]).toEqual({ tasks_applied: true, specs_accepted: true, stop_open: false });
  });

  test('marks the rows where each condition alone changes the outcome', () => {
    expect(m.rows.filter((r) => r.mcdc).map((r) => [r.id, r.mcdc])).toEqual([
      ['D3', ['tasks_applied']],
      ['D5', ['specs_accepted']],
      ['D7', ['tasks_applied', 'specs_accepted', 'stop_open']],
      ['D8', ['stop_open']],
    ]);
    expect(m.dead).toEqual([]);
  });

  test('a row the constraints rule out is infeasible, and its coupled condition reported', () => {
    const c = matrix('decision: allow = token_valid & !token_expired');
    expect(c.rows.find((r) => r.id === 'D4')?.infeasible).toBe('ruled out by the constraint token_valid -> !token_expired');
    expect(c.dead).toEqual(['token_expired']);
    expect(c.notes[0]).toContain('dead, or coupled');
  });

  test('comparisons are made concrete at their boundary, and walked across it', () => {
    const v = matrix('decision: alarm = armed & voltage > 9 & voltage < 20');
    expect(v.rows.find((r) => r.id === 'D1')?.infeasible).toContain('no value of voltage');
    expect(v.rows.find((r) => r.id === 'D6')?.steps[0]).toEqual({ armed: true, voltage: 9 });
    expect(v.rows.find((r) => r.id === 'D8')).toMatchObject({ steps: [{ armed: true, voltage: 10 }], expect: { alarm: true } });
    const edges = v.rows.filter((r) => r.id.startsWith('B')).map((r) => [r.steps[0]!.voltage, r.expect!.alarm]);
    expect(edges).toEqual([[0, false], [8, false], [24, false], [19, true], [21, false]]);
  });
});

describe('a FRETish requirement\'s matrix', () => {
  const m = matrix('fret: upon req Client shall within 2 ticks satisfy done');

  test('is step sequences, with checks over the response', () => {
    expect(m.rows.map((r) => [r.id, r.checks])).toEqual([
      ['T1', [{ kind: 'some', from: 0, to: 2 }]],
      ['T2', []],
      ['T3', [{ kind: 'some', from: 0, to: 2 }]],
      ['T4', [{ kind: 'some', from: 0, to: 2 }, { kind: 'some', from: 2, to: 4 }]],
      ['T5', [{ kind: 'some', from: 2, to: 4 }]],
    ]);
    expect(m.inputs).toEqual({ req: 'bool' });
    expect(m.outputs).toEqual({ done: 'bool' });
    expect(m.rows[3]!.steps.map((s) => s.req)).toEqual([true, false, true, false, false, false, false]);
  });

  test('comes with responses that meet and that break its checks', () => {
    for (const s of m.selfTest) expect(checksHold(s.checks, s.response)).toBe(s.passes);
    expect(m.selfTest.some((s) => !s.passes)).toBe(true);
  });

  test('never and for', () => {
    const never = matrix('fret: whenever req Client shall never satisfy done');
    expect(never.rows[0]!.checks).toEqual([{ kind: 'none', from: 0, to: 6 }]);
    for (const s of never.selfTest) expect(checksHold(s.checks, s.response)).toBe(s.passes);
  });
});

describe('which rows must pass', () => {
  const v = matrix('decision: alarm = armed & voltage > 9 & voltage < 20');
  test('all of them for P0, or without classes; MC/DC and edges for P1; none below', () => {
    expect(requiredRows(v, 'P0')).toHaveLength(v.rows.filter((r) => !r.infeasible).length);
    expect(requiredRows(v, null)).toEqual(requiredRows(v, 'P0'));
    expect(requiredRows(v, 'P1')).toEqual(['D4', 'D6', 'D7', 'D8', 'B1', 'B2', 'B3', 'B4', 'B5']);
    expect(requiredRows(v, 'P2')).toEqual([]);
  });
});

describe('the runner', () => {
  const decision = matrix('decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open');
  const harnessFor = (decide: (i: Record<string, Value>) => boolean) => (): Harness => {
    const inputs: Record<string, Value> = {};
    return { drive: (n, v) => { inputs[n] = v; }, observe: () => decide(inputs) };
  };

  test('one named case per runnable row, passing against a correct implementation', async () => {
    const cases = matrixCases(decision as never, harnessFor((i) => i.tasks_applied === true && i.specs_accepted === true && i.stop_open !== true));
    expect(cases[6]!.name).toStartWith('[req:archive#r] [row:D7] ');
    for (const c of cases) await c.run();
  });

  test('a wrong implementation fails exactly the rows it gets wrong', async () => {
    // Forgets the stop report.
    const cases = matrixCases(decision as never, harnessFor((i) => i.tasks_applied === true && i.specs_accepted === true));
    const failed: string[] = [];
    for (const c of cases) await c.run().catch(() => failed.push(c.name.match(/\[row:(\w+)\]/)?.[1] ?? c.name));
    expect(failed).toEqual(['D8']);
  });

  test('over time: drives each step, reads the outputs, checks the response', async () => {
    const fret = matrix('fret: upon req Client shall within 2 ticks satisfy done');
    // Answers each request `delay` steps after it went out, each on its own clock.
    const client = (delay: number) => (): Harness => {
      let pending: number[] = [];
      let prev = false;
      return {
        drive: (_n, v) => { if (v === true && !prev) pending.push(0); prev = v === true; },
        observe: () => pending.some((age) => age >= delay),
        tick: () => { pending = pending.filter((age) => age < delay).map((age) => age + 1); },
      };
    };
    for (const c of matrixCases(fret as never, client(2))) await c.run();
    const late: string[] = [];
    for (const c of matrixCases(fret as never, client(3))) await c.run().catch(() => late.push(c.name));
    expect(late.length).toBeGreaterThan(0);
  });
});

describe('matrix files', () => {
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-matrix-'));
    dirs.push(d);
    return d;
  };
  const item = req('decision: archive_allowed = tasks_applied & !stop_open', 'Archive only closed work');

  test('live in spec-tacular/matrix, outliving the change, and are rewritten only when they differ', () => {
    const d = root();
    const entries = changeMatrices(d, 'add-archive', [item], G);
    expect(entries.map((e) => [e.path, e.harness])).toEqual([
      ['spec-tacular/matrix/archive/archive-only-closed-work.json', 'test/support/harness/archive.ts'],
    ]);
    expect(staleMatrices(d, entries)).toHaveLength(1);
    expect(writeMatrices(d, entries)).toEqual(['spec-tacular/matrix/archive/archive-only-closed-work.json']);
    expect(staleMatrices(d, entries)).toEqual([]);
    expect(writeMatrices(d, entries)).toEqual([]);
    const changed = changeMatrices(d, 'add-archive', [req('decision: archive_allowed = tasks_applied', 'Archive only closed work')], G);
    expect(staleMatrices(d, changed)).toHaveLength(1);
  });

  test('each gets a generated test, the runner is copied, missing harnesses named', () => {
    const d = root();
    const entries = changeMatrices(d, 'add-archive', [item], G);
    writeMatrices(d, entries);
    const t = testFileFor(d, entries[0]!);
    expect(t.path).toBe('test/matrix/archive/archive-only-closed-work.matrix.test.ts');
    expect(t.content).toContain("import { matrixCases } from '../../support/spec-tacular-matrix.ts';");
    expect(t.content).toContain("import { harness } from '../../support/harness/archive.ts';");
    expect(t.content).toContain("import matrix from '../../../spec-tacular/matrix/archive/archive-only-closed-work.json';");
    const result = writeTests(d, entries);
    expect(result.missingHarness).toEqual(['test/support/harness/archive.ts']);
    expect(readFileSync(join(d, result.runner), 'utf8')).toContain('export function matrixCases');
  });
});

describe('evidence per row', () => {
  test('an item with a matrix is verified only once every required row ran', () => {
    const item = req('decision: archive_allowed = tasks_applied');
    const run = (row: string, outcome: 'pass' | 'fail' = 'pass'): EvidenceRecord => ({
      kind: 'run', at: 'now', item: item.id, hash: item.hash, test: `[req:archive#r] [row:${row}] x`, file: null, fileHash: null, outcome,
    });
    expect(itemEvidence('/x', item, [run('D1'), run('D2')], undefined, ['D1', 'D2']).state).toBe('passing');
    expect(itemEvidence('/x', item, [run('D1')], undefined, ['D1', 'D2'])).toMatchObject({ state: 'missing', note: 'matrix rows not run: D2' });
    expect(itemEvidence('/x', item, [run('D1', 'fail')], undefined, ['D1', 'D2']).state).toBe('failing');
  });
});
