import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDefect, isDefectSchema, parseReport } from '../src/core/defects.ts';
import { parseSpecFile } from '../src/core/requirements.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASELINE = `# export

## Purpose
Users export their data.

## Requirements

### Requirement: Export data
The system SHALL export only the caller's data.

#### Scenario: Not someone else's
- **WHEN** a user exports
- **THEN** no other user's rows are in it
`;

/** A project whose accepted baseline has the export requirement. */
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-defect-'));
  dirs.push(d);
  mkdirSync(join(d, 'openspec', 'specs', 'export'), { recursive: true });
  writeFileSync(join(d, 'openspec', 'specs', 'export', 'spec.md'), BASELINE);
  return d;
};

const delta = (op: 'ADDED' | 'MODIFIED', body: string) =>
  parseSpecFile(`## ${op} Requirements\n\n${body}`, 'export', 'f').requirements;

const UNCHANGED = `### Requirement: Export data
The system SHALL export only the caller's data.

#### Scenario: Not someone else's
- **WHEN** a user exports
- **THEN** no other user's rows are in it
`;

const CHANGED = UNCHANGED.replace("only the caller's data", "only the caller's data, even from a cached query");

const REPRODUCER = '- [ ] 1.1 (guard: Export leaks other users) Reproducer\n';

describe('the defect report', () => {
  test('says whose bug it is, and which requirement it violates', () => {
    expect(parseReport('**Whose bug:** Requirement\n\n**Violated requirement:** `export#export-data`')).toEqual({
      fault: 'requirement',
      violated: 'export#export-data',
    });
    expect(parseReport('**Whose bug:** <!-- code | requirement | gap -->')).toEqual({ fault: null, violated: null });
  });

  test('the defect schema is told apart from the main one', () => {
    expect(isDefectSchema('spec-tacular-defect')).toBe(true);
    expect(isDefectSchema('spec-tacular')).toBe(false);
  });
});

describe('checking a defect change against its report', () => {
  test('a report that does not decide whose bug it is, is flagged', () => {
    expect(checkDefect(project(), { fault: null, violated: null }, [], null).warnings).toEqual([
      'the report does not say whose bug it is: **Whose bug:** code, requirement or gap',
    ]);
  });

  test('a code bug repeats the violated requirement unchanged', () => {
    const d = project();
    const report = { fault: 'code' as const, violated: 'export#export-data' };
    expect(checkDefect(d, report, delta('MODIFIED', UNCHANGED), REPRODUCER).warnings).toEqual([]);
    expect(checkDefect(d, report, delta('MODIFIED', CHANGED), REPRODUCER).warnings).toEqual([
      'a code bug changes no requirement, but this one changes "Export data" — is it a requirement bug?',
    ]);
  });

  test('a code bug names a requirement the specs include', () => {
    const report = { fault: 'code' as const, violated: 'export#other' };
    expect(checkDefect(project(), report, delta('MODIFIED', UNCHANGED), REPRODUCER).warnings).toEqual([
      'the report names export#other as violated, but the specs do not include it',
    ]);
  });

  test('a requirement bug changes the requirement, a gap adds one', () => {
    const d = project();
    expect(checkDefect(d, { fault: 'requirement', violated: null }, delta('MODIFIED', CHANGED), REPRODUCER).warnings).toEqual([]);
    expect(checkDefect(d, { fault: 'requirement', violated: null }, delta('MODIFIED', UNCHANGED), REPRODUCER).warnings).toEqual([
      'a requirement bug changes a requirement, but the specs only repeat the accepted ones',
    ]);
    const added = delta('ADDED', UNCHANGED.replace('Export data', 'Export while cached'));
    expect(checkDefect(d, { fault: 'gap', violated: null }, added, REPRODUCER).warnings).toEqual([]);
  });

  test('a fix without a reproducer is flagged once its tasks exist', () => {
    const d = project();
    const report = { fault: 'code' as const, violated: null };
    expect(checkDefect(d, report, [], null).warnings).toEqual([]);
    expect(checkDefect(d, report, [], '- [ ] 1.1 Fix it\n').warnings).toEqual([
      'no reproducer: the first task is a guard task whose test fails on the unfixed code',
    ]);
  });
});
