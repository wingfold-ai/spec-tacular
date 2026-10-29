/**
 * What the time-tracker evaluation found, each pinned by a test: the glossary
 * spellings, constraints that emptied matrices, matrices that test nothing,
 * waived guards called mitigated, decisions asked again, task notes,
 * revising risks, the roadmap's slices, and what implementing is allowed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDriver } from '../src/agent/claude.ts';
import { changeEvidence, loadVerification, VERIFICATION_STARTER, type EvidenceRecord } from '../src/core/evidence.ts';
import { formalOf } from '../src/core/formal/formal.ts';
import { readGlossary } from '../src/core/formal/glossary.ts';
import { matricesFor, ruledOutBy } from '../src/core/formal/matrix.ts';
import { hazardState, type Hazard } from '../src/core/hazards.ts';
import { parseRefinement, refineContext } from '../src/core/refine.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { loadReview } from '../src/core/review.ts';
import { parseRisks } from '../src/core/risks.ts';
import { acceptDocument, hashDocument } from '../src/core/signoff.ts';
import { claudeSessionUsage } from '../src/core/usage.ts';
import { mergeSlices, moveSlice, type ProposedSlice } from '../src/core/vision.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'eval-fixes-'));
  dirs.push(d);
  return d;
};

const req = (formal: string) =>
  parseSpecFile(
    `## ADDED Requirements\n\n### Requirement: R\nThe system SHALL x.\n\n\`\`\`formal\n${formal}\n\`\`\`\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** not b\n`,
    'timer',
    'f',
  ).requirements[0]!;

describe('the glossary', () => {
  test('reads the usual spellings of its types as the types they mean', () => {
    const g = readGlossary({
      variables: {
        running: { role: 'input', type: 'boolean', meaning: 'x' },
        version: { role: 'input', type: 'integer', range: [1, 3], meaning: 'x' },
        hours: { role: 'input', type: 'number', meaning: 'x' },
      },
    });
    expect(g.problems).toEqual([]);
    expect(g.variables.get('running')!.type).toBe('bool');
    expect(g.variables.get('version')!.type).toBe('int');
    expect(g.variables.get('hours')!.type).toBe('float');
  });
});

const G = readGlossary({
  variables: {
    timer_running: { role: 'input', type: 'bool', meaning: 'x' },
    same_project: { role: 'input', type: 'bool', meaning: 'x' },
    clock_behind: { role: 'input', type: 'bool', meaning: 'x' },
    noop: { role: 'output', type: 'bool', meaning: 'x' },
    started: { role: 'output', type: 'bool', meaning: 'x' },
    entry_start: { role: 'input', type: 'int', range: [0, 10], meaning: 'x' },
    now: { role: 'input', type: 'int', range: [0, 10], meaning: 'x' },
    refused: { role: 'output', type: 'bool', meaning: 'x' },
  },
  constraints: ['same_project -> timer_running', 'clock_behind -> timer_running'],
});

describe('constraints', () => {
  test('rule out only the rows that set every variable they name', () => {
    // No same_project here: the constraint says nothing about the row.
    expect(ruledOutBy(G, { timer_running: false })).toBeNull();
    expect(ruledOutBy(G, { timer_running: false, same_project: true })).toBe('same_project -> timer_running');
  });

  test('a matrix without one of its variables keeps the rows where the outcome happens', () => {
    const r = req('decision: noop = timer_running AND NOT clock_behind');
    const m = matricesFor(r, '[req:timer#r]', formalOf(r)!, G)[0]!;
    const runnable = m.rows.filter((row) => !row.infeasible);
    expect(runnable.some((row) => row.expect?.['noop'] === true)).toBe(true);
    expect(m.vacuous).toBeUndefined();
    // same_project is not in it: never read as false.
    expect(m.rows.filter((row) => row.infeasible).map((row) => row.infeasible)).toEqual([
      'ruled out by the constraint clock_behind -> timer_running',
    ]);
  });
});

describe('a matrix that tests nothing', () => {
  test('is flagged when its output is the same in every row that can happen', () => {
    const r = req('decision: started = same_project AND NOT timer_running');
    const m = matricesFor(r, '[req:timer#r]', formalOf(r)!, G)[0]!;
    expect(m.vacuous).toMatch(/started is false in every row/);
    expect(m.notes.some((n) => n.startsWith('tests nothing'))).toBe(true);
  });

  test('and its requirement has no evidence however its rows did', () => {
    const d = root();
    const r = req('decision: started = same_project AND NOT timer_running');
    const records: EvidenceRecord[] = [
      { kind: 'run', at: 'a', item: r.id, hash: r.hash, test: '[req:timer#r] [row:D1]', file: null, fileHash: null, outcome: 'pass' },
    ];
    mkdirSync(join(d, '.spec-tacular', 'evidence'), { recursive: true });
    writeFileSync(join(d, '.spec-tacular', 'evidence', 'c.jsonl'), records.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const reviewed = [{ item: r, state: 'accepted' as const, review: { state: 'accepted' as const, hash: r.hash, reviewedAt: 'a' }, drifted: false }];
    const [e] = changeEvidence(d, 'c', reviewed, new Map(), new Map(), new Map([[r.id, 'its matrix tests nothing: x']]));
    expect(e).toMatchObject({ state: 'missing', note: 'its matrix tests nothing: x' });
  });
});

describe('comparing two variables', () => {
  test('is generated: values for both, either side of each other', () => {
    const r = req('decision: refused = timer_running AND now < entry_start');
    const m = matricesFor(r, '[req:timer#r]', formalOf(r)!, G)[0]!;
    const runnable = m.rows.filter((row) => !row.infeasible);
    expect(runnable).toHaveLength(4);
    for (const row of runnable) {
      const env = row.steps[0]!;
      const holds = env['timer_running'] === true && (env['now'] as number) < (env['entry_start'] as number);
      expect(row.expect!['refused']).toBe(holds);
    }
    expect(runnable.some((row) => row.expect?.['refused'] === true)).toBe(true);
    expect(m.vacuous).toBeUndefined();
  });
});

describe('a waived guard in the register', () => {
  const hazard: Hazard = {
    number: 1, id: 'HAZ-0001', title: 'Leak', file: 'f', stated: 'mitigated', severity: 'high',
    reviewed: '2026-10-28', hazard: '', causes: '', affects: '', controls: [], verification: ['[risk:c#leak]'],
    unmitigated: '', history: [],
  };
  const run = (outcome: 'pass' | 'fail', at: string): EvidenceRecord =>
    ({ kind: 'run', at, item: '[risk:c#leak]', hash: '', test: 't', file: null, fileHash: null, outcome });

  test('is unverified, with the waiver, not mitigated', () => {
    const waiver: EvidenceRecord = { kind: 'waive', at: 'b', item: '[risk:c#leak]', hash: '', reason: 'harness not connected' };
    const s = hazardState(hazard, [run('pass', 'a'), waiver], new Date('2026-10-29'));
    expect(s.status).toBe('unverified');
    expect(s.because).toContain('harness not connected');
  });

  test('until a later run passes', () => {
    const waiver: EvidenceRecord = { kind: 'waive', at: 'b', item: '[risk:c#leak]', hash: '', reason: 'x' };
    expect(hazardState(hazard, [waiver, run('pass', 'c')], new Date('2026-10-29')).status).toBe('mitigated');
  });
});

describe('accepting the design', () => {
  const DESIGN = '# Design\n\n## Decisions\n\n### Decision: Store as JSON\nOne file.\n\n### Decision: One clock reading\nPer command.\n';

  test('accepts each of its decisions, so an unchanged one is not asked again', () => {
    const d = root();
    acceptDocument(d, 'c', 'design', DESIGN);
    const states = Object.values(loadReview(d, 'c').requirements).map((r) => r.state);
    expect(states).toEqual(['accepted', 'accepted']);
  });
});

describe('a task note', () => {
  test('is implementing, not changing the plan', () => {
    const tasks = '- [ ] 1.1 Write the store\n- [ ] 1.2 Write the CLI\n';
    const noted = '- [x] 1.1 Write the store (note: atomic rename instead of fsync)\n- [ ] 1.2 Write the CLI\n      (note: exit code 2 for usage errors)\n';
    expect(hashDocument(noted)).toBe(hashDocument(tasks));
    expect(hashDocument(tasks.replace('the CLI', 'a GUI'))).not.toBe(hashDocument(tasks));
  });
});

describe('revising a risk with the agent', () => {
  const RISKS = '# Risks\n\n### Risk: Entry ends before it starts\n- **Hazard:** a negative duration\n- **Affects:** timer#stop\n- **Boundary:** clock set back\n- **Severity:** high\n- **Guard:** an entry never ends before it starts\n- **Check:** stop with the clock behind\n';

  test('takes back one risk, in the risks format', () => {
    const d = root();
    const file = join(d, 'risks.md');
    writeFileSync(file, RISKS);
    const [risk] = parseRisks(RISKS, file);
    const context = refineContext(d, risk!);
    const revised = RISKS.split('\n').slice(2).join('\n').replace('Severity:** high', 'Severity:** medium').trim();
    const r = parseRefinement({ requirement: revised, summary: 'lower severity' }, context);
    expect(r.warnings).toEqual([]);
    expect(() => parseRefinement({ requirement: '### Requirement: X\nThe system SHALL x.', summary: '' }, context)).toThrow('### Risk:');
  });
});

describe('the roadmap\'s slices', () => {
  const slices: ProposedSlice[] = [
    { id: 'add-timer', title: 'Start and stop', summary: 'Start and stop a timer.', why: 'first', dependsOn: [] },
    { id: 'add-today', title: 'List today', summary: 'List today\'s entries.', why: '', dependsOn: ['add-timer'] },
    { id: 'add-totals', title: 'Totals', summary: 'Hours per project.', why: '', dependsOn: ['add-today'] },
  ];

  test('merge into one change, and what depended on the merged one follows', () => {
    const merged = mergeSlices(slices, 0);
    expect(merged.map((s) => s.id)).toEqual(['add-timer', 'add-totals']);
    expect(merged[0]!.summary).toBe('Start and stop a timer; List today\'s entries.');
    expect(merged[1]!.dependsOn).toEqual(['add-timer']);
  });

  test('move, but never before what they build on', () => {
    expect(moveSlice(slices, 1, -1)).toMatchObject({ ok: false });
    const independent = [slices[0]!, { ...slices[2]!, dependsOn: [] }];
    expect(moveSlice(independent, 1, -1)).toMatchObject({ ok: true });
  });
});

describe('verification.yaml', () => {
  test('the starter init writes leaves evidence off', () => {
    const d = root();
    mkdirSync(join(d, 'spec-tacular'));
    writeFileSync(join(d, 'spec-tacular', 'verification.yaml'), VERIFICATION_STARTER);
    expect(loadVerification(d)).toBeNull();
  });
});

describe('the implementing session', () => {
  test('may edit and run the project\'s tests without asking, and is named', () => {
    const c = claudeDriver.interactive!('Implement it', ['bun test'], 'abc');
    expect(c.args[0]).toBe('Implement it');
    expect(c.args).toContain('acceptEdits');
    expect(c.args).toContain('Bash(bun test:*)');
    expect(c.args.slice(c.args.indexOf('--session-id'), c.args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'abc']);
  });

  test('what it used is read from its transcript, each message once', () => {
    const d = root();
    const file = join(d, 't.jsonl');
    const msg = (id: string) =>
      JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } });
    writeFileSync(file, [msg('a'), msg('a'), msg('b'), JSON.stringify({ type: 'user' })].join('\n'));
    expect(claudeSessionUsage(file)).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, turns: 2, model: 'claude-opus-5-5' });
    expect(claudeSessionUsage(join(d, 'missing.jsonl'))).toBeNull();
  });
});
