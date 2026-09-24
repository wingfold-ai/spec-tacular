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
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        killAll();
        process.exit(128 + (signal === 'SIGTERM' ? 15 : 1));
      });
    }
  }
  return child;
}

/** How many adopted children are still running — for tests. */
export function liveChildren(): number {
  return live.size;
}
