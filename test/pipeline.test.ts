import { describe, expect, test } from 'bun:test';
import { buildPipeline, sortByProgress } from '../src/core/pipeline.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';

function change(
  name: string,
  artifacts: OpenSpecArtifact[],
  applyRequires = ['tasks'],
): OpenSpecChangeStatus {
  return {
    changeName: name,
    schemaName: 'spec-driven',
    changeRoot: `/tmp/${name}`,
    artifactPaths: {},
    isPlanningComplete: false,
    applyRequires,
    nextSteps: [],
    artifacts,
  };
}

const a = (
  id: string,
  status: OpenSpecArtifact['status'],
  requires: string[] = [],
): OpenSpecArtifact => ({ id, status, requires, outputPath: `${id}.md` });

describe('buildPipeline', () => {
  test('maps OpenSpec statuses onto stage states', () => {
    const p = buildPipeline(
      change('c', [
        a('proposal', 'done'),
        a('specs', 'ready', ['proposal']),
        a('design', 'blocked', ['specs']),
      ]),
    );
    expect(p.stages.map((s) => s.state)).toEqual(['written', 'ready', 'blocked']);
  });

  test('records why a stage is blocked', () => {
    const p = buildPipeline(
      change('c', [a('proposal', 'ready'), a('tasks', 'blocked', ['specs', 'design'])]),
    );
    expect(p.stages[1]!.blockedBy).toEqual(['specs', 'design']);
  });

  test('current stage is the first actionable one, skipping blocked stages', () => {
    const p = buildPipeline(
      change('c', [
        a('proposal', 'done'),
        a('specs', 'ready', ['proposal']),
        a('design', 'blocked', ['specs']),
      ]),
    );
    expect(p.current?.id).toBe('specs');
  });

  test('current is null once every artifact is written', () => {
    const p = buildPipeline(change('c', [a('proposal', 'done'), a('specs', 'done')]));
    expect(p.current).toBeNull();
  });

  test('apply is gated by the schema apply.requires, never "written"', () => {
    const blocked = buildPipeline(change('c', [a('tasks', 'ready')]));
    expect(blocked.apply.state).toBe('blocked');
    expect(blocked.apply.blockedBy).toEqual(['tasks']);

    const ready = buildPipeline(change('c', [a('tasks', 'done')]));
    expect(ready.apply.state).toBe('ready');
  });

  test('apply with no requirements is ready', () => {
    const p = buildPipeline(change('c', [a('proposal', 'ready')], []));
    expect(p.apply.state).toBe('ready');
  });
});

describe('prerequisite gaps (problem-analysis §1)', () => {
  test('flags an artifact whose prerequisite was never written', () => {
    // The real shape seen in OpenSpec's own repo: tasks.md written while
    // design.md does not exist.
    const p = buildPipeline(
      change('c', [
        a('proposal', 'done'),
        a('specs', 'done', ['proposal']),
        a('design', 'ready', ['proposal']),
        a('tasks', 'done', ['specs', 'design']),
      ]),
    );
    expect(p.gaps).toEqual([{ artifact: 'tasks', missing: ['design'] }]);
  });

  test('a consistent change has no gaps', () => {
    const p = buildPipeline(
      change('c', [a('proposal', 'done'), a('specs', 'done', ['proposal'])]),
    );
    expect(p.gaps).toEqual([]);
  });

  test('an unwritten artifact with missing prerequisites is blocked, not a gap', () => {
    const p = buildPipeline(
      change('c', [a('proposal', 'ready'), a('specs', 'blocked', ['proposal'])]),
    );
    expect(p.gaps).toEqual([]);
    expect(p.stages[1]!.state).toBe('blocked');
  });
});

describe('sortByProgress', () => {
  test('least complete first, ties broken by name', () => {
    const far = buildPipeline(change('far', [a('p', 'done'), a('s', 'done')]));
    const near = buildPipeline(change('near', [a('p', 'done'), a('s', 'ready')]));
    const bbb = buildPipeline(change('bbb', [a('p', 'done'), a('s', 'done')]));
    expect(sortByProgress([far, near, bbb]).map((p) => p.name)).toEqual([
      'near',
      'bbb',
      'far',
    ]);
  });

  test('does not mutate its input', () => {
    const one = buildPipeline(change('one', [a('p', 'ready')]));
    const two = buildPipeline(change('two', [a('p', 'done')]));
    const input = [two, one];
    sortByProgress(input);
    expect(input.map((p) => p.name)).toEqual(['two', 'one']);
  });

  test('a change with no artifacts is treated as complete, not divided by zero', () => {
    const empty = buildPipeline(change('empty', []));
    const partial = buildPipeline(change('partial', [a('p', 'ready')]));
    expect(sortByProgress([empty, partial]).map((p) => p.name)).toEqual([
      'partial',
      'empty',
    ]);
  });
});
