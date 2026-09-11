# biblia-chat-server

The conversation endpoint of **Bíblia Loyola**, a Bible reader for iOS and Android. This is the one part of that project that is public: the app itself lives in a private repository, and this directory is published from it as a subtree so the server can be deployed from a repository of its own.

`POST /api/chat` takes a short transcript and an optional passage context, and streams back an answer from a hosted model — in Brazilian Portuguese, grounded in the text of the Figueiredo translation through a tool the model has to call before quoting scripture. The corpus is bundled here (`corpus/`), which is also why the app reads its Bible text from this directory: one copy, so what the reader sees on the page and what the model quotes are guaranteed to be the same text.

## Layout

| Path | What it is |
|---|---|
| `api/chat.ts` | The Vercel function. A one-line re-export. |
| `src/chat-route.ts` | The handler: rate limit → validate → `streamText` with the `buscar_versiculos` tool. Reads `OPENROUTER_API_KEY`. |
| `src/bible-tools.ts` | Reference parsing and the tool's execution against the corpus. Also imported by the app. |
| `src/rate-limit.ts` | Per-IP limits counted in Upstash Redis over REST. Fails open. |
| `src/upstream-errors.ts` | The Portuguese the reader sees when something fails — shared with the app's client code. |
| `src/corpus.ts` | Generated loader, one `require` per book. |
| `corpus/` | 73 books as `string[][]` (chapters → verses) plus `books-manifest.json`. **Generated** by the app repo's `scripts/generate-bible-data.mjs`; do not edit by hand. |

## Deploying

The project is connected to Vercel and deploys on push. Configuration that matters:

- `vercel.json` pins the function to **`gru1` (São Paulo)** and sets `maxDuration: 300` — the answer streams, so the function stays alive for the whole reply.
- Environment variables, set in the Vercel project (never committed):
  - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys. Without it the route answers 503.
  - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — from https://console.upstash.com. Without them the limiter is **inert** and the response header `X-RateLimit-Store` says `none`; with them it says `redis`. Check that header before trusting a deployment, because the endpoint is unauthenticated and the model is paid.

Locally, `pnpm install && pnpm dev` runs it under `vercel dev`; the app repo instead mounts `src/chat-route.ts` on its own Metro dev server, so day-to-day development does not need this.

## Publishing from the app repo

This directory is `chat-server/` in the private app repository and is pushed here with `git subtree`:

```sh
git subtree push --prefix=chat-server chat-server-public main
```

Do not commit here directly — changes flow one way, from the app repo.

## Why a separate repository

Vercel builds from a Git repository, and the app's is private and contains far more than this route. Publishing the route on its own keeps the app private while letting the server deploy from Git like any other Vercel project. The corpus is a 19th-century public-domain translation (Pe. António Pereira de Figueiredo, from the Vulgate), extracted from a 1950 printing; about 3.6% of verses could not be recovered from the scan and are stored as empty strings, which the route and the app both render as `[…]`.
