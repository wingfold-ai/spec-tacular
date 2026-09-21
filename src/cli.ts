#!/usr/bin/env bun
/**
 * spec-tacular entry point.
 *
 * `spectacular`          launch the TUI
 * `spectacular --print`  render the overview as text and exit
 *
 * `--print` is not a degraded mode: it is the same model rendered without a
 * terminal, which is what makes the overview usable in CI and over a pipe.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OpenSpecAdapter, OpenSpecError, isOpenSpecProject } from './adapter/openspec.ts';
import {
  buildPipeline,
  sortByProgress,
  type ChangePipeline,
  type ReviewByArtifact,
} from './core/pipeline.ts';
import { loadChangeReview, specFilesOf, specsArtifactId } from './core/change-review.ts';
import { openSession, type ReviewSession } from './core/session.ts';
import { saveReview } from './core/review.ts';
import type { OpenSpecChangeStatus } from './adapter/types.ts';
import { renderOverview } from './render/text.ts';
import { gateFor } from './core/gate.ts';
import { initProject, SCHEMA_NAME } from './core/init.ts';
import { buildContext, buildPrompt } from './core/context.ts';
import {
  activeJobForChange,
  cancelJob,
  JobConflictError,
  listJobs,
  startJob,
  tailJob,
} from './core/jobs.ts';
import { defaultRegistry, DEFAULT_DRIVER } from './agent/index.ts';

type Command = 'overview' | 'init' | 'instructions' | 'run' | 'jobs';

interface Args {
  command: Command;
  /** For `instructions`: the artifact to write. */
  artifact: string | undefined;
  change: string | undefined;
  cwd: string;
  print: boolean;
  bin: string | undefined;
  force: boolean;
  help: boolean;
  driver: string;
  /** For `jobs`: a job id to cancel or tail. */
  job: string | undefined;
  cancel: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'overview',
    artifact: undefined,
    change: undefined,
    cwd: process.cwd(),
    print: false,
    bin: undefined,
    force: false,
    help: false,
    driver: DEFAULT_DRIVER,
    job: undefined,
    cancel: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print' || a === '-p') args.print = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--force' || a === '-f') args.force = true;
    else if (a === '--cwd') args.cwd = argv[++i] ?? args.cwd;
    else if (a === '--change' || a === '-c') args.change = argv[++i];
    else if (a === '--openspec-bin') args.bin = argv[++i];
    else if (a === '--driver') args.driver = argv[++i] ?? args.driver;
    else if (a === '--job') args.job = argv[++i];
    else if (a === '--cancel') args.cancel = true;
    else if (a !== undefined && !a.startsWith('-')) positional.push(a);
  }

  const [first, second] = positional;
  if (first === 'init') args.command = 'init';
  else if (first === 'jobs') args.command = 'jobs';
  else if (first === 'instructions' || first === 'run') {
    args.command = first === 'run' ? 'run' : 'instructions';
    args.artifact = second;
  }
  return args;
}

const HELP = `spec-tacular — spec-driven development, reviewable

Usage:
  spectacular                              Launch the TUI
  spectacular --print                      Print the overview as text
  spectacular init                         Install the spec-tacular schema
  spectacular instructions <artifact> -c <change>
                                           Instructions for writing an artifact,
                                           refused while its prerequisites are
                                           not accepted
  spectacular run <artifact> -c <change>   Dispatch an agent in the background
                                           to write it. Returns immediately.
  spectacular jobs                         List background jobs
  spectacular jobs --job <id>              Tail one job's output
  spectacular jobs --job <id> --cancel     Stop a running job

Options:
  -p, --print            Print the overview as text and exit
  -c, --change <name>    The change to act on
      --cwd <dir>        Project root (default: current directory)
      --openspec-bin <p> Path to the openspec binary
      --driver <name>    Agent to run (claude, opencode). Default: claude
  -f, --force            Overwrite an existing schema install
  -h, --help             Show this help
`;

async function loadPipelines(
  adapter: OpenSpecAdapter,
  projectRoot: string,
): Promise<{
  pipelines: ChangePipeline[];
  failed: string[];
  statuses: Map<string, OpenSpecChangeStatus>;
}> {
  const { changes, failed } = await adapter.statusAll();
  const statuses = new Map(changes.map((c) => [c.changeName, c]));

  const pipelines = changes.map((status) => {
    const reviews: Record<string, ReviewByArtifact[string]> = {};
    // Only an artifact that actually carries requirements gets review state.
    // Attaching an empty summary elsewhere would read as "reviewed, zero
    // requirements" and wrongly mark the stage accepted.
    const specsId = specsArtifactId(status);
    if (specsId && specFilesOf(status).length > 0) {
      reviews[specsId] = loadChangeReview(projectRoot, status).summary;
    }
    return buildPipeline(status, reviews);
  });

  return { pipelines: sortByProgress(pipelines), failed, statuses };
}

/** `spectacular init` — install the schema that enforces the sequencing. */
function runInit(args: Args): number {
  const schemaDir = join(args.cwd, 'openspec', 'schemas', SCHEMA_NAME);
  if (existsSync(schemaDir) && !args.force) {
    process.stderr.write(
      `${SCHEMA_NAME} is already installed at ${schemaDir}.\n` +
        'Re-run with --force to replace it (local edits to it will be lost).\n',
    );
    return 1;
  }

  const result = initProject(args.cwd);
  process.stdout.write(`Installed the ${SCHEMA_NAME} schema to ${result.schemaDir}\n`);
  for (const file of result.files) process.stdout.write(`  ${file}\n`);
  for (const note of result.notes) process.stdout.write(`\n${note}\n`);
  process.stdout.write(
    '\ndesign now requires specs, so a design cannot be written against\n' +
      'requirements nobody has agreed to yet.\n',
  );
  return 0;
}

/**
 * Runs the gate and reports it. Shared by `instructions` and `run` so an agent
 * dispatched in the background can never bypass a check the foreground honours.
 */
async function checkGate(
  args: Args,
  adapter: OpenSpecAdapter,
  verb: string,
): Promise<{ ok: false; code: number } | { ok: true; artifact: string; change: string }> {
  if (!args.artifact || !args.change) {
    process.stderr.write(`Usage: spectacular ${verb} <artifact> --change <name>\n`);
    return { ok: false, code: 1 };
  }

  const { pipelines } = await loadPipelines(adapter, args.cwd);
  const pipeline = pipelines.find((p) => p.name === args.change);
  if (!pipeline) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return { ok: false, code: 1 };
  }

  const gate = gateFor(pipeline, args.artifact);

  // Warnings print either way. A prerequisite that drifted is worth knowing
  // about whether or not something else also blocks — dropping it on refusal
  // would hide it exactly when several things are wrong at once.
  for (const warning of gate.warnings) process.stderr.write(`Warning: ${warning}\n`);

  if (!gate.allowed) {
    process.stderr.write(`Refused: ${gate.reason}\n`);
    for (const blocker of gate.blockers) process.stderr.write(`  - ${blocker}\n`);
    process.stderr.write(
      `\nReview it first: spectacular --cwd ${args.cwd}, select ${args.change}, press enter.\n`,
    );
    return { ok: false, code: 1 };
  }
  return { ok: true, artifact: args.artifact, change: args.change };
}

/**
 * `spectacular instructions <artifact> -c <change>` — the gate, plus the
 * prompt an agent would receive. Useful on its own for piping into a tool
 * spec-tacular has no driver for.
 */
async function runInstructions(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const gate = await checkGate(args, adapter, 'instructions');
  if (!gate.ok) return gate.code;
  process.stdout.write(await composePrompt(args, adapter, gate.artifact, gate.change));
  return 0;
}

/** Context bundle plus OpenSpec's instructions — exactly what a job runs on. */
async function composePrompt(
  args: Args,
  adapter: OpenSpecAdapter,
  artifact: string,
  change: string,
): Promise<string> {
  const instructions = await adapter.instructions(artifact, change);
  const status = (await adapter.statusAll()).changes.find((c) => c.changeName === change);
  const reviewed = status ? loadChangeReview(args.cwd, status).requirements : [];
  return buildPrompt(buildContext(args.cwd, reviewed), instructions);
}

/**
 * `spectacular run <artifact> -c <change>` — dispatch and return.
 *
 * Returning immediately is the point: this is what lets you review one change
 * while another is being implemented, in one terminal.
 */
async function runAgent(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const gate = await checkGate(args, adapter, 'run');
  if (!gate.ok) return gate.code;

  let driver;
  try {
    driver = defaultRegistry().get(args.driver);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const prompt = await composePrompt(args, adapter, gate.artifact, gate.change);

  try {
    const job = startJob({
      projectRoot: args.cwd,
      change: gate.change,
      artifact: gate.artifact,
      driver: driver.id,
      command: driver.build({ prompt, cwd: args.cwd }),
      cwd: args.cwd,
    });
    process.stdout.write(
      `Started ${driver.label} on ${gate.change}/${gate.artifact}\n` +
        `  job:  ${job.id}\n` +
        `  log:  ${job.logPath}\n\n` +
        `Follow it with: spectacular jobs --job ${job.id}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof JobConflictError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** `spectacular jobs` — list, tail, or cancel. */
function runJobs(args: Args): number {
  const driver = defaultRegistry();

  if (args.job) {
    const job = listJobs(args.cwd).find((j) => j.id === args.job || j.id.startsWith(args.job!));
    if (!job) {
      process.stderr.write(`No job matching '${args.job}'.\n`);
      return 1;
    }
    if (args.cancel) {
      const stopped = cancelJob(args.cwd, job.id);
      process.stdout.write(
        stopped ? `Cancelled ${job.id}\n` : `${job.id} is not running (${job.status}).\n`,
      );
      return stopped ? 0 : 1;
    }

    process.stdout.write(
      `${job.change}/${job.artifact}  ${job.status}  started ${job.startedAt}\n\n`,
    );
    let format: (line: string) => string | null;
    try {
      format = driver.get(job.driver).formatLine;
    } catch {
      // A job recorded under a driver this build no longer has is still
      // readable — its log is plain text on disk.
      format = (line) => line;
    }
    for (const line of tailJob(job)) {
      const rendered = format(line);
      if (rendered !== null) process.stdout.write(`${rendered}\n`);
    }
    return 0;
  }

  const jobs = listJobs(args.cwd);
  if (jobs.length === 0) {
    process.stdout.write('No jobs yet.\n');
    return 0;
  }
  for (const job of jobs) {
    const when = job.endedAt ?? job.startedAt;
    process.stdout.write(
      `${job.status.padEnd(11)} ${job.change}/${job.artifact}  ${when}  ${job.id}\n`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!isOpenSpecProject(args.cwd)) {
    process.stderr.write(
      `No openspec/ directory in ${args.cwd}.\n` +
        `spec-tacular works on an OpenSpec project — run \`openspec init\` first,\n` +
        `or point at one with --cwd.\n`,
    );
    return 1;
  }

  if (args.command === 'init') return runInit(args);
  if (args.command === 'jobs') return runJobs(args);

  const adapter = new OpenSpecAdapter({ cwd: args.cwd, bin: args.bin });

  try {
    if (args.command === 'instructions') return await runInstructions(args, adapter);
    if (args.command === 'run') return await runAgent(args, adapter);

    const { pipelines, failed, statuses } = await loadPipelines(adapter, args.cwd);

    if (args.print || !process.stdout.isTTY) {
      process.stdout.write(
        renderOverview(pipelines, {
          color: process.stdout.isTTY === true,
          failed,
          root: args.cwd,
        }) + '\n',
      );
      return 0;
    }

    // Imported lazily so `--print` never pays for the terminal renderer, and
    // so a headless environment can run the text path even if the TUI's
    // native dependencies are unavailable.
    const { startTui } = await import('./tui/app.tsx');

    const queueFor = (change: string) => {
      const status = statuses.get(change);
      if (!status || specFilesOf(status).length === 0) return null;
      return loadChangeReview(args.cwd, status);
    };

    await startTui({
      pipelines,
      failed,
      root: args.cwd,
      openReview: (change): ReviewSession | null => {
        const queue = queueFor(change);
        if (!queue) return null;
        return openSession(
          change,
          queue.requirements.map((r) => r.requirement),
          queue.review,
        );
      },
      saveSession: (session) => saveReview(args.cwd, session.review),
      reparse: (change) =>
        queueFor(change)?.requirements.map((r) => r.requirement) ?? [],
      reloadPipelines: async () => (await loadPipelines(adapter, args.cwd)).pipelines,
      listJobs: () => listJobs(args.cwd),
      tailJob: (job) => {
        let format: (line: string) => string | null;
        try {
          format = defaultRegistry().get(job.driver).formatLine;
        } catch {
          // A job recorded under a driver this build no longer has is still
          // readable — its log is plain text on disk.
          format = (line) => line;
        }
        return tailJob(job)
          .map(format)
          .filter((line): line is string => line !== null);
      },
      cancelJob: (job) => {
        cancelJob(args.cwd, job.id);
      },
    });
    return 0;
  } catch (err) {
    if (err instanceof OpenSpecError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`${err.hint}\n`);
      return 1;
    }
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
