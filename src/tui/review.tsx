/**
 * The review screen — one requirement at a time.
 *
 * This is the screen the product exists for. Everything else is navigation to
 * get here. Design rules it follows (docs/tui-design.md):
 *   - one decision on screen at a time;
 *   - queue progress never leaves the frame;
 *   - anything that drifted since you accepted it says so, loudly.
 */

import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ReviewSession } from '../core/session.ts';
import { currentItem, position } from '../core/session.ts';
import { renderCounts, renderProgressBar, wrap } from '../render/requirement.ts';
import type { Finding } from '../core/concreteness.ts';
import { exampleValues, renderExamples } from '../core/examples.ts';
import { isRequirement, type Requirement, type ReviewItem } from '../core/requirements.ts';
import type { RefineTurn, Refinement } from '../core/refine.ts';
import { THEME } from './theme.ts';
import { isCancel, isPrintable } from './input.ts';
import { useCopy, usePasteInto } from './copy-paste.ts';
import { RevisePanel } from './revise.tsx';

/** A decision that needs a typed reason before it is recorded. */
export type PromptKind = 'reject' | 'defer';

/** Revising a requirement with the agent: what the screen needs for it. */
export interface RefinePort {
  /** Why there is no agent to revise with, or null when there is one. */
  unavailable: string | null;
  /** The requirement's Markdown as it is in its file. */
  current: (item: Requirement) => { ok: true; block: string } | { ok: false; reason: string };
  propose: (item: Requirement, turns: RefineTurn[], instruction: string) => Promise<Refinement>;
  /** Writes an accepted revision; the session then shows it pending again. */
  accept: (item: Requirement, block: string) => { ok: true } | { ok: false; reason: string };
}

/** An item as Markdown, for copying when its file cannot be read. */
function asMarkdown(item: ReviewItem): string {
  if (!isRequirement(item)) return `### ${item.name}\n\n${item.text}`;
  return [
    `### Requirement: ${item.name}`,
    '',
    item.text,
    ...item.scenarios.flatMap((s) => ['', `#### Scenario: ${s.name}`, ...s.body]),
  ].join('\n');
}

export interface ReviewScreenProps {
  session: ReviewSession;
  /** Concreteness findings for the current requirement. Advisory, never blocking. */
  findings?: Finding[];
  /** Marks a flagged value as an illustration rather than a contract. */
  onMarkExample?: (finding: Finding) => void;
  /** Lifts the current design decision to a project-wide ADR. */
  onPromote?: () => void;
  /** Whether the current item is a promotable design decision. */
  promotable?: boolean;
  onAccept: () => void;
  onReject: (note: string) => void;
  onDefer: (reason: string) => void;
  onSkip: () => void;
  /** Opens the item in `$EDITOR` — `E`, now that `e` revises it with the agent. */
  onEdit: () => void;
  /** Revising with the agent; without it, `e` opens the editor as `E` does. */
  refine?: RefinePort;
  onMove: (delta: number) => void;
  onBack: () => void;
}

const STATE_COLOR: Record<string, string> = {
  accepted: THEME.ok,
  rejected: THEME.err,
  deferred: THEME.warn,
  pending: THEME.dim,
};

export function ReviewScreen(props: ReviewScreenProps) {
  const [prompt, setPrompt] = createSignal<PromptKind | null>(null);
  const [draft, setDraft] = createSignal('');
  const [help, setHelp] = createSignal(false);
  const [marking, setMarking] = createSignal(false);
  /** The requirement being revised with the agent, and its text when opened. */
  const [revising, setRevising] = createSignal<{ item: Requirement; current: string } | null>(null);
  /** One line about what just happened, until the next key. */
  const [flash, setFlash] = createSignal<string | null>(null);
  const copy = useCopy();

  const item = createMemo(() => currentItem(props.session));
  const pos = createMemo(() => position(props.session));
  const findings = createMemo(() => props.findings ?? []);
  // Examples are shown by value rather than inline braces: the braces are
  // noise on screen, but which values are illustrative is the point.
  const examples = createMemo(() => {
    const current = item();
    return current ? exampleValues(current.item.text) : [];
  });
  // A design decision has neither scenarios nor a delta operation; the review
  // screen renders both kinds of item.
  const scenarios = createMemo(() => {
    const current = item();
    return current && isRequirement(current.item) ? current.item.scenarios : [];
  });
  const operation = createMemo(() => {
    const current = item();
    return current && isRequirement(current.item) ? `   [${current.item.operation}]` : '';
  });
  // Named for what it is. "item 3 of 12" tells a reviewer nothing about what
  // they are being asked to judge.
  const noun = createMemo(() => {
    const current = item();
    if (!current) return 'item';
    if (isRequirement(current.item)) return 'requirement';
    return current.item.capability.startsWith('foundation/') ? 'ground rule' : 'decision';
  });
  const label = createMemo(() => {
    const word = noun();
    return word.charAt(0).toUpperCase() + word.slice(1);
  });

  const closePrompt = () => {
    setPrompt(null);
    setDraft('');
  };

  const submitPrompt = () => {
    const kind = prompt();
    const text = draft().trim();
    if (!kind) return;
    // An empty reason is allowed for a rejection but not for a deferral: a
    // deferred requirement leaves the change without ever being verified, so
    // the register has to record what would verify it (problem-analysis §8).
    if (kind === 'defer' && text === '') return;
    closePrompt();
    if (kind === 'reject') props.onReject(text);
    else props.onDefer(text);
  };

  const openRevise = () => {
    const current = item();
    if (!current) return;
    if (!props.refine) return props.onEdit();
    if (!isRequirement(current.item)) {
      setFlash('Only requirements are revised with the AI — E opens this in your editor');
      return;
    }
    const text = props.refine.current(current.item);
    if (!text.ok) {
      setFlash(text.reason);
      return;
    }
    setRevising({ item: current.item, current: text.block });
  };

  const copyCurrent = () => {
    const current = item();
    if (!current) return;
    const fromFile = isRequirement(current.item) ? props.refine?.current(current.item) : undefined;
    copy(fromFile?.ok ? fromFile.block : asMarkdown(current.item), `the ${noun()}`);
  };

  usePasteInto(() => (prompt() ? (text: string) => setDraft((d) => d + text) : null));

  useKeyboard((key) => {
    // The revise panel has the keyboard while it is open.
    if (revising()) return;
    setFlash(null);

    if (marking()) {
      // Numbered rather than cycling: with several findings on one
      // requirement, picking the wrong one rewrites the spec.
      const pick = Number(key.sequence);
      if (Number.isInteger(pick) && pick >= 1 && pick <= findings().length) {
        props.onMarkExample?.(findings()[pick - 1]!);
      }
      setMarking(false);
      return;
    }

    if (prompt()) {
      if (isCancel(key)) closePrompt();
      else if (key.name === 'return' || key.name === 'enter') submitPrompt();
      else if (key.name === 'backspace') setDraft((d) => d.slice(0, -1));
      else if (isPrintable(key)) setDraft((d) => d + key.sequence);
      return;
    }

    // Help is a transient overlay: any key dismisses it rather than acting,
    // so you cannot accept a requirement you are not currently looking at.
    if (help()) {
      setHelp(false);
      return;
    }

    if (isCancel(key)) return props.onBack();

    // `E` and ctrl+e are the editor, as ctrl+e is everywhere else.
    if (key.name === 'e' && (key.shift || key.ctrl)) return props.onEdit();
    if (key.ctrl) return;

    switch (key.name) {
      case 'a': return props.onAccept();
      case 'r': return setPrompt('reject');
      case 'd': return setPrompt('defer');
      case 's': return props.onSkip();
      case 'e': return openRevise();
      case 'y': return copyCurrent();
      case 'm':
        if (findings().length > 0) setMarking(true);
        return;
      case 'p':
        // `p` only promotes on a design decision; on a requirement it is
        // "previous", which is why the two can share a key.
        if (props.promotable) return props.onPromote?.();
        return props.onMove(-1);
      case 'n': case 'down': case 'j': return props.onMove(1);
      case 'up': case 'k': return props.onMove(-1);
      case 'q': return props.onBack();
      case '?': return setHelp(true);
      default: return;
    }
  });

  return (
    <box style={{ flexDirection: 'column', width: '100%', height: '100%' }}>
      <Show
        when={item()}
        fallback={
          <box style={{ padding: 1 }}>
            <text style={{ fg: THEME.dim }}>
              No requirements in this change. Nothing to review.
            </text>
          </box>
        }
      >
        <Show when={revising()}>
          <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
            <RevisePanel
              name={revising()!.item.name}
              current={revising()!.current}
              seed={item()?.state === 'rejected' && !item()?.drifted ? item()?.review.note : undefined}
              unavailable={props.refine?.unavailable ?? null}
              propose={(turns, instruction) => props.refine!.propose(revising()!.item, turns, instruction)}
              onAccept={(block) => {
                const result = props.refine!.accept(revising()!.item, block);
                if (result.ok) setFlash('Revised and written — it is pending again: a accepts the new text');
                return result;
              }}
              onClose={(message) => {
                setRevising(null);
                if (message) setFlash(message);
              }}
            />
          </box>
        </Show>
        <Show when={!revising()}>
        <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
          {/* Where am I */}
          <text style={{ fg: THEME.dim }}>
            {`${item()!.item.capability}   ${noun()} ${pos().index} of ${pos().total}${operation()}`}
          </text>
          <text>{' '}</text>

          {/* The requirement */}
          <text style={{ fg: THEME.accent }}>
            {`${label()}: ${item()!.item.name}`}
          </text>
          <text>{' '}</text>
          <For each={wrap(renderExamples(item()!.item.text), 76)}>
            {(line) => <text style={{ fg: THEME.text }}>{line || ' '}</text>}
          </For>
          <text>{' '}</text>

          <Show when={examples().length > 0}>
            <text style={{ fg: THEME.dim }}>
              {`  examples, not contracts: ${examples().join(', ')}`}
            </text>
            <text>{' '}</text>
          </Show>

          {/* Its scenarios */}
          <For each={scenarios()}>
            {(scenario) => (
              <box style={{ flexDirection: 'column' }}>
                <text style={{ fg: THEME.accent2 }}>{`  Scenario: ${scenario.name}`}</text>
                <For each={scenario.body}>
                  {(line) => <text style={{ fg: THEME.text }}>{`    ${line}`}</text>}
                </For>
                <text>{' '}</text>
              </box>
            )}
          </For>

          <Show when={props.promotable}>
            <text style={{ fg: THEME.accent2 }}>
              {'  this decision is marked global — p promotes it to a project-wide ADR'}
            </text>
            <text>{' '}</text>
          </Show>

          {/* Advisory only — a finding can never block a stage */}
          <Show when={findings().length > 0}>
            <For each={findings()}>
              {(finding, i) => (
                <text style={{ fg: THEME.warn }}>
                  {`  ${i() + 1}. ${finding.question}: ${finding.value}`}
                </text>
              )}
            </For>
            <text>{' '}</text>
          </Show>

          {/* Honest state: drift is never silent */}
          <Show when={item()!.drifted}>
            <text style={{ fg: THEME.warn }}>
              {`  ! changed since you marked it ${item()!.review.state} — review it again`}
            </text>
          </Show>
          <Show when={!item()!.drifted && item()!.state !== 'pending'}>
            <text style={{ fg: STATE_COLOR[item()!.state] ?? THEME.dim }}>
              {`  ${item()!.state}${item()!.review.note ? ` — ${item()!.review.note}` : ''}`}
            </text>
          </Show>
        </box>
        </Show>
      </Show>

      {/* Constant region: progress never leaves the frame */}
      <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
        <Show when={flash() && !revising()}>
          <text style={{ fg: THEME.warn }}>{flash()}</text>
        </Show>
        <text style={{ fg: THEME.dim }}>
          {`${renderProgressBar(props.session.summary)}  ${renderCounts(props.session.summary)}`}
        </text>
      </box>

      {/* Prompt, help, or the key hints — one at a time */}
      <Show when={prompt() && !revising()}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.warn }}>
            {prompt() === 'reject' ? 'Why reject? ' : 'What would verify it? '}
          </text>
          <text style={{ fg: THEME.text }}>{`${draft()}_`}</text>
          <text style={{ fg: THEME.dim }}>
            {prompt() === 'defer' && draft().trim() === ''
              ? '   (a reason is required)   esc cancel'
              : '   enter confirm · esc cancel'}
          </text>
        </box>
      </Show>

      <Show when={!revising() && !prompt() && marking()}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.warn }}>
            {`Mark which as an example? 1-${findings().length} · any other key cancels`}
          </text>
        </box>
      </Show>

      <Show when={!revising() && !prompt() && !marking() && help()}>
        <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.text }}>a accept · r reject (asks why) · d defer (asks what would verify it)</text>
          <text style={{ fg: THEME.text }}>e revise with AI: say what should change, see the diff, accept or ask again</text>
          <text style={{ fg: THEME.text }}>E or ctrl+e edit in $EDITOR · y copy it · s skip · n/p move · q back</text>
          <text style={{ fg: THEME.text }}>drag to select text, ctrl+c copies it · ctrl+v pastes into a prompt · any key closes</text>
        </box>
      </Show>

      <Show when={!revising() && !prompt() && !marking() && !help()}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.dim }}>
            {props.promotable
              ? 'a accept · r reject · e revise with AI · E editor · p promote to ADR · s skip · ? help · q back'
              : findings().length > 0
                ? 'a accept · r reject · e revise with AI · E editor · d defer · m mark example · s skip · ? help · q back'
                : 'a accept · r reject · e revise with AI · E editor · d defer · s skip · n/p move · ? help · q back'}
          </text>
        </box>
      </Show>
    </box>
  );
}
