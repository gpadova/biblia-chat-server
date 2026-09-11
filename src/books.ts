import manifest from '../corpus/books-manifest.json';

/** The book table the tool resolves references against.
 *
 * This is the server's view of `corpus/books-manifest.json`: ids, names and the
 * spellings a typed reference may use, plus chapter counts for range checks.
 * The app reads the same file through `data/books.ts`, which adds the
 * navigation helpers the reader needs and this route does not. Both are
 * generated from the corpus by `scripts/generate-bible-data.mjs` in the app
 * repo — never edit the manifest by hand. */
export type BookMeta = {
  id: string;
  abbrev: string;
  name: string;
  fullName: string;
  /** Other spellings a reference may use — the names Figueiredo's own edition
   * prints (Paralipômenos, II Esdras) and common variants. */
  altNames: string[];
  testament: 'AT' | 'NT';
  order: number;
  chapterCount: number;
  verseCounts: number[];
};

export const books: BookMeta[] = manifest as BookMeta[];

const booksById: Record<string, BookMeta> = Object.fromEntries(books.map((b) => [b.id, b]));

export function getBook(id: string): BookMeta | undefined {
  return booksById[id];
}
