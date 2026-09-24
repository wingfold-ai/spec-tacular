/**
 * M3's exit criterion, against real specs from the OpenSpec repo:
 * review a change end to end with the keyboard, quit halfway, resume in place.
 *
 * Uses the real review screen, real keystrokes, real parsing and a real
 * sidecar on disk — only the OpenSpec CLI is stepped around, since the spec
 * files are read directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capabilityFromPath, parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import { loadReview, saveReview } from '../src/core/review.ts';
import { decide, openSession, skip, move, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const CHANGE = 'simplify-skill-installation';
const SPEC_DIR = `/home/user/OpenSpec/openspec/changes/${CHANGE}/specs`;

const available = existsSync(SPEC_DIR);

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...specFiles(path));
    else if (entry === 'spec.md') out.push(path);
  }
  return out.sort();
}

function realRequirements(): Requirement[] {
  return specFiles(SPEC_DIR).flatMap(
    (f) => parseSpecFile(readFileSync(f, 'utf8'), capabilityFromPath(f), f).requirements,
  );
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-e2e-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mounts the review screen over a session that persists to `root`. */
async function mount(root: string, initial: ReviewSession) {
  const [session, setSession] = createSignal(initial);
  const commit = (next: ReviewSession) => {
    // Persisted on every decision, exactly as the app does it: a crash
    // mid-review must not lose the decisions already made.
    saveReview(root, next.review);
    setSession(next);
  };

  const setup = await testRender(
    () => (
      <ReviewScreen
        session={session()}
        onAccept={() => commit(decide(session(), 'accepted'))}
        onReject={(note) => commit(decide(session(), 'rejected', { note }))}
        onDefer={(reason) => commit(decide(session(), 'deferred', { deferReason: reason }))}
        onSkip={() => commit(skip(session()))}
        onMove={(d) => commit(move(session(), d))}
        onEdit={() => {}}
        onBack={() => {}}
      />
    ),
    { width: 100, height: 44 },
  );
  await setup.flush();

  return {
    session,
    frame: () => setup.captureCharFrame(),
    press: async (...keys: string[]) => {
      for (const k of keys) await setup.mockInput.pressKey(k);
      await setup.flush();
    },
    type: async (text: string) => {
      for (const ch of text) await setup.mockInput.pressKey(ch);
      await setup.flush();
    },
    destroy: () => setup.renderer.destroy(),
  };
}

describe.if(available)('reviewing a real change end to end', () => {
  test('the fixture is the large change M3 is meant to handle', () => {
    expect(realRequirements().length).toBeGreaterThanOrEqual(20);
  });

  test('accepts every requirement by keyboard, then reports complete', async () => {
    const root = tmp();
    const requirements = realRequirements();
    const ui = await mount(root, openSession(CHANGE, requirements, loadReview(root, CHANGE)));

    expect(ui.frame()).toContain(`requirement 1 of ${requirements.length}`);

    for (let i = 0; i < requirements.length; i++) await ui.press('a');

    expect(ui.session().summary).toMatchObject({
      total: requirements.length,
      accepted: requirements.length,
      pending: 0,
      complete: true,
    });
    expect(ui.frame()).toContain(`${requirements.length} accepted`);
    ui.destroy();
  });

  test('quits halfway and resumes at the same requirement', async () => {
    const root = tmp();
    const requirements = realRequirements();

    const first = await mount(root, openSession(CHANGE, requirements, loadReview(root, CHANGE)));
    for (let i = 0; i < 7; i++) await first.press('a');
    const stoppedAt = first.session().items[first.session().cursor]!.item.id;
    expect(first.session().summary.accepted).toBe(7);
    first.destroy();

    // A brand-new session, reading only what is on disk — the same thing a
    // fresh process would do.
    const resumed = await mount(
      root,
      openSession(CHANGE, requirements, loadReview(root, CHANGE)),
    );
    expect(resumed.session().summary.accepted).toBe(7);
    expect(resumed.session().items[resumed.session().cursor]!.item.id).toBe(stoppedAt);
    expect(resumed.frame()).toContain('7 accepted');
    resumed.destroy();
  });

  test('a mixed pass records each decision with its reason and survives a restart', async () => {
    const root = tmp();
    const requirements = realRequirements();
    const ui = await mount(root, openSession(CHANGE, requirements, loadReview(root, CHANGE)));

    await ui.press('a');
    await ui.press('r');
    await ui.type('names an endpoint that is not decided');
    await ui.press('RETURN');
    await ui.press('d');
    await ui.type('needs a deployed instance');
    await ui.press('RETURN');
    await ui.press('s');
    ui.destroy();

    const stored = loadReview(root, CHANGE);
    const states = requirements.slice(0, 4).map((r) => stored.requirements[r.id]?.state ?? 'pending');
    expect(states).toEqual(['accepted', 'rejected', 'deferred', 'pending']);
    expect(stored.requirements[requirements[1]!.id]?.note).toBe(
      'names an endpoint that is not decided',
    );
    expect(stored.requirements[requirements[2]!.id]?.deferReason).toBe(
      'needs a deployed instance',
    );
  });

  test('rejected requirements come back around in the same pass', async () => {
    const root = tmp();
    const requirements = realRequirements();
    const ui = await mount(root, openSession(CHANGE, requirements, loadReview(root, CHANGE)));

    // Reject the first, accept every other one; the rejection is the only
    // thing left needing attention, so review must return to it.
    await ui.press('r');
    await ui.press('RETURN');
    for (let i = 1; i < requirements.length; i++) await ui.press('a');

    expect(ui.session().items[ui.session().cursor]!.item.id).toBe(requirements[0]!.id);
    expect(ui.session().summary).toMatchObject({ rejected: 1, complete: false });
    ui.destroy();
  });
});
