/** The deployed conversation endpoint: `POST /api/chat` on Vercel.
 *
 * Vercel's Node.js runtime accepts a Web-standard handler — a function taking
 * a `Request` and returning a `Response` — which is exactly what
 * `src/chat-route.ts` exports, so nothing is adapted here. The same module is
 * mounted on the app's Metro dev server by `app/api/chat+api.ts` in the app
 * repo; keeping one copy of the handler is what stops the two from drifting. */
export { POST } from '../src/chat-route';
