#!/usr/bin/env bun
/**
 * spec-tacular entry point.
 *
 * `spec-tacular`          launch the TUI
 * `spec-tacular --print`  render the overview as text and exit
 *
 * `--print` is not a degraded mode: it is the same model rendered without a
 * terminal, which is what makes the overview usable in CI and over a pipe.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { OpenSpecAdapter, OpenSpecError, isOpenSpecProject, openSpecToolsInstalled } from './adapter/openspec.ts';
import {
  buildPipeline,
  specified,
  sortByProgress,
  type ChangePipeline,
  type ReviewByArtifact,
  type RiskCheck,
} from './core/pipeline.ts';
import {
  loadChangeReview,
  risksArtifactId,
  risksWritten,
  specFilesOf,
  specsArtifactId,
} from './core/change-review.ts';
import { changedFiles, implementationDiff, outsideBoundary, parseBoundary } from './core/boundary.ts';
import { classesPath, classOfChange, loadClasses, renderClasses } from './core/classes.ts';
import { isRequirement, parseSpecFile, slugify, type ReviewItem } from './core/requirements.ts';
import {
  crossCheck,
  exportFiles,
  fretCli,
  fretFormula,
  monitorability,
  monitorDecision,
  monitorFret,
  readTrace,
} from './core/formal/fret.ts';
import type { Env } from './core/formal/expr.ts';
import { checkDefect, isDefectSchema, parseReport } from './core/defects.ts';
import { changeFormal, checkFormal, formalOf } from './core/formal/formal.ts';
import { fretVariables } from './core/formal/fretish.ts';
import { variablesOf } from './core/formal/expr.ts';
import { glossaryPath, loadGlossary } from './core/formal/glossary.ts';
import {
  changeMatrices,
  removeOrphanMatrices,
  staleMatrices,
  testFileFor,
  writeMatrices,
  writeTests,
  type MatrixEntry,
} from './core/formal/files.ts';
import { matricesFor, matrixLines, requiredRows } from './core/formal/matrix.ts';
import {
  allowSurvivors,
  componentHarness,
  connection,
  isHarnessItem,
  loadAllowed,
  loadCheck,
  runHarnessCheck,
  saveCheck,
} from './core/formal/harness.ts';
import { matrixConfig, matrixVerified } from './core/formal/config.ts';
import type { ReviewedItem } from './core/review.ts';

/**
 * Which components' harnesses are not shown to reach the code, and so which
 * items' matrix results cannot count: each component's harness, its review
 * items' states, and its last check.
 */
function unconnectedItems(
  projectRoot: string,
  entries: MatrixEntry[],
  reviewed: ReviewedItem[],
): { items: Map<string, string>; components: { component: string; because: string[] }[] } {
  const items = new Map<string, string>();
  const components: { component: string; because: string[] }[] = [];
  const byComponent = new Map<string, MatrixEntry[]>();
  for (const e of entries) {
    const c = slugify(e.matrix.component);
    byComponent.set(c, [...(byComponent.get(c) ?? []), e]);
  }
  const config = matrixConfig(projectRoot);
  for (const [component, group] of byComponent) {
    const h = componentHarness(projectRoot, component, config);
    const states = reviewed
      .filter((r) => r.item.capability === `harness/${component}`)
      .map((r) => ({ accepted: r.state === 'accepted' }));
    const matrices = group.map((g) => g.matrix);
    const c = connection(projectRoot, h, matrices, states, undefined, config);
    if (!c.connected) components.push({ component, because: c.because });
    // Each item by its own tests: one matrix's weak harness is not another's.
    const byItem = new Map<string, MatrixEntry[]>();
    for (const g of group) byItem.set(g.item.id, [...(byItem.get(g.item.id) ?? []), g]);
    for (const [id, mine] of byItem) {
      const tests = mine.map((g) => testFileFor(projectRoot, g, config).path);
      const own = connection(projectRoot, h, matrices, states, tests, config);
      if (!own.connected) items.set(id, `harness for ${component} not connected: ${own.because.join('; ')}`);
    }
  }
  return { items, components };
}

/** What spec-tacular writes into a project itself: never outside a change's boundary. */
function generatedPaths(projectRoot: string): string[] {
  const config = matrixConfig(projectRoot);
  return [config.tests, config.runner];
}

/** Per item, why its matrix would show nothing even when every row passes. */
function vacuousItems(entries: MatrixEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) if (e.matrix.vacuous) out.set(e.item.id, `its matrix tests nothing: ${e.matrix.vacuous}`);
  return out;
}

/** Per item, the matrix rows its class requires to have run. */
function rowsRequired(entries: MatrixEntry[], cls: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) out.set(e.item.id, [...(out.get(e.item.id) ?? []), ...requiredRows(e.matrix, cls)]);
  return out;
}
import {
  HAZARD_EVIDENCE,
  hazardRecordsForRun,
  hazardsDir,
  listHazards,
  markReviewed,
  promoteRisks,
  registerStates,
} from './core/hazards.ts';
import {
  appendEvidence,
  changeEvidence,
  loadVerification,
  METHODS,
  orphanTags,
  recordsForRun,
  runTests,
  summarizeEvidence,
  tagFor,
  verificationPath,
  type EvidenceRecord,
  type ItemEvidence,
  type Method,
} from './core/evidence.ts';
import { writeReviewRecord } from './core/review-record.ts';
import { isRisk, unansweredRisks, unguardedRisks, unprovenGuards, type Risk } from './core/risks.ts';
import { openSession, type ReviewSession } from './core/session.ts';
import { clearStopReport, parseStop, readStopReport, saveStopReport, stopInstructions, type StopReport } from './core/stops.ts';
import { loadReview, saveReview, setState } from './core/review.ts';
import { acceptDocument, loadSignoff, type Signoff } from './core/signoff.ts';
import type { OpenSpecChangeStatus } from './adapter/types.ts';
import { renderOverview } from './render/text.ts';
import { foundationGate, gateFor } from './core/gate.ts';
import { DEFECT_SCHEMA_NAME, initProject, SCHEMA_NAME } from './core/init.ts';
import { buildContext, buildPrompt } from './core/context.ts';
import {
  activeJobForChange,
  cancelJob,
  JobConflictError,
  listJobs,
  readJobLog,
  startJob,
  tailJob,
} from './core/jobs.ts';
import { defaultRegistry, DEFAULT_DRIVER } from './agent/index.ts';
import { ALLOW_MCP_HOOK_ARG } from './agent/claude.ts';
import type { AgentCommand } from './agent/driver.ts';
import { version as VERSION } from '../package.json';
import { createAssistants, type Assistants } from './assistants.ts';
import { appendUsageLog, claudeSessionUsage, claudeTranscriptPath, loadUsageLog, type Usage } from './core/usage.ts';
import { isGreenfield } from './core/vision.ts';
import { loadLintConfig } from './core/concreteness.ts';
import { listAdrs, promoteDecision, replaceDecisionBody } from './core/decisions.ts';
import {
  answerFoundation,
  foundationDir,
  guidedQuestions,
  isDeferred,
  isUnanswered,
  loadFoundation,
  scaffoldFoundation,
} from './core/foundation.ts';
import { projectStage, schemaInstalled, validateChangeName } from './core/guide.ts';
import { ArchiveBlockedError, planArchive, prepareArchive } from './core/archive.ts';
import { loadRegister, registerPath } from './core/pending.ts';
import { verifyRequirement } from './core/verify.ts';
import { refineContext } from './core/refine.ts';
import {
  completeSlice,
  loadRoadmap,
  markApplied,
  nextPromotable,
  promoteSlice,
  roadmapPath,
  saveRoadmap,
  scaffoldRoadmap,
  waitingOn,
} from './core/roadmap.ts';
import { taskProgress } from './core/tasks.ts';
import { implementingNow, openElsewhere, writeSessionScript } from './tui/tabs.ts';

type Command =
  | 'overview' | 'init' | 'instructions' | 'run' | 'jobs' | 'adr' | 'foundation'
  | 'archive' | 'pending' | 'verify' | 'roadmap' | 'classes' | 'diff' | 'evidence' | 'hazards' | 'defect'
  | 'glossary' | 'matrix' | 'harness' | 'fret' | 'monitor';

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
  version: boolean;
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
  /** For `diff`: record that the diff shown was read and accepted. */
  accept: boolean;
  /** For `evidence`: run the tests first. */
  run: boolean;
  /** For `evidence`: an item to sign off (`--sign`) or waive (`--waive`). */
  sign: string | undefined;
  waive: string | undefined;
  method: string | undefined;
  /** What was checked, for a sign-off; why, for a waiver. */
  note: string | undefined;
  /** For `hazards`: the hazard a person just looked at again. */
  reviewed: string | undefined;
  /** For `defect`: what went wrong, in a sentence or two. */
  description: string | undefined;
  /** For `matrix`: also write the runner and the test files. */
  write: boolean;
  /** For `harness`: run the coverage and mutation check. */
  check: boolean;
  /** For `harness`: allow the last check's surviving mutants, saying why. */
  allowSurvivors: string | undefined;
  /** For `fret`: check, export or realizability. */
  sub: string | undefined;
  /** For `monitor`: the recorded run; for `fret realizability`: the component. */
  target: string | undefined;
  /** For `fret export`: where the files go. */
  out: string | undefined;
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
    version: false,
    driver: DEFAULT_DRIVER,
    job: undefined,
    cancel: false,
    requirement: undefined,
    slice: undefined,
    done: false,
    dryRun: false,
    accept: false,
    run: false,
    sign: undefined,
    waive: undefined,
    method: undefined,
    note: undefined,
    reviewed: undefined,
    description: undefined,
    write: false,
    check: false,
    allowSurvivors: undefined,
    sub: undefined,
    target: undefined,
    out: undefined,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print' || a === '-p') args.print = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-V') args.version = true;
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
    else if (a === '--accept') args.accept = true;
    else if (a === '--run') args.run = true;
    else if (a === '--sign') args.sign = argv[++i];
    else if (a === '--waive') args.waive = argv[++i];
    else if (a === '--method') args.method = argv[++i];
    else if (a === '--note' || a === '--reason') args.note = argv[++i];
    else if (a === '--reviewed') args.reviewed = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--write') args.write = true;
    else if (a === '--check') args.check = true;
    else if (a === '--allow-survivors') args.allowSurvivors = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a !== undefined && !a.startsWith('-')) positional.push(a);
  }

  const [first, second, third] = positional;
  if (first === 'init') args.command = 'init';
  else if (first === 'jobs') args.command = 'jobs';
  else if (first === 'adr') args.command = 'adr';
  else if (first === 'foundation') args.command = 'foundation';
  else if (first === 'pending') args.command = 'pending';
  else if (first === 'roadmap') args.command = 'roadmap';
  else if (first === 'classes') args.command = 'classes';
  else if (first === 'hazards') args.command = 'hazards';
  else if (first === 'glossary') args.command = 'glossary';
  else if (first === 'matrix') {
    args.command = 'matrix';
    if (second && !args.change) args.change = second;
  } else if (first === 'harness') {
    args.command = 'harness';
    if (second && !args.change) args.change = second;
  } else if (first === 'fret') {
    args.command = 'fret';
    args.sub = second;
    // `fret check <change>`, `fret export <change>`, `fret realizability <project> <component>`
    if (second === 'realizability') {
      args.target = positional[3];
      if (third) args.change = third;
    } else if (third && !args.change) args.change = third;
  } else if (first === 'monitor') {
    args.command = 'monitor';
    args.target = second;
    if (third && !args.change) args.change = third;
  }
  else if (first === 'defect') {
    args.command = 'defect';
    if (second && !args.change) args.change = second;
  }
  else if (first === 'evidence') {
    args.command = 'evidence';
    if (second && !args.change) args.change = second;
  }
  else if (first === 'diff') {
    args.command = 'diff';
    if (second && !args.change) args.change = second;
  } else if (first === 'archive') {
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
  spec-tacular                              Launch the TUI
  spec-tacular --print                      Print the overview as text
  spec-tacular init                         Install the spec-tacular schema
  spec-tacular instructions <artifact> -c <change>
                                            Instructions for writing an artifact,
                                            refused while its prerequisites are
                                            not accepted
  spec-tacular run <artifact> -c <change>   Dispatch an agent in the background
                                            to write it. Returns immediately.
  spec-tacular jobs                         List background jobs
  spec-tacular jobs --job <id>              Tail one job's output
  spec-tacular jobs --job <id> --cancel     Stop a running job
  spec-tacular foundation                   Show the project's ground rules and
                                            what is still unanswered
  spec-tacular adr                          List architectural decision records
  spec-tacular archive <change>             Merge accepted requirements, divert
                                            deferred ones to the register
  spec-tacular pending                      Requirements waiting on validation
  spec-tacular verify <capability> --requirement <name>
                                            Move one into the accepted baseline
  spec-tacular roadmap                      Show the slices
  spec-tacular roadmap --promote <slice>    Make a slice active
  spec-tacular roadmap --done <slice>       Mark a slice finished
  spec-tacular classes                      Consequence classes, their rules,
                                            and the class of each change
  spec-tacular diff <change> [--accept]     Read the code the agent wrote, and
                                            accept it (required for P0)
  spec-tacular evidence [<change>] [--run]  The verification matrix: each item,
                                            its method, tests and status
  spec-tacular evidence -c <change> --sign <item> --method <m> --note <what>
                                            Record an analysis, inspection or
                                            demonstration
  spec-tacular evidence -c <change> --waive <item> --reason <why>
                                            Waive an item, with justification
  spec-tacular hazards                      The hazard register, each hazard's
                                            status by its guards' results
  spec-tacular hazards --reviewed <HAZ-n>   Record a look at one
  spec-tacular defect <name> [--description <text>]
                                            Start a change that fixes a defect
  spec-tacular glossary                     The variables formal requirements
                                            use, and what is missing
  spec-tacular matrix [<change>] [--write]  Generate the test matrix of each
                                            formal requirement; --write also
                                            writes the runner and the tests
  spec-tacular harness [<change>] [--check] Whether each matrix's harness
                                            reaches the real code; --check
                                            runs coverage and mutants;
                                            --allow-survivors "<why>" allows
                                            the changes no matrix caught;
                                            --accept accepts the harness you
                                            have read
  spec-tacular fret check [<change>]        Compare spec-tacular's reading of
                                            each FRETish requirement with FRET's
  spec-tacular fret export [<change>] [--out <dir>]
                                            Requirements and glossary for FRET
  spec-tacular fret realizability <project> <component>
                                            FRET's realizability check
  spec-tacular monitor <trace.jsonl> [<change>]
                                            Check a recorded run against the
                                            formal requirements

Options:
  -p, --print            Print the overview as text and exit
  -c, --change <name>    The change to act on
      --cwd <dir>        Project root (default: current directory)
      --openspec-bin <p> Path to the openspec binary
      --driver <name>    Agent to run (claude, opencode). Default: claude
  -f, --force            Overwrite an existing schema install
  -h, --help             Show this help
  -V, --version          Show the version
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
  // Asked of git once, and only if some change needs it.
  let changedCache: string[] | null | undefined;
  const changed = () => (changedCache === undefined ? (changedCache = changedFiles(projectRoot)) : changedCache);
  let diffCache: string | null | undefined;
  const diff = () => (diffCache === undefined ? (diffCache = implementationDiff(projectRoot)) : diffCache);
  const classes = loadClasses(projectRoot);
  // Evidence is collected, and required, only where the project says how to
  // run its tests.
  const verification = loadVerification(projectRoot);
  const verifying = verification !== null && !('problem' in verification);
  const glossary = loadGlossary(projectRoot);

  const parts = changes.map((status) => {
    const reviews: Record<string, ReviewByArtifact[string]> = {};
    // Only an artifact that actually carries requirements gets review state.
    // Attaching an empty summary elsewhere would read as "reviewed, zero
    // requirements" and wrongly mark the stage accepted.
    const specsId = specsArtifactId(status);
    const risksId = risksArtifactId(status);
    const queue =
      specFilesOf(status).length > 0 || risksWritten(status) ? loadChangeReview(projectRoot, status) : null;
    if (specsId && queue && specFilesOf(status).length > 0) reviews[specsId] = queue.summary;
    // The risks are reviewed one at a time too, not read as one document.
    if (risksId && queue?.risks) reviews[risksId] = queue.risks;
    // Every other written artifact that is one document is accepted as a whole.
    const signoffs: Record<string, Signoff> = {};
    for (const artifact of status.artifacts) {
      if (artifact.id === specsId || artifact.id === risksId || artifact.status !== 'done') continue;
      const content = singleDocument(status, artifact.id);
      if (content !== null) signoffs[artifact.id] = loadSignoff(projectRoot, status.changeName, artifact.id, content);
    }
    const tasksFile = singleDocument(status, 'tasks');
    const tasks = tasksFile === null ? undefined : taskProgress(tasksFile);

    // Followed through: the accepted risks against the design and the tasks,
    // and — once implementing started — the code against the boundary.
    const accepted = (queue?.requirements ?? [])
      .filter((r) => r.state === 'accepted' && isRisk(r.item))
      .map((r) => r.item as Risk);
    const design = singleDocument(status, 'design');
    const proposal = singleDocument(status, 'proposal');
    const boundary = proposal === null ? null : parseBoundary(proposal);
    // Changed files are asked of git once implementing started, and only when
    // something needs them: a boundary to check, or classes to apply.
    const changedNow = (boundary || classes) && tasks && tasks.done > 0 ? changed() : null;
    const risks: RiskCheck | undefined =
      risksId || boundary
        ? {
            unanswered: design === null ? [] : unansweredRisks(accepted, design).map((r) => r.name),
            unguarded: tasksFile === null ? [] : unguardedRisks(accepted, tasksFile).map((r) => r.name),
            unproven: tasksFile === null ? [] : unprovenGuards(tasksFile).map((g) => g.risk),
            outsideBoundary: boundary && changedNow ? outsideBoundary(changedNow, boundary, generatedPaths(projectRoot)) : [],
            unmitigatedHigh: accepted
              .filter((r) => r.unmitigated && /^\s*(high|critical|catastrophic)\b/i.test(r.severity))
              .map((r) => r.name),
          }
        : undefined;

    // The class, and — where it asks for one — whether a person accepted
    // the diff the agent wrote.
    const consequence = classes ? classOfChange(classes, boundary, changedNow) : undefined;
    const diffText = consequence?.rules.includes('diff-review') && tasks?.applied ? diff() : null;
    const diffSignoff =
      diffText === null ? undefined : loadSignoff(projectRoot, status.changeName, 'implementation', diffText);
    // Formal forms, where any requirement or risk has one, and the matrices
    // they give: which rows must pass, by the change's class.
    const items = (queue?.requirements ?? []).map((r) => r.item);
    const formalState = items.some((i) => formalOf(i)) ? changeFormal(items, glossary) : undefined;
    // Matrices, a harness and its check only where the class asks for them.
    const verified = matrixVerified(consequence?.class ?? null, matrixConfig(projectRoot));
    const matrices = formalState && verified ? changeMatrices(projectRoot, status.changeName, items, glossary) : [];
    if (formalState && matrices.length > 0) {
      formalState.staleMatrices = [...new Set(staleMatrices(projectRoot, matrices).map((e) => e.item.name))];
    }
    const rows = rowsRequired(matrices, consequence?.class ?? null);
    // A matrix proves something only through a harness shown to reach the code.
    const unconnected = unconnectedItems(projectRoot, matrices, queue?.requirements ?? []);
    if (formalState && unconnected.components.length > 0) formalState.unconnected = unconnected.components;
    const harnessOpen = (queue?.requirements ?? []).filter((r) => isHarnessItem(r.item) && r.state !== 'accepted').length;
    if (formalState && harnessOpen > 0) formalState.harnessPending = harnessOpen;
    const evidence =
      verifying && queue
        ? summarizeEvidence(changeEvidence(projectRoot, status.changeName, queue.requirements, rows, unconnected.items, vacuousItems(matrices)))
        : undefined;
    // A defect change is checked against its own report: whose bug it is.
    const defect =
      isDefectSchema(status.schemaName) && proposal !== null
        ? checkDefect(
            projectRoot,
            parseReport(proposal),
            (queue?.requirements ?? []).map((r) => r.item).filter(isRequirement),
            tasksFile,
          )
        : undefined;
    return { status, reviews, signoffs, tasks, risks, consequence, diff: diffSignoff, evidence, defect, formal: formalState };
  });

  // A slice is done once its change is applied — or archived, which it
  // cannot be before. What is not done yet holds up the slices after it.
  let roadmap = loadRoadmap(projectRoot);
  if (roadmap) {
    const archived = archivedChanges(projectRoot);
    // Where the class asks a person to accept the diff, that is part of done.
    const implemented = (p: (typeof parts)[number]) =>
      p.tasks?.applied === true && (!p.consequence?.rules.includes('diff-review') || p.diff?.accepted === true);
    const applied = new Set(parts.filter(implemented).map((p) => p.status.changeName));
    const updated = markApplied(roadmap, (id) => applied.has(id) || archived.has(id));
    if (updated) {
      saveRoadmap(projectRoot, updated);
      roadmap = updated;
    }
  }

  const pipelines = parts.map(({ status, reviews, signoffs, tasks, risks, consequence, diff, evidence, defect, formal }) =>
    buildPipeline(status, reviews, signoffs, {
      ...(tasks ? { tasks } : {}),
      ...(risks ? { risks } : {}),
      ...(consequence ? { consequence } : {}),
      ...(diff ? { diff } : {}),
      ...(evidence ? { evidence } : {}),
      ...(defect ? { defect } : {}),
      ...(formal ? { formal } : {}),
      waitingOn: waitingOn(roadmap, status.changeName),
    }),
  );

  return { pipelines: sortByProgress(pipelines), failed, statuses };
}

/** The names of the changes that were archived: `archive/2026-09-29-<name>`. */
function archivedChanges(projectRoot: string): Set<string> {
  try {
    return new Set(
      readdirSync(join(projectRoot, 'openspec', 'changes', 'archive'))
        .filter((d) => !d.startsWith('.'))
        .map((d) => d.replace(/^\d{4}-\d{2}-\d{2}-/, '')),
    );
  } catch {
    return new Set();
  }
}

/** An artifact's content, when it is a single document that has been written. */
function singleDocument(status: OpenSpecChangeStatus, artifact: string): string | null {
  const file = status.artifactPaths[artifact]?.resolvedOutputPath;
  if (!file || file.includes('*')) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Why OpenSpec is not ready for spec-tacular here, or null when it is.
 * `openspec init` is the developer's to run: it asks which agents to set up.
 */
function openSpecMissing(root: string, driver: string): string | null {
  const agent = defaultRegistry().get(driver).label;
  if (!isOpenSpecProject(root)) {
    return `OpenSpec is not initialized here. Run \`openspec init\` in this folder first, and choose ${agent}.`;
  }
  if (!openSpecToolsInstalled(root, driver)) {
    return `OpenSpec is not set up for ${agent} here. Run \`openspec init\` in this folder again, and choose ${agent}.`;
  }
  return null;
}

/** `spec-tacular init` — install the schema that enforces the sequencing. */
function runInit(args: Args): number {
  const missing = openSpecMissing(args.cwd, args.driver);
  if (missing) {
    process.stderr.write(`${missing}\n`);
    return 1;
  }
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
    '\ndesign now requires accepted specs and risks, so a design cannot be\n' +
      'written against requirements nobody has agreed to, or ignore what they\n' +
      'could break.\n',
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
    process.stderr.write(`Usage: spec-tacular ${verb} <artifact> --change <name>\n`);
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
          'See what is outstanding with: spec-tacular foundation\n',
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
      `\nReview it first: spec-tacular --cwd ${args.cwd}, select ${args.change}, press enter.\n`,
    );
    return { ok: false, code: 1 };
  }
  return { ok: true, artifact: args.artifact, change: args.change };
}

/**
 * `spec-tacular instructions <artifact> -c <change>` — the gate, plus the
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
  const status = (await adapter.statusAll()).changes.find((c) => c.changeName === change);
  const written = status?.artifacts.find((a) => a.id === artifact)?.status === 'done';
  const stopped = readStopReport(args.cwd, change, artifact);
  const quoted = (text: string) => `> ${text.trim().replace(/\n/g, '\n> ')}`;
  const instructions = !feedback
    ? base
    : written
      // A redraft: the developer read the draft and said what to change.
      ? `${base}\n\n# Revision requested\n\nA draft of this artifact already exists. The developer read it and asked for\nthese changes:\n\n${quoted(feedback)}\n\nRevise the existing file in place. Keep what they did not ask to change.\n`
      : stopped !== null
        // An answer: the last attempt stopped with a report, and the developer replied to it.
        ? `${base}\n\n# Your last attempt stopped\n\nIt stopped instead of writing this artifact, with this report:\n\n${quoted(stopped)}\n\nThe developer read it and answered:\n\n${quoted(feedback)}\n\nGo with their answer. If the requirements still cannot be reconciled with it, stop again the same way.\n`
        // A retry: an earlier attempt stopped without writing it, and they answered.
        : `${base}\n\n# Before you start\n\nAn earlier attempt at this artifact stopped without writing it. The developer\nread why and answered:\n\n${quoted(feedback)}\n\nTake that as settled and write the artifact.\n`;
  const reviewed = status ? loadChangeReview(args.cwd, status).requirements : [];
  // What the developer said the change is for, when they created it. OpenSpec
  // keeps it in the change's README but does not put it in the instructions.
  const intent = status ? changeDescription(status.changeRoot) : '';
  const described = intent
    ? `The developer described this change as:\n\n> ${intent.replace(/\n/g, '\n> ')}\n\n${instructions}`
    : instructions;
  // How its formal forms are verified decides what the plan and the work
  // include: said once, where it is decided.
  const verifying = artifact === 'tasks' || artifact === 'apply'
    ? `${described}\n\n${await verificationNote(args, adapter, change)}`
    : described;
  // Implementing is interactive: a stop there is said in the session itself.
  const task = artifact === 'apply' ? verifying : `${verifying}\n\n${stopInstructions(args.cwd, change, artifact)}`;
  return buildPrompt(buildContext(args.cwd, reviewed, change), task);
}

/** How a change's formal requirements are verified: through matrices, or as any other requirement. */
async function verificationNote(args: Args, adapter: OpenSpecAdapter, change: string): Promise<string> {
  const pipeline = (await loadPipelines(adapter, args.cwd)).pipelines.find((p) => p.name === change);
  const cls = pipeline?.consequence?.class ?? null;
  const config = matrixConfig(args.cwd);
  const where = cls ? `This change is in consequence class ${cls}` : 'This project has no consequence classes for this change';
  return matrixVerified(cls, config)
    ? `# How this change's formal requirements are verified\n\n${where}, so its formal requirements are verified through their generated test matrices: the harness, the matrix tests and \`spec-tacular harness <change> --check\` are part of the work.\n`
    : `# How this change's formal requirements are verified\n\n${where}, so its formal requirements are tested like every other requirement — a tagged test per scenario — and not through generated matrices. Plan no harness, no \`spec-tacular matrix --write\` and no harness check, and do not run them.\n`;
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
 * `spec-tacular run <artifact> -c <change>` — dispatch and return.
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
        `Follow it with: spec-tacular jobs --job ${job.id}\n`,
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

/** `spec-tacular jobs` — list, tail, or cancel. */
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

/** `spec-tacular adr` — the project's durable decisions. */
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

/** `spec-tacular foundation` — the ground rules, and what is still TBD. */
function runFoundation(args: Args): number {
  const items = loadFoundation(args.cwd);
  if (items.length === 0) {
    process.stderr.write(
      `No Foundation at ${foundationDir(args.cwd)}.\n` +
        'Run `spec-tacular init` to scaffold it.\n',
    );
    return 1;
  }

  const unanswered = items.filter(isUnanswered);
  const deferred = items.filter(isDeferred);
  let group = '';
  for (const item of items) {
    if (item.capability !== group) {
      group = item.capability;
      process.stdout.write(`\n${group}\n`);
    }
    process.stdout.write(`  ${isUnanswered(item) ? '○' : isDeferred(item) ? '◌' : '●'} ${item.name}\n`);
  }

  process.stdout.write(
    `\n${items.length - unanswered.length - deferred.length}/${items.length - deferred.length} answered` +
      `${deferred.length > 0 ? `, ${deferred.length} left for later (◌)` : ''}\n`,
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

/** `spec-tacular pending` — what is waiting on validation. */
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

/** `spec-tacular verify <capability> --requirement <name>`. */
async function runVerify(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.artifact || !args.requirement) {
    process.stderr.write(
      'Usage: spec-tacular verify <capability> --requirement "<name>"\n',
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

/** `spec-tacular archive <change>` — the split. */
/** `spec-tacular classes` — the class map, its rules, and the class of each change. */
async function runClasses(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const map = loadClasses(args.cwd);
  if (!map) {
    process.stdout.write(
      'No consequence classes yet, so no change has a class and no class rule applies.\n' +
        `Write ${classesPath(args.cwd)}, for example:\n\n` +
        'default: P2\n' +
        'classes:\n' +
        '  P0:\n' +
        '    why: a wrong decision here lets unreviewed work through\n' +
        '    paths: [src/auth/, src/billing/**/*.ts]\n' +
        'tailoring:\n' +
        '  - class: P0\n' +
        '    rule: diff-review\n' +
        '    reason: why this project does without it\n',
    );
    return 0;
  }
  process.stdout.write(`${renderClasses(map)}\n`);
  for (const problem of map.problems) process.stderr.write(`Warning: ${problem}\n`);

  const { pipelines } = await loadPipelines(adapter, args.cwd);
  if (pipelines.length > 0) process.stdout.write('\n');
  for (const p of pipelines) {
    const c = p.consequence;
    const raised = c && c.raisedBy.length > 0 ? ` (declared ${c.declared ?? 'unclassified'})` : '';
    process.stdout.write(`${p.name}  ${c?.class ?? 'unclassified'}${raised}\n`);
  }
  return map.problems.length > 0 ? 1 : 0;
}

/**
 * `spec-tacular diff <change> [--accept]` — the code the agent wrote, and
 * accepting it. `--accept` records the diff as it is now, so it is only
 * meaningful after reading this same output.
 */
async function runDiff(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.change) {
    process.stderr.write('Usage: spec-tacular diff <change> [--accept]\n');
    return 1;
  }
  const text = implementationDiff(args.cwd);
  if (text === null) {
    process.stderr.write('Not a git repository — there is no diff to read.\n');
    return 1;
  }
  const pipeline = (await loadPipelines(adapter, args.cwd)).pipelines.find((p) => p.name === args.change);
  if (!pipeline) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
  }
  if (!args.accept) {
    process.stdout.write(text ? `${text}\n` : '(no changes to the code yet)\n');
    return 0;
  }
  acceptDocument(args.cwd, args.change, 'implementation', text);
  const status = (await adapter.statusAll()).changes.find((c) => c.changeName === args.change);
  if (status) recordReview(args.cwd, status);
  process.stdout.write(`Accepted the implementation diff of ${args.change}. A later change to the code sends it back.\n`);
  return 0;
}

/**
 * `spec-tacular evidence` — the verification matrix (RVTM): each requirement
 * and risk, how it is verified, by which tests, and where it stands. With
 * `--run` the tests run first and their results are appended to the record.
 * Exits non-zero while anything is missing, failing or stale, so it can gate
 * CI the way the archive gate does.
 */
async function runEvidence(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const config = loadVerification(args.cwd);
  if (config === null || 'problem' in config) {
    process.stderr.write(
      (config ? `${config.problem}\n` : 'No verification set up yet, so no evidence is collected or required.\n') +
        `Write ${verificationPath(args.cwd)} with the command that runs your tests and the JUnit report it writes:\n\n` +
        'command: bun test --reporter=junit --reporter-outfile=.spec-tacular/junit.xml\n' +
        'report: .spec-tacular/junit.xml\n\n' +
        '(vitest: --reporter=junit --outputFile=…; pytest: --junitxml=…)\n',
    );
    return config === null ? 0 : 1;
  }

  const { changes } = await adapter.statusAll();
  const queues = changes.map((status) => ({ status, queue: loadChangeReview(args.cwd, status) }));
  const target = args.change ? queues.filter((q) => q.status.changeName === args.change) : queues;
  if (args.change && target.length === 0) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
  }

  // A sign-off or a waiver: one record, bound to the item's text now.
  if (args.sign || args.waive) {
    const one = target.length === 1 ? target[0] : undefined;
    if (!one) {
      process.stderr.write('Name the change with -c <change>.\n');
      return 1;
    }
    const id = (args.sign ?? args.waive)!;
    const item = one.queue.requirements.find((r) => r.item.id === id)?.item;
    if (!item) {
      process.stderr.write(`${one.status.changeName} has no item '${id}'. Ids are shown by \`spec-tacular evidence ${one.status.changeName}\`.\n`);
      return 1;
    }
    if (!args.note?.trim()) {
      process.stderr.write(args.sign ? 'Say what was checked: --note "…"\n' : 'Say why: --reason "…"\n');
      return 1;
    }
    const at = new Date().toISOString();
    let record: EvidenceRecord;
    if (args.sign) {
      const method = (args.method ?? '').toLowerCase() as Method;
      if (!METHODS.includes(method) || method === 'test') {
        process.stderr.write('A sign-off is for --method analysis, inspection or demonstration; tests are recorded by --run.\n');
        return 1;
      }
      record = { kind: 'sign', at, item: item.id, hash: item.hash, method, note: args.note.trim() };
    } else {
      record = { kind: 'waive', at, item: item.id, hash: item.hash, reason: args.note.trim() };
    }
    appendEvidence(args.cwd, one.status.changeName, [record]);
    process.stdout.write(`Recorded: ${record.kind === 'sign' ? `${record.method} of` : 'waiver for'} ${item.id}. An edit to it makes this stale.\n`);
    return 0;
  }

  if (args.run) {
    const ran = runTests(args.cwd, config);
    if (!ran.ok) {
      process.stderr.write(`Could not collect evidence: ${ran.reason}\n`);
      return 1;
    }
    const at = new Date().toISOString();
    for (const { status, queue } of queues) {
      appendEvidence(args.cwd, status.changeName, recordsForRun(args.cwd, status.changeName, queue.requirements.map((r) => r.item), ran.results, at));
    }
    // The register's guards keep being recorded after their change is gone.
    appendEvidence(args.cwd, HAZARD_EVIDENCE, hazardRecordsForRun(listHazards(args.cwd), ran.results, at));
    // Backward traceability: a test naming nothing that exists.
    const active = new Set(queues.flatMap(({ queue }) => queue.requirements.map((r) => r.item.id)));
    const changeNames = new Set([...queues.map((q) => q.status.changeName), ...archivedChanges(args.cwd)]);
    const baseline = baselineRequirementIds(args.cwd);
    const orphans = orphanTags(ran.results, (t) =>
      t.kind === 'req' ? active.has(t.ref) || baseline.has(t.ref) : changeNames.has(t.ref.split('#')[0] ?? ''),
    );
    process.stdout.write(`Ran ${ran.results.length} tests.\n`);
    for (const o of orphans) process.stdout.write(`  orphan: ${o.tag} in "${o.test}" names nothing that exists\n`);
    process.stdout.write('\n');
  }

  // Which matrix rows each item must have run depends on its change's class.
  const classOf = new Map((await loadPipelines(adapter, args.cwd)).pipelines.map((p) => [p.name, p.consequence?.class ?? null]));
  const glossary = loadGlossary(args.cwd);
  let open = 0;
  for (const { status, queue } of target) {
    const cls = classOf.get(status.changeName) ?? null;
    const matrices = matrixVerified(cls, matrixConfig(args.cwd))
      ? changeMatrices(args.cwd, status.changeName, queue.requirements.map((r) => r.item), glossary)
      : [];
    const rows = rowsRequired(matrices, cls);
    const unconnected = unconnectedItems(args.cwd, matrices, queue.requirements).items;
    const items = changeEvidence(args.cwd, status.changeName, queue.requirements, rows, unconnected, vacuousItems(matrices));
    if (items.length === 0) continue;
    const s = summarizeEvidence(items);
    if (!s.complete) open++;
    process.stdout.write(`${status.changeName}  ${s.passing}/${s.total} verified${s.excepted ? `, ${s.excepted} excepted` : ''}\n`);
    for (const e of items) {
      const state = e.state === 'excepted' ? 'waived' : e.state;
      process.stdout.write(`  ${state.padEnd(8)} ${e.method.padEnd(13)} ${e.item.id}  ${e.item.name}\n`);
      if (e.state === 'missing' && e.method === 'test' && e.tests.length === 0) {
        process.stdout.write(`           name a test with ${tagFor(status.changeName, e.item)}\n`);
      }
      for (const t of e.tests) process.stdout.write(`           ${t}\n`);
      if (e.note) process.stdout.write(`           ${e.note}\n`);
      if (e.at) process.stdout.write(`           ${e.at}\n`);
    }
    process.stdout.write('\n');
  }
  return open > 0 ? 1 : 0;
}

/** Requirement ids in the accepted baseline, `openspec/specs/`. */
function baselineRequirementIds(projectRoot: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(projectRoot, 'openspec', 'specs');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const capability of entries) {
    const file = join(dir, capability, 'spec.md');
    try {
      for (const r of parseSpecFile(readFileSync(file, 'utf8'), capability, file).requirements) ids.add(r.id);
    } catch {
      // Not a capability folder.
    }
  }
  return ids;
}

async function runArchive(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.change) {
    process.stderr.write('Usage: spec-tacular archive <change>\n');
    return 1;
  }
  const ok = await archiveChange(args, adapter, args.change, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
  return ok ? 0 : 1;
}

/**
 * Archives a change, or says why not — the CLI's and the TUI's archive. What
 * it reports goes to `out`, refusals to `err`; true once it is archived (or,
 * on a dry run, once it could be).
 */
/**
 * Writes the change's review record (core/review-record.ts). A record that
 * cannot be written never fails the decision it records: the sidecar holds it.
 */
function recordReview(root: string, status: OpenSpecChangeStatus, evidence?: ItemEvidence[]): string | null {
  try {
    return writeReviewRecord(root, status, evidence ? { evidence } : {});
  } catch {
    return null;
  }
}

async function archiveChange(
  args: Args,
  adapter: OpenSpecAdapter,
  change: string,
  write: { out: (text: string) => void; err: (text: string) => void },
): Promise<boolean> {
  const { changes } = await adapter.statusAll();
  const status = changes.find((c) => c.changeName === change);
  if (!status) {
    write.err(`No change called '${change}'.\n`);
    return false;
  }

  const queue = loadChangeReview(args.cwd, status);
  const plan = planArchive(change, queue.requirements);

  write.out(
    `${plan.merging.length} requirement(s) merge into the baseline\n` +
      `${plan.diverting.length} divert to pending validation\n`,
  );
  for (const entry of plan.diverting) {
    write.out(`  ${entry.capability}: ${entry.name} — ${entry.needs}\n`);
  }

  if (plan.unresolved.length > 0) {
    write.err(
      `\nRefused: ${plan.unresolved.length} requirement(s) are neither accepted nor deferred.\n`,
    );
    for (const id of plan.unresolved) write.err(`  - ${id}\n`);
    write.err(
      '\nArchiving now would merge text nobody agreed to — exactly what `--yes` does.\n',
    );
    return false;
  }

  // The class's last word: a change whose code a person must read is not
  // archived until they have.
  const pipeline = (await loadPipelines(adapter, args.cwd)).pipelines.find((p) => p.name === change);
  const diff = pipeline?.apply.signoff;
  if (pipeline?.apply.tasks?.applied && diff && !diff.accepted) {
    write.err(
      `\nRefused: ${change} is a ${pipeline.consequence?.class} change and nobody has accepted its implementation diff` +
        `${diff.drifted ? ' since the code last changed' : ''}.\n` +
        `Read it with \`spec-tacular diff ${change}\`, then accept it with \`--accept\`.\n`,
    );
    return false;
  }

  // No-Go until proven: where the project runs tests for evidence, every
  // accepted requirement and risk must be verified or waived. Silence is
  // not consent.
  const evidence = (() => {
    if (!pipeline?.evidence) return undefined;
    const cls = pipeline.consequence?.class ?? null;
    const matrices = matrixVerified(cls, matrixConfig(args.cwd))
      ? changeMatrices(args.cwd, change, queue.requirements.map((r) => r.item), loadGlossary(args.cwd))
      : [];
    const rows = rowsRequired(matrices, cls);
    const unconnected = unconnectedItems(args.cwd, matrices, queue.requirements).items;
    return changeEvidence(args.cwd, change, queue.requirements, rows, unconnected, vacuousItems(matrices));
  })();
  if (pipeline?.evidence && !pipeline.evidence.complete) {
    const open = (evidence ?? []).filter((e) => e.state !== 'passing' && e.state !== 'excepted');
    write.err(`\nRefused: ${open.length} item(s) of ${change} have no current evidence.\n`);
    for (const e of open) write.err(`  - ${e.state}: ${e.item.id}${e.note ? ` — ${e.note.slice(0, 160)}` : ''}\n`);
    // The one step only the developer can take, named where it blocks.
    if (queue.requirements.some((r) => isHarnessItem(r.item) && r.state !== 'accepted')) {
      write.err(
        `\nIts harness is not reviewed yet: read it, then accept it in the review (enter on the overview)` +
          ` or with \`spec-tacular harness ${change} --accept\`.\n`,
      );
    }
    write.err(`\nSee \`spec-tacular evidence ${change}\`; \`--run\` runs the tests.\n`);
    return false;
  }

  if (args.dryRun) {
    write.out('\nDry run — nothing written.\n');
    return true;
  }

  // The decisions travel with the change: written now, while the deferred
  // requirements are still in its specs, and moved by `openspec archive`.
  const record = recordReview(args.cwd, status, evidence);
  if (record) write.out(`  wrote ${relative(args.cwd, record)}\n`);

  try {
    const prepared = prepareArchive(args.cwd, change, queue.requirements);
    for (const file of prepared.rewritten) write.out(`  rewrote ${file}\n`);
    for (const file of prepared.removed) {
      write.out(`  removed ${file} (every requirement in it deferred)\n`);
    }
  } catch (err) {
    if (err instanceof ArchiveBlockedError) {
      write.err(`${err.message}\n`);
      return false;
    }
    throw err;
  }

  // `--yes` is honest here: the only incomplete tasks are ones deliberately
  // deferred, and every deferred requirement is now recorded in the register.
  const output = await adapter.archive(change);
  write.out(output);

  // The risks outlive the change: each joins the register, or updates the
  // hazard it names. Only accepted ones — a rejected risk was judged wrong.
  const risks = queue.requirements.filter((r) => r.state === 'accepted' && isRisk(r.item)).map((r) => r.item as Risk);
  if (risks.length > 0) {
    write.out('\nHazard register:\n');
    for (const p of promoteRisks(args.cwd, change, risks)) {
      write.out(`  ${p.created ? 'added' : 'updated'} ${p.hazard} from risk "${p.risk}"\n`);
    }
  }
  return true;
}

/** Every formal item of the active changes, and of the accepted baseline. */
async function formalItems(args: Args, adapter: OpenSpecAdapter): Promise<{ where: string; item: ReviewItem }[]> {
  const out: { where: string; item: ReviewItem }[] = [];
  const { changes } = await adapter.statusAll();
  for (const status of changes) {
    if (args.change && status.changeName !== args.change) continue;
    for (const r of loadChangeReview(args.cwd, status).requirements) {
      if (formalOf(r.item)) out.push({ where: status.changeName, item: r.item });
    }
  }
  if (!args.change) {
    // Archived requirements keep their formal forms in the baseline.
    const dir = join(args.cwd, 'openspec', 'specs');
    for (const capability of existsSync(dir) ? readdirSync(dir) : []) {
      const file = join(dir, capability, 'spec.md');
      if (!existsSync(file)) continue;
      for (const r of parseSpecFile(readFileSync(file, 'utf8'), capability, file).requirements) {
        if (formalOf(r)) out.push({ where: 'baseline', item: r });
      }
    }
  }
  return out;
}

/**
 * `spec-tacular fret check|export|realizability` — NASA FRET alongside.
 *
 * - `check [<change>]` compares spec-tacular's reading of every FRETish
 *   requirement with FRET's own finite-trace formula, on the matrix's
 *   sequences and on seeded random traces. Formulas come from the FRET
 *   command line where it is set up (`fret.cli` in verification.yaml), else
 *   from the committed cache it fills.
 * - `export [<change>] [--out dir]` writes the requirements and the glossary
 *   in FRET's terms.
 * - `realizability <project> <component>` runs FRET's own check, on
 *   requirements imported into FRET.
 */
async function runFret(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const glossary = loadGlossary(args.cwd);
  if (args.sub === 'realizability') {
    const cli = fretCli(args.cwd);
    if (!cli || !args.change || !args.target) {
      process.stderr.write(
        cli
          ? 'Usage: spec-tacular fret realizability <FRET project> <component>\n'
          : 'FRET is not set up: set fret.cli in spec-tacular/verification.yaml to the command before `formalize`,\n' +
              'e.g. `npm run --silent --prefix ~/fret/fret-electron start-cli --`, and import `spec-tacular fret export` into FRET first.\n',
      );
      return 1;
    }
    const r = spawnSync('sh', ['-c', `${cli} realizability --diagnose '${args.change}' '${args.target}'`], { stdio: 'inherit' });
    return r.status ?? 1;
  }

  const items = await formalItems(args, adapter);
  const frets = items.flatMap(({ where, item }) => formalOf(item)!.frets.map((f) => ({ where, item, f })));

  if (args.sub === 'export') {
    const rows = items.flatMap(({ where, item }) => {
      const form = formalOf(item)!;
      return form.frets.map((f, i) => ({
        reqid: `${where === 'baseline' ? '' : `${where}:`}${item.id}${form.frets.length > 1 ? `-${i + 1}` : ''}`,
        fulltext: f.source,
        rationale: item.text.split('\n')[0] ?? item.name,
      }));
    });
    const dir = args.out ?? join(args.cwd, 'spec-tacular', 'fret', 'export');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(exportFiles(args.change ?? 'spec-tacular', rows, glossary))) {
      writeFileSync(join(dir, name), content, 'utf8');
      process.stdout.write(`wrote ${join(dir, name)}\n`);
    }
    process.stdout.write(`${rows.length} FRETish requirement(s). Decisions are not FRETish and stay out; FRET's own analyses start from these.\n`);
    return 0;
  }

  if (args.sub !== 'check') {
    process.stderr.write('Usage: spec-tacular fret check [<change>] | fret export [<change>] [--out dir] | fret realizability <project> <component>\n');
    return 1;
  }
  if (frets.length === 0) {
    process.stdout.write('No FRETish requirements to check.\n');
    return 0;
  }
  let disagreeing = 0;
  let unchecked = 0;
  for (const { where, item, f } of frets) {
    const source = fretFormula(args.cwd, f.source);
    const label = `${where}: ${item.name}`;
    if (source.formula === null) {
      unchecked++;
      process.stdout.write(`?  ${label}\n   ${f.source}\n   not checked — ${source.why}\n`);
      continue;
    }
    const sequences = matricesFor(item, '', formalOf(item)!, glossary)
      .filter((m) => m.kind === 'fret' && m.source === f.source)
      .flatMap((m) => m.rows.map((r) => r.steps as Env[]));
    const result = crossCheck(f, source.formula, sequences);
    const ok = result.disagreements.length === 0;
    if (!ok) disagreeing++;
    process.stdout.write(
      `${ok ? '✓' : '✗'}  ${label}\n   ${f.source}\n   FRET (${source.from}): ${source.formula}\n` +
        `   ${result.traces} traces, ${result.disagreements.length} disagreement(s)\n`,
    );
    const first = result.disagreements[0];
    if (first) {
      const shown = first.trace.map((s, i) => `${i}: ${Object.entries(s).map(([k, v]) => `${k}=${v === true ? 'T' : v === false ? 'F' : v}`).join(' ')}`);
      process.stdout.write(`   e.g. FRET says ${first.fret ? 'holds' : 'violated'}, spec-tacular ${first.ours ? 'holds' : 'violated'}, on:\n${shown.map((l) => `     ${l}`).join('\n')}\n`);
    }
    const unmonitorable = monitorability(f);
    if (unmonitorable) process.stdout.write(`   ! ${unmonitorable}\n`);
  }
  if (unchecked > 0) process.stdout.write(`\n${unchecked} not checked: FRET is needed once to formalize them; its answers are then cached.\n`);
  return disagreeing > 0 ? 1 : 0;
}

/**
 * `spec-tacular monitor <trace.jsonl> [<change>]` — a recorded run, one JSON
 * object of variable values per line, checked against every formal
 * requirement whose variables it records. Exits non-zero on a violation.
 */
async function runMonitor(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  if (!args.target || !existsSync(args.target)) {
    process.stderr.write('Usage: spec-tacular monitor <trace.jsonl> [<change>] — one JSON object of variable values per step\n');
    return 1;
  }
  const trace = readTrace(readFileSync(args.target, 'utf8'));
  const glossary = loadGlossary(args.cwd);
  let violated = 0;
  for (const { where, item } of await formalItems(args, adapter)) {
    const form = formalOf(item)!;
    const verdicts = [
      ...form.decisions.map((d) => monitorDecision(item.name, d, trace, glossary)),
      ...form.frets.map((f) => monitorFret(item.name, f, trace)),
    ];
    for (const v of verdicts) {
      if (v.holds === null) {
        process.stdout.write(`-  ${where}: ${v.requirement} — not recorded: ${v.unobserved.join(', ')}\n`);
        continue;
      }
      if (!v.holds) violated++;
      process.stdout.write(
        `${v.holds ? '✓' : '✗'}  ${where}: ${v.requirement}\n   ${v.form}\n` +
          (v.holds ? '' : `   violated at step${v.violated.length > 1 ? 's' : ''} ${v.violated.join(', ')}\n`),
      );
    }
  }
  process.stdout.write(`${trace.length} steps recorded.\n`);
  return violated > 0 ? 1 : 0;
}

/**
 * `spec-tacular harness [<change>] [--check]` — for each component the
 * change's matrices run through: its harness, whether it is connected, and
 * why not. `--check` runs the check — the matrix tests with coverage, then
 * with mutants of the code under test in a scratch copy — and records it.
 */
async function runHarness(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const glossary = loadGlossary(args.cwd);
  const config = matrixConfig(args.cwd);
  const { changes } = await adapter.statusAll();
  const target = args.change ? changes.filter((c) => c.changeName === args.change) : changes;
  if (args.change && target.length === 0) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
  }
  let open = 0;
  const done = new Set<string>();
  for (const status of target) {
    let queue = loadChangeReview(args.cwd, status);
    // --accept: the developer read the harness and agrees each binding sets
    // and reads what its variable means — the review's accept, from a shell.
    if (args.accept) {
      const open = queue.requirements.filter((r) => isHarnessItem(r.item) && r.state !== 'accepted');
      if (open.length > 0) {
        let review = loadReview(args.cwd, status.changeName);
        for (const r of open) {
          review = setState(review, r.item, 'accepted');
          process.stdout.write(`Accepted ${r.item.name} (${relative(args.cwd, r.item.file)})\n`);
        }
        saveReview(args.cwd, review);
        recordReview(args.cwd, status);
        queue = loadChangeReview(args.cwd, status);
      }
    }
    const entries = changeMatrices(args.cwd, status.changeName, queue.requirements.map((r) => r.item), glossary);
    const components = [...new Set(entries.map((e) => slugify(e.matrix.component)))];
    for (const component of components) {
      if (done.has(component)) continue;
      done.add(component);
      const h = componentHarness(args.cwd, component, config);
      const group = entries.filter((e) => slugify(e.matrix.component) === component);
      if (args.check) {
        // Regenerated first: a mapping reaches its tests through them.
        writeTests(args.cwd, group);
        process.stdout.write(`Checking ${component}: coverage, then mutants of ${h.production.join(', ') || '(no code)'}…\n`);
        const tests = group.map((e) => testFileFor(args.cwd, e, config).path);
        saveCheck(args.cwd, runHarnessCheck(args.cwd, h, tests, config));
      }
      const states = queue.requirements
        .filter((r) => r.item.capability === `harness/${component}`)
        .map((r) => ({ accepted: r.state === 'accepted' }));
      if (args.allowSurvivors !== undefined) {
        if (!args.allowSurvivors.trim()) {
          process.stderr.write('--allow-survivors needs a reason: why may the code differ there?\n');
          return 1;
        }
        try {
          const allowed = allowSurvivors(args.cwd, component, args.allowSurvivors.trim());
          if (allowed) process.stdout.write(`Allowed ${allowed.survivors.length} surviving change(s) to ${component}: ${allowed.reason}\n`);
        } catch (err) {
          process.stderr.write(`Not allowed: ${(err as Error).message}\n`);
          open++;
        }
      }
      const c = connection(args.cwd, h, group.map((g) => g.matrix), states, undefined, config);
      const check = loadCheck(args.cwd, component);
      process.stdout.write(
        `${component}  ${c.connected ? 'connected' : 'NOT CONNECTED'}  (${h.kind}${h.path ? `: ${h.path}` : ''})\n` +
          (check ? `    last check ${check.at}: ${check.killed}/${check.mutants} mutants caught${check.unexecuted.length ? `, not executed: ${check.unexecuted.join(', ')}` : ''}\n` : ''),
      );
      // Where the changes went, and which code no row reaches.
      for (const [file, f] of Object.entries(check?.perFile ?? {})) {
        process.stdout.write(`      ${f.killed}/${f.mutants} caught in ${file}\n`);
      }
      const unmutated = Object.keys(check?.production ?? {}).filter((f) => !check?.perFile?.[f]);
      if (check?.perFile && unmutated.length > 0) process.stdout.write(`      no mutable operator executed in ${unmutated.join(', ')}\n`);
      for (const b of c.because) process.stdout.write(`    - ${b}\n`);
      const allowed = loadAllowed(args.cwd, component);
      if (allowed) process.stdout.write(`    allowed ${allowed.survivors.length} surviving change(s): ${allowed.reason}\n`);
      if (!c.connected) open++;
    }
  }
  if (done.size === 0) process.stdout.write('No matrices yet, so no harnesses to check.\n');
  return open > 0 ? 1 : 0;
}

/**
 * `spec-tacular matrix [<change>] [--write]` — generates the test matrix of
 * every formal requirement and risk guard, writes it to
 * `spec-tacular/matrix/`, and prints it. `--write` also copies the runner
 * into the project and writes a table-driven test file per matrix, and names
 * the harnesses that still have to be written.
 */
async function runMatrix(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const glossary = loadGlossary(args.cwd);
  const { pipelines } = await loadPipelines(adapter, args.cwd);
  const { changes } = await adapter.statusAll();
  const target = args.change ? changes.filter((c) => c.changeName === args.change) : changes;
  if (args.change && target.length === 0) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
  }
  const all: MatrixEntry[] = [];
  let blocked = 0;
  for (const status of target) {
    const items = loadChangeReview(args.cwd, status).requirements.map((r) => r.item);
    const entries = changeMatrices(args.cwd, status.changeName, items, glossary);
    const withForm = items.filter((i) => formalOf(i));
    // A form with errors gives no matrix: say which, rather than skip silently.
    for (const item of withForm) {
      const problems = checkFormal(formalOf(item)!, glossary).errors;
      if (problems.length > 0) {
        blocked++;
        process.stdout.write(`! ${status.changeName}: ${item.name} — no matrix until its formal form is fixed: ${problems.join('; ')}\n`);
      }
    }
    if (entries.length === 0) continue;
    const cls = pipelines.find((p) => p.name === status.changeName)?.consequence?.class ?? null;
    // Only --write writes: without it, say what is out of date.
    const stale = new Set(staleMatrices(args.cwd, entries).map((e) => e.path));
    const written = new Set(args.write ? writeMatrices(args.cwd, entries) : []);
    process.stdout.write(`${status.changeName}${cls ? `  (class ${cls})` : ''}\n`);
    for (const e of entries) {
      const required = requiredRows(e.matrix, cls);
      const runnable = e.matrix.rows.filter((r) => !r.infeasible).length;
      const mark = written.has(e.path) ? ' (updated)' : stale.has(e.path) ? ' (out of date — --write regenerates it)' : '';
      process.stdout.write(
        `  ${e.item.name} → ${e.path}${mark}\n` +
          `  ${required.length} of ${runnable} rows required to pass${e.matrix.vacuous ? ' — but it tests nothing' : ''}\n`,
      );
      for (const line of matrixLines(e.matrix)) process.stdout.write(`  ${line}\n`);
      process.stdout.write('\n');
    }
    all.push(...entries);
  }
  if (all.length === 0 && blocked === 0) {
    process.stdout.write('No formal requirements yet — a requirement gets a matrix once it has a ```formal block.\n');
    return 0;
  }
  if (args.write) {
    // What is no longer generated goes, with its test: a renamed matrix
    // must not leave its old tests running against nothing.
    const keep = new Set<string>();
    for (const status of changes) {
      const items = loadChangeReview(args.cwd, status).requirements.map((r) => r.item);
      for (const e of changeMatrices(args.cwd, status.changeName, items, glossary)) keep.add(e.path);
    }
    const baseline = (await formalItems({ ...args, change: undefined }, adapter)).filter((f) => f.where === 'baseline');
    for (const e of changeMatrices(args.cwd, 'baseline', baseline.map((f) => f.item), glossary)) keep.add(e.path);
    for (const gone of removeOrphanMatrices(args.cwd, keep, changes.map((c) => c.changeName))) {
      process.stdout.write(`Removed ${gone} and its test: no longer generated\n`);
    }
  }
  if (args.write && all.length > 0) {
    const result = writeTests(args.cwd, all);
    process.stdout.write(`Runner: ${result.runner}\n`);
    for (const t of result.tests) process.stdout.write(`Test:   ${t}\n`);
    for (const h of result.missingHarness) {
      process.stdout.write(
        `Write:  ${h} — export \`harness\`, a function returning { reset?, drive(name, value), observe(name), tick? }\n` +
          '        that sets each input in the real code and reads each output from it.\n',
      );
    }
  }
  return blocked > 0 ? 1 : 0;
}

/**
 * `spec-tacular glossary` — the variables formal requirements are written
 * over, which requirements use each, and what is missing: variables used but
 * not defined, and ones without a source in the system — which cannot be
 * observed, and so cannot be monitored.
 */
async function runGlossary(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const glossary = loadGlossary(args.cwd);
  const { changes } = await adapter.statusAll();
  const usedBy = new Map<string, string[]>();
  let errors = 0;
  for (const status of changes) {
    for (const r of loadChangeReview(args.cwd, status).requirements) {
      const form = formalOf(r.item);
      if (!form) continue;
      const names = new Set<string>();
      for (const d of form.decisions) [d.output, ...variablesOf(d.expr)].forEach((v) => names.add(v));
      for (const f of form.frets) fretVariables(f).forEach((v) => names.add(v));
      for (const n of names) usedBy.set(n, [...(usedBy.get(n) ?? []), `${status.changeName}: ${r.item.name}`]);
      const problems = checkFormal(form, glossary).errors;
      if (problems.length > 0) {
        errors++;
        process.stdout.write(`! ${status.changeName}: ${r.item.name} — ${problems.join('; ')}\n`);
      }
    }
  }
  if (!glossary) {
    process.stdout.write(
      `No glossary yet. Formal requirements are written over variables defined in ${glossaryPath(args.cwd)}:\n\n` +
        'variables:\n' +
        '  tasks_applied:\n' +
        '    role: input          # mode | input | output | internal\n' +
        '    type: bool           # bool | int | float | enum (with values: [...])\n' +
        '    meaning: every task is ticked or deferred\n' +
        '    source: src/core/tasks.ts#taskProgress\n' +
        'constraints:\n' +
        '  - token_valid -> NOT token_expired\n',
    );
    return errors > 0 ? 1 : 0;
  }
  for (const problem of glossary.problems) process.stdout.write(`! ${problem}\n`);
  for (const v of glossary.variables.values()) {
    const users = usedBy.get(v.name) ?? [];
    process.stdout.write(
      `${v.name}  ${v.role} ${v.type}${v.values.length ? ` (${v.values.join(', ')})` : ''} — ${v.meaning}\n` +
        `    source: ${v.source || '(none — cannot be observed or monitored)'}\n` +
        (users.length ? users.map((u) => `    used by ${u}\n`).join('') : '    used by nothing yet\n'),
    );
  }
  for (const c of glossary.constraints) process.stdout.write(`constraint: ${c.source}\n`);
  return errors > 0 || glossary.problems.length > 0 ? 1 : 0;
}

/**
 * `spec-tacular defect <name> [--description …]` — a change that fixes
 * something, created with the defect schema: report, specs, risks, fix,
 * tasks, reproducer first.
 */
async function runDefect(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  const problem = args.change ? validateChangeName(args.change) : 'A name is required';
  if (problem) {
    process.stderr.write(`${problem}\nUsage: spec-tacular defect <name> [--description "what went wrong"]\n`);
    return 1;
  }
  if (!existsSync(join(args.cwd, 'openspec', 'schemas', DEFECT_SCHEMA_NAME, 'schema.yaml'))) {
    process.stderr.write(`The defect schema is not installed here. Run \`spec-tacular init --force\` first.\n`);
    return 1;
  }
  await adapter.newChange(args.change!, args.description, DEFECT_SCHEMA_NAME);
  process.stdout.write(
    `Created ${args.change}, a defect change. Its report decides first whose bug it is —\n` +
      'the code\'s, the requirement\'s, or a gap — and its first task is a reproducer\n' +
      'that fails on the code as it is.\n',
  );
  return 0;
}

/**
 * `spec-tacular hazards` — the register and where each hazard stands, by its
 * guards' latest results. `--reviewed HAZ-0003` records a look at one. Exits
 * non-zero while a hazard is unproven: a guard failing or never run, or no
 * control verified by a test. A waived guard does not fail it.
 */
function runHazards(args: Args): number {
  if (args.reviewed) {
    const updated = markReviewed(args.cwd, args.reviewed, args.note);
    if (!updated) {
      process.stderr.write(`No hazard ${args.reviewed} in ${hazardsDir(args.cwd)}.\n`);
      return 1;
    }
    process.stdout.write(`Reviewed ${updated.id} today.\n`);
    return 0;
  }
  const states = registerStates(args.cwd);
  if (states.length === 0) {
    process.stdout.write('No hazards yet. Each change\'s accepted risks join the register when it is archived.\n');
    return 0;
  }
  for (const s of states) {
    process.stdout.write(
      `${s.hazard.id}  ${s.status.padEnd(11)} ${(s.hazard.severity || '-').padEnd(8)} ${s.hazard.title}\n` +
        `           ${s.because}${s.dueForReview ? ` · due for review (last ${s.hazard.reviewed ?? 'never'})` : ''}\n`,
    );
  }
  return states.some((s) => s.blocking) ? 1 : 0;
}

/** `spec-tacular roadmap` — show, promote, or complete a slice. */
async function runRoadmap(args: Args, adapter: OpenSpecAdapter): Promise<number> {
  // Loading the changes also marks the slices whose changes are applied done.
  const pipelines = isOpenSpecProject(args.cwd) ? (await loadPipelines(adapter, args.cwd)).pipelines : [];
  const isSpecified = (id: string) => specified(pipelines.find((p) => p.name === id));
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
      : promoteSlice(roadmap, args.slice, isSpecified);
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

  const next = nextPromotable(roadmap, isSpecified);
  const planning = roadmap.slices.find((s) => s.status === 'active' && !isSpecified(s.id));
  process.stdout.write(
    next
      ? `\nNext: spec-tacular roadmap --promote ${next.id}\n`
      : planning
        ? `\n'${planning.id}' is being specified. The next slice opens once its specs are accepted.\n`
        : '\nNothing left to promote.\n',
  );
  return 0;
}

function describeError(err: unknown): string {
  if (err instanceof OpenSpecError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return (err as Error).message;
}

/**
 * The TUI's one-key setup: the schema, then the Foundation questions, on a
 * folder where `openspec init` already ran. Each step is skipped when already
 * done, so it is safe to run on a half-set-up project — and never overwrites a
 * schema someone edited, which `init` only does under `--force`.
 */
async function setUpProject(
  root: string,
  driver: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const missing = openSpecMissing(root, driver);
    if (missing) return { ok: false, reason: missing };
    if (!schemaInstalled(root)) initProject(root);
    else scaffoldFoundation(root, { defer: isGreenfield(root) });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/** `w` in the TUI: the same gates as `spec-tacular run`, reported as a line. */
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
    clearStopReport(args.cwd, change, artifact);
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
 * Opens the next slice on the roadmap as a change: once the one before it is
 * specified, so it can be specified while that one is designed and built.
 */
async function startNextSlice(
  args: Args,
  adapter: OpenSpecAdapter,
  id?: string,
): Promise<{ ok: true; change: string } | { ok: false; reason: string }> {
  try {
    const roadmap = loadRoadmap(args.cwd);
    if (!roadmap) return { ok: false, reason: 'There is no roadmap' };
    const { pipelines } = await loadPipelines(adapter, args.cwd);
    const isSpecified = (id: string) => specified(pipelines.find((p) => p.name === id));
    // The slice the developer picked, or else the next one the roadmap allows.
    const next = id ? roadmap.slices.find((s) => s.id === id) : nextPromotable(roadmap, isSpecified);
    if (!next) {
      return { ok: false, reason: id ? `No slice called '${id}' on the roadmap` : 'No slice can start yet — accept the current one\'s specs first' };
    }
    const promoted = promoteSlice(roadmap, next.id, isSpecified);
    if (!promoted.ok) return { ok: false, reason: promoted.reason };
    await adapter.newChange(next.id, next.summary);
    saveRoadmap(args.cwd, promoted.roadmap);
    return { ok: true, change: next.id };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/**
 * Implementing, from the TUI: the same gates as a draft, then the agent's own
 * interactive session on the apply instructions — so it runs commands and
 * asks for permissions just as it does when started by hand.
 */
function implementingSessionsPath(projectRoot: string): string {
  return join(projectRoot, '.spec-tacular', 'implementing', 'sessions.jsonl');
}

function recordImplementingSession(projectRoot: string, change: string, sessionId: string): void {
  mkdirSync(dirname(implementingSessionsPath(projectRoot)), { recursive: true });
  appendFileSync(implementingSessionsPath(projectRoot), `${JSON.stringify({ change, sessionId, at: new Date().toISOString() })}\n`, 'utf8');
}

/** What the implementing sessions used, as their transcripts say: tokens, no cost. */
function implementingUsage(projectRoot: string): Usage[] {
  let lines: string[];
  try {
    lines = readFileSync(implementingSessionsPath(projectRoot), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.flatMap((l) => {
    try {
      const { sessionId } = JSON.parse(l) as { sessionId: string };
      const usage = claudeSessionUsage(claudeTranscriptPath(projectRoot, sessionId));
      return usage ? [usage] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The commands an implementing session runs to show its work: the project's
 * test commands from verification.yaml, the matrix's, and spec-tacular's
 * own checks — as prefixes a driver can pre-approve.
 */
function implementingCommands(projectRoot: string): string[] {
  const out = new Set(['spec-tacular matrix', 'spec-tacular harness', 'spec-tacular evidence', 'spec-tacular glossary']);
  // A command's first two words: `bun test`, `npx vitest`, `pytest --junitxml…` → `pytest`.
  const prefix = (command: string) => {
    const words = command.replace(/^([A-Z_]+=\S+\s+)+/, '').trim().split(/\s+/);
    return words.slice(0, words[1] && !words[1].startsWith('-') && !words[1].includes('{') ? 2 : 1).join(' ');
  };
  const verification = loadVerification(projectRoot);
  if (verification && !('problem' in verification)) out.add(prefix(verification.command));
  const matrix = matrixConfig(projectRoot);
  out.add(prefix(matrix.run));
  out.add(prefix(matrix.coverage));
  // The usual typecheckers and linters, however they are reached.
  for (const tool of ['tsc', 'biome', 'eslint', 'prettier']) {
    out.add(tool);
    out.add(`bunx ${tool}`);
    out.add(`npx ${tool}`);
    out.add(`./node_modules/.bin/${tool}`);
  }
  return [...out].filter((p) => p !== '');
}

async function implementCommand(
  args: Args,
  adapter: OpenSpecAdapter,
  change: string,
): Promise<{ ok: true; command: AgentCommand; label: string } | { ok: false; reason: string }> {
  try {
    const { pipelines } = await loadPipelines(adapter, args.cwd);
    const pipeline = pipelines.find((p) => p.name === change);
    if (!pipeline) return { ok: false, reason: `No change called '${change}'` };
    const gate = gateFor(pipeline, 'apply');
    if (!gate.allowed) return { ok: false, reason: `Not yet: ${gate.blockers.join('; ')}` };
    const driver = defaultRegistry().get(args.driver);
    if (!driver.interactive) return { ok: false, reason: `${driver.label} cannot be opened interactively` };
    const prompt = await composePrompt(args, adapter, 'apply', change);
    // Named, so what it used can be read from its transcript afterwards.
    const sessionId = args.driver === 'claude' ? randomUUID() : undefined;
    if (sessionId) recordImplementingSession(args.cwd, change, sessionId);
    return { ok: true, command: driver.interactive(prompt, implementingCommands(args.cwd), sessionId), label: driver.label };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
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

async function main(): Promise<number> {
  // Claude Code runs this as the MCP allow hook when spec-tacular is a
  // compiled binary, which has no allow-mcp.mjs on disk (agent/claude.ts).
  if (process.argv[2] === ALLOW_MCP_HOOK_ARG) {
    await import('./agent/allow-mcp.mjs');
    return 0;
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`spec-tacular ${VERSION}\n`);
    return 0;
  }

  // The TUI opens anywhere: in a folder that is not set up yet, it offers to
  // set it up. Every other command needs a project to act on.
  const tui = args.command === 'overview' && !args.print && process.stdout.isTTY === true;
  if (!isOpenSpecProject(args.cwd) && !tui) {
    process.stderr.write(
      `No openspec/ directory in ${args.cwd}.\n` +
        `spec-tacular works on an OpenSpec project — run \`spec-tacular\` in a terminal\n` +
        `to be guided through setting one up, or point at one with --cwd.\n`,
    );
    return 1;
  }

  if (args.command === 'init') return runInit(args);
  if (args.command === 'jobs') return runJobs(args);
  if (args.command === 'adr') return runAdrs(args);
  if (args.command === 'foundation') return runFoundation(args);
  if (args.command === 'pending') return runPending(args);
  if (args.command === 'hazards') return runHazards(args);
  const adapter = new OpenSpecAdapter({ cwd: args.cwd, bin: args.bin });

  try {
    if (args.command === 'roadmap') return await runRoadmap(args, adapter);
    if (args.command === 'instructions') return await runInstructions(args, adapter);
    if (args.command === 'run') return await runAgent(args, adapter);
    if (args.command === 'archive') return await runArchive(args, adapter);
    if (args.command === 'verify') return await runVerify(args, adapter);
    if (args.command === 'classes') return await runClasses(args, adapter);
    if (args.command === 'diff') return await runDiff(args, adapter);
    if (args.command === 'evidence') return await runEvidence(args, adapter);
    if (args.command === 'defect') return await runDefect(args, adapter);
    if (args.command === 'glossary') return await runGlossary(args, adapter);
    if (args.command === 'matrix') return await runMatrix(args, adapter);
    if (args.command === 'harness') return await runHarness(args, adapter);
    if (args.command === 'fret') return await runFret(args, adapter);
    if (args.command === 'monitor') return await runMonitor(args, adapter);

    if (!tui) {
      const { pipelines, failed } = await loadPipelines(adapter, args.cwd);
      process.stdout.write(
        renderOverview(pipelines, {
          color: process.stdout.isTTY === true,
          failed,
          root: args.cwd,
        }) + '\n',
      );
      // A hazard whose guard fails is a regression in something the project
      // already decided must not happen: it is said on every overview.
      for (const s of registerStates(args.cwd)) {
        if (s.status === 'open' && s.hazard.verification.length > 0) {
          process.stdout.write(`! ${s.hazard.id} ${s.hazard.title} is open again — ${s.because}\n`);
        } else if (s.dueForReview) {
          process.stdout.write(`· ${s.hazard.id} ${s.hazard.title} is due for review (\`spec-tacular hazards\`)\n`);
        }
      }
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
      // The session's review was loaded when it opened: documents accepted
      // since are on disk only, and must not be overwritten by it.
      saveSession: (session) => {
        const { documents } = loadReview(args.cwd, session.review.change);
        saveReview(args.cwd, { ...session.review, ...(documents ? { documents } : {}) });
        const status = statuses.get(session.review.change);
        if (status) recordReview(args.cwd, status);
      },
      lintConfig: loadLintConfig(args.cwd),
      glossary: () => loadGlossary(args.cwd),
      reparse: (change) =>
        queueFor(change)?.requirements.map((r) => r.item) ?? [],
      reloadPipelines: async () => {
        const fresh = await load();
        statuses = fresh.statuses;
        return fresh.pipelines;
      },
      listJobs: () => listJobs(args.cwd),
      driver: args.driver,
      modelFor: (id) => {
        try {
          return defaultRegistry().get(id).model?.('research');
        } catch {
          return undefined;
        }
      },
      jobUsage: (job) => {
        let parse: ((line: string) => Usage | null) | undefined;
        try {
          parse = defaultRegistry().get(job.driver).parseUsage;
        } catch {
          return [];
        }
        if (!parse) return [];
        const out: Usage[] = [];
        for (const line of tailJob(job, 2000)) {
          const usage = parse(line);
          if (usage) out.push(usage);
        }
        return out;
      },
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
      stage: () => projectStage(args.cwd, statuses.size, args.driver),
      setup: () => setUpProject(args.cwd, args.driver),
      questions: () => guidedQuestions(args.cwd),
      answer: (question, text) => answerFoundation(question.item, text),
      createChange: async (name, description, kind) => {
        try {
          await adapter.newChange(name, description || undefined, kind === 'defect' ? DEFECT_SCHEMA_NAME : undefined);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: describeError(err) };
        }
      },
      dispatch: (change, artifact, feedback) => dispatch(args, adapter, change, artifact, feedback),
      stopReport: (change, artifact, job) => {
        let text = readStopReport(args.cwd, change, artifact);
        let source: StopReport['source'] = 'report';
        if (text === null && job) {
          // No report: its last words, kept as one so they outlive the log.
          let driver;
          try {
            driver = defaultRegistry().get(job.driver);
          } catch {
            return null;
          }
          text = driver.finalMessage?.(readJobLog(job)) ?? null;
          if (text === null) return null;
          saveStopReport(args.cwd, change, artifact, text);
        }
        if (text === null) return null;
        if (!/^#\s+Stopped:/m.test(text)) source = 'message';
        const items = queueFor(change)?.requirements.map((r) => r.item) ?? [];
        return parseStop(text, items, { change, artifact, source });
      },
      implement: (change) => implementCommand(args, adapter, change),
      launch: (change, command) => openElsewhere(writeSessionScript(args.cwd, change, command), args.cwd),
      implementing: () => implementingNow(args.cwd),
      startNextSlice: (id) => startNextSlice(args, adapter, id),
      writeMatrices: (change) => {
        const status = statuses.get(change);
        if (!status) return { ok: false, reason: `${change} is gone` };
        try {
          const entries = changeMatrices(args.cwd, change, loadChangeReview(args.cwd, status).requirements.map((r) => r.item), loadGlossary(args.cwd));
          if (entries.length === 0) return { ok: false, reason: `${change} has no formal requirements yet` };
          writeMatrices(args.cwd, entries);
          return { ok: true, written: writeTests(args.cwd, entries).tests.length };
        } catch (err) {
          return { ok: false, reason: `Could not write the matrices: ${(err as Error).message}` };
        }
      },
      archive: async (change, dryRun) => {
        let text = '';
        const collect = (t: string) => {
          text += t;
        };
        const ok = await archiveChange({ ...args, dryRun }, adapter, change, { out: collect, err: collect });
        return { ok, text };
      },
      acceptDocument: (change, artifact, content) => {
        try {
          acceptDocument(args.cwd, change, artifact, content);
          const status = statuses.get(change);
          if (status) recordReview(args.cwd, status);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: `Could not record it: ${(err as Error).message}` };
        }
      },
      readArtifact: async (change, artifact) => {
        // Not a file: what the branch changed, read to be accepted as a whole.
        // Exactly the text that is hashed on acceptance — no placeholder.
        if (artifact === 'implementation') {
          const text = implementationDiff(args.cwd);
          if (text === null) return { ok: false, reason: 'not a git repository — there is no diff to read' };
          return { ok: true, file: '', content: text };
        }
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
      ...(assistants = createAssistants({ cwd: args.cwd, driver: args.driver, record: (u) => appendUsageLog(args.cwd, u) })),
      pastUsage: loadUsageLog(args.cwd),
      implementingUsage: () => implementingUsage(args.cwd),
      reviseAnswer: {
        unavailable: assistants.answerRefiner ? null : assistants.advisorNote,
        propose: async (question, current, turns, instruction) => {
          if (!assistants?.answerRefiner) throw new Error(assistants?.advisorNote ?? 'no agent to revise with');
          return assistants.answerRefiner.propose({ question, questions: guidedQuestions(args.cwd) }, current, turns, instruction);
        },
      },
      reviseVisionAnswer: {
        unavailable: assistants.answerRefiner ? null : assistants.advisorNote,
        propose: async (session, current, turns, instruction) => {
          const pending = session.pending;
          if (!assistants?.answerRefiner) throw new Error(assistants?.advisorNote ?? 'no agent to revise with');
          if (!pending) throw new Error('There is no interview question to answer');
          return assistants.answerRefiner.propose({ ask: pending.ask, why: pending.why, interview: session }, current, turns, instruction);
        },
      },
      refine: {
        unavailable: assistants.refiner ? null : assistants.advisorNote,
        propose: async (change, item, turns, instruction) => {
          const root = statuses.get(change)?.changeRoot;
          if (!assistants?.refiner || !root) throw new Error(assistants?.advisorNote ?? `${change} is gone`);
          return assistants.refiner.propose(refineContext(root, item, args.cwd), turns, instruction);
        },
      },
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

/** The TUI's AI, once it runs: its sessions end before spec-tacular does. */
let assistants: Assistants | null = null;

/** Ends the agent sessions — and whatever server they shared — before exiting. */
async function shutdown(): Promise<void> {
  await assistants?.close();
}

main().then(
  async (code) => {
    await shutdown();
    process.exit(code);
  },
  async (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    await shutdown();
    process.exit(1);
  },
);
