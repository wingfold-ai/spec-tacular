/**
 * The system clipboard, for a terminal program that has no direct access to
 * it.
 *
 * A terminal hands a program keystrokes, not the clipboard: ctrl+v arrives
 * as a bare control character, and the program captures the mouse, so the
 * terminal's own selection is gone too. Reading and writing therefore go
 * through whatever the desktop offers — `wl-copy` on Wayland, `xclip` or
 * `xsel` on X11, `pbcopy` on macOS — and, for copying, the terminal itself
 * through OSC 52, which is also the only way that reaches the clipboard of
 * the machine you sit at when this runs over SSH.
 *
 * The commands are run through an injected runner, so tests exercise every
 * platform without touching anyone's real clipboard.
 */

import { spawn } from 'node:child_process';
import { onPath } from '../agent/structured.ts';

export interface RunOptions {
  /** Written to the command's stdin, which is then closed. */
  input?: string;
  /** Whether stdout is wanted. A copy command must not have it piped. */
  capture: boolean;
  timeoutMs: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
}

/** Runs one command. The seam tests replace. */
export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

export type ReadResult = { ok: true; text: string } | { ok: false; reason: string };
export type WriteResult = { ok: true; via: string } | { ok: false; reason: string };

export interface ClipboardPort {
  read(): Promise<ReadResult>;
  write(text: string): Promise<WriteResult>;
}

type Command = [command: string, args: string[]];

/** Where the clipboard lives, as far as the environment tells. */
export interface ClipboardEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether a command is installed. */
  has: (command: string) => boolean;
}

/**
 * The commands that read the clipboard, best first.
 *
 * Wayland before X11: a Wayland session usually runs XWayland too, so both
 * variables are set, and xclip there reads a clipboard native apps never
 * wrote to.
 */
export function readCommands(where: ClipboardEnvironment): Command[] {
  const out: Command[] = [];
  if (where.platform === 'darwin') out.push(['pbpaste', []]);
  if (where.platform === 'win32') out.push(['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]);
  if (where.env['WAYLAND_DISPLAY']) out.push(['wl-paste', ['--no-newline']]);
  if (where.env['DISPLAY']) {
    out.push(['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]);
  }
  return out.filter(([command]) => where.has(command));
}

/** The commands that write the clipboard, best first. */
export function writeCommands(where: ClipboardEnvironment): Command[] {
  const out: Command[] = [];
  if (where.platform === 'darwin') out.push(['pbcopy', []]);
  if (where.platform === 'win32') out.push(['clip', []]);
  if (where.env['WAYLAND_DISPLAY']) out.push(['wl-copy', []]);
  if (where.env['DISPLAY']) {
    out.push(['xclip', ['-selection', 'clipboard', '-i']], ['xsel', ['--clipboard', '--input']]);
  }
  return out.filter(([command]) => where.has(command));
}

/**
 * Over SSH the commands above reach the remote machine's clipboard, which is
 * nobody's: only the terminal, through OSC 52, reaches yours.
 */
export function isRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_TTY'] || env['SSH_CLIENT']);
}

/**
 * OSC 52, the escape sequence that asks the terminal to set its clipboard.
 * Wrapped for tmux, which otherwise swallows it.
 */
export function osc52(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const sequence = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  return env['TMUX'] ? `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : sequence;
}

/** Spawns a command; never rejects, and never waits on a forked daemon. */
export const spawnRunner: Runner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // `wl-copy` and `xclip` fork a process that keeps serving the
      // clipboard. A piped stdout would stay open in it and `close` would
      // never come, so a copy ignores its output and waits for `exit` only.
      child = spawn(command, args, { stdio: ['pipe', options.capture ? 'pipe' : 'ignore', 'ignore'] });
    } catch {
      return resolve({ code: null, stdout: '' });
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => done(null));
    if (options.capture) child.on('close', (code) => done(code));
    else child.on('exit', (code) => done(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });

export interface SystemClipboardOptions {
  runner?: Runner;
  where?: ClipboardEnvironment;
  /**
   * Sends OSC 52 to the terminal; true when it was sent. The renderer owns
   * the terminal, so it is the one that writes the sequence.
   */
  osc52?: (text: string) => boolean;
  timeoutMs?: number;
}

/** The clipboard through the desktop's commands, and the terminal's. */
export class SystemClipboard implements ClipboardPort {
  private readonly runner: Runner;
  private readonly where: ClipboardEnvironment;
  private readonly osc52: ((text: string) => boolean) | undefined;
  private readonly timeoutMs: number;

  constructor(options: SystemClipboardOptions = {}) {
    this.runner = options.runner ?? spawnRunner;
    this.where = options.where ?? {
      platform: process.platform,
      env: process.env,
      has: (command) => onPath(command),
    };
    this.osc52 = options.osc52;
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  async read(): Promise<ReadResult> {
    const commands = readCommands(this.where);
    if (commands.length === 0) {
      // A terminal cannot be asked for its clipboard, only told to set it:
      // pasting has to go through the terminal's own paste then.
      return {
        ok: false,
        reason: 'No clipboard tool found (wl-paste, xclip, xsel or pbpaste) — paste with ctrl+shift+v instead',
      };
    }
    for (const [command, args] of commands) {
      const result = await this.runner(command, args, { capture: true, timeoutMs: this.timeoutMs });
      if (result.code === 0) return { ok: true, text: result.stdout };
    }
    // wl-paste exits non-zero on an empty clipboard, which is not an error.
    return { ok: false, reason: 'The clipboard is empty, or could not be read' };
  }

  async write(text: string): Promise<WriteResult> {
    const remote = isRemote(this.where.env);
    if (!remote) {
      for (const [command, args] of writeCommands(this.where)) {
        const result = await this.runner(command, args, {
          input: text,
          capture: false,
          timeoutMs: this.timeoutMs,
        });
        if (result.code === 0) return { ok: true, via: command };
      }
    }
    // No desktop tool, or it failed, or it would copy on the wrong machine.
    if (this.osc52?.(text)) return { ok: true, via: 'terminal' };
    return {
      ok: false,
      reason: 'No clipboard tool found (wl-copy, xclip, xsel or pbcopy), and the terminal does not take OSC 52',
    };
  }
}

/**
 * Pasted text made fit for the input it lands in.
 *
 * Line endings become `\n`, and control characters — the escape sequences a
 * terminal may leave in a paste — are dropped. A one-line input gets its
 * lines joined with spaces rather than losing all but the first.
 */
export function cleanPaste(text: string, multiline: boolean): string {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  if (multiline) return lines;
  return lines.split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ');
}
