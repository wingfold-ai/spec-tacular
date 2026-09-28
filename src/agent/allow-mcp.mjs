// PreToolUse hook that Claude Code runs for spec-tacular's agents: it
// approves every MCP tool call, since a headless agent has nobody to ask.
// SPECTACULAR_MCP_DENY names servers to leave out (space or comma separated,
// matched case-insensitively against the server part of `mcp__<server>__<tool>`);
// their calls get no decision here, so Claude Code refuses them as usual.
//
// Plain JavaScript on purpose: it runs under whichever runtime started
// spec-tacular (process.execPath), Bun or Node.

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let name = '';
try {
  name = JSON.parse(raw || '{}').tool_name ?? '';
} catch {
  // Not JSON: no decision, so Claude Code's own rules apply.
}

const server = (name.split('__')[1] ?? '').toLowerCase();
const denied = (process.env.SPECTACULAR_MCP_DENY ?? '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .some((entry) => server.includes(entry.toLowerCase()));

if (name.startsWith('mcp__') && server !== '' && !denied) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'spec-tacular allows MCP tools (SPECTACULAR_MCP_DENY to exclude a server)',
      },
    }),
  );
}
