/**
 * The AI behind the guided setup — the ground-rules advisor, the vision
 * interview and change names — and behind revising a requirement from the
 * review screen, wired to the chosen agent, and started ahead of time.
 *
 * All of them share one pool of agent sessions (agent/structured.ts), so a run
 * never starts the same agent twice. Each still works without a model: the
 * setup without proposals, the vision as the developer's own words.
 */

import { defaultRegistry, type AgentDriver, type DriverRegistry } from './agent/index.ts';
import { advisorUnavailable, StructuredPool } from './agent/structured.ts';
import { FoundationAdvisor, type Ask } from './core/advisor.ts';
import { buildNamePrompt, NAME_SCHEMA, parseNames } from './core/naming.ts';
import { finalizeVision, VisionInterviewer } from './core/vision.ts';
import { REFINE_SCHEMA, RequirementRefiner } from './core/refine.ts';
import { AnswerRefiner } from './core/refine-answer.ts';
import type { StructuredMode } from './agent/driver.ts';
import type { Usage } from './core/usage.ts';
import type { VisionPort } from './tui/app.tsx';

export type WarmTarget = 'foundation' | 'vision' | 'naming' | 'review';

export interface Assistants {
  advisor: FoundationAdvisor | null;
  /** Why there is no advisor, shown instead of suggestions. */
  advisorNote: string | null;
  nameChange?: (description: string, taken: string[]) => Promise<string[]>;
  vision: VisionPort;
  /**
   * Revises one requirement in conversation (review screen, `e`). Null
   * without a model; `advisorNote` says why.
   */
  refiner: RequirementRefiner | null;
  /**
   * Revises one ground-rule answer in conversation (ground-rules screen,
   * ctrl+r). Null without a model; `advisorNote` says why.
   */
  answerRefiner: AnswerRefiner | null;
  /**
   * Starts — and primes — the sessions a screen is about to need, while the
   * developer reads it. Never waits, never shows, and does nothing at all
   * with SPECTACULAR_NO_ADVISOR or without a model.
   */
  warm: (target: WarmTarget) => void;
  /** Subscribes to what the sessions cost, as each turn reports it. */
  onUsage: (listener: (usage: Usage) => void) => () => void;
  /** Ends every session, and whatever server they shared. */
  close: () => Promise<void>;
}

export function createAssistants(options: {
  cwd: string;
  driver: string;
  registry?: DriverRegistry;
  env?: NodeJS.ProcessEnv;
  /** Every turn's usage, as it is reported: kept, so a restart keeps the total. */
  record?: (usage: Usage) => void;
}): Assistants {
  const { cwd } = options;
  const env = options.env ?? process.env;

  let driver: AgentDriver | undefined;
  let unavailable: string | null = env['SPECTACULAR_NO_ADVISOR'] ? 'turned off by SPECTACULAR_NO_ADVISOR' : null;
  try {
    driver = (options.registry ?? defaultRegistry()).get(options.driver);
    unavailable ??= advisorUnavailable(driver);
  } catch (err) {
    unavailable ??= (err as Error).message;
  }

  // Opened on first use: a run that never needs the AI starts nothing.
  let pool: StructuredPool | null = null;
  const usageListeners = new Set<(usage: Usage) => void>();
  const reportUsage = (usage: Usage) => {
    options.record?.(usage);
    for (const listener of usageListeners) listener(usage);
  };
  const sessions = () => (pool ??= new StructuredPool(driver!, cwd, { onUsage: reportUsage }));

  /** An `Ask` on the pool; a prime goes to its session, or nowhere. */
  const askIn = (fallback: StructuredMode): Ask => (prompt, schema, o) => {
    if (unavailable || !driver) return Promise.reject(new Error(unavailable ?? 'no agent'));
    const mode = o?.mode ?? fallback;
    if (o?.prime) return o.parts ? sessions().prime(schema, mode, o.parts) : Promise.resolve(null);
    return sessions().ask(prompt, schema, { mode, parts: o?.parts });
  };

  const advisor = unavailable ? null : new FoundationAdvisor(cwd, askIn('research'));
  // The interview reasons about the vision; it has nothing to look up.
  const interviewer = new VisionInterviewer(cwd, askIn('think'));

  const vision: VisionPort = {
    unavailable,
    session: () => interviewer.session(),
    start: async (text) => {
      if (!unavailable) return interviewer.start(text);
      // No interview possible: keep the vision, and go on to a change.
      const session = await interviewer.start(text).catch(() => interviewer.session()!);
      finalizeVision(cwd, session, text, []);
      interviewer.skip();
      return session;
    },
    answer: (text) => interviewer.answer(text),
    finish: () => interviewer.finish(),
    resume: () => interviewer.resume(),
    extract: (taken) => interviewer.extract(taken),
    skip: () => interviewer.skip(),
    confirm: (text, kept) => finalizeVision(cwd, interviewer.session()!, text, kept),
  };

  return {
    advisor,
    advisorNote: unavailable,
    nameChange: unavailable
      ? undefined
      : async (description, taken) =>
          parseNames(
            await sessions().ask(buildNamePrompt(description, taken), NAME_SCHEMA, {
              mode: 'quick',
              timeoutMs: 60_000,
            }),
            taken,
          ),
    vision,
    // One conversation for every requirement revised in a run: each request
    // carries its own requirement and history, so a session that revised
    // the last one is only sent what differs.
    refiner: unavailable ? null : new RequirementRefiner(askIn('think')),
    // The same conversation as revising a requirement: wording, nothing to look up.
    answerRefiner: unavailable ? null : new AnswerRefiner(askIn('think')),
    warm: (target) => {
      if (unavailable) return;
      if (target === 'foundation') advisor?.prime();
      else if (target === 'vision') interviewer.prime();
      else if (target === 'review') sessions().warm(REFINE_SCHEMA, 'think');
      else sessions().warm(NAME_SCHEMA, 'quick');
    },
    onUsage: (listener) => {
      usageListeners.add(listener);
      return () => {
        usageListeners.delete(listener);
      };
    },
    close: async () => {
      await pool?.close().catch(() => {});
    },
  };
}
