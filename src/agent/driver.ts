/**
 * Agent drivers.
 *
 * spec-tacular does not talk to a model. It builds a prompt and hands it to
 * whichever coding agent you already use, as a subprocess. Keeping that behind
 * an interface is deliberate: hardcoding one vendor would make the tool
 * useless to anyone using another, and the whole point of building on OpenSpec
 * is that it works with the tools you have.
 */

import type { Usage } from '../core/usage.ts';

export interface AgentRequest {
  /** The full prompt: OpenSpec's instructions plus the context bundle. */
  prompt: string;
  cwd: string;
}

export type StructuredMode = 'research' | 'think' | 'quick';

export interface AgentCommand {
  command: string;
  args: string[];
  /** Added to the environment it runs in. */
  env?: Record<string, string>;
}

export interface AgentDriver {
  id: string;
  /** Human-readable name for the job pane. */
  label: string;
  /** The command to run. Building it is separate from running it so it is testable. */
  build(request: AgentRequest): AgentCommand;
  /**
   * The agent's own interactive session, started on `prompt`: run in the
   * developer's terminal, it asks for permissions exactly as it would if they
   * had started it themselves. How implementing runs — optional: without it
   * a driver implements in the background like it drafts.
   *
   * `allow` is the shell commands implementing needs — the project's tests,
   * spec-tacular's checks — as command prefixes (`bun test`); a driver that
   * can pre-approve them does, so the developer is asked about the rest.
   * `sessionId`, when the driver can name its session, is what it is
   * started as — so what it used can be read afterwards.
   */
  interactive?(prompt: string, allow?: string[], sessionId?: string): AgentCommand;
  /**
   * Renders one line of the agent's stdout for display, or null to drop it.
   * Agents emit a lot of protocol noise that nobody wants tailing past.
   */
  formatLine(line: string): string | null;
  /**
   * Usage reported by one line of a finished job's output, or null. Optional:
   * a driver that does not report cost simply shows no cost for its jobs.
   */
  parseUsage?(line: string): Usage | null;
  /**
   * What the agent said last, from a finished job's whole log, or null. An
   * agent that stops without writing the artifact explains why there — and
   * the developer should read that without digging through the log.
   */
  finalMessage?(log: string): string | null;
  /**
   * The model this driver uses for a kind of request, when one is configured.
   * `undefined` means the agent's own default, which only it knows.
   */
  model?(mode?: StructuredMode): string | undefined;
  /**
   * A one-shot request answered as JSON matching `schema` — for the advisor,
   * not for writing artifacts. Optional: a driver without it simply means no
   * AI suggestions during setup.
   */
  structured?: {
    /**
     * Every mode may read the files and links the developer points at.
     * `research` may also search the web (current versions); `think` reasons
     * without searching; `quick` is a small task on a fast model.
     */
    build(request: AgentRequest & { schema: object; mode?: StructuredMode }): AgentCommand;
    /**
     * The structured value from the command's stdout; throws on failure. A
     * `MalformedOutputError` (agent/json.ts) earns one retry with its reason.
     */
    parse(stdout: string, schema?: object): unknown;
    /**
     * Optional: a long-running session that answers one request after
     * another, so each question does not pay for starting an agent and
     * re-reading everything. Model, tools and schema are fixed per session.
     */
    session?(request: { cwd: string; schema: object; mode: StructuredMode }): StructuredSession;
    /** Stops whatever the sessions shared, such as a server. After closing them. */
    dispose?(): Promise<void>;
  };
}

/** One live conversation with an agent, answering in JSON. */
export interface StructuredSession {
  /**
   * Sends one message and resolves with its structured answer. The caller
   * sends one at a time; what the session was told before is still known.
   */
  send(text: string, options: { timeoutMs: number }): Promise<unknown>;
  /** Starts the agent ahead of the first message, so that one is quick too. */
  warm(): void;
  /** Usage for the most recent turn, when the agent reports one. */
  lastUsage?(): Usage | null;
  /** False once it died, errored beyond use, or was closed. */
  readonly alive: boolean;
  close(): void;
}

/**
 * The session itself failed — would not start, died, or broke protocol — as
 * opposed to the model answering with an error. Only this is worth falling
 * back to a one-shot process for: a model error would simply repeat.
 */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * The session did not answer in time. Not retried: the wait the developer
 * was promised is already spent, and the next request starts a fresh one.
 */
export class SessionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTimeoutError';
  }
}

/** Passes stdout through unchanged. The right default for a plain-text agent. */
export function passthrough(line: string): string | null {
  return line.trim() === '' ? null : line;
}

export class DriverNotFoundError extends Error {
  constructor(id: string, known: string[]) {
    super(`Unknown agent driver '${id}'. Known drivers: ${known.join(', ')}.`);
    this.name = 'DriverNotFoundError';
  }
}

export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>();

  register(driver: AgentDriver): this {
    this.drivers.set(driver.id, driver);
    return this;
  }

  get(id: string): AgentDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new DriverNotFoundError(id, [...this.drivers.keys()]);
    return driver;
  }

  ids(): string[] {
    return [...this.drivers.keys()];
  }
}
