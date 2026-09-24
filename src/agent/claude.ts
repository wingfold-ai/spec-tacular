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
      ],
    };
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
