/**
 * Background jobs.
 *
 * The reason this exists: `openspec apply` occupies your session, so
 * reviewing while implementing means a second terminal and a second agent
 * instance managed by hand (docs/problem-analysis.md §7). Here a job is
 * dispatched, its output streams to a file, and the review loop keeps running.
 *
 * Jobs are spawned detached and recorded on disk, so quitting the TUI does not
 * kill work in progress and relaunching finds it again.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AgentCommand } from '../agent/driver.ts';
import type { ChangePipeline } from './pipeline.ts';

export type JobStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** The process is gone but never recorded an outcome — the TUI died with it. */
  | 'interrupted';

export interface Job {
  id: string;
  change: string;
  /** The artifact being written, or `apply`. */
  artifact: string;
  driver: string;
  command: string;
  args: string[];
  cwd: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  pid?: number;
  /** Path to the job's combined stdout/stderr log. */
  logPath: string;
}

export function jobsDir(projectRoot: string): string {
  return join(projectRoot, '.spec-tacular', 'jobs');
}

const recordPath = (root: string, id: string) => join(jobsDir(root), `${id}.json`);
const logPathFor = (root: string, id: string) => join(jobsDir(root), `${id}.log`);
const exitPathFor = (root: string, id: string) => join(jobsDir(root), `${id}.exit`);

/**
 * The wrapper every job runs under.
 *
 * `spec-tacular run` dispatches and exits, so by the time the agent finishes
 * there is no spec-tacular process left to notice. Without this the outcome
 * would be lost and every background job would read as `interrupted`. The job
 * records its own exit code instead.
 *
 * `"$0" "$@"` rather than interpolating the command keeps it quoting-safe: a
 * prompt containing quotes or newlines is passed through as one argv entry.
 * The final `exit "$ec"` matters as much as the file: without it the wrapper
 * would exit with `printf`'s status, so every job would look successful to a
 * parent still watching.
 */
const EXIT_WRAPPER =
  '"$0" "$@"; ec=$?; printf %s "$ec" > "$SPECTACULAR_EXIT_FILE"; exit "$ec"';

/** The exit code a finished job left behind, if it left one. */
function readExitCode(root: string, id: string): number | null {
  try {
    const raw = readFileSync(exitPathFor(root, id), 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

function newId(change: string, artifact: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${change}-${artifact}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Atomic, so a reader never sees a half-written record. */
function writeRecord(projectRoot: string, job: Job): void {
  mkdirSync(jobsDir(projectRoot), { recursive: true });
  const path = recordPath(projectRoot, job.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Whether a pid is alive. Signal 0 tests for existence without delivering one. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every job on disk, newest first, with dead ones reconciled.
 *
 * A record left `running` whose process is gone is reported as `interrupted`
 * rather than believed: the alternative is a job pane that claims work is
 * still happening hours after the machine rebooted.
 */
export function listJobs(projectRoot: string): Job[] {
  const dir = jobsDir(projectRoot);
  if (!existsSync(dir)) return [];

  const jobs: Job[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const job = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Job;
      if (job.status === 'running' && !isAlive(job.pid)) {
        // The process is gone. Its own exit code, if it recorded one, is the
        // truth; only a job that vanished without recording one is
        // `interrupted`.
        const code = readExitCode(projectRoot, job.id);
        const reconciled: Job =
          code === null
            ? { ...job, status: 'interrupted', endedAt: new Date().toISOString() }
            : {
                ...job,
                status: code === 0 ? 'succeeded' : 'failed',
                exitCode: code,
                endedAt: new Date().toISOString(),
              };
        writeRecord(projectRoot, reconciled);
        jobs.push(reconciled);
      } else {
        jobs.push(job);
      }
    } catch {
      // A malformed record must not hide the others.
    }
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getJob(projectRoot: string, id: string): Job | null {
  return listJobs(projectRoot).find((j) => j.id === id) ?? null;
}

/** Jobs still running, per the reconciliation above. */
export function activeJobs(projectRoot: string): Job[] {
  return listJobs(projectRoot).filter((j) => j.status === 'running');
}

/**
 * The job currently writing to a change, if any.
 *
 * One writer per change: two agents editing the same spec files concurrently
 * would interleave their edits, and neither would be the plan anyone reviewed.
 * Reviews are reads and are never blocked by this.
 */
export function activeJobForChange(projectRoot: string, change: string): Job | null {
  return activeJobs(projectRoot).find((j) => j.change === change) ?? null;
}

export class JobConflictError extends Error {
  constructor(readonly existing: Job) {
    super(
      `${existing.change} already has a running job (${existing.artifact}, started ${existing.startedAt}). ` +
        'Wait for it or cancel it first.',
    );
    this.name = 'JobConflictError';
  }
}

export interface StartJobOptions {
  projectRoot: string;
  change: string;
  artifact: string;
  driver: string;
  command: AgentCommand;
  cwd: string;
}

export function startJob(options: StartJobOptions): Job {
  const existing = activeJobForChange(options.projectRoot, options.change);
  if (existing) throw new JobConflictError(existing);

  const id = newId(options.change, options.artifact);
  const logPath = logPathFor(options.projectRoot, id);
  mkdirSync(jobsDir(options.projectRoot), { recursive: true });
  writeFileSync(logPath, '', 'utf8');

  const log = openSync(logPath, 'a');
  try {
    const child = spawn(
      'sh',
      ['-c', EXIT_WRAPPER, options.command.command, ...options.command.args],
      {
        cwd: options.cwd,
        // Detached, so quitting the TUI does not kill work in progress.
        detached: true,
        // stdin closed: a job that stops to ask a question would hang forever
        // with nobody able to answer it.
        stdio: ['ignore', log, log],
        env: { ...process.env, SPECTACULAR_EXIT_FILE: exitPathFor(options.projectRoot, id) },
      },
    );
    child.unref();

    // A spawn that produced no pid failed outright; recording it as `running`
    // would only be reconciled to `interrupted` later, which reads as "we lost
    // it" rather than "it never started".
    if (child.pid === undefined) {
      const failed: Job = {
        id,
        change: options.change,
        artifact: options.artifact,
        driver: options.driver,
        command: options.command.command,
        args: options.command.args,
        cwd: options.cwd,
        status: 'failed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        logPath,
      };
      writeRecord(options.projectRoot, failed);
      return failed;
    }

    const job: Job = {
      id,
      change: options.change,
      artifact: options.artifact,
      driver: options.driver,
      command: options.command.command,
      args: options.command.args,
      cwd: options.cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      pid: child.pid,
      logPath,
    };
    writeRecord(options.projectRoot, job);

    // The record is updated by whoever is still around when the process ends.
    // If nobody is, `listJobs` reconciles it to `interrupted` later.
    child.on('exit', (code, signal) => {
      const status: JobStatus =
        signal === 'SIGTERM' || signal === 'SIGKILL'
          ? 'cancelled'
          : code === 0
            ? 'succeeded'
            : 'failed';
      writeRecord(options.projectRoot, {
        ...job,
        status,
        endedAt: new Date().toISOString(),
        ...(code === null ? {} : { exitCode: code }),
      });
    });

    child.on('error', (err) => {
      appendFileSync(logPath, `\nspec-tacular: could not start the agent: ${err.message}\n`);
      writeRecord(options.projectRoot, {
        ...job,
        status: 'failed',
        endedAt: new Date().toISOString(),
      });
    });

    return job;
  } finally {
    // The child holds its own descriptor; this one has done its job.
    closeSync(log);
  }
}

export function cancelJob(projectRoot: string, id: string): boolean {
  const job = getJob(projectRoot, id);
  if (!job || job.status !== 'running' || job.pid === undefined) return false;
  try {
    // Negative pid kills the whole process group. A detached agent spawns
    // children of its own, and killing only the parent orphans them.
    process.kill(-job.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  writeRecord(projectRoot, {
    ...job,
    status: 'cancelled',
    endedAt: new Date().toISOString(),
  });
  return true;
}

/** The last `limit` lines of a job's log. */
export function tailJob(job: Job, limit = 200): string[] {
  let content: string;
  try {
    content = readFileSync(job.logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-limit);
}

/** A job's whole log, or '' when there is none. */
export function readJobLog(job: Job): string {
  try {
    return readFileSync(job.logPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The draft that stopped short on a change, if its latest job is one.
 *
 * Exit 0 is not proof of work: an agent can finish without writing the file —
 * on purpose, as the design does when the specs it is built on are wrong or
 * ambiguous. Derived rather than recorded, so it survives a restart, and only
 * from the change's latest job: once anything else ran on it — the specs
 * redrafted with what the agent raised, say — the stop has been dealt with.
 */
export function stoppedDraft(jobs: readonly Job[], pipeline: ChangePipeline): Job | null {
  const latest = jobs
    .filter((j) => j.change === pipeline.name)
    .reduce<Job | null>((a, j) => (a === null || j.startedAt > a.startedAt ? j : a), null);
  if (!latest || latest.status !== 'succeeded') return null;
  const stage = pipeline.stages.find((s) => s.id === latest.artifact);
  return stage && (stage.state === 'ready' || stage.state === 'blocked') ? latest : null;
}

/** Removes finished jobs and their logs. Running ones are never touched. */
export function pruneJobs(projectRoot: string): number {
  let removed = 0;
  for (const job of listJobs(projectRoot)) {
    if (job.status === 'running') continue;
    try {
      unlinkSync(recordPath(projectRoot, job.id));
      if (existsSync(job.logPath)) unlinkSync(job.logPath);
      const exitFile = exitPathFor(projectRoot, job.id);
      if (existsSync(exitFile)) unlinkSync(exitFile);
      removed++;
    } catch {
      // Already gone.
    }
  }
  return removed;
}
