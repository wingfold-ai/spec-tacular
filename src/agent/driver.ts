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
