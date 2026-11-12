// Apps Script keeps one name per file, without its extension: a project can't hold both
// Admin.js and Admin.html, and `clasp push` refuses the whole push when two files share a
// name. This checks every file the push sends, plus Index.html, which the build writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
