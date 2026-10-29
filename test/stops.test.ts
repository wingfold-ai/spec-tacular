import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDriver } from '../src/agent/claude.ts';
import { opencodeDriver } from '../src/agent/opencode.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import {
  clearStopReport,
  mentioned,
  parseStop,
  readStopReport,
  renderStop,
  saveStopReport,
  stopInstructions,
  stopPath,
} from '../src/core/stops.ts';

const SPEC = `# goal-recording

## ADDED Requirements

### Requirement: Goals are recorded for either side of a fixture
A goal SHALL be recorded for the club's team or for the opponent. A goal for
the opponent SHALL NOT name a scorer.

#### Scenario: Opponent goal
- **WHEN** an opponent goal is recorded
- **THEN** it has no scorer

### Requirement: Scorer is picked from the team's squad by name
Each goal SHALL name a scorer who is a player in the squad of the fixture's team.

#### Scenario: Goal without a scorer is rejected
- **WHEN** a goal names no scorer
- **THEN** it is rejected

### Requirement: Minute
A goal SHALL have a minute of at least 1.
`;

const items = parseSpecFile(SPEC, 'goal-recording', '/tmp/goal-recording/spec.md').requirements;
const meta = { change: 'add-goal-video-feed', artifact: 'design' };

const REPORT = `# Stopped: design

The accepted specs contradict each other on opponent goals.

## Conflict: Opponent goals must and must not name a scorer

- goal-recording: Goals are recorded for either side of a fixture
- goal-recording: Scorer is picked from the team's squad by name

One says an opponent goal SHALL NOT name a scorer; the other rejects any goal without one.

## Gap: No upper bound on the minute

- goal-recording: Minute

"up to 130" is only an example.

## Recommendation

Limit the scorer requirement to the club's own goals.
`;

describe('reading why an agent stopped', () => {
  test('a report: each problem, with the requirements it lists', () => {
    const report = parseStop(REPORT, items, { ...meta, source: 'report' });
    expect(report.summary).toBe('The accepted specs contradict each other on opponent goals.');
    expect(report.issues.map((i) => [i.kind, i.title])).toEqual([
      ['conflict', 'Opponent goals must and must not name a scorer'],
      ['gap', 'No upper bound on the minute'],
    ]);
    expect(report.issues[0]!.requirements.map((r) => r.name)).toEqual([
      'Goals are recorded for either side of a fixture',
      "Scorer is picked from the team's squad by name",
    ]);
    expect(report.issues[0]!.body).toContain('SHALL NOT name a scorer');
    expect(report.issues[0]!.body).not.toContain('- goal-recording');
    expect(report.issues[1]!.requirements.map((r) => r.name)).toEqual(['Minute']);
    // A recommendation is not a problem.
    expect(report.issues).toHaveLength(2);
  });

  test('a requirement listed under a name that matches none is kept as text', () => {
    const report = parseStop('# Stopped: design\n\n## Conflict: x\n\n- billing: Invoices are sent\n', items, { ...meta, source: 'report' });
    expect(report.issues[0]!.requirements).toEqual([]);
    expect(report.issues[0]!.body).toContain('billing: Invoices are sent');
  });

  test('a final message: the requirements it mentions by name, in order', () => {
    const message = 'I stopped. "Scorer is picked from the team’s squad by name" (`:57`) says each goal SHALL name a scorer, but **Goals are recorded for either side of a fixture** says an opponent goal SHALL NOT.';
    const report = parseStop(message, items, { ...meta, source: 'message' });
    expect(report.issues).toEqual([]);
    expect(report.named.map((r) => r.name)).toEqual([
      "Scorer is picked from the team's squad by name",
      'Goals are recorded for either side of a fixture',
    ]);
    expect(report.summary).toStartWith('I stopped.');
  });

  test('short names are not looked for in prose', () => {
    expect(mentioned('Every minute counts, and so does the scorer.', items)).toEqual([]);
  });

  test('rendered, each requirement’s text sits under the problem it is part of', () => {
    const text = renderStop(parseStop(REPORT, items, { ...meta, source: 'report' }));
    expect(text).toStartWith('# The agent stopped instead of writing the design\n');
    const conflict = text.indexOf('## Conflict: Opponent goals');
    const quoted = text.indexOf("### goal-recording › Scorer is picked from the team's squad by name");
    const gap = text.indexOf('## Gap: No upper bound');
    expect(conflict).toBeGreaterThan(-1);
    expect(quoted).toBeGreaterThan(conflict);
    expect(gap).toBeGreaterThan(quoted);
    expect(text).toContain('> Each goal SHALL name a scorer who is a player in the squad');
    expect(text).toContain('## Recommendation\n\nLimit the scorer requirement');
  });

  test('rendered from a final message, the requirements it names follow it', () => {
    const text = renderStop(parseStop('Stopped: see "Scorer is picked from the team\'s squad by name".', items, { ...meta, source: 'message' }));
    expect(text).toContain('## The requirements it names');
    expect(text).toContain("### goal-recording › Scorer is picked from the team's squad by name");
  });
});

describe('the report on disk', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('is saved, read back, and cleared by a new attempt', () => {
    root = mkdtempSync(join(tmpdir(), 'spectacular-stops-'));
    expect(readStopReport(root, 'c', 'design')).toBeNull();
    saveStopReport(root, 'c', 'design', 'Stopped.');
    expect(readStopReport(root, 'c', 'design')).toBe('Stopped.\n');
    clearStopReport(root, 'c', 'design');
    expect(existsSync(stopPath(root, 'c', 'design'))).toBe(false);
  });

  test('the prompt says where to write it, and in what shape', () => {
    const text = stopInstructions('/p', 'add-feed', 'design');
    expect(text).toContain('`.spec-tacular/stops/add-feed/design.md`');
    expect(text).toContain('## Conflict:');
    expect(text).toContain('- <capability>: <requirement name');
  });
});

describe('an agent’s last words', () => {
  test('Claude Code: the result, else the last reply', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the specs.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I stopped: they conflict.' }] } }),
      'not json',
    ];
    expect(claudeDriver.finalMessage!(lines)).toBe('I stopped: they conflict.');
    lines.push(JSON.stringify({ type: 'result', result: 'I stopped: they conflict, in full.' }));
    expect(claudeDriver.finalMessage!(lines)).toBe('I stopped: they conflict, in full.');
    expect(claudeDriver.finalMessage!([])).toBeNull();
  });

  test('opencode: the text of its last step', () => {
    const lines = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { text: 'Reading.' } }),
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { text: 'I stopped.' } }),
      JSON.stringify({ type: 'text', part: { text: 'They conflict.' } }),
      JSON.stringify({ type: 'step_finish', part: {} }),
    ];
    expect(opencodeDriver.finalMessage!(lines)).toBe('I stopped.\n\nThey conflict.');
  });
});
