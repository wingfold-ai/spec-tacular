/**
 * The `{{example: ...}}` notation.
 *
 * Specs come back naming endpoints, table names and classes that nobody has
 * decided yet (docs/problem-analysis.md §5). Instructions alone demonstrably
 * do not hold — OpenSpec's own schema already says "avoid implementation
 * detail" and you still get endpoint names — so the distinction is made
 * explicit instead: an unmarked concrete value is a binding contract, a marked
 * one is an illustration.
 *
 * Marking is part of the requirement's text, so it changes the hash and resets
 * acceptance. That is correct: it changes what the requirement promises.
 */

/** A `{{example: ...}}` occurrence, with offsets into the original text. */
export interface ExampleSpan {
  /** Offset of the opening `{{`. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
  /** The illustrative value itself. */
  value: string;
}

// Non-greedy, and `}` is excluded from the value so a stray brace ends the
// span rather than swallowing the rest of the paragraph.
const EXAMPLE = /\{\{\s*example:\s*([^}]*?)\s*\}\}/gi;

export function findExamples(text: string): ExampleSpan[] {
  const spans: ExampleSpan[] = [];
  for (const match of text.matchAll(EXAMPLE)) {
    if (match.index === undefined) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      value: (match[1] ?? '').trim(),
    });
  }
  return spans;
}

/** Whether an offset falls inside a marked example. */
export function isInsideExample(spans: ExampleSpan[], offset: number): boolean {
  return spans.some((s) => offset >= s.start && offset < s.end);
}

/**
 * Replaces each `{{example: X}}` with `X` for reading.
 *
 * The braces are noise on screen; what matters is that the reviewer knows
 * which values are illustrative, which the caller shows separately.
 */
export function renderExamples(text: string): string {
  return text.replace(EXAMPLE, (_, value: string) => value.trim());
}

/** Every illustrative value in the text, in order. */
export function exampleValues(text: string): string[] {
  return findExamples(text).map((s) => s.value);
}

/**
 * Wraps the first occurrence of `value` in `{{example: ...}}`.
 *
 * Returns null when it cannot be done unambiguously — the value is absent, or
 * already inside a marked example. Rewriting a spec on a guess is worse than
 * declining and letting the reviewer open an editor.
 */
export function markAsExample(text: string, value: string): string | null {
  if (value.trim() === '') return null;
  const spans = findExamples(text);

  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at === -1) return null;
    if (!isInsideExample(spans, at)) {
      return `${text.slice(0, at)}{{example: ${value}}}${text.slice(at + value.length)}`;
    }
    from = at + 1;
  }
}
