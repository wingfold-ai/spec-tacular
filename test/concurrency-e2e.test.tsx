/**
 * M5's exit criterion: a job running against one change while another is
 * reviewed, in one process.
 *
 * Uses a real detached subprocess and the real review screen — the thing being
 * proved is that neither blocks the other.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobForChange, cancelJob, getJob, listJobs, startJob } from '../src/core/jobs.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, openSession, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const SPEC = `## ADDED Requirements

### Requirement: Alpha
SHALL alpha.

### Requirement: Beta
SHALL beta.
`;

const dirs: string[] = [];
const renderers: { destroy: () => void }[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-conc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const r of renderers.splice(0)) r.destroy();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reviewing while a job runs', () => {
  test('a long job on change A does not block reviewing change B', async () => {
    const r = root();

    // A slow agent on change A.
    const job = startJob({
      projectRoot: r,
      change: 'change-a',
      artifact: 'apply',
      driver: 'test',
      command: { command: 'sh', args: ['-c', 'echo starting; sleep 30'] },
      cwd: r,
    });
    expect(job.status).toBe('running');

    // Meanwhile, review change B end to end.
    const requirements = parseSpecFile(SPEC, 'cap', '/p/specs/cap/spec.md').requirements;
    const [session, setSession] = createSignal<ReviewSession>(
      openSession('change-b', requirements, emptyReview('change-b')),
    );
    const setup = await testRender(
      () => (
        <ReviewScreen
          session={session()}
          onAccept={() => setSession((s) => decide(s, 'accepted'))}
          onReject={() => {}} onDefer={() => {}} onSkip={() => {}}
          onEdit={() => {}} onMove={() => {}} onBack={() => {}}
        />
      ),
      { width: 90, height: 24 },
    );
    await setup.flush();
    renderers.push({ destroy: () => setup.renderer.destroy() });

    await setup.mockInput.pressKey('a');
    await setup.mockInput.pressKey('a');
    await setup.flush();

    expect(session().summary).toMatchObject({ accepted: 2, complete: true });
    // And the job is still going, untouched by any of it.
    expect(getJob(r, job.id)?.status).toBe('running');

    cancelJob(r, job.id);
  });

  test('two changes can have jobs at once; one change cannot have two', async () => {
    const r = root();
    const spawn = (change: string) =>
      startJob({
        projectRoot: r, change, artifact: 'apply', driver: 'test',
        command: { command: 'sh', args: ['-c', 'sleep 30'] }, cwd: r,
      });

    const a = spawn('change-a');
    const b = spawn('change-b');
    expect(listJobs(r).filter((j) => j.status === 'running')).toHaveLength(2);

    // One writer per change: two agents editing the same files would
    // interleave their edits.
    expect(() => spawn('change-a')).toThrow();
    expect(activeJobForChange(r, 'change-a')?.id).toBe(a.id);

    cancelJob(r, a.id);
    cancelJob(r, b.id);
  });

  test('cancelling one job leaves the other running', async () => {
    const r = root();
    const spawn = (change: string) =>
      startJob({
        projectRoot: r, change, artifact: 'apply', driver: 'test',
        command: { command: 'sh', args: ['-c', 'sleep 30'] }, cwd: r,
      });
    const a = spawn('change-a');
    const b = spawn('change-b');

    cancelJob(r, a.id);
    expect(getJob(r, a.id)?.status).toBe('cancelled');
    expect(getJob(r, b.id)?.status).toBe('running');

    cancelJob(r, b.id);
  });
});
