/**
 * How far a change's implementation is, read from its tasks.md checkboxes.
 *
 * A change is applied once every task is ticked — except the ones marked
 * `(defer: …)`, which need a deployed environment to verify. Those are the
 * schema's own escape hatch (schemas/spec-tacular/schema.yaml): they wait
 * for the archive, where they go to the pending register, and must not hold
 * up the next slice meanwhile.
 */

export interface TaskProgress {
  total: number;
  /** Ticked. */
  done: number;
  /** Not ticked, and marked `(defer: …)`: waiting for a deployment. */
  deferred: number;
  /** Not ticked, and nothing excuses it. */
  open: number;
  /** Every task ticked or deferred — and there is at least one. */
  applied: boolean;
}

const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const DEFERRED = /\(defer:[^)]*\)/i;

export function taskProgress(content: string): TaskProgress {
  let total = 0;
  let done = 0;
  let deferred = 0;
  for (const line of content.split('\n')) {
    const task = TASK.exec(line);
    if (!task) continue;
    total++;
    if (task[1] !== ' ') done++;
    else if (DEFERRED.test(task[2]!)) deferred++;
  }
  const open = total - done - deferred;
  return { total, done, deferred, open, applied: total > 0 && open === 0 };
}
