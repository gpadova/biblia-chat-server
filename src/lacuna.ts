/** Leaf module — deliberately imports nothing.
 *
 * `LACUNA` used to live next to the corpus loader, whose 73 `require()`s pull
 * every book into whatever bundle reaches it. Anything reaching for the marker
 * therefore dragged the whole 5 MB corpus along. Harmless in the app, which
 * ships the corpus anyway, but this module is also what the app's
 * `data/bible-content.ts` re-exports, and keeping it a leaf keeps that cheap. */

/** Shown where the extraction could not recover a verse from the 1950 scan.
 *
 * The corpus stores those as empty strings so that verse numbering — which
 * every highlight, bookmark and citation is anchored to — stays intact. A blank
 * after a verse number reads as a broken app, so the page marks the gap the way
 * a printed critical edition does. About 3.6% of verses; see tools/figueiredo. */
export const LACUNA = '[…]';

export function isLacuna(verse: string): boolean {
  return verse.length === 0;
}
