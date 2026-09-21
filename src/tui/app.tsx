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

import { render, useKeyboard, useRenderer } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { staleArtifacts } from '../core/gate.ts';
import type { ChangePipeline, Stage, StageState } from '../core/pipeline.ts';
import {
  decide,
  move as moveCursor,
  refresh,
  skip as skipItem,
  type ReviewSession,
} from '../core/session.ts';
import type { Requirement } from '../core/requirements.ts';
import { currentItem } from '../core/session.ts';
import { openInEditor } from './editor.ts';
import { JobPane, summarizeJobs } from './jobs.tsx';
import { ReviewScreen } from './review.tsx';
import { THEME } from './theme.ts';
import type { Job } from '../core/jobs.ts';
import { lintRequirement, type LintConfig } from '../core/concreteness.ts';
import { markExampleInFile } from '../core/mark.ts';

export interface TuiInput {
  pipelines: ChangePipeline[];
  failed: string[];
  root: string;
  /** Opens a change's review queue, or null when it has no specs yet. */
  openReview: (change: string) => ReviewSession | null;
  /** Persists a session's decisions and cursor. */
  saveSession: (session: ReviewSession) => void;
  /** Re-parses a change's specs, for after an external edit. */
  reparse: (change: string) => Requirement[];
  /** Per-project linter tuning. */
  lintConfig: LintConfig;
  /** Recomputes the overview after review changed something. */
  reloadPipelines: () => Promise<ChangePipeline[]>;
  /** Background jobs, re-read each time the pane opens. */
  listJobs: () => Job[];
  /** Rendered log lines for one job. */
  tailJob: (job: Job) => string[];
  cancelJob: (job: Job) => void;
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
    <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
      <Show when={props.pipeline === undefined}>
        <text style={{ fg: THEME.dim }}>no change selected</text>
      </Show>
      <For each={stages()}>
        {(stage) => (
          <text style={{ fg: STAGE_COLOR[stage.state] }}>
            {`${STAGE_MARK[stage.state]} ${stage.id}  `}
          </text>
        )}
      </For>
    </box>
  );
}

function ChangeRow(props: { pipeline: ChangePipeline; selected: boolean }) {
  const specs = () => props.pipeline.stages.find((s) => s.review)?.review;
  return (
    <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
      <text style={{ fg: props.selected ? THEME.accent : THEME.text }}>
        {`${props.selected ? '›' : ' '} ${props.pipeline.name}`}
      </text>
      <Show when={specs()}>
        <text style={{ fg: specs()!.complete ? THEME.ok : THEME.dim }}>
          {`  ${specs()!.accepted}/${specs()!.total} accepted`}
        </text>
      </Show>
      <Show when={(specs()?.drifted ?? 0) > 0}>
        <text style={{ fg: THEME.warn }}>{`  ! ${specs()!.drifted} changed`}</text>
      </Show>
      <Show when={staleArtifacts(props.pipeline).length > 0}>
        <text style={{ fg: THEME.warn }}>
          {`  ! ${staleArtifacts(props.pipeline).map((s) => s.artifact).join(', ')} may be stale`}
        </text>
      </Show>
      <Show when={props.pipeline.gaps.length > 0}>
        <text style={{ fg: THEME.warn }}>{`  ? ${props.pipeline.gaps.length} prereq gap`}</text>
      </Show>
    </box>
  );
}

function App(props: { input: TuiInput; onQuit: () => void }) {
  const renderer = useRenderer();
  const [pipelines, setPipelines] = createSignal(props.input.pipelines);
  const [index, setIndex] = createSignal(0);
  const [session, setSession] = createSignal<ReviewSession | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [jobs, setJobs] = createSignal<Job[]>(props.input.listJobs());
  const [jobIndex, setJobIndex] = createSignal(0);
  const [jobsOpen, setJobsOpen] = createSignal(false);

  const selected = () => pipelines()[index()];
  const inReview = createMemo(() => session() !== null && !jobsOpen());

  const selectedJob = createMemo(() => jobs()[jobIndex()]);
  const jobLines = createMemo(() => {
    const job = selectedJob();
    return job ? props.input.tailJob(job) : [];
  });

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

  const move = (delta: number) => {
    const n = pipelines().length;
    if (n === 0) return;
    // Clamped, not wrapping: at a list boundary, jumping to the far end loses
    // your place in a way that is disorienting in a review tool.
    setIndex((i) => Math.min(Math.max(i + delta, 0), n - 1));
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
  };

  const leaveReview = async () => {
    const current = session();
    if (current) props.input.saveSession(current);
    setSession(null);
    // The overview must reflect what was just decided, or the pipeline bar
    // would keep showing a stage as unreviewed after you finished reviewing it.
    setPipelines(await props.input.reloadPipelines());
  };

  /** Every decision is persisted immediately — a crash must not lose a review. */
  const commit = (next: ReviewSession) => {
    props.input.saveSession(next);
    setSession(next);
  };

  const findings = createMemo(() => {
    const current = session();
    const item = current ? currentItem(current) : null;
    return item ? lintRequirement(item.requirement, props.input.lintConfig) : [];
  });

  const onEdit = () => {
    const current = session();
    const item = current ? currentItem(current) : null;
    if (!current || !item) return;

    const result = openInEditor(renderer, item.requirement.file, item.requirement.line);
    if (!result.ok) {
      setNotice(result.reason ?? 'Could not open an editor');
      return;
    }
    // Re-parse rather than trusting the in-memory copy: the point of opening
    // an editor is that the file changed, and an edit after acceptance must
    // surface as drift.
    setSession(refresh(current, props.input.reparse(current.change)));
  };

  useKeyboard((key) => {
    // The job overlay owns the keyboard while it is up, including during a
    // review — that is what makes it a glance rather than a context switch.
    if (jobsOpen()) return;
    if (key.ctrl && key.name === 'j') return openJobs();
    if (inReview()) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) props.onQuit();
    else if (key.name === 'j' || key.name === 'down') move(1);
    else if (key.name === 'k' || key.name === 'up') move(-1);
    else if (key.name === 'return' || key.name === 'enter' || key.name === 'r') enterReview();
  });

  return (
    <box
      style={{ flexDirection: 'column', width: '100%', height: '100%', backgroundColor: THEME.bg }}
    >
      {/* Header */}
      <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.accent }}>spec-tacular</text>
        <text style={{ fg: THEME.dim }}>
          {`  ${props.input.root}${inReview() ? ` › ${session()!.change} › specs` : ''}`}
        </text>
      </box>

      {/* Constant region 1: the pipeline of the selected change */}
      <PipelineBar pipeline={selected()} />

      <Show when={jobsOpen()}>
        <JobPane
          jobs={jobs()}
          lines={jobLines()}
          selected={jobIndex()}
          onSelect={(i) => setJobIndex(Math.min(Math.max(i, 0), Math.max(jobs().length - 1, 0)))}
          onCancel={(job) => {
            props.input.cancelJob(job);
            setJobs(props.input.listJobs());
          }}
          onClose={() => setJobsOpen(false)}
        />
      </Show>

      <Show when={!jobsOpen()}>
      <Show
        when={session()}
        fallback={
          <>
            <box style={{ flexDirection: 'column', flexGrow: 1, paddingTop: 1 }}>
              <For each={pipelines()}>
                {(p, i) => <ChangeRow pipeline={p} selected={i() === index()} />}
              </For>
            </box>

            {/* Constant region 2: status */}
            <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
              <text style={{ fg: THEME.dim }}>{`${pipelines().length} changes`}</text>
              <Show when={props.input.failed.length > 0}>
                <text style={{ fg: THEME.warn }}>
                  {`  ${props.input.failed.length} failed to load`}
                </text>
              </Show>
              <Show when={notice()}>
                <text style={{ fg: THEME.warn }}>{`  ${notice()}`}</text>
              </Show>
              <Show when={summarizeJobs(jobs()) !== ''}>
                <text style={{ fg: THEME.dim }}>{`  jobs: ${summarizeJobs(jobs())}`}</text>
              </Show>
              <text style={{ fg: THEME.dim }}>
                {'   j/k move · enter review · ctrl+j jobs · q quit'}
              </text>
            </box>
          </>
        }
      >
        <ReviewScreen
          session={session()!}
          onAccept={() => commit(decide(session()!, 'accepted'))}
          onReject={(note) => commit(decide(session()!, 'rejected', { note }))}
          onDefer={(deferReason) => commit(decide(session()!, 'deferred', { deferReason }))}
          onSkip={() => commit(skipItem(session()!))}
          onEdit={onEdit}
          onMove={(d) => commit(moveCursor(session()!, d))}
          findings={findings()}
          onMarkExample={(finding) => {
            const current = session();
            const item = current ? currentItem(current) : null;
            if (!current || !item) return;
            const result = markExampleInFile(item.requirement, finding.value);
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
      </Show>
      </Show>
    </box>
  );
}

export async function startTui(input: TuiInput): Promise<void> {
  await new Promise<void>((resolve) => {
    void render(() => <App input={input} onQuit={resolve} />);
  });
}
