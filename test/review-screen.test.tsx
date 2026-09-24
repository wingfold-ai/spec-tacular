/**
 * Drives the real review screen with real keystrokes and asserts on the
 * rendered terminal frame. Not a mock of the UI — OpenTUI's test renderer runs
 * the same component tree the terminal does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, move, openSession, skip, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const SPEC = `## ADDED Requirements

### Requirement: Theme selection
The app SHALL let users switch between light and dark themes.

#### Scenario: User toggles dark mode
- **WHEN** the user clicks the theme toggle
- **THEN** the app switches to dark mode

### Requirement: Export data
The app SHALL let users export their data.
`;

const requirements = () => parseSpecFile(SPEC, 'cap', '/p/specs/cap/spec.md').requirements;

// Each test renderer holds terminal listeners; without this they accumulate
// across the suite and Node starts warning about a leak.
const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

/** Mounts the screen wired to a real session, as the app wires it. */
async function mount() {
  const [session, setSession] = createSignal<ReviewSession>(
    openSession('c', requirements(), emptyReview('c')),
  );
  let backCalled = false;
  let editCalled = false;

  const setup = await testRender(
    () => (
      <ReviewScreen
        session={session()}
        onAccept={() => setSession((s) => decide(s, 'accepted'))}
        onReject={(note) => setSession((s) => decide(s, 'rejected', { note }))}
        onDefer={(reason) => setSession((s) => decide(s, 'deferred', { deferReason: reason }))}
        onSkip={() => setSession((s) => skip(s))}
        onEdit={() => { editCalled = true; }}
        onMove={(d) => setSession((s) => move(s, d))}
        onBack={() => { backCalled = true; }}
      />
    ),
    { width: 100, height: 40 },
  );

  const press = async (...keys: string[]) => {
    for (const k of keys) await setup.mockInput.pressKey(k);
    await setup.flush();
  };
  const cancel = async () => {
    await setup.mockInput.pressKey('c', { ctrl: true });
    await setup.flush();
  };
  const type = async (text: string) => {
    for (const ch of text) await setup.mockInput.pressKey(ch);
    await setup.flush();
  };

  await setup.flush();
  open.push({ destroy: () => setup.renderer.destroy() });
  return {
    ...setup,
    press,
    cancel,
    type,
    session,
    frame: () => setup.captureCharFrame(),
    wasBackCalled: () => backCalled,
    wasEditCalled: () => editCalled,
  };
}

describe('review screen', () => {
  test('shows one requirement with its scenario and the key hints', async () => {
    const ui = await mount();
    const frame = ui.frame();

    expect(frame).toContain('Requirement: Theme selection');
    expect(frame).toContain('Scenario: User toggles dark mode');
    expect(frame).toContain('the user clicks the theme toggle');
    expect(frame).toContain('requirement 1 of 2');
    expect(frame).toContain('a accept');
    // One decision at a time: the next requirement must not be on screen.
    expect(frame).not.toContain('Requirement: Export data');
  });

  test('progress counts are on screen from the start', async () => {
    const ui = await mount();
    expect(ui.frame()).toContain('0 accepted · 2 pending');
  });

  test('a accepts and advances to the next requirement', async () => {
    const ui = await mount();
    await ui.press('a');

    expect(ui.session().items[0]!.state).toBe('accepted');
    const frame = ui.frame();
    expect(frame).toContain('Requirement: Export data');
    expect(frame).toContain('requirement 2 of 2');
    expect(frame).toContain('1 accepted · 1 pending');
  });

  test('n and p move without deciding', async () => {
    const ui = await mount();
    await ui.press('n');
    expect(ui.frame()).toContain('requirement 2 of 2');
    await ui.press('p');
    expect(ui.frame()).toContain('requirement 1 of 2');
    expect(ui.session().summary.pending).toBe(2);
  });

  test('s skips without recording a decision', async () => {
    const ui = await mount();
    await ui.press('s');
    expect(ui.session().items[0]!.state).toBe('pending');
    expect(ui.frame()).toContain('requirement 2 of 2');
  });

  test('r prompts for a reason and records it', async () => {
    const ui = await mount();
    await ui.press('r');
    expect(ui.frame()).toContain('Why reject?');

    await ui.type('names an endpoint');
    expect(ui.frame()).toContain('names an endpoint');

    await ui.press('RETURN');
    const item = ui.session().items[0]!;
    expect(item.state).toBe('rejected');
    expect(item.review.note).toBe('names an endpoint');
    expect(ui.frame()).toContain('1 rejected');
  });

  test('ctrl+c cancels a prompt without deciding', async () => {
    // Not escape: a lone ESC is the prefix of every escape sequence, so a
    // terminal parser cannot deliver it until it sees what follows.
    const ui = await mount();
    await ui.press('r');
    await ui.type('half a thought');
    await ui.cancel();

    expect(ui.session().items[0]!.state).toBe('pending');
    expect(ui.frame()).not.toContain('half a thought');
  });

  test('ctrl+c at the top level goes back', async () => {
    const ui = await mount();
    await ui.cancel();
    expect(ui.wasBackCalled()).toBe(true);
  });

  test('backspace edits the prompt draft', async () => {
    const ui = await mount();
    await ui.press('r');
    await ui.type('abc');
    await ui.press('BACKSPACE');
    expect(ui.frame()).toContain('ab');

    await ui.press('RETURN');
    expect(ui.session().items[0]!.review.note).toBe('ab');
  });

  test('d refuses an empty reason, because a deferral must say what would verify it', async () => {
    const ui = await mount();
    await ui.press('d');
    expect(ui.frame()).toContain('What would verify it?');
    expect(ui.frame()).toContain('a reason is required');

    await ui.press('RETURN');
    // Still prompting, nothing decided.
    expect(ui.session().items[0]!.state).toBe('pending');
    expect(ui.frame()).toContain('What would verify it?');

    await ui.type('needs a deployed instance');
    await ui.press('RETURN');
    const item = ui.session().items[0]!;
    expect(item.state).toBe('deferred');
    expect(item.review.deferReason).toBe('needs a deployed instance');
  });

  test('keys that decide are inert while a prompt is open', async () => {
    const ui = await mount();
    await ui.press('r');
    await ui.press('a');            // must type an 'a', not accept
    expect(ui.session().items[0]!.state).toBe('pending');
    await ui.press('RETURN');
    expect(ui.session().items[0]!.review.note).toBe('a');
  });

  test('? shows help and any key dismisses it', async () => {
    const ui = await mount();
    await ui.press('?');
    expect(ui.frame()).toContain('asks what would verify it');

    await ui.press('a');            // dismisses, does not accept
    expect(ui.session().items[0]!.state).toBe('pending');
    expect(ui.frame()).not.toContain('asks what would verify it');
  });

  test('e and q reach their handlers', async () => {
    const ui = await mount();
    await ui.press('e');
    expect(ui.wasEditCalled()).toBe(true);
    await ui.press('q');
    expect(ui.wasBackCalled()).toBe(true);
  });

  test('a decided requirement shows its state when revisited', async () => {
    const ui = await mount();
    await ui.press('a');
    await ui.press('p');
    expect(ui.frame()).toContain('accepted');
  });

  test('an empty queue says so instead of rendering nothing', async () => {
    const [session] = createSignal(openSession('c', [], emptyReview('c')));
    const setup = await testRender(
      () => (
        <ReviewScreen
          session={session()}
          onAccept={() => {}} onReject={() => {}} onDefer={() => {}}
          onSkip={() => {}} onEdit={() => {}} onMove={() => {}} onBack={() => {}}
        />
      ),
      { width: 80, height: 20 },
    );
    await setup.flush();
    open.push({ destroy: () => setup.renderer.destroy() });
    expect(setup.captureCharFrame()).toContain('Nothing to review');
  });
});
