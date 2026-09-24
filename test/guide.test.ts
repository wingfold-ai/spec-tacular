import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerFoundation,
  foundationDir,
  guidedQuestions,
  scaffoldFoundation,
} from '../src/core/foundation.ts';
import { nextStep, projectStage, setupStep, setupSteps, validateChangeName } from '../src/core/guide.ts';
import { isGreenfield, VisionInterviewer } from '../src/core/vision.ts';
import { buildPipeline } from '../src/core/pipeline.ts';
import type { ReviewSummary } from '../src/core/review.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';
import { resolveEditor } from '../src/tui/editor.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-guide-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const withOpenSpec = () => {
  const r = root();
  mkdirSync(join(r, 'openspec', 'changes'), { recursive: true });
  return r;
};

const answerAll = (r: string) => {
  for (const q of guidedQuestions(r)) answerFoundation(q.item, 'Decided.');
};

const a = (
  id: string,
  status: OpenSpecArtifact['status'],
  requires: string[] = [],
): OpenSpecArtifact => ({ id, status, requires, outputPath: `${id}.md` });

const change = (artifacts: OpenSpecArtifact[]): OpenSpecChangeStatus => ({
  changeName: 'add-login',
  schemaName: 'spec-tacular',
  changeRoot: '/tmp/add-login',
  artifactPaths: {},
  isPlanningComplete: false,
  applyRequires: ['tasks'],
  nextSteps: [],
  artifacts,
});

const summary = (over: Partial<ReviewSummary>): ReviewSummary => ({
  total: 3, accepted: 0, rejected: 0, deferred: 0, pending: 3, drifted: 0, complete: false,
  ...over,
});

describe('where a project is', () => {
  test('walks set up → ground rules → first change → working', () => {
    const bare = root();
    expect(projectStage(bare, 0)).toEqual({ kind: 'no-openspec' });

    const r = withOpenSpec();
    expect(projectStage(r, 0)).toEqual({ kind: 'no-foundation' });

    scaffoldFoundation(r);
    const open = projectStage(r, 0);
    expect(open.kind).toBe('foundation');
    expect(open).toMatchObject({ answered: 0 });

    answerAll(r);
    // A new project describes its vision before its first change…
    expect(projectStage(r, 0)).toEqual({ kind: 'vision' });
    // …unless it says it is not new.
    new VisionInterviewer(r, async () => ({})).skip();
    expect(projectStage(r, 0)).toEqual({ kind: 'no-changes' });
    expect(projectStage(r, 1)).toEqual({ kind: 'working' });
  });

  test('a project with baseline specs goes straight to its first change', () => {
    const r = withOpenSpec();
    mkdirSync(join(r, 'openspec', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(r, 'openspec', 'specs', 'auth', 'spec.md'), '# Auth\n');
    scaffoldFoundation(r);
    answerAll(r);
    expect(isGreenfield(r)).toBe(false);
    expect(projectStage(r, 0)).toEqual({ kind: 'no-changes' });
    expect(setupSteps(false)).toEqual(['Set up', 'Ground rules', 'First change']);
    expect(setupSteps(true)).toEqual(['Set up', 'Ground rules', 'Vision', 'First change']);
    expect(setupStep({ kind: 'no-changes' }, true)).toBe(3);
  });

  test('a project with changes but no Foundation is not sent back to setup', () => {
    // It adopted OpenSpec before spec-tacular; the gate lets it proceed too.
    expect(projectStage(withOpenSpec(), 2)).toEqual({ kind: 'working' });
  });

  test('the stepper ends once there is a change', () => {
    expect(setupStep({ kind: 'no-openspec' })).toBe(0);
    expect(setupStep({ kind: 'foundation', answered: 1, total: 19 })).toBe(1);
    expect(setupStep({ kind: 'no-changes' })).toBe(2);
    expect(setupStep({ kind: 'working' })).toBeNull();
  });
});

describe('the guided questions', () => {
  test('are asked stack, domain, architecture, conventions — with hints', () => {
    const r = root();
    scaffoldFoundation(r);
    const qs = guidedQuestions(r);
    expect([...new Set(qs.map((q) => q.title))]).toEqual([
      'Stack', 'Domain', 'Architecture', 'Conventions',
    ]);
    expect(qs.every((q) => q.hint !== '' && !q.answered)).toBe(true);
    expect(qs.find((q) => q.title === 'Architecture')!.hint).toContain('Clean architecture');
  });

  test('an answer replaces the placeholder and nothing else', () => {
    const r = root();
    scaffoldFoundation(r);
    const [first, second] = guidedQuestions(r);
    expect(answerFoundation(first!.item, 'TypeScript 5.6 on Bun 1.4')).toEqual({ ok: true });

    const file = readFileSync(join(foundationDir(r), 'stack.md'), 'utf8');
    expect(file).toContain('## Language and runtime, with versions.\n\nTypeScript 5.6 on Bun 1.4\n\n## Framework');
    const after = guidedQuestions(r);
    expect(after[0]!.answered).toBe(true);
    expect(after[1]!.item.name).toBe(second!.item.name);
    expect(after[1]!.answered).toBe(false);
  });

  test('re-answering replaces the previous answer', () => {
    const r = root();
    scaffoldFoundation(r);
    answerFoundation(guidedQuestions(r)[0]!.item, 'Python');
    answerFoundation(guidedQuestions(r)[0]!.item, 'Go 1.23');
    const file = readFileSync(join(foundationDir(r), 'stack.md'), 'utf8');
    expect(file).toContain('Go 1.23');
    expect(file).not.toContain('Python');
  });

  test('an empty answer is refused rather than silently leaving it open', () => {
    const r = root();
    scaffoldFoundation(r);
    expect(answerFoundation(guidedQuestions(r)[0]!.item, '  ').ok).toBe(false);
  });

  test('a question removed from the file since it was read is refused', () => {
    const r = root();
    scaffoldFoundation(r);
    const q = guidedQuestions(r)[0]!;
    writeFileSync(q.item.file, '# Stack\n\n## Something else\n\nTBD\n');
    expect(answerFoundation(q.item, 'Bun').ok).toBe(false);
  });

  test('a section a human added is asked too, after the scaffold’s own', () => {
    const r = root();
    scaffoldFoundation(r);
    writeFileSync(join(foundationDir(r), 'security.md'), '# Security\n\n## Threat model\n\nTBD\n');
    const last = guidedQuestions(r).at(-1)!;
    expect(last.item.name).toBe('Threat model');
    expect(last.hint).toBe('');
  });
});

describe('the next step for a change', () => {
  test('a fresh change asks for its proposal, offering both ways to write it', () => {
    const p = buildPipeline(change([a('proposal', 'ready'), a('specs', 'blocked', ['proposal'])]));
    const step = nextStep(p, true);
    expect(step.text).toContain('Write the proposal');
    expect(step.actions).toEqual(['draft', 'write']);
    expect(step.artifact).toBe('proposal');
  });

  test('unsettled ground rules come before the proposal', () => {
    const p = buildPipeline(change([a('proposal', 'ready')]));
    const step = nextStep(p, false);
    expect(step.actions).toEqual(['foundation']);
    expect(step.text).toContain('ground rules');
  });

  test('written specs send you to review them', () => {
    const p = buildPipeline(
      change([a('proposal', 'done'), a('specs', 'done', ['proposal']), a('design', 'ready', ['specs'])]),
      { specs: summary({ pending: 2, accepted: 1 }) },
    );
    const step = nextStep(p, true);
    expect(step.actions).toEqual(['review']);
    expect(step.text).toContain('2 requirements waiting');
  });

  test('accepted specs unlock the design', () => {
    const p = buildPipeline(
      change([a('proposal', 'done'), a('specs', 'done', ['proposal']), a('design', 'ready', ['specs'])]),
      { specs: summary({ pending: 0, accepted: 3, complete: true }) },
    );
    expect(nextStep(p, true)).toMatchObject({ artifact: 'design', actions: ['draft', 'write'] });
  });

  test('finished planning offers the implementation', () => {
    const p = buildPipeline(change([a('proposal', 'done'), a('tasks', 'done', ['proposal'])]));
    expect(nextStep(p, true)).toMatchObject({ artifact: 'apply', actions: ['draft'] });
  });
});

describe('small rules', () => {
  test('change names are kebab-case', () => {
    expect(validateChangeName('add-user-login')).toBeNull();
    expect(validateChangeName('')).not.toBeNull();
    expect(validateChangeName('Add Login')).toContain('lowercase');
  });

  test('the editor falls back when $EDITOR is unset', () => {
    expect(resolveEditor({ EDITOR: 'hx' })).toBe('hx');
    expect(resolveEditor({ VISUAL: 'code -w', EDITOR: 'hx' })).toBe('code -w');
    expect(resolveEditor({ PATH: '' })).toBeUndefined();
  });
});
