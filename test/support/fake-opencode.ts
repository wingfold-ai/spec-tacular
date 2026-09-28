/**
 * A stand-in for `opencode serve`: the handful of HTTP endpoints the driver
 * uses, announced on stdout the way opencode announces its URL.
 *
 * Replies are steered by the message text: PROSE answers in text with the
 * JSON buried in prose and no structured output; BAD answers with no JSON at
 * all until it is told what was wrong; ERROR is a provider error; anything
 * else comes back as `structured`. GET /log lists what was asked, for tests.
 */

const log: { method: string; path: string; body?: unknown; auth: boolean }[] = [];
let sessions = 0;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = (req.headers.get('authorization') ?? '').startsWith('Basic ');
    const body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
    log.push({ method: req.method, path: url.pathname, body, auth });
    if (!auth) return new Response('unauthorized', { status: 401 });

    if (url.pathname === '/log') return Response.json(log);
    if (req.method === 'POST' && url.pathname === '/session') return Response.json({ id: `ses_${++sessions}` });
    if (req.method === 'DELETE' && url.pathname.startsWith('/session/')) return Response.json(true);

    const message = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === 'POST' && message) {
      const text = (body as { parts: { text: string }[] }).parts[0]!.text;
      const id = message[1];
      if (text.includes('ERROR')) {
        return Response.json({ info: { error: { name: 'APIError', data: { message: 'no credit' } } }, parts: [] });
      }
      if (text.includes('PROSE')) {
        return Response.json({
          info: {},
          parts: [{ type: 'text', text: 'Sure! Here it is:\n```json\n{"answer": "from prose", "session": "' + id + '"}\n```\nHope that helps {really}.' }],
        });
      }
      if (text.includes('BAD')) {
        return Response.json({ info: {}, parts: [{ type: 'text', text: 'I would rather chat.' }] });
      }
      if (text.includes('could not be used')) {
        return Response.json({ info: { structured: { answer: 'fixed', session: id } }, parts: [] });
      }
      return Response.json({ info: { structured: { answer: text, session: id } }, parts: [] });
    }
    return new Response('not found', { status: 404 });
  },
});

process.stdout.write(`opencode server listening on http://127.0.0.1:${server.port}\n`);
