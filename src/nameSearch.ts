// The tablet's name search. A typed name and each volunteer's name both go through fold()
// before they are compared, so a search ignores Latin accents, apostrophes, periods,
// hyphens, case and spacing: "jose" finds José, "obrien" finds O'Brien, "mary kate" finds
// Mary-Kate. Marks that are part of a letter in another script (Devanagari vowel signs,
// for one) are kept, so two different names in that script never fold together.
//
// The Kiosk admin dialog (apps-script/AdminDialog.html) carries its own copy of fold(),
// since it can't import this file; tests/nameSearch.test.mjs holds the two to the same
// output on every code point. Change both together.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

// Removed before NFKD. NFKD turns each of these spacing accents into a space plus a mark,
// which would leave a space in the middle of a name. The modifier-letter apostrophes and
// prime, and the Greek numeral sign that NFKD turns into that prime, count as letters of
// no script, so a mark after one would be kept in the next step and left behind when the
// apostrophe is removed; folding the result again would then drop the mark. Format
// characters (soft hyphen, zero-width characters, byte-order mark) go here for the same
// reason.
const BEFORE_NFKD = /[\u00A8\u00AF\u00B4\u00B8\u02B9\u02BB\u02BC\u02D8-\u02DD\u0374\p{Cf}]/gu;

// A run of combining marks, with the letter before it when there is one.
const MARK_RUN = /(\p{L})?(\p{M}+)/gu;
const LATIN = /\p{Script=Latin}/u;

// Lower-case letters NFKD leaves whole, and what they fold to.
const WHOLE_LETTERS = /[\u00DF\u00E6\u0153\u00F8\u0111\u00F0\u0142\u00FE\u0131]/g;
const WHOLE_LETTER_FOLDS: Record<string, string> = {
  "\u00DF": "ss", // ß
  "\u00E6": "ae", // æ
  "\u0153": "oe", // œ
  "\u00F8": "o", // ø
  "\u0111": "d", // đ
  "\u00F0": "d", // ð
  "\u0142": "l", // ł
  "\u00FE": "th", // þ
  "\u0131": "i", // dotless ı
};

// Apostrophes and their look-alikes (' ’ ‘ ʼ ʻ ` ′ ʹ), periods and format characters.
// Some are removed before NFKD too; NFKD can make others, such as ' from a full-width ＇.
const DELETED = /['\u2019\u2018\u02BC\u02BB`.\u2032\u02B9\p{Cf}]/gu;

// Hyphens, dashes, the minus sign and the underscore: each separates words.
const SEPARATORS = /[-\u2010-\u2015\u2212_]/g;

/** The form a name or a query is compared in. Never shown. */
export function fold(text: string): string {
  return text
    .replace(BEFORE_NFKD, "")
    .normalize("NFKD")
    .replace(MARK_RUN, (run: string, base: string | undefined) =>
      base && !LATIN.test(base) ? run : (base ?? ""),
    )
    .toLowerCase()
    .replace(WHOLE_LETTERS, (letter) => WHOLE_LETTER_FOLDS[letter])
    .replace(DELETED, "")
    .replace(SEPARATORS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A folded string with its spaces removed, so "marykate" can find "mary kate". */
export function compact(folded: string): string {
  return folded.replace(/ /g, "");
}

/**
 * How well a folded query matches a folded name, best first: 0 when the name starts with
 * it, 1 when a word of the name does, 2 when it is anywhere in the name, 3 when it is only
 * in the name with the spaces taken out. null when it doesn't match.
 */
export function nameTier(foldedName: string, foldedQuery: string): 0 | 1 | 2 | 3 | null {
  if (!foldedQuery) return null;
  if (foldedName.startsWith(foldedQuery)) return 0;
  if ((" " + foldedName).includes(" " + foldedQuery)) return 1;
  if (foldedName.includes(foldedQuery)) return 2;
  if (compact(foldedName).includes(compact(foldedQuery))) return 3;
  return null;
}

type Named = { firstName: string; lastName: string };

/** Every person whose name matches the query, best match first, then by name. */
export function rankNames<T extends Named>(people: readonly T[], query: string): T[] {
  const foldedQuery = fold(query.trim());
  if (!foldedQuery) return [];
  return people
    .map((person) => {
      const name = `${person.firstName} ${person.lastName}`;
      return { person, name, tier: nameTier(fold(name), foldedQuery) };
    })
    .filter((entry) => entry.tier !== null)
    .sort((a, b) => a.tier! - b.tier! || a.name.localeCompare(b.name))
    .map((entry) => entry.person);
}

/** How many matches the name box shows. */
export const SHOWN_RESULTS = 3;

/** The matches the name box shows. */
export function searchNames<T extends Named>(people: readonly T[], query: string): T[] {
  return rankNames(people, query).slice(0, SHOWN_RESULTS);
}
