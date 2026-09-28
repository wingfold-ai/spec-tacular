/**
 * A prompt in parts, so a long-running session can be sent only what changed.
 *
 * Every advisor request carries the whole project as decided so far. Resending
 * all of it on every question is what a one-shot process has to do; a session
 * that already read it only needs the difference and the new task. The full
 * rendering is still what a fresh session, or the one-shot fallback, gets —
 * a delta is an optimisation, never the only way to be correct.
 */

/** A named list of facts: "Decided so far", "The interview so far". */
export interface ContextSection {
  heading: string;
  lines: string[];
  /** Shown instead of the lines when there are none. */
  empty?: string;
}

export interface PromptParts {
  /** Standing instructions before the context. Sent once per session. */
  preamble: string;
  context: ContextSection[];
  /** What this request asks for. Always sent. */
  task: string;
  /** Standing rules after the task. Sent once per session. */
  rules?: string;
}

/** The whole prompt, as a one-shot request or a fresh session reads it. */
export function renderPrompt(parts: PromptParts): string {
  const lines = [parts.preamble, ''];
  for (const s of parts.context) {
    lines.push(`${s.heading}:`, ...(s.lines.length > 0 ? s.lines : [s.empty ?? '(none)']), '');
  }
  lines.push(parts.task);
  if (parts.rules) lines.push('', parts.rules);
  return lines.join('\n');
}

/**
 * What to send a session that already read `before`: the lines added to and
 * removed from each section since, then the task.
 */
export function renderDelta(before: ContextSection[], parts: PromptParts): string {
  const out: string[] = [];
  for (const s of parts.context) {
    const was = new Set(before.find((b) => b.heading === s.heading)?.lines ?? []);
    const now = new Set(s.lines);
    const added = s.lines.filter((l) => !was.has(l));
    const removed = [...was].filter((l) => !now.has(l));
    if (added.length > 0) out.push(`${s.heading} — now also:`, ...added, '');
    if (removed.length > 0) out.push(`${s.heading} — no longer:`, ...removed, '');
  }
  return [
    out.length > 0
      ? 'Since my last message the project changed:\n\n' + out.join('\n')
      : 'Nothing else changed since my last message.\n',
    'Same instructions and rules as before. The new request:',
    '',
    parts.task,
  ].join('\n');
}
