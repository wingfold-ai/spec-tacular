/**
 * Claude Code driver.
 *
 * `claude -p` is the non-interactive mode. `stream-json` is used rather than
 * plain text because it arrives incrementally — a job pane that only fills in
 * once the agent finishes is not a job pane.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { adopt } from './children.ts';
import {
  SessionError,
  SessionTimeoutError,
  type AgentCommand,
  type AgentDriver,
  type AgentRequest,
  type StructuredMode,
  type StructuredSession,
} from './driver.ts';

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: { type?: string; text?: string; name?: string }[] };
  result?: string;
  is_error?: boolean;
  structured_output?: unknown;
  errors?: string[];
}

/** Extra flags from the environment, split on whitespace. */
function extraArgs(): string[] {
  return (process.env['SPECTACULAR_CLAUDE_ARGS'] ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Extended thinking, off unless asked for. It is most of what an advisor
 * request costs in time: measured on one follow-up with haiku, 3,500 output
 * tokens and 39 s with it, 490 tokens and 7 s without — for options of the
 * same quality. SPECTACULAR_ADVISOR_THINKING=1 turns it back on.
 */
function structuredEnv(): Record<string, string> | undefined {
  return process.env['SPECTACULAR_ADVISOR_THINKING'] ? undefined : { MAX_THINKING_TOKENS: '0' };
}

/** Model, tools and schema for a structured request, one-shot or session. */
function structuredFlags(schema: object, mode: StructuredMode = 'research'): string[] {
  return [
    '--json-schema',
    JSON.stringify(schema),
    '--model',
    mode === 'quick'
      ? (process.env['SPECTACULAR_QUICK_MODEL'] ?? 'haiku')
      : (process.env['SPECTACULAR_ADVISOR_MODEL'] ?? 'sonnet'),
    // Web search at most: the advisor looks up current versions, and has
    // no business reading or editing the project. Other modes need none.
    ...(mode === 'research'
      ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch']
      : ['--tools', '']),
    '--no-session-persistence',
    // The user's MCP servers are irrelevant here and slow to start.
    '--strict-mcp-config',
  ];
}

/**
 * A Claude Code process kept open on stream-json: one user message per line
 * on stdin, one `result` event per answer on stdout.
 *
 * Exported so tests can drive it against a fake agent that speaks the same
 * protocol.
 */
export class StreamJsonSession implements StructuredSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private pending: {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private dead = false;

  constructor(
    private readonly command: AgentCommand,
    private readonly cwd: string,
    private readonly label = 'Claude Code',
  ) {}

  get alive(): boolean {
    return !this.dead;
  }

  warm(): void {
    if (!this.dead) this.start();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command.command, this.command.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.command.env ? { ...process.env, ...this.command.env } : process.env,
    });
    adopt(child);
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.handle(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2000);
    });
    // Writing to a process that just died must fail the request, not crash us.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.fail(new SessionError(`${this.label} could not start: ${err.message}`)));
    child.on('exit', (code, signal) => {
      const why = this.stderr.trim().split('\n').at(-1);
      const how = code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : '';
      this.fail(new SessionError(`${this.label} exited${how}${why ? `: ${why}` : ''}`));
    });
    return child;
  }

  send(text: string, options: { timeoutMs: number }): Promise<unknown> {
    if (this.dead) return Promise.reject(new SessionError(`${this.label} session is closed`));
    if (this.pending) return Promise.reject(new Error('A session answers one request at a time'));
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Whatever it is still working on would arrive as the answer to the
        // next question, so a session that timed out is finished.
        this.fail(new SessionTimeoutError(
          `${this.label} did not answer within ${Math.round(options.timeoutMs / 1000)}s`,
        ));
      }, options.timeoutMs);
      this.pending = { resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    });
  }

  private handle(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return; // not protocol: diagnostics, which stderr already keeps
    }
    if (event.type !== 'result' || !this.pending) return;
    const { resolve, reject, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    if (event.is_error || (event.subtype && event.subtype !== 'success')) {
      reject(new Error(event.result ?? event.errors?.join('; ') ?? `${this.label} reported an error`));
    } else if (event.structured_output === undefined) {
      reject(new Error(`${this.label} returned no structured output`));
    } else {
      resolve(event.structured_output);
    }
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
  }

  close(): void {
    this.fail(new SessionError(`${this.label} session was closed`));
  }
}

export const claudeDriver: AgentDriver = {
  id: 'claude',
  label: 'Claude Code',

  build(request: AgentRequest): AgentCommand {
    return {
      command: 'claude',
      args: [
        '-p',
        request.prompt,
        '--output-format',
        'stream-json',
        // stream-json requires --verbose; without it the CLI refuses to start,
        // which would look like a driver bug rather than a missing flag.
        '--verbose',
        // Headless, nobody is there to approve a tool call, so each one is
        // denied — and the agent "succeeds" having printed its artifact
        // instead of writing it. Editing files in the project is the job;
        // OpenSpec's read-only commands are how it looks at existing specs.
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash(openspec list:*)',
        'Bash(openspec show:*)',
        'Bash(openspec status:*)',
        'Bash(openspec validate:*)',
        'Bash(ls:*)',
        // Anything more — running tests during apply, say — is the project's
        // call: SPECTACULAR_CLAUDE_ARGS='--allowedTools Bash(bun test:*)'.
        ...extraArgs(),
      ],
    };
  },

  structured: {
    build(request): AgentCommand {
      return {
        command: 'claude',
        args: ['-p', request.prompt, '--output-format', 'json', ...structuredFlags(request.schema, request.mode)],
        env: structuredEnv(),
      };
    },
    parse(stdout: string): unknown {
      const result = JSON.parse(stdout) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
      };
      if (result.is_error) throw new Error(result.result ?? 'Claude Code reported an error');
      if (result.structured_output === undefined) {
        throw new Error('Claude Code returned no structured output');
      }
      return result.structured_output;
    },
    session({ cwd, schema, mode }) {
      return new StreamJsonSession(
        {
          command: 'claude',
          args: [
            '-p',
            // A JSON message per line in, an event per line out, for as long as
            // stdin stays open. --json-schema still holds for every turn: each
            // `result` event carries its own structured_output.
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            ...structuredFlags(schema, mode),
          ],
          env: structuredEnv(),
        },
        cwd,
      );
    },
  },

  formatLine(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      // Not JSON: the CLI's own diagnostics, which are worth showing verbatim
      // since they are usually why a job failed.
      return trimmed;
    }

    if (event.type === 'assistant') {
      const parts = event.message?.content ?? [];
      const text = parts
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text;

      const tools = parts.filter((p) => p.type === 'tool_use' && p.name).map((p) => p.name!);
      return tools.length > 0 ? `· ${tools.join(', ')}` : null;
    }

    if (event.type === 'result') {
      return event.is_error ? `failed: ${event.result ?? 'unknown error'}` : 'done';
    }

    // System init, user echoes, partial chunks: protocol noise.
    return null;
  },
};
