/**
 * Long-running agent processes, and making sure none outlives spec-tacular.
 *
 * A session's process waits for its next message indefinitely. Claude Code
 * notices its stdin closing and exits with us, but a server such as
 * `opencode serve` reads no stdin and would linger for good. So every one is
 * registered here and killed on the way out — however the way out happens:
 * quitting, ctrl+c, SIGTERM, or an uncaught error.
 */

import type { ChildProcess } from 'node:child_process';

const live = new Set<ChildProcess>();
let hooked = false;

export function killAll(): void {
  for (const child of live) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  live.clear();
}

/** Registers a child to be killed when this process exits. */
export function adopt(child: ChildProcess): ChildProcess {
  live.add(child);
  child.once('exit', () => live.delete(child));
  if (!hooked) {
    hooked = true;
    // 'exit' handlers must be synchronous; kill() is.
    process.once('exit', killAll);
    // A signal ends the process without 'exit' handlers running, so each is
    // caught here too. The TUI's renderer listens for the same signals to
    // restore the terminal — it registered first, so it has run by now.
    const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
    for (const signal of Object.keys(codes) as (keyof typeof codes)[]) {
      process.once(signal, () => {
        killAll();
        process.exit(codes[signal]);
      });
    }
  }
  return child;
}

/** How many adopted children are still running — for tests. */
export function liveChildren(): number {
  return live.size;
}
