/**
 * An agent that stops instead of writing an artifact, in the whole app: what
 * it found opens straight away with the text of every requirement it names,
 * the overview keeps saying so, and `s` opens the review on the first of them.
 * With no report at all, the stop is still shown, with the ways on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { answerFoundation, guidedQuestions } from '../src/core/foundation.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { openSession } from '../src/core/session.ts';
import { parseStop, readStopReport, saveStopReport } from '../src/core/stops.ts';
import { changeWith, mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const ui of mounted.splice(0)) ui.destroy();
});

const SPEC = `# goal-recording

## ADDED Requirements

### Requirement: Minute is recorded
A goal SHALL have a minute of at least 1.

### Requirement: Goals are recorded for either side of a fixture
A goal for the opponent SHALL NOT name a scorer.

### Requirement: Scorer is picked from the team's squad by name
Each goal SHALL name a scorer from the squad.
`;

const REPORT = `# Stopped: design

The accepted specs contradict each other on opponent goals.

## Conflict: Opponent goals must and must not name a scorer

- goal-recording: Goals are recorded for either side of a fixture
- goal-recording: Scorer is picked from the team's squad by name

One forbids a scorer on an opponent goal; the other requires one on every goal.
`;

const items = parseSpecFile(SPEC, 'goal-recording', '/tmp/goal-recording/spec.md').requirements;

async function stoppedDesign(writeReport: (root: string) => void) {
  let root: string | null = null;
  const ui = await mountApp({
    baseline: true,
    changes: [changeWith('add-feed', ['proposal', 'specs'], ['proposal', 'specs'])],
    openReview: (change) => openSession(change, items, emptyReview(change)),
    reparse: () => items,
    // As the real wiring does it, minus the log: the report on disk.
    stopReport: (change, artifact) => {
      const text = root === null ? null : readStopReport(root, change, artifact);
      return text === null
        ? null
        : parseStop(text, items, { change, artifact, source: text.startsWith('# Stopped:') ? 'report' : 'message' });
    },
  });
  mounted.push(ui);
  root = ui.root;
  await ui.press('return'); // Start
  for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
  await ui.press('c', { ctrl: true });
  await ui.press('w'); // draft the design
  expect(ui.dispatched).toEqual(['add-feed/design']);
  writeReport(ui.root);
  ui.stopJob('add-feed', 'design');
  await ui.settle(2300); // the job poll
  return ui;
}

describe('when the agent stops instead of writing the design', () => {
  test('its report opens, each conflicting requirement quoted under it', async () => {
    const ui = await stoppedDesign((root) => saveStopReport(root, 'add-feed', 'design', REPORT));
    const frame = ui.frame();
    expect(frame).toContain('The agent stopped before writing the design');
    expect(frame).toContain('The agent stopped instead of writing the design');
    expect(frame).toContain('Conflict: Opponent goals must and must not name a scorer');
    expect(frame).toContain('goal-recording › Goals are recorded for either side of a fixture');
    expect(frame).toContain("goal-recording › Scorer is picked from the team's squad by name");
    expect(frame).toContain('│ A goal for the opponent SHALL NOT name a scorer.');
    expect(frame).toContain('│ Each goal SHALL name a scorer from the squad.');
    // Five actions: their labels wrap inside the buttons.
    expect(frame).toContain('▶ Revise them in the');
    expect(frame).toContain('↩ Fix the');
    expect(frame).toContain('↻ Draft the design');
  });

  test('the overview keeps saying so, and s opens the review on the first requirement it names', async () => {
    const ui = await stoppedDesign((root) => saveStopReport(root, 'add-feed', 'design', REPORT));
    await ui.press('q');
    expect(ui.frame()).toContain('⚠ The agent stopped before writing the design of add-feed: 1 conflict in the');
    expect(ui.frame()).toContain('▶ Why it stopped');

    await ui.press('o');
    expect(ui.frame()).toContain('The agent stopped before writing the design');
    await ui.press('s');
    expect(ui.frame()).toContain('add-feed › review');
    expect(ui.frame()).toContain('Requirement: Goals are recorded for either side of a fixture');
    expect(ui.frame()).not.toContain('Requirement: Minute is recorded');
  });

  test('answering it drafts again with the answer', async () => {
    const ui = await stoppedDesign((root) => saveStopReport(root, 'add-feed', 'design', REPORT));
    await ui.press('w');
    expect(ui.frame()).toContain('What should it go with');
    await ui.type('opponent goals get no video');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.dispatched.at(-1)).toBe('add-feed/design (opponent goals get no video)');
  });

  test('a final message without a report still shows the requirements it names', async () => {
    const ui = await stoppedDesign((root) =>
      saveStopReport(root, 'add-feed', 'design', 'I stopped: "Scorer is picked from the team\'s squad by name" contradicts the opponent rule.'));
    expect(ui.frame()).toContain('I stopped:');
    expect(ui.frame()).toContain('The requirements it names');
    expect(ui.frame()).toContain('│ Each goal SHALL name a scorer from the squad.');
  });

  test('without any report it says that it said nothing, and still offers the ways on', async () => {
    const ui = await stoppedDesign(() => {});
    expect(ui.frame()).toContain('The agent stopped before writing the design');
    expect(ui.frame()).toContain('It said nothing at the end');
    expect(ui.frame()).toContain('↻ Draft the design');
    expect(ui.frame()).not.toContain('Revise them in the');
  });
});

