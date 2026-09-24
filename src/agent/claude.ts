/**
 * Claude Code driver.
 *
 * `claude -p` is the non-interactive mode. `stream-json` is used rather than
 * plain text because it arrives incrementally — a job pane that only fills in
 * once the agent finishes is not a job pane.
 */

import type { AgentCommand, AgentDriver, AgentRequest } from './driver.ts';

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: { type?: string; text?: string; name?: string }[] };
  result?: string;
  is_error?: boolean;
}

/** Extra flags from the environment, split on whitespace. */
function extraArgs(): string[] {
  return (process.env['SPECTACULAR_CLAUDE_ARGS'] ?? '').split(/\s+/).filter(Boolean);
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
        args: [
          '-p',
          request.prompt,
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(request.schema),
          '--model',
          request.mode === 'quick'
            ? (process.env['SPECTACULAR_QUICK_MODEL'] ?? 'haiku')
            : (process.env['SPECTACULAR_ADVISOR_MODEL'] ?? 'sonnet'),
          // Web search at most: the advisor looks up current versions, and has
          // no business reading or editing the project. Other modes need none.
          ...((request.mode ?? 'research') === 'research'
            ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch']
            : ['--tools', '']),
          '--no-session-persistence',
          // The user's MCP servers are irrelevant here and slow to start.
          '--strict-mcp-config',
        ],
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
