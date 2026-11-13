// Tests for name search on the tablet's name box: src/nameSearch.ts, imported as it is
// (Node strips its types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { compact, fold, nameTier, rankNames, searchNames } from "../src/nameSearch.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);

const person = (name) => {
  const [firstName, ...rest] = name.split(" ");
  return { firstName, lastName: rest.join(" "), name };
};
const names = (people) => people.map((p) => p.name);
const tierOf = (name, query) => nameTier(fold(name), fold(query.trim()));

// [input, its fold]
const CASES = [
  // Letters NFKD leaves whole, and their capitals
  ["\u00DF", "ss"],
  ["\u1E9E", "ss"],
  ["\u00E6", "ae"],
  ["\u00C6", "ae"],
  ["\u0153", "oe"],
  ["\u0152", "oe"],
  ["\u00F8", "o"],
  ["\u00D8", "o"],
  ["\u0111", "d"],
  ["\u0110", "d"],
  ["\u00F0", "d"],
  ["\u00D0", "d"],
  ["\u0142", "l"],
  ["\u0141", "l"],
  ["\u00FE", "th"],
  ["\u00DE", "th"],
  ["\u0131", "i"],
  ["I", "i"],
  ["Stra\u00DFe", "strasse"],
  // Accents
  ["Jos\u00E9", "jose"],
  ["Jose\u0301", "jose"],
  ["Zo\u00EB", "zoe"],
  ["\u00D1\u00FA\u00F1ez", "nunez"],
  ["\u0130pek", "ipek"],
  ["I\u015F\u0131k", "isik"],
  ["Fran\u00E7ois", "francois"],
  ["Franc\u00B8ois", "francois"],
  ["Zoe\u00A8", "zoe"],
  ["Muller", "muller"],
  ["M\u00FCller", "muller"],
  // Apostrophes and periods
  ["O'Brien", "obrien"],
  ["O\u2019Brien", "obrien"],
  ["O\u2018Brien", "obrien"],
  ["O\u02BCbrien", "obrien"],
  ["O\u00B4Brien", "obrien"],
  ["O`Brien", "obrien"],
  ["O\u2032Brien", "obrien"],
  ["O\u02B9Brien", "obrien"],
  ["O\uFF07Brien", "obrien"],
  ["Ka\u02BBiulani", "kaiulani"],
  ["St. John", "st john"],
  // Hyphens, dashes, underscores
  ["Mary-Kate", "mary kate"],
  ["Mary\u2013Kate", "mary kate"],
  ["Mary\u2014Kate", "mary kate"],
  ["Mary\u2010Kate", "mary kate"],
  ["Mary\u2011Kate", "mary kate"],
  ["Mary\u2012Kate", "mary kate"],
  ["Mary\u2015Kate", "mary kate"],
  ["Mary\u2212Kate", "mary kate"],
  ["Mary_Kate", "mary kate"],
  ["Mary - Kate", "mary kate"],
  // Invisible format characters
  ["Mar\u00ADgaret", "margaret"],
  ["Mar\u200Bgaret", "margaret"],
  ["\uFEFFAnn", "ann"],
  // Spacing
  ["  Ann   Lee  ", "ann lee"],
  ["Ann\u00A0Lee", "ann lee"],
  ["Ann\tLee", "ann lee"],
  // Nothing left
  ["'.-", ""],
  ["\u2019 . _ \u2014", ""],
  ["", ""],
  // Plain ASCII: lower-case only
  ["Sam Lee", "sam lee"],
  // Marks that belong to another script stay
  ["\u0930\u093E\u092E", "\u0930\u093E\u092E"],
  ["\u0930\u092E\u093E", "\u0930\u092E\u093E"],
];

test("fold gives each name in the case table its expected form", () => {
  for (const [input, folded] of CASES) {
    assert.equal(fold(input), folded, JSON.stringify(input));
  }
});

test("names that differ in another script's marks stay different", () => {
  // राम and रमा differ only in where the vowel sign sits.
  assert.notEqual(fold("\u0930\u093E\u092E"), fold("\u0930\u092E\u093E"));
  // Пётр and Петр
  assert.notEqual(fold("\u041F\u0451\u0442\u0440"), fold("\u041F\u0435\u0442\u0440"));
});

test("fold is stable on every code point, alone and next to a mark", () => {
  const unstable = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const c = String.fromCodePoint(cp);
    // Alone; followed by a mark; between a letter and a mark.
    for (const text of [c, c + "\u0301", "a" + c + "\u0301"]) {
      const folded = fold(text);
      if (fold(folded) !== folded) unstable.push(text);
    }
  }
  const show = (list) => list.slice(0, 10).map((t) => JSON.stringify(t));
  assert.deepEqual(show(unstable), [], `${unstable.length} inputs change when folded again`);
});

// ---------------------------------------------------------------------------
// The tablet's name box

test("a name is found without its accents, apostrophes or hyphens", () => {
  const people = ["Jos\u00E9 D\u00EDaz", "Sam O'Brien", "Mary-Kate Lee", "Ann Smith"].map(person);
  assert.deepEqual(names(searchNames(people, "jose")), ["Jos\u00E9 D\u00EDaz"]);
  for (const query of ["obrien", "o\u2019brien", "o\u00B4brien", "O'BRIEN"]) {
    assert.deepEqual(names(searchNames(people, query)), ["Sam O'Brien"], query);
  }
  assert.deepEqual(names(searchNames(people, "mary kate")), ["Mary-Kate Lee"]);
  assert.deepEqual(names(searchNames(people, "marykate")), ["Mary-Kate Lee"]);
});

test("tiers: start of name, start of a word, anywhere, then only without spaces", () => {
  assert.equal(tierOf("Mary-Kate Lee", "mary kate"), 0);
  assert.equal(tierOf("Ann Mary-Kate", "mary-k"), 1);
  assert.equal(tierOf("Jo-Ann Smith", "ann"), 1);
  assert.equal(tierOf("Sam Lee", "am"), 2);
  assert.equal(tierOf("Mary-Kate Lee", "marykate"), 3);
  assert.equal(tierOf("Ann Lee", "nl"), 3);
  assert.equal(tierOf("Ann Lee", "bob"), null);
  assert.equal(tierOf("Ann Lee", "'"), null);
});

test("a match only without spaces ranks below every real match", () => {
  const people = ["Ann Lee", "Quinlan Ray"].map(person);
  assert.deepEqual(names(rankNames(people, "nl")), ["Quinlan Ray", "Ann Lee"]);
});

// Today's search, before the fold: lower-case substring, ranked by the same three tiers.
function oldTier(name, query) {
  const n = name.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q || !n.includes(q)) return null;
  if (n.startsWith(q)) return 0;
  return n.split(" ").some((part) => part.startsWith(q)) ? 1 : 2;
}

test("a query keeps the tier it has today", () => {
  assert.equal(oldTier("Sam Lee", "sam"), 0);
  assert.equal(tierOf("Sam Lee", "sam"), 0);
  assert.equal(oldTier("Sam Lee", "lee"), 1);
  assert.equal(tierOf("Sam Lee", "lee"), 1);
  assert.equal(oldTier("Sam Lee", "am"), 2);
  assert.equal(tierOf("Sam Lee", "am"), 2);
});

test("no query that matches today loses its match or drops a tier", () => {
  const sample = [
    "Sam Lee",
    "Jos\u00E9 D\u00EDaz",
    "Jo-Ann Smith",
    "Sam O'Brien",
    "Mary-Kate O\u2019Neil",
    "Ann St. John",
    "Zo\u00EB Stra\u00DFe",
    "Ka\u02BBiulani Kahale",
    "Li  Wu",
  ];
  for (const name of sample) {
    for (let i = 0; i < name.length; i++) {
      for (let j = i + 1; j <= name.length; j++) {
        const query = name.slice(i, j);
        const before = oldTier(name, query);
        if (before === null || !fold(query.trim())) continue;
        const after = tierOf(name, query);
        assert.ok(after !== null && after <= before, `${JSON.stringify(query)} in ${name}`);
      }
    }
  }
});

test("matches sort by tier, then by name, and the box shows the first three", () => {
  const people = ["Ann Zed", "Bo Ann", "Ann Able", "Joann Cole", "Anne Brook", "Dee Hann"].map(
    person,
  );
  const all = ["Ann Able", "Ann Zed", "Anne Brook", "Bo Ann", "Dee Hann", "Joann Cole"];
  assert.deepEqual(names(rankNames(people, "ann")), all);
  assert.deepEqual(names(searchNames(people, "ann")), all.slice(0, 3));
});

test("a query that folds to nothing finds nobody", () => {
  const people = ["Sam O'Brien", "Ann Lee"].map(person);
  for (const query of ["'", " . ", "\u2019", ""]) {
    assert.deepEqual(rankNames(people, query), [], JSON.stringify(query));
  }
});

test("a search never changes the names it returns", () => {
  const people = [person("Jos\u00E9 D\u00EDaz")];
  assert.equal(searchNames(people, "jose")[0], people[0]);
  assert.equal(compact(fold("Mary-Kate Lee")), "marykatelee");
});

// ---------------------------------------------------------------------------
// Same-name groups still go by the spelling

test("José Díaz and Jose Diaz are still two names, on the server and the tablet", () => {
  const accented = { firstName: "Jos\u00E9", lastName: "D\u00EDaz" };
  const plainName = { firstName: "Jose", lastName: "Diaz" };
  assert.equal(fold("Jos\u00E9 D\u00EDaz"), fold("Jose Diaz"));
  assert.notEqual(L.volunteerNameKey(accented), L.volunteerNameKey(plainName));

  // The tablet's group key, taken from App.tsx without its type annotation.
  const source = read("src/App.tsx");
  const body = /const nameKey = \(v: Volunteer\) =>\n([^;]+);/.exec(source);
  assert.ok(body, "nameKey not found in App.tsx");
  const nameKey = vm.runInNewContext("(v) => " + body[1]);
  assert.notEqual(nameKey(accented), nameKey(plainName));
  assert.equal(nameKey({ firstName: " Jose ", lastName: "DIAZ" }), nameKey(plainName));
});
