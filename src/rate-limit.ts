/** Abuse control for the conversation endpoint, which is unauthenticated.
 *
 * ## What is actually at risk
 *
 * Money, now — and that is a change. This was written when the route ran on a
 * `:free` model id, where OpenRouter's own account-wide cap (20 req/min, 50/day)
 * meant abuse could only exhaust a quota, never generate a bill; fairness
 * between callers was the whole point, with that cap as the backstop underneath.
 * The `:free` variant was retired on 2026-09-08 and the route moved to the paid
 * id, which has no request cap at all — only spend. A stranger POSTing in a loop
 * now costs real money instead of merely crowding readers out, and nothing
 * upstream stops them.
 *
 * Two consequences. This file is now the *only* backstop, not a fairness layer
 * on top of one — so an inert limiter is a billing problem, not just an
 * unfairness. And the numbers below stay conservative on purpose: the price is
 * low ($0.05/M in, $0.20/M out) but unbounded, so the ceiling should be raised
 * for a complaining reader, not pre-emptively.
 *
 * ## Why this needs an external store — measured, not assumed
 *
 * A serverless function has **no durable state** it may rely on. This was
 * first measured on EAS Hosting (Cloudflare Workers), where all three
 * candidates were tested against the live deployment:
 *
 * | Mechanism            | Result                                                    |
 * |----------------------|-----------------------------------------------------------|
 * | Module-scope `Map`   | Six sequential requests hit four isolates; 30 got through. |
 * | `caches.default`     | Present but throws: "This Worker is not permitted to access the default cache." |
 * | KV / env bindings    | `undefined`.                                              |
 *
 * Vercel is no different in the way that matters: Fluid compute *does* reuse a
 * warm instance across requests, which makes a module-scope counter look
 * alive in a quick test — and then a second instance spins up under load and
 * every caller gets a fresh count. An in-memory limiter is worse than none: it
 * works locally, passes review, and silently does nothing in production. So
 * counting happens in Upstash Redis over its REST API — no npm dependency,
 * just `fetch`, and `INCR` is atomic, which also removes the read-modify-write
 * race a cache-based counter would have had.
 *
 * ## Unconfigured behaviour
 *
 * With no Upstash credentials this module **allows everything** and reports
 * `X-RateLimit-Store: none`. That is deliberate: failing closed would take the
 * feature down. It used to be cheap as well as deliberate, because OpenRouter's
 * free-tier cap bounded the damage; on the paid id nothing does, so `none` in
 * production is now a live spend risk rather than a degraded mode. The header is
 * how you tell a working limiter from an inert one from outside — check it
 * before trusting that this file is doing anything. */

/** Short window: stops hammering. */
const BURST_LIMIT = 15;
const BURST_WINDOW_SECONDS = 60;

/** Long window: stops one caller quietly spending all day while staying under
 * the burst limit. The number was first chosen to ration a 50/day free-model
 * allowance; on the paid id there is no upstream ceiling, so this is the only
 * brake there is. Raise it when a real reader complains, not before. */
const DAILY_LIMIT = 30;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Identifies the caller. Vercel sets `X-Real-IP` and `X-Forwarded-For` from
 * the connecting address (EAS Hosting set the first; Cloudflare's own header is
 * kept so the module still works if the route ever moves back). Falling back to
 * a shared bucket when nothing is set is deliberate: a limiter that cannot tell
 * callers apart should throttle all of them rather than none. */
function clientKey(request: Request): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  const cloudflare = request.headers.get('cf-connecting-ip');
  if (cloudflare) return cloudflare.trim();
  return 'unknown';
}

/** One atomic round trip per bucket: `INCR` the counter, then set its TTL only
 * if the key has none yet (`EXPIRE … NX`). The NX matters — refreshing the TTL
 * on every request would turn a fixed window into one that never closes for a
 * caller who keeps knocking. */
async function increment(key: string, ttlSeconds: number): Promise<number> {
  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(ttlSeconds), 'NX'],
    ]),
  });
  if (!response.ok) {
    throw new Error(`Upstash HTTP ${response.status}`);
  }
  const results = (await response.json()) as ({ result?: unknown; error?: string } | null)[];
  const incr = results?.[0];
  if (!incr || incr.error) throw new Error(incr?.error ?? 'Upstash INCR failed');
  const count = Number(incr.result);
  if (!Number.isFinite(count)) throw new Error('Upstash INCR returned a non-number');
  return count;
}

/** `store` reports which backend actually counted, so an unconfigured or broken
 * limiter is visible from outside rather than passing for a working one. */
export type RateLimitVerdict = {
  allowed: boolean;
  retryAfterSeconds?: number;
  count: number;
  limit: number;
  store: 'redis' | 'none' | 'error';
  detail?: string;
};

/** Records the request and reports whether it may proceed. Call once per
 * request, before any work worth protecting.
 *
 * Fails **open** on every error path — see the module header for why. */
export async function checkRateLimit(request: Request): Promise<RateLimitVerdict> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return { allowed: true, count: 0, limit: BURST_LIMIT, store: 'none' };
  }

  const client = clientKey(request);
  // The window index is part of the key, so a window rolls over by moving to a
  // fresh key rather than needing a reset written anywhere.
  const now = Date.now();
  const burstWindow = Math.floor(now / (BURST_WINDOW_SECONDS * 1000));
  const dailyWindow = Math.floor(now / (DAILY_WINDOW_SECONDS * 1000));

  try {
    const burst = await increment(
      `rl:burst:${client}:${burstWindow}`,
      BURST_WINDOW_SECONDS
    );
    if (burst > BURST_LIMIT) {
      return {
        allowed: false,
        retryAfterSeconds: secondsLeftIn(BURST_WINDOW_SECONDS, now),
        count: burst,
        limit: BURST_LIMIT,
        store: 'redis',
      };
    }

    const daily = await increment(
      `rl:daily:${client}:${dailyWindow}`,
      DAILY_WINDOW_SECONDS
    );
    if (daily > DAILY_LIMIT) {
      return {
        allowed: false,
        retryAfterSeconds: secondsLeftIn(DAILY_WINDOW_SECONDS, now),
        count: daily,
        limit: DAILY_LIMIT,
        store: 'redis',
      };
    }

    return { allowed: true, count: burst, limit: BURST_LIMIT, store: 'redis' };
  } catch (error) {
    return {
      allowed: true,
      count: 0,
      limit: BURST_LIMIT,
      store: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Seconds remaining in the current fixed window. */
function secondsLeftIn(windowSeconds: number, now: number): number {
  const windowMs = windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

/** Standard rate-limit headers, set on every response. Also the only way to see
 * from outside whether the counter store is live — check `X-RateLimit-Store`. */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(verdict.limit),
    'X-RateLimit-Remaining': String(Math.max(0, verdict.limit - verdict.count)),
    'X-RateLimit-Store': verdict.store,
  };
  if (verdict.detail) headers['X-RateLimit-Detail'] = verdict.detail.slice(0, 120);
  if (verdict.retryAfterSeconds != null) {
    headers['Retry-After'] = String(verdict.retryAfterSeconds);
  }
  return headers;
}
