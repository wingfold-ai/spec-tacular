/**
 * The ground-rules setup: one Foundation question at a time.
 *
 * Asked before the first change because the first change's design otherwise
 * invents the architecture implicitly (docs/problem-analysis.md §9). The same
 * rule as the review screen applies — one thing on screen at a time.
 *
 * An advisor may propose options and add follow-up questions (core/advisor.ts).
 * It proposes; the developer decides. Nothing is written until an option is
 * picked or an answer typed, so the Foundation still holds only decisions
 * somebody made.
 *
 * Nothing here can trap anyone: every question can be skipped, a pass ends
 * once each is answered or skipped, and ctrl+f ends it early. What was not
 * answered is then left for later — open, but not blocking the first change.
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, on, Show, untrack } from 'solid-js';
import type { AdviceOption, QuestionMeta } from '../core/advisor.ts';
import type { GuidedQuestion } from '../core/foundation.ts';
import { mergeOptions } from '../core/presets.ts';
import { wrap } from '../render/requirement.ts';
import { THEME } from './theme.ts';
import { editLine, isCancel, isEnter } from './input.ts';
import { Button, clip, KeyBar, Panel, Spinner } from './widgets.tsx';

type Result = { ok: true } | { ok: false; reason: string };

/**
 * What saving an answer returns: whether it was written, and — with an
 * advisor — a promise of the follow-ups it raised, by question name, and the
 * follow-ups the preset table added at once.
 */
export type AnswerResult = Result & { advice?: Promise<{ added: string[] }>; presets?: string[] };

/** Typed instead of an answer, these ask for help or skip the question. */
const HELP_WORDS = new Set(['?', 'help', 'help me', 'idk', "i don't know", 'i dont know', 'dont know', "don't know", 'not sure', "i'm not sure", 'no idea']);
const SKIP_WORDS = new Set(['skip', '/skip', 'later', 'pass']);
/** Typed instead of an answer, these end the pass and leave the rest for later. */
const DONE_WORDS = new Set(['done', '/done', 'finish', "that's all", 'thats all']);

/** A row in the choice list. */
type Row =
  | { kind: 'skip' }
  | { kind: 'option'; option: AdviceOption; derived?: string }
  | { kind: 'help' }
  | { kind: 'own' };

/**
 * What the developer has chosen on this question — by what it is, not by
 * position, since positions move when the advisor's options arrive.
 */
type Pick = { kind: 'option'; label: string } | { kind: 'skip' } | { kind: 'help' } | { kind: 'own' };

const pickOf = (row: Row | undefined): Pick | null =>
  !row ? null : row.kind === 'option' ? { kind: 'option', label: row.option.label } : { kind: row.kind };

export interface FoundationScreenProps {
  questions: GuidedQuestion[];
  /** Advisor state per question id: options, and whether it is a follow-up. */
  meta?: Record<string, QuestionMeta>;
  /** Advisor requests in flight, by the question they are about. */
  thinking?: string[];
  /** Why there are no AI suggestions, when there are none. */
  advisorNote?: string | null;
  /** A transient line, e.g. that follow-ups were added. */
  notice?: string | null;
  /** A question came on screen — the moment to fetch options for it. */
  onShow?: (question: GuidedQuestion) => void;
  /** Writes an answer; the parent re-reads `questions` afterwards. */
  onAnswer: (question: GuidedQuestion, answer: string) => AnswerResult;
  /**
   * Asks the advisor to help with a question the developer cannot answer.
   * Resolves to the simpler questions added before it, by name. Absent when
   * there is no advisor.
   */
  onHelp?: (question: GuidedQuestion) => Promise<{ probes: string[] }>;
  /** Removes a follow-up the developer finds irrelevant. */
  onDismiss?: (question: GuidedQuestion) => void;
  /** Opens the question's section in $EDITOR, for an answer longer than a line. */
  onEdit: (question: GuidedQuestion) => void;
  /**
   * Ends the pass: the questions still open are left for later, so they no
   * longer block the first change. Then the setup is left.
   */
  onFinish?: (open: GuidedQuestion[]) => void;
  /** Leaves the setup, finished or not. */
  onClose: () => void;
}

const INTRO = [
  'Every agent that writes a proposal, spec or design for this project reads',
  'these first — so it builds on your decisions instead of inventing its own.',
  '',
  '  Domain         what you are building, and for whom — asked first',
  '  Stack          what it is built with',
  '  Architecture   how the code is shaped and which way dependencies point',
  '  Conventions    how the team works on it',
  '',
  'Start with the idea; the rest is proposed from it, marked ⇐ — enter confirms.',
  'Not sure? Press ? (or type "help") for an explanation, examples for your',
  'project, and simpler questions first. Not decided? Skip it (the first',
  'choice, tab, or "skip") — skipped questions are left for later and do not',
  'block the first change. ctrl+f finishes early. Answers are saved as you go.',
];

export function FoundationScreen(props: FoundationScreenProps) {
  const dims = useTerminalDimensions();
  const meta = () => props.meta ?? {};
  const [intro, setIntro] = createSignal(props.questions.every((q) => !q.answered));
  const [cursorId, setCursorId] = createSignal<string | null>(
    (props.questions.find((q) => !q.answered) ?? props.questions[0])?.item.id ?? null,
  );
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [showDone, setShowDone] = createSignal(false);
  /** Skipped this session, so "next" does not come straight back to them. */
  const [skipped, setSkipped] = createSignal<Set<string>>(new Set());
  /** Index into `rows()`. */
  const [sel, setSel] = createSignal(0);
  /** An answer was saved and the advisor is looking at it before moving on. */
  const [waiting, setWaiting] = createSignal<{ token: number; answer: string } | null>(null);
  /** Help was asked for the current question and is on its way. */
  const [helping, setHelping] = createSignal(false);
  /** Set once the developer moves the selection or types; null until then. */
  const [picked, setPicked] = createSignal<Pick | null>(null);
  let token = 0;

  // By id rather than index, so re-reading the files after a save, a follow-up
  // arriving, or an external edit cannot silently move you to another question.
  const index = createMemo(() => {
    const i = props.questions.findIndex((q) => q.item.id === cursorId());
    return i < 0 ? 0 : i;
  });
  const current = createMemo(() => props.questions[index()]);
  const currentMeta = createMemo<QuestionMeta>(() => {
    const q = current();
    return q ? meta()[q.item.id] ?? {} : {};
  });
  /**
   * The options on screen. When new ones arrive for the question being
   * looked at, the one the developer has selected stays, whatever came.
   */
  const shownOptions = createMemo<{ id: string | undefined; list: AdviceOption[] }>((prev) => {
    const id = current()?.item.id;
    const incoming = currentMeta().options ?? [];
    if (!prev || prev.id !== id) return { id, list: incoming };
    const p = untrack(picked);
    return { id, list: mergeOptions(prev.list, incoming, p?.kind === 'option' ? p.label : null) };
  });
  const options = () => shownOptions().list;

  /**
   * The choice list: skipping it, an answer derived from earlier ones, the
   * proposals, asking for help, then writing your own.
   */
  const rows = createMemo<Row[]>(() => {
    // Skip is always there, and always first: the way out of any question.
    const out: Row[] = [{ kind: 'skip' }];
    const derived = current()?.answered ? undefined : currentMeta().derived;
    if (derived) {
      out.push({
        kind: 'option',
        option: { label: derived.answer, detail: derived.reason, recommended: false },
        derived: derived.reason,
      });
    }
    for (const option of options()) {
      if (derived && option.label.toLowerCase() === derived.answer.toLowerCase()) continue;
      out.push({ kind: 'option', option });
    }
    if (props.onHelp) out.push({ kind: 'help' });
    out.push({ kind: 'own' });
    return out;
  });
  const ownRow = createMemo(() => rows().length - 1);
  /** Wide enough for the longest proposal, within reason, so labels line up. */
  const labelWidth = createMemo(() =>
    Math.min(Math.max(...options().map((o) => o.label.length), 12) + 2, Math.floor(dims().width / 2)),
  );
  const hasChoices = createMemo(() => rows().some((r) => r.kind === 'option'));
  const answered = createMemo(() => props.questions.filter((q) => q.answered).length);
  /**
   * Options for this question are on their way: asked for directly, or as
   * part of advising on the answer just given, which proposes them for the
   * next question too.
   */
  const thinkingHere = createMemo(() => {
    const q = current();
    if (!q) return false;
    const thinking = props.thinking ?? [];
    return thinking.includes(q.item.name) || (thinking.length > 0 && !q.answered && !currentMeta().suggested);
  });

  // A question coming on screen is when to ask for its options.
  createEffect(on(() => (intro() ? null : current()?.item.id), () => {
    const q = current();
    if (q && !intro()) props.onShow?.(q);
  }));

  // Start on a derived answer, else the recommendation, else writing your own
  // — never on Skip, which is first in the list but never the default: an
  // enter that skips by accident loses a question. Re-applied when the
  // question changes or advice arrives for it; once the developer has chosen
  // or started typing, their choice is followed to wherever it moved instead.
  createEffect(on(rows, (r) => {
    const p = untrack(picked);
    if (untrack(draft) !== '' || p?.kind === 'own') return setSel(r.length - 1);
    if (p) {
      const i = r.findIndex((x) =>
        x.kind === p.kind && (p.kind !== 'option' || (x.kind === 'option' && x.option.label === p.label)));
      if (i >= 0) return setSel(i);
    }
    const derived = r.findIndex((x) => x.kind === 'option' && x.derived);
    const rec = r.findIndex((x) => x.kind === 'option' && x.option.recommended);
    setSel(derived >= 0 ? derived : rec >= 0 ? rec : r.length - 1);
  }));

  const go = (i: number) => {
    const n = props.questions.length;
    if (n === 0) return;
    // Choices belong to the question they were made on: cleared first, so
    // the next question starts from its own recommendation.
    setPicked(null);
    setDraft('');
    setError(null);
    setWaiting(null);
    setCursorId(props.questions[Math.min(Math.max(i, 0), n - 1)]!.item.id);
  };

  const goTo = (name: string): boolean => {
    const i = props.questions.findIndex((q) => q.item.name === name);
    if (i < 0) return false;
    go(i);
    return true;
  };

  /**
   * The first open question not skipped, in order — not merely the one after
   * this.
   *
   * Follow-ups are inserted straight after the answer that raised them, which
   * is behind the cursor by the time they arrive. Taking the first open one
   * means they come next, which is what "dig deeper" should feel like. A
   * skipped question is never come back to in the same pass: once every
   * question is answered or skipped, the pass is over.
   */
  const advance = () => {
    const qs = props.questions;
    const next = qs.find((q) => !q.answered && !skipped().has(q.item.id) && q.item.id !== cursorId());
    if (next) return go(qs.indexOf(next));
    setShowDone(true);
  };

  /** Still open when the pass ends: what `onFinish` leaves for later. */
  const open = createMemo(() => props.questions.filter((q) => !q.answered));

  const finish = () => {
    if (open().length > 0 && props.onFinish) props.onFinish(open());
    else props.onClose();
  };

  /**
   * Saves, then — with an advisor — stays put while it looks at the answer,
   * so what the answer leaves open is asked now, not after unrelated
   * questions. Enter moves on without waiting; what arrives later still
   * comes up next.
   *
   * Not for a derived answer confirmed as it was proposed: the advisor
   * proposed it knowing everything before it, and a new project confirms
   * several in a row — waiting after each would undo the point of proposing.
   */
  const save = (text: string, confirmed = false) => {
    const q = current();
    if (!q) return;
    const result = props.onAnswer(q, text);
    if (!result.ok) return setError(result.reason);
    setDraft('');
    setError(null);
    if (!result.advice || confirmed) return advance();
    // The preset table already knows what this answer leaves open: go there
    // now. The advisor's own follow-ups still arrive, and come up in order.
    if (result.presets?.[0] && goTo(result.presets[0])) return;

    const mine = ++token;
    setWaiting({ token: mine, answer: text });
    const settle = (added: string[]) => {
      if (waiting()?.token !== mine) return; // moved on without waiting
      setWaiting(null);
      if (!(added[0] && goTo(added[0]))) advance();
    };
    result.advice.then(({ added }) => settle(added), () => settle([]));
  };

  const help = () => {
    const q = current();
    if (!q) return;
    if (!props.onHelp) {
      return setError(
        props.advisorNote
          ? `AI help is off (${props.advisorNote}). Type what you know, or tab to skip.`
          : 'Type what you know, or tab to skip.',
      );
    }
    setDraft('');
    setError(null);
    setHelping(true);
    props.onHelp(q).then(
      ({ probes }) => {
        setHelping(false);
        // Simpler questions first: they come before this one, so answering
        // them walks straight back here — often with an answer derived.
        if (probes[0]) goTo(probes[0]);
      },
      () => setHelping(false),
    );
  };

  const submit = () => {
    const q = current();
    if (!q) return;
    const text = draft().trim();
    const word = text.toLowerCase().replace(/[.!]+$/, '');
    if (SKIP_WORDS.has(word)) {
      setDraft('');
      return skip();
    }
    if (DONE_WORDS.has(word)) {
      setDraft('');
      return setShowDone(true);
    }
    if (HELP_WORDS.has(word)) return help();
    if (text !== '') return save(text);

    const row = rows()[sel()];
    if (row?.kind === 'skip') return skip();
    if (row?.kind === 'option') return save(row.option.label, row.derived !== undefined);
    if (row?.kind === 'help') return help();
    if (q.answered) return advance();
    // Enter on nothing, with nothing chosen, most often means "I don't know".
    if (props.onHelp) return help();
    setError('Type an answer, or press tab (or type "skip") to leave it for now');
  };

  const skip = () => {
    const q = current();
    if (q) setSkipped((s) => new Set(s).add(q.item.id));
    advance();
  };

  useKeyboard((key) => {
    if (intro()) {
      if (isEnter(key)) setIntro(false);
      else if (isCancel(key)) props.onClose();
      return;
    }
    if (showDone()) {
      if (isEnter(key)) finish();
      else if (isCancel(key)) props.onClose();
      else if (key.name === 'left' || key.name === 'up') {
        setShowDone(false);
        go(props.questions.length - 1);
      }
      return;
    }

    if (waiting()) {
      if (isEnter(key) || key.name === 'tab') {
        setWaiting(null);
        advance();
      } else if (isCancel(key)) props.onClose();
      return;
    }

    if (isCancel(key)) return props.onClose();
    if (key.ctrl && key.name === 'f') return setShowDone(true);
    if (helping()) return;
    if (isEnter(key)) return submit();
    if (key.name === 'tab') return skip();
    if (key.sequence === '?' && draft() === '') return help();
    if (key.name === 'left') return go(index() - 1);
    if (key.name === 'right') return go(index() + 1);
    if (key.name === 'up' || key.name === 'down') {
      const n = rows().length;
      setSel((s) => (s + (key.name === 'up' ? -1 : 1) + n) % n);
      setPicked(pickOf(rows()[sel()]));
      return;
    }
    if (key.ctrl && key.name === 'e') {
      const q = current();
      if (q) props.onEdit(q);
      return;
    }
    if (key.ctrl && key.name === 'd') {
      const q = current();
      if (q && (currentMeta().parent || currentMeta().helps)) props.onDismiss?.(q);
      return;
    }

    const next = editLine(draft(), key);
    if (next !== null) {
      setDraft(next);
      setError(null);
      // Typing is choosing to write your own.
      setSel(ownRow());
      setPicked({ kind: 'own' });
    }
  });

  /** Per section: one dot per question, so progress reads at a glance. */
  const sections = createMemo(() => {
    const out: { title: string; dots: { answered: boolean; current: boolean }[] }[] = [];
    for (const q of props.questions) {
      let s = out.find((x) => x.title === q.title);
      if (!s) out.push((s = { title: q.title, dots: [] }));
      s.dots.push({ answered: q.answered, current: q.item.id === current()?.item.id });
    }
    return out;
  });

  const keys = createMemo((): [string, string][] => {
    if (waiting()) return [['enter', 'continue without waiting'], ['ctrl+c', 'back']];
    const k: [string, string][] = [['↑↓', 'choose']];
    const row = rows()[sel()]?.kind;
    k.push(['enter', draft() ? 'save' : row === 'skip' ? 'skip' : row === 'option' ? 'pick' : current()?.answered ? 'keep' : 'save']);
    if (props.onHelp) k.push(['?', 'not sure']);
    k.push(['tab', 'skip'], ['←→', 'questions'], ['ctrl+e', 'editor']);
    if (currentMeta().parent || currentMeta().helps) k.push(['ctrl+d', 'not relevant']);
    k.push(['ctrl+f', 'done — rest later'], ['ctrl+c', 'back']);
    return k;
  });

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <Show when={intro()}>
        <box style={{ flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Panel title="Ground rules" width={82}>
            <text>{' '}</text>
            <text style={{ fg: THEME.accent }}>Before the first change, settle the ground rules.</text>
            <text>{' '}</text>
            <For each={INTRO}>
              {(line) => <text style={{ fg: THEME.text }}>{line || ' '}</text>}
            </For>
            <text>{' '}</text>
            <text style={{ fg: props.advisorNote ? THEME.dim : THEME.accent2 }}>
              {props.advisorNote
                ? `AI suggestions are off: ${props.advisorNote}.`
                : '✦ An AI assistant digs deeper where an answer leaves something open,'}
            </text>
            <Show when={!props.advisorNote}>
              <text style={{ fg: THEME.accent2 }}>
                {'  and proposes options with a recommendation. You always choose.'}
              </text>
            </Show>
            <text>{' '}</text>
            <box style={{ flexDirection: 'row' }}>
              <Button label={`▶ Begin — ${props.questions.length} questions`} focused onPress={() => setIntro(false)} />
            </box>
          </Panel>
        </box>
        <KeyBar keys={[['enter', 'begin'], ['ctrl+c', 'back']]} />
      </Show>

      <Show when={!intro() && showDone()}>
        <box style={{ flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Panel title="Ground rules" width={72}>
            <text>{' '}</text>
            <Show
              when={open().length > 0}
              fallback={
                <text style={{ fg: THEME.ok }}>
                  {`✓ All ${props.questions.length} ground rules are answered.`}
                </text>
              }
            >
              <text style={{ fg: THEME.ok }}>
                {`✓ ${props.questions.length - open().length} of ${props.questions.length} ground rules answered.`}
              </text>
              <text style={{ fg: THEME.text }}>
                {`${open().length} ${open().length === 1 ? 'is' : 'are'} left for later — open, but not blocking the first change.`}
              </text>
            </Show>
            <text>{' '}</text>
            <text style={{ fg: THEME.text }}>
              They live in spec-tacular/foundation/ and go into every agent's context.
            </text>
            <text style={{ fg: THEME.text }}>
              Change one any time with f from the overview, or by editing the file.
            </text>
            <text>{' '}</text>
            <box style={{ flexDirection: 'row' }}>
              <Button label="▶ Continue" focused onPress={finish} />
            </box>
          </Panel>
        </box>
        <KeyBar keys={[['enter', 'continue'], ['←', 'revisit an answer'], ['ctrl+c', 'back']]} />
      </Show>

      <Show when={!intro() && !showDone() && current()}>
        {/* Progress, per section */}
        <Panel title="Ground rules">
          <box style={{ flexDirection: 'row' }}>
            <For each={sections()}>
              {(s) => (
                <box style={{ flexDirection: 'row', marginRight: 3 }}>
                  <text style={{ fg: s.dots.some((d) => d.current) ? THEME.accent : THEME.text }}>
                    {`${s.title} `}
                  </text>
                  <For each={s.dots}>
                    {(d) => (
                      <text style={{ fg: d.current ? THEME.accent : d.answered ? THEME.ok : THEME.dim }}>
                        {d.current ? '◆' : d.answered ? '●' : '○'}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
            <box style={{ flexGrow: 1 }} />
            <text style={{ fg: THEME.dim }}>{`${answered()}/${props.questions.length}`}</text>
          </box>
        </Panel>

        {/* The question */}
        <Panel
          title={`${current()!.title}${current()!.purpose ? ` · ${current()!.purpose}` : ''}`}
          focused
        >
          <text>{' '}</text>
          <text style={{ fg: THEME.accent }}>
            <strong>{current()!.item.name}</strong>
          </text>
          <Show when={currentMeta().parent}>
            <text style={{ fg: THEME.accent2 }}>
              {`${currentMeta().preset ? '◇' : '✦'} follow-up to “${currentMeta().parent}”${currentMeta().why ? ` — ${currentMeta().why}` : ''}`}
            </text>
          </Show>
          <Show when={currentMeta().helps}>
            <text style={{ fg: THEME.accent2 }}>
              {`✦ a simpler question, to help decide “${currentMeta().helps}”`}
            </text>
          </Show>
          <Show when={!currentMeta().parent && !currentMeta().helps && current()!.hint}>
            <For each={wrap(current()!.hint, 90)}>
              {(line) => <text style={{ fg: THEME.dim }}>{line}</text>}
            </For>
          </Show>
          <Show when={currentMeta().explain}>
            <text>{' '}</text>
            <For each={wrap(`💡 ${currentMeta().explain}`, 100)}>
              {(line) => <text style={{ fg: THEME.text }}>{line}</text>}
            </For>
          </Show>
          <text>{' '}</text>

          <Show when={current()!.answered}>
            <box style={{ flexDirection: 'row' }}>
              <text style={{ fg: THEME.ok }}>✓ Current answer: </text>
              <text style={{ fg: THEME.text }}>
                {wrap(current()!.item.text, 70)[0] ?? ''}
              </text>
            </box>
            <text>{' '}</text>
          </Show>

          {/* After an answer: looking at it before moving on */}
          <Show when={waiting()}>
            <box style={{ flexDirection: 'row' }}>
              <text style={{ fg: THEME.ok }}>✓ Saved: </text>
              <text style={{ fg: THEME.text }}>{clip(waiting()!.answer, 80)}</text>
            </box>
            <text>{' '}</text>
            <Spinner label="Looking at your answer — does it leave anything open? It may also answer later questions." />
            <text style={{ fg: THEME.dim }}>{'  enter continues without waiting'}</text>
          </Show>

          <Show when={!waiting() && helping()}>
            <Spinner label="Working out how to help — an explanation, examples, and simpler questions…" />
            <text>{' '}</text>
          </Show>

          <Show when={!waiting()}>
          {/* The choices — one line each, so the list reads as a menu */}
          <For each={rows()}>
            {(row, i) => (
              <box
                onMouseDown={() => {
                  if (row.kind === 'skip') skip();
                  else if (row.kind === 'option') save(row.option.label, row.derived !== undefined);
                  else if (row.kind === 'help') help();
                  else {
                    setSel(i());
                    setPicked({ kind: 'own' });
                  }
                }}
                style={{
                  flexDirection: 'row',
                  backgroundColor: sel() === i() ? THEME.highlight : THEME.panel,
                }}
              >
                <text style={{ fg: THEME.accent, width: 3, flexShrink: 0 }}>
                  {sel() === i() ? ' ▸ ' : '   '}
                </text>
                {/* A derived answer is usually a sentence: its own full line, reason below */}
                <Show when={row.kind === 'option' && (row as { derived?: string }).derived}>
                  <box style={{ flexDirection: 'column', flexGrow: 1 }}>
                    <text style={{ fg: sel() === i() ? THEME.accent : THEME.text }}>
                      {`⇐ ${clip((row as { option: AdviceOption }).option.label, Math.max(dims().width - 12, 20))}`}
                    </text>
                    <text style={{ fg: THEME.accent2 }}>
                      {`  ${clip(`from your earlier answers: ${(row as { derived: string }).derived}`, Math.max(dims().width - 12, 20))}`}
                    </text>
                  </box>
                </Show>
                <Show when={row.kind === 'option' && !(row as { derived?: string }).derived}>
                  <text style={{ fg: sel() === i() ? THEME.accent : THEME.text, width: labelWidth(), flexShrink: 0 }}>
                    {clip((row as { option: AdviceOption }).option.label, labelWidth() - 1)}
                  </text>
                  <text style={{ fg: THEME.warn, width: 3, flexShrink: 0 }}>
                    {(row as { option: AdviceOption }).option.recommended ? '★ ' : '  '}
                  </text>
                  <text style={{ fg: THEME.dim, flexGrow: 1 }}>
                    {clip((row as { option: AdviceOption }).option.detail, Math.max(dims().width - labelWidth() - 14, 20))}
                  </text>
                </Show>
                <Show when={row.kind === 'skip'}>
                  <text style={{ fg: sel() === i() ? THEME.accent : THEME.dim }}>
                    ↷ Skip — leave it for later
                  </text>
                </Show>
                <Show when={row.kind === 'help'}>
                  <text style={{ fg: sel() === i() ? THEME.accent : THEME.accent2 }}>
                    ? I'm not sure — explain it, show examples, ask me simpler questions
                  </text>
                </Show>
                <Show when={row.kind === 'own'}>
                  <text style={{ fg: sel() === i() ? THEME.accent : THEME.text }}>
                    {hasChoices() ? '✎ Write my own answer' : '✎ Write my answer'}
                  </text>
                </Show>
              </box>
            )}
          </For>
          <Show when={thinkingHere() && !hasChoices()}>
            <Spinner label="looking for options…" />
          </Show>
          <Show when={hasChoices()}>
            <text style={{ fg: THEME.dim }}>
              {`   ${[
                ...(rows().some((r) => r.kind === 'option' && r.derived) ? ['⇐ derived from earlier answers'] : []),
                '★ recommended',
                // Instant, from the preset table: the advisor may still refine them.
                ...(currentMeta().preset && options().length > 0
                  ? [thinkingHere() ? '◇ instant suggestions, AI refining…' : '◇ instant suggestions']
                  : []),
                '↑↓ or click to choose',
              ].join(' · ')}`}
            </text>
          </Show>
          <text>{' '}</text>

          {/* Your own answer */}
          <box
            style={{
              border: true,
              borderStyle: 'rounded',
              borderColor: sel() === ownRow() ? THEME.accent : THEME.border,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: 'column',
            }}
          >
            <Show
              when={draft()}
              fallback={
                <text style={{ fg: THEME.dim }}>
                  {sel() === ownRow()
                    ? '› ▏type your answer — or "skip", or "?" if you are not sure'
                    : '› or type your own answer…'}
                </text>
              }
            >
              <For each={wrap(`${draft()}▏`, 88)}>
                {(line, i) => (
                  <text style={{ fg: THEME.text }}>{`${i() === 0 ? '› ' : '  '}${line}`}</text>
                )}
              </For>
            </Show>
          </box>
          <Show when={error()}>
            <text style={{ fg: THEME.warn }}>{error()}</text>
          </Show>
          </Show>
        </Panel>

        <box style={{ flexGrow: 1 }} />

        {/* What the advisor is doing */}
        <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1, height: 1 }}>
          <Show
            when={(props.thinking ?? []).length > 0}
            fallback={
              <text style={{ fg: props.notice ? THEME.accent2 : THEME.dim }}>
                {props.notice ?? (props.advisorNote ? `AI suggestions off: ${props.advisorNote}` : '')}
              </text>
            }
          >
            <Spinner label={`AI is thinking about “${(props.thinking ?? []).at(-1)}”…`} />
          </Show>
        </box>
        <KeyBar keys={keys()} />
      </Show>
    </box>
  );
}
