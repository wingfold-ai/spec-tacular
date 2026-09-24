import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { lintRequirement, type Finding } from '../src/core/concreteness.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, openSession, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const SPEC = `## ADDED Requirements

### Requirement: Export
The system SHALL expose POST /v1/export and store user_email, returning {{example: CSV}}.

#### Scenario: Works
- **WHEN** called
- **THEN** it works
`;

const requirements = () => parseSpecFile(SPEC, 'cap', '/p/specs/cap/spec.md').requirements;

const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

async function mount() {
  const [session, setSession] = createSignal<ReviewSession>(
    openSession('c', requirements(), emptyReview('c')),
  );
  const marked: Finding[] = [];
  const findings = lintRequirement(requirements()[0]!);

  const setup = await testRender(
    () => (
      <ReviewScreen
        session={session()}
        findings={findings}
        onMarkExample={(f) => marked.push(f)}
        onAccept={() => setSession((s) => decide(s, 'accepted'))}
        onReject={() => {}} onDefer={() => {}} onSkip={() => {}}
        onEdit={() => {}} onMove={() => {}} onBack={() => {}}
      />
    ),
    { width: 100, height: 30 },
  );
  await setup.flush();
  open.push({ destroy: () => setup.renderer.destroy() });

  return {
    frame: () => setup.captureCharFrame(),
    press: async (...keys: string[]) => {
      for (const k of keys) await setup.mockInput.pressKey(k);
      await setup.flush();
    },
    session,
    marked,
    findings,
  };
}

describe('findings in review', () => {
  test('shows each finding numbered, as a question', async () => {
    const ui = await mount();
    const frame = ui.frame();
    expect(frame).toContain('1. names an HTTP endpoint: POST /v1/export');
    expect(frame).toContain('2. names a field or table: user_email');
  });

  test('already-marked values are shown as examples, not flagged', async () => {
    const ui = await mount();
    expect(ui.frame()).toContain('examples, not contracts: CSV');
    expect(ui.findings.map((f) => f.value)).not.toContain('CSV');
  });

  test('the requirement reads without the braces', async () => {
    const ui = await mount();
    expect(ui.frame()).toContain('returning CSV.');
    expect(ui.frame()).not.toContain('{{example:');
  });

  test('a finding never blocks acceptance — the linter is advisory', async () => {
    const ui = await mount();
    await ui.press('a');
    expect(ui.session().items[0]!.state).toBe('accepted');
  });
});

describe('marking a value as an example', () => {
  test('m then a number marks that finding', async () => {
    const ui = await mount();
    await ui.press('m');
    expect(ui.frame()).toContain('Mark which as an example?');

    await ui.press('1');
    expect(ui.marked.map((f) => f.value)).toEqual(['POST /v1/export']);
  });

  test('picks the numbered finding, not the first', async () => {
    const ui = await mount();
    await ui.press('m', '2');
    expect(ui.marked.map((f) => f.value)).toEqual(['user_email']);
  });

  test('an out-of-range number cancels rather than marking something arbitrary', async () => {
    const ui = await mount();
    await ui.press('m', '9');
    expect(ui.marked).toEqual([]);
    expect(ui.frame()).not.toContain('Mark which as an example?');
  });

  test('any other key cancels', async () => {
    const ui = await mount();
    await ui.press('m', 'z');
    expect(ui.marked).toEqual([]);
  });

  test('marking mode swallows decision keys', async () => {
    // Otherwise `m` then a mistyped `a` would silently accept.
    const ui = await mount();
    await ui.press('m', 'a');
    expect(ui.session().items[0]!.state).toBe('pending');
    expect(ui.marked).toEqual([]);
  });

  test('m does nothing when there is nothing flagged', async () => {
    const clean = parseSpecFile(
      '## ADDED Requirements\n\n### Requirement: Clean\nThe system SHALL let a user export data.\n',
      'cap',
      '/p/specs/cap/spec.md',
    ).requirements;
    const [session] = createSignal(openSession('c', clean, emptyReview('c')));
    const setup = await testRender(
      () => (
        <ReviewScreen
          session={session()} findings={[]}
          onAccept={() => {}} onReject={() => {}} onDefer={() => {}} onSkip={() => {}}
          onEdit={() => {}} onMove={() => {}} onBack={() => {}}
        />
      ),
      { width: 90, height: 24 },
    );
    await setup.flush();
    open.push({ destroy: () => setup.renderer.destroy() });

    await setup.mockInput.pressKey('m');
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain('Mark which');
  });
});
