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

  test('says what each tool call did', () => {
    const use = (name: string, input: object) =>
      claudeDriver.formatLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }));
    expect(use('Read', { file_path: `${process.cwd()}/openspec/changes/c/design.md` })).toBe('· Read openspec/changes/c/design.md');
    expect(use('Bash', { command: 'pnpm   test\n  --run', description: 'Run the tests' })).toBe('$ pnpm test --run');
    expect(use('Grep', { pattern: 'TODO', path: '/elsewhere' })).toBe('· Grep TODO in /elsewhere');
  });

  test('shows a refused or failed tool call, and counts the refusals at the end', () => {
    const results = JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', is_error: true, content: 'This command requires approval' },
        { type: 'tool_result', content: 'v22.23.1' },
      ] },
    });
    expect(claudeDriver.formatLine(results)).toBe('  ✗ This command requires approval');
    expect(claudeDriver.formatLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toBeNull();
    expect(claudeDriver.formatLine(JSON.stringify({ type: 'result', result: 'ok', permission_denials: [{}, {}] })))
      .toBe('done · 2 tool calls refused');
  });

  test('reports the result, success or failure', () => {
    expect(claudeDriver.formatLine(JSON.stringify({ type: 'result', result: 'ok' }))).toBe('done');
    expect(
      claudeDriver.formatLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })),
    ).toBe('failed: boom');
  });

  test('reports what a result cost, and which model ran it', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.0174849,
      duration_ms: 1444,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 42,
        cache_read_input_tokens: 13689,
        cache_creation_input_tokens: 7948,
      },
      modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.0174849 } },
    });
    expect(claudeDriver.parseUsage!(line)).toEqual({
      driver: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 42,
      cacheReadTokens: 13689,
      cacheWriteTokens: 7948,
      costUsd: 0.0174849,
      durationMs: 1444,
      turns: 1,
    });
    expect(claudeDriver.formatLine(line)).toBe('done · $0.0175');
    expect(claudeDriver.parseUsage!('not json')).toBeNull();
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

  test('what it said last is its closing result — why it stopped, when it wrote nothing', () => {
    const log = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the specs.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
      'not json',
      JSON.stringify({ type: 'result', result: '## The ambiguity\n\nTell me A or B. ' }),
      '',
    ].join('\n');
    expect(claudeDriver.finalMessage!(log)).toBe('## The ambiguity\n\nTell me A or B.');
  });

  test('without a result, what it said last is its last reply', () => {
    const log = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'First.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Last.' }, { type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
    ].join('\n');
    expect(claudeDriver.finalMessage!(log)).toBe('Last.');
    expect(claudeDriver.finalMessage!('')).toBeNull();
  });
});

describe('opencode driver', () => {
  test('uses its non-interactive run subcommand, in JSON so cost can be read', () => {
    const built = opencodeDriver.build({ prompt: 'go', cwd: '/p' });
    expect(built).toEqual({ command: 'opencode', args: ['run', '--format', 'json', 'go'] });
  });

  test('renders JSON events, and passes anything else through unchanged', () => {
    expect(opencodeDriver.formatLine('hello')).toBe('hello');
    expect(opencodeDriver.formatLine('  ')).toBeNull();
    expect(
      opencodeDriver.formatLine(
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'Writing design.md' } }),
      ),
    ).toBe('Writing design.md');
    expect(
      opencodeDriver.formatLine(JSON.stringify({ type: 'tool', part: { tool: 'write' } })),
    ).toBe('· write');
    expect(
      opencodeDriver.formatLine(
        JSON.stringify({ type: 'step_finish', part: { cost: 0.0028, tokens: { input: 10 } } }),
      ),
    ).toBe('done · $0.0028');
    expect(opencodeDriver.formatLine(JSON.stringify({ type: 'step_start', part: {} }))).toBeNull();
  });

  test('reads what a step cost', () => {
    const usage = opencodeDriver.parseUsage!(
      JSON.stringify({
        type: 'step_finish',
        part: { cost: 0.0028, tokens: { input: 9359, output: 3, cache: { read: 1792, write: 0 } } },
      }),
    );
    expect(usage).toEqual({
      driver: 'opencode',
      costUsd: 0.0028,
      inputTokens: 9359,
      outputTokens: 3,
      cacheReadTokens: 1792,
      cacheWriteTokens: 0,
    });
    expect(opencodeDriver.parseUsage!('not json')).toBeNull();
  });

  test('what it said last is the text after its last tool call, in one piece', () => {
    const log = [
      JSON.stringify({ type: 'text', part: { text: 'Looking around.' } }),
      JSON.stringify({ type: 'tool', part: { tool: 'read' } }),
      JSON.stringify({ type: 'text', part: { text: 'The specs disagree.' } }),
      JSON.stringify({ type: 'text', part: { text: 'Tell me A or B.' } }),
      JSON.stringify({ type: 'step_finish', part: { cost: 0.01 } }),
    ].join('\n');
    expect(opencodeDriver.finalMessage!(log)).toBe('The specs disagree.\n\nTell me A or B.');
    expect(opencodeDriver.finalMessage!(JSON.stringify({ type: 'tool', part: { tool: 'write' } }))).toBeNull();
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
