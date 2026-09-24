/**
 * The TUI shell.
 *
 * Two regions never leave the screen — the pipeline bar and the status line —
 * because "always visible" is the requirement this exists to meet
 * (docs/tui-design.md, "The constant frame").
 *
 * Kept thin: all derivation lives in core/, which is why the review loop's
 * behaviour is tested without a terminal and the screens only draw.
 */

import { createCliRenderer } from '@opentui/core';
import { render, useKeyboard, useRenderer } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { staleArtifacts } from '../core/gate.ts';
import type { ChangePipeline, Stage, StageState } from '../core/pipeline.ts';
import {
  decide,
  move as moveCursor,
  refresh,
  skip as skipItem,
  type ReviewSession,
} from '../core/session.ts';
import { isRequirement, type ReviewItem } from '../core/requirements.ts';
import { currentItem } from '../core/session.ts';
import { openInEditor } from './editor.ts';
import { JobPane, summarizeJobs } from './jobs.tsx';
import { ReviewScreen } from './review.tsx';
import { THEME } from './theme.ts';
import type { Job } from '../core/jobs.ts';
import { lintRequirement, type LintConfig } from '../core/concreteness.ts';
import { markExampleInFile } from '../core/mark.ts';
import type { Decision } from '../core/decisions.ts';
import { DEFERRED, type GuidedQuestion } from '../core/foundation.ts';
import {
  nextStep,
  setupStep,
  setupSteps,
  validateChangeName,
  type NextStep,
  type ProjectStage,
} from '../core/guide.ts';
import type { FollowUp, QuestionMeta } from '../core/advisor.ts';
import { FoundationScreen, type AnswerResult } from './foundation.tsx';
import { nameFromDescription } from '../core/naming.ts';
import type { Roadmap, Slice } from '../core/roadmap.ts';
import { sliceDescription, type ProposedSlice, type VisionSession } from '../core/vision.ts';
import { DocumentView, type DocumentAction } from './document.tsx';
import { VisionScreen } from './vision.tsx';
import { FirstChangeGuide, HelpOverlay, Stepper } from './guide.tsx';
import { HomeScreen, type HomeAction } from './home.tsx';
import { editLine, isCancel, isEnter } from './input.ts';
import { Button, clip, KeyBar, Panel, shortPath, Spinner } from './widgets.tsx';
import { wrap } from '../render/requirement.ts';
import { acceptRefinement, readRequirementBlock, type Refinement, type RefineTurn } from '../core/refine.ts';
import type { Requirement } from '../core/requirements.ts';
import type { RefinePort } from './review.tsx';
import { osc52, SystemClipboard, type ClipboardPort } from './clipboard.ts';
import { ClipboardProvider, usePasteInto, useSelectionCopy, type ClipboardContextValue } from './copy-paste.ts';

export interface TuiInput {
  pipelines: ChangePipeline[];
  failed: string[];
  root: string;
  /** Opens a change's review queue, or null when it has no specs yet. */
  openReview: (change: string) => ReviewSession | null;
  /** Persists a session's decisions and cursor. */
  saveSession: (session: ReviewSession) => void;
  /** Re-parses a change's specs, for after an external edit. */
  reparse: (change: string) => ReviewItem[];
  /** Per-project linter tuning. */
  lintConfig: LintConfig;
  /** Recomputes the overview after review changed something. */
  reloadPipelines: () => Promise<ChangePipeline[]>;
  /** Background jobs, re-read each time the pane opens. */
  listJobs: () => Job[];
  /** Rendered log lines for one job. */
  tailJob: (job: Job) => string[];
  cancelJob: (job: Job) => void;
  /** Lifts a global design decision to a project-wide ADR. */
  promote: (change: string, decision: Decision) => { ok: true; adr: string } | { ok: false; reason: string };
  /** Where the project is in getting started, re-derived from disk. */
  stage: () => ProjectStage;
  /** Makes the folder a spec-tacular project: OpenSpec, schema, Foundation. */
  setup: () => Promise<Result>;
  /** The Foundation questions in the order the setup asks them. */
  questions: () => GuidedQuestion[];
  answer: (question: GuidedQuestion, text: string) => Result;
  createChange: (name: string, description: string) => Promise<Result>;
  /** Starts an agent on one artifact in the background, behind the gate. */
  dispatch: (change: string, artifact: string, feedback?: string) => Promise<{ ok: boolean; message: string }>;
  /** A written, single-file artifact's content, for reading it in full. */
  readArtifact?: (change: string, artifact: string) => Promise<{ ok: true; file: string; content: string } | { ok: false; reason: string }>;
  /** The vision interview, for a project that starts from nothing. */
  vision?: VisionPort | null;
  /** Whether the project starts from nothing — no baseline specs yet. */
  greenfield?: () => boolean;
  roadmap?: () => Roadmap | null;
  /** The file to write an artifact in by hand, created from its template if new. */
  artifactFile: (change: string, artifact: string) => Promise<{ ok: true; file: string } | { ok: false; reason: string }>;
  /** The AI that proposes options and follow-ups during setup, if one is available. */
  advisor?: Advisor | null;
  /** Why there is no advisor, shown instead of suggestions. */
  advisorNote?: string | null;
  /** Proposes names for a change from its description, best first. */
  nameChange?: (description: string, taken: string[]) => Promise<string[]>;
  /**
   * Starts the AI sessions a screen is about to need, so its first question
   * does not wait for an agent to start. Optional, and free until asked.
   */
  warm?: (screen: 'foundation' | 'vision' | 'naming' | 'review') => void;
  /** Revising one requirement with the agent, from the review screen. */
  refine?: {
    /** Why there is no agent to revise with, or null when there is one. */
    unavailable: string | null;
    propose: (change: string, item: Requirement, turns: RefineTurn[], instruction: string) => Promise<Refinement>;
  };
  /** The system clipboard; tests pass their own so they never touch the real one. */
  clipboard?: ClipboardPort;
}

/** What the TUI needs from core/vision.ts. */
export interface VisionPort {
  /** Why there is no interview, or null when there is one. */
  unavailable: string | null;
  session: () => VisionSession | null;
  start: (vision: string) => Promise<VisionSession>;
  answer: (text: string | null) => Promise<VisionSession>;
  finish: () => VisionSession;
  resume: () => Promise<VisionSession>;
  extract: (taken: string[]) => Promise<unknown>;
  skip: () => void;
  /** Writes the vision and roadmap; returns the slice to start with. */
  confirm: (vision: string, kept: ProposedSlice[]) => Slice | null;
}

/** What the TUI needs from core/advisor.ts's FoundationAdvisor. */
export interface Advisor {
  meta: () => Record<string, QuestionMeta>;
  afterAnswer: (question: GuidedQuestion, answer: string) => Promise<{ added: FollowUp[]; derived: string[] }>;
  suggest: (question: GuidedQuestion) => Promise<void>;
  /** Instant follow-ups from the preset table, by name; no model involved. */
  presets?: (question: GuidedQuestion, answer: string) => string[];
  coach: (question: GuidedQuestion) => Promise<{ explain: string; probes: FollowUp[] }>;
  dismiss: (question: GuidedQuestion) => boolean;
}

type Result = { ok: true } | { ok: false; reason: string };

type Screen = 'home' | 'foundation' | 'vision' | 'overview' | 'document';

/** An artifact open for reading. */
interface OpenDocument {
  change: string;
  artifact: string;
  file: string;
  content: string;
}

const STAGE_COLOR: Record<StageState, string> = {
  accepted: THEME.ok,
  written: THEME.text,
  ready: THEME.accent,
  blocked: THEME.dim,
};

const STAGE_MARK: Record<StageState, string> = {
  accepted: '✓',
  written: '●',
  ready: '◉',
  blocked: '○',
};

function PipelineBar(props: { pipeline: ChangePipeline | undefined }) {
  const stages = (): Stage[] => {
    const p = props.pipeline;
    return p ? [...p.stages, p.apply] : [];
  };

  return (
    <box style={{ flexDirection: 'row' }}>
      <Show when={props.pipeline === undefined}>
        <text style={{ fg: THEME.dim }}>no change selected</text>
      </Show>
      <For each={stages()}>
        {(stage, i) => (
          <box style={{ flexDirection: 'row' }}>
            <text style={{ fg: STAGE_COLOR[stage.state] }}>
              {`${STAGE_MARK[stage.state]} ${stage.id}`}
            </text>
            <Show when={i() < stages().length - 1}>
              <text style={{ fg: THEME.border }}>{' ── '}</text>
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}

function ChangeRow(props: { pipeline: ChangePipeline; selected: boolean; onPick: () => void }) {
  const specs = () => props.pipeline.stages.find((s) => s.review)?.review;
  const warn = () =>
    (specs()?.drifted ?? 0) > 0 ||
    staleArtifacts(props.pipeline).length > 0 ||
    props.pipeline.gaps.length > 0;
  return (
    <box
      onMouseDown={props.onPick}
      style={{
        flexDirection: 'row',
        backgroundColor: props.selected ? THEME.highlight : THEME.panel,
      }}
    >
      <text style={{ fg: props.selected ? THEME.accent : THEME.text, flexGrow: 1 }}>
        {`${props.selected ? '▸' : ' '} ${props.pipeline.name}`}
      </text>
      <Show when={warn()}>
        <text style={{ fg: THEME.warn }}>{'! '}</text>
      </Show>
      <text style={{ fg: specs()?.complete ? THEME.ok : THEME.dim }}>
        {specs() ? `${specs()!.accepted}/${specs()!.total}` : `${props.pipeline.written}/${props.pipeline.total}`}
      </text>
    </box>
  );
}

/** What is worth flagging about the selected change, beyond its next step. */
function changeWarnings(p: ChangePipeline): string[] {
  const out: string[] = [];
  const specs = p.stages.find((s) => s.review)?.review;
  if ((specs?.drifted ?? 0) > 0) out.push(`${specs!.drifted} requirement(s) changed since you accepted them`);
  const stale = staleArtifacts(p);
  if (stale.length > 0) out.push(`${stale.map((s) => s.artifact).join(', ')} may be stale`);
  if (p.gaps.length > 0) out.push(`${p.gaps.length} artifact(s) written before their prerequisite`);
  return out;
}

function App(props: { input: TuiInput; onQuit: () => void }) {
  const renderer = useRenderer();
  const advisor = props.input.advisor ?? null;
  const [pipelines, setPipelines] = createSignal(props.input.pipelines);
  const [index, setIndex] = createSignal(0);
  const [session, setSession] = createSignal<ReviewSession | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [jobs, setJobs] = createSignal<Job[]>(props.input.listJobs());
  const [jobIndex, setJobIndex] = createSignal(0);
  const [jobsOpen, setJobsOpen] = createSignal(false);
  const [stage, setStage] = createSignal<ProjectStage>(props.input.stage());
  const [screen, setScreen] = createSignal<Screen>('home');
  const [questions, setQuestions] = createSignal<GuidedQuestion[]>(props.input.questions());
  const [help, setHelp] = createSignal(false);
  /**
   * The new-change prompt: what it should do first, then a name proposed from
   * that — the name is the least important question, so it comes last.
   */
  const [asking, setAsking] = createSignal<'describe' | 'name' | null>(null);
  const [draft, setDraft] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [names, setNames] = createSignal<string[]>([]);
  const [nameEdited, setNameEdited] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [homeBusy, setHomeBusy] = createSignal<string | null>(null);
  const [homeError, setHomeError] = createSignal<string | null>(null);
  /** Focused action button in the change panel. */
  const [actionFocus, setActionFocus] = createSignal(0);
  const [doc, setDoc] = createSignal<OpenDocument | null>(null);
  const vision = props.input.vision ?? null;
  const [visionSession, setVisionSession] = createSignal<VisionSession | null>(vision?.session() ?? null);
  const [visionBusy, setVisionBusy] = createSignal<string | null>(null);
  const [visionError, setVisionError] = createSignal<string | null>(null);
  const [roadmap, setRoadmap] = createSignal<Roadmap | null>(props.input.roadmap?.() ?? null);

  // The advisor's state: what it has proposed, and what it is working on.
  const [meta, setMeta] = createSignal<Record<string, QuestionMeta>>(advisor?.meta() ?? {});
  const [thinking, setThinking] = createSignal<string[]>([]);
  const [adviceNotice, setAdviceNotice] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal<GuidedQuestion | null>(null);
  /** Questions whose advice failed this session. */
  const failed = new Set<string>();

  // --- copy and paste -------------------------------------------------------

  /** A short status in the corner — "Copied …" — that clears itself. */
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(toastTimer));
  const clipboard: ClipboardContextValue = {
    clipboard:
      props.input.clipboard ??
      new SystemClipboard({
        // The renderer knows whether the terminal takes OSC 52; when it does
        // not know, the sequence is sent anyway — a terminal that does not
        // understand it ignores it.
        osc52: (text) => {
          if (renderer.copyToClipboardOSC52(text)) return true;
          if (!process.stdout.isTTY) return false;
          process.stdout.write(osc52(text));
          return true;
        },
      }),
    notify: (message) => {
      setToast(message);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setToast(null), 2500);
    },
  };
  useSelectionCopy(clipboard);

  const selected = () => pipelines()[index()];
  const inReview = createMemo(() => session() !== null && !jobsOpen());
  const greenfield = createMemo(() => {
    stage(); // re-derived whenever the stage moves
    return props.input.greenfield?.() ?? false;
  });
  const step = createMemo(() => setupStep(stage(), greenfield()));
  const foundationSettled = createMemo(() => stage().kind !== 'foundation');
  const next = createMemo<NextStep | null>(() => {
    const p = selected();
    return p ? nextStep(p, foundationSettled()) : null;
  });

  const selectedJob = createMemo(() => jobs()[jobIndex()]);
  const jobLines = createMemo(() => {
    const job = selectedJob();
    return job ? props.input.tailJob(job) : [];
  });

  const refreshFoundation = () => {
    setQuestions(props.input.questions());
    setStage(props.input.stage());
    setRoadmap(props.input.roadmap?.() ?? null);
    if (advisor) setMeta(advisor.meta());
  };

  /** Re-derives everything a first run moves through, after any step. */
  const reload = async (select?: string) => {
    try {
      const fresh = await props.input.reloadPipelines();
      setPipelines(fresh);
      if (select) {
        const i = fresh.findIndex((p) => p.name === select);
        if (i >= 0) setIndex(i);
      } else {
        setIndex((i) => Math.min(i, Math.max(fresh.length - 1, 0)));
      }
    } catch (err) {
      setNotice((err as Error).message);
    }
    refreshFoundation();
  };

  // --- the advisor, in the background ------------------------------------

  /**
   * Runs one advisor request, labelled by the question it is about.
   *
   * Failures become a line on screen, never an error: setup works without
   * the advisor, so losing it must never interrupt answering.
   */
  const track = <T,>(label: string, work: () => Promise<T>, id?: string): Promise<T> => {
    setThinking((t) => [...t, label]);
    const running = work();
    void running
      .catch((err: Error) => {
        // Not retried automatically: a failure that repeats (no network, no
        // credit) would otherwise re-ask for as long as the question is shown.
        if (id) failed.add(id);
        setAdviceNotice(`AI suggestions failed: ${err.message}`);
      })
      .finally(() => {
        setThinking((t) => t.filter((x) => x !== label));
        refreshFoundation();
        // Whatever is on screen now may have been waiting for this to finish.
        const q = shown();
        if (q) maybeSuggest(q);
      });
    return running;
  };

  /**
   * Options for a question, when it is shown and nobody has asked yet.
   *
   * Held back while any request is in flight: the answer just given is being
   * advised on together with options for the question after it, and asking
   * twice would pay twice for the same thing.
   */
  const maybeSuggest = (q: GuidedQuestion) => {
    if (!advisor || q.answered || thinking().length > 0 || failed.has(q.item.id)) return;
    const current = props.input.questions().find((x) => x.item.id === q.item.id);
    if (!current || current.answered || advisor.meta()[q.item.id]?.suggested) return;
    void track(q.item.name, () => advisor.suggest(current), q.item.id).catch(() => {});
  };

  const onAnswer = (q: GuidedQuestion, text: string): AnswerResult => {
    const result = props.input.answer(q, text);
    refreshFoundation();
    if (!result.ok || !advisor) return result;
    setAdviceNotice(null);
    // What the tables know — follow-ups, options, what an architecture style
    // decides — is on screen now; the advisor refines it after.
    const presets = advisor.presets?.(q, text) ?? [];
    refreshFoundation();
    const advice = track(q.item.name, async () => {
      const { added, derived } = await advisor.afterAnswer(q, text);
      const parts: string[] = [];
      if (added.length > 0) parts.push(`${added.length} follow-up${added.length === 1 ? '' : 's'} on “${q.item.name}”`);
      if (derived.length > 0) parts.push(`${derived.length} later answer${derived.length === 1 ? '' : 's'} derived — confirm when you get there`);
      if (parts.length > 0) setAdviceNotice(`✦ ${parts.join(' · ')}`);
      // Re-read before resolving: the screen moves to the new questions as
      // soon as this settles, so they must already be in its list.
      refreshFoundation();
      return { added: added.map((f) => f.ask) };
    });
    return { ...result, advice, presets };
  };

  // Sessions start while the developer reads the screen, not on the first
  // question — and for a project that still has to be set up, already while
  // the start screen is read: by the first answer, the advisor has started
  // and read its instructions, and that answer costs one short model turn.
  // Warming twice is free, so both the stage and the screen may ask.
  createEffect(on(stage, (s) => {
    if (s.kind === 'no-openspec' || s.kind === 'no-foundation' || s.kind === 'foundation') {
      props.input.warm?.('foundation');
    } else if (s.kind === 'vision') props.input.warm?.('vision');
  }));
  createEffect(on(screen, (s) => {
    if (s === 'foundation' || s === 'vision') props.input.warm?.(s);
  }));
  createEffect(on(asking, (a) => {
    if (a === 'describe' && props.input.nameChange) props.input.warm?.('naming');
  }));

  const onHelp = (q: GuidedQuestion) =>
    track(q.item.name, async () => {
      const { probes } = await advisor!.coach(q);
      setAdviceNotice(
        probes.length > 0
          ? `✦ ${probes.length} simpler question${probes.length === 1 ? '' : 's'} first, to help decide “${q.item.name}”`
          : `✦ Examples for “${q.item.name}” are listed — pick one or adapt it`,
      );
      refreshFoundation();
      return { probes: probes.map((f) => f.ask) };
    });

  // --- jobs ---------------------------------------------------------------

  /**
   * Re-reads from disk every time the pane opens.
   *
   * Jobs are spawned detached and record their own outcome, so the in-memory
   * list goes stale the moment one finishes — and a pane showing a job as
   * still running long after it stopped is worse than no pane.
   */
  const openJobs = () => {
    setJobs(props.input.listJobs());
    setJobIndex((i) => Math.min(Math.max(i, 0), Math.max(props.input.listJobs().length - 1, 0)));
    setJobsOpen(true);
  };

  // While an agent runs, watch for it finishing: its artifact changes what
  // the next step is, and making you restart to find out defeats the point of
  // running it in the background.
  const poll = setInterval(() => {
    const before = jobs();
    if (!before.some((j) => j.status === 'running')) return;
    const after = props.input.listJobs();
    setJobs(after);
    const finished = after.filter(
      (j) => j.status !== 'running' && before.find((b) => b.id === j.id)?.status === 'running',
    );
    if (finished.length === 0) return;
    const last = finished[finished.length - 1]!;
    setNotice(
      last.status === 'succeeded'
        ? `✦ The ${last.artifact} of ${last.change} is drafted`
        : `${last.change}/${last.artifact} ${last.status} — ctrl+j shows its log`,
    );
    void reload().then(() => {
      // Exit 0 is not proof of work: an agent can finish without writing the
      // file (denied, confused, out of turns). Say so rather than showing the
      // same next step again as if nothing had happened.
      const stage = pipelines().find((p) => p.name === last.change)?.stages.find((s) => s.id === last.artifact);
      if (last.status === 'succeeded' && stage && (stage.state === 'ready' || stage.state === 'blocked')) {
        setNotice(`The agent finished but did not write the ${last.artifact} — ctrl+j shows what it did`);
        return;
      }
      // What was drafted is what you want to see next — unless you are busy
      // with something else, in which case it waits behind its button.
      const idle = screen() === 'overview' && session() === null && !jobsOpen() && asking() === null;
      if (last.status === 'succeeded' && idle && selected()?.name === last.change) {
        void openDoc(last.change, last.artifact, true);
      }
    });
  }, 2000);
  onCleanup(() => clearInterval(poll));

  // --- drafts ---------------------------------------------------------------

  /** The agent working on the selected change right now, if any. */
  const running = createMemo(() =>
    jobs().find((j) => j.status === 'running' && j.change === selected()?.name) ?? null,
  );
  /** Its latest output, re-read whenever the job list is polled. */
  const runningLines = createMemo(() => {
    const job = running();
    return job ? props.input.tailJob(job).filter((l) => l.trim() !== '').slice(-8) : [];
  });
  const elapsed = createMemo(() => {
    const job = running();
    if (!job) return '';
    jobs(); // ticks with the poll
    const secs = Math.max(Math.round((Date.now() - Date.parse(job.startedAt)) / 1000), 0);
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
  });

  /** Prose artifacts written for the selected change: what can be read. */
  const readable = createMemo(() => {
    const p = selected();
    if (!p || !props.input.readArtifact) return [];
    return p.stages.filter((st) => st.state !== 'ready' && st.state !== 'blocked' && !st.review).map((st) => st.id);
  });

  const openDoc = async (change: string, artifact: string, justDrafted = false) => {
    if (!props.input.readArtifact) return;
    const result = await props.input.readArtifact(change, artifact);
    if (!result.ok) {
      if (!justDrafted) setNotice(result.reason);
      return;
    }
    setDoc({ change, artifact, file: result.file, content: result.content });
    setScreen('document');
  };

  const closeDoc = () => {
    setDoc(null);
    setScreen('overview');
  };

  /** What reading a document offers: move on first, then change it. */
  const docActions = createMemo((): DocumentAction[] => {
    const d = doc();
    if (!d) return [];
    const out: DocumentAction[] = [];
    const step = next();
    if (step?.actions.includes('draft') && step.artifact && step.artifact !== d.artifact) {
      out.push({
        label: step.artifact === 'apply'
          ? '✓ Looks good — start implementing'
          : `✓ Looks good — draft the ${step.artifact}`,
        key: 'n',
        run: () => { closeDoc(); void draftNext(); },
      });
    } else {
      out.push({ label: '✓ Looks good', key: 'n', run: closeDoc });
    }
    out.push({
      label: '✎ Edit it',
      key: 'e',
      run: () => {
        const opened = openInEditor(renderer, d.file, 1);
        if (!opened.ok) return setNotice(opened.reason ?? 'Could not open an editor');
        void openDoc(d.change, d.artifact);
        void reload(d.change);
      },
    });
    return out;
  });

  const redraft = async (feedback: string) => {
    const d = doc();
    if (!d) return;
    closeDoc();
    const result = await props.input.dispatch(d.change, d.artifact, feedback);
    setJobs(props.input.listJobs());
    setNotice(result.message);
  };

  // --- the vision -----------------------------------------------------------

  /**
   * Runs one step of the interview. Once it has enough — the model says so,
   * or the developer does — the vision is split into slices straight away.
   */
  const runVision = async (label: string, work: () => Promise<unknown>) => {
    if (!vision) return;
    setVisionBusy(label);
    setVisionError(null);
    try {
      await work();
    } catch (err) {
      setVisionError(`The AI could not continue: ${(err as Error).message}`);
    }
    setVisionBusy(null);
    const current = vision.session();
    setVisionSession(current);
    if (current?.finished && current.slices.length === 0 && !visionError() && !vision.unavailable) {
      await runVision('Splitting your vision into slices — the first is the smallest thing a user can do end to end…', () => vision.extract(taken()));
    }
  };

  const confirmVision = async (kept: ProposedSlice[]) => {
    if (!vision) return;
    const current = vision.session();
    const first = vision.confirm(current?.refined || current?.understood || current?.vision || '', kept);
    const proposed = kept.find((k) => k.id === first?.id);
    if (!first || !proposed) {
      setVisionError('No slice can start first — one must not depend on another');
      return;
    }
    const result = await props.input.createChange(first.id, sliceDescription(proposed));
    if (!result.ok) return setVisionError(result.reason);
    await reload(first.id);
    setScreen('overview');
    setNotice(`Roadmap saved: ${kept.length} slices. First up: ${proposed.title}.`);
  };

  const notNewProject = () => {
    vision?.skip();
    refreshFoundation();
    setScreen('overview');
    startNewChange();
  };

  // --- overview actions ---------------------------------------------------

  const move = (delta: number) => {
    const n = pipelines().length;
    if (n === 0) return;
    // Clamped, not wrapping: at a list boundary, jumping to the far end loses
    // your place in a way that is disorienting in a review tool.
    setIndex((i) => Math.min(Math.max(i + delta, 0), n - 1));
    setActionFocus(0);
  };

  const enterReview = () => {
    const change = selected()?.name;
    if (!change) return;
    const opened = props.input.openReview(change);
    if (!opened) {
      setNotice(`${change} has no specs to review yet`);
      return;
    }
    setNotice(null);
    setSession(opened);
    // The agent that revises a requirement starts while you read the first.
    if (props.input.refine && !props.input.refine.unavailable) props.input.warm?.('review');
  };

  const leaveReview = async () => {
    const current = session();
    if (current) props.input.saveSession(current);
    setSession(null);
    // The overview must reflect what was just decided, or the pipeline bar
    // would keep showing a stage as unreviewed after you finished reviewing it.
    await reload();
  };

  /** Every decision is persisted immediately — a crash must not lose a review. */
  const commit = (next: ReviewSession) => {
    props.input.saveSession(next);
    setSession(next);
  };

  const openFoundation = async () => {
    if (questions().length === 0) {
      // A project that adopted OpenSpec before spec-tacular has no Foundation
      // yet; asking for it is the moment to write the questions.
      const result = await props.input.setup();
      if (!result.ok) return setNotice(result.reason);
      await reload();
    }
    setNotice(null);
    setScreen('foundation');
  };

  const startNewChange = () => {
    if (!foundationSettled()) {
      setNotice('Settle the ground rules first — f continues them');
      return;
    }
    setNotice(null);
    setDraft('');
    setAsking('describe');
  };

  const taken = () => pipelines().map((p) => p.name);

  const proposeNames = (text: string) => {
    const quick = nameFromDescription(text, taken());
    setNames([quick]);
    setDraft(quick);
    setNameEdited(false);
    if (!props.input.nameChange) return;
    setNaming(true);
    props.input.nameChange(text, taken()).then(
      (proposed) => {
        setNaming(false);
        if (asking() !== 'name' || proposed.length === 0) return;
        setNames([...new Set([...proposed, quick])]);
        // Never overwrite a name the developer already started adjusting.
        if (!nameEdited()) setDraft(proposed[0]!);
      },
      () => setNaming(false),
    );
  };

  const submitPrompt = async () => {
    const text = draft().trim();
    if (asking() === 'describe') {
      if (text === '') return setNotice('Describe the change first — a sentence is enough');
      setNotice(null);
      setDescription(text);
      setAsking('name');
      proposeNames(text);
      return;
    }
    const problem = validateChangeName(text);
    if (problem) return setNotice(problem);
    if (taken().includes(text)) return setNotice(`There is already a change called ${text}`);
    setAsking(null);
    setDraft('');
    setNotice(null);
    const result = await props.input.createChange(text, description());
    if (!result.ok) return setNotice(result.reason);
    await reload(text);
    setNotice(`Created ${text}.`);
  };

  const draftNext = async () => {
    const p = selected();
    const step = next();
    if (running()) {
      setNotice(`An agent is already working on ${p?.name} — ctrl+j to watch it`);
      return;
    }
    if (!p || !step?.actions.includes('draft') || !step.artifact) {
      setNotice(step ? `Nothing to draft — ${step.text}` : 'No change selected — n starts one');
      return;
    }
    const result = await props.input.dispatch(p.name, step.artifact);
    setJobs(props.input.listJobs());
    setNotice(result.message);
  };

  const writeNext = async () => {
    const p = selected();
    const step = next();
    if (!p || !step?.actions.includes('write') || !step.artifact) {
      setNotice(step ? `Nothing to write by hand — ${step.text}` : 'No change selected — n starts one');
      return;
    }
    const file = await props.input.artifactFile(p.name, step.artifact);
    if (!file.ok) return setNotice(file.reason);
    const opened = openInEditor(renderer, file.file, 1);
    if (!opened.ok) return setNotice(opened.reason ?? 'Could not open an editor');
    setNotice(null);
    await reload(p.name);
  };

  /** The selected change's next step, as buttons. */
  const actionButtons = createMemo((): { label: string; key: string; run: () => void }[] => {
    const actions = next()?.actions ?? [];
    const out: { label: string; key: string; run: () => void }[] = [];
    if (actions.includes('review')) out.push({ label: '▶ Review', key: 'enter', run: enterReview });
    if (actions.includes('draft')) {
      out.push({
        label: next()?.artifact === 'apply' ? '▶ Start implementing' : '✦ Let an agent draft it',
        key: 'w',
        run: () => void draftNext(),
      });
    }
    if (actions.includes('write')) out.push({ label: '✎ Write it myself', key: 'e', run: () => void writeNext() });
    if (actions.includes('foundation')) out.push({ label: '▶ Ground rules', key: 'f', run: () => void openFoundation() });
    const latest = readable().at(-1);
    const p = selected();
    if (latest && p) out.push({ label: `📄 Read the ${latest}`, key: 'v', run: () => void openDoc(p.name, latest) });
    return out;
  });

  // --- home ---------------------------------------------------------------

  const homeStatus = createMemo(() => {
    const s = stage();
    switch (s.kind) {
      case 'no-openspec': return 'This folder is not set up yet — Start sets it up here.';
      case 'no-foundation': return 'OpenSpec is here; spec-tacular is not set up yet.';
      case 'foundation': return `Ground rules: ${s.answered} of ${s.total} answered.`;
      case 'vision': return 'Ground rules are set. Now: what are you building?';
      case 'no-changes': return 'Ground rules are set — time for your first change.';
      case 'working': {
        const n = pipelines().length;
        const waiting = pipelines().filter((p) => p.current?.state === 'written').length;
        return `${n} change${n === 1 ? '' : 's'}${waiting > 0 ? ` · ${waiting} waiting for your review` : ''}`;
      }
    }
  });

  const homeActions = createMemo((): HomeAction[] => {
    const s = stage();
    const openOverview = () => { setScreen('overview'); };
    const groundRules = { label: 'Ground rules', run: () => openFoundation() };
    switch (s.kind) {
      case 'no-openspec':
      case 'no-foundation':
        return [{
          label: 'Start',
          run: async () => {
            setHomeBusy('Setting up the project…');
            setHomeError(null);
            const result = await props.input.setup();
            setHomeBusy(null);
            if (!result.ok) {
              setHomeError(`Setup failed: ${result.reason}`);
              return;
            }
            await reload();
            setScreen('foundation');
          },
        }];
      case 'foundation':
        return [
          { label: 'Continue ground rules', run: () => { setScreen('foundation'); } },
          { label: 'Open project', run: openOverview },
        ];
      case 'vision':
        return [
          { label: visionSession()?.vision ? 'Continue your vision' : 'Describe your vision', run: () => { setScreen('vision'); } },
          groundRules,
        ];
      case 'no-changes':
        return [
          { label: 'Start your first change', run: () => { openOverview(); startNewChange(); } },
          groundRules,
        ];
      case 'working':
        return [
          { label: 'Open project', run: openOverview },
          { label: 'New change', run: () => { openOverview(); startNewChange(); } },
          groundRules,
        ];
    }
  });

  // --- review -------------------------------------------------------------

  const findings = createMemo(() => {
    const current = session();
    const item = current ? currentItem(current) : null;
    // Only a spec requirement is linted for premature concreteness; a design
    // decision is supposed to be concrete.
    return item && isRequirement(item.item)
      ? lintRequirement(item.item, props.input.lintConfig)
      : [];
  });

  /** A global-scope design decision is the only promotable item. */
  const promotable = createMemo(() => {
    const current = session();
    const item = current ? currentItem(current) : null;
    const decision = item?.item as Decision | undefined;
    return decision?.capability === 'design' && decision.scope === 'global';
  });

  const onPromote = () => {
    const current = session();
    const item = current ? currentItem(current) : null;
    if (!current || !item) return;
    const result = props.input.promote(current.change, item.item as Decision);
    setNotice(result.ok ? `promoted to ${result.adr}` : result.reason);
    if (result.ok) {
      // Re-parsed: promotion rewrites design.md, so the decision's text
      // changed and its acceptance must reset like any other edit.
      setSession(refresh(current, props.input.reparse(current.change)));
    }
  };

  const onEdit = () => {
    const current = session();
    const item = current ? currentItem(current) : null;
    if (!current || !item) return;

    const result = openInEditor(renderer, item.item.file, item.item.line);
    if (!result.ok) {
      setNotice(result.reason ?? 'Could not open an editor');
      return;
    }
    // Re-parse rather than trusting the in-memory copy: the point of opening
    // an editor is that the file changed, and an edit after acceptance must
    // surface as drift.
    setSession(refresh(current, props.input.reparse(current.change)));
  };

  /** `e` on the review screen: the current requirement, revised with the agent. */
  const refinePort = createMemo((): RefinePort | undefined => {
    const refine = props.input.refine;
    if (!refine) return undefined;
    return {
      unavailable: refine.unavailable,
      current: (item) => readRequirementBlock(item),
      propose: (item, turns, instruction) => refine.propose(session()!.change, item, turns, instruction),
      accept: (item, block) => {
        const current = session();
        if (!current) return { ok: false, reason: 'the review was closed' };
        const result = acceptRefinement(current, item, block, () => props.input.reparse(current.change));
        if (!result.ok) return result;
        commit(result.session);
        return { ok: true };
      },
    };
  });

  // Pasting a description is as natural as typing one.
  usePasteInto(
    () =>
      screen() === 'overview' && !jobsOpen() && !inReview() && asking()
        ? (text: string) => {
            setDraft((d) => d + text);
            if (asking() === 'name') setNameEdited(true);
          }
        : null,
    { clipboard },
  );

  // --- keyboard -----------------------------------------------------------

  useKeyboard((key) => {
    // The job overlay owns the keyboard while it is up, including during a
    // review — that is what makes it a glance rather than a context switch.
    if (jobsOpen()) return;
    // Home and the ground rules own theirs: the latter takes typed answers,
    // so a letter is text there, not a command.
    if (screen() !== 'overview') return;
    if (key.ctrl && key.name === 'j') return openJobs();
    if (inReview()) return;

    if (asking()) {
      if (isCancel(key)) {
        setAsking(null);
        setDraft('');
        setNotice(null);
      } else if (isEnter(key)) void submitPrompt();
      else if (key.name === 'tab' && asking() === 'name' && names().length > 1) {
        // Cycles the proposals; a name you typed yourself is not lost to it.
        const i = names().indexOf(draft());
        setDraft(names()[(i + 1) % names().length]!);
        setNameEdited(false);
      } else {
        const edited = editLine(draft(), key);
        if (edited !== null) {
          setDraft(edited);
          if (asking() === 'name') setNameEdited(true);
        }
      }
      return;
    }

    // Help is a transient overlay: any key closes it rather than acting.
    if (help()) return setHelp(false);

    const buttons = actionButtons();
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) props.onQuit();
    else if (key.name === 'j' || key.name === 'down') move(1);
    else if (key.name === 'k' || key.name === 'up') move(-1);
    else if (key.name === 'tab' || key.name === 'right') {
      if (buttons.length > 0) setActionFocus((f) => (f + 1) % buttons.length);
    } else if (key.name === 'left') {
      if (buttons.length > 0) setActionFocus((f) => (f - 1 + buttons.length) % buttons.length);
    } else if (isEnter(key)) {
      // Enter presses the focused button — the next step, unless you moved.
      const button = buttons[Math.min(actionFocus(), buttons.length - 1)];
      if (button) button.run();
      else if (pipelines().length === 0 && foundationSettled()) startNewChange();
    } else if (key.name === 'r') enterReview();
    else if (key.name === 'n') startNewChange();
    else if (key.name === 'w') void draftNext();
    else if (key.name === 'e') void writeNext();
    else if (key.name === 'f') void openFoundation();
    else if (key.name === 'h') setScreen('home');
    else if (key.name === 'v' && !key.ctrl) {
      const latest = readable().at(-1);
      const p = selected();
      if (latest && p) void openDoc(p.name, latest);
    }
    else if (key.sequence === '?') setHelp(true);
  });

  const overviewKeys = createMemo((): [string, string][] => {
    if (asking() === 'describe') return [['enter', 'next: name it'], ['ctrl+c', 'cancel']];
    if (asking() === 'name') {
      return [['enter', 'create'], ...(names().length > 1 ? [['tab', 'next suggestion'] as [string, string]] : []), ['ctrl+u', 'clear'], ['ctrl+c', 'cancel']];
    }
    const k: [string, string][] = [];
    if (pipelines().length > 1) k.push(['↑↓', 'change']);
    if (actionButtons().length > 1) k.push(['←→', 'action']);
    if (actionButtons().length > 0) k.push(['enter', 'go']);
    k.push(['n', 'new change'], ['f', 'ground rules'], ['ctrl+j', 'jobs'], ['?', 'help'], ['q', 'quit']);
    return k;
  });

  return (
    <ClipboardProvider value={clipboard}>
    <box
      style={{ flexDirection: 'column', width: '100%', height: '100%', backgroundColor: THEME.bg }}
    >
      {/* Header — not on home, which is its own header */}
      <Show when={screen() !== 'home'}>
        <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.accent }}>
            <strong>spec-tacular</strong>
          </text>
          <text style={{ fg: THEME.dim }}>
            {`  ${shortPath(props.input.root, 50)}${inReview() ? ` › ${session()!.change} › specs` : ''}${screen() === 'foundation' ? ' › ground rules' : ''}${screen() === 'vision' ? ' › vision' : ''}${screen() === 'document' && doc() ? ` › ${doc()!.change} › ${doc()!.artifact}` : ''}`}
          </text>
          <box style={{ flexGrow: 1 }} />
          <Show when={summarizeJobs(jobs()) !== ''}>
            <text style={{ fg: THEME.dim }}>{`jobs: ${summarizeJobs(jobs())}`}</text>
          </Show>
        </box>
        {/* Where you are: setup steps until there is a change */}
        <Show when={step() !== null && !inReview()}>
          <Stepper step={step()!} steps={setupSteps(greenfield())} />
        </Show>
      </Show>

      <Show when={screen() === 'home'}>
        <HomeScreen
          root={props.input.root}
          status={homeStatus()}
          actions={homeActions()}
          busy={homeBusy()}
          error={homeError()}
          onQuit={props.onQuit}
        />
      </Show>

      <Show when={screen() === 'foundation'}>
        <FoundationScreen
          questions={questions()}
          meta={meta()}
          thinking={thinking()}
          advisorNote={props.input.advisorNote ?? null}
          notice={adviceNotice()}
          onShow={(q) => {
            setShown(q);
            maybeSuggest(q);
          }}
          onAnswer={onAnswer}
          onHelp={advisor ? onHelp : undefined}
          onDismiss={(q) => {
            if (advisor?.dismiss(q)) setAdviceNotice(`Removed “${q.item.name}”`);
            refreshFoundation();
          }}
          onEdit={(q) => {
            const result = openInEditor(renderer, q.item.file, q.item.line);
            if (!result.ok) setAdviceNotice(result.reason ?? 'Could not open an editor');
            refreshFoundation();
          }}
          onFinish={(open) => {
            // Left for later: still in the files, no longer blocking.
            for (const q of open) props.input.answer(q, DEFERRED);
            setShown(null);
            refreshFoundation();
            setScreen(stage().kind === 'vision' ? 'vision' : 'overview');
          }}
          onClose={() => {
            setShown(null);
            refreshFoundation();
            setScreen(stage().kind === 'vision' ? 'vision' : 'overview');
          }}
        />
      </Show>

      <Show when={screen() === 'vision'}>
        <VisionScreen
          session={visionSession()}
          busy={visionBusy()}
          error={visionError()}
          unavailable={vision?.unavailable ?? 'no vision support'}
          seed={
            // The Domain section asked what it is for already: start from that.
            questions().find((q) => q.title === 'Domain' && q.answered && /what the system is for/i.test(q.item.name))
              ?.item.text
          }
          onStart={(text) => {
            if (vision?.unavailable) {
              // No interview without a model: keep the vision, start a change.
              void vision.start(text).then(() => {
                refreshFoundation();
                setScreen('overview');
                startNewChange();
                setNotice('Your vision is saved to spec-tacular/vision.md');
              });
              return;
            }
            void runVision('Reading your vision — working out what to ask…', () => vision!.start(text));
          }}
          onRetry={() => void runVision('Trying again…', () => vision!.resume())}
          onAnswer={(answer) =>
            void runVision(
              answer === null ? 'Skipped — finding the next question…' : 'Thinking about your answer…',
              () => vision!.answer(answer),
            )}
          onFinish={() => void runVision('Wrapping up…', async () => vision!.finish())}
          onConfirm={(kept) => void confirmVision(kept)}
          onNotNew={notNewProject}
          onClose={() => setScreen('home')}
        />
      </Show>

      <Show when={screen() === 'document' && doc()}>
        <DocumentView
          title={`${doc()!.change} › ${doc()!.artifact}`}
          content={doc()!.content}
          actions={docActions()}
          onRedraft={(feedback) => void redraft(feedback)}
          onClose={closeDoc}
        />
      </Show>

      <Show when={screen() === 'overview' && jobsOpen()}>
        <Panel title="Jobs" grow focused>
          <JobPane
            jobs={jobs()}
            lines={jobLines()}
            selected={jobIndex()}
            onSelect={(i) => setJobIndex(Math.min(Math.max(i, 0), Math.max(jobs().length - 1, 0)))}
            onCancel={(job) => {
              props.input.cancelJob(job);
              setJobs(props.input.listJobs());
            }}
            onClose={() => {
              setJobsOpen(false);
              void reload();
            }}
          />
        </Panel>
      </Show>

      <Show when={screen() === 'overview' && !jobsOpen()}>
      <Show
        when={session()}
        fallback={
          <>
            <Show when={!help()} fallback={<Panel title="Help" grow focused><HelpOverlay /></Panel>}>
              <Show when={stage().kind === 'foundation'}>
                <Panel title="Ground rules">
                  <text style={{ fg: THEME.warn }}>
                    {(() => {
                      const s = stage();
                      return s.kind === 'foundation'
                        ? `Ground rules: ${s.answered} of ${s.total} answered. f continues them — no change can start until every question has an answer.`
                        : '';
                    })()}
                  </text>
                </Panel>
              </Show>

              <box style={{ flexDirection: 'row', flexGrow: 1 }}>
                {/* The changes */}
                <Panel title={`Changes · ${pipelines().length}`} width={34}>
                  <Show
                    when={pipelines().length > 0}
                    fallback={<text style={{ fg: THEME.dim }}>none yet</text>}
                  >
                    <For each={pipelines()}>
                      {(p, i) => (
                        <ChangeRow
                          pipeline={p}
                          selected={i() === index()}
                          onPick={() => { setIndex(i()); setActionFocus(0); }}
                        />
                      )}
                    </For>
                  </Show>
                  {/* The roadmap, when the project started from a vision */}
                  <Show when={(roadmap()?.slices.length ?? 0) > 0}>
                    <text>{' '}</text>
                    <text style={{ fg: THEME.accent2 }}>Roadmap</text>
                    <For each={roadmap()!.slices}>
                      {(slice) => (
                        <text
                          style={{
                            fg: slice.status === 'active' ? THEME.accent : slice.status === 'done' ? THEME.ok : THEME.dim,
                          }}
                        >
                          {clip(`${slice.status === 'active' ? '◉' : slice.status === 'done' ? '✓' : '○'} ${slice.id}`, 30)}
                        </text>
                      )}
                    </For>
                  </Show>
                  <box style={{ flexGrow: 1 }} />
                  <Show when={foundationSettled()}>
                    <box style={{ flexDirection: 'row' }}>
                      <Button label="+ New change" primary={pipelines().length === 0} onPress={startNewChange} />
                    </box>
                  </Show>
                </Panel>

                {/* The selected change, or how to start one */}
                <Show
                  when={selected()}
                  fallback={
                    <Panel title="Getting started" grow>
                      <Show
                        when={stage().kind === 'no-changes'}
                        fallback={<text style={{ fg: THEME.dim }}>Settle the ground rules first — f.</text>}
                      >
                        <FirstChangeGuide />
                      </Show>
                    </Panel>
                  }
                >
                  <Panel title={selected()!.name} grow focused>
                    <text>{' '}</text>
                    <PipelineBar pipeline={selected()} />
                    <text>{' '}</text>
                    <For each={changeWarnings(selected()!)}>
                      {(w) => <text style={{ fg: THEME.warn }}>{`! ${w}`}</text>}
                    </For>
                    {/* An agent at work: what it is doing, live */}
                    <Show when={running()}>
                      <text>{' '}</text>
                      <Spinner
                        label={`${running()!.driver === 'claude' ? 'Claude Code' : running()!.driver} is drafting the ${running()!.artifact} · ${elapsed()}`}
                      />
                      <text>{' '}</text>
                      <box
                        style={{
                          flexDirection: 'column',
                          border: ['left'],
                          borderColor: THEME.border,
                          paddingLeft: 1,
                        }}
                      >
                        <Show
                          when={runningLines().length > 0}
                          fallback={<text style={{ fg: THEME.dim }}>starting…</text>}
                        >
                          <For each={runningLines()}>
                            {(line) => <text style={{ fg: THEME.dim }}>{clip(line.replace(/\s+/g, ' '), 90)}</text>}
                          </For>
                        </Show>
                      </box>
                      <text>{' '}</text>
                      <text style={{ fg: THEME.text }}>
                        It opens here for you to read when it is done. Keep working meanwhile.
                      </text>
                      <text>{' '}</text>
                      <box style={{ flexDirection: 'row' }}>
                        <Button label="Watch the full log  ctrl+j" onPress={openJobs} />
                      </box>
                    </Show>

                    <Show when={next() && !running()}>
                      <text>{' '}</text>
                      <text style={{ fg: THEME.accent2 }}>
                        <strong>Next</strong>
                      </text>
                      <text style={{ fg: THEME.text }}>{next()!.text}</text>
                      <text>{' '}</text>
                      <box style={{ flexDirection: 'row' }}>
                        <For each={actionButtons()}>
                          {(b, i) => (
                            <Button
                              label={`${b.label}  ${b.key}`}
                              primary={i() === 0}
                              focused={i() === Math.min(actionFocus(), actionButtons().length - 1)}
                              onPress={b.run}
                            />
                          )}
                        </For>
                      </box>
                    </Show>
                  </Panel>
                </Show>
              </box>
            </Show>

            {/* The new-change prompt: describe it, then name it */}
            <Show when={asking()}>
              <Panel title={asking() === 'describe' ? 'New change · 1 of 2 · what' : 'New change · 2 of 2 · name'} focused>
                <Show when={asking() === 'describe'}>
                  <text style={{ fg: THEME.text }}>
                    What do you want to change, and why? A sentence or two — the agent drafting the proposal starts from this.
                  </text>
                  <text style={{ fg: THEME.dim }}>
                    e.g. "Let users sign in with email and password so their data follows them across devices"
                  </text>
                </Show>
                <Show when={asking() === 'name'}>
                  <text style={{ fg: THEME.dim }}>{clip(`“${description()}”`, 110)}</text>
                  <text style={{ fg: THEME.text }}>
                    A name for it — proposed from your description; adjust it if you like.
                  </text>
                </Show>
                <box style={{ border: true, borderStyle: 'rounded', borderColor: THEME.accent, paddingLeft: 1 }}>
                  <For each={wrap(`${draft()}▏`, 100)}>
                    {(line, i) => <text style={{ fg: THEME.text }}>{`${i() === 0 ? '› ' : '  '}${line}`}</text>}
                  </For>
                </box>
                <Show when={asking() === 'name'}>
                  <Show
                    when={!naming()}
                    fallback={<Spinner label="✦ proposing a better name…" />}
                  >
                    <Show when={names().length > 1}>
                      <text style={{ fg: THEME.dim }}>{`suggestions: ${names().join(' · ')}   (tab cycles)`}</text>
                    </Show>
                  </Show>
                </Show>
              </Panel>
            </Show>

            <KeyBar keys={overviewKeys()} right={notice() ?? undefined} />
          </>
        }
      >
        <Panel title={`${session()!.change} › review`} grow focused>
          <ReviewScreen
            session={session()!}
            onAccept={() => commit(decide(session()!, 'accepted'))}
            onReject={(note) => commit(decide(session()!, 'rejected', { note }))}
            onDefer={(deferReason) => commit(decide(session()!, 'deferred', { deferReason }))}
            onSkip={() => commit(skipItem(session()!))}
            onEdit={onEdit}
            refine={refinePort()}
            onMove={(d) => commit(moveCursor(session()!, d))}
            findings={findings()}
            promotable={promotable()}
            onPromote={onPromote}
            onMarkExample={(finding) => {
              const current = session();
              const item = current ? currentItem(current) : null;
              if (!current || !item || !isRequirement(item.item)) return;
              const result = markExampleInFile(item.item, finding.value);
              if (!result.ok) {
                setNotice(result.reason);
                return;
              }
              // Re-parsed rather than patched in memory: the text changed, so
              // the hash changed, and an accepted requirement must drop back to
              // pending exactly as any other edit would make it.
              setNotice(null);
              setSession(refresh(current, props.input.reparse(current.change)));
            }}
            onBack={() => void leaveReview()}
          />
        </Panel>
      </Show>
      </Show>

      {/* Copied, or why not: over the bottom-right corner, on every screen */}
      <Show when={toast()}>
        <box style={{ position: 'absolute', right: 1, bottom: 0, backgroundColor: THEME.highlight, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: THEME.ok }}>{toast()}</text>
        </box>
      </Show>
    </box>
    </ClipboardProvider>
  );
}

/** Exported for tests, which mount it against an in-memory input. */
export { App };

export async function startTui(input: TuiInput): Promise<void> {
  // `exitOnCtrlC` off: ctrl+c is the app's own cancel — back out of a
  // review, a prompt, the ground rules — and quits only from the overview.
  // Left on, the renderer tears itself down on the first ctrl+c anywhere.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  await new Promise<void>((resolve) => {
    void render(() => <App input={input} onQuit={resolve} />, renderer);
  });
  // Quitting is the app's call now, so restoring the terminal is too.
  renderer.destroy();
}
