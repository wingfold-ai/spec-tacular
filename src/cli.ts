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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { foundationGate, gateFor } from './core/gate.ts';
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
import { defaultRegistry, DEFAULT_DRIVER, type AgentDriver } from './agent/index.ts';
import { advisorUnavailable, runStructured } from './agent/structured.ts';
import { FoundationAdvisor } from './core/advisor.ts';
import { finalizeVision, isGreenfield, VisionInterviewer } from './core/vision.ts';
import type { VisionPort } from './tui/app.tsx';
import { buildNamePrompt, NAME_SCHEMA, parseNames } from './core/naming.ts';
import { loadLintConfig } from './core/concreteness.ts';
import { listAdrs, promoteDecision, replaceDecisionBody } from './core/decisions.ts';
import {
  answerFoundation,
  foundationDir,
  guidedQuestions,
  isUnanswered,
  loadFoundation,
  scaffoldFoundation,
} from './core/foundation.ts';
import { projectStage, schemaInstalled } from './core/guide.ts';
import { ArchiveBlockedError, planArchive, prepareArchive } from './core/archive.ts';
import { loadRegister, registerPath } from './core/pending.ts';
import { verifyRequirement } from './core/verify.ts';
import {
  completeSlice,
  loadRoadmap,
  nextPromotable,
  promoteSlice,
  roadmapPath,
  saveRoadmap,
  scaffoldRoadmap,
} from './core/roadmap.ts';

type Command =
  | 'overview' | 'init' | 'instructions' | 'run' | 'jobs' | 'adr' | 'foundation'
  | 'archive' | 'pending' | 'verify' | 'roadmap';

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
  /** For `verify`: the requirement name. */
  requirement: string | undefined;
  /** For `roadmap`: the slice to promote or complete. */
  slice: string | undefined;
  done: boolean;
  dryRun: boolean;
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
    requirement: undefined,
    slice: undefined,
    done: false,
    dryRun: false,
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
    else if (a === '--requirement') args.requirement = argv[++i];
    else if (a === '--promote') args.slice = argv[++i];
    else if (a === '--done') { args.done = true; args.slice = argv[++i]; }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a !== undefined && !a.startsWith('-')) positional.push(a);
  }

  const [first, second] = positional;
  if (first === 'init') args.command = 'init';
  else if (first === 'jobs') args.command = 'jobs';
  else if (first === 'adr') args.command = 'adr';
  else if (first === 'foundation') args.command = 'foundation';
  else if (first === 'pending') args.command = 'pending';
  else if (first === 'roadmap') args.command = 'roadmap';
  else if (first === 'archive') {
    args.command = 'archive';
    if (second && !args.change) args.change = second;
  } else if (first === 'verify') {
    args.command = 'verify';
    args.artifact = second;
  }
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
  spectacular foundation                   Show the project's ground rules and
                                           what is still unanswered
  spectacular adr                          List architectural decision records
  spectacular archive <change>             Merge accepted requirements, divert
                                           deferred ones to the register
  spectacular pending                      Requirements waiting on validation
  spectacular verify <capability> --requirement <name>
                                           Move one into the accepted baseline
  spectacular roadmap                      Show the slices
  spectacular roadmap --promote <slice>    Make a slice active
  spectacular roadmap --done <slice>       Mark a slice finished

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
  if (result.foundationCreated.length > 0) {
    process.stdout.write(`\nScaffolded the Foundation at ${foundationDir(args.cwd)}\n`);
    for (const file of result.foundationCreated) process.stdout.write(`  ${file}\n`);
  }
  for (const file of result.foundationSkipped) {
    process.stdout.write(`  ${file} (kept — it already had answers)\n`);
  }
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

  // The first artifact of a change is where the ground rules have to already
  // exist; later ones are downstream of a proposal that already passed this.
  const target = [...pipeline.stages, pipeline.apply].find((st) => st.id === args.artifact);
  if (target && target.requires.length === 0) {
    const foundation = foundationGate(args.cwd);
    for (const warning of foundation.warnings) process.stderr.write(`Warning: ${warning}\n`);
    if (!foundation.allowed) {
      process.stderr.write(`Refused: ${foundation.reason}\n`);
      for (const blocker of foundation.blockers) process.stderr.write(`  - ${blocker}\n`);
      process.stderr.write(
        `\nAnswer them in ${args.cwd}/spec-tacular/foundation, then try again.\n` +
          'See what is outstanding with: spectacular foundation\n',
      );
      return { ok: false, code: 1 };
    }
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
  feedback?: string,
): Promise<string> {
  const base = await adapter.instructions(artifact, change);
  // A redraft: the developer read the draft and said what to change.
  const instructions = feedback
    ? `${base}\n\n# Revision requested\n\nA draft of this artifact already exists. The developer read it and asked for\nthese changes:\n\n> ${feedback.replace(/\n/g, '\n> ')}\n\nRevise the existing file in place. Keep what they did not ask to change.\n`
    : base;
  const status = (await adapter.statusAll()).changes.find((c) => c.changeName === change);
  const reviewed = status ? loadChangeReview(args.cwd, status).requirements : [];
  // What the developer said the change is for, when they created it. OpenSpec
  // keeps it in the change's README but does not put it in the instructions.
  const intent = status ? changeDescription(status.changeRoot) : '';
  const task = intent
    ? `The developer described this change as:\n\n> ${intent.replace(/\n/g, '\n> ')}\n\n${instructions}`
    : instructions;
  return buildPrompt(buildContext(args.cwd, reviewed), task);
}

/** The description a change was created with: its README, minus the heading. */
function changeDescription(changeRoot: string): string {
  try {
    return readFileSync(join(changeRoot, 'README.md'), 'utf8')
      .replace(/^#[^\n]*\n/, '')
      .trim();
  } catch {
    return '';
  }
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

/** `spectacular adr` — the project's durable decisions. */
function runAdrs(args: Args): number {
  const adrs = listAdrs(args.cwd);
  if (adrs.length === 0) {
    process.stdout.write(
      'No architectural decisions recorded yet.\n' +
        'Promote one while reviewing a design: press p on a decision.\n',
    );
    return 0;
  }
  for (const adr of adrs) {
    const padded = String(adr.number).padStart(4, '0');
    const status =
      adr.status === 'superseded'
        ? `superseded${adr.supersededBy ? ` by ADR-${String(adr.supersededBy).padStart(4, '0')}` : ''}`
        : 'accepted';
    process.stdout.write(`ADR-${padded}  ${status.padEnd(26)} ${adr.title}\n`);
  }
  return 0;
}

/** `spectacular foundation` — the ground rules, and what is still TBD. */
function runFoundation(args: Args): number {
  const items = loadFoundation(args.cwd);
  if (items.length === 0) {
    process.stderr.write(
      `No Foundation at ${foundationDir(args.cwd)}.\n` +
        'Run `spectacular init` to scaffold it.\n',
    );
    return 1;
  }

  const unanswered = items.filter(isUnanswered);
  let group = '';
  for (const item of items) {
    if (item.capability !== group) {
      group = item.capability;
      process.stdout.write(`\n${group}\n`);
    }
    process.stdout.write(`  ${isUnanswered(item) ? '○' : '●'} ${item.name}\n`);
  }

  process.stdout.write(
    `\n${items.length - unanswered.length}/${items.length} answered\n`,
  );
  if (unanswered.length > 0) {
    // Not an error: a half-answered Foundation is a normal state to be in
    // while setting a project up.
    process.stdout.write(
      'Unanswered questions are not carried into an agent\'s context — they are\n' +
        'decisions nobody has made yet, not constraints.\n',
    );
  }
  return 0;
}

/** `spectacular pending` — what is waiting on validation. */
function runPending(args: Args): number {
  const entries = loadRegister(args.cwd);
  if (entries.length === 0) {
    process.stdout.write('Nothing is waiting on validation.\n');
    return 0;
  }

  let capability = '';
  for (const entry of entries) {
    if (entry.capability !== capability) {
      capability = entry.capability;
      process.stdout.write(`\n${capability}\n`);
    }
    process.stdout.write(`  ${entry.name}\n`);
    process.stdout.write(`    needs: ${entry.needs}\n`);
    process.stdout.write(`    from:  ${entry.change} (${entry.deferred})\n`);
  }
  process.stdout.write(
    `\n${entries.length} requirement(s) accepted but unverified — not in the baseline.\n` +
      `Register: ${registerPath(args.cwd)}\n`,
  );
  return 0;
}

/** `spectacular verify <capability> --requirement <name>`. */
async function runVerify(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.artifact || !args.requirement) {
    process.stderr.write(
      'Usage: spectacular verify <capability> --requirement "<name>"\n',
    );
    return 1;
  }

  const result = verifyRequirement(args.cwd, args.artifact, args.requirement);
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    return 1;
  }

  process.stdout.write(
    `Verified '${result.entry.name}' into ${result.specFile}\n` +
      (result.created ? '  (the spec did not exist — fill in its Purpose)\n' : ''),
  );

  // This is the one place spec-tacular writes to openspec/specs/, so the
  // result is handed straight back to OpenSpec to confirm it still parses.
  try {
    const validation = await adapter.validate(args.artifact);
    process.stdout.write(validation.trim() ? `${validation.trim()}\n` : 'openspec validate: ok\n');
  } catch (err) {
    process.stderr.write(
      `Written, but openspec could not validate it: ${(err as Error).message}\n`,
    );
    return 1;
  }
  return 0;
}

/** `spectacular archive <change>` — the split. */
async function runArchive(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.change) {
    process.stderr.write('Usage: spectacular archive <change>\n');
    return 1;
  }

  const { changes } = await adapter.statusAll();
  const status = changes.find((c) => c.changeName === args.change);
  if (!status) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
  }

  const queue = loadChangeReview(args.cwd, status);
  const plan = planArchive(args.change, queue.requirements);

  process.stdout.write(
    `${plan.merging.length} requirement(s) merge into the baseline\n` +
      `${plan.diverting.length} divert to pending validation\n`,
  );
  for (const entry of plan.diverting) {
    process.stdout.write(`  ${entry.capability}: ${entry.name} — ${entry.needs}\n`);
  }

  if (plan.unresolved.length > 0) {
    process.stderr.write(
      `\nRefused: ${plan.unresolved.length} requirement(s) are neither accepted nor deferred.\n`,
    );
    for (const id of plan.unresolved) process.stderr.write(`  - ${id}\n`);
    process.stderr.write(
      '\nArchiving now would merge text nobody agreed to — exactly what `--yes` does.\n',
    );
    return 1;
  }

  if (args.dryRun) {
    process.stdout.write('\nDry run — nothing written.\n');
    return 0;
  }

  try {
    const prepared = prepareArchive(args.cwd, args.change, queue.requirements);
    for (const file of prepared.rewritten) process.stdout.write(`  rewrote ${file}\n`);
    for (const file of prepared.removed) {
      process.stdout.write(`  removed ${file} (every requirement in it deferred)\n`);
    }
  } catch (err) {
    if (err instanceof ArchiveBlockedError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // `--yes` is honest here: the only incomplete tasks are ones deliberately
  // deferred, and every deferred requirement is now recorded in the register.
  const output = await adapter.archive(args.change);
  process.stdout.write(output);
  return 0;
}

/** `spectacular roadmap` — show, promote, or complete a slice. */
function runRoadmap(args: Args): number {
  const roadmap = loadRoadmap(args.cwd);
  if (!roadmap) {
    if (scaffoldRoadmap(args.cwd)) {
      process.stdout.write(
        `Created ${roadmapPath(args.cwd)}\n` +
          'Fill in the vision and the slices, then promote one at a time.\n',
      );
      return 0;
    }
    process.stderr.write(`Could not read ${roadmapPath(args.cwd)}.\n`);
    return 1;
  }

  if (args.slice) {
    const result = args.done
      ? completeSlice(roadmap, args.slice)
      : promoteSlice(roadmap, args.slice);
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      return 1;
    }
    saveRoadmap(args.cwd, result.roadmap);
    process.stdout.write(
      args.done
        ? `'${result.slice.id}' is done.\n`
        : `'${result.slice.id}' is now active. Open a change for it:\n` +
            `  openspec new change ${result.slice.id}\n`,
    );
    return 0;
  }

  process.stdout.write(`${roadmap.vision.trim()}\n\n`);
  const MARK: Record<string, string> = { planned: '○', active: '◉', done: '✓' };
  for (const slice of roadmap.slices) {
    const blocked = slice.dependsOn.length > 0 ? `  (after ${slice.dependsOn.join(', ')})` : '';
    process.stdout.write(`${MARK[slice.status]} ${slice.id}${blocked}\n    ${slice.summary}\n`);
  }

  const next = nextPromotable(roadmap);
  const active = roadmap.slices.find((s) => s.status === 'active');
  process.stdout.write(
    active
      ? `\n'${active.id}' is active. One slice at a time keeps the review queue to one change.\n`
      : next
        ? `\nNext: spectacular roadmap --promote ${next.id}\n`
        : '\nNothing left to promote.\n',
  );
  return 0;
}

function describeError(err: unknown): string {
  if (err instanceof OpenSpecError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return (err as Error).message;
}

/**
 * The TUI's one-key setup: OpenSpec if missing, then the schema, then the
 * Foundation questions. Each step is skipped when already done, so it is safe
 * to run on a half-set-up project — and never overwrites a schema someone
 * edited, which `init` only does under `--force`.
 */
async function setUpProject(
  root: string,
  adapter: OpenSpecAdapter,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (!isOpenSpecProject(root)) await adapter.init();
    if (!schemaInstalled(root)) initProject(root);
    else scaffoldFoundation(root);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/** `w` in the TUI: the same gates as `spectacular run`, reported as a line. */
async function dispatch(
  args: Args,
  adapter: OpenSpecAdapter,
  change: string,
  artifact: string,
  feedback?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const { pipelines } = await loadPipelines(adapter, args.cwd);
    const pipeline = pipelines.find((p) => p.name === change);
    if (!pipeline) return { ok: false, message: `No change called '${change}'` };

    const target = [...pipeline.stages, pipeline.apply].find((st) => st.id === artifact);
    if (target && target.requires.length === 0) {
      const foundation = foundationGate(args.cwd);
      if (!foundation.allowed) return { ok: false, message: `Refused: ${foundation.reason}` };
    }
    const gate = gateFor(pipeline, artifact);
    if (!gate.allowed) return { ok: false, message: `Refused: ${gate.reason}` };

    const driver = defaultRegistry().get(args.driver);
    const prompt = await composePrompt(args, adapter, artifact, change, feedback);
    startJob({
      projectRoot: args.cwd,
      change,
      artifact,
      driver: driver.id,
      command: driver.build({ prompt, cwd: args.cwd }),
      cwd: args.cwd,
    });
    return {
      ok: true,
      message: feedback
        ? `${driver.label} is redrafting the ${artifact} with your feedback`
        : `${driver.label} is drafting the ${artifact} — it opens for you when done`,
    };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

/**
 * `e` in the TUI: the file an artifact is written in, seeded with the
 * schema's template when it does not exist yet so a blank page is never the
 * starting point.
 */
async function artifactFile(
  adapter: OpenSpecAdapter,
  statuses: Map<string, OpenSpecChangeStatus>,
  change: string,
  artifact: string,
): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  const paths = statuses.get(change)?.artifactPaths[artifact];
  if (!paths) return { ok: false, reason: `${change} has no artifact called ${artifact}` };
  const file = paths.resolvedOutputPath;
  if (file.includes('*')) {
    return {
      ok: false,
      reason: `${artifact} spans one file per capability — w lets an agent draft them`,
    };
  }
  if (!existsSync(file)) {
    try {
      const template = await adapter.template(artifact, change);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, template.replace('<!-- Change name -->', change), 'utf8');
    } catch (err) {
      return { ok: false, reason: describeError(err) };
    }
  }
  return { ok: true, file };
}

/**
 * The vision interview. Without a model it still records the vision in the
 * developer's own words; there is just no interview and no slicing.
 */
function visionFor(args: Args): VisionPort {
  let driver: AgentDriver | undefined;
  let unavailable: string | null = process.env['SPECTACULAR_NO_ADVISOR']
    ? 'turned off by SPECTACULAR_NO_ADVISOR'
    : null;
  try {
    driver = defaultRegistry().get(args.driver);
    unavailable ??= advisorUnavailable(driver);
  } catch (err) {
    unavailable = (err as Error).message;
  }
  const interviewer = new VisionInterviewer(args.cwd, (prompt, schema) =>
    unavailable || !driver
      ? Promise.reject(new Error(unavailable ?? 'no agent'))
      // The interview reasons about the vision; it has nothing to look up.
      : runStructured(driver, args.cwd, prompt, schema, { mode: 'think' }),
  );
  return {
    unavailable,
    session: () => interviewer.session(),
    start: async (text) => {
      if (!unavailable) return interviewer.start(text);
      // No interview possible: keep the vision, and go on to a change.
      const session = await interviewer.start(text).catch(() => interviewer.session()!);
      finalizeVision(args.cwd, session, text, []);
      interviewer.skip();
      return session;
    },
    answer: (text) => interviewer.answer(text),
    finish: () => interviewer.finish(),
    resume: () => interviewer.resume(),
    extract: (taken) => interviewer.extract(taken),
    skip: () => interviewer.skip(),
    confirm: (text, kept) => finalizeVision(args.cwd, interviewer.session()!, text, kept),
  };
}

/**
 * The setup advisor, when the chosen driver can answer structured requests
 * and is installed. Without one, setup still works — just without proposals.
 */
function advisorFor(args: Args): {
  advisor: FoundationAdvisor | null;
  advisorNote: string | null;
  nameChange?: (description: string, taken: string[]) => Promise<string[]>;
} {
  if (process.env['SPECTACULAR_NO_ADVISOR']) {
    return { advisor: null, advisorNote: 'turned off by SPECTACULAR_NO_ADVISOR' };
  }
  let driver;
  try {
    driver = defaultRegistry().get(args.driver);
  } catch (err) {
    return { advisor: null, advisorNote: (err as Error).message };
  }
  const missing = advisorUnavailable(driver);
  if (missing) return { advisor: null, advisorNote: missing };
  return {
    advisor: new FoundationAdvisor(args.cwd, (prompt, schema) =>
      runStructured(driver, args.cwd, prompt, schema),
    ),
    advisorNote: null,
    nameChange: async (description, taken) =>
      parseNames(
        await runStructured(driver, args.cwd, buildNamePrompt(description, taken), NAME_SCHEMA, {
          mode: 'quick',
          timeoutMs: 60_000,
        }),
        taken,
      ),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // The TUI opens anywhere: in a folder that is not set up yet, it offers to
  // set it up. Every other command needs a project to act on.
  const tui = args.command === 'overview' && !args.print && process.stdout.isTTY === true;
  if (!isOpenSpecProject(args.cwd) && !tui) {
    process.stderr.write(
      `No openspec/ directory in ${args.cwd}.\n` +
        `spec-tacular works on an OpenSpec project — run \`spectacular\` in a terminal\n` +
        `to be guided through setting one up, or point at one with --cwd.\n`,
    );
    return 1;
  }

  if (args.command === 'init') return runInit(args);
  if (args.command === 'jobs') return runJobs(args);
  if (args.command === 'adr') return runAdrs(args);
  if (args.command === 'foundation') return runFoundation(args);
  if (args.command === 'pending') return runPending(args);
  if (args.command === 'roadmap') return runRoadmap(args);

  const adapter = new OpenSpecAdapter({ cwd: args.cwd, bin: args.bin });

  try {
    if (args.command === 'instructions') return await runInstructions(args, adapter);
    if (args.command === 'run') return await runAgent(args, adapter);
    if (args.command === 'archive') return await runArchive(args, adapter);
    if (args.command === 'verify') return await runVerify(args, adapter);

    if (!tui) {
      const { pipelines, failed } = await loadPipelines(adapter, args.cwd);
      process.stdout.write(
        renderOverview(pipelines, {
          color: process.stdout.isTTY === true,
          failed,
          root: args.cwd,
        }) + '\n',
      );
      return 0;
    }

    // Before setup there is nothing to ask OpenSpec about.
    const load = () =>
      isOpenSpecProject(args.cwd)
        ? loadPipelines(adapter, args.cwd)
        : Promise.resolve({ pipelines: [], failed: [], statuses: new Map<string, OpenSpecChangeStatus>() });
    const loaded = await load();
    // Re-read on every reload: a change created, or an artifact an agent just
    // wrote, must be reviewable without restarting.
    let statuses = loaded.statuses;

    // Imported lazily so `--print` never pays for the terminal renderer, and
    // so a headless environment can run the text path even if the TUI's
    // native dependencies are unavailable.
    const { startTui } = await import('./tui/app.tsx');

    const queueFor = (change: string) => {
      const status = statuses.get(change);
      if (!status || specFilesOf(status).length === 0) return null;
      // Decisions ride along in the TUI queue, so reviewing a change walks
      // its requirements and then its design decisions in one pass.
      return loadChangeReview(args.cwd, status, { includeDecisions: true });
    };

    await startTui({
      pipelines: loaded.pipelines,
      failed: loaded.failed,
      root: args.cwd,
      openReview: (change): ReviewSession | null => {
        const queue = queueFor(change);
        if (!queue) return null;
        return openSession(
          change,
          queue.requirements.map((r) => r.item),
          queue.review,
        );
      },
      saveSession: (session) => saveReview(args.cwd, session.review),
      lintConfig: loadLintConfig(args.cwd),
      reparse: (change) =>
        queueFor(change)?.requirements.map((r) => r.item) ?? [],
      reloadPipelines: async () => {
        const fresh = await load();
        statuses = fresh.statuses;
        return fresh.pipelines;
      },
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
      promote: (change, decision) => {
        try {
          const { adr, reference } = promoteDecision(args.cwd, decision, { change });
          const replaced = replaceDecisionBody(decision, reference);
          if (!replaced.ok) return replaced;
          return { ok: true, adr: `ADR-${String(adr.number).padStart(4, '0')}` };
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      },
      stage: () => projectStage(args.cwd, statuses.size),
      setup: () => setUpProject(args.cwd, adapter),
      questions: () => guidedQuestions(args.cwd),
      answer: (question, text) => answerFoundation(question.item, text),
      createChange: async (name, description) => {
        try {
          await adapter.newChange(name, description || undefined);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: describeError(err) };
        }
      },
      dispatch: (change, artifact, feedback) => dispatch(args, adapter, change, artifact, feedback),
      readArtifact: async (change, artifact) => {
        const file = statuses.get(change)?.artifactPaths[artifact]?.resolvedOutputPath;
        if (!file || file.includes('*')) return { ok: false, reason: `${artifact} is not a single document` };
        try {
          return { ok: true, file, content: readFileSync(file, 'utf8') };
        } catch {
          return { ok: false, reason: `${artifact} has not been written yet` };
        }
      },
      greenfield: () => isGreenfield(args.cwd),
      roadmap: () => loadRoadmap(args.cwd),
      vision: visionFor(args),
      ...advisorFor(args),
      artifactFile: (change, artifact) => artifactFile(adapter, statuses, change, artifact),
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
