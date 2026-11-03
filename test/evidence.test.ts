import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvidence,
  changeEvidence,
  itemEvidence,
  lacksNegativeScenario,
  loadEvidence,
  loadVerification,
  methodOf,
  orphanTags,
  parseJUnit,
  recordsForRun,
  runTests,
  summarizeEvidence,
  tagFor,
  tagsIn,
  type EvidenceRecord,
} from '../src/core/evidence.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { parseRisks } from '../src/core/risks.ts';
import type { ReviewedItem } from '../src/core/review.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-evidence-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// What `bun test --reporter=junit` writes, trimmed.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="a.test.ts" file="a.test.ts">
    <testsuite name="export [req:export#export-data]" file="a.test.ts">
      <testcase name="passes [risk:add-export#export-leaks-other-users]" classname="export [req:export#export-data]" file="a.test.ts" line="3" />
      <testcase name="fails &amp; &lt;tricky&gt;" classname="other" file="a.test.ts" line="4">
        <failure type="AssertionError" message="x">boom</failure>
      </testcase>
      <testcase name="skipped [req:export#export-data]" classname="x" file="a.test.ts" line="5">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

const SPEC = `## ADDED Requirements

### Requirement: Export data
The system SHALL let a user export their data.

#### Scenario: Export
- **WHEN** a user exports
- **THEN** they get a file

#### Scenario: Not someone else's
- **WHEN** a user exports
- **THEN** no other user's rows are in it

### Requirement: Export is fast
The export SHALL finish within a minute.
**Verified by:** demonstration

#### Scenario: Big account
- **WHEN** an account has a million rows
- **THEN** the export finishes within a minute
`;

const RISKS = `### Risk: Export leaks other users
- **Hazard:** another user's rows in an export
- **Guard:** only the caller's rows
- **Check:** export as A with B present

### Risk: Huge export
- **Hazard:** a big export times out
- **Severity:** low
- **Unmitigated:** pagination comes later
`;

const [exportData, exportFast] = parseSpecFile(SPEC, 'export', '/c/specs/export/spec.md').requirements as [
  ReturnType<typeof parseSpecFile>['requirements'][number],
  ReturnType<typeof parseSpecFile>['requirements'][number],
];
const [leak, huge] = parseRisks(RISKS, '/c/risks.md') as [ReturnType<typeof parseRisks>[number], ReturnType<typeof parseRisks>[number]];

const reviewed = (item: ReviewedItem['item'], state: ReviewedItem['state'] = 'accepted', deferReason?: string): ReviewedItem => ({
  item,
  state,
  review: { state, hash: item.hash, reviewedAt: 'then', ...(deferReason ? { deferReason } : {}) },
  drifted: false,
});

describe('the JUnit report', () => {
  test('reads each case with its suite, its file and its outcome', () => {
    expect(parseJUnit(JUNIT)).toEqual([
      { name: 'export [req:export#export-data] passes [risk:add-export#export-leaks-other-users]', file: 'a.test.ts', outcome: 'pass' },
      { name: 'other fails & <tricky>', file: 'a.test.ts', outcome: 'fail' },
      { name: 'x skipped [req:export#export-data]', file: 'a.test.ts', outcome: 'skip' },
    ]);
  });
});

describe('tags', () => {
  test('a test names requirements and risks in its name', () => {
    expect(tagsIn('a [req:export#export-data] b [risk:add-export#leak]')).toEqual([
      { kind: 'req', ref: 'export#export-data' },
      { kind: 'risk', ref: 'add-export#leak' },
    ]);
  });

  test('the tag for an item is the one the tests must carry', () => {
    expect(tagFor('add-export', exportData)).toBe('[req:export#export-data]');
    expect(tagFor('add-export', leak)).toBe('[risk:add-export#export-leaks-other-users]');
  });

  test('a tag naming nothing is an orphan', () => {
    const results = parseJUnit(JUNIT);
    expect(orphanTags(results, (t) => t.ref !== 'add-export#export-leaks-other-users')).toEqual([
      { test: results[0]!.name, tag: '[risk:add-export#export-leaks-other-users]' },
    ]);
  });
});

describe('methods', () => {
  test('by test, unless the item says otherwise', () => {
    expect(methodOf(exportData)).toBe('test');
    expect(methodOf(exportFast)).toBe('demonstration');
  });
});

describe('evidence of an item', () => {
  const run = (over: Partial<Extract<EvidenceRecord, { kind: 'run' }>> = {}): EvidenceRecord => ({
    kind: 'run', at: '2026-10-29T10:00:00Z', item: exportData.id, hash: exportData.hash,
    test: 't', file: null, fileHash: null, outcome: 'pass', ...over,
  });
  const p = '/nowhere';

  test('no record is missing evidence', () => {
    expect(itemEvidence(p, exportData, []).state).toBe('missing');
  });

  test('only the latest run counts', () => {
    const records = [run({ outcome: 'fail' }), run({ at: '2026-10-29T11:00:00Z' })];
    expect(itemEvidence(p, exportData, records).state).toBe('passing');
    expect(itemEvidence(p, exportData, [...records, run({ at: '2026-10-29T12:00:00Z', outcome: 'fail' })]).state).toBe('failing');
  });

  test('a skipped test is not evidence', () => {
    expect(itemEvidence(p, exportData, [run({ outcome: 'skip' })]).state).toBe('missing');
  });

  test('passing against other text, or an edited test, is stale', () => {
    expect(itemEvidence(p, exportData, [run({ hash: 'sha256:old' })]).state).toBe('stale');
    expect(itemEvidence(p, exportData, [run({ file: 'a.ts', fileHash: 'sha256:then' })], () => 'sha256:now').state).toBe('stale');
    expect(itemEvidence(p, exportData, [run({ file: 'a.ts', fileHash: 'sha256:then' })], () => 'sha256:then').state).toBe('passing');
  });

  test('a demonstration is verified by a sign-off on the same text', () => {
    const sign = (hash: string): EvidenceRecord => ({ kind: 'sign', at: 'now', item: exportFast.id, hash, method: 'demonstration', note: 'ran it on a copy of prod' });
    expect(itemEvidence(p, exportFast, []).state).toBe('missing');
    expect(itemEvidence(p, exportFast, [sign(exportFast.hash)])).toMatchObject({ state: 'passing', note: 'ran it on a copy of prod' });
    expect(itemEvidence(p, exportFast, [sign('sha256:old')]).state).toBe('stale');
    // A test run does not stand in for a demonstration.
    expect(itemEvidence(p, exportFast, [{ ...run(), item: exportFast.id, hash: exportFast.hash } as EvidenceRecord]).state).toBe('missing');
  });

  test('a waiver excepts it, with its reason, until the text changes', () => {
    const waive = (hash: string): EvidenceRecord => ({ kind: 'waive', at: 'now', item: exportData.id, hash, reason: 'covered by the vendor' });
    expect(itemEvidence(p, exportData, [run({ outcome: 'fail' }), waive(exportData.hash)])).toMatchObject({ state: 'excepted', note: 'covered by the vendor' });
    expect(itemEvidence(p, exportData, [run({ outcome: 'fail' }), waive('sha256:old')]).state).toBe('failing');
  });
});

describe('evidence of a change', () => {
  test('accepted requirements and guarded risks need it; deferred ones are excepted; unmitigated risks need none', () => {
    const items = changeEvidence('/nowhere', 'add-export', [
      reviewed(exportData),
      reviewed(exportFast, 'deferred', 'needs production data'),
      reviewed(leak),
      reviewed(huge),
    ]);
    expect(items.map((i) => [i.item.id, i.state])).toEqual([
      ['export#export-data', 'missing'],
      ['export#export-is-fast', 'excepted'],
      ['risks#export-leaks-other-users', 'missing'],
    ]);
    expect(summarizeEvidence(items)).toEqual({ total: 3, passing: 0, failing: 0, stale: 0, missing: 2, excepted: 1, unconnected: 0, complete: false });
  });

  test('a run is recorded per item it names, bound to the item and the test file', () => {
    const d = root();
    writeFileSync(join(d, 'a.test.ts'), 'the test\n');
    const records = recordsForRun(d, 'add-export', [exportData, leak], parseJUnit(JUNIT), 'now');
    expect(records.map((r) => r.kind === 'run' && [r.item, r.outcome])).toEqual([
      ['export#export-data', 'pass'],
      ['risks#export-leaks-other-users', 'pass'],
      ['export#export-data', 'skip'],
    ]);
    appendEvidence(d, 'add-export', records);
    appendEvidence(d, 'add-export', records.slice(0, 1));
    // Appended, never rewritten.
    expect(loadEvidence(d, 'add-export')).toHaveLength(4);
    expect(changeEvidence(d, 'add-export', [reviewed(exportData), reviewed(leak)]).map((i) => i.state)).toEqual(['passing', 'passing']);

    writeFileSync(join(d, 'a.test.ts'), 'the test, edited\n');
    expect(changeEvidence(d, 'add-export', [reviewed(leak)])[0]!.state).toBe('stale');
  });
});

describe('the test command', () => {
  test('is configured, or says what is wrong', () => {
    const d = root();
    expect(loadVerification(d)).toBeNull();
    mkdirSync(join(d, 'spec-tacular'));
    writeFileSync(join(d, 'spec-tacular', 'verification.yaml'), 'command: x\n');
    expect(loadVerification(d)).toEqual({ problem: 'verification.yaml needs a `command` and the `report` it writes' });
  });

  test('failing tests are a result; a report it did not write is not', () => {
    const d = root();
    const ok = runTests(d, { command: `printf '%s' '${JUNIT.replace(/'/g, '')}' > out.xml; exit 1`, report: 'out.xml' });
    expect(ok.ok && ok.results.map((r) => r.outcome)).toEqual(['pass', 'fail', 'skip']);

    const stale = runTests(d, { command: 'true', report: 'out.xml' });
    expect(stale.ok === false && stale.reason).toContain('was not rewritten');
    const none = runTests(d, { command: 'true', report: 'missing.xml' });
    expect(none.ok === false && none.reason).toContain('wrote no report');
  });
});

describe('negative scenarios', () => {
  test('a requirement with only happy paths is flagged', () => {
    expect(lacksNegativeScenario(exportData)).toBe(false);
    const [happy] = parseSpecFile(
      '## ADDED Requirements\n\n### Requirement: Export\nThe system SHALL export.\n\n#### Scenario: Export\n- **WHEN** a user exports\n- **THEN** they get a file\n',
      'export',
      'f',
    ).requirements;
    expect(lacksNegativeScenario(happy!)).toBe(true);
  });

  test('risks and decisions are not requirements, and are not flagged', () => {
    expect(lacksNegativeScenario(leak)).toBe(false);
  });
});
