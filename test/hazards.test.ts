import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvidence, type EvidenceRecord } from '../src/core/evidence.ts';
import {
  HAZARD_EVIDENCE,
  hazardRecordsForRun,
  hazardState,
  listHazards,
  markReviewed,
  promoteRisks,
  registerStates,
  renderRegister,
  type Hazard,
} from '../src/core/hazards.ts';
import { parseRisks } from '../src/core/risks.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-hazards-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RISKS = `### Risk: Export leaks other users
- **Hazard:** another user's rows in an export
- **Affects:** export#export-data
- **Causes:** the user filter is skipped on a cached query
- **Severity:** high
- **Guard:** an export only ever holds the caller's rows
- **Check:** export as A with B present

### Risk: Huge export
- **Hazard:** a big export times out
- **Severity:** low
- **Unmitigated:** pagination comes later
`;

const run = (item: string, outcome: 'pass' | 'fail', at: string): EvidenceRecord => ({
  kind: 'run', at, item, hash: 'h', test: 't', file: null, fileHash: null, outcome,
});

describe('promoting risks at archive', () => {
  test('each accepted risk becomes an entry, with its guard as its verification', () => {
    const d = root();
    const promoted = promoteRisks(d, 'add-export', parseRisks(RISKS, 'f'));
    expect(promoted).toEqual([
      { hazard: 'HAZ-0001', risk: 'Export leaks other users', created: true },
      { hazard: 'HAZ-0002', risk: 'Huge export', created: true },
    ]);
    const [leak, huge] = listHazards(d);
    expect(leak).toMatchObject({
      title: 'Export leaks other users',
      stated: 'mitigated',
      severity: 'high',
      causes: 'the user filter is skipped on a cached query',
      verification: ['[risk:add-export#export-leaks-other-users]'],
      controls: ["change `add-export`: an export only ever holds the caller's rows"],
    });
    expect(huge).toMatchObject({ stated: 'unmitigated', verification: [], unmitigated: 'pagination comes later' });
  });

  test('a risk naming a known hazard updates it instead of adding a second', () => {
    const d = root();
    promoteRisks(d, 'add-export', parseRisks(RISKS, 'f').slice(0, 1));
    const again = parseRisks(
      `### Risk: Cached export leaks
- **Hazard:** the new cache serves another user's export
- **Severity:** critical
- **Guard:** the cache key includes the user
- **Check:** two users, one cache
- **Known hazard:** HAZ-0001
`,
      'f',
    );
    expect(promoteRisks(d, 'add-cache', again)).toEqual([{ hazard: 'HAZ-0001', risk: 'Cached export leaks', created: false }]);
    const [entry] = listHazards(d);
    expect(listHazards(d)).toHaveLength(1);
    expect(entry!.severity).toBe('critical');
    expect(entry!.verification).toEqual(['[risk:add-export#export-leaks-other-users]', '[risk:add-cache#cached-export-leaks]']);
    expect(entry!.controls).toHaveLength(2);
    expect(entry!.history).toHaveLength(2);
  });

  test('the guard\'s latest results come along', () => {
    const d = root();
    const [leak] = parseRisks(RISKS, 'f');
    appendEvidence(d, 'add-export', [
      { ...run(leak!.id, 'fail', 'a'), item: leak!.id },
      { ...run(leak!.id, 'pass', 'b'), item: leak!.id },
    ]);
    promoteRisks(d, 'add-export', [leak!]);
    expect(registerStates(d)[0]!.status).toBe('mitigated');
  });
});

describe('the status of a hazard', () => {
  const hazard = (over: Partial<Hazard> = {}): Hazard => ({
    number: 1, id: 'HAZ-0001', title: 'Leak', file: 'f', stated: 'mitigated', severity: 'high',
    reviewed: '2026-10-01', hazard: '', causes: '', affects: '', controls: [], verification: ['[risk:c#leak]'],
    unmitigated: '', history: [], ...over,
  });
  const now = new Date('2026-10-29');

  test('mitigated only while every guard passed its latest run', () => {
    expect(hazardState(hazard(), [run('[risk:c#leak]', 'pass', 'a')], now).status).toBe('mitigated');
    expect(hazardState(hazard(), [run('[risk:c#leak]', 'pass', 'a'), run('[risk:c#leak]', 'fail', 'b')], now)).toMatchObject({
      status: 'open',
      because: 'guard failing: [risk:c#leak]',
    });
  });

  test('a guard never run leaves it unverified, not mitigated', () => {
    expect(hazardState(hazard(), [], now).status).toBe('unverified');
    expect(hazardState(hazard({ verification: [] }), [], now).status).toBe('open');
  });

  test('closed and unmitigated are what the entry says', () => {
    expect(hazardState(hazard({ stated: 'closed' }), [], now).status).toBe('closed');
    expect(hazardState(hazard({ stated: 'unmitigated', unmitigated: 'later' }), [], now)).toMatchObject({ status: 'unmitigated', because: 'later' });
  });

  test('not looked at for the review period, it is due', () => {
    expect(hazardState(hazard(), [], now).dueForReview).toBe(false);
    expect(hazardState(hazard({ reviewed: '2026-06-01' }), [], now).dueForReview).toBe(true);
    expect(hazardState(hazard({ reviewed: null }), [], now).dueForReview).toBe(true);
    expect(hazardState(hazard({ stated: 'closed', reviewed: null }), [], now).dueForReview).toBe(false);
  });
});

describe('the register over time', () => {
  test('its guards keep being recorded after the change is archived', () => {
    const d = root();
    promoteRisks(d, 'add-export', parseRisks(RISKS, 'f').slice(0, 1));
    const results = [
      { name: 'suite [risk:add-export#export-leaks-other-users] isolates users', file: null, outcome: 'fail' as const },
      { name: 'unrelated', file: null, outcome: 'pass' as const },
    ];
    appendEvidence(d, HAZARD_EVIDENCE, hazardRecordsForRun(listHazards(d), results, 'now'));
    expect(registerStates(d)[0]).toMatchObject({ status: 'open' });
  });

  test('a review is recorded on the entry', () => {
    const d = root();
    promoteRisks(d, 'add-export', parseRisks(RISKS, 'f').slice(0, 1));
    expect(markReviewed(d, 'haz-0001', 'still relevant')?.history.at(-1)).toContain('reviewed: still relevant');
    expect(readFileSync(listHazards(d)[0]!.file, 'utf8')).toContain('**Reviewed:** ');
    expect(markReviewed(d, 'HAZ-0009')).toBeNull();
  });

  test('agents read the live entries', () => {
    const d = root();
    promoteRisks(d, 'add-export', parseRisks(RISKS, 'f'));
    const text = renderRegister(registerStates(d));
    expect(text).toContain('HAZ-0001 Export leaks other users — unverified; affects export#export-data');
    expect(text).toContain('HAZ-0002 Huge export — unmitigated');
    expect(text).toContain('**Known hazard:** HAZ-NNNN');
  });
});
