/**
 * opencode driver.
 *
 * `opencode run <prompt>` is its non-interactive entry point. Its output is
 * already human-readable, so nothing is reinterpreted here.
 *
 * Structured requests (the setup advisor, the vision interview) go through
 * `opencode serve` instead: one headless server per project, started on first
 * use, with a conversation per kind of request that stays open between
 * questions. Its HTTP API takes a JSON Schema per message (`format`) and
 * returns the answer as `structured`; a model that ignores that still gets
 * its JSON found in the reply text, checked, and asked for again once.
 *
 * The model is opencode's default unless SPECTACULAR_OPENCODE_MODEL names one
 * (`provider/model`); SPECTACULAR_OPENCODE_QUICK_MODEL for the small tasks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { extractJson, jsonInstruction, MalformedOutputError, retryInstruction, shapeError } from './json.ts';

/**
 * The read-only agent: it may look things up, never edit the project. Tools
 * are not narrowed further per request — opencode's free models refuse any
 * request whose tool set was changed.
 */
const AGENT = 'plan';

/** `provider/model` for this mode, from the environment, or opencode's default. */
export function opencodeModel(mode: StructuredMode | undefined): string | undefined {
  const main = process.env['SPECTACULAR_OPENCODE_MODEL'] || undefined;
  return mode === 'quick' ? process.env['SPECTACULAR_OPENCODE_QUICK_MODEL'] || main : main;
}

/** `openrouter/anthropic/claude-sonnet-4` → provider `openrouter`, model the rest. */
function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const slash = model?.indexOf('/') ?? -1;
  if (!model || slash <= 0) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

interface Part {
  type?: string;
  text?: string;
}

interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface Reply {
  info?: {
    structured?: unknown;
    error?: { name?: string; data?: { message?: string } };
    cost?: number;
    tokens?: Tokens;
    modelID?: string;
    providerID?: string;
  };
  parts?: Part[];
}

/** What one opencode message cost, from its reply info, or null if it says nothing. */
export function usageFromReply(info: Reply['info']): Usage | null {
  if (!info) return null;
  const tokens = info.tokens;
  const model = info.modelID
    ? info.providerID
      ? `${info.providerID}/${info.modelID}`
      : info.modelID
    : undefined;
  if (info.cost === undefined && !tokens && !model) return null;
  return {
    driver: 'opencode',
    ...(model ? { model } : {}),
    ...(tokens?.input !== undefined ? { inputTokens: tokens.input } : {}),
    ...(tokens?.output !== undefined ? { outputTokens: tokens.output } : {}),
    ...(tokens?.cache?.read !== undefined ? { cacheReadTokens: tokens.cache.read } : {}),
    ...(tokens?.cache?.write !== undefined ? { cacheWriteTokens: tokens.cache.write } : {}),
    ...(info.cost !== undefined ? { costUsd: info.cost } : {}),
  };
}

/** One event from `opencode run --format json`. */
interface RunEvent {
  type?: string;
  part?: { type?: string; text?: string; tool?: string; name?: string; cost?: number; tokens?: Tokens };
  error?: { name?: string; data?: { message?: string }; message?: string };
}

/** An agent's error, or the JSON it answered — validated against `schema`. */
export function readReply(reply: Reply, schema: object): unknown {
  const error = reply.info?.error;
  // A StructuredOutputError means the model did not use the schema tool; its
  // reply text may still hold the answer.
  if (error && error.name !== 'StructuredOutputError') {
    throw new Error(error.data?.message ?? error.name ?? 'opencode reported an error');
  }
  if (reply.info?.structured !== undefined && reply.info.structured !== null) {
    const problem = shapeError(reply.info.structured, schema);
    if (problem) throw new MalformedOutputError(problem);
    return reply.info.structured;
  }
  const text = (reply.parts ?? []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
  return extractJson(text, schema);
}

// ---------------------------------------------------------------------------
// The server

/**
 * One `opencode serve` on a free local port, with a password of its own so
 * nothing else on the machine can drive it.
 */
export class OpencodeServer {
  private child: ChildProcess | null = null;
  private url: Promise<string> | null = null;
  private readonly password = randomBytes(18).toString('base64url');
  private readonly deletions = new Set<Promise<unknown>>();

  constructor(
    private readonly cwd: string,
    private readonly command: AgentCommand = {
      command: 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    },
    private readonly startTimeoutMs = 30_000,
  ) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** The server's URL, starting it if needed. */
  start(): Promise<string> {
    if (this.url && this.running) return this.url;
    this.url = new Promise<string>((resolve, reject) => {
      const child = adopt(spawn(this.command.command, this.command.args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: this.password,
          // A file the developer points at may sit outside the project, and
          // headless nobody can approve reading it. The plan agent still
          // edits nothing, wherever the file is.
          OPENCODE_CONFIG_CONTENT: process.env['OPENCODE_CONFIG_CONTENT']
            ?? JSON.stringify({ permission: { external_directory: 'allow' } }),
        },
      }));
      this.child = child;
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new SessionError(`opencode serve did not start within ${this.startTimeoutMs / 1000}s`));
      }, this.startTimeoutMs);
      const scan = (chunk: Buffer | string) => {
        output = (output + String(chunk)).slice(-4000);
        const found = /listening on (https?:\/\/[^\s]+)/.exec(output);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]!.replace(/\/$/, ''));
        }
      };
      child.stdout!.on('data', scan);
      child.stderr!.on('data', scan);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new SessionError(`opencode could not start: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const last = output.trim().split('\n').at(-1);
        reject(new SessionError(`opencode serve exited${code !== null ? ` with code ${code}` : ''}${last ? `: ${last}` : ''}`));
      });
    });
    // A failed start must not be what every later request gets.
    this.url.catch(() => (this.url = null));
    return this.url;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = await this.start();
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        method,
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new SessionError(`opencode serve is unreachable: ${(err as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SessionError(`opencode serve answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Deletes a session in the background, so it does not clutter opencode's
   * list. Registered at once, even before its id is known, so a `stop` that
   * follows straight after still waits for it.
   */
  forget(id: Promise<string>): void {
    if (!this.running) return;
    const deletion = id.then((known) => this.request('DELETE', `/session/${known}`)).catch(() => {});
    this.deletions.add(deletion);
    void deletion.finally(() => this.deletions.delete(deletion));
  }

  /** Waits briefly for pending deletions, then stops the server. */
  async stop(): Promise<void> {
    if (this.deletions.size > 0) {
      await Promise.race([Promise.allSettled([...this.deletions]), new Promise((r) => setTimeout(r, 1500))]);
    }
    this.child?.kill('SIGTERM');
    this.child = null;
    this.url = null;
  }
}

const servers = new Map<string, OpencodeServer>();

function serverFor(cwd: string): OpencodeServer {
  let server = servers.get(cwd);
  if (!server) servers.set(cwd, (server = new OpencodeServer(cwd)));
  return server;
}

// ---------------------------------------------------------------------------
// A session

/** One opencode conversation, answering in JSON. */
export class OpencodeSession implements StructuredSession {
  private id: Promise<string> | null = null;
  private dead = false;
  private inFlight: AbortController | null = null;
  private usage: Usage | null = null;

  constructor(
    private readonly server: OpencodeServer,
    private readonly schema: object,
    private readonly mode: StructuredMode,
  ) {}

  get alive(): boolean {
    return !this.dead;
  }

  lastUsage(): Usage | null {
    return this.usage;
  }

  private session(): Promise<string> {
    this.id ??= this.server
      .request<{ id: string }>('POST', '/session', { title: `spec-tacular ${this.mode}` })
      .then((s) => s.id);
    return this.id;
  }

  warm(): void {
    if (!this.dead) this.session().catch(() => {});
  }

  private post(id: string, text: string, signal: AbortSignal): Promise<Reply> {
    const model = splitModel(opencodeModel(this.mode));
    return this.server.request<Reply>('POST', `/session/${id}/message`, {
      agent: AGENT,
      ...(model ? { model } : {}),
      format: { type: 'json_schema', schema: this.schema, retryCount: 1 },
      parts: [{ type: 'text', text }],
    }, signal);
  }

  async send(text: string, options: { timeoutMs: number }): Promise<unknown> {
    if (this.dead) throw new SessionError('opencode session is closed');
    const abort = new AbortController();
    this.inFlight = abort;
    const timer = setTimeout(() => abort.abort(), options.timeoutMs);
    let id: string | undefined;
    try {
      id = await this.session();
      try {
        return this.answer(await this.post(id, text, abort.signal));
      } catch (err) {
        if (!(err instanceof MalformedOutputError)) throw err;
        // Once, with what was wrong and the shape spelled out in words.
        const retry = `${retryInstruction(err.message)}\n\n${jsonInstruction(this.schema)}`;
        return this.answer(await this.post(id, retry, abort.signal));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        if (id) void this.server.request('POST', `/session/${id}/abort`).catch(() => {});
        this.close();
        throw new SessionTimeoutError(`opencode did not answer within ${Math.round(options.timeoutMs / 1000)}s`);
      }
      if (err instanceof SessionError) this.close();
      throw err;
    } finally {
      clearTimeout(timer);
      this.inFlight = null;
    }
  }

  /** The value in a reply, with its usage remembered for the sidebar. */
  private answer(reply: Reply): unknown {
    const usage = usageFromReply(reply.info);
    if (usage) this.usage = usage;
    return readReply(reply, this.schema);
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.inFlight?.abort();
    if (this.id) this.server.forget(this.id);
  }
}

/**
 * What the agent said last in a `run --format json` log: the text after its
 * last tool call — one reply can arrive as several text events.
 */
export function finalMessageFromRun(log: string): string | null {
  let texts: string[] = [];
  for (const line of log.split('\n')) {
    let event: RunEvent;
    try {
      event = JSON.parse(line.trim()) as RunEvent;
    } catch {
      continue;
    }
    if (event.type === 'text' && event.part?.text?.trim()) texts.push(event.part.text.trim());
    else if (event.type === 'tool' || event.type === 'tool_use' || event.type === 'tool_call') texts = [];
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// The driver

export const opencodeDriver: AgentDriver = {
  id: 'opencode',
  label: 'opencode',
  interactive(prompt: string): AgentCommand {
    return { command: 'opencode', args: ['--prompt', prompt] };
  },

  build(request: AgentRequest): AgentCommand {
    // JSON events rather than prose: they carry what each step cost, and can
    // be rendered back into readable lines by `formatLine`.
    return { command: 'opencode', args: ['run', '--format', 'json', request.prompt] };
  },

  /**
   * `opencode run --format json` emits one event per line; a line that is not
   * an event is the CLI's own diagnostics, worth showing verbatim.
   */
  formatLine(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    let event: RunEvent;
    try {
      event = JSON.parse(trimmed) as RunEvent;
    } catch {
      return trimmed;
    }
    switch (event.type) {
      case 'text': {
        const text = event.part?.text?.trim();
        return text ? text : null;
      }
      case 'tool':
      case 'tool_use':
      case 'tool_call': {
        const name = event.part?.tool ?? event.part?.name;
        return name ? `· ${name}` : null;
      }
      case 'step_finish': {
        const cost = event.part?.cost;
        return cost !== undefined ? `done · $${cost.toFixed(4)}` : null;
      }
      case 'error':
        return `failed: ${event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? 'unknown error'}`;
      default:
        return null;
    }
  },

  finalMessage: finalMessageFromRun,

  parseUsage(line: string): Usage | null {
    let event: RunEvent;
    try {
      event = JSON.parse(line.trim()) as RunEvent;
    } catch {
      return null;
    }
    if (event.type !== 'step_finish') return null;
    const tokens = event.part?.tokens;
    return {
      driver: 'opencode',
      ...(event.part?.cost !== undefined ? { costUsd: event.part.cost } : {}),
      ...(tokens?.input !== undefined ? { inputTokens: tokens.input } : {}),
      ...(tokens?.output !== undefined ? { outputTokens: tokens.output } : {}),
      ...(tokens?.cache?.read !== undefined ? { cacheReadTokens: tokens.cache.read } : {}),
      ...(tokens?.cache?.write !== undefined ? { cacheWriteTokens: tokens.cache.write } : {}),
    };
  },

  model: opencodeModel,

  structured: {
    build(request): AgentCommand {
      const model = opencodeModel(request.mode);
      return {
        command: 'opencode',
        args: [
          'run',
          '--format',
          'json',
          '--agent',
          AGENT,
          ...(model ? ['--model', model] : []),
          `${request.prompt}\n\n${jsonInstruction(request.schema)}`,
        ],
      };
    },
    parse(stdout: string, schema?: object): unknown {
      const texts: string[] = [];
      let error: string | null = null;
      for (const line of stdout.split('\n')) {
        let event: { type?: string; part?: Part; error?: { name?: string; data?: { message?: string }; message?: string } };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          continue;
        }
        if (event.type === 'text' && event.part?.text) texts.push(event.part.text);
        if (event.type === 'error') {
          error = event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? 'opencode reported an error';
        }
      }
      if (texts.length === 0 && error) throw new Error(error);
      return extractJson(texts.join('\n'), schema);
    },
    session({ cwd, schema, mode }) {
      return new OpencodeSession(serverFor(cwd), schema, mode);
    },
    async dispose() {
      await Promise.all([...servers.values()].map((s) => s.stop()));
      servers.clear();
    },
  },
};
