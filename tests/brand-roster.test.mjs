// This brand's separate Profiles file, read with every Roster column row blank, gives what
// the release before gave: the same list and problem lines, the same emails, the same
// error for each missing column, and the same Profiles cache key.
// tests/brand-fixtures/roster-before.json holds that release's sample Profiles header and
// rows and what it read from them (made by tests/brand-fixtures/make.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const BEFORE = JSON.parse(read("tests/brand-fixtures/roster-before.json"));
const hash = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// Every Roster column row blank, as Settings reads on a sheet that never filled one; and
// no mapping at all, as a caller from before the rows existed passes.
const BLANK = plain(L.rosterColumnMapping({}));
const MAPPINGS = [
  ["blank rows", BLANK],
  ["no mapping", undefined],
];

test("every Roster column row reads blank on a Settings tab without them", () => {
  assert.ok(Object.keys(BLANK).length >= 7);
  for (const [key, value] of Object.entries(BLANK)) assert.equal(value, "", key);
});

test("the list, its problem lines and the emails are the release before's", () => {
  const { header, rows } = BEFORE;
  for (const [what, mapping] of MAPPINGS) {
    const list = plain(L.parseProfiles(header, rows, hash, mapping));
    assert.deepEqual(list, BEFORE.list, what);
    assert.deepEqual(
      plain(L.profileEmailsFrom(header, rows, list.volunteers, mapping)),
      BEFORE.emails,
      what,
    );
    const noEmail = header.map((h) => (h === "Email" ? "Other" : h));
    assert.deepEqual(
      plain(L.profileEmailsFrom(noEmail, rows, list.volunteers, mapping)),
      BEFORE.emailsNoColumn,
      what + ", no Email column",
    );
  }
});

test("a missing column gives the release before's error, word for word", () => {
  const { header, rows } = BEFORE;
  assert.ok(BEFORE.missing.filter(([, error]) => error).length >= 5);
  for (const [what, mapping] of MAPPINGS) {
    BEFORE.missing.forEach(([name, error], at) => {
      const without = header.map((x, i) => (i === at ? "Other" : x));
      const read = () => L.parseProfiles(without, rows, hash, mapping);
      if (error === null) assert.doesNotThrow(read, what + ": " + name);
      else assert.throws(read, { message: error }, what + ": " + name);
    });
  }
});

test("the Profiles cache key is the release before's", () => {
  for (const [what, mapping] of MAPPINGS) {
    for (const [fileId, tab, key] of BEFORE.cacheKeys) {
      assert.equal(L.profilesCacheKey(fileId, tab, mapping), key, what);
    }
  }
});
