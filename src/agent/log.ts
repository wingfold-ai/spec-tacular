/**
 * Timings for the advisor, when asked for.
 *
 * The TUI owns the terminal, so nothing can go to stderr while it runs. With
 * SPECTACULAR_DEBUG_LOG set to a file, each advisor request appends a line —
 * which session answered it, whether it was a delta, and how long it took.
 */

import { appendFileSync } from 'node:fs';

export function debugLog(line: string): void {
  const file = process.env['SPECTACULAR_DEBUG_LOG'];
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // A log that cannot be written must never break the thing being logged.
  }
}
