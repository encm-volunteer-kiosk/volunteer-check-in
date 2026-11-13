// Apps Script keeps one name per file, without its extension: a project can't hold both
// Admin.js and Admin.html, and `clasp push` refuses the whole push when two files share a
// name. This checks every file the push sends, plus Index.html, which the build writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../apps-script/", import.meta.url));

test("every Apps Script file has a name no other file uses", () => {
  const files = new Set(readdirSync(dir).filter((f) => /\.(js|gs|html)$/.test(f)));
  files.add("Index.html");
  const seen = new Map();
  for (const file of files) {
    const name = file.replace(/\.[^.]+$/, "");
    assert.ok(!seen.has(name), `${file} and ${seen.get(name)} share the name ${name}`);
    seen.set(name, file);
  }
});

// Apps Script loads every server file into one global scope, so when two files define a
// function with the same name, only one of them is kept, and which one depends on load
// order. Each top-level function name must be defined in one file only.
test("no top-level function is defined in two server files", () => {
  const files = readdirSync(dir).filter((f) => /\.js$/.test(f));
  const seen = new Map();
  const repeated = [];
  for (const file of files) {
    const text = readFileSync(dir + file, "utf8");
    for (const m of text.matchAll(/^function ([A-Za-z0-9_$]+)/gm)) {
      const name = m[1];
      if (seen.has(name) && seen.get(name) !== file) {
        repeated.push(name + " in " + seen.get(name) + " and " + file);
      } else seen.set(name, file);
    }
  }
  assert.ok(seen.size > 100, "found " + seen.size + " functions");
  assert.deepEqual(repeated, []);
});
