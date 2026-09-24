/**
 * The job pane.
 *
 * An overlay rather than a screen: you pull it up mid-review to glance at a
 * running agent and drop it again without losing your place in the queue.
 * That is the whole point of the milestone — reviewing and implementing at
 * once, in one terminal (docs/problem-analysis.md §7).
 */

import { useKeyboard } from '@opentui/solid';
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
      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.accent }}>jobs</text>
        <text style={{ fg: THEME.dim }}>{`  ${summarizeJobs(props.jobs) || 'none yet'}`}</text>
      </box>

      <Show
        when={props.jobs.length > 0}
        fallback={
          <box style={{ padding: 1, flexGrow: 1 }}>
            <text style={{ fg: THEME.dim }}>
              Nothing has been dispatched yet. Run one with: spectacular run &lt;artifact&gt; -c &lt;change&gt;
            </text>
          </box>
        }
      >
        <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
          <For each={props.jobs}>
            {(job, i) => (
              <text
                style={{ fg: i() === props.selected ? THEME.text : THEME.dim }}
              >
                {`${i() === props.selected ? '›' : ' '} ${STATUS_MARK[job.status]} ${job.change}/${job.artifact}  ${job.status}`}
              </text>
            )}
          </For>
        </box>

        <box style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
          <Show
            when={props.lines.length > 0}
            fallback={<text style={{ fg: THEME.dim }}>(no output yet)</text>}
          >
            <For each={props.lines}>
              {(line) => <text style={{ fg: THEME.text }}>{line || ' '}</text>}
            </For>
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
