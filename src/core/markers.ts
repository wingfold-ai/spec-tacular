/**
 * Parenthesised markers an agent writes on a task — `(shown red: …)`,
 * `(note: …)` — read with their parentheses balanced: a note that says
 * "(stderr, exit 1)" inside it is still one note, not a note that ends half
 * way and leaves the rest looking like an edit to the plan.
 */

/** `shown red`, optionally qualified (`shown red as uid 1000`), then a colon. */
export const SHOWN_RED = /^shown red\b[^:()\n]{0,60}:\s*[^\s)]/i;
export const NOTE = /^note:\s*[^\s)]/i;

/** Where each marker starting with `label` is: `[start, end)`, its parentheses included. */
export function markerSpans(text: string, label: RegExp): [number, number][] {
  const out: [number, number][] = [];
  for (let i = text.indexOf('('); i !== -1; i = text.indexOf('(', i + 1)) {
    if (!label.test(text.slice(i + 1, i + 80))) continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end === -1) continue; // never closed: not a marker
    out.push([i, end]);
    i = end - 1;
  }
  return out;
}

export function hasMarker(text: string, label: RegExp): boolean {
  return markerSpans(text, label).length > 0;
}

/**
 * The text without its markers. A marker on lines of its own goes with
 * those lines; one after other text goes with the spaces before it.
 */
export function stripMarkers(text: string, labels: RegExp[]): string {
  const spans = labels.flatMap((l) => markerSpans(text, l)).sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    if (start < at) continue;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const before = text.slice(lineStart, start);
    const after = /^[ \t]*(\n|$)/.exec(text.slice(end));
    if (before.trim() === '' && after && lineStart >= at) {
      out += text.slice(at, lineStart);
      at = end + after[0].length;
    } else {
      out += text.slice(at, start).replace(/[ \t]+$/, '');
      at = end;
    }
  }
  return out + text.slice(at);
}
