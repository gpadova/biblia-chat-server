/** What the reader is told when the model side fails — the server half of the
 * contract with `lib/ai/chat-errors.ts` in the app.
 *
 * The message constants are the contract. `describeUpstreamError` here turns a
 * provider failure into one of them, and the app's `classifyChatFailure`
 * recognises them by prefix to decide which notice to show. That is why the
 * strings live in this file and the app imports them from here rather than
 * keeping a copy: a copy would drift, and a drifted string is an error the
 * client silently files under "unknown".
 *
 * It lives outside `chat-route.ts` deliberately: that module reads the
 * OpenRouter key, and the app must be able to import these strings without
 * ever reaching it. */

/** Refused by this route's own limiter (`rate-limit.ts`), before any model call. */
export const RATE_LIMIT_APP_MESSAGE =
  'Muitas mensagens em pouco tempo. Aguarde um instante e tente de novo.';

/** Refused upstream — OpenRouter's limit, shared by every reader. */
export const RATE_LIMIT_PROVIDER_MESSAGE = 'A conversa atingiu o limite de mensagens por agora.';

/** The one line that is true of every failure the reader cannot act on. */
export const GENERIC_CHAT_ERROR = 'Falha ao conversar. Verifique sua conexão.';

/** The stream ended without a `finish` chunk — a cut, not a completion. */
export const TRUNCATED_CHAT_MESSAGE = 'A resposta foi interrompida antes do fim. Tente de novo.';

/** The model hit `maxOutputTokens`. A retry would be cut at the same place, so
 * the copy asks for a narrower question instead. */
export const LENGTH_CAPPED_CHAT_MESSAGE =
  'A resposta ficou longa demais e parou no meio. Pergunte sobre uma parte menor da passagem.';

const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /free-models-per-\w+/i,
  /quota/i,
  /\b429\b/,
];

/** Whether raw provider text is describing a rate limit. Shared with the app,
 * which uses it as a last resort on text an older deployment let through. */
export function looksRateLimited(text: string | null | undefined): boolean {
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/** "um instante", "3 minutos", "2 horas" — a `Retry-After` in words a reader
 * can act on. Anything up to 90 s is "um instante": the notice would be stale
 * before the reader finished reading a number. */
export function humanWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 90) return 'um instante';
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}

function retryAfterSeconds(headers: unknown): number | undefined {
  let raw: string | null = null;
  if (headers instanceof Headers) {
    raw = headers.get('retry-after');
  } else if (headers && typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const value = record['retry-after'] ?? record['Retry-After'];
    if (typeof value === 'string') raw = value;
  }
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** The AI SDK's `onError` for the stream: turns whatever the provider threw
 * into the one sentence the reader should see.
 *
 * This runs on the server rather than on the client because this is the only
 * side holding `statusCode` / `responseBody` / `Retry-After` — by the time the
 * client sees it, an upstream 429 is a bare string inside a 200 response. */
export function describeUpstreamError(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const status = typeof record?.statusCode === 'number' ? record.statusCode : undefined;
  const body = typeof record?.responseBody === 'string' ? record.responseBody : '';
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  if (status === 429 || looksRateLimited(`${message}\n${body}`)) {
    const wait = retryAfterSeconds(record?.responseHeaders);
    return `${RATE_LIMIT_PROVIDER_MESSAGE} Tente de novo em ${
      wait ? humanWait(wait) : 'alguns minutos'
    }.`;
  }

  // Anything else is a provider message written for whoever wired the route
  // up, not for the reader: English, often JSON, occasionally an instruction
  // ("use this slug instead: …"). Passing it through is how a retired model id
  // once got rendered as the answer to "o que significa essa passagem?". Keep
  // it in the function log, where it is the fastest possible diagnosis, and
  // give the reader the one line that is true of every case.
  if (message) console.error('[chat] upstream failure:', status ?? '', message, body);
  return GENERIC_CHAT_ERROR;
}
