// All page-to-server traffic goes through KioskApi in src/api.ts, so a page served from
// somewhere else needs only another KioskApi beside gasApi and localApi. Each src file is
// read as code, with its comments, strings and JSX text left out, through the TypeScript
// parser and scanner, and only api.ts and google.d.ts may name google.script in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const src = new URL("../src/", import.meta.url);
const ALLOWED = new Set(["api.ts", "google.d.ts"]);
// Strings, backtick string parts, JSX text and regular expressions are not code.
const notCode = (node) =>
  ts.isStringTextContainingNode(node) ||
  ts.isJsxText(node) ||
  node.kind === ts.SyntaxKind.RegularExpressionLiteral;

/** The code tokens of a source text, in order: no comments, strings or JSX text. */
function codeTokens(fileName, text) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node) => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      if (!notCode(node) && node.kind !== ts.SyntaxKind.EndOfFileToken) {
        out.push(node.getText(source));
      }
      return;
    }
    children.forEach(visit);
  };
  visit(source);
  return out;
}

/** True when the code names google.script: google, any !, then . or ?. and script. */
function namesGoogleScript(fileName, text) {
  const tokens = codeTokens(fileName, text);
  return tokens.some((t, i) => {
    if (t !== "google") return false;
    let at = i + 1;
    while (tokens[at] === "!") at++;
    return (tokens[at] === "." || tokens[at] === "?.") && tokens[at + 1] === "script";
  });
}

const files = readdirSync(src, { recursive: true })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => /\.(ts|tsx)$/.test(f));

test("only api.ts and google.d.ts name google.script in their code", () => {
  assert.ok(files.length > 10);
  const naming = files.filter((f) => namesGoogleScript(f, readFileSync(new URL(f, src), "utf8")));
  assert.deepEqual(
    naming.filter((f) => !ALLOWED.has(f)),
    [],
  );
  assert.ok(naming.includes("api.ts"), "the check finds api.ts's own calls");
});

test("a file that names google.script only in comments passes", () => {
  for (const f of ["listStore.ts", "replies.ts"]) {
    const text = readFileSync(new URL(f, src), "utf8");
    assert.match(text, /google\.script/, f + " mentions it in a comment");
    assert.equal(namesGoogleScript(f, text), false, f);
  }
});

test("the check finds code and passes comments, strings and JSX text", () => {
  const found = (text, name = "x.tsx") => namesGoogleScript(name, text);
  assert.ok(found("const run = google.script.run;"));
  assert.ok(found("const run = google!\n  .script.run;"));
  assert.ok(found("const run = google?.script;"));
  assert.ok(found("const s = `${google.script.run}`;"));
  assert.equal(found("// google.script.run\nconst a = 1;"), false);
  assert.equal(found("/* google.script */ const a = 1;"), false);
  assert.equal(found('const a = "google.script";'), false);
  assert.equal(found("const a = `see google.script.run`;"), false);
  assert.equal(found("const a = <p>Uses google.script today</p>;"), false);
  assert.equal(found("const google = 1; const script = google;"), false);
});
