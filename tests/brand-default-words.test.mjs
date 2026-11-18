// This brand's text under the default words is the release before's, word for word:
// refusals, Settings sentences, How to rows, email subjects and bodies, the hours report,
// log check and setup messages, header names and notes, and the page's screen strings.
// tests/brand-fixtures/default-words.json holds that release's output for each call in
// tests/brand-fixtures/textCalls.mjs, and the screen strings of its page sources (made by
// tests/brand-fixtures/make.mjs). Two changes are allowed: the How to sections about the
// new Settings rows, and the Profiles file ID's sentence, which now says that a blank ID
// means this spreadsheet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { wordText } from "../src/words.ts";
import { BRAND_WORDS } from "../src/brand.ts";
import { isPageSource, screenStrings } from "./brand-fixtures/pageStrings.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const GOLDEN = JSON.parse(read("tests/brand-fixtures/default-words.json"));

const FILE_ID = "Volunteer Profiles file ID";
const NEW_SECTIONS = [
  "Use your own words, name and logo",
  "Turn parts of the kiosk on or off",
  "Read your own volunteer list",
];

const run = ({ fn, args }) => {
  try {
    return { out: plain(L[fn](...args) ?? null) };
  } catch (err) {
    return { threw: err.message };
  }
};

test("every server text is the release before's, but the two allowed changes", () => {
  const special = new Set(["settingsDescriptionColumn", "howToRows"]);
  let checked = 0;
  for (const call of GOLDEN.calls) {
    if (special.has(call.fn)) continue;
    const got = run(call);
    const label = call.fn + " " + JSON.stringify(call.args).slice(0, 120);
    if ("threw" in call) assert.equal(got.threw, call.threw, label);
    else assert.deepEqual(got, { out: call.out }, label);
    checked++;
  }
  assert.ok(checked > 100, "the golden holds every family");
});

test("Settings sentences: each row's is the release before's, and the file ID's says blank means this spreadsheet", () => {
  const call = GOLDEN.calls.find((c) => c.fn === "settingsDescriptionColumn");
  const names = call.args[0];
  const got = run(call).out;
  assert.equal(got.length, call.out.length);
  got.forEach((sentence, i) => {
    if (names[i] === FILE_ID) {
      assert.notEqual(sentence, call.out[i]);
      assert.equal(sentence, L.settingsDescriptions()[FILE_ID]);
    } else {
      assert.equal(sentence, call.out[i], names[i]);
    }
  });
});

test("How to: every row of the release before, in order, and one block of new sections about the new rows", () => {
  const call = GOLDEN.calls.find((c) => c.fn === "howToRows");
  const old = call.out.map((r) => JSON.stringify(r));
  const rows = run(call).out.map((r) => JSON.stringify(r));
  const added = [];
  let i = 0;
  rows.forEach((row, at) => {
    if (i < old.length && row === old[i]) i++;
    else added.push(at);
  });
  assert.equal(i, old.length, "every earlier row is there, in order");
  assert.equal(added[added.length - 1] - added[0] + 1, added.length, "one block");
  const texts = added.map((at) => JSON.parse(rows[at]).text);
  assert.equal(texts[0], NEW_SECTIONS[0]);
  assert.deepEqual(
    texts.filter((t) => NEW_SECTIONS.includes(t)),
    NEW_SECTIONS,
  );
});

test("every screen string of the release before's page is still in the page, and the brand's words leave it as written", () => {
  const files = readdirSync(new URL("src", root), { recursive: true })
    .map((f) => "src/" + f.replaceAll("\\", "/"))
    .filter(isPageSource);
  const now = new Set(files.flatMap((f) => screenStrings(f, read(f))));
  assert.ok(GOLDEN.page.length > 150);
  for (const s of GOLDEN.page) {
    assert.ok(now.has(s), "the page still says: " + s);
    assert.equal(wordText(s, BRAND_WORDS), s);
  }
});
