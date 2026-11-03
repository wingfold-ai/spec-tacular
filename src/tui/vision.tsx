/**
 * The vision screen: a new project's way in.
 *
 * "What do you want to change?" is the wrong first question when nothing
 * exists yet (core/vision.ts). Here the developer describes what they want to
 * build, in their own words and at any length; an interview sharpens it one
 * question at a time until they stop it or the model has enough; then it is
 * split into slices they review before anything is written.
 */

import { useKeyboard } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { optionAnswer, type AdviceOption } from '../core/advisor.ts';
import type { RefineTurn, Refinement } from '../core/refine.ts';
import { mergeSlices, moveSlice, type ProposedSlice, type VisionSession } from '../core/vision.ts';
import { RevisePanel } from './revise.tsx';
import { wrap } from '../render/requirement.ts';
import { THEME } from './theme.ts';
import { useContentWidth } from './layout.ts';
import { createLine, isCancel, isEnter } from './input.ts';
import { usePasteInto } from './copy-paste.ts';
import { Button, clip, DraftText, KeyBar, Panel, ScrollArea, Spinner } from './widgets.tsx';

export interface VisionScreenProps {
  session: VisionSession | null;
  /** What the model is doing, while it is doing it. */
  busy: string | null;
  error: string | null;
  /** Why there is no interview, when there is no model to run it. */
  unavailable: string | null;
  /**
   * What the developer already said the project is for, in the ground rules'
   * Domain section: the description starts from it, so a new project is not
   * described twice.
   */
  seed?: string;
  onStart: (vision: string) => void;
  /** An answer, or null to skip the question. */
  onAnswer: (answer: string | null) => void;
  /** Enough questions — split it into slices now. */
  onFinish: () => void;
  onConfirm: (kept: ProposedSlice[]) => void;
  /** Not a new project: go straight to a single change. */
  onNotNew: () => void;
  /** Asks the model again after a failure. */
  onRetry: () => void;
  onClose: () => void;
  /**
   * Revising an answer to the question on screen with the agent — an
   * option's, or what is being typed — before it is given. Absent: no ctrl+r.
   */
  revise?: {
    unavailable: string | null;
    propose: (current: string, turns: RefineTurn[], instruction: string) => Promise<Refinement>;
  };
}

const DONE_WORDS = new Set(['done', 'enough', "that's it", 'thats it', 'finish', 'no more']);
const SKIP_WORDS = new Set(['skip', 'pass', 'later', "don't know", 'dont know', 'idk', 'not sure']);

type Row = { kind: 'skip' } | { kind: 'option'; option: AdviceOption } | { kind: 'own' };

export function VisionScreen(props: VisionScreenProps) {
  const contentWidth = useContentWidth();
  const line = createLine(props.session?.vision ? '' : (props.seed ?? '').trim());
  const draft = line.text;
  const setDraft = line.set;
  const [sel, setSel] = createSignal(0);
  /** Slices the developer dropped from the proposal, by id. */
  const [dropped, setDropped] = createSignal<Set<string>>(new Set());
  const [sliceSel, setSliceSel] = createSignal(0);
  /** The proposed slices as the developer reshapes them: merged, moved, reworded. */
  const [slices, setSlices] = createSignal<ProposedSlice[]>(props.session?.slices ?? []);
  createEffect(on(() => props.session?.slices, (proposed) => {
    setSlices(proposed ?? []);
    setDropped(new Set<string>());
    setSliceSel(0);
  }));
  /** The slice whose description is being rewritten, by position. */
  const [rewording, setRewording] = createSignal<number | null>(null);
  const sliceLine = createLine('');
  const [hint, setHint] = createSignal<string | null>(null);
  /** An answer being revised with the agent: the panel has the screen. */
  const [revising, setRevising] = createSignal<{ ask: string; current: string } | null>(null);

  const phase = createMemo(() => {
    const s = props.session;
    if (!s || !s.vision) return 'describe' as const;
    if (s.slices.length > 0) return 'review' as const;
    if (s.pending) return 'interview' as const;
    return 'working' as const;
  });

  const question = () => props.session?.pending ?? null;
  // Skip first, as in the ground rules: the way out of any question.
  const rows = createMemo<Row[]>(() => [
    { kind: 'skip' as const },
    ...(question()?.options ?? []).map((option) => ({ kind: 'option' as const, option })),
    { kind: 'own' as const },
  ]);

  // A new question starts on its recommendation, with an empty answer box —
  // or on writing your own, never on Skip.
  createEffect(on(() => question()?.ask, (ask) => {
    if (ask === undefined) return; // describing: keep what is there, the seed included
    setDraft('');
    const rec = rows().findIndex((r) => r.kind === 'option' && r.option.recommended);
    setSel(rec >= 0 ? rec : rows().length - 1);
  }));

  const kept = createMemo(() => slices().filter((s) => !dropped().has(s.id)));

  /** The highlighted option's whole answer, when there is more of it than its row shows. */
  const preview = createMemo(() => {
    const row = rows()[sel()];
    if (row?.kind !== 'option') return null;
    const text = optionAnswer(row.option);
    return text !== row.option.label || text.length > 29 || text.includes('\n') ? text : null;
  });
  const PREVIEW_LINES = 10;

  /**
   * ctrl+r: what is revised is what is in front of you — the option
   * highlighted, else what is being typed.
   */
  const startRevise = () => {
    const q = question();
    if (!q || !props.revise) return;
    const row = rows()[sel()];
    const text = row?.kind === 'option' ? optionAnswer(row.option) : draft().trim();
    if (text === '') return setHint('Highlight an option (or type a first draft), then ctrl+r to revise it with AI');
    setHint(null);
    setRevising({ ask: q.ask, current: text });
  };

  // Pasting a long description is the natural way to hand over a vision.
  usePasteInto(
    () => (!props.busy && !revising() && (phase() === 'describe' || phase() === 'interview') ? (text: string) => line.insert(text) : null),
    { multiline: true },
  );

  const submitDescribe = () => {
    const text = draft().trim();
    if (text.length < 10) return setHint('Say a little more — a few sentences about what you want to build');
    setHint(null);
    props.onStart(text);
  };

  const submitAnswer = () => {
    const text = draft().trim();
    const word = text.toLowerCase().replace(/[.!]+$/, '');
    if (DONE_WORDS.has(word)) return props.onFinish();
    if (SKIP_WORDS.has(word)) return props.onAnswer(null);
    if (text) return props.onAnswer(text);
    const row = rows()[sel()];
    if (row?.kind === 'skip') return props.onAnswer(null);
    if (row?.kind === 'option') return props.onAnswer(optionAnswer(row.option));
    setHint('Pick an option or type an answer — tab skips it, "done" ends the questions');
  };

  useKeyboard((key) => {
    // The revise panel has the keyboard while it is open.
    if (revising()) return;
    if (props.busy) {
      if (isCancel(key)) props.onClose();
      return;
    }
    if (phase() === 'review' && rewording() !== null) {
      const at = rewording()!;
      if (isEnter(key)) {
        // `Title — what it does`: both are reworded on the one line.
        const text = sliceLine.text().trim();
        const cut = text.indexOf(' — ');
        const title = cut > 0 ? text.slice(0, cut).trim() : '';
        const summary = cut > 0 ? text.slice(cut + 3).trim() : text;
        if (text) setSlices((all) => all.map((sl, i) => (i === at ? { ...sl, ...(title ? { title } : {}), summary: summary || sl.summary } : sl)));
        setRewording(null);
        return;
      }
      if (isCancel(key)) return setRewording(null);
      sliceLine.edit(key);
      return;
    }

    if (isCancel(key)) return props.onClose();

    if (phase() === 'review') {
      const n = slices().length;
      const move = key.name === 'up' || key.name === 'k' ? -1 : key.name === 'down' || key.name === 'j' ? 1 : 0;
      setHint(null);
      if (move !== 0 && key.shift) {
        const moved = moveSlice(slices(), sliceSel(), move);
        if (!moved.ok) return setHint(moved.reason);
        setSlices(moved.slices);
        setSliceSel((s) => s + move);
      } else if (move !== 0) setSliceSel((s) => (s + move + n) % n);
      else if (key.name === 'm') {
        if (sliceSel() >= n - 1) return setHint('The last slice has nothing after it to merge — move to the one above');
        const absorbed = slices()[sliceSel() + 1]!;
        setSlices((all) => mergeSlices(all, sliceSel()));
        setDropped((d) => {
          const next = new Set(d);
          next.delete(absorbed.id);
          return next;
        });
        setHint(`Merged “${absorbed.title}” into this slice`);
      } else if (key.name === 'e') {
        const sl = slices()[sliceSel()]!;
        sliceLine.set(`${sl.title} — ${sl.summary}`);
        setRewording(sliceSel());
      } else if (key.name === 'space' || key.name === 'x') {
        const id = slices()[sliceSel()]!.id;
        setDropped((d) => {
          const next = new Set(d);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (isEnter(key)) {
        if (kept().length === 0) return setHint('Keep at least one slice');
        props.onConfirm(kept());
      }
      return;
    }

    if (phase() === 'describe') {
      if (key.ctrl && key.name === 'n') return props.onNotNew();
      if (isEnter(key)) return submitDescribe();
    } else if (phase() === 'interview') {
      if (key.ctrl && key.name === 'd') return props.onFinish();
      if (key.ctrl && key.name === 'r') return startRevise();
      if (key.name === 'tab') return props.onAnswer(null);
      if (isEnter(key)) return submitAnswer();
      if (key.name === 'up' || key.name === 'down') {
        const n = rows().length;
        setSel((s) => (s + (key.name === 'up' ? -1 : 1) + n) % n);
        return;
      }
    } else {
      // Waiting on nothing: the last request failed, or was cut off.
      if (isEnter(key)) props.onRetry();
      return;
    }

    if (line.edit(key)) {
      setHint(null);
      if (phase() === 'interview') setSel(rows().length - 1);
    }
  });

  const width = () => Math.max(contentWidth() - 8, 40);

  const keys = createMemo((): [string, string][] => {
    if (props.busy) return [['ctrl+c', 'back']];
    switch (phase()) {
      case 'describe':
        return [['enter', 'continue'], ['ctrl+n', 'not a new project'], ['ctrl+c', 'back']];
      case 'interview':
        return [
          ['↑↓', 'choose'],
          ['enter', 'answer'],
          ...(props.revise && (rows()[sel()]?.kind === 'option' || draft().trim() !== '') ? [['ctrl+r', 'revise with AI'] as [string, string]] : []),
          ['tab', 'skip question'],
          ['ctrl+d', "that's enough — make slices"],
          ['ctrl+c', 'back'],
        ];
      case 'review':
        if (rewording() !== null) return [['enter', 'save: title — what it does'], ['esc', 'leave it as it was']];
        return [
          ['↑↓', 'select'],
          ['space', 'keep / drop'],
          ['m', 'merge with the next'],
          ['shift+↑↓', 'reorder'],
          ['e', 'reword'],
          ['enter', 'create the roadmap'],
          ['ctrl+c', 'back'],
        ];
      default:
        return [['enter', 'ask again'], ['ctrl+c', 'back']];
    }
  });

  /** The input box, shared by describing and answering. */
  const InputBox = (p: { placeholder: string }) => (
    <box
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: phase() === 'describe' || sel() === rows().length - 1 ? THEME.accent : THEME.border,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <Show when={draft()} fallback={<text style={{ fg: THEME.dim }}>{`› ▏${p.placeholder}`}</text>}>
        {/* Inside a panel and this box: two borders and two paddings a side. */}
        <DraftText draft={draft()} cursor={line.cursor()} width={contentWidth() - 8} maxLines={8} />
      </Show>
    </box>
  );

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {/* 1. Describe it */}
      <Show when={phase() === 'describe'}>
        <Panel title="Your vision" focused>
          <text>{' '}</text>
          <text style={{ fg: THEME.accent }}>
            <strong>What are you building?</strong>
          </text>
          <text>{' '}</text>
          <For each={[
            'This is a new project, so there is nothing to change yet — start from what you',
            'want it to be. Describe it freely: who it is for, what they will do with it, what',
            'matters most. Rough is fine; paste a longer text if you have one.',
            '',
            props.unavailable
              ? `(AI is off: ${props.unavailable} — your description is saved as the vision.)`
              : '✦ Then an AI asks a few questions to sharpen it — skip any, or stop whenever you',
            props.unavailable ? '' : '  like — and splits it into small slices, each becoming one change.',
          ]}>
            {(line) => <text style={{ fg: line.startsWith('✦') || line.startsWith('  like') ? THEME.accent2 : THEME.text }}>{line || ' '}</text>}
          </For>
          <text>{' '}</text>
          <InputBox placeholder="e.g. A booking tool for small clinics: receptionists see free rooms and book them for patients…" />
          <Show when={props.seed?.trim() && draft() === props.seed.trim()}>
            <text style={{ fg: THEME.accent2 }}>
              ⇐ from your ground rules (Domain) — add what matters most, or press enter as it is
            </text>
          </Show>
          <Show when={hint()}>
            <text style={{ fg: THEME.warn }}>{hint()}</text>
          </Show>
          <text>{' '}</text>
          <box style={{ flexDirection: 'row' }}>
            <Button label="▶ Continue" primary focused={false} onPress={submitDescribe} />
            <Button label="Not a new project — just start a change" onPress={props.onNotNew} />
          </box>
        </Panel>
      </Show>

      {/* 2. The interview */}
      <Show when={phase() === 'interview' || phase() === 'working'}>
        <Show when={props.session?.understood && !revising()}>
          <Panel title="What I understood so far">
            <For each={wrap(props.session!.understood, width())}>
              {(line) => <text style={{ fg: THEME.text }}>{line}</text>}
            </For>
          </Panel>
        </Show>
        <Show when={phase() === 'interview' && !props.busy && revising()}>
          <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
            <RevisePanel
              name={revising()!.ask}
              current={revising()!.current}
              unavailable={props.revise?.unavailable ?? null}
              noun="answer"
              invite="How should this answer change? The agent proposes a revision; nothing is answered until you accept it."
              examples={'e.g. "only receptionists, patients never log in" · "add that it must work offline" · "shorter"'}
              editorHint="Type your own answer instead."
              propose={(turns, instruction) => props.revise!.propose(revising()!.current, turns, instruction)}
              onAccept={(block) => {
                // Accepted is answered: as if it had been typed.
                props.onAnswer(block);
                return { ok: true };
              }}
              onKeep={(text) => {
                // The option as proposed after all: as if it had been picked.
                props.onAnswer(text);
                return { ok: true };
              }}
              onClose={(message) => {
                setRevising(null);
                if (message) setHint(message);
              }}
            />
          </box>
        </Show>
        <Show when={phase() === 'interview' && !props.busy && !revising()}>
          <Panel title={`Question ${(props.session?.turns.length ?? 0) + 1}`} focused>
            <text>{' '}</text>
            <text style={{ fg: THEME.accent }}>
              <strong>{question()!.ask}</strong>
            </text>
            <Show when={question()!.why}>
              <text style={{ fg: THEME.dim }}>{clip(question()!.why, width())}</text>
            </Show>
            <text>{' '}</text>
            <For each={rows()}>
              {(row, i) => (
                <box
                  onMouseDown={() =>
                    row.kind === 'option' ? props.onAnswer(optionAnswer(row.option))
                      : row.kind === 'skip' ? props.onAnswer(null)
                      : setSel(i())}
                  style={{ flexDirection: 'row', backgroundColor: sel() === i() ? THEME.highlight : THEME.panel }}
                >
                  <text style={{ fg: THEME.accent, width: 3, flexShrink: 0 }}>{sel() === i() ? ' ▸ ' : '   '}</text>
                  <Show when={row.kind === 'skip'}>
                    <text style={{ fg: sel() === i() ? THEME.accent : THEME.dim }}>↷ Skip this question</text>
                  </Show>
                  <Show when={row.kind === 'own'}>
                    <text style={{ fg: sel() === i() ? THEME.accent : THEME.text }}>
                      {rows().length > 2 ? '✎ Write my own answer' : '✎ Write my answer'}
                    </text>
                  </Show>
                  <Show when={row.kind === 'option'}>
                    <text style={{ fg: sel() === i() ? THEME.accent : THEME.text, width: 30, flexShrink: 0 }}>
                      {clip((row as { option: AdviceOption }).option.label, 29)}
                    </text>
                    <text style={{ fg: THEME.warn, width: 3, flexShrink: 0 }}>
                      {(row as { option: AdviceOption }).option.recommended ? '★ ' : '  '}
                    </text>
                    <text style={{ fg: THEME.dim, flexGrow: 1 }}>
                      {clip((row as { option: AdviceOption }).option.detail, Math.max(width() - 40, 20))}
                    </text>
                  </Show>
                </box>
              )}
            </For>
            {/* The highlighted option in full: what picking it answers */}
            <Show when={preview()}>
              <box
                style={{ border: true, borderStyle: 'rounded', borderColor: THEME.border, paddingLeft: 1, paddingRight: 1, flexDirection: 'column', marginTop: 1 }}
                title={props.revise ? ' picking answers this · ctrl+r revise with AI ' : ' picking answers this '}
              >
                <For each={(() => {
                  const lines = preview()!.split('\n').flatMap((l) => (l.trim() === '' ? [''] : wrap(l, width() - 6)));
                  return lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES - 1), `… ${lines.length - PREVIEW_LINES + 1} more lines`] : lines;
                })()}>
                  {(line) => <text style={{ fg: THEME.text }}>{line || ' '}</text>}
                </For>
              </box>
            </Show>
            <text>{' '}</text>
            <InputBox placeholder='type your answer — "skip" if you do not know, "done" when that is enough' />
            <Show when={hint()}>
              <text style={{ fg: THEME.warn }}>{hint()}</text>
            </Show>
            <text>{' '}</text>
            <box style={{ flexDirection: 'row' }}>
              <Button label="That's enough — make the slices" onPress={props.onFinish} />
            </box>
          </Panel>
        </Show>
      </Show>

      {/* 3. The slices */}
      <Show when={phase() === 'review' && !props.busy}>
        <Panel title="Your roadmap — review the slices" focused grow>
          <text>{' '}</text>
          <For each={wrap(props.session?.refined || props.session?.understood || '', width())}>
            {(line) => <text style={{ fg: THEME.text }}>{line}</text>}
          </For>
          <text>{' '}</text>
          <text style={{ fg: THEME.dim }}>
            Built in this order, one at a time — each becomes a change you review before the next.
          </text>
          <text>{' '}</text>
          {/* Scrolls rather than squeezing slices into each other when there are many */}
          <ScrollArea follow={`slice-${sliceSel()}`}>
          <For each={slices()}>
            {(slice, i) => (
              <box
                id={`slice-${i()}`}
                onMouseDown={() => setSliceSel(i())}
                style={{ flexDirection: 'column', flexShrink: 0, backgroundColor: sliceSel() === i() ? THEME.highlight : THEME.panel }}
              >
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ fg: THEME.accent, width: 3, flexShrink: 0 }}>{sliceSel() === i() ? ' ▸ ' : '   '}</text>
                  <text style={{ fg: dropped().has(slice.id) ? THEME.dim : THEME.ok, width: 4, flexShrink: 0 }}>
                    {dropped().has(slice.id) ? '[ ]' : '[✓]'}
                  </text>
                  <text style={{ fg: dropped().has(slice.id) ? THEME.dim : THEME.accent }}>
                    {`${i() + 1}. ${slice.title}`}
                  </text>
                  <text style={{ fg: THEME.dim }}>{`   ${slice.id}`}</text>
                </box>
                {/* The selected slice in full; the others a line each */}
                <Show
                  when={sliceSel() === i()}
                  fallback={
                    <>
                      <text style={{ fg: dropped().has(slice.id) ? THEME.dim : THEME.text }}>
                        {`       ${clip(slice.summary, width() - 8)}`}
                      </text>
                      <Show when={slice.why}>
                        <text style={{ fg: THEME.dim }}>{`       ${clip(slice.why, width() - 8)}`}</text>
                      </Show>
                    </>
                  }
                >
                  <Show
                    when={rewording() === i()}
                    fallback={
                      <For each={wrap(slice.summary, width() - 8)}>
                        {(l) => <text style={{ fg: dropped().has(slice.id) ? THEME.dim : THEME.text }}>{`       ${l}`}</text>}
                      </For>
                    }
                  >
                    <box style={{ marginLeft: 7, border: true, borderStyle: 'rounded', borderColor: THEME.accent, paddingLeft: 1, paddingRight: 1 }}>
                      <DraftText draft={sliceLine.text()} cursor={sliceLine.cursor()} width={width() - 14} maxLines={6} />
                    </box>
                  </Show>
                  <For each={slice.why ? wrap(slice.why, width() - 8) : []}>
                    {(l) => <text style={{ fg: THEME.dim }}>{`       ${l}`}</text>}
                  </For>
                </Show>
              </box>
            )}
          </For>
          </ScrollArea>
          <Show when={hint()}>
            <text style={{ fg: THEME.warn }}>{hint()}</text>
          </Show>
          <text>{' '}</text>
          <box style={{ flexDirection: 'row', flexShrink: 0 }}>
            <Button
              label={`▶ Create the roadmap — start with “${kept()[0]?.title ?? '…'}”`}
              focused
              onPress={() => (kept().length > 0 ? props.onConfirm(kept()) : setHint('Keep at least one slice'))}
            />
          </box>
        </Panel>
      </Show>

      <Show when={props.busy}>
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <Spinner label={props.busy!} />
        </box>
      </Show>
      <Show when={props.error}>
        <text style={{ fg: THEME.err }}>{` ${props.error}`}</text>
      </Show>
      <Show when={phase() === 'working' && !props.busy}>
        <text style={{ fg: THEME.text }}> Press enter to ask again.</text>
      </Show>

      {/* The roadmap panel grows into the free room itself */}
      <Show when={phase() !== 'review' || props.busy}>
        <box style={{ flexGrow: 1 }} />
      </Show>
      {/* The revise panel shows its own keys */}
      <Show when={!revising()}>
        <KeyBar keys={keys()} />
      </Show>
    </box>
  );
}
