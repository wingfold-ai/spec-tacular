/**
 * A review card taller than the terminal: a requirement with a formula, its
 * reading, its matrices and its flags. It used to overprint itself; it scrolls,
 * and the long parts fold to a line each until asked for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import type { Finding } from '../src/core/concreteness.ts';
import type { FormalView } from '../src/core/formal/formal.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, move, openSession, skip, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const steps = Array.from({ length: 30 }, (_, i) => `- **AND** step ${String(i + 1).padStart(2, '0')} holds`).join('\n');
const SPEC = `## ADDED Requirements

### Requirement: Tall
The app SHALL do a great many things at once.

#### Scenario: Everything
- **WHEN** it starts
${steps}
- **THEN** the very last line is reached
`;

const FORMAL: FormalView = {
  source: ['decision: started = a AND b'],
  reading: ['started is true exactly when a and b'],
  errors: [],
  notes: [],
  asked: [],
  vague: [],
  matrix: [
    '  Matrix (2 conditions): started = a AND b',
    '     D1   a=F, b=F → started=F',
    '     D2   a=F, b=T → started=F',
    '   ◆ D3   a=T, b=F → started=F   [MC/DC: a]',
    '   ◆ D4   a=T, b=T → started=T   [MC/DC: a, b]',
  ],
};

const FLAGS: Finding[] = Array.from({ length: 6 }, (_, i) => ({
  kind: 'file-path',
  value: `data-${i}.json`,
  offset: i,
  question: 'names a file',
})) as Finding[];

const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

async function mount(height: number) {
  const items = parseSpecFile(SPEC, 'cap', '/p/specs/cap/spec.md').requirements;
  const [session, setSession] = createSignal<ReviewSession>(openSession('c', items, emptyReview('c')));
  const setup = await testRender(
    () => (
      <ReviewScreen
        session={session()}
        formal={FORMAL}
        findings={FLAGS}
        onAccept={() => setSession((s) => decide(s, 'accepted'))}
        onReject={(note) => setSession((s) => decide(s, 'rejected', { note }))}
        onDefer={(reason) => setSession((s) => decide(s, 'deferred', { deferReason: reason }))}
        onSkip={() => setSession((s) => skip(s))}
        onEdit={() => {}}
        onMove={(d) => setSession((s) => move(s, d))}
        onBack={() => {}}
      />
    ),
    { width: 100, height },
  );
  open.push({ destroy: () => setup.renderer.destroy() });
  await setup.flush();
  const press = async (...keys: string[]) => {
    for (const k of keys) await setup.mockInput.pressKey(k);
    await setup.flush();
  };
  return { frame: () => setup.captureCharFrame(), press };
}

describe('a review card taller than the terminal', () => {
  test('keeps its header and its keys in place, each line whole', async () => {
    const ui = await mount(24);
    const frame = ui.frame();
    expect(frame).toContain('Requirement: Tall');
    expect(frame).toContain('step 01 holds');
    // The bottom of the screen is still the progress and the keys.
    expect(frame).toContain('a accept · r revise with AI');
    expect(frame).not.toContain('the very last line is reached');
  });

  test('scrolls down to the rest', async () => {
    const ui = await mount(24);
    await ui.press('\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~');
    const frame = ui.frame();
    expect(frame).toContain('the very last line is reached');
    expect(frame).toContain('a accept · r revise with AI');
  });

  test('folds its matrix and its flags until asked for', async () => {
    const ui = await mount(90);
    let frame = ui.frame();
    expect(frame).toContain('Matrix (2 conditions): 4 rows, 2 MC/DC · t shows them');
    expect(frame).not.toContain('D3   a=T');
    expect(frame).toContain('… 3 more specificity flags · f shows them');
    expect(frame).not.toContain('data-5.json');

    await ui.press('t', 'f');
    frame = ui.frame();
    expect(frame).toContain('D3   a=T, b=F → started=F');
    expect(frame).toContain('data-5.json');
  });
});
