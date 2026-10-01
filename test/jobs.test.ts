/** Real processes, real files — the job runner's whole job is surviving both. */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeJobForChange,
  activeJobs,
  cancelJob,
  getJob,
  JobConflictError,
  jobsDir,
  listJobs,
  pruneJobs,
  startJob,
  tailJob,
  type Job,
} from '../src/core/jobs.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-jobs-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (script: string) => ({ command: 'sh', args: ['-c', script] });

const start = (projectRoot: string, script: string, over: Partial<{ change: string; artifact: string }> = {}) =>
  startJob({
    projectRoot,
    change: over.change ?? 'c',
    artifact: over.artifact ?? 'design',
    driver: 'test',
    command: sh(script),
    cwd: projectRoot,
  });

/** Waits for a job to leave `running`, so tests never race the OS. */
async function settle(projectRoot: string, id: string, timeoutMs = 5000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(projectRoot, id);
    if (job && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} never settled (${job?.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('starting and finishing', () => {
  test('records a job and captures its output', async () => {
    const r = root();
    const job = start(r, 'echo hello; echo world');
    expect(job.status).toBe('running');
    expect(existsSync(job.logPath)).toBe(true);

    const done = await settle(r, job.id);
    expect(done.status).toBe('succeeded');
    expect(done.exitCode).toBe(0);
    expect(tailJob(done)).toEqual(['hello', 'world']);
  });

  test('captures stderr too — a failing agent explains itself there', async () => {
    const r = root();
    const job = await settle(r, start(r, 'echo oops >&2; exit 3').id);
    expect(job.status).toBe('failed');
    expect(job.exitCode).toBe(3);
    expect(tailJob(job)).toContain('oops');
  });

  test('returns immediately rather than waiting for the agent', () => {
    // The point of the whole milestone: dispatching must not block.
    const r = root();
    const before = Date.now();
    start(r, 'sleep 5');
    expect(Date.now() - before).toBeLessThan(1500);
  });

  test('a command that does not exist fails the job instead of throwing', async () => {
    const r = root();
    const job = startJob({
      projectRoot: r,
      change: 'c',
      artifact: 'design',
      driver: 'test',
      command: { command: 'definitely-not-a-real-binary-xyz', args: [] },
      cwd: r,
    });
    const done = await settle(r, job.id);
    expect(done.status).toBe('failed');
  });
});

describe('one writer per change', () => {
  test('refuses a second job on the same change', () => {
    // Two agents editing one change's spec files would interleave their edits,
    // and neither result would be the plan anyone reviewed.
    const r = root();
    const first = start(r, 'sleep 5');
    expect(() => start(r, 'sleep 5')).toThrow(JobConflictError);
    expect(activeJobForChange(r, 'c')?.id).toBe(first.id);
  });

  test('allows concurrent jobs on different changes', async () => {
    // Reviewing change B while change A is being implemented is the exit
    // criterion for this milestone.
    const r = root();
    const a = start(r, 'sleep 5', { change: 'a' });
    const b = start(r, 'sleep 5', { change: 'b' });
    expect(activeJobs(r).map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    cancelJob(r, a.id);
    cancelJob(r, b.id);
  });

  test('a finished job no longer blocks the change', async () => {
    const r = root();
    await settle(r, start(r, 'true').id);
    expect(activeJobForChange(r, 'c')).toBeNull();
    expect(() => start(r, 'true')).not.toThrow();
  });
});

describe('cancelling', () => {
  test('stops a running job', async () => {
    const r = root();
    const job = start(r, 'sleep 30');
    expect(cancelJob(r, job.id)).toBe(true);
    expect(getJob(r, job.id)?.status).toBe('cancelled');
  });

  test('cancelling a finished job is a no-op', async () => {
    const r = root();
    const job = await settle(r, start(r, 'true').id);
    expect(cancelJob(r, job.id)).toBe(false);
  });

  test('cancelling an unknown job is a no-op', () => {
    expect(cancelJob(root(), 'nope')).toBe(false);
  });
});

describe('surviving a restart', () => {
  test('a record left running whose process is gone reads as interrupted', () => {
    // Otherwise the job pane claims work is still happening hours after the
    // machine rebooted.
    const r = root();
    mkdirSync(jobsDir(r), { recursive: true });
    const stale: Job = {
      id: 'stale', change: 'c', artifact: 'design', driver: 'test',
      command: 'sh', args: [], cwd: r, status: 'running',
      startedAt: '2020-01-01T00:00:00.000Z',
      pid: 2 ** 22, // far above any real pid
      logPath: join(jobsDir(r), 'stale.log'),
    };
    writeFileSync(join(jobsDir(r), 'stale.json'), JSON.stringify(stale));

    expect(listJobs(r)[0]!.status).toBe('interrupted');
    // And the reconciliation is persisted, not recomputed every read.
    expect(JSON.parse(readFileSync(join(jobsDir(r), 'stale.json'), 'utf8')).status).toBe(
      'interrupted',
    );
  });

  test('an outcome recorded with no parent watching is recovered', () => {
    // `spec-tacular run` dispatches and exits, so by the time the agent
    // finishes there is no spec-tacular process left to see it. The job writes
    // its own exit code; without that every background job would read as
    // `interrupted`.
    const r = root();
    mkdirSync(jobsDir(r), { recursive: true });
    const orphan = (id: string, code: string): void => {
      writeFileSync(
        join(jobsDir(r), `${id}.json`),
        JSON.stringify({
          id, change: id, artifact: 'apply', driver: 'test', command: 'sh', args: [],
          cwd: r, status: 'running', startedAt: '2020-01-01T00:00:00.000Z',
          pid: 2 ** 22, logPath: join(jobsDir(r), `${id}.log`),
        }),
      );
      writeFileSync(join(jobsDir(r), `${id}.exit`), code);
    };
    orphan('ok', '0');
    orphan('bad', '2');

    const byId = new Map(listJobs(r).map((j) => [j.id, j]));
    expect(byId.get('ok')?.status).toBe('succeeded');
    expect(byId.get('ok')?.exitCode).toBe(0);
    expect(byId.get('bad')?.status).toBe('failed');
    expect(byId.get('bad')?.exitCode).toBe(2);
  });

  test('a garbled exit file is treated as no outcome at all', () => {
    const r = root();
    mkdirSync(jobsDir(r), { recursive: true });
    writeFileSync(
      join(jobsDir(r), 'x.json'),
      JSON.stringify({
        id: 'x', change: 'c', artifact: 'apply', driver: 'test', command: 'sh', args: [],
        cwd: r, status: 'running', startedAt: '2020-01-01T00:00:00.000Z',
        pid: 2 ** 22, logPath: join(jobsDir(r), 'x.log'),
      }),
    );
    writeFileSync(join(jobsDir(r), 'x.exit'), 'not-a-number');
    expect(listJobs(r)[0]!.status).toBe('interrupted');
  });

  test('a prompt containing quotes and newlines survives the wrapper', async () => {
    // The wrapper passes argv through as "$0" "$@" rather than interpolating,
    // so a prompt is never re-parsed by the shell.
    const r = root();
    const nasty = 'a "quoted" $(echo pwned) \'single\'\nsecond line';
    const job = await settle(
      r,
      startJob({
        projectRoot: r, change: 'c', artifact: 'design', driver: 'test',
        command: { command: 'printf', args: ['%s', nasty] },
        cwd: r,
      }).id,
    );
    expect(job.status).toBe('succeeded');
    expect(tailJob(job).join('\n')).toContain('$(echo pwned)');
  });

  test('a still-running job is found again after a reload', () => {
    const r = root();
    const job = start(r, 'sleep 5');
    expect(listJobs(r).find((j) => j.id === job.id)?.status).toBe('running');
    cancelJob(r, job.id);
  });

  test('a malformed record does not hide the others', () => {
    const r = root();
    mkdirSync(jobsDir(r), { recursive: true });
    writeFileSync(join(jobsDir(r), 'broken.json'), '{not json');
    const job = start(r, 'true');
    expect(listJobs(r).map((j) => j.id)).toContain(job.id);
  });

  test('no jobs directory is an empty list, not an error', () => {
    expect(listJobs(root())).toEqual([]);
  });
});

describe('listing and pruning', () => {
  test('newest first', async () => {
    const r = root();
    const first = await settle(r, start(r, 'true', { change: 'a' }).id);
    await new Promise((res) => setTimeout(res, 1100)); // ids are second-resolution
    const second = await settle(r, start(r, 'true', { change: 'b' }).id);
    expect(listJobs(r).map((j) => j.id)).toEqual([second.id, first.id]);
  });

  test('prune removes finished jobs and their logs but never running ones', async () => {
    const r = root();
    const finished = await settle(r, start(r, 'true', { change: 'a' }).id);
    const running = start(r, 'sleep 5', { change: 'b' });

    expect(pruneJobs(r)).toBe(1);
    expect(existsSync(finished.logPath)).toBe(false);
    expect(listJobs(r).map((j) => j.id)).toEqual([running.id]);
    cancelJob(r, running.id);
  });

  test('tail limits how much it returns', async () => {
    const r = root();
    const job = await settle(r, start(r, 'for i in 1 2 3 4 5; do echo $i; done').id);
    expect(tailJob(job, 2)).toEqual(['4', '5']);
  });

  test('tailing a job whose log is gone returns nothing', async () => {
    const r = root();
    const job = await settle(r, start(r, 'true').id);
    rmSync(job.logPath);
    expect(tailJob(job)).toEqual([]);
  });
});
