import { describe, expect, test } from 'bun:test';
import { buildPipeline } from '../src/core/pipeline.ts';
import { renderOverview, renderPipelineBar } from '../src/render/text.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';

const a = (
  id: string,
  status: OpenSpecArtifact['status'],
  requires: string[] = [],
): OpenSpecArtifact => ({ id, status, requires, outputPath: `${id}.md` });

const status: OpenSpecChangeStatus = {
  changeName: 'add-dark-mode',
  schemaName: 'spec-driven',
  changeRoot: '/tmp/add-dark-mode',
  artifactPaths: {},
  isPlanningComplete: false,
  applyRequires: ['tasks'],
  nextSteps: [],
  artifacts: [
    a('proposal', 'done'),
    a('specs', 'done', ['proposal']),
    a('design', 'ready', ['proposal']),
    a('tasks', 'done', ['specs', 'design']),
  ],
};

describe('renderPipelineBar', () => {
  test('shows every stage plus apply, in schema order', () => {
    const bar = renderPipelineBar(buildPipeline(status));
    expect(bar).toContain('* proposal');
    expect(bar).toContain('> design');
    expect(bar).toContain('apply');
    expect(bar.indexOf('proposal')).toBeLessThan(bar.indexOf('design'));
  });

  test('emits no ANSI codes unless colour is requested', () => {
    expect(renderPipelineBar(buildPipeline(status))).not.toContain('\x1b[');
    expect(renderPipelineBar(buildPipeline(status), { color: true })).toContain('\x1b[');
  });
});

describe('renderOverview', () => {
  const out = renderOverview([buildPipeline(status)], { root: '/tmp/proj' });

  test('names the change and its next actionable stage', () => {
    expect(out).toContain('add-dark-mode');
    expect(out).toContain('next: design');
  });

  test('surfaces an unwritten prerequisite by name', () => {
    expect(out).toContain('tasks exists but design was never written');
  });

  test('states that "written" is not "accepted"', () => {
    expect(out).toContain('not that anyone accepted it');
    expect(out).toContain('review state arrives in M2');
  });

  test('reports changes that failed to load', () => {
    const withFailure = renderOverview([buildPipeline(status)], { failed: ['broken'] });
    expect(withFailure).toContain('failed to load: broken');
  });

  test('handles an empty project without crashing', () => {
    expect(renderOverview([])).toContain('0 changes');
  });
});
