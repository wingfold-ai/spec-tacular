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

import { OpenSpecAdapter, OpenSpecError, isOpenSpecProject } from './adapter/openspec.ts';
import {
  buildPipeline,
  sortByProgress,
  type ChangePipeline,
  type ReviewByArtifact,
} from './core/pipeline.ts';
import { loadChangeReview, specFilesOf, specsArtifactId } from './core/change-review.ts';
import { renderOverview } from './render/text.ts';

interface Args {
  cwd: string;
  print: boolean;
  bin: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), print: false, bin: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print' || a === '-p') args.print = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--cwd') args.cwd = argv[++i] ?? args.cwd;
    else if (a === '--openspec-bin') args.bin = argv[++i];
  }
  return args;
}

const HELP = `spec-tacular — spec-driven development, reviewable

Usage:
  spectacular [options]

Options:
  -p, --print            Print the overview as text and exit
      --cwd <dir>        Project root (default: current directory)
      --openspec-bin <p> Path to the openspec binary
  -h, --help             Show this help
`;

async function loadPipelines(
  adapter: OpenSpecAdapter,
  projectRoot: string,
): Promise<{ pipelines: ChangePipeline[]; failed: string[] }> {
  const { changes, failed } = await adapter.statusAll();

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

  return { pipelines: sortByProgress(pipelines), failed };
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

  const adapter = new OpenSpecAdapter({ cwd: args.cwd, bin: args.bin });

  try {
    const { pipelines, failed } = await loadPipelines(adapter, args.cwd);

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
    await startTui({ pipelines, failed, root: args.cwd });
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
