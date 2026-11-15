// The saving screen's skyline (SavingSkyline in src/App.tsx, styles in src/index.css): it
// loops for as long as the save takes and adds no time of its own. These tests read the
// files as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const css = read("src/index.css");
const app = read("src/App.tsx");

test("the saving screen shows the skyline in place of the spinner", () => {
  const screen = app.slice(
    app.indexOf("function SavingScreen("),
    app.indexOf("function StatusScreen"),
  );
  assert.match(screen, /<SavingSkyline \/>/);
  assert.doesNotMatch(app + css, /save-spinner/);
  // Decoration only: the heading says what is happening.
  assert.match(app, /<svg className="saving-skyline" viewBox="0 0 240 180" aria-hidden="true">/);
});

test("the sun and the windows loop until the save ends; nothing waits on them", () => {
  assert.match(
    css,
    /\.saving-skyline \.sun \{[^}]*animation: skyline-sun 6s ease-in-out -1.5s infinite;/,
  );
  assert.match(css, /\.saving-skyline \.window \{[^}]*animation: skyline-window 4s infinite;/);
  // No animation end is listened for, so the reply moves the screen on at once.
  assert.doesNotMatch(app, /onAnimationEnd|animationend/);
});

test("without motion the sun stays overhead and every window is lit", () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n  \.saving-skyline \.sun,\n  \.saving-skyline \.window \{\n    animation: none;\n  \}\n  \.saving-skyline \.window \{\n    fill: var\(--yellow\);\n  \}\n\}/,
  );
});
