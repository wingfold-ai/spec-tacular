/**
 * When an agent declines to write an artifact.
 *
 * The prompt tells it to stop rather than design around accepted
 * requirements that are wrong or contradict each other. That is the right
 * call, but a job that stops still exits 0 — and the reason it gives is the
 * last message in a log nobody reads. So it is asked to leave a report, in a
 * shape this module can read back: which requirements are in conflict, so the
 * TUI can put their actual text side by side and send you to revise them.
 *
 * A job that stopped without writing one (an older prompt, a driver that
 * ignored it) still has its final message; that is used instead, and the
 * requirements it mentions by name are found in it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ReviewItem } from './requirements.ts';

/** Where the agent writes its report for one artifact of one change. */
export function stopPath(projectRoot: string, change: string, artifact: string): string {
  return join(projectRoot, '.spec-tacular', 'stops', change, `${artifact}.md`);
}

/** What the prompt asks of an agent that cannot write the artifact. */
export function stopInstructions(projectRoot: string, change: string, artifact: string): string {
  const path = relative(projectRoot, stopPath(projectRoot, change, artifact));
  return [
    '# If you stop instead of writing it',
    '',
    `Do not write the ${artifact} then. Write a report to \`${path}\` instead —`,
    'the developer is shown it, with the text of every requirement you name —',
    'in exactly this shape:',
    '',
    '```markdown',
    `# Stopped: ${artifact}`,
    '',
    'One or two sentences: why it cannot be written as the requirements stand.',
    '',
    '## Conflict: <what contradicts what, in a few words>',
    '',
    '- <capability>: <requirement name, exactly as in its ### Requirement: header>',
    '- <capability>: <requirement name>',
    '',
    'How they contradict, quoting the lines that do.',
    '',
    '## Gap: <what is missing or ambiguous, in a few words>',
    '',
    '- <capability>: <requirement name>',
    '',
    'What is missing, and why it decides the design.',
    '',
    '## Recommendation',
    '',
    'How you would resolve it, if you have a view.',
    '```',
    '',
    'One `## Conflict:` or `## Gap:` section per problem, each listing every',
    'requirement involved. Then end your reply.',
    '',
  ].join('\n');
}

/** One problem the agent found, and the requirements it involves. */
export interface StopIssue {
  /** `conflict`, `gap` — whatever word the section header used, lowercased. */
  kind: string;
  title: string;
  /** The explanation, without the requirement list. */
  body: string;
  requirements: ReviewItem[];
}

export interface StopReport {
  change: string;
  artifact: string;
  /** The report as written — or the agent's final message, when it wrote none. */
  text: string;
  /** Whether `text` is a report in the asked-for shape, or only a final message. */
  source: 'report' | 'message';
  /** Its first paragraph: what the developer sees before opening it. */
  summary: string;
  issues: StopIssue[];
  /** Every requirement it names, in the order it first names them. */
  named: ReviewItem[];
}

const ISSUE_HEADER = /^##\s+([A-Za-z][\w -]*?)\s*:\s*(.+?)\s*$/;
/** `## Conflict: …`, `## Gap: …` — any `Word: title` header but a recommendation. */
function isIssueHeader(line: string): boolean {
  const m = ISSUE_HEADER.exec(line);
  return m !== null && !/^recommend/i.test(m[1]!);
}
const LISTED = /^\s*[-*]\s+`?([\w.-]+)`?\s*[:›>]\s*(.+?)\s*$/;

const norm = (s: string) =>
  s.toLowerCase().replace(/[`*_"“”‘’']/g, '').replace(/^requirement:\s*/, '').replace(/\s+/g, ' ').trim();

/** The requirement a `- capability: name` line points at, if there is one. */
function lookup(capability: string, name: string, items: ReviewItem[]): ReviewItem | null {
  const n = norm(name);
  return (
    items.find((i) => norm(i.capability) === norm(capability) && norm(i.name) === n) ??
    items.find((i) => norm(i.name) === n) ??
    null
  );
}

/**
 * The requirements a free-form text mentions by name, in order of mention.
 *
 * Short names are skipped: "Login" turns up in prose about anything, whereas
 * "Scorer is picked from the team's squad by name" is only ever a reference.
 */
export function mentioned(text: string, items: ReviewItem[]): ReviewItem[] {
  const hay = norm(text);
  return items
    .filter((i) => norm(i.name).length >= 12 || i.name.trim().split(/\s+/).length >= 3)
    .map((i) => ({ item: i, at: hay.indexOf(norm(i.name)) }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.item);
}

function unique(items: ReviewItem[]): ReviewItem[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id));
}

function firstParagraph(text: string): string {
  const paragraphs = text
    .replace(/^#[^\n]*\n/, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !p.startsWith('#'));
  return (paragraphs[0] ?? '').replace(/\s+/g, ' ');
}

/** Reads a report — or a final message — against the change's requirements. */
export function parseStop(
  text: string,
  items: ReviewItem[],
  meta: { change: string; artifact: string; source: StopReport['source'] },
): StopReport {
  const issues: StopIssue[] = [];
  let current: { kind: string; title: string; body: string[]; listed: ReviewItem[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.body.join('\n').trim();
    issues.push({
      kind: current.kind,
      title: current.title,
      body,
      // What it listed first, then anything else its explanation names.
      requirements: unique([...current.listed, ...mentioned(body, items)]),
    });
    current = null;
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const header = isIssueHeader(line) ? ISSUE_HEADER.exec(line) : null;
    if (header) {
      close();
      current = { kind: header[1]!.toLowerCase(), title: header[2]!, body: [], listed: [] };
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      close();
      continue;
    }
    if (!current) continue;
    const listed = LISTED.exec(line);
    const item = listed ? lookup(listed[1]!, listed[2]!, items) : null;
    if (item) current.listed.push(item);
    else current.body.push(line);
  }
  close();

  // A final message has no sections; what it names is still worth showing.
  const named = unique([...issues.flatMap((i) => i.requirements), ...mentioned(text, items)]);
  return { ...meta, text: text.trim(), summary: firstParagraph(text), issues, named };
}

/** The report the agent left for this artifact, if any. */
export function readStopReport(projectRoot: string, change: string, artifact: string): string | null {
  const path = stopPath(projectRoot, change, artifact);
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Keeps a final message as the report, so it outlives the job's log and is
 * read the same way next time.
 */
export function saveStopReport(projectRoot: string, change: string, artifact: string, text: string): void {
  const path = stopPath(projectRoot, change, artifact);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/** A new attempt makes the old report stale. */
export function clearStopReport(projectRoot: string, change: string, artifact: string): void {
  rmSync(stopPath(projectRoot, change, artifact), { force: true });
}

/**
 * Renders a report for reading: the agent's words, with the full text of
 * every requirement a problem involves right under it, so a contradiction can
 * be seen rather than taken on trust.
 */
export function renderStop(report: StopReport): string {
  const out: string[] = [`# The agent stopped instead of writing the ${report.artifact}`, ''];
  const quote = (item: ReviewItem) => [
    `### ${item.capability} › ${item.name}`,
    '',
    ...item.text.split('\n').map((l) => `> ${l}`),
    '',
  ];
  const lines = report.text.replace(/^#\s[^\n]*\n+/, '').split('\n');

  if (report.issues.length > 0) {
    // The issues are in the order their headers appear, so the n-th issue
    // header met is the n-th issue.
    let open: StopIssue | null = null;
    let next = 0;
    const flush = () => {
      if (open) for (const item of open.requirements) out.push(...quote(item));
      open = null;
    };
    for (const line of lines) {
      if (/^#{1,2}\s/.test(line)) {
        flush();
        if (isIssueHeader(line)) open = report.issues[next++] ?? null;
      }
      out.push(line);
    }
    flush();
    return out.join('\n').trimEnd() + '\n';
  }

  // No sections to hang them under: the requirements it names come after.
  out.push(...lines, '');
  if (report.named.length > 0) {
    out.push('## The requirements it names', '');
    for (const item of report.named) out.push(...quote(item));
  }
  return out.join('\n').trimEnd() + '\n';
}
