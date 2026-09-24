/**
 * Agent drivers.
 *
 * spec-tacular does not talk to a model. It builds a prompt and hands it to
 * whichever coding agent you already use, as a subprocess. Keeping that behind
 * an interface is deliberate: hardcoding one vendor would make the tool
 * useless to anyone using another, and the whole point of building on OpenSpec
 * is that it works with the tools you have.
 */

export interface AgentRequest {
  /** The full prompt: OpenSpec's instructions plus the context bundle. */
  prompt: string;
  cwd: string;
}

export type StructuredMode = 'research' | 'think' | 'quick';

export interface AgentCommand {
  command: string;
  args: string[];
}

export interface AgentDriver {
  id: string;
  /** Human-readable name for the job pane. */
  label: string;
  /** The command to run. Building it is separate from running it so it is testable. */
  build(request: AgentRequest): AgentCommand;
  /**
   * Renders one line of the agent's stdout for display, or null to drop it.
   * Agents emit a lot of protocol noise that nobody wants tailing past.
   */
  formatLine(line: string): string | null;
  /**
   * A one-shot request answered as JSON matching `schema` — for the advisor,
   * not for writing artifacts. Optional: a driver without it simply means no
   * AI suggestions during setup.
   */
  structured?: {
    /**
     * `research` may look things up on the web (current versions); `think`
     * reasons with no tools; `quick` is a small offline task on a fast model.
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
