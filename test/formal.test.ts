import { describe, expect, test } from 'bun:test';
import { conditionsOf, evaluate, inWords, parseExpr, variablesOf } from '../src/core/formal/expr.ts';
import { check, fretInWords, parseFretish, scopeIntervals, triggers } from '../src/core/formal/fretish.ts';
import { readGlossary } from '../src/core/formal/glossary.ts';
import {
  changeFormal,
  checkFormal,
  decisionConflicts,
  formalOf,
  readFormal,
  resolveLiterals,
  vagueTerms,
} from '../src/core/formal/formal.ts';
import { parseSpecFile } from '../src/core/requirements.ts';

describe('expressions', () => {
  test('either spelling of the operators, FRET precedence', () => {
    const a = parseExpr('tasks_applied AND specs_accepted AND NOT stop_open');
    const b = parseExpr('tasks_applied & specs_accepted & !stop_open');
    const env = { tasks_applied: true, specs_accepted: true, stop_open: false };
    expect(evaluate(a, env)).toBe(true);
    expect(evaluate(b, { ...env, stop_open: true })).toBe(false);
    // & binds tighter than |, | tighter than ->
    expect(evaluate(parseExpr('a | b & c'), { a: true, b: false, c: false })).toBe(true);
    expect(evaluate(parseExpr('a -> b | c'), { a: true, b: false, c: true })).toBe(true);
  });

  test('comparisons, numbers and calls', () => {
    const e = parseExpr('voltage > 9 & isValid()');
    expect(evaluate(e, { voltage: 10, 'isValid()': true })).toBe(true);
    expect(evaluate(e, { voltage: 9, 'isValid()': true })).toBe(false);
    expect([...variablesOf(e)]).toEqual(['voltage', 'isValid()']);
  });

  test('x and NOT x are one condition; a comparison is one', () => {
    const e = parseExpr('(a & !b) | (!a & b) | voltage >= 3');
    expect([...conditionsOf(e).keys()]).toEqual(['a', 'b', 'voltage >= 3']);
  });

  test('read back in plain words', () => {
    expect(inWords(parseExpr('tasks_applied & specs_accepted & !stop_open'))).toBe('tasks_applied and specs_accepted and not stop_open');
    expect(inWords(parseExpr('(a | b) & c'))).toBe('(a or b) and c');
  });

  test('says what it cannot read', () => {
    expect(() => parseExpr('a & (b')).toThrow('not closed');
    expect(() => parseExpr('a b')).toThrow('unexpected "b"');
  });
});

describe('FRETish', () => {
  test('reads scope, condition, component, timing and response', () => {
    const f = parseFretish('In flight mode, upon low_battery the Battery shall within 5 ticks satisfy alarm');
    expect(f.scope).toEqual({ kind: 'in', mode: 'flight' });
    expect(f.condition?.kind).toBe('upon');
    expect(f.component).toBe('Battery');
    expect(f.timing).toEqual({ kind: 'within', n: 5 });
  });

  test('timing defaults to always; whenever is every step', () => {
    const f = parseFretish('whenever overheated Pump shall satisfy !running');
    expect(f.timing.kind).toBe('always');
    expect(f.condition?.kind).toBe('whenever');
    expect(() => parseFretish('Pump satisfy x')).toThrow('shall');
    expect(() => parseFretish('Pump shall sometimes satisfy x')).toThrow('unknown timing');
  });

  const steps = (key: string, values: number[], extra: Record<string, number[]> = {}) =>
    values.map((v, i) => ({ [key]: v === 1, ...Object.fromEntries(Object.entries(extra).map(([k, vs]) => [k, vs[i] === 1])) }));

  test('upon: an obligation each time the condition becomes true', () => {
    const f = parseFretish('upon req Client shall within 3 ticks satisfy done');
    const trace = steps('req', [1, 1, 0, 1, 0, 0, 0, 0]);
    expect(triggers(f, trace, [0, 7])).toEqual([0, 3]);
    expect(check(f, steps('req', [1, 0, 0, 0, 0, 0], { done: [0, 0, 0, 1, 0, 0] })).holds).toBe(true); // at +3: inclusive
    expect(check(f, steps('req', [1, 0, 0, 0, 0, 0], { done: [0, 0, 0, 0, 1, 0] }))).toEqual({ holds: false, violated: [0] });
    expect(check(f, steps('req', [0, 0, 0, 0], { done: [0, 0, 0, 0] })).holds).toBe(true); // never triggered
  });

  test('a window running past the end is judged on the steps there are', () => {
    const f = parseFretish('upon req Client shall within 3 ticks satisfy done');
    expect(check(f, steps('req', [0, 0, 1], { done: [0, 0, 0] })).holds).toBe(true);
  });

  test('scopes: in, before, after a mode', () => {
    const trace = steps('m', [0, 1, 1, 0, 1, 0]);
    expect(scopeIntervals(parseFretish('in m mode X shall satisfy y'), trace)).toEqual([[1, 2], [4, 4]]);
    expect(scopeIntervals(parseFretish('before m X shall satisfy y'), trace)).toEqual([[0, 0]]);
    expect(scopeIntervals(parseFretish('after m X shall satisfy y'), trace)).toEqual([[3, 5]]);
  });

  test('never, for, after, until', () => {
    const never = parseFretish('whenever text_changed Review shall never satisfy accepted');
    expect(check(never, steps('text_changed', [0, 1, 0], { accepted: [1, 0, 0] })).holds).toBe(true);
    expect(check(never, steps('text_changed', [0, 1, 0], { accepted: [0, 0, 1] })).holds).toBe(false);
    const forN = parseFretish('upon go X shall for 2 ticks satisfy on');
    expect(check(forN, steps('go', [1, 0, 0, 0], { on: [1, 1, 1, 0] })).holds).toBe(true);
    expect(check(forN, steps('go', [1, 0, 0, 0], { on: [1, 1, 0, 0] })).holds).toBe(false);
    const after = parseFretish('upon go X shall after 2 ticks satisfy on');
    expect(check(after, steps('go', [1, 0, 0, 0], { on: [0, 0, 1, 0] })).holds).toBe(true);
    expect(check(after, steps('go', [1, 0, 0, 0], { on: [0, 1, 1, 0] })).holds).toBe(false);
    const until = parseFretish('upon go X shall until stop satisfy on');
    expect(check(until, steps('go', [1, 0, 0, 0], { on: [1, 1, 0, 0], stop: [0, 0, 1, 0] })).holds).toBe(true);
  });

  test('read back in plain words', () => {
    expect(fretInWords(parseFretish('upon req Client shall within 3 ticks satisfy done | failed'))).toBe(
      'each time req becomes true, Client must make "done or failed" true within 3 steps (by step +3 at the latest).',
    );
  });
});

const GLOSSARY = readGlossary({
  variables: {
    tasks_applied: { role: 'input', type: 'bool', meaning: 'every task ticked or deferred' },
    specs_accepted: { role: 'input', type: 'bool', meaning: 'every requirement accepted' },
    stop_open: { role: 'input', type: 'bool', meaning: 'a stop report is open' },
    archive_allowed: { role: 'output', type: 'bool', meaning: 'archiving goes ahead' },
    token: { role: 'input', type: 'enum', values: ['VALID', 'EXPIRED'], meaning: 'state of the token' },
    voltage: { role: 'input', type: 'int', range: [0, 24], meaning: 'battery voltage' },
    flight: { role: 'mode', type: 'bool', meaning: 'airborne' },
  },
  constraints: ['token = VALID -> voltage > 0'],
});

const spec = (formal: string, name = 'Archive only closed work') =>
  parseSpecFile(
    `## ADDED Requirements\n\n### Requirement: ${name}\nThe system SHALL archive only closed work.\n\n\`\`\`formal\n${formal}\n\`\`\`\n\n#### Scenario: Open\n- **WHEN** a stop report is open\n- **THEN** archiving is refused\n`,
    'archive',
    'f',
  ).requirements[0]!;

describe('the glossary', () => {
  test('reads roles, types, enum values, constraints', () => {
    expect(GLOSSARY.problems).toEqual([]);
    expect(GLOSSARY.variables.get('token')?.values).toEqual(['VALID', 'EXPIRED']);
    expect(GLOSSARY.constraints).toHaveLength(1);
  });

  test('says what it cannot use', () => {
    expect(readGlossary({ variables: { x: { role: 'thing', type: 'enum' } }, constraints: ['y &'] }).problems).toEqual([
      'x: role must be one of mode, input, output, internal',
      'x: an enum lists its values',
      'x: says nothing about what it means',
      'constraint "y &": the expression ends too early',
    ]);
  });
});

describe('a requirement\'s formal form', () => {
  test('is read from its formal block, which is part of what is accepted', () => {
    const r = spec('decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open\nasked: Does a deferred task count as open? — No.');
    const form = formalOf(r)!;
    expect(form.decisions[0]?.output).toBe('archive_allowed');
    expect(form.asked).toEqual(['Does a deferred task count as open? — No.']);
    expect(spec('decision: archive_allowed = tasks_applied').hash).not.toBe(r.hash);
  });

  test('is checked against the glossary', () => {
    expect(checkFormal(formalOf(spec('decision: archive_allowed = tasks_applied & !stop_open'))!, GLOSSARY)).toEqual({ errors: [], notes: [] });
    expect(checkFormal(formalOf(spec('decision: archive_allowed = tasks_done'))!, GLOSSARY).errors).toEqual(['not in the glossary: tasks_done']);
    expect(checkFormal(formalOf(spec('decision: stop_open = tasks_applied'))!, GLOSSARY).errors).toEqual(['stop_open is an input: a decision defines an output']);
    expect(checkFormal(formalOf(spec('decision: archive_allowed = token = REVOKED'))!, GLOSSARY).errors).toEqual(['not in the glossary: REVOKED', 'REVOKED is not a value of token (VALID, EXPIRED)']);
    expect(checkFormal(formalOf(spec('decision: archive_allowed = voltage'))!, GLOSSARY).errors).toEqual(['voltage is int, read here as true or false']);
    expect(checkFormal(formalOf(spec('fret: in voltage mode X shall satisfy archive_allowed'))!, GLOSSARY).errors).toEqual(['voltage is used as a mode, but is an input']);
    expect(checkFormal(formalOf(spec('decision: archive_allowed = ('))!, GLOSSARY).errors[0]).toContain('decision:');
    expect(checkFormal(formalOf(spec('decision: archive_allowed = tasks_applied'))!, null).errors).toEqual([
      'there is no glossary yet: its variables are defined in spec-tacular/glossary.yaml',
    ]);
  });

  test('enum values become literals', () => {
    const e = resolveLiterals(formalOf(spec('decision: archive_allowed = token = VALID'))!.decisions[0]!.expr, GLOSSARY);
    expect(evaluate(e, { token: 'VALID' })).toBe(true);
    expect(evaluate(e, { token: 'EXPIRED' })).toBe(false);
  });

  test('a decision over too many conditions is flagged for splitting', () => {
    const notes = checkFormal(formalOf(spec('decision: archive_allowed = a & b & c & d & e & f & g'))!, readGlossary({})).notes;
    expect(notes[0]).toContain('7 conditions in one decision');
  });

  test('is read back in words, with what each variable means', () => {
    expect(readFormal(formalOf(spec('decision: archive_allowed = tasks_applied & !stop_open'))!, GLOSSARY)).toEqual([
      'archive_allowed is true exactly when tasks_applied and not stop_open.',
      '  archive_allowed (output, bool) — archiving goes ahead',
      '  stop_open (input, bool) — a stop report is open',
      '  tasks_applied (input, bool) — every task ticked or deferred',
    ]);
  });
});

describe('across a change', () => {
  test('two decisions defining one output differently conflict', () => {
    const a = spec('decision: archive_allowed = tasks_applied & !stop_open', 'Archive closed work');
    const b = spec('decision: archive_allowed = tasks_applied', 'Archive applied work');
    expect(decisionConflicts([{ item: a, form: formalOf(a)! }, { item: b, form: formalOf(b)! }])).toEqual([
      '"Archive closed work" and "Archive applied work" define archive_allowed differently, e.g. when tasks_applied=T, stop_open=T',
    ]);
    const same = spec('decision: archive_allowed = !stop_open & tasks_applied', 'Same');
    expect(decisionConflicts([{ item: a, form: formalOf(a)! }, { item: same, form: formalOf(same)! }])).toEqual([]);
  });

  test('the change summary counts formal requirements and collects errors', () => {
    const ok = spec('decision: archive_allowed = tasks_applied', 'Ok');
    const bad = spec('decision: archive_allowed = nope', 'Bad');
    const plain = parseSpecFile('## ADDED Requirements\n\n### Requirement: Plain\nThe system SHALL work.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n', 'c', 'f').requirements[0]!;
    const summary = changeFormal([ok, bad, plain], GLOSSARY);
    expect(summary).toMatchObject({ formal: 2, total: 3, errors: [{ item: 'Bad', problems: ['not in the glossary: nope'] }] });
    expect(summary.conflicts).toHaveLength(1);
  });
});

describe('vague terms', () => {
  test('words a requirement leaves undefined, when it has no formal form', () => {
    const r = parseSpecFile(
      '## ADDED Requirements\n\n### Requirement: Fast export\nThe system SHALL export promptly and handle large accounts gracefully. {{example: quickly}}\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n',
      'c',
      'f',
    ).requirements[0]!;
    expect(vagueTerms(r)).toEqual(['promptly', 'large', 'gracefully']);
    expect(vagueTerms(spec('decision: archive_allowed = tasks_applied'))).toEqual([]);
  });
});

describe('in the pipeline', () => {
  test('a broken or contradicting formal form holds up the design', async () => {
    const { buildPipeline } = await import('../src/core/pipeline.ts');
    const { gateFor, formalWarnings } = await import('../src/core/gate.ts');
    const status = {
      changeName: 'c', schemaName: 'spec-tacular', changeRoot: '/tmp/c', artifactPaths: {}, isPlanningComplete: false,
      applyRequires: ['tasks'], nextSteps: [],
      artifacts: [
        { id: 'proposal', status: 'done' as const, requires: [], outputPath: 'proposal.md' },
        { id: 'specs', status: 'done' as const, requires: ['proposal'], outputPath: 'specs/**/*.md' },
        { id: 'design', status: 'ready' as const, requires: ['specs'], outputPath: 'design.md' },
      ],
    };
    const done = { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true };
    const formal = changeFormal([spec('decision: archive_allowed = nope', 'Bad')], GLOSSARY);
    const p = buildPipeline(status, { specs: done }, { proposal: { accepted: true, drifted: false } }, { formal });
    const gate = gateFor(p, 'design');
    expect(gate.allowed === false && gate.blockers).toEqual(['the formal form of "Bad": not in the glossary: nope']);
    expect(formalWarnings(p)).toEqual(['formal form of "Bad": not in the glossary: nope']);
  });

  test('the review shows the formula as written, unwrapped', async () => {
    const { renderRequirement } = await import('../src/render/requirement.ts');
    const r = spec('decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open AND tasks_applied');
    const out = renderRequirement(
      { item: r, state: 'pending', review: { state: 'pending', hash: null, reviewedAt: null }, drifted: false },
      { index: 1, total: 1, width: 40, glossary: GLOSSARY, summary: { total: 1, accepted: 0, rejected: 0, deferred: 0, pending: 1, drifted: 0, complete: false } },
    );
    expect(out).toContain('decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open AND tasks_applied');
    expect(out).toContain('Reads as:');
  });
});
