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
import type { KeyEvent } from '@opentui/core';
import { THEME } from './theme.ts';

/** A decision that needs a typed reason before it is recorded. */
export type PromptKind = 'reject' | 'defer';

export interface ReviewScreenProps {
  session: ReviewSession;
  onAccept: () => void;
  onReject: (note: string) => void;
  onDefer: (reason: string) => void;
  onSkip: () => void;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onBack: () => void;
}

const STATE_COLOR: Record<string, string> = {
  accepted: THEME.ok,
  rejected: THEME.err,
  deferred: THEME.warn,
  pending: THEME.dim,
};

/** A key that contributes a character to a prompt, as opposed to a command. */
function isPrintable(key: KeyEvent): boolean {
  // Length 1 excludes alt-chords, which arrive as a two-character sequence
  // beginning with ESC and would otherwise type a stray letter.
  return (
    !key.ctrl && typeof key.sequence === 'string' && key.sequence.length === 1 && key.sequence >= ' '
  );
}

export function ReviewScreen(props: ReviewScreenProps) {
  const [prompt, setPrompt] = createSignal<PromptKind | null>(null);
  const [draft, setDraft] = createSignal('');
  const [help, setHelp] = createSignal(false);

  const item = createMemo(() => currentItem(props.session));
  const pos = createMemo(() => position(props.session));

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

  /**
   * `ctrl+c`, not a bare escape, is the reliable cancel.
   *
   * A lone ESC is the prefix of every escape sequence, so a terminal parser
   * cannot deliver it until it sees what follows — pressing it alone produces
   * no event at all, and pressing it before `x` arrives as alt-x. `escape` is
   * still handled for terminals that do resolve it, but nothing depends on it.
   */
  const isCancel = (key: KeyEvent): boolean =>
    key.name === 'escape' || (key.ctrl === true && key.name === 'c');

  useKeyboard((key) => {
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

    switch (key.name) {
      case 'a': return props.onAccept();
      case 'r': return setPrompt('reject');
      case 'd': return setPrompt('defer');
      case 's': return props.onSkip();
      case 'e': return props.onEdit();
      case 'n': case 'down': case 'j': return props.onMove(1);
      case 'p': case 'up': case 'k': return props.onMove(-1);
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
        <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
          {/* Where am I */}
          <text style={{ fg: THEME.dim }}>
            {`${item()!.requirement.capability}   requirement ${pos().index} of ${pos().total}   [${item()!.requirement.operation}]`}
          </text>
          <text>{' '}</text>

          {/* The requirement */}
          <text style={{ fg: THEME.accent }}>
            {`Requirement: ${item()!.requirement.name}`}
          </text>
          <text>{' '}</text>
          <For each={wrap(item()!.requirement.text, 76)}>
            {(line) => <text style={{ fg: THEME.text }}>{line || ' '}</text>}
          </For>
          <text>{' '}</text>

          {/* Its scenarios */}
          <For each={item()!.requirement.scenarios}>
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

      {/* Constant region: progress never leaves the frame */}
      <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.dim }}>
          {`${renderProgressBar(props.session.summary)}  ${renderCounts(props.session.summary)}`}
        </text>
      </box>

      {/* Prompt, help, or the key hints — one at a time */}
      <Show when={prompt()}>
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

      <Show when={!prompt() && help()}>
        <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.text }}>a accept · r reject (asks why) · d defer (asks what would verify it)</text>
          <text style={{ fg: THEME.text }}>e edit in $EDITOR · s skip · n/p move · q back · any key closes</text>
        </box>
      </Show>

      <Show when={!prompt() && !help()}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.dim }}>
            a accept · r reject · e edit · d defer · s skip · n/p move · ? help · q back
          </text>
        </box>
      </Show>
    </box>
  );
}
