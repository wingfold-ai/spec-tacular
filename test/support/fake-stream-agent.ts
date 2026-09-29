/**
 * A stand-in for `claude -p --input-format stream-json --output-format
 * stream-json`: reads one user message per line, answers each with the
 * events Claude Code emits, ending in a `result` carrying structured_output.
 *
 * What it does is steered by the message text, so a test can script a
 * session: DIE exits (as does any second message, given --die-on-turn-2),
 * HANG never answers, FAIL answers with an error, and
 * anything else is echoed back with the turn number and this process's pid.
 */

let buffer = '';
let turn = 0;

const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: 'system', subtype: 'init' });

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line) as { message: { content: string } };
    const text = message.message.content;
    turn++;
    if (text.includes('DIE') || (turn === 2 && process.argv.includes('--die-on-turn-2'))) {
      process.stderr.write('fake agent: told to die\n');
      process.exit(3);
    }
    if (text.includes('HANG')) continue;
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
    if (text.includes('FAIL')) {
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'model said no' });
      continue;
    }
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { text, turn, pid: process.pid, args: process.argv.slice(2) },
      // As Claude Code reports it: the cost is the session's running total
      // (the first turn writes the cache, later ones mostly read it), the
      // token counts are this turn's.
      total_cost_usd: 0.01 + 0.001 * (turn - 1),
      usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: turn === 1 ? 0 : 5000, cache_creation_input_tokens: turn === 1 ? 5000 : 100 },
    });
  }
});
process.stdin.on('end', () => process.exit(0));
