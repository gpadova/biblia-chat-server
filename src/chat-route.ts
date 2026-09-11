import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';

import { executeBibleTool } from './bible-tools';
import { loadChapterVerses } from './corpus';
import { checkRateLimit, rateLimitHeaders } from './rate-limit';
import { describeUpstreamError, RATE_LIMIT_APP_MESSAGE } from './upstream-errors';

/** ⚠️ SERVER-ONLY MODULE — reads the OpenRouter API key. ⚠️
 *
 * **Never import this file, or anything that re-exports it, from client code.**
 * It is not a `+api.ts` file, so Expo's automatic secret stripping does not
 * cover it; what keeps the key out of the app bundle is simply that no client
 * module reaches it. One stray import undoes that, silently, and ships the key
 * inside the JS bundle where `grep sk-or-v1` on the IPA/APK finds it — which is
 * exactly the bug this route was created to fix.
 *
 * The handler lives here rather than directly in a route file because it is
 * mounted twice, from two thin re-export shims:
 *   - `api/chat.ts` in this project — the Vercel function that is deployed.
 *   - `app/api/chat+api.ts` in the app repo — so the Metro dev server serves
 *     /api/chat in development.
 * Keeping one copy is what stops the two from drifting apart. */
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/** qwen/qwen3-30b-a3b-instruct-2507 — a **paid, non-reasoning** id, and both
 * halves of that are load-bearing.
 *
 * *Paid*, because OpenRouter retired `nvidia/nemotron-3-nano-30b-a3b:free` on
 * 2026-09-08 and a retired free variant does not fail like an outage: the route
 * still answers 200, the stream still opens, and OpenRouter's 404 text arrives
 * *as the answer* — "This model is unavailable for free. The paid version is
 * available now - use this slug instead: …" — in English, where the exegesis
 * should be. Never put a `:free` suffix back on this constant.
 *
 * *Non-reasoning*, for a reason that has since half-expired. On the previous
 * host (EAS Hosting, 10 CPU-ms per request) reasoning tokens spent the budget
 * on a channel the reader never sees, and the paid Nemotron — which reasons by
 * default — went from 6/6 clean answers to 2/6. Vercel has no such ceiling, so
 * a reasoning model is *affordable* again; it is still not *free*, because
 * reasoning tokens are billed like any other and this one spends 28 tokens on
 * the tool step where Nemotron spent 285. What did not expire is the grounding
 * lesson: do not reach for `reasoning: { enabled: false }` to quieten a
 * reasoning model — on Nemotron that measured 1 answer in 3 quoting Pr 20,1
 * straight from memory without calling `buscar_versiculos`, plus a run that
 * invented the tool name (`buscar_versiculo`, singular). Grounding every
 * quotation in the real corpus is the entire reason this feature was rebuilt
 * around a tool, so any replacement is measured on that first.
 *
 * Live-tested before landing, three runs each on the tool step plus a full
 * round trip: `meta-llama/llama-3.3-70b-instruct` and `openai/gpt-4.1-nano`
 * both also passed and are the fallbacks if this one degrades.
 * `mistralai/mistral-small-3.2-24b-instruct` was dropped — its provider
 * answered 429 on two of three runs. This one won on cost ($0.05/M in,
 * $0.19/M out across four providers at 98–99.9% uptime) and on being the only
 * candidate that actually produced the sentido literal / sentido espiritual /
 * aplicação structure the system prompt asks for.
 *
 * Not to be confused with the Qwen3-1.7B that `docs/auditoria-chat-ia.md`
 * retired at ~6% factual accuracy: that was a 1.7B model quantized onto the
 * phone. This is a 30B MoE served at full precision, and it is grounded by a
 * corpus tool rather than answering from its weights. */
const ROUTER_CHAT_MODEL_ID = 'qwen/qwen3-30b-a3b-instruct-2507';

const openrouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY,
  appName: 'Bíblia Loyola',
});

/** Lives on the server rather than in shared code so the endpoint is pinned to
 * scripture reading. The route is unauthenticated — anyone who finds the URL
 * can POST to it — and letting the caller supply the whole system prompt would
 * make it a general-purpose free LLM relay. Callers may only append a passage
 * context block, bounded below. */
const BASE_SYSTEM_PROMPT =
  'Você é um companheiro de leitura da Bíblia Sagrada (tradução católica do Pe. António ' +
  'Pereira de Figueiredo, feita a partir da Vulgata latina). Os Salmos seguem a numeração ' +
  'da Vulgata, um número atrás da usada nas bíblias modernas: o Miserere é o Salmo 50. ' +
  'Converse sempre em português do Brasil, com tom acolhedor, claro e respeitoso. ' +
  'Ajude a compreender o texto: sentido literal, sentido espiritual e aplicações à vida, sempre ' +
  'ancorados no que o texto realmente diz. ' +
  // Hard, countable, and stated twice on purpose. "Alguns parágrafos curtos"
  // was read as an invitation: measured 2026-09-08, whole-chapter questions
  // ran past 2 700 characters and hit `maxOutputTokens` mid-word. A limit the
  // model can count against is the only kind it holds to. It was first added
  // as a reliability control on a host that could not afford long answers;
  // that host is gone, and the rule stays because a reading companion that
  // answers in three paragraphs is the product, not a constraint.
  'LIMITE DE TAMANHO: responda em no máximo 3 parágrafos curtos, cerca de 900 caracteres no ' +
  'total. Se a pergunta for ampla (um capítulo inteiro, um livro), não tente cobrir tudo: ' +
  'escolha o essencial, diga em uma linha o que ficou de fora e ofereça aprofundar em uma ' +
  'próxima pergunta. Prefira terminar antes do limite a ser cortado no meio de uma frase. ' +
  'Cite referências bíblicas quando útil. ' +
  'Pode usar formatação simples: negrito, itálico e listas curtas quando ajudarem a leitura. ' +
  'REGRA OBRIGATÓRIA: você não tem certeza suficiente do texto exato dos versículos de memória. ' +
  'Sempre que precisar ler, citar ou comentar o texto literal de um versículo que ainda não esteja ' +
  'citado nesta conversa, chame a ferramenta buscar_versiculos antes de responder, e cite apenas o ' +
  'texto que ela devolver — nunca escreva de memória o texto de um versículo. ' +
  'REGRA CONTRA INVENÇÃO: baseie toda afirmação factual verificável (datas, nomes de lugares, ' +
  'números, dados arqueológicos ou históricos precisos) apenas no texto bíblico fornecido ou em ' +
  'fatos amplamente consolidados; na dúvida, diga que não tem certeza em vez de inventar. Essa ' +
  'cautela não vale para leitura espiritual, moral, literária e aplicação à vida — nesses casos dê ' +
  'sempre uma resposta própria, completa e reflexiva; nunca recuse responder só por ser uma ' +
  'interpretação. ' +
  'REGRA DE IDIOMA: responda exclusivamente em português do Brasil, do início ao fim da resposta.';

/** The model's own lookups run here, against the same corpus the app ships.
 * The deterministic prefetch for a reference the *user* typed still runs
 * on-device in `components/chat/chat-view.tsx` — that one has to stay instant
 * and work with no round trip. */
const buscarVersiculosTool = tool({
  description:
    'Busca o texto de versículos da Bíblia (tradução de Figueiredo). Use sempre que precisar ler, ' +
    'citar ou comentar o texto literal de um versículo que ainda não esteja citado na conversa — ' +
    'para o trecho em foco, versículos vizinhos, outro capítulo ou outro livro. Máximo de 25 ' +
    'versículos por chamada.',
  inputSchema: z.object({
    livro: z
      .string()
      .describe('Nome ou abreviação do livro, ex.: "Gênesis", "Gn", "Salmos", "Mt".'),
    capitulo: z.number().int().describe('Número do capítulo (a partir de 1).'),
    versiculo_inicial: z
      .number()
      .int()
      .optional()
      .describe('Primeiro versículo desejado (opcional; padrão 1).'),
    versiculo_final: z
      .number()
      .int()
      .optional()
      .describe('Último versículo desejado (opcional; padrão até 25 versículos).'),
  }),
  execute: async ({ livro, capitulo, versiculo_inicial, versiculo_final }) => {
    const result = await executeBibleTool(
      {
        toolName: 'buscar_versiculos',
        arguments: { livro, capitulo, versiculo_inicial, versiculo_final },
      },
      // The bundled corpus — the same files the app ships. On Vercel the
      // function is allowed to be large, so nothing is fetched at runtime.
      loadChapterVerses
    );
    return result ?? 'Erro ao buscar o versículo.';
  },
});

/** Bounds are abuse control, not validation theatre: this endpoint is reachable
 * by anyone who learns the URL, so an unbounded transcript would let a stranger
 * spend the account's whole free-tier quota in one request. */
const requestSchema = z.object({
  context: z.string().max(4000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(40),
});

export async function POST(request: Request) {
  // First thing in the handler, deliberately ahead of body parsing: this
  // endpoint is unauthenticated, so malformed spam has to be throttled too, not
  // just requests that reach the model.
  const rateLimit = await checkRateLimit(request);
  const rlHeaders = rateLimitHeaders(rateLimit);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: RATE_LIMIT_APP_MESSAGE },
      { status: 429, headers: rlHeaders }
    );
  }

  if (!OPENROUTER_API_KEY) {
    return Response.json(
      { error: 'A conversa não está configurada no servidor.' },
      { status: 503, headers: rlHeaders }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: 'Corpo da requisição inválido.' },
      { status: 400, headers: rlHeaders }
    );
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: 'Requisição inválida.' }, { status: 400, headers: rlHeaders });
  }
  const { context, messages } = parsed.data;

  const result = streamText({
    model: openrouter.chat(ROUTER_CHAT_MODEL_ID),
    system: context ? BASE_SYSTEM_PROMPT + context : BASE_SYSTEM_PROMPT,
    messages: messages as ModelMessage[],
    tools: { buscar_versiculos: buscarVersiculosTool },
    // Default stopWhen is isStepCount(1) — a lone tool call would end the turn
    // right there, before the model reads the result and answers. Allow a
    // couple of round trips without letting a misbehaving loop run away.
    stopWhen: stepCountIs(4),
    temperature: 0.3,
    // Headroom above the ~900-character rule in the system prompt, not a
    // target: the model is asked to stop well before this, and the cap only
    // exists so a runaway answer ends as a labelled cut (`finishReason:
    // 'length'`) rather than a bill. It was 400 on the previous host, where
    // every streamed token spent part of a 10 CPU-ms budget and length decided
    // whether the reader got an answer at all; Vercel has no such ceiling, so
    // the cap went back to the value the prompt was written against.
    maxOutputTokens: 900,
    // Client hung up (the reader hit stop, or backgrounded the app) — stop
    // paying for tokens nobody will read.
    abortSignal: request.signal,
  });

  return result.toUIMessageStreamResponse({
    // The model id above emits no reasoning, so this should never have
    // anything to filter. It stays as the guard for the day someone swaps in a
    // model that does: the client discards that channel unread, and streaming
    // it would only slow the visible answer down.
    sendReasoning: false,
    // Default masks every failure as "An error occurred." The store shows this
    // string to the reader, and what actually fails here is free-tier rate
    // limiting, which is worth naming. Nothing secret reaches this path: the
    // key is never interpolated into an AI SDK error message.
    //
    // The diagnosis happens here rather than on the client because this is the
    // only side holding `statusCode` / `responseBody` / `Retry-After` — by the
    // time the client sees it, an upstream 429 is a bare string inside a 200
    // response. See upstream-errors.ts.
    onError: describeUpstreamError,
    headers: {
      ...rlHeaders,
      // Some hosts buffer a whole compressed response before flushing, which
      // would defeat streaming and make the reply land as one block.
      'Content-Encoding': 'none',
    },
  });
}
