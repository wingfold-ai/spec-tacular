/**
 * The TUI shell (M0/M1).
 *
 * Two regions never leave the screen — the pipeline bar and the status line —
 * because "always visible" is the requirement this milestone exists to meet
 * (docs/tui-design.md, "The constant frame").
 *
 * Kept deliberately thin: all derivation lives in core/, so the review loop in
 * M3 attaches to a model that is already tested without a terminal.
 */

import { render } from '@opentui/solid';
import { createSignal, For, Show } from 'solid-js';
import type { ChangePipeline, Stage, StageState } from '../core/pipeline.ts';

export interface TuiInput {
  pipelines: ChangePipeline[];
  failed: string[];
  root: string;
}

const THEME = {
  accent: '#7aa2f7',
  dim: '#565f89',
  text: '#c0caf5',
  warn: '#e0af68',
  ok: '#9ece6a',
  bg: '#1a1b26',
} as const;

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
  // Flattened to a plain accessor rather than Show's render-prop form: the
  // empty list renders as nothing, which is the same result with less typing
  // ceremony around the undefined case.
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
  return (
    <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
      <text style={{ fg: props.selected ? THEME.accent : THEME.text }}>
        {`${props.selected ? '›' : ' '} ${props.pipeline.name}`}
      </text>
      <text style={{ fg: THEME.dim }}>
        {`  ${props.pipeline.accepted}/${props.pipeline.total} accepted`}
      </text>
      <Show when={props.pipeline.gaps.length > 0}>
        <text style={{ fg: THEME.warn }}>
          {`  ? ${props.pipeline.gaps.length} prereq gap`}
        </text>
      </Show>
    </box>
  );
}

function App(props: { input: TuiInput; onQuit: () => void }) {
  const [index, setIndex] = createSignal(0);
  const changes = () => props.input.pipelines;
  const selected = () => changes()[index()];

  const move = (delta: number) => {
    const n = changes().length;
    if (n === 0) return;
    // Clamped rather than wrapping: at a list boundary, wrapping to the far
    // end loses your place in a way that is disorienting in a review tool.
    setIndex((i) => Math.min(Math.max(i + delta, 0), n - 1));
  };

  const onKey = (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) props.onQuit();
    else if (key.name === 'j' || key.name === 'down') move(1);
    else if (key.name === 'k' || key.name === 'up') move(-1);
  };

  return (
    <box
      style={{ flexDirection: 'column', width: '100%', height: '100%', backgroundColor: THEME.bg }}
      focused
      onKeyDown={onKey}
    >
      {/* Header */}
      <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.accent }}>spec-tacular</text>
        <text style={{ fg: THEME.dim }}>{`  ${props.input.root}`}</text>
      </box>

      {/* Constant region 1: the pipeline of the selected change */}
      <PipelineBar pipeline={selected()} />

      {/* Body */}
      <box style={{ flexDirection: 'column', flexGrow: 1, paddingTop: 1 }}>
        <For each={changes()}>
          {(p, i) => <ChangeRow pipeline={p} selected={i() === index()} />}
        </For>
      </box>

      {/* Constant region 2: status */}
      <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: THEME.dim }}>
          {`${changes().length} changes`}
        </text>
        <Show when={props.input.failed.length > 0}>
          <text style={{ fg: THEME.warn }}>
            {`  ${props.input.failed.length} failed to load`}
          </text>
        </Show>
        <text style={{ fg: THEME.dim }}>{'   j/k move · q quit'}</text>
      </box>
    </box>
  );
}

export async function startTui(input: TuiInput): Promise<void> {
  await new Promise<void>((resolve) => {
    void render(() => <App input={input} onQuit={resolve} />);
  });
}
