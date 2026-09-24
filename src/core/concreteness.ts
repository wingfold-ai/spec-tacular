/**
 * The concreteness linter.
 *
 * Flags values a requirement names that the project may not have decided yet:
 * endpoints, identifiers, file paths, library names. It cannot know whether
 * any given one is a real contract — for a CLI tool the command names *are*
 * the contract — so it is advisory by construction and never blocks a stage.
 * Its job is to put the question in front of a human at review time, where it
 * is one keystroke to answer.
 *
 * Anything inside `{{example: ...}}` is never flagged: that is the reviewer
 * having already answered.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findExamples, isInsideExample } from './examples.ts';
import type { Requirement } from './requirements.ts';

export type FindingKind = 'http-endpoint' | 'url-path' | 'identifier' | 'file-path';

export interface Finding {
  kind: FindingKind;
  /** The flagged text, exactly as it appears — so it can be marked as an example. */
  value: string;
  /** Offset into the text that was scanned. */
  offset: number;
  /** What to ask the reviewer. */
  question: string;
}

export interface LintConfig {
  /**
   * Values never flagged. Matched case-insensitively against the whole token,
   * so a project can silence the vocabulary it genuinely owns.
   */
  allow: string[];
  /**
   * Technologies the project has committed to, read from the Foundation stack.
   *
   * There is no rule that flags library names, because no list of every
   * library exists. The stack works the other way round: naming something the
   * project already chose is a decision made, so it is never flagged.
   */
  stack: string[];
}

export const EMPTY_CONFIG: LintConfig = { allow: [], stack: [] };

interface Rule {
  kind: FindingKind;
  pattern: RegExp;
  question: string;
  /**
   * Only flag when the match sits inside backticks.
   *
   * Used for PascalCase, where prose and code are otherwise indistinguishable:
   * `PowerShell`, `OpenCode` and `CodeBuddy` are product names a spec is
   * entitled to use, while `ToolCommandAdapter` is an internal class. Authors
   * reliably backtick the latter and not the former, which is a better signal
   * than anything the shape of the word provides.
   */
  codeOnly?: boolean;
}

/** Spans covered by inline code, so `x` can be told from plain prose. */
function backtickSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(/`+[^`]*`+/g)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

const HTTP_VERBS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

const RULES: Rule[] = [
  {
    kind: 'http-endpoint',
    // A verb followed by a path is the clearest case of an interface being
    // decided inside a requirement.
    pattern: new RegExp(`\\b(${HTTP_VERBS})\\s+(/[A-Za-z0-9._~\\-/{}:]*)`, 'g'),
    question: 'names an HTTP endpoint',
  },
  {
    kind: 'url-path',
    // At least two segments: `/users/{id}`. One segment is usually prose
    // ("the /tmp directory") or a CLI path, and flagging it is noise.
    pattern: /(?<![A-Za-z0-9._~\-])(\/[A-Za-z0-9._~\-{}]+){2,}\/?/g,
    question: 'names a URL or path',
  },
  {
    kind: 'identifier',
    // Starts lowercase: `skillsDir`, `existingOutputPaths`. No English word
    // has this shape, so prose never collides with it.
    pattern: /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g,
    question: 'names a field or symbol',
  },
  {
    kind: 'identifier',
    // Starts uppercase: `ToolCommandAdapter`, but also `PowerShell`. Only
    // flagged in code formatting — see `codeOnly`.
    pattern: /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g,
    question: 'names a class or symbol',
    codeOnly: true,
  },
  {
    kind: 'identifier',
    pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
    question: 'names a field or table',
  },
  {
    kind: 'file-path',
    pattern: /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java|kt|sql|yaml|yml|json|toml|md)\b/g,
    question: 'names a file',
  },
];

/**
 * Tokens shaped like findings that never are.
 *
 * Platform and product names are the awkward case: `macOS` and `iOS` have the
 * exact shape of a camelCase symbol. They are spelled that way by convention,
 * not because anyone decided an interface.
 */
const NEVER_FLAG = new Set([
  'openspec', 'spec', 'specs', 'readme',
  'javascript', 'typescript', 'github', 'gitlab',
  'macos', 'ios', 'ipados', 'watchos', 'tvos', 'youtube', 'paypal', 'ebay',
]);

/**
 * `Node.js`, `Vue.js`, `Next.js` — a framework, not a file.
 *
 * A single capitalised word before the extension. Real file references are
 * lowercase, kebab, snake, all-caps (`README.md`) or multi-cap
 * (`CommandContent.ts`), none of which match.
 */
function isProductName(value: string): boolean {
  return /^[A-Z][a-z]+\.[a-z]+$/.test(value);
}

function trimSentencePunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]]+$/, '');
}

function allowed(value: string, config: LintConfig): boolean {
  const lower = value.toLowerCase();
  if (NEVER_FLAG.has(lower)) return true;
  if (config.allow.some((a) => a.toLowerCase() === lower)) return true;
  // A library the project already committed to is a decision, not a guess.
  return config.stack.some((s) => s.toLowerCase() === lower);
}

/**
 * Scans one block of text.
 *
 * Overlapping matches are collapsed: `POST /v1/export` should read as one
 * endpoint finding, not also as a bare path.
 */
export function lintText(text: string, config: LintConfig = EMPTY_CONFIG): Finding[] {
  const examples = findExamples(text);
  const code = backtickSpans(text);
  const inCode = (offset: number) => code.some((c) => offset >= c.start && offset < c.end);
  const found: Finding[] = [];
  const claimed: { start: number; end: number }[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (match.index === undefined) continue;
      // A path's charset includes `.`, which otherwise swallows the sentence's
      // full stop — and the value has to be exact, because it is what gets
      // wrapped in `{{example: ...}}`.
      const value = trimSentencePunctuation(match[0]);
      if (value.trim() === '') continue;

      const start = match.index;
      const end = start + value.length;

      if (isInsideExample(examples, start)) continue;
      if (rule.codeOnly && !inCode(start)) continue;
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      if (allowed(value, config)) continue;
      if (rule.kind === 'file-path' && isProductName(value)) continue;

      claimed.push({ start, end });
      found.push({ kind: rule.kind, value: value.trim(), offset: start, question: rule.question });
    }
  }

  return found.sort((a, b) => a.offset - b.offset);
}

/** Scans a requirement's prose and every scenario body. */
export function lintRequirement(
  requirement: Requirement,
  config: LintConfig = EMPTY_CONFIG,
): Finding[] {
  const parts = [requirement.text, ...requirement.scenarios.flatMap((s) => s.body)];
  return parts.flatMap((part) => lintText(part, config));
}


/**
 * Loads the per-project tuning.
 *
 * `spec-tacular/lint.json` holds the allowlist: the vocabulary a project
 * genuinely owns and should stop being asked about. It is committed and
 * hand-edited, because only a human knows which of its own nouns are
 * contracts.
 *
 * The stack comes from the Foundation (M7). Every backticked token in
 * `foundation/stack.md` counts as a committed technology — authors reliably
 * mark them that way, and it needs no schema of its own.
 */
export function loadLintConfig(projectRoot: string): LintConfig {
  const allow: string[] = [];
  const configPath = join(projectRoot, 'spec-tacular', 'lint.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { allow?: unknown };
      if (Array.isArray(parsed.allow)) {
        allow.push(...parsed.allow.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      // A broken lint config must not stop a review. The cost of ignoring it
      // is a few extra questions, which is the linter's whole failure mode.
    }
  }

  const stack: string[] = [];
  const stackPath = join(projectRoot, 'spec-tacular', 'foundation', 'stack.md');
  if (existsSync(stackPath)) {
    try {
      const content = readFileSync(stackPath, 'utf8');
      for (const match of content.matchAll(/`([^`\n]+)`/g)) {
        const token = (match[1] ?? '').trim();
        if (token) stack.push(token);
      }
    } catch {
      // As above.
    }
  }

  return { allow, stack };
}
