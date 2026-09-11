/** The deployed function's entry point: adapts Vercel's Node `(req, res)`
 * calling convention to the Web-standard `POST(request): Response` that
 * `chat-route.ts` exports, streaming the body through as it arrives.
 *
 * Why an adapter at all, when Vercel's own builder accepts Web handlers:
 * that builder compiles TypeScript file by file and leaves `ai` and the
 * OpenRouter provider as bare `require()`s, and they ship ESM only — the
 * runtime's launcher answers `ERR_REQUIRE_ESM`. Bundling everything into one
 * CommonJS file with esbuild (`scripts/build.mjs`) sidesteps the module-format
 * question entirely, and once the function is a hand-built artifact it has to
 * speak the launcher's native protocol, which is this one. */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { POST } from './chat-route';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }

  // The route reads only the path and headers off the request, so the origin
  // is nominal — `x-forwarded-host` is set by Vercel's edge, and `localhost`
  // is what the local harness sees.
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost';
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const response = await POST(
    new Request(`https://${host}${req.url ?? '/api/chat'}`, {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks),
      signal: controller.signal,
    })
  );

  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  // One write per chunk, flushed as it lands — buffering here would turn the
  // stream back into a single block after the last token.
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}
