/**
 * Revising one requirement with the agent (src/core/refine.ts): what the
 * agent is told, what of its answer is accepted, and that writing it changes
 * that requirement's block and not one other byte — nor anyone else's review.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt } from '../src/agent/prompt.ts';
import { lineDiff } from '../src/render/diff.ts';
import {
  acceptRefinement,
  buildRefineParts,
  parseRefinement,
  readRequirementBlock,
  remapAfterRevision,
  REFINE_SCHEMA,
  RequirementRefiner,
  writeRequirementBlock,
  type RefineContext,
} from '../src/core/refine.ts';
import { capabilityFromPath, parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { currentItem, decide, moveTo, openSession } from '../src/core/session.ts';

const SPEC = `# Sessions

## ADDED Requirements

### Requirement: Session timeout
The system SHALL end an idle session after {{example: 30 minutes}}.

#### Scenario: Idle user
- **WHEN** a user is idle for the timeout
- **THEN** their session ends

### Requirement: Remember me
The system SHALL keep a session across restarts when asked to.

#### Scenario: Returning user
- **WHEN** a user who ticked "remember me" comes back
- **THEN** they are still signed in

## Notes

Written by hand.
`;

const REVISED = `### Requirement: Session timeout
The system SHALL end an idle session after a configurable timeout.

#### Scenario: Idle user
- **WHEN** a user is idle for the configured timeout
- **THEN** their session ends`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function specFile(content = SPEC): string {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-refine-'));
  dirs.push(root);
  const dir = join(root, 'openspec', 'changes', 'c', 'specs', 'auth');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'spec.md');
  writeFileSync(file, content);
  return file;
}

const parse = (file: string) =>
  parseSpecFile(readFileSync(file, 'utf8'), capabilityFromPath(file), file).requirements;

const contextOf = (file: string, i = 0): RefineContext => ({
  requirement: parse(file)[i]!,
  spec: readFileSync(file, 'utf8'),
  proposal: '## Why\n\nUsers get signed out too often.\n<!-- template reminder -->\n',
});

describe('the prompt', () => {
  test('carries the requirement, its spec, the proposal and the rules', () => {
    const file = specFile();
    const text = renderPrompt(buildRefineParts(contextOf(file), [], 'make the timeout configurable'));
    expect(text).toContain('make the timeout configurable');
    expect(text).toContain('### Requirement: Session timeout');
    expect(text).toContain('### Requirement: Remember me'); // the surrounding spec
    expect(text).toContain('Users get signed out too often');
    expect(text).not.toContain('template reminder');
    expect(text).toContain('#### Scenario:');
    expect(text).toContain('the requirement as it is in the file now');
  });

  test('a later round carries every earlier one and builds on the latest', () => {
    const file = specFile();
    const parts = buildRefineParts(
      contextOf(file),
      [
        { instruction: 'make the timeout configurable', revised: REVISED },
        { instruction: 'add a scenario for the default', revised: `${REVISED}\n\n#### Scenario: Default` },
      ],
      'shorter please',
    );
    const text = renderPrompt(parts);
    expect(text).toContain('[1] the developer asked: make the timeout configurable');
    expect(text).toContain('[2] the developer asked: add a scenario for the default');
    expect(text).toContain('[2] | #### Scenario: Default');
    expect(parts.task).toContain('your latest proposal, [2]');
  });

  test('a MODIFIED requirement is told to keep its name', () => {
    const file = specFile(SPEC.replace('## ADDED Requirements', '## MODIFIED Requirements'));
    expect(buildRefineParts(contextOf(file), [], 'x').rules).toContain('Keep the name exactly');
  });
});

describe('the answer', () => {
  test('a single requirement is taken, trimmed and unfenced', () => {
    const file = specFile();
    const r = parseRefinement({ requirement: `\`\`\`markdown\n${REVISED}  \n\`\`\``, summary: ' Made it configurable. ' }, contextOf(file));
    expect(r.block).toBe(REVISED);
    expect(r.summary).toBe('Made it configurable.');
    expect(r.warnings).toEqual([]);
  });

  test('anything that is not exactly one requirement is refused', () => {
    const ctx = contextOf(specFile());
    expect(() => parseRefinement({ requirement: 'The system SHALL…', summary: '' }, ctx)).toThrow('does not start');
    expect(() => parseRefinement({ requirement: `${REVISED}\n\n### Requirement: Another\nIt SHALL.`, summary: '' }, ctx)).toThrow('2 requirements');
    expect(() => parseRefinement({ requirement: `${REVISED}\n\n## Notes`, summary: '' }, ctx)).toThrow('"## " heading');
    expect(() => parseRefinement({ summary: 'nothing' }, ctx)).toThrow('without a requirement');
  });

  test('a rename is flagged, and refused when another requirement has that name', () => {
    const ctx = contextOf(specFile());
    const renamed = parseRefinement({ requirement: REVISED.replace('Session timeout', 'Idle timeout'), summary: '' }, ctx);
    expect(renamed.warnings.join()).toContain('Renames it to "Idle timeout"');
    expect(() =>
      parseRefinement({ requirement: REVISED.replace('Session timeout', 'Remember me'), summary: '' }, ctx),
    ).toThrow('another requirement in this spec already uses');
  });

  test('no scenario, or no change at all, is worth a warning', () => {
    const file = specFile();
    const ctx = contextOf(file);
    const bare = parseRefinement({ requirement: '### Requirement: Session timeout\nThe system SHALL end it.', summary: '' }, ctx);
    expect(bare.warnings).toContain('It has no scenario left');
    const same = readRequirementBlock(ctx.requirement);
    expect(same.ok).toBe(true);
    expect(parseRefinement({ requirement: same.ok ? same.block : '', summary: '' }, ctx).warnings).toContain('Nothing changed');
  });

  test('the refiner asks in think mode, with the prompt in parts', async () => {
    const file = specFile();
    const asked: { schema: object; mode?: string; hasParts: boolean }[] = [];
    const refiner = new RequirementRefiner(async (_prompt, schema, options) => {
      asked.push({ schema, mode: options?.mode, hasParts: options?.parts !== undefined });
      return { requirement: REVISED, summary: 'Configurable.' };
    });
    const r = await refiner.propose(contextOf(file), [], 'make it configurable');
    expect(r.block).toBe(REVISED);
    expect(asked).toEqual([{ schema: REFINE_SCHEMA, mode: 'think', hasParts: true }]);
  });
});

describe('writing it back', () => {
  test('replaces that requirement only; every other byte stays', () => {
    const file = specFile();
    const [timeout] = parse(file);
    expect(writeRequirementBlock(timeout!, REVISED)).toEqual({ ok: true });
    const after = readFileSync(file, 'utf8');
    const original = readRequirementBlock(timeout!);
    expect(original.ok).toBe(false); // it is gone: the file no longer holds that text
    expect(after).toBe(SPEC.replace(/### Requirement: Session timeout[\s\S]*?their session ends/, REVISED));
    expect(after).toContain('### Requirement: Remember me\nThe system SHALL keep');
    expect(after.endsWith('## Notes\n\nWritten by hand.\n')).toBe(true);
  });

  test('keeps a CRLF file CRLF, and a last block without a newline without one', () => {
    const crlf = SPEC.replace(/\n/g, '\r\n').replace(/## Notes\r\n\r\nWritten by hand.\r\n$/, '').trimEnd();
    const file = specFile(crlf);
    const [, remember] = parse(file);
    const block = '### Requirement: Remember me\nThe system SHALL keep a session for 30 days when asked to.';
    expect(writeRequirementBlock(remember!, block)).toEqual({ ok: true });
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(crlf.slice(0, crlf.indexOf('### Requirement: Remember me')))).toBe(true);
    expect(after.endsWith(block.replace(/\n/g, '\r\n'))).toBe(true);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('refuses when the file changed since it was read', () => {
    const file = specFile();
    const [timeout] = parse(file);
    writeFileSync(file, SPEC.replace('30 minutes', '15 minutes'));
    const result = writeRequirementBlock(timeout!, REVISED);
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('15 minutes');
  });
});

describe('review state across a revision', () => {
  test('the revised requirement is pending again; the others keep their decisions', () => {
    const file = specFile();
    let session = openSession('c', parse(file), emptyReview('c'));
    session = decide(session, 'rejected', { note: 'the timeout must be configurable' });
    session = decide(moveTo(session, 1), 'accepted');
    const [timeout, remember] = session.items.map((i) => i.item) as Requirement[];

    const result = acceptRefinement(moveTo(session, 0), timeout!, REVISED, () => parse(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const revised = currentItem(result.session)!;
    expect(revised.item.name).toBe('Session timeout');
    expect(revised.state).toBe('pending');
    expect(revised.drifted).toBe(false);
    expect(revised.review.note).toBeUndefined();
    const other = result.session.items.find((i) => i.item.id === remember!.id)!;
    expect(other.state).toBe('accepted');
    expect(other.drifted).toBe(false);
  });

  test('a rename moves the cursor with it and leaves the old id behind', () => {
    const file = specFile();
    let session = openSession('c', parse(file), emptyReview('c'));
    session = decide(session, 'accepted');
    const [timeout] = session.items.map((i) => i.item) as Requirement[];
    const result = acceptRefinement(moveTo(session, 0), timeout!, REVISED.replace('Session timeout', 'Idle timeout'), () => parse(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentItem(result.session)!.item.id).toBe('auth#idle-timeout');
    expect(result.session.review.cursor).toBe('auth#idle-timeout');
    expect(result.session.review.requirements['auth#session-timeout']).toBeUndefined();
  });

  test('renaming one of two same-named requirements does not hand its state to the other', () => {
    const twin = SPEC.replace('Requirement: Remember me', 'Requirement: Session timeout');
    const file = specFile(twin);
    const before = parse(file);
    expect(before.map((r) => r.id)).toEqual(['auth#session-timeout', 'auth#session-timeout~2']);
    let session = openSession('c', before, emptyReview('c'));
    session = decide(moveTo(session, 1), 'accepted');

    // The first is renamed: the second's id shifts from `~2` to the bare slug.
    const after = [...before];
    writeRequirementBlock(before[0]!, REVISED.replace('Session timeout', 'Idle timeout'));
    after.splice(0, after.length, ...parse(file));
    expect(after.map((r) => r.id)).toEqual(['auth#idle-timeout', 'auth#session-timeout']);

    const { review } = remapAfterRevision(session.review, before, after, before[0]!);
    expect(review.requirements['auth#session-timeout']?.state).toBe('accepted');
    expect(review.requirements['auth#session-timeout']?.hash).toBe(after[1]!.hash);
    expect(review.requirements['auth#idle-timeout']?.state).toBe('pending');
    expect(review.requirements['auth#session-timeout~2']).toBeUndefined();
  });
});

describe('the diff a proposal is shown as', () => {
  test('keeps shared lines, and shows a change as a removal and an addition', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(lineDiff([], ['x'])).toEqual([{ op: '+', text: 'x' }]);
    expect(lineDiff(['x'], [])).toEqual([{ op: '-', text: 'x' }]);
  });
});
