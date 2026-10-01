import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { implementingNow, launchers, writeSessionScript } from '../src/tui/tabs.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-tabs-'));
  dirs.push(d);
  return d;
};

/** A PATH holding stand-ins for the named programs. */
const pathWith = (...names: string[]) => {
  const bin = temp();
  for (const n of names) {
    writeFileSync(join(bin, n), '#!/bin/sh\n');
    chmodSync(join(bin, n), 0o755);
  }
  return bin;
};

describe('where a session opens', () => {
  const where = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'linux') =>
    launchers('/p/.spec-tacular/implementing/c.sh', '/p', env, platform).map((l) => l.where);

  test('a tab of the terminal it runs in, first', () => {
    expect(where({ TMUX: '/tmp/tmux-1/default,1,0' })[0]).toBe('a new tmux window');
    expect(where({ KITTY_WINDOW_ID: '1' })[0]).toBe('a new kitty tab');
    expect(where({ WEZTERM_PANE: '0' })[0]).toBe('a new WezTerm tab');
    expect(where({ GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/1' })[0]).toBe('a new GNOME Terminal tab');
    expect(where({ KONSOLE_DBUS_SERVICE: ':1.2' })[0]).toBe('a new Konsole tab');
    expect(where({ TERM_PROGRAM: 'iTerm.app' }, 'darwin')[0]).toBe('a new iTerm tab');
  });

  test('an IDE terminal, which opens no tabs: a window of the desktop terminal', () => {
    const env = { TERMINAL_EMULATOR: 'JetBrains-JediTerm', PATH: pathWith('gnome-terminal', 'x-terminal-emulator') };
    expect(where(env)).toEqual(['a new GNOME Terminal window', 'a new terminal window']);
    expect(where({ TERM_PROGRAM: 'vscode' }, 'darwin')).toEqual(['a new Terminal window']);
    expect(where({ PATH: pathWith() })).toEqual([]);
  });

  test('the tab starts in the project, running the session script', () => {
    const [gnome] = launchers('/p/s.sh', '/p', { GNOME_TERMINAL_SCREEN: 'x' }, 'linux');
    expect(gnome).toEqual({
      where: 'a new GNOME Terminal tab',
      command: 'gnome-terminal',
      args: ['--tab', '--working-directory=/p', '--', '/p/s.sh'],
    });
  });
});

describe('the session', () => {
  test('runs the agent in the project, marked running while it lasts', () => {
    const root = temp();
    const script = writeSessionScript(root, 'book-rooms', {
      command: 'sh',
      args: ['-c', 'pwd > seen; cat .spec-tacular/implementing/book-rooms.pid > pid; echo "$GREETING" > greeting'],
      env: { GREETING: "it's here" },
    });
    // Enter closes the tab once the agent is done.
    const run = spawnSync(script, [], { input: '\n', encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(readFileSync(join(root, 'seen'), 'utf8').trim()).toBe(root);
    expect(readFileSync(join(root, 'pid'), 'utf8').trim()).toMatch(/^\d+$/);
    expect(readFileSync(join(root, 'greeting'), 'utf8').trim()).toBe("it's here");
    expect(run.stdout).toContain('Press enter to close this tab.');
    expect(readFileSync(join(root, '.spec-tacular', 'implementing', '.gitignore'), 'utf8')).toBe('*\n');
    // Over: the marker is gone.
    expect(existsSync(join(root, '.spec-tacular', 'implementing', 'book-rooms.pid'))).toBe(false);
  });

  test('is implementing while its process lives; a marker left by a dead one is cleared', () => {
    const root = temp();
    const dir = join(root, '.spec-tacular', 'implementing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'live.pid'), `${process.pid}\n`);
    writeFileSync(join(dir, 'gone.pid'), '2147483646\n');
    expect(implementingNow(root)).toEqual(['live']);
    expect(existsSync(join(dir, 'gone.pid'))).toBe(false);
    expect(implementingNow(temp())).toEqual([]);
  });
});
