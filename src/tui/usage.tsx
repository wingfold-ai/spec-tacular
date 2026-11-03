/**
 * The AI usage sidebar: what is answering, what it is doing, and what it has
 * cost — always on screen, compact enough to leave the review surface alone.
 *
 * The summary is one glance; `ctrl+b` (or the button) expands it into the
 * per-model and per-job breakdown, including the steps a running agent has
 * taken. Nothing here decides anything: it only reports what the drivers and
 * the job logs already said.
 */

import { For, Show } from 'solid-js';
import type { Job } from '../core/jobs.ts';
import {
  driverLabel,
  formatCost,
  formatTokens,
  sumUsage,
  totalInput,
  type Usage,
  type UsageTotals,
} from '../core/usage.ts';
import { THEME } from './theme.ts';
import { Button, clip, KeyBar, Spinner } from './widgets.tsx';

/** Columns the sidebar takes when it is showing. */
export const USAGE_WIDTH = 30;

/** What the AI is doing right now, for the compact line. */
export interface ActiveAI {
  driver: string;
  label: string;
  /** The latest step, shown under the label. */
  step?: string;
  /** Recent steps, shown in full when expanded. */
  steps: string[];
}

/** The compact, always-visible summary. */
export function UsageColumn(props: {
  totals: UsageTotals;
  driver: string;
  model?: string;
  active: ActiveAI | null;
  onExpand: () => void;
  /** The implementing sessions: tokens only, Claude Code reports no cost for them. */
  implementing?: UsageTotals;
}) {
  const requests = () =>
    `${props.totals.requests} request${props.totals.requests === 1 ? '' : 's'}`;
  return (
    <box
      style={{
        width: USAGE_WIDTH,
        flexShrink: 0,
        flexDirection: 'column',
        border: ['left'],
        borderColor: THEME.border,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text style={{ fg: THEME.accent }}>
        <strong>AI</strong>
      </text>
      <text style={{ fg: THEME.text }}>{clip(driverLabel(props.driver), USAGE_WIDTH - 3)}</text>
      <Show when={props.model}>
        <text style={{ fg: THEME.dim }}>{clip(props.model!, USAGE_WIDTH - 3)}</text>
      </Show>

      <text>{' '}</text>
      <text style={{ fg: THEME.accent2 }}>
        <strong>{formatCost(props.totals.costUsd)}</strong>
      </text>
      <text style={{ fg: THEME.dim }}>{clip(requests(), USAGE_WIDTH - 3)}</text>
      <Show when={totalInput(props.totals) + props.totals.outputTokens > 0}>
        <text style={{ fg: THEME.dim }}>
          {clip(
            `${formatTokens(totalInput(props.totals))} in · ${formatTokens(props.totals.outputTokens)} out`,
            USAGE_WIDTH - 3,
          )}
        </text>
      </Show>

      <Show when={props.implementing && props.implementing.requests > 0}>
        <text>{' '}</text>
        <text style={{ fg: THEME.text }}>{clip('+ implementing', USAGE_WIDTH - 3)}</text>
        <text style={{ fg: THEME.dim }}>
          {clip(`${formatTokens(totalInput(props.implementing!))} in · ${formatTokens(props.implementing!.outputTokens)} out`, USAGE_WIDTH - 3)}
        </text>
        <text style={{ fg: THEME.dim }}>{clip('cost not reported', USAGE_WIDTH - 3)}</text>
      </Show>

      <box style={{ flexGrow: 1 }} />

      <Show
        when={props.active}
        fallback={<text style={{ fg: THEME.dim }}>idle</text>}
      >
        <Spinner label="working" color={THEME.accent2} />
        <text style={{ fg: THEME.text }}>{clip(props.active!.label, USAGE_WIDTH - 3)}</text>
        <Show when={props.active!.step}>
          <text style={{ fg: THEME.dim }}>{clip(props.active!.step!, USAGE_WIDTH - 3)}</text>
        </Show>
      </Show>

      <text>{' '}</text>
      <Button label="Details  ctrl+b" onPress={props.onExpand} />
    </box>
  );
}

/** One job's share, parsed from its log. */
export interface JobUsage {
  job: Job;
  usages: Usage[];
}

/** The expanded breakdown. */
export function UsagePane(props: {
  totals: UsageTotals;
  driver: string;
  model?: string;
  active: ActiveAI | null;
  jobs: JobUsage[];
  implementing?: UsageTotals;
}) {
  // In, split by what it cost: read from the cache is cheapest, written to it dearest.
  const tokenLine = () => {
    const t = props.totals;
    const split = [
      t.cacheReadTokens > 0 ? `${formatTokens(t.cacheReadTokens)} from cache` : '',
      t.cacheWriteTokens > 0 ? `${formatTokens(t.cacheWriteTokens)} cached` : '',
      t.cacheReadTokens + t.cacheWriteTokens > 0 ? `${formatTokens(t.inputTokens)} uncached` : '',
    ].filter(Boolean);
    return `${formatTokens(totalInput(t))} in${split.length ? ` (${split.join(', ')})` : ''} · ${formatTokens(t.outputTokens)} out`;
  };

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <text style={{ fg: THEME.dim }}>
        {`${driverLabel(props.driver)}${props.model ? ` · ${props.model}` : ''} — ${formatCost(props.totals.costUsd)} over ${props.totals.requests} request${props.totals.requests === 1 ? '' : 's'}`}
      </text>
      <text style={{ fg: THEME.text }}>{tokenLine()}</text>
      <Show when={props.implementing && props.implementing.requests > 0}>
        <text style={{ fg: THEME.text }}>
          {`+ implementing: ${formatTokens(totalInput(props.implementing!))} in · ${formatTokens(props.implementing!.outputTokens)} out` +
            ' — Claude Code reports no cost for an interactive session; its /cost command shows it there'}
        </text>
      </Show>

      <text>{' '}</text>
      <text style={{ fg: THEME.accent2 }}>
        <strong>By model</strong>
      </text>
      <Show
        when={props.totals.models.length > 0}
        fallback={<text style={{ fg: THEME.dim }}>nothing yet</text>}
      >
        <For each={props.totals.models}>
          {(m) => (
            <text style={{ fg: THEME.text }}>
              {clip(`${driverLabel(m.driver)} · ${m.model}  ${formatCost(m.costUsd)} · ${m.requests}×`, 70)}
            </text>
          )}
        </For>
      </Show>

      <Show when={props.jobs.length > 0}>
        <text>{' '}</text>
        <text style={{ fg: THEME.accent2 }}>
          <strong>Jobs</strong>
        </text>
        <For each={props.jobs}>
          {(entry) => {
            const total = () => sumUsage(entry.usages);
            return (
              <text style={{ fg: entry.job.status === 'running' ? THEME.text : THEME.dim }}>
                {clip(`${entry.job.change}/${entry.job.artifact} · ${entry.job.status}  ${formatCost(total().costUsd)}`, 80)}
              </text>
            );
          }}
        </For>
      </Show>

      <Show when={props.active}>
        <text>{' '}</text>
        <text style={{ fg: THEME.accent2 }}>
          <strong>Now</strong>
        </text>
        <Spinner label={props.active!.label} />
        <Show
          when={props.active!.steps.length > 0}
          fallback={<text style={{ fg: THEME.dim }}>starting…</text>}
        >
          <For each={props.active!.steps.slice(-12)}>
            {(step) => <text style={{ fg: THEME.dim }}>{clip(step.replace(/\s+/g, ' '), 100)}</text>}
          </For>
        </Show>
      </Show>

      <box style={{ flexGrow: 1 }} />
      <KeyBar keys={[['ctrl+b', 'close'], ['q', 'close']]} />
    </box>
  );
}
