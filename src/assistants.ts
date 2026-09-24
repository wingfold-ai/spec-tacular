/**
 * The AI behind the guided setup — the ground-rules advisor, the vision
 * interview and change names — wired to the chosen agent, and started ahead
 * of time.
 *
 * All three share one pool of agent sessions (agent/structured.ts), so a run
 * never starts the same agent twice. Each still works without a model: the
 * setup without proposals, the vision as the developer's own words.
 */

import { defaultRegistry, type AgentDriver, type DriverRegistry } from './agent/index.ts';
import { advisorUnavailable, StructuredPool } from './agent/structured.ts';
import { FoundationAdvisor, type Ask } from './core/advisor.ts';
import { buildNamePrompt, NAME_SCHEMA, parseNames } from './core/naming.ts';
import { finalizeVision, VisionInterviewer } from './core/vision.ts';
import type { StructuredMode } from './agent/driver.ts';
import type { VisionPort } from './tui/app.tsx';

export type WarmTarget = 'foundation' | 'vision' | 'naming';

export interface Assistants {
  advisor: FoundationAdvisor | null;
  /** Why there is no advisor, shown instead of suggestions. */
  advisorNote: string | null;
  nameChange?: (description: string, taken: string[]) => Promise<string[]>;
  vision: VisionPort;
  /**
   * Starts — and primes — the sessions a screen is about to need, while the
   * developer reads it. Never waits, never shows, and does nothing at all
   * with SPECTACULAR_NO_ADVISOR or without a model.
   */
  warm: (target: WarmTarget) => void;
  /** Ends every session, and whatever server they shared. */
  close: () => Promise<void>;
}

export function createAssistants(options: {
  cwd: string;
  driver: string;
  registry?: DriverRegistry;
  env?: NodeJS.ProcessEnv;
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
  const sessions = () => (pool ??= new StructuredPool(driver!, cwd));

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
    warm: (target) => {
      if (unavailable) return;
      if (target === 'foundation') advisor?.prime();
      else if (target === 'vision') interviewer.prime();
      else sessions().warm(NAME_SCHEMA, 'quick');
    },
    close: async () => {
      await pool?.close().catch(() => {});
    },
  };
}
