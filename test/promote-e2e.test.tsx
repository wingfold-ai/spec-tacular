/**
 * M7's exit criterion: a decision promoted while reviewing change A appears in
 * the context of change B's design generation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, buildPrompt } from '../src/core/context.ts';
import {
  parseDecisions,
  promoteDecision,
  replaceDecisionBody,
  type Decision,
} from '../src/core/decisions.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, openSession, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const DESIGN_A = `# Design

## Decisions

### Errors are values
**Scope: global**

**Decision:** Every fallible operation returns a result type rather than throwing.

**Rationale:** Exceptions escape the type checker.

### Cache the schema in memory
**Scope: local**

**Decision:** Parse once per process.
`;

const dirs: string[] = [];
const renderers: { destroy: () => void }[] = [];
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-promote-'));
  dirs.push(d);
  mkdirSync(join(d, 'changes', 'change-a'), { recursive: true });
  const design = join(d, 'changes', 'change-a', 'design.md');
  writeFileSync(design, DESIGN_A, 'utf8');
  return { root: d, design };
};
afterEach(() => {
  for (const r of renderers.splice(0)) r.destroy();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const load = (design: string): Decision[] =>
  parseDecisions(readFileSync(design, 'utf8'), design);

describe('promotion end to end', () => {
  test('a decision promoted in change A reaches change B’s prompt', () => {
    const { root, design } = project();
    const [global] = load(design);

    const { adr, reference } = promoteDecision(root, global!, { change: 'change-a' });
    expect(replaceDecisionBody(global!, reference)).toEqual({ ok: true });

    // Change B knows nothing about change A; it only reads the project store.
    const prompt = buildPrompt(buildContext(root, []), 'WRITE THE DESIGN FOR CHANGE B');
    expect(prompt).toContain('Accepted architectural decisions');
    expect(prompt).toContain(`ADR-000${adr.number}`);
    expect(prompt).toContain('returns a result type rather than throwing');
    expect(prompt).toContain('never diverge silently');
    expect(prompt.indexOf('result type')).toBeLessThan(prompt.indexOf('WRITE THE DESIGN'));
  });

  test('change A keeps a reference, so the two cannot drift', () => {
    const { root, design } = project();
    const [global] = load(design);
    const { reference } = promoteDecision(root, global!, { change: 'change-a' });
    replaceDecisionBody(global!, reference);

    const updated = readFileSync(design, 'utf8');
    expect(updated).toContain('### Errors are values');
    expect(updated).toContain('ADR-0001');
    expect(updated).not.toContain('Exceptions escape the type checker.');
    // The local decision is untouched.
    expect(updated).toContain('Parse once per process.');
  });

  test('a local decision is not promotable', () => {
    const { design } = project();
    expect(load(design)[1]!.scope).toBe('local');
  });
});

describe('promoting from the review screen', () => {
  async function mount(decisions: Decision[], onPromote: () => void) {
    const [session, setSession] = createSignal<ReviewSession>(
      openSession('change-a', decisions, emptyReview('change-a')),
    );
    const setup = await testRender(
      () => (
        <ReviewScreen
          session={session()}
          promotable={decisions[0]!.scope === 'global'}
          onPromote={onPromote}
          onAccept={() => setSession((s) => decide(s, 'accepted'))}
          onReject={() => {}} onDefer={() => {}} onSkip={() => {}}
          onEdit={() => {}} onMove={() => {}} onBack={() => {}}
        />
      ),
      { width: 96, height: 26 },
    );
    await setup.flush();
    renderers.push({ destroy: () => setup.renderer.destroy() });
    return {
      frame: () => setup.captureCharFrame(),
      press: async (k: string) => {
        await setup.mockInput.pressKey(k);
        await setup.flush();
      },
      session,
    };
  }

  test('a global decision offers promotion and p triggers it', () => {
    const { design } = project();
    return (async () => {
      let promoted = 0;
      const ui = await mount(load(design), () => { promoted++; });

      expect(ui.frame()).toContain('decision 1 of 2');
      expect(ui.frame()).toContain('marked global — p promotes it');
      expect(ui.frame()).toContain('p promote to ADR');

      await ui.press('p');
      expect(promoted).toBe(1);
    })();
  });

  test('on a local decision, p is still "previous"', async () => {
    // The two share a key; only a global decision reassigns it.
    const { design } = project();
    const local = [load(design)[1]!, load(design)[0]!];
    let promoted = 0;
    const ui = await mount(local, () => { promoted++; });

    expect(ui.frame()).not.toContain('marked global');
    await ui.press('p');
    expect(promoted).toBe(0);
  });

  test('a decision renders without scenarios and is still acceptable', async () => {
    const { design } = project();
    const ui = await mount(load(design), () => {});
    // Named for what it is: a decision is not a requirement.
    expect(ui.frame()).toContain('Decision: Errors are values');
    expect(ui.frame()).not.toContain('no scenarios');

    await ui.press('a');
    expect(ui.session().summary.accepted).toBe(1);
  });
});
