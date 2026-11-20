/**
 * The OpenSpec adapter — the ONLY module in spec-tacular that knows OpenSpec
 * exists.
 *
 * Two rules, both load-bearing (see docs/architecture.md):
 *   1. Reads go through the CLI's `--json` surface, which is a far more stable
 *      contract than OpenSpec's internal module paths.
 *   2. Nothing here ever writes a file OpenSpec owns. Mutations are delegated
 *      to OpenSpec's own commands, so the on-disk format stays compatible with
 *      plain `openspec` and with any agent that knows it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isChangeError,
  type OpenSpecBatchStatus,
  type OpenSpecChangeError,
  type OpenSpecChangeStatus,
} from './types.ts';

export class OpenSpecError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'OpenSpecError';
  }
}

export interface AdapterOptions {
  /** Project root. Must contain an `openspec/` directory. */
  cwd: string;
  /** Override the binary, for tests or a pinned local install. */
  bin?: string;
  /** Per-invocation timeout. A sweep over a large repo is not instant. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Whether `dir` looks like an OpenSpec project. Cheap, sync, no subprocess. */
export function isOpenSpecProject(dir: string): boolean {
  return existsSync(join(dir, 'openspec'));
}

/**
 * Where `openspec init` puts each agent's skills. OpenSpec 2 installs them
 * once in `.agents/skills/`: opencode reads that folder itself, and Claude
 * Code, which does not, gets links in `.claude/skills/`. OpenSpec 1 wrote a
 * copy per agent.
 */
const AGENT_DIRS: Record<string, string[]> = { claude: ['.claude'], opencode: ['.opencode', '.agents'] };

/**
 * Whether `openspec init` wired OpenSpec into `driver`: its skills and
 * commands are how the agent knows the workflow. An agent OpenSpec does not
 * know counts as wired — there is nothing to check.
 */
export function openSpecToolsInstalled(dir: string, driver: string): boolean {
  const agentDirs = AGENT_DIRS[driver];
  return !agentDirs || agentDirs.some((d) => existsSync(join(dir, d, 'skills', 'openspec-apply-change')));
}

export class OpenSpecAdapter {
  private readonly cwd: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: AdapterOptions) {
    this.cwd = options.cwd;
    this.bin = options.bin ?? 'openspec';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Status for every active change.
   *
   * Entries that failed to load are dropped rather than thrown on: OpenSpec's
   * own sweep does not abort for one bad change, and neither should the UI —
   * one malformed change must not hide the other twenty-five.
   */
  async statusAll(): Promise<{ changes: OpenSpecChangeStatus[]; failed: string[] }> {
    const raw = await this.runJson<OpenSpecBatchStatus>(['status', '--all', '--json']);

    // `{ changes: [], root: null }` is OpenSpec's documented failure shape for
    // this command, not an empty project. Told apart by `root`.
    if (raw.root === null && raw.changes.length === 0) {
      throw new OpenSpecError(
        'OpenSpec could not resolve a project root.',
        `Is ${this.cwd} an OpenSpec project? Try \`openspec init\`.`,
      );
    }

    const changes: OpenSpecChangeStatus[] = [];
    const failed: string[] = [];
    for (const entry of raw.changes as (OpenSpecChangeStatus | OpenSpecChangeError)[]) {
      if (isChangeError(entry)) failed.push(entry.changeName);
      else changes.push(entry);
    }
    return { changes, failed };
  }

  /** Status for one change. */
  async status(change: string): Promise<OpenSpecChangeStatus> {
    return this.runJson<OpenSpecChangeStatus>(['status', '--change', change, '--json']);
  }

  /**
   * Raw instructions for writing one artifact.
   *
   * Returned as text, not parsed: this is handed to an agent verbatim, and
   * spec-tacular has no business reinterpreting OpenSpec's guidance.
   */
  async instructions(artifact: string, change: string): Promise<string> {
    const { stdout } = await this.run(['instructions', artifact, '--change', change]);
    return stdout;
  }

  /**
   * Archives a change through OpenSpec.
   *
   * `--yes` is passed because spec-tacular has already resolved what it
   * covers: every requirement is accepted or recorded in the pending register,
   * and the only unchecked tasks are ones deliberately deferred.
   */
  async archive(change: string): Promise<string> {
    const { stdout, stderr } = await this.run(['archive', change, '--yes']);
    return stdout + stderr;
  }

  /** Validates a spec or change, so a write can be checked by its owner. */
  async validate(item: string): Promise<string> {
    const { stdout, stderr } = await this.run(['validate', item, '--type', 'spec']);
    return stdout + stderr;
  }

  /** Creates a change. Its schema comes from the project's config, unless named. */
  async newChange(name: string, description?: string, schema?: string): Promise<void> {
    const args = ['new', 'change', name];
    if (description) args.push('--description', description);
    if (schema) args.push('--schema', schema);
    await this.run(args);
  }

  /** The schema's starting template for an artifact, for writing it by hand. */
  async template(artifact: string, change: string): Promise<string> {
    const raw = await this.runJson<{ template?: string }>([
      'instructions', artifact, '--change', change, '--json',
    ]);
    return raw.template ?? '';
  }

  /** The OpenSpec version in use, for the compatibility check. */
  async version(): Promise<string> {
    const { stdout } = await this.run(['--version']);
    return stdout.trim();
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const { stdout } = await this.run(args);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      // A non-JSON body from a --json command means the CLI failed before it
      // could produce one. Its own text is the most useful thing to show.
      const preview = stdout.trim().slice(0, 300);
      throw new OpenSpecError(
        `openspec ${args.join(' ')} did not return JSON.`,
        preview || 'No output. Is the openspec CLI installed and on PATH?',
      );
    }
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: this.cwd,
        // stdin is closed so a prompt can never silently hang the UI: any
        // OpenSpec command that wants confirmation fails fast instead.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(
          new OpenSpecError(
            `openspec ${args.join(' ')} timed out after ${this.timeoutMs}ms.`,
          ),
        );
      }, this.timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            // A missing working directory is reported by spawn as ENOENT too,
            // so check it before blaming the binary — otherwise a typo in
            // --cwd reads as "openspec is not installed".
            err.code === 'ENOENT' && !existsSync(this.cwd)
              ? new OpenSpecError(
                  `The folder \`${this.cwd}\` does not exist.`,
                  'Create it first, or point --cwd at a folder that does.',
                )
              : err.code === 'ENOENT'
                ? new OpenSpecError(
                    `The \`${this.bin}\` command was not found.`,
                    'Install it with `npm install -g @fission-ai/openspec`.',
                  )
                : new OpenSpecError(`Could not run \`${this.bin}\`: ${err.message}`),
          ),
        );
      });

      child.on('close', (code) => {
        finish(() => {
          // A `--json` command can exit non-zero and still have emitted a
          // usable payload, so a parseable body wins over the exit code.
          if (code !== 0 && !stdout.trim()) {
            reject(
              new OpenSpecError(
                `openspec ${args.join(' ')} exited with code ${code}.`,
                stderr.trim() || undefined,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    });
  }
}
