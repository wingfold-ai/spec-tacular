/**
 * Runs a driver's one-shot structured request and returns its value.
 *
 * Unlike a job this is not detached: it is short, its result is consumed by
 * the running TUI, and nothing needs to survive the TUI exiting. It is still
 * asynchronous — the UI keeps drawing and taking answers while it runs.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentDriver, StructuredMode } from './driver.ts';

const DEFAULT_TIMEOUT_MS = 180_000;

/** Whether `command` can be found on PATH, without running it. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes('/')) return existsSync(command);
  return (env['PATH'] ?? '').split(delimiter).some((d) => d && existsSync(join(d, command)));
}

/** Why a driver cannot advise, or null when it can. */
export function advisorUnavailable(driver: AgentDriver): string | null {
  if (!driver.structured) return `${driver.label} cannot answer structured requests`;
  const probe = driver.structured.build({ prompt: '', cwd: '', schema: {} });
  if (!onPath(probe.command)) return `\`${probe.command}\` is not installed`;
  return null;
}

export function runStructured(
  driver: AgentDriver,
  cwd: string,
  prompt: string,
  schema: object,
  options: { mode?: StructuredMode; timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const structured = driver.structured;
  if (!structured) return Promise.reject(new Error(`${driver.label} cannot advise`));
  const { command, args } = structured.build({ prompt, cwd, schema, mode: options.mode });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${driver.label} did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(structured.parse(stdout));
      } catch (err) {
        reject(
          new Error(
            code !== 0 && stderr.trim()
              ? stderr.trim().split('\n')[0]!
              : (err as Error).message,
          ),
        );
      }
    });
  });
}
