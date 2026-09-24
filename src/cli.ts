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

type Command = 'overview' | 'init' | 'instructions';

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
    else if (a !== undefined && !a.startsWith('-')) positional.push(a);
  }

  const [first, second] = positional;
  if (first === 'init') args.command = 'init';
  else if (first === 'instructions') {
    args.command = 'instructions';
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

Options:
  -p, --print            Print the overview as text and exit
  -c, --change <name>    The change to act on
      --cwd <dir>        Project root (default: current directory)
      --openspec-bin <p> Path to the openspec binary
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
 * `spectacular instructions <artifact> -c <change>` — the gate.
 *
 * This is the seam an agent goes through to write an artifact, so refusing
 * here is what actually stops a design being written against pending specs.
 * M5's agent driver calls the same function.
 */
async function runInstructions(
  args: Args,
  adapter: OpenSpecAdapter,
): Promise<number> {
  if (!args.artifact || !args.change) {
    process.stderr.write('Usage: spectacular instructions <artifact> --change <name>\n');
    return 1;
  }

  const { pipelines } = await loadPipelines(adapter, args.cwd);
  const pipeline = pipelines.find((p) => p.name === args.change);
  if (!pipeline) {
    process.stderr.write(`No change called '${args.change}'.\n`);
    return 1;
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
    return 1;
  }
  process.stdout.write(await adapter.instructions(args.artifact, args.change));
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

  const adapter = new OpenSpecAdapter({ cwd: args.cwd, bin: args.bin });

  try {
    if (args.command === 'instructions') return await runInstructions(args, adapter);

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
