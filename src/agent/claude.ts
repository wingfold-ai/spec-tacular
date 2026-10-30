/**
 * Claude Code driver.
 *
 * `claude -p` is the non-interactive mode. `stream-json` is used rather than
 * plain text because it arrives incrementally — a job pane that only fills in
 * once the agent finishes is not a job pane.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adopt } from './children.ts';
import type { Usage } from '../core/usage.ts';
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
  message?: { content?: string | ContentPart[] };
  result?: string;
  is_error?: boolean;
  structured_output?: unknown;
  errors?: string[];
  model?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

/** A path as the log shows it: relative to the project the job runs in. */
function shortPath(path: string): string {
  const root = `${process.cwd()}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

const oneLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/** A tool call as one line: what it did, not only which tool. */
export function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  const path = str('file_path') ?? str('notebook_path') ?? str('path');
  switch (name) {
    case 'Bash':
      return `$ ${oneLine(str('command') ?? '')}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? `· ${name} ${shortPath(path)}` : `· ${name}`;
    case 'Grep':
    case 'Glob':
      return `· ${name} ${oneLine(str('pattern') ?? '')}${path ? ` in ${shortPath(path)}` : ''}`;
    case 'WebFetch':
      return `· ${name} ${str('url') ?? ''}`;
    case 'WebSearch':
      return `· ${name} ${oneLine(str('query') ?? '')}`;
    case 'TodoWrite':
      return '· updating its task list';
    default:
      return `· ${name}`;
  }
}

/** A tool result's text, whichever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : '')).join(' ');
  }
  return '';
}

/**
 * What a Claude `result` event says the request cost, or null when it carries
 * no usage at all. `modelUsage` names the model that actually ran, which is
 * more truthful than the flag that was asked for.
 */
export function usageFromResult(event: StreamEvent): Usage | null {
  if (event.type !== 'result') return null;
  const models = Object.keys(event.modelUsage ?? {});
  const model = models[0] ?? event.model;
  const usage = event.usage;
  if (event.total_cost_usd === undefined && !usage && !model) return null;
  return {
    driver: 'claude',
    ...(model ? { model } : {}),
    ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage?.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
    ...(event.total_cost_usd !== undefined ? { costUsd: event.total_cost_usd } : {}),
    ...(event.duration_ms !== undefined ? { durationMs: event.duration_ms } : {}),
    ...(event.num_turns !== undefined ? { turns: event.num_turns } : {}),
  };
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

/**
 * The model a structured request asks for, or undefined to run on Claude
 * Code's own default — the one the developer chose there. Only an explicit
 * SPECTACULAR_*_MODEL overrides it.
 */
function chosenModel(mode: StructuredMode = 'research'): string | undefined {
  const env = process.env[mode === 'quick' ? 'SPECTACULAR_QUICK_MODEL' : 'SPECTACULAR_ADVISOR_MODEL'];
  return env || undefined;
}

/** Whether the developer's MCP servers are loaded; SPECTACULAR_NO_MCP opts out. */
function mcpEnabled(): boolean {
  return !process.env['SPECTACULAR_NO_MCP'];
}

const ALLOW_MCP_HOOK = fileURLToPath(new URL('./allow-mcp.mjs', import.meta.url));

/** The argument that makes `spec-tacular` run the allow hook (src/cli.ts). */
export const ALLOW_MCP_HOOK_ARG = '__allow-mcp-hook';

/**
 * A compiled binary carries its modules in Bun's embedded filesystem, so
 * there is no allow-mcp.mjs on disk to hand Claude Code; the binary runs the
 * hook itself instead.
 */
const compiled = import.meta.url.includes('$bunfs') || import.meta.url.includes('~BUN');

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The developer's MCP servers, loaded as Claude Code loads them, and usable:
 * headless, nobody can approve a call, so a hook approves every MCP tool
 * except the servers SPECTACULAR_MCP_DENY names. Only MCP tools: the built-in
 * ones keep the limits each request sets. SPECTACULAR_NO_MCP starts none,
 * which also starts each session faster.
 */
export function mcpFlags(): string[] {
  if (!mcpEnabled()) return ['--strict-mcp-config'];
  const hook = `${shellQuote(process.execPath)} ${compiled ? ALLOW_MCP_HOOK_ARG : shellQuote(ALLOW_MCP_HOOK)}`;
  return [
    '--settings',
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: hook }] }] } }),
  ];
}

/**
 * What every structured request may use, whatever its mode: the developer
 * writes answers as they would to Claude Code itself — "see docs/notes.md",
 * a pasted link — so the files and pages they point at must be readable.
 */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'];

/** Model, tools and schema for a structured request, one-shot or session. */
function structuredFlags(schema: object, mode: StructuredMode = 'research'): string[] {
  const model = chosenModel(mode);
  const builtIn = [
    ...READ_TOOLS,
    ...(mode === 'research' ? ['WebSearch'] : []),
    // MCP tools are deferred: the agent finds and loads them with ToolSearch.
    ...(mcpEnabled() ? ['ToolSearch'] : []),
  ];
  return [
    '--json-schema',
    JSON.stringify(schema),
    ...(model ? ['--model', model] : []),
    // Reading, never editing or running anything: the advisor answers
    // questions, the artifact jobs are what change the project.
    '--tools',
    builtIn.join(','),
    '--allowedTools',
    ...builtIn,
    '--no-session-persistence',
    ...mcpFlags(),
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
  private usage: Usage | null = null;
  /** The session's running total so far: each `result` reports the sum, not the turn. */
  private costSoFar = 0;

  constructor(
    private readonly command: AgentCommand,
    private readonly cwd: string,
    private readonly label = 'Claude Code',
  ) {}

  get alive(): boolean {
    return !this.dead;
  }

  lastUsage(): Usage | null {
    return this.usage;
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
    this.usage = usageFromResult(event);
    // total_cost_usd in a long-running session is everything since it
    // started; the token counts are this turn's. Keep the cost per turn too.
    if (this.usage?.costUsd !== undefined) {
      const total = this.usage.costUsd;
      this.usage.costUsd = Math.max(total - this.costSoFar, 0);
      this.costSoFar = total;
    }
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

/** What an implementing session may run without asking: it only looks. */
const READ_ONLY_TOOLS = [
  'Bash(openspec list:*)',
  'Bash(openspec show:*)',
  'Bash(openspec status:*)',
  'Bash(openspec validate:*)',
  'Bash(ls:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  // What a test run's output is read through.
  'Bash(grep:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(sort:*)',
  'Bash(cat:*)',
];

export const claudeDriver: AgentDriver = {
  id: 'claude',
  label: 'Claude Code',

  interactive(prompt: string, allow: string[] = [], sessionId?: string): AgentCommand {
    // The developer's own session, in the permission mode they use — auto,
    // accept edits, ask — never one chosen for them: overriding auto mode
    // turned an unattended session into 22 prompts. What is added only
    // widens it: the project's tests and checks, and commands that only
    // look, so a test run piped into grep does not ask either.
    return {
      command: 'claude',
      // The prompt first: --allowedTools takes every argument after it.
      args: [
        prompt,
        ...(sessionId ? ['--session-id', sessionId] : []),
        '--allowedTools',
        ...READ_ONLY_TOOLS,
        ...allow.map((prefix) => `Bash(${prefix}:*)`),
        ...extraArgs(),
      ],
    };
  },

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
        ...mcpFlags(),
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

    const parts = Array.isArray(event.message?.content) ? event.message.content : [];

    if (event.type === 'assistant') {
      const out = parts.flatMap((p) => {
        if (p.type === 'text' && p.text?.trim()) return [p.text.trim()];
        if (p.type === 'tool_use' && p.name) return [describeToolUse(p.name, p.input)];
        return [];
      });
      return out.length > 0 ? out.join('\n') : null;
    }

    // What a tool answered is noise — unless it refused or failed, which is
    // exactly what explains an agent that stops short.
    if (event.type === 'user') {
      const failed = parts
        .filter((p) => p.type === 'tool_result' && p.is_error)
        .map((p) => `  ✗ ${oneLine(resultText(p.content))}`);
      return failed.length > 0 ? failed.join('\n') : null;
    }

    if (event.type === 'result') {
      const usage = usageFromResult(event);
      const cost = usage?.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(4)}` : '';
      const denied = event.permission_denials?.length ?? 0;
      const refused = denied > 0 ? ` · ${denied} tool call${denied === 1 ? '' : 's'} refused` : '';
      return event.is_error ? `failed: ${event.result ?? 'unknown error'}` : `done${cost}${refused}`;
    }

    // System init, user echoes, partial chunks: protocol noise.
    return null;
  },

  finalMessage(lines: string[]): string | null {
    let last: string | null = null;
    for (const line of lines) {
      let event: StreamEvent;
      try {
        event = JSON.parse(line.trim()) as StreamEvent;
      } catch {
        continue;
      }
      // The result repeats the last reply in full; the reply itself is the
      // fallback for a run cut off before it.
      if (event.type === 'result' && typeof event.result === 'string' && event.result.trim()) {
        last = event.result.trim();
      } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        const text = event.message.content
          .filter((p) => p.type === 'text' && p.text?.trim())
          .map((p) => p.text!.trim())
          .join('\n\n');
        if (text) last = text;
      }
    }
    return last;
  },

  parseUsage(line: string): Usage | null {
    try {
      return usageFromResult(JSON.parse(line.trim()) as StreamEvent);
    } catch {
      return null;
    }
  },

  model(mode?: StructuredMode): string | undefined {
    // Without an override every request runs on Claude Code's own default,
    // which only it knows; the sidebar shows the model a reply reports.
    return mode ? chosenModel(mode) : undefined;
  },
};
