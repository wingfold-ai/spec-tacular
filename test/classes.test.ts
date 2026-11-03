import { describe, expect, test } from 'bun:test';
import {
  classOfBoundary,
  classOfChange,
  classOfFile,
  highest,
  readClassMap,
  renderClasses,
} from '../src/core/classes.ts';
import { buildPipeline } from '../src/core/pipeline.ts';
import { classWarnings, gateFor } from '../src/core/gate.ts';
import { nextStep } from '../src/core/guide.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';
import type { ReviewSummary } from '../src/core/review.ts';
import type { TaskProgress } from '../src/core/tasks.ts';

const MAP = readClassMap({
  default: 'P2',
  classes: {
    P0: { why: 'a wrong decision lets unreviewed work through', paths: ['src/core/gate.ts', 'src/auth/'] },
    P1: { paths: ['src/core/**/*.ts'] },
    P3: { paths: ['scripts/'] },
  },
});

describe('reading the class map', () => {
  test('reads areas, the default and no problems', () => {
    expect(MAP.default).toBe('P2');
    expect(MAP.areas.map((a) => a.class)).toEqual(['P0', 'P1', 'P3']);
    expect(MAP.problems).toEqual([]);
  });

  test('reports what it cannot use instead of ignoring it', () => {
    const map = readClassMap({
      default: 'P9',
      classes: { PX: { paths: ['a'] }, P1: {} },
      tailoring: [{ class: 'P0', rule: 'diff-review' }, { class: 'P0', rule: 'nope', reason: 'x' }],
    });
    expect(map.problems).toEqual([
      "default: 'P9' is not one of P0, P1, P2, P3",
      "classes: 'PX' is not one of P0, P1, P2, P3",
      'classes: P1 names no paths',
      'tailoring: diff-review for P0 gives no reason, so it is not applied',
      'tailoring: needs a class (P0, P1, P2, P3) and a rule (diff-review, guard-high-risks)',
    ]);
    expect(map.tailoring).toEqual([]);
  });
});

describe('the class of code', () => {
  test('higher consequence wins where areas overlap', () => {
    expect(classOfFile(MAP, 'src/core/gate.ts')).toBe('P0');
    expect(classOfFile(MAP, 'src/core/review.ts')).toBe('P1');
    expect(classOfFile(MAP, 'src/auth/token.ts')).toBe('P0');
  });

  test('code no area names takes the default', () => {
    expect(classOfFile(MAP, 'README.md')).toBe('P2');
    expect(classOfFile(readClassMap({ classes: { P0: { paths: ['x/'] } } }), 'y.ts')).toBeNull();
  });

  test('a boundary is in the highest class it reaches into', () => {
    expect(classOfBoundary(MAP, ['src/core/'])).toBe('P0');
    expect(classOfBoundary(MAP, ['src/core/review.ts'])).toBe('P1');
    expect(classOfBoundary(MAP, ['scripts/build.ts'])).toBe('P2'); // the default is higher than P3
    expect(classOfBoundary(MAP, ['src/auth/**/*.ts'])).toBe('P0');
  });

  test('highest picks the highest consequence, ignoring nulls', () => {
    expect(highest([null, 'P2', 'P1', null])).toBe('P1');
    expect(highest([null])).toBeNull();
  });
});

describe('the class of a change', () => {
  test('changed code in a higher class raises it, and is named', () => {
    const c = classOfChange(MAP, ['src/core/review.ts'], ['src/core/review.ts', 'src/core/gate.ts']);
    expect(c).toMatchObject({ class: 'P0', declared: 'P1', raisedBy: ['src/core/gate.ts'] });
    expect(c.rules).toEqual(['diff-review', 'guard-high-risks']);
  });

  test('without a boundary, the default is what it declares', () => {
    expect(classOfChange(MAP, null, null)).toMatchObject({ class: 'P2', declared: 'P2', rules: [] });
  });

  test('a waived rule needs a reason, and keeps it', () => {
    const map = readClassMap({
      classes: { P0: { paths: ['src/'] } },
      tailoring: [{ class: 'P0', rule: 'diff-review', reason: 'one developer, pair-reviewed in CI' }],
    });
    const c = classOfChange(map, ['src/'], null);
    expect(c.rules).toEqual(['guard-high-risks']);
    expect(c.waived).toEqual([{ class: 'P0', rule: 'diff-review', reason: 'one developer, pair-reviewed in CI' }]);
    expect(renderClasses(map)).toContain('(waived: one developer, pair-reviewed in CI)');
  });
});

describe('the rules in the pipeline', () => {
  const a = (id: string, status: OpenSpecArtifact['status'], requires: string[] = []): OpenSpecArtifact => ({
    id, status, requires, outputPath: `${id}.md`,
  });
  const status: OpenSpecChangeStatus = {
    changeName: 'c',
    schemaName: 'spec-tacular',
    changeRoot: '/tmp/c',
    artifactPaths: {},
    isPlanningComplete: true,
    applyRequires: ['tasks'],
    nextSteps: [],
    artifacts: [
      a('proposal', 'done'),
      a('specs', 'done', ['proposal']),
      a('risks', 'done', ['specs']),
      a('design', 'done', ['specs', 'risks']),
      a('tasks', 'done', ['specs', 'risks', 'design']),
    ],
  };
  const done: ReviewSummary = { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true };
  const accepted = { accepted: true, drifted: false };
  const signoffs = { proposal: accepted, design: accepted, tasks: accepted };
  const tasks: TaskProgress = { total: 2, done: 2, deferred: 0, open: 0, unproven: 0, applied: true };
  const p0 = classOfChange(MAP, ['src/core/gate.ts'], null);
  const risks = { unanswered: [], unguarded: [], unproven: [], outsideBoundary: [], unmitigatedHigh: ['Leak'] };

  test('a P0 change is not implemented until a person accepts its diff', () => {
    const waiting = buildPipeline(status, { specs: done, risks: done }, signoffs, { tasks, consequence: p0 });
    expect(waiting.apply.state).toBe('ready');
    expect(nextStep(waiting, true)).toMatchObject({ actions: ['read'], artifact: 'implementation' });
    expect(classWarnings(waiting)).toContain(
      'a P0 change: read and accept the implementation diff before it counts as implemented',
    );

    const read = buildPipeline(status, { specs: done, risks: done }, signoffs, { tasks, consequence: p0, diff: accepted });
    expect(read.apply.state).toBe('accepted');
  });

  test('code changed since the diff was accepted asks for it again', () => {
    const p = buildPipeline(status, { specs: done, risks: done }, signoffs, {
      tasks, consequence: p0, diff: { accepted: false, drifted: true },
    });
    expect(nextStep(p, true).text).toContain('changed since you accepted it');
  });

  test('a lower class finishes when the tasks do', () => {
    const p2 = classOfChange(MAP, ['README.md'], null);
    expect(buildPipeline(status, { specs: done, risks: done }, signoffs, { tasks, consequence: p2 }).apply.state).toBe('accepted');
  });

  test('a P0 design is refused while a high-severity risk is left unmitigated', () => {
    const p = buildPipeline(status, { specs: done, risks: done }, signoffs, { consequence: p0, risks });
    const gate = gateFor(p, 'design');
    expect(gate.allowed === false && gate.blockers).toEqual([
      'a P0 change cannot leave a high-severity risk unmitigated: "Leak"',
    ]);
  });

  test('waived, it is a warning that says why', () => {
    const map = readClassMap({
      classes: { P0: { paths: ['src/'] } },
      tailoring: [{ class: 'P0', rule: 'guard-high-risks', reason: 'prototype for a demo' }],
    });
    const p = buildPipeline(status, { specs: done, risks: done }, signoffs, {
      consequence: classOfChange(map, ['src/'], null), risks,
    });
    const gate = gateFor(p, 'design');
    expect(gate.allowed).toBe(true);
    expect(gate.warnings).toContain('high-severity risks left unmitigated, allowed for P0 because: prototype for a demo');
  });
});
