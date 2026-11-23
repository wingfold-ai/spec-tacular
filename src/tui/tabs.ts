/**
 * Runs an agent's own session somewhere else: a new tab of the terminal
 * spec-tacular is in, or a new window when that terminal cannot be told to
 * open one — so the TUI stays open, and ctrl+c in the agent reaches only it.
 *
 * The session is a small script under `.spec-tacular/implementing/`. While it
 * runs, a marker holding its pid says so; the TUI watches the markers to know
 * what is being implemented, and to refresh as tasks get ticked off.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface Launcher {
  /** Where it opens, for the notice: "a new GNOME Terminal tab". */
  where: string;
  command: string;
  args: string[];
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env['PATH'] ?? '').split(delimiter).some((d) => d && existsSync(join(d, name)));
}

/**
 * The ways to open `script` elsewhere, best first: a tab of the terminal
 * this runs in, then a window of the system's terminal. Each is tried in
 * turn until one starts.
 */
export function launchers(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Launcher[] {
  const out: Launcher[] = [];
  if (env['TMUX']) out.push({ where: 'a new tmux window', command: 'tmux', args: ['new-window', '-c', cwd, script] });
  if (env['KITTY_WINDOW_ID']) {
    out.push({ where: 'a new kitty tab', command: 'kitty', args: ['@', 'launch', '--type=tab', '--cwd', cwd, script] });
  }
  if (env['WEZTERM_PANE']) {
    out.push({ where: 'a new WezTerm tab', command: 'wezterm', args: ['cli', 'spawn', '--cwd', cwd, '--', script] });
  }
  if (env['GNOME_TERMINAL_SCREEN'] || env['GNOME_TERMINAL_SERVICE']) {
    out.push({ where: 'a new GNOME Terminal tab', command: 'gnome-terminal', args: ['--tab', `--working-directory=${cwd}`, '--', script] });
  }
  if (env['KONSOLE_DBUS_SERVICE']) {
    out.push({ where: 'a new Konsole tab', command: 'konsole', args: ['--new-tab', '--workdir', cwd, '-e', script] });
  }
  if (platform === 'darwin') {
    if (env['TERM_PROGRAM'] === 'iTerm.app') {
      out.push({
        where: 'a new iTerm tab',
        command: 'osascript',
        args: ['-e', `tell application "iTerm2" to tell current window to create tab with default profile command ${JSON.stringify(script)}`],
      });
    }
    out.push({
      where: 'a new Terminal window',
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(q(script))}`, '-e', 'tell application "Terminal" to activate'],
    });
  } else {
    // A terminal that cannot be told to open a tab — an IDE's, say — still
    // has a desktop around it with a terminal of its own.
    if (onPath('gnome-terminal', env)) {
      out.push({ where: 'a new GNOME Terminal window', command: 'gnome-terminal', args: ['--window', `--working-directory=${cwd}`, '--', script] });
    }
    if (onPath('konsole', env)) out.push({ where: 'a new Konsole window', command: 'konsole', args: ['--workdir', cwd, '-e', script] });
    if (onPath('x-terminal-emulator', env)) {
      out.push({ where: 'a new terminal window', command: 'x-terminal-emulator', args: ['-e', script] });
    }
  }
  return out;
}

const dirFor = (root: string) => join(root, '.spec-tacular', 'implementing');

/**
 * Inherited markers that would make the developer's own session something
 * else: started from inside a Claude Code session, the implementing one
 * would count as its child and save no transcript — nothing to resume, and
 * nothing to read what it used from.
 */
export const DROPPED_ENV = ['CLAUDE_CODE_CHILD_SESSION'];

/**
 * Writes the script that runs `command` for `change`: it marks the session
 * running while it lasts, and keeps the tab open once the agent exits so
 * nothing it printed last is lost.
 */
export function writeSessionScript(
  root: string,
  change: string,
  command: { command: string; args: string[]; env?: Record<string, string> },
): string {
  const dir = dirFor(root);
  mkdirSync(dir, { recursive: true });
  // Scripts and pids of this machine's sessions: never for the repository.
  writeFileSync(join(dir, '.gitignore'), '*\n', 'utf8');
  const marker = join(dir, `${change}.pid`);
  const script = join(dir, `${change}.sh`);
  const exports = Object.entries(command.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}`);
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `# spec-tacular: implementing ${change}`,
      `cd ${q(root)} || exit 1`,
      `echo $$ > ${q(marker)}`,
      `trap 'rm -f ${q(marker)}' EXIT`,
      "trap 'exit 130' HUP INT TERM",
      `unset ${DROPPED_ENV.join(' ')}`,
      ...exports,
      [command.command, ...command.args].map(q).join(' '),
      `printf '\\n%s\\n' 'Done — spec-tacular has picked up the tasks ticked off. Press enter to close this tab.'`,
      'read -r _',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
}

/** Opens the session elsewhere; the first launcher that starts wins. */
export function openElsewhere(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; where: string } | { ok: false } {
  for (const l of launchers(script, cwd, env)) {
    const result = spawnSync(l.command, l.args, { cwd, stdio: 'ignore', timeout: 10_000 });
    if (!result.error && result.status === 0) return { ok: true, where: l.where };
  }
  return { ok: false };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The changes whose sessions are running now. A marker whose process is gone
 * — its window closed too hard for the script to clean up — is removed.
 */
export function implementingNow(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dirFor(root)).filter((f) => f.endsWith('.pid'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const file = join(dirFor(root), entry);
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    } catch {
      continue;
    }
    if (Number.isFinite(pid) && alive(pid)) out.push(entry.slice(0, -'.pid'.length));
    else rmSync(file, { force: true });
  }
  return out;
}
