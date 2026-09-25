/**
 * Runs a driver's structured requests and returns their values.
 *
 * Unlike a job this is not detached: it is short, its result is consumed by
 * the running TUI, and nothing needs to survive the TUI exiting. It is still
 * asynchronous — the UI keeps drawing and taking answers while it runs.
 *
 * Two ways to ask. `runStructured` starts an agent per request: simple, and
 * the fallback. `StructuredPool` keeps a session per kind of request open and
 * sends it only what changed — the difference between a follow-up question
 * taking the agent's start-up plus a re-read of the whole project, and taking
 * one model turn.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { adopt } from './children.ts';
import {
  SessionError,
  SessionTimeoutError,
  type AgentDriver,
  type StructuredMode,
  type StructuredSession,
} from './driver.ts';
import { MalformedOutputError, retryInstruction } from './json.ts';
import { debugLog } from './log.ts';
import { renderDelta, renderPrompt, type ContextSection, type PromptParts } from './prompt.ts';
import type { Usage } from '../core/usage.ts';

const DEFAULT_TIMEOUT_MS = 180_000;

/** Whether `command` can be found on PATH, without running it. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes('/')) return existsSync(command);
  return (env['PATH'] ?? '').split(delimiter).some((d) => d && existsSync(join(d, command)));
}

/** Why a driver cannot advise, or null when it can. */
export function advisorUnavailable(driver: AgentDriver): string | null {
  if (!driver.structured) return `${driver.label} cannot answer structured requests`;
  const probe = driver.structured.build({ prompt: '', cwd: '', schema: {} });
  if (!onPath(probe.command)) return `\`${probe.command}\` is not installed`;
  return null;
}

function runOnce(
  driver: AgentDriver,
  cwd: string,
  prompt: string,
  schema: object,
  mode: StructuredMode | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const structured = driver.structured!;
  const { command, args, env } = structured.build({ prompt, cwd, schema, mode });

  return new Promise((resolve, reject) => {
    const child = adopt(spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    }));
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${driver.label} did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout!.on('data', (c) => (stdout += c));
    child.stderr!.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(structured.parse(stdout, schema));
      } catch (err) {
        if (err instanceof MalformedOutputError) return reject(err);
        reject(
          new Error(
            code !== 0 && stderr.trim()
              ? stderr.trim().split('\n')[0]!
              : (err as Error).message,
          ),
        );
      }
    });
  });
}

export async function runStructured(
  driver: AgentDriver,
  cwd: string,
  prompt: string,
  schema: object,
  options: { mode?: StructuredMode; timeoutMs?: number } = {},
): Promise<unknown> {
  if (!driver.structured) throw new Error(`${driver.label} cannot advise`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await runOnce(driver, cwd, prompt, schema, options.mode, timeoutMs);
  } catch (err) {
    // An agent that cannot be held to a schema sometimes answers around it.
    // Told what was wrong, it nearly always gets it right the second time.
    if (!(err instanceof MalformedOutputError)) throw err;
    return runOnce(driver, cwd, `${prompt}\n\n${retryInstruction(err.message)}`, schema, options.mode, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// Sessions

export interface PoolAsk {
  mode?: StructuredMode;
  /** The prompt in parts, so a session that has seen it is sent only the change. */
  parts?: PromptParts;
  timeoutMs?: number;
}

interface Entry {
  session: StructuredSession | null;
  /** The context the session was last sent, or null when it has seen none. */
  seen: ContextSection[] | null;
  turns: number;
  /** The tail of the queue: requests to one session go one at a time. */
  queue: Promise<unknown>;
  /** A priming turn was queued; one is enough for as long as the pool lives. */
  primed: boolean;
}

/** A one-shot request, for when there is no session to be had. */
export type OneShot = (prompt: string, schema: object, mode: StructuredMode | undefined, timeoutMs: number) => Promise<unknown>;

/**
 * Sessions by (mode, schema), opened lazily or ahead of time with `warm`.
 *
 * Model, tools and schema are fixed when an agent starts, so each kind of
 * request gets its own session. A session is told the whole context once;
 * after that only what changed. When one fails, a fresh session is sent the
 * whole prompt; when that cannot start either, the one-shot path answers.
 */
export class StructuredPool {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly oneShot: OneShot;
  private readonly maxTurns: number;
  private readonly onUsage: ((usage: Usage) => void) | undefined;

  constructor(
    private readonly driver: AgentDriver,
    private readonly cwd: string,
    options: { oneShot?: OneShot; maxTurns?: number; onUsage?: (usage: Usage) => void } = {},
  ) {
    this.oneShot = options.oneShot ??
      ((prompt, schema, mode, timeoutMs) => runStructured(driver, cwd, prompt, schema, { mode, timeoutMs }));
    // A conversation grows with every turn, and so does what each turn costs.
    // Past this, a fresh session re-reading the context is the cheaper one.
    this.maxTurns = options.maxTurns ?? 20;
    this.onUsage = options.onUsage;
  }

  /** Reports what the turn just cost, when the session and caller care. */
  private report(session: StructuredSession): void {
    if (!this.onUsage) return;
    const usage = session.lastUsage?.();
    if (usage) this.onUsage(usage);
  }

  private key(mode: StructuredMode, schema: object): string {
    return `${mode}:${JSON.stringify(schema)}`;
  }

  private entry(mode: StructuredMode, schema: object): Entry {
    const key = this.key(mode, schema);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { session: null, seen: null, turns: 0, queue: Promise.resolve(), primed: false };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private open(entry: Entry, mode: StructuredMode, schema: object): StructuredSession {
    if (entry.session?.alive && entry.turns < this.maxTurns) return entry.session;
    entry.session?.close();
    entry.session = this.driver.structured!.session!({ cwd: this.cwd, schema, mode });
    entry.seen = null;
    entry.turns = 0;
    return entry.session;
  }

  /** Starts the session for this kind of request, so its first answer is quick too. */
  warm(schema: object, mode: StructuredMode = 'research'): void {
    if (this.closed || !this.driver.structured?.session) return;
    const entry = this.entry(mode, schema);
    try {
      this.open(entry, mode, schema).warm();
    } catch {
      // Warming is an optimisation; the request will find out for real.
    }
  }

  /**
   * Starts the session and sends it `parts` — instructions and context, with
   * a task that asks for nothing — before any request, so the first real one
   * is sent as a delta and costs a single short turn. Never falls back to a
   * one-shot request: a prime nobody waits for is not worth a process of its
   * own. Requests queue behind it; resolves once it is done or has failed.
   */
  prime(schema: object, mode: StructuredMode, parts: PromptParts, timeoutMs = 60_000): Promise<void> {
    if (this.closed || !this.driver.structured?.session) return Promise.resolve();
    const entry = this.entry(mode, schema);
    if (entry.primed) return Promise.resolve();
    entry.primed = true;
    const run = entry.queue.then(() => this.primeTurn(entry, schema, mode, parts, timeoutMs));
    entry.queue = run;
    return run;
  }

  private async primeTurn(
    entry: Entry,
    schema: object,
    mode: StructuredMode,
    parts: PromptParts,
    timeoutMs: number,
  ): Promise<void> {
    // Already in a conversation: a request got there first.
    if (this.closed || entry.seen !== null) return;
    const tag = `${mode}/${(schema as { required?: string[] }).required?.join(',') ?? 'schema'}`;
    const text = renderPrompt(parts);
    const started = Date.now();
    try {
      const session = this.open(entry, mode, schema);
      await session.send(text, { timeoutMs });
      this.report(session);
      entry.seen = parts.context;
      entry.turns++;
      debugLog(`advisor ${tag} primed, ${text.length} chars: ${Date.now() - started}ms`);
    } catch (err) {
      entry.seen = null;
      debugLog(`advisor ${tag} priming failed after ${Date.now() - started}ms: ${(err as Error).message}`);
    }
  }

  ask(prompt: string, schema: object, options: PoolAsk = {}): Promise<unknown> {
    const mode = options.mode ?? 'research';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.closed || !this.driver.structured?.session) {
      return this.oneShot(prompt, schema, options.mode, timeoutMs);
    }
    const entry = this.entry(mode, schema);
    const run = entry.queue.then(
      () => this.exchange(entry, prompt, schema, mode, options.parts, timeoutMs),
      () => this.exchange(entry, prompt, schema, mode, options.parts, timeoutMs),
    );
    entry.queue = run.catch(() => {});
    return run;
  }

  private async exchange(
    entry: Entry,
    prompt: string,
    schema: object,
    mode: StructuredMode,
    parts: PromptParts | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const tag = `${mode}/${(schema as { required?: string[] }).required?.join(',') ?? 'schema'}`;
    const attempt = async (fresh: boolean) => {
      if (fresh) entry.session?.close();
      const session = this.open(entry, mode, schema);
      const delta = entry.seen !== null && parts !== undefined;
      const text = delta ? renderDelta(entry.seen!, parts!) : parts ? renderPrompt(parts) : prompt;
      const started = Date.now();
      try {
        const value = await session.send(text, { timeoutMs });
        this.report(session);
        entry.seen = parts?.context ?? null;
        entry.turns++;
        debugLog(`advisor ${tag} turn ${entry.turns}${delta ? ' delta' : ' full'} ${text.length} chars: ${Date.now() - started}ms`);
        return value;
      } catch (err) {
        debugLog(`advisor ${tag}${delta ? ' delta' : ' full'} failed after ${Date.now() - started}ms: ${(err as Error).message}`);
        // What the session knows is no longer certain; start from nothing.
        entry.seen = null;
        throw err;
      }
    };

    try {
      return await attempt(false);
    } catch (err) {
      if (err instanceof SessionTimeoutError || this.closed) throw err;
    }
    try {
      return await attempt(true);
    } catch (err) {
      if (!(err instanceof SessionError) || this.closed) throw err;
      debugLog(`advisor ${tag} falling back to a one-shot request`);
      const started = Date.now();
      const value = await this.oneShot(prompt, schema, mode, timeoutMs);
      debugLog(`advisor ${tag} one-shot: ${Date.now() - started}ms`);
      return value;
    }
  }

  /** Ends every session, and what they shared; later requests go one-shot. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) entry.session?.close();
    this.entries.clear();
    await this.driver.structured?.dispose?.();
  }
}
