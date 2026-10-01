/**
 * The job pane.
 *
 * An overlay rather than a screen: you pull it up mid-review to glance at a
 * running agent and drop it again without losing your place in the queue.
 * That is the whole point of the milestone — reviewing and implementing at
 * once, in one terminal (docs/problem-analysis.md §7).
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { wrap } from '../render/requirement.ts';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Job, JobStatus } from '../core/jobs.ts';
import { THEME } from './theme.ts';

export interface JobPaneProps {
  jobs: Job[];
  /** Rendered log lines for the selected job. */
  lines: string[];
  selected: number;
  onSelect: (index: number) => void;
  onCancel: (job: Job) => void;
  onClose: () => void;
}

const STATUS_COLOR: Record<JobStatus, string> = {
  running: THEME.accent,
  succeeded: THEME.ok,
  failed: THEME.err,
  cancelled: THEME.dim,
  interrupted: THEME.warn,
};

const STATUS_MARK: Record<JobStatus, string> = {
  running: '◉',
  succeeded: '✓',
  failed: '✗',
  cancelled: '−',
  interrupted: '?',
};

/** Jobs listed at once; the rest scroll with the selection. */
const LIST_ROWS = 5;

/** Wrapped to `width`, a word too long for a row split across rows. */
function wrapHard(line: string, width: number): string[] {
  if (line.trim() === '') return [''];
  const indent = /^\s*/.exec(line)![0];
  return wrap(line.trimStart(), Math.max(width - indent.length, 10)).flatMap((row) => {
    const text = `${indent}${row}`;
    const out: string[] = [];
    for (let at = 0; at < text.length; at += width) out.push(text.slice(at, at + width));
    return out;
  });
}

/** A compact summary for the status line: `1 running · 2 failed`. */
export function summarizeJobs(jobs: Job[]): string {
  if (jobs.length === 0) return '';
  const counts = new Map<JobStatus, number>();
  for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  // Running first — it is the only status anyone is waiting on.
  const order: JobStatus[] = ['running', 'failed', 'interrupted', 'succeeded', 'cancelled'];
  return order
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ');
}

export function JobPane(props: JobPaneProps) {
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  const current = createMemo(() => props.jobs[props.selected]);
  const dims = useTerminalDimensions();

  /** The slice of the job list in view: the selected job always among it. */
  const listed = createMemo(() => {
    const first = Math.min(Math.max(props.selected - LIST_ROWS + 1, 0), Math.max(props.jobs.length - LIST_ROWS, 0));
    return props.jobs.slice(first, first + LIST_ROWS).map((job, i) => ({ job, index: first + i }));
  });

  /**
   * The log's latest rows that fit, as one text. One node per row, with more
   * rows than room, is squeezed until rows are drawn over each other.
   */
  const log = createMemo(() => {
    const width = Math.max(dims().width - 2, 20);
    // Header, list, the gap above the log, the footer.
    const rows = Math.max(dims().height - 3 - listed().length - (props.jobs.length > LIST_ROWS ? 1 : 0), 3);
    return props.lines
      .flatMap((l) => l.split('\n'))
      .flatMap((l) => wrapHard(l, width))
      .slice(-rows)
      .join('\n');
  });

  useKeyboard((key) => {
    if (confirmCancel()) {
      // Cancelling throws away an agent's work in progress, so it asks first.
      if (key.name === 'y') {
        const job = current();
        if (job) props.onCancel(job);
      }
      setConfirmCancel(false);
      return;
    }
    if (key.name === 'j' || key.name === 'down') props.onSelect(props.selected + 1);
    else if (key.name === 'k' || key.name === 'up') props.onSelect(props.selected - 1);
    else if (key.name === 'x') {
      if (current()?.status === 'running') setConfirmCancel(true);
    } else if (key.name === 'q' || (key.ctrl && key.name === 'c')) props.onClose();
  });

  return (
    <box style={{ flexDirection: 'column', width: '100%', height: '100%' }}>
      <box style={{ flexDirection: 'row', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.accent }}>jobs</text>
        <text style={{ fg: THEME.dim }}>{`  ${summarizeJobs(props.jobs) || 'none yet'}`}</text>
      </box>

      <Show
        when={props.jobs.length > 0}
        fallback={
          <box style={{ padding: 1, flexGrow: 1 }}>
            <text style={{ fg: THEME.dim }}>
              Nothing has been dispatched yet. Run one with: spec-tacular run &lt;artifact&gt; -c &lt;change&gt;
            </text>
          </box>
        }
      >
        <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
          <For each={listed()}>
            {({ job, index }) => (
              <text style={{ fg: index === props.selected ? THEME.text : STATUS_COLOR[job.status] }}>
                {`${index === props.selected ? '›' : ' '} ${STATUS_MARK[job.status]} ${job.change}/${job.artifact}  ${job.status}  ${new Date(job.startedAt).toTimeString().slice(0, 5)}`}
              </text>
            )}
          </For>
          <Show when={props.jobs.length > LIST_ROWS}>
            <text style={{ fg: THEME.dim }}>{`  ${props.selected + 1} of ${props.jobs.length} — j/k for the others`}</text>
          </Show>
        </box>

        <box style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
          <Show
            when={props.lines.length > 0}
            fallback={<text style={{ fg: THEME.dim }}>(no output yet)</text>}
          >
            <text style={{ fg: THEME.text }}>{log()}</text>
          </Show>
        </box>
      </Show>

      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <Show
          when={confirmCancel()}
          fallback={
            <text style={{ fg: THEME.dim }}>j/k move · x cancel job · q close</text>
          }
        >
          <text style={{ fg: THEME.warn }}>
            {`Cancel ${current()?.change}/${current()?.artifact}? Its work in progress is lost.  y / any other key`}
          </text>
        </Show>
      </box>
    </box>
  );
}
