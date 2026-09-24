import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptedAdrs,
  listAdrs,
  markSuperseded,
  parseDecisions,
  promoteDecision,
  replaceDecisionBody,
  type Decision,
} from '../src/core/decisions.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-adr-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DESIGN = `# Design

## Context

Some context.

## Decisions

### Use result types for errors
**Scope: global**

**Decision:** Errors are values, not exceptions.

**Rationale:** Exceptions escape type checking.

### Cache the parsed schema
**Scope: local**

**Decision:** Parse once per process.

### Unmarked decision

**Decision:** Something.

## Risks / Trade-offs

Nothing much.
`;

const parse = (content = DESIGN) => parseDecisions(content, '/p/changes/c/design.md');

describe('parseDecisions', () => {
  test('reads each decision with its scope', () => {
    const decisions = parse();
    expect(decisions.map((d) => [d.name, d.scope])).toEqual([
      ['Use result types for errors', 'global'],
      ['Cache the parsed schema', 'local'],
      ['Unmarked decision', 'local'],
    ]);
  });

  test('defaults an unmarked scope to local', () => {
    // Promoting something project-wide without anyone saying so is the more
    // damaging guess.
    expect(parse()[2]!.scope).toBe('local');
  });

  test('ids and hashes make them reviewable like requirements', () => {
    const [first] = parse();
    expect(first!.id).toBe('design#use-result-types-for-errors');
    expect(first!.capability).toBe('design');
    expect(first!.hash).toStartWith('sha256:');
    expect(first!.line).toBe(9);
  });

  test('stops at the next top-level section', () => {
    expect(parse().map((d) => d.name)).not.toContain('Risks / Trade-offs');
    expect(parse()[2]!.text).not.toContain('Nothing much');
  });

  test('a design with no Decisions section yields nothing', () => {
    expect(parse('# Design\n\n## Context\n\nOnly context.\n')).toEqual([]);
  });

  test('ignores decisions inside fenced code blocks', () => {
    const decisions = parse(
      '## Decisions\n\n### Real\n**Scope: local**\n\n```md\n### Fake\n```\n',
    );
    expect(decisions.map((d) => d.name)).toEqual(['Real']);
  });

  test('disambiguates decisions with the same name', () => {
    const decisions = parse('## Decisions\n\n### Same\na\n\n### Same\nb\n');
    expect(decisions.map((d) => d.id)).toEqual(['design#same', 'design#same~2']);
  });
});

describe('the ADR store', () => {
  const globalDecision = (): Decision => parse()[0]!;

  test('promoting writes a numbered ADR', () => {
    const r = root();
    const { adr, reference } = promoteDecision(r, globalDecision(), { change: 'add-errors' });

    expect(adr.number).toBe(1);
    expect(adr.file).toEndWith('0001-use-result-types-for-errors.md');
    expect(reference).toContain('ADR-0001');

    const content = readFileSync(adr.file, 'utf8');
    expect(content).toContain('# ADR-0001: Use result types for errors');
    expect(content).toContain('**Status:** accepted');
    expect(content).toContain('**Origin:** change `add-errors`');
    expect(content).toContain('Errors are values, not exceptions.');
    // The scope marker is meaningless once promoted: an ADR is global by
    // definition.
    expect(content).not.toContain('Scope: global');
  });

  test('numbers increase', () => {
    const r = root();
    promoteDecision(r, globalDecision());
    expect(promoteDecision(r, { ...globalDecision(), name: 'Another' }).adr.number).toBe(2);
  });

  test('a gap in the middle never causes a reuse', () => {
    // Newer ADRs may reference the deleted one's neighbours by number.
    const r = root();
    const first = promoteDecision(r, globalDecision());
    promoteDecision(r, { ...globalDecision(), name: 'Second' });
    rmSync(first.adr.file);
    expect(promoteDecision(r, { ...globalDecision(), name: 'Third' }).adr.number).toBe(3);
  });

  test('superseding keeps the record and the number', () => {
    // The supported way to retire a decision. Deleting the newest ADR does
    // free its number, which is why supersede exists instead.
    const r = root();
    promoteDecision(r, globalDecision());
    const replacement = promoteDecision(r, { ...globalDecision(), name: 'Reversed' }, { supersedes: 1 });
    expect(replacement.adr.number).toBe(2);
    expect(listAdrs(r).map((a) => a.number)).toEqual([1, 2]);
  });

  test('lists ADRs with their status', () => {
    const r = root();
    promoteDecision(r, globalDecision());
    const adrs = listAdrs(r);
    expect(adrs).toHaveLength(1);
    expect(adrs[0]).toMatchObject({ number: 1, status: 'accepted', title: 'Use result types for errors' });
  });

  test('superseding records which ADR replaced it', () => {
    const r = root();
    promoteDecision(r, globalDecision());
    const replacement = promoteDecision(r, { ...globalDecision(), name: 'Use exceptions' }, { supersedes: 1 });

    const adrs = listAdrs(r);
    expect(adrs[0]).toMatchObject({ number: 1, status: 'superseded', supersededBy: 2 });
    expect(adrs[1]).toMatchObject({ number: replacement.adr.number, status: 'accepted' });
  });

  test('only accepted ADRs are binding', () => {
    // A superseded one is history; feeding it to an agent as a rule would
    // resurrect a decision the project reversed.
    const r = root();
    promoteDecision(r, globalDecision());
    promoteDecision(r, { ...globalDecision(), name: 'Replacement' }, { supersedes: 1 });
    expect(acceptedAdrs(r).map((a) => a.number)).toEqual([2]);
  });

  test('superseding an ADR that does not exist is a no-op', () => {
    expect(markSuperseded(root(), 99, 1)).toBe(false);
  });

  test('an empty store lists nothing', () => {
    expect(listAdrs(root())).toEqual([]);
  });

  test('files that are not ADRs are ignored', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular', 'decisions'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'decisions', 'notes.md'), '# Notes');
    expect(listAdrs(r)).toEqual([]);
  });
});

describe('replaceDecisionBody', () => {
  const designFile = () => {
    const dir = root();
    const file = join(dir, 'design.md');
    writeFileSync(file, DESIGN, 'utf8');
    return file;
  };

  test('leaves a reference behind and keeps the rest of the document', () => {
    const file = designFile();
    const decision = parseDecisions(readFileSync(file, 'utf8'), file)[0]!;

    expect(replaceDecisionBody(decision, 'See ADR-0001.')).toEqual({ ok: true });

    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('### Use result types for errors\n\nSee ADR-0001.');
    // The promoted decision's text is gone — keeping it would let the two
    // drift, which is what the ADR store exists to end.
    expect(updated).not.toContain('Errors are values, not exceptions.');
    // Everything else survives.
    expect(updated).toContain('### Cache the parsed schema');
    expect(updated).toContain('## Risks / Trade-offs');
    expect(updated).toContain('Nothing much.');
  });

  test('refuses when the document moved under it', () => {
    const file = designFile();
    const stale = parseDecisions(readFileSync(file, 'utf8'), file)[0]!;
    writeFileSync(file, '# Design\n\n(replaced)\n', 'utf8');
    const result = replaceDecisionBody(stale, 'See ADR-0001.');
    expect(result.ok === false && result.reason).toContain('changed since it was read');
  });

  test('reports a missing file instead of throwing', () => {
    const file = designFile();
    const decision = parseDecisions(readFileSync(file, 'utf8'), file)[0]!;
    expect(replaceDecisionBody({ ...decision, file: '/nope/design.md' }, 'x').ok).toBe(false);
  });
});
