/**
 * Mounts the whole App against a real temp-dir Foundation and a stubbed
 * OpenSpec, for end-to-end tests that drive it by keystroke.
 */
import { testRender } from '@opentui/solid';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoundationAdvisor, type Ask } from '../../src/core/advisor.ts';
import { answerFoundation, guidedQuestions, scaffoldFoundation } from '../../src/core/foundation.ts';
import { projectStage } from '../../src/core/guide.ts';
import type { Job } from '../../src/core/jobs.ts';
import { buildPipeline, type ChangePipeline } from '../../src/core/pipeline.ts';
import { loadRoadmap } from '../../src/core/roadmap.ts';
import { finalizeVision, isGreenfield, VisionInterviewer } from '../../src/core/vision.ts';
import { App, type TuiInput } from '../../src/tui/app.tsx';

const ORDER = ['proposal', 'specs', 'design', 'tasks'];

/** A change whose artifacts up to `written` exist, the next one ready. */
export const changeWith = (name: string, written: string[] = []): ChangePipeline =>
  buildPipeline({
    changeName: name,
    schemaName: 'spec-tacular',
    changeRoot: `/tmp/${name}`,
    artifactPaths: {},
    isPlanningComplete: false,
    applyRequires: ['tasks'],
    nextSteps: [],
    artifacts: ORDER.map((id, i) => ({
      id,
      status: written.includes(id)
        ? ('done' as const)
        : i === 0 || written.includes(ORDER[i - 1]!)
          ? ('ready' as const)
          : ('blocked' as const),
      requires: i === 0 ? [] : [ORDER[i - 1]!],
      outputPath: id === 'specs' ? 'specs/**/*.md' : `${id}.md`,
    })),
  });

export const freshChange = (name: string) => changeWith(name);

const named: Record<string, string> = {
  return: 'RETURN', tab: 'TAB', up: 'ARROW_UP', down: 'ARROW_DOWN', left: 'ARROW_LEFT',
  right: 'ARROW_RIGHT', backspace: 'BACKSPACE', space: ' ',
};

export async function mountApp(
  options: {
    ask?: Ask;
    /** The model behind the vision interview. */
    visionAsk?: Ask;
    nameChange?: TuiInput['nameChange'];
    /** An existing project: it has baseline specs, so no vision step. */
    baseline?: boolean;
    width?: number;
    height?: number;
    /** Changes there already are, once the project is set up. */
    changes?: ChangePipeline[];
    openReview?: TuiInput['openReview'];
    saveSession?: TuiInput['saveSession'];
    reparse?: TuiInput['reparse'];
    refine?: TuiInput['refine'];
    reviseAnswer?: TuiInput['reviseAnswer'];
    reviseVisionAnswer?: TuiInput['reviseVisionAnswer'];
    /** Never the real clipboard: a test that pastes brings its own. */
    clipboard?: TuiInput['clipboard'];
    /** The AI usage sidebar's wiring, for tests that exercise it. */
    driver?: TuiInput['driver'];
    modelFor?: TuiInput['modelFor'];
    onUsage?: TuiInput['onUsage'];
    jobUsage?: TuiInput['jobUsage'];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-app-'));
  if (options.baseline) {
    mkdirSync(join(root, 'openspec', 'specs', 'existing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'existing', 'spec.md'), '# Existing\n');
  }
  const changes: ChangePipeline[] = [...(options.changes ?? [])];
  const created: { name: string; description: string }[] = [];
  const dispatched: string[] = [];
  const jobs: Job[] = [];
  const docs = new Map<string, string>();
  /** What the app asked to have warmed, in order. */
  const warmed: string[] = [];
  const interviewer = new VisionInterviewer(root, options.visionAsk ?? (() => Promise.reject(new Error('no model'))));

  const input: TuiInput = {
    pipelines: [...changes],
    failed: [],
    root,
    openReview: options.openReview ?? (() => null),
    saveSession: options.saveSession ?? (() => {}),
    reparse: options.reparse ?? (() => []),
    refine: options.refine,
    reviseAnswer: options.reviseAnswer,
    reviseVisionAnswer: options.reviseVisionAnswer,
    clipboard: options.clipboard ?? {
      read: async () => ({ ok: false, reason: 'no clipboard in this test' }),
      write: async () => ({ ok: false, reason: 'no clipboard in this test' }),
    },
    lintConfig: { allow: [] } as unknown as TuiInput['lintConfig'],
    reloadPipelines: async () => [...changes],
    listJobs: () => jobs.map((j) => ({ ...j })),
    tailJob: (job) => [`working on ${job.artifact}…`, 'reading the ground rules'],
    cancelJob: () => {},
    promote: () => ({ ok: false, reason: 'n/a' }),
    stage: () => projectStage(root, changes.length),
    setup: async () => {
      mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
      // As the real set-up does: a new project leaves some questions for later.
      scaffoldFoundation(root, { defer: isGreenfield(root) });
      return { ok: true };
    },
    questions: () => guidedQuestions(root),
    answer: (q, text) => answerFoundation(q.item, text),
    createChange: async (name, description) => {
      changes.push(freshChange(name));
      created.push({ name, description });
      return { ok: true };
    },
    dispatch: async (change, artifact, feedback) => {
      dispatched.push(`${change}/${artifact}${feedback ? ` (${feedback})` : ''}`);
      jobs.push({
        id: `job-${jobs.length + 1}`, change, artifact, driver: 'claude', command: 'claude', args: [],
        cwd: root, status: 'running', startedAt: new Date().toISOString(), logPath: '/dev/null',
      });
      return { ok: true, message: `drafting ${change}/${artifact}` };
    },
    readArtifact: async (change, artifact) => {
      const content = docs.get(`${change}/${artifact}`);
      return content === undefined
        ? { ok: false, reason: 'not written' }
        : { ok: true, file: `/tmp/${change}/${artifact}.md`, content };
    },
    artifactFile: async () => ({ ok: false, reason: 'not in this test' }),
    advisor: options.ask ? new FoundationAdvisor(root, options.ask) : null,
    advisorNote: options.ask ? null : 'none in this test',
    nameChange: options.nameChange,
    driver: options.driver ?? 'claude',
    modelFor: options.modelFor,
    onUsage: options.onUsage,
    jobUsage: options.jobUsage,
    warm: (target) => warmed.push(target),
    greenfield: () => isGreenfield(root),
    roadmap: () => loadRoadmap(root),
    vision: {
      unavailable: options.visionAsk ? null : 'none in this test',
      session: () => interviewer.session(),
      start: (text) => interviewer.start(text),
      answer: (text) => interviewer.answer(text),
      finish: () => interviewer.finish(),
      resume: () => interviewer.resume(),
      extract: (taken) => interviewer.extract(taken),
      skip: () => interviewer.skip(),
      confirm: (text, kept) => finalizeVision(root, interviewer.session()!, text, kept),
    },
  };

  const setup = await testRender(() => <App input={input} onQuit={() => {}} />, {
    width: options.width ?? 120,
    height: options.height ?? 40,
    exitOnCtrlC: false,
  });
  await setup.flush();

  const settle = async (ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
    await setup.flush();
  };
  return {
    root,
    changes,
    created,
    dispatched,
    jobs,
    docs,
    warmed,
    settle,
    /** Pretends an agent finished writing `artifact` of `change`. */
    finishJob: (change: string, artifact: string, content: string) => {
      const job = jobs.find((j) => j.change === change && j.artifact === artifact && j.status === 'running');
      if (job) job.status = 'succeeded';
      docs.set(`${change}/${artifact}`, content);
      const i = changes.findIndex((c) => c.name === change);
      const done = ORDER.slice(0, ORDER.indexOf(artifact) + 1);
      if (i >= 0) changes[i] = changeWith(change, done);
    },
    /** Answers every ground-rule question, as if the setup were done. */
    settleGroundRules: () => {
      for (const q of guidedQuestions(root)) answerFoundation(q.item, 'Decided.');
    },
    frame: () => setup.captureCharFrame(),
    press: async (key: string, mods?: { ctrl?: boolean; shift?: boolean }) => {
      setup.mockInput.pressKey((named[key] ?? key) as never, mods);
      await settle();
    },
    type: async (text: string) => {
      await setup.mockInput.typeText(text);
      await settle();
    },
    /** The terminal's own paste: one bracketed-paste event. */
    paste: async (text: string) => {
      await setup.mockInput.pasteBracketedText(text);
      await settle();
    },
    destroy: () => {
      setup.renderer.destroy();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
