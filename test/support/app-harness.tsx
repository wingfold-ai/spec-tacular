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
import { parseStop } from '../../src/core/stops.ts';
import { finalizeVision, isGreenfield, VisionInterviewer } from '../../src/core/vision.ts';
import { App, type TuiInput } from '../../src/tui/app.tsx';

const ORDER = ['proposal', 'specs', 'design', 'tasks'];

/**
 * A change whose artifacts up to `written` exist, the next one ready. With
 * `accepted`, its written documents carry sign-off state as the real app
 * loads it: those named are accepted, the rest are waiting to be read.
 */
export const changeWith = (name: string, written: string[] = [], accepted?: string[]): ChangePipeline =>
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
  }, accepted?.includes('specs') && written.includes('specs')
    ? { specs: { total: 1, accepted: 1, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true } }
    : {}, accepted
    ? Object.fromEntries(written.filter((id) => id !== 'specs').map((id) => [id, { accepted: accepted.includes(id), drifted: false }]))
    : {});

export const freshChange = (name: string) => changeWith(name);

const named: Record<string, string> = {
  return: 'RETURN', tab: 'TAB', up: 'ARROW_UP', down: 'ARROW_DOWN', left: 'ARROW_LEFT',
  right: 'ARROW_RIGHT', backspace: 'BACKSPACE', space: ' ', home: 'HOME', end: 'END',
};

export async function mountApp(
  options: {
    ask?: Ask;
    /** The model behind the vision interview. */
    visionAsk?: Ask;
    nameChange?: TuiInput['nameChange'];
    /** An existing project: it has baseline specs, so no vision step. */
    baseline?: boolean;
    /**
     * Whether `openspec init` ran, wiring OpenSpec into Claude Code: 'agent'
     * set up without that, false not at all. Default: it ran.
     */
    openspec?: boolean | 'agent';
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
    implement?: TuiInput['implement'];
    launch?: TuiInput['launch'];
    implementing?: TuiInput['implementing'];
    /** Prepares the folder before the app opens it: a roadmap, say. */
    prepare?: (root: string) => void;
    startNextSlice?: TuiInput['startNextSlice'];
    /** Never the real clipboard: a test that pastes brings its own. */
    clipboard?: TuiInput['clipboard'];
    /** The AI usage sidebar's wiring, for tests that exercise it. */
    driver?: TuiInput['driver'];
    modelFor?: TuiInput['modelFor'];
    onUsage?: TuiInput['onUsage'];
    jobUsage?: TuiInput['jobUsage'];
    stopReport?: TuiInput['stopReport'];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-app-'));
  // What `openspec init --tools claude` leaves behind, as far as it is checked.
  if (options.openspec !== false) mkdirSync(join(root, 'openspec'), { recursive: true });
  if (options.openspec === undefined || options.openspec === true) {
    mkdirSync(join(root, '.claude', 'skills', 'openspec-apply-change'), { recursive: true });
  }
  if (options.baseline) {
    mkdirSync(join(root, 'openspec', 'specs', 'existing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'existing', 'spec.md'), '# Existing\n');
  }
  options.prepare?.(root);
  const changes: ChangePipeline[] = [...(options.changes ?? [])];
  const created: { name: string; description: string; kind?: 'change' | 'defect' }[] = [];
  const dispatched: string[] = [];
  const jobs: Job[] = [];
  const docs = new Map<string, string>();
  /** What each job's agent said last, by job id. */
  const reports = new Map<string, string>();
  /** Documents accepted, per change: `acceptDocument` adds, a redraft removes. */
  const accepted = new Map<string, Set<string>>();
  const acceptedIn = (change: string) => accepted.get(change) ?? accepted.set(change, new Set()).get(change)!;
  const writtenIn = (p: ChangePipeline) => p.stages.filter((s) => s.state === 'written' || s.state === 'accepted').map((s) => s.id);
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
    implement: options.implement,
    launch: options.launch,
    implementing: options.implementing,
    startNextSlice: options.startNextSlice,
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
    stage: () => projectStage(root, changes.length, 'claude'),
    setup: async () => {
      mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
      // As the real set-up does: a new project leaves some questions for later.
      scaffoldFoundation(root, { defer: isGreenfield(root) });
      return { ok: true };
    },
    questions: () => guidedQuestions(root),
    answer: (q, text) => answerFoundation(q.item, text),
    createChange: async (name, description, kind) => {
      changes.push(freshChange(name));
      created.push({ name, description, ...(kind ? { kind } : {}) });
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
    acceptDocument: (change, artifact) => {
      acceptedIn(change).add(artifact);
      const i = changes.findIndex((c) => c.name === change);
      if (i >= 0) changes[i] = changeWith(change, writtenIn(changes[i]!), [...acceptedIn(change)]);
      return { ok: true };
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
    // As the real one does without a report file: the job's last words.
    stopReport: options.stopReport ?? ((change, artifact, job) => {
      const said = job ? reports.get(job.id) : undefined;
      return said === undefined ? null : parseStop(said, [], { change, artifact, source: 'message' });
    }),
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
      // A new draft is new text: whatever was accepted before no longer holds.
      acceptedIn(change).delete(artifact);
      if (i >= 0) changes[i] = changeWith(change, done, [...acceptedIn(change)]);
    },
    /** Pretends an agent finished without writing `artifact`, saying `message` last, if anything. */
    stopJob: (change: string, artifact: string, message?: string) => {
      const job = jobs.find((j) => j.change === change && j.artifact === artifact && j.status === 'running');
      if (!job) throw new Error(`no running job for ${change}/${artifact}`);
      job.status = 'succeeded';
      if (message !== undefined) reports.set(job.id, message);
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
