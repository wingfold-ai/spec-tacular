/**
 * Opens a requirement in `$EDITOR`, at its line.
 *
 * The renderer must be suspended first: the editor takes over the terminal,
 * and two programs drawing to one screen produces garbage that survives the
 * editor exiting.
 */

import { spawnSync } from 'node:child_process';
import type { CliRenderer } from '@opentui/core';

/** `+12 file` is understood by vim, nvim, nano, emacs and helix alike. */
function argsFor(editor: string, file: string, line: number): string[] {
  const base = editor.split(/\s+/).slice(1);
  const name = (editor.split(/\s+/)[0] ?? '').replace(/.*\//, '');
  if (/^(code|codium|subl)$/.test(name)) return [...base, '--goto', `${file}:${line}`];
  return [...base, `+${line}`, file];
}

export function openInEditor(
  renderer: CliRenderer | undefined,
  file: string,
  line: number,
): { ok: boolean; reason?: string } {
  const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
  if (!editor) return { ok: false, reason: 'No $EDITOR set' };

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
