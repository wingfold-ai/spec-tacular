import { describe, expect, test } from 'bun:test';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';
import { gateFor } from '../src/core/gate.ts';
import { nextStep } from '../src/core/guide.ts';
import { buildPipeline, specified } from '../src/core/pipeline.ts';
import { taskProgress } from '../src/core/tasks.ts';

const TASKS = `## 1. Setup
- [x] 1.1 Add the schema
- [ ] 1.2 Wire it up

## 2. Verify
- [ ] 2.1 (defer: awaiting-deployment) Check it on the live site
* [X] 2.2 Run the tests
`;

describe('task progress', () => {
  test('counts ticked, deferred and open tasks', () => {
    expect(taskProgress(TASKS)).toEqual({ total: 4, done: 2, deferred: 1, open: 1, applied: false });
  });

  test('applied once all but the deferred ones are ticked', () => {
    expect(taskProgress(TASKS.replace('- [ ] 1.2', '- [x] 1.2')).applied).toBe(true);
    // A ticked deferred task is simply done.
    expect(taskProgress('- [x] 1.1 (defer: awaiting-deployment) Live check').done).toBe(1);
  });

  test('no tasks is not applied', () => {
    expect(taskProgress('# Tasks\n\nNothing yet.').applied).toBe(false);
  });
});

const a = (id: string, requires: string[] = []): OpenSpecArtifact => ({ id, status: 'done', requires, outputPath: `${id}.md` });
const status: OpenSpecChangeStatus = {
  changeName: 'export',
  schemaName: 'spec-tacular',
  changeRoot: '/tmp/export',
  artifactPaths: {},
  isPlanningComplete: true,
  applyRequires: ['tasks'],
  nextSteps: [],
  artifacts: [a('proposal'), a('specs', ['proposal']), a('design', ['specs']), a('tasks', ['specs', 'design'])],
};
const ACCEPTED = { accepted: true, drifted: false };
const planned = (implementation: Parameters<typeof buildPipeline>[3]) =>
  buildPipeline(
    status,
    { specs: { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true } },
    { proposal: ACCEPTED, design: ACCEPTED, tasks: ACCEPTED },
    implementation,
  );

describe('implementing', () => {
  test('a fully planned change is ready to implement, and says how far it got', () => {
    const p = planned({ tasks: taskProgress(TASKS) });
    expect(specified(p)).toBe(true);
    expect(p.apply.state).toBe('ready');
    expect(nextStep(p, true)).toMatchObject({ actions: ['draft'], artifact: 'apply' });
    expect(nextStep(p, true).text).toBe('2 of 4 tasks ticked off. Carry on implementing — the agent opens right here.');
  });

  test('all tasks ticked but the deferred: implemented', () => {
    const p = planned({ tasks: taskProgress(TASKS.replace('- [ ] 1.2', '- [x] 1.2')) });
    expect(p.apply.state).toBe('accepted');
    const step = nextStep(p, true);
    expect(step.actions).toEqual([]);
    expect(step.text).toContain('Implemented: all 3 tasks are ticked off.');
    expect(step.text).toContain('1 deferred until it is deployed');
  });

  test('a slice waits for the ones before it to be applied — planned, but not implemented', () => {
    const p = planned({ tasks: taskProgress(TASKS), waitingOn: ['auth'] });
    expect(nextStep(p, true)).toEqual({
      text: 'Planned. Implementing it waits for auth to be applied first.',
      actions: [],
    });
    const gate = gateFor(p, 'apply');
    expect(gate.allowed === false && gate.blockers).toEqual(['auth is not applied yet']);
    // What it does is not held up by it; how it is built is.
    expect(gateFor(p, 'specs').allowed).toBe(true);
    expect(gateFor(p, 'tasks').allowed).toBe(false);
  });

  test('specified ahead: the design waits for the code before it', () => {
    const p = buildPipeline(
      { ...status, artifacts: [a('proposal'), a('specs', ['proposal']), { ...a('design', ['specs']), status: 'ready' }, { ...a('tasks', ['specs', 'design']), status: 'blocked' }] },
      { specs: { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true } },
      { proposal: ACCEPTED },
      { waitingOn: ['auth'] },
    );
    expect(specified(p)).toBe(true);
    expect(p.current?.id).toBe('design');
    expect(nextStep(p, true)).toEqual({
      text: 'Specified. The design waits until auth is applied — it builds on that code.',
      actions: [],
    });
    expect(gateFor(p, 'design').allowed === false && gateFor(p, 'design')).toMatchObject({
      blockers: ['auth is not applied yet'],
    });
    // Once auth is applied, the design is next like any other.
    const free = buildPipeline(
      { ...status, artifacts: p.stages.map((st) => ({ id: st.id, requires: st.requires, outputPath: `${st.id}.md`, status: st.state === 'blocked' ? 'blocked' : st.state === 'ready' ? 'ready' : 'done' })) },
      { specs: { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true } },
      { proposal: ACCEPTED },
    );
    expect(nextStep(free, true)).toMatchObject({ actions: ['draft', 'write'], artifact: 'design' });
  });
});
