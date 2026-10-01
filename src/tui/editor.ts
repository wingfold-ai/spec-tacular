/**
 * Opens a requirement in `$EDITOR`, at its line.
 *
 * The renderer must be suspended first: the editor takes over the terminal,
 * and two programs drawing to one screen produces garbage that survives the
 * editor exiting.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CliRenderer } from '@opentui/core';

/** `+12 file` is understood by vim, nvim, nano, emacs and helix alike. */
function argsFor(editor: string, file: string, line: number): string[] {
  const base = editor.split(/\s+/).slice(1);
  const name = (editor.split(/\s+/)[0] ?? '').replace(/.*\//, '');
  if (/^(code|codium|subl)$/.test(name)) return [...base, '--goto', `${file}:${line}`];
  return [...base, `+${line}`, file];
}

/**
 * `$VISUAL`, then `$EDITOR`, then the first common terminal editor installed.
 *
 * The fallback matters on a first run: plenty of machines never set
 * `$EDITOR`, and "No $EDITOR set" is a dead end for someone being guided.
 */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const chosen = env['VISUAL'] ?? env['EDITOR'];
  if (chosen) return chosen;
  const dirs = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  return ['nano', 'vim', 'vi'].find((name) => dirs.some((d) => existsSync(join(d, name))));
}

export function openInEditor(
  renderer: CliRenderer | undefined,
  file: string,
  line: number,
): { ok: boolean; reason?: string } {
  const editor = resolveEditor();
  if (!editor) return { ok: false, reason: 'No $EDITOR set, and no nano or vim found' };

  const command = editor.split(/\s+/)[0]!;
  renderer?.suspend();
  try {
    const result = spawnSync(command, argsFor(editor, file, line), { stdio: 'inherit' });
    if (result.error) return { ok: false, reason: result.error.message };
    return { ok: true };
  } finally {
    // In `finally` so a crashing editor cannot leave the terminal unusable.
    renderer?.resume();
  }
}

/**
 * Hands the terminal to another program — an agent's own session — until it
 * exits, then takes it back.
 */
export function runInTerminal(
  renderer: CliRenderer | undefined,
  command: { command: string; args: string[]; env?: Record<string, string> },
  cwd: string,
): { ok: boolean; reason?: string } {
  // ctrl+c there reaches every process in this terminal: meant for the agent,
  // it must not end spec-tacular too.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  renderer?.suspend();
  try {
    const result = spawnSync(command.command, command.args, {
      stdio: 'inherit',
      cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
    });
    if (result.error) return { ok: false, reason: result.error.message };
    return { ok: true };
  } finally {
    renderer?.resume();
    process.off('SIGINT', ignore);
  }
}
