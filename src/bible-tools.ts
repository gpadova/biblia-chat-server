import { books, getBook } from './books';
import { LACUNA, isLacuna } from './lacuna';

/** A call to `buscar_versiculos` — shaped like the AI SDK's tool-call input,
 * kept as a plain local type so this file doesn't depend on any particular
 * model runtime. */
type BibleToolCall = { toolName: string; arguments: Record<string, unknown> };

/** How the caller reads the corpus.
 *
 * Injected rather than imported so this module carries no corpus of its own:
 * the app imports it for `extractVerseRefs` and the deployed route for the
 * tool, and each passes the loader it already has (`corpus.ts` in both cases
 * today — the parameter is what kept the route's bundle small when it ran on a
 * host that could not afford the corpus, and it costs nothing to keep). */
export type VerseLoader = (bookId: string, chapter: number) => string[] | Promise<string[]>;

/** Hard cap per tool call so a chapter dump never floods the model's context. */
const MAX_VERSES_PER_CALL = 25;

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const foldCase = (s: string) => s.toLowerCase().trim();

/** Resolves "Gn", "Gênesis", "genesis", "1 Samuel", "Paralipômenos"… to a book. */
function resolveBook(query: string) {
  const cased = foldCase(query);
  const q = normalize(query);
  return (
    // Case-insensitive but accent-preserving match first. "Jó" (Job, id
    // "job") and "Jo"/"João" (id "jo") are distinct books that collide once
    // normalize() strips the accent — without this, getBook(q) below would
    // resolve "Jó" straight to João. The accent is the only signal that
    // tells them apart, so it has to be checked before it's discarded.
    books.find(
      (b) => foldCase(b.abbrev) === cased || foldCase(b.name) === cased || foldCase(b.fullName) === cased
    ) ??
    getBook(q) ??
    books.find((b) => normalize(b.abbrev) === q) ??
    books.find((b) => normalize(b.name) === q || normalize(b.fullName) === q) ??
    books.find((b) => b.altNames.some((n) => normalize(n) === q)) ??
    books.find((b) => normalize(b.name).startsWith(q))
  );
}

export type VerseRefArgs = {
  livro: string;
  capitulo: number;
  versiculo_inicial?: number;
  versiculo_final?: number;
};

let bookPattern: RegExp | null = null;
function getBookPattern(): RegExp {
  if (!bookPattern) {
    // Longest names first so "1 Samuel" wins over "Samuel", "Gênesis" over "Gn".
    const alternatives = books
      .flatMap((b) => [b.abbrev, b.name, b.fullName, ...b.altNames])
      .map(normalize)
      .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i)
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    bookPattern = new RegExp(
      `(?:^|[\\s(“"'])(${alternatives.join('|')})\\.?\\s+(\\d{1,3})(?:\\s*[,:.]\\s*(\\d{1,3})(?:\\s*[-–—a]\\s*(\\d{1,3}))?)?`,
      'g'
    );
  }
  return bookPattern;
}

/** Finds scripture references typed by the user ("Gn 2, 7", "Gênesis 2:7-9",
 * "salmos 23"...) so the app can fetch the real text deterministically instead
 * of betting on the model's tool-use initiative. */
export function extractVerseRefs(text: string, max = 3): VerseRefArgs[] {
  const refs: VerseRefArgs[] = [];
  const normalized = normalize(text);
  const pattern = getBookPattern();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null && refs.length < max) {
    const ref: VerseRefArgs = { livro: match[1], capitulo: Number(match[2]) };
    if (match[3]) {
      ref.versiculo_inicial = Number(match[3]);
      ref.versiculo_final = match[4] ? Number(match[4]) : Number(match[3]);
    }
    refs.push(ref);
  }
  return refs;
}

/** Executes a tool call against the locally bundled Bible. Always returns a
 * string for the model — errors come back as readable PT-BR notes so the
 * model can correct itself (wrong book name, chapter out of range…). */
export async function executeBibleTool(
  call: BibleToolCall,
  loadVerses: VerseLoader
): Promise<string | null> {
  if (call.toolName !== 'buscar_versiculos') {
    return `Ferramenta desconhecida: ${call.toolName}. Use "buscar_versiculos".`;
  }
  const args = call.arguments as {
    livro?: string;
    capitulo?: number | string;
    versiculo_inicial?: number | string;
    versiculo_final?: number | string;
  };

  const book = args.livro ? resolveBook(String(args.livro)) : undefined;
  if (!book) {
    const sample = books
      .slice(0, 8)
      .map((b) => `${b.abbrev} (${b.name})`)
      .join(', ');
    return `Livro "${args.livro ?? ''}" não encontrado. Exemplos válidos: ${sample}…`;
  }

  const chapter = Number(args.capitulo);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > book.chapterCount) {
    return `${book.name} tem ${book.chapterCount} capítulos; capítulo "${args.capitulo}" é inválido.`;
  }

  let verses: string[];
  try {
    verses = await loadVerses(book.id, chapter);
  } catch {
    return `Não foi possível carregar ${book.name} ${chapter}.`;
  }

  let from = Math.max(1, Number(args.versiculo_inicial) || 1);
  let to = Number(args.versiculo_final) || from + MAX_VERSES_PER_CALL - 1;
  if (to < from) [from, to] = [to, from];
  from = Math.min(from, verses.length);
  to = Math.min(to, verses.length, from + MAX_VERSES_PER_CALL - 1);

  // A verse the extraction could not recover is marked rather than sent as an
  // empty line — otherwise the model reads the blank as scripture and fills it
  // in from memory, which is the one thing it must never do.
  const body = verses
    .slice(from - 1, to)
    .map((text, i) => `${from + i}. ${isLacuna(text) ? `${LACUNA} (não recuperado)` : text}`)
    .join('\n');
  const suffix =
    to < verses.length ? `\n(… o capítulo continua até o versículo ${verses.length})` : '';
  // The book emoji doubles as a visual cue in the chat that this bubble is
  // scripture fetched by the model, not generated text.
  const range = from === to ? `${from}` : `${from}-${to}`;
  return `📖 ${book.name} ${chapter}, ${range} (Figueiredo):\n${body}${suffix}`;
}
