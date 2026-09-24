import { describe, expect, test } from 'bun:test';
import { claudeDriver, defaultRegistry, opencodeDriver, DriverNotFoundError } from '../src/agent/index.ts';

describe('claude driver', () => {
  const built = claudeDriver.build({ prompt: 'write the design', cwd: '/p' });

  test('runs non-interactively with streaming output', () => {
    expect(built.command).toBe('claude');
    expect(built.args).toContain('-p');
    expect(built.args).toContain('stream-json');
    // stream-json requires --verbose; without it the CLI refuses to start,
    // which would look like a driver bug rather than a missing flag.
    expect(built.args).toContain('--verbose');
    // Without it, a headless agent's every write is denied and it prints the
    // artifact instead of writing it.
    expect(built.args[built.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(built.args).toContain('Bash(openspec list:*)');
  });

  test('passes the prompt as one argv entry, never interpolated', () => {
    const nasty = claudeDriver.build({ prompt: 'a "b" $(echo c)', cwd: '/p' });
    expect(nasty.args).toContain('a "b" $(echo c)');
  });

  test('renders assistant text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Writing design.md' }] },
    });
    expect(claudeDriver.formatLine(line)).toBe('Writing design.md');
  });

  test('renders tool use compactly', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write' }] },
    });
    expect(claudeDriver.formatLine(line)).toBe('· Write');
  });

  test('reports the result, success or failure', () => {
    expect(claudeDriver.formatLine(JSON.stringify({ type: 'result', result: 'ok' }))).toBe('done');
    expect(
      claudeDriver.formatLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })),
    ).toBe('failed: boom');
  });

  test('drops protocol noise', () => {
    expect(claudeDriver.formatLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
    expect(claudeDriver.formatLine('')).toBeNull();
    expect(claudeDriver.formatLine('   ')).toBeNull();
  });

  test('shows non-JSON output verbatim — it is usually why a job failed', () => {
    expect(claudeDriver.formatLine('command not found: claude')).toBe('command not found: claude');
  });

  test('an assistant message with neither text nor tools is dropped', () => {
    expect(
      claudeDriver.formatLine(JSON.stringify({ type: 'assistant', message: { content: [] } })),
    ).toBeNull();
  });
});

describe('opencode driver', () => {
  test('uses its non-interactive run subcommand', () => {
    const built = opencodeDriver.build({ prompt: 'go', cwd: '/p' });
    expect(built).toEqual({ command: 'opencode', args: ['run', 'go'] });
  });

  test('passes output through unchanged', () => {
    expect(opencodeDriver.formatLine('hello')).toBe('hello');
    expect(opencodeDriver.formatLine('  ')).toBeNull();
  });
});

describe('registry', () => {
  test('knows both drivers', () => {
    expect(defaultRegistry().ids().sort()).toEqual(['claude', 'opencode']);
  });

  test('an unknown driver names the ones that exist', () => {
    expect(() => defaultRegistry().get('nope')).toThrow(DriverNotFoundError);
    try {
      defaultRegistry().get('nope');
    } catch (err) {
      expect((err as Error).message).toContain('claude, opencode');
    }
  });
});
