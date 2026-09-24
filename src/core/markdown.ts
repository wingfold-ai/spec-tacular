/**
 * Markdown primitives, deliberately mirroring OpenSpec's own parsers.
 *
 * These regexes and normalization rules are copied from
 * `src/core/parsers/{requirement-blocks,requirement-text,spec-structure,code-fence}.ts`
 * in @fission-ai/openspec. spec-tacular must agree with OpenSpec about what a
 * requirement *is* — a requirement this parser cannot see is one a human can
 * never review, and one it invents is one that does not exist. Any divergence
 * here is a bug, so the rules are kept together and cited rather than
 * re-derived.
 */

/** `## ADDED Requirements` and friends. */
export const DELTA_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;

/** `## Requirements`, the main (non-delta) spec section. */
export const REQUIREMENTS_HEADER = /^##\s+Requirements\s*$/i;

/** Any `## ` section header. */
export const SECTION_HEADER = /^##\s+/;

/** `### Requirement: <name>`. The missing space in `###Requirement:` is accepted. */
export const REQUIREMENT_HEADER = /^###\s*Requirement:\s*(.+)\s*$/i;

/** `#### Scenario: <name>` — and any other `#### ` header inside a requirement. */
export const SCENARIO_HEADER = /^####\s+/;

/** ``FROM: `### Requirement: <name>` `` in a RENAMED section. */
export const RENAME_FROM = /^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;
export const RENAME_TO = /^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;

/** Strips a leading BOM and normalizes CRLF/CR to LF. */
export function normalizeContent(content: string): string {
  return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * An ATX heading may close with a run of `#`. `### Requirement: Foo ###` names
 * `Foo`, but `C#` keeps its `#` — only a run preceded by a space or tab closes
 * the heading, which is why this is `[ \t]` and not `\s`.
 */
export function normalizeRequirementName(name: string): string {
  return name.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

interface ActiveFence {
  marker: '`' | '~';
  length: number;
}

function openingFence(line: string): ActiveFence | null {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  if (!m?.[1]) return null;
  return { marker: m[1][0] as '`' | '~', length: m[1].length };
}

function closesFence(line: string, fence: ActiveFence): boolean {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(m?.[1] && m[1][0] === fence.marker && m[1].length >= fence.length);
}

/**
 * Per-line mask marking lines inside a fenced code block, fences included.
 *
 * Without this, a `### Requirement:` shown as an *example* inside a fenced
 * block — which the schema's own instructions do — parses as a real
 * requirement. OpenSpec had exactly that bug; the mask is how it was fixed.
 */
export function buildCodeFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let active: ActiveFence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!active) {
      const fence = openingFence(line);
      if (fence) {
        active = fence;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (closesFence(line, active)) active = null;
  }
  return mask;
}
