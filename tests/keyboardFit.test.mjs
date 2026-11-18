// The landscape welcome screen keeps the name box and its results above an iPad's on-screen
// keyboard (index.css, the block for landscape at 821 px and wider). These tests read
// src/index.css and src/App.tsx as text, and import src/searchOpen.ts as it is (Node strips
// its types).
//
// The limits are for the smallest iPad the kiosk meets, 1024x768 in landscape, where the
// kiosk's frame is 1024x653 with Google's bar showing above it:
// - Safari leaves the page alone when a tapped box lies above the keyboard by at least 50 pt,
//   which there means the field must end by frame y 196;
// - the keyboard's top is at frame y 246, and the results area keeps 11 pt clear of it, so it
//   must end by frame y 235;
// - the results area shows two whole rows and part of a third.
//
// The logo and date sit in a row under the name card there, below everything these limits
// cover, and slide with the card while the name box is in use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchOpenAfter } from "../src/searchOpen.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const css = read("src/index.css");
const app = read("src/App.tsx");

const SCOPE = "@media (orientation: landscape) and (min-width: 821px)";
const SHELL = ".app-shell.screen-welcome:not(.setup)";

/**
 * A small CSS reader: a list of rules, each { selector, decls, media }, where media is the
 * list of @media preludes the rule sits in, outermost first. Enough for this file.
 */
function parseCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  function block(media) {
    let buffer = "";
    while (i < src.length) {
      const ch = src[i++];
      if (ch === "{") {
        const prelude = buffer.trim();
        buffer = "";
        if (prelude.startsWith("@media")) block([...media, prelude.replace(/\s+/g, " ")]);
        else if (prelude.startsWith("@")) skip();
        else rules.push({ selector: prelude.replace(/\s+/g, " "), decls: body(), media });
      } else if (ch === "}") {
        return;
      } else if (ch === ";" && buffer.trim().startsWith("@")) {
        buffer = "";
      } else {
        buffer += ch;
      }
    }
  }
  function skip() {
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i++];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  function body() {
    const start = i;
    skip();
    const decls = {};
    for (const part of src.slice(start, i - 1).split(";")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      decls[part.slice(0, at).trim()] = part
        .slice(at + 1)
        .trim()
        .replace(/\s+/g, " ");
    }
    return decls;
  }
  block([]);
  return rules;
}

const rules = parseCss(css);
const selectorsOf = (rule) => rule.selector.split(",").map((s) => s.trim());
const inScope = (rule) => rule.media[0] === SCOPE;
/** The one declaration `prop` of `selector` in the landscape block, outside any nested @media. */
function scoped(selector, prop) {
  const found = rules.filter(
    (r) =>
      inScope(r) && r.media.length === 1 && selectorsOf(r).includes(selector) && prop in r.decls,
  );
  assert.equal(found.length, 1, `one ${prop} for ${selector} in the landscape block`);
  return found[0].decls[prop];
}
const px = (value) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
  assert.ok(m, `${value} is a length in px`);
  return Number(m[1]);
};

test("the header and greeting no longer collapse while a name is typed", () => {
  assert.ok(!css.includes("has-query"), "index.css has no has-query rule");
  assert.ok(!app.includes("has-query"), "App.tsx sets no has-query class");
  assert.ok(!/hasQuery|HasQuery/.test(app), "App.tsx keeps no has-query state");
});

test("the name field and results area fit above the keyboard on a 1024x768 iPad", () => {
  const prop = (name) => px(scoped(SHELL, name));
  const top = prop("--search-top");
  const field = prop("--search-field-height");
  const gap = prop("--results-gap");
  const results = prop("--results-height");
  const row = prop("--result-row-height");
  const rowGap = prop("--result-row-gap");

  assert.ok(top + field <= 196, `field ends at ${top + field}, Safari scrolls past 196`);
  const resultsEnd = top + field + gap + results;
  assert.ok(resultsEnd <= 235, `results end at ${resultsEnd}, past 235`);
  assert.ok(2 * row + rowGap <= results, "two whole rows fit");
  assert.ok(2 * row + 2 * rowGap < results, "part of a third row shows");
  // Positive lengths, so a sum above can't come out right by a negative one.
  for (const value of [prop("--card-border"), prop("--card-padding"), gap, rowGap])
    assert.ok(value >= 0);
});

test("every length from the screen's top to the results area's bottom is one of the properties", () => {
  const card = ".app-shell.screen-welcome:not(.setup) .name-search-card";
  assert.equal(
    scoped(card, "margin-top"),
    "calc(var(--search-top) - var(--card-padding) - var(--card-border))",
  );
  assert.equal(scoped(card, "border-width"), "var(--card-border)");
  assert.equal(scoped(card, "padding"), "var(--card-padding)");

  const field = ".app-shell.screen-welcome:not(.setup) .name-search-field";
  assert.equal(scoped(field, "height"), "var(--search-field-height)");
  assert.equal(scoped(field, "min-height"), "0");

  const list = ".app-shell.screen-welcome:not(.setup) .name-results";
  for (const prop of ["height", "min-height", "max-height"])
    assert.equal(scoped(list, prop), "var(--results-height)", prop);
  assert.equal(scoped(list, "margin-top"), "var(--results-gap)");
  assert.equal(scoped(list, "gap"), "var(--result-row-gap)");
  assert.equal(scoped(list, "overscroll-behavior"), "contain");

  const row = ".app-shell.screen-welcome:not(.setup) .name-results .volunteer-card";
  assert.equal(scoped(row, "height"), "var(--result-row-height)");

  // Nothing shows above the card: no header, greeting or prompt line.
  for (const hidden of [".header", ".name-entry-hero", ".match-prompt", ".type-prompt"])
    assert.equal(scoped(`${SHELL} ${hidden}`, "display"), "none", hidden);
  const welcome = `${SHELL} .welcome`;
  assert.equal(scoped(welcome, "min-height"), "0");
  // Keeps the card's top margin inside the welcome block, so the page gains no scroll range.
  assert.equal(scoped(welcome, "display"), "flow-root");
  assert.equal(
    scoped(`${SHELL} .checkin-sidebar`, "overscroll-behavior"),
    "contain",
    "the panel's list keeps its swipes too",
  );
});

test("the panel slides aside and the card and the logo and date row slide right, by transform and visibility only, inside the landscape block", () => {
  const open = rules.filter((r) => r.selector.includes("search-open"));
  assert.ok(open.length >= 2, "rules for the card and the panel");
  for (const rule of open) {
    assert.equal(rule.media[0], SCOPE, `${rule.selector} sits in the landscape block`);
    for (const prop of Object.keys(rule.decls))
      assert.ok(
        prop === "transform" || prop === "visibility" || prop.startsWith("transition"),
        `${rule.selector} sets ${prop}`,
      );
  }

  const card = `${SHELL}.search-open .name-search-card`;
  const panel = `${SHELL}.search-open .checkin-sidebar`;
  assert.equal(scoped(card, "transform"), "translateX(calc(var(--sidebar-width) / 2))");
  assert.equal(scoped(panel, "transform"), "translateX(100%)");
  assert.equal(scoped(panel, "visibility"), "hidden");
  // The logo and date row moves with the card: the same move, the same timing.
  const row = `${SHELL}.search-open .welcome-header`;
  assert.equal(scoped(row, "transform"), scoped(card, "transform"));
  assert.equal(
    scoped(`${SHELL} .welcome-header`, "transition"),
    scoped(`${SHELL} .name-search-card`, "transition"),
  );
  assert.equal(
    scoped(`${SHELL} .welcome-header`, "transition"),
    "transform var(--slide-duration) var(--slide-ease)",
  );

  const motion = [
    scoped(`${SHELL} .name-search-card`, "transition"),
    scoped(`${SHELL} .checkin-sidebar`, "transition"),
    scoped(panel, "transition"),
  ];
  for (const value of motion) {
    assert.match(value, /\btransform var\(--slide-duration\)/);
  }
  // Hidden once the slide out ends; visible from the first frame back.
  assert.match(scoped(panel, "transition"), /visibility 0s linear var\(--slide-duration\)/);
  assert.match(scoped(`${SHELL} .checkin-sidebar`, "transition"), /visibility 0s linear 0s/);

  // A slide must stay a transition (Safari puts the caret back in the box at its end).
  for (const rule of rules) {
    const touches = selectorsOf(rule).some(
      (s) =>
        s.endsWith(".name-search-card") ||
        s.endsWith(".checkin-sidebar") ||
        s.endsWith(".welcome-header"),
    );
    if (!touches) continue;
    assert.notEqual(rule.decls.transition, "none", rule.selector);
    assert.notEqual(rule.decls["transition-property"], "none", rule.selector);
    // Only the transition shorthand times the slide; a separate duration would override it.
    assert.equal(rule.decls["transition-duration"], undefined, rule.selector);
  }
});

test("the logo and date sit under the card, not in the panel", () => {
  assert.ok(!app.includes("sidebar-header"), "App.tsx has no sidebar-header");
  assert.ok(!css.includes("sidebar-header"), "index.css has no sidebar-header");

  const welcome = app.slice(
    app.indexOf("function Welcome("),
    app.indexOf("function CheckedInSidebar("),
  );
  const card = welcome.indexOf('aria-label={w("Find your volunteer profile")}');
  const start = welcome.indexOf('<div className="welcome-header">');
  assert.ok(card > 0, "the name card");
  assert.ok(start > card, "the row comes after the name card");
  assert.ok(start < welcome.indexOf('className="tagline"'), "and before the tagline");
  const row = welcome.slice(start, welcome.indexOf("</div>", start));
  assert.match(row, /className="logo"/);
  assert.match(row, /<DateBlock \/>/);

  const sidebarStart = app.indexOf("function CheckedInSidebar(");
  const sidebar = app.slice(sidebarStart, app.indexOf("\nfunction ", sidebarStart + 1));
  assert.ok(!sidebar.includes('className="logo"'), "no logo in the panel");
  assert.ok(!sidebar.includes("<DateBlock"), "no date in the panel");

  // Hidden everywhere but the landscape block.
  const rowSelector = `${SHELL} .welcome-header`;
  const base = rules.filter(
    (r) => r.media.length === 0 && selectorsOf(r).includes(".welcome-header"),
  );
  assert.equal(base.length, 1);
  assert.equal(base[0].decls.display, "none");
  assert.equal(scoped(rowSelector, "display"), "flex");
  assert.equal(scoped(rowSelector, "margin"), "48px auto 0");
  assert.equal(scoped(rowSelector, "width"), "min(720px, 100%)");
  assert.equal(scoped(`${rowSelector} .logo`, "width"), "180px");

  // It sits where the page puts it: no rule places or moves it, except the slide and the
  // hours search's fixed place.
  for (const rule of rules) {
    if (
      !rule.selector.includes(".welcome-header") ||
      rule.selector.includes("search-open") ||
      rule.selector.includes("hours-search")
    )
      continue;
    for (const prop of ["position", "top", "transform"])
      assert.equal(rule.decls[prop], undefined, `${rule.selector} sets ${prop}`);
  }

  // A frame under 400 pt tall leaves the row out, so it never ends past the frame's bottom.
  const short = rules.filter(
    (r) =>
      inScope(r) &&
      r.media.length === 2 &&
      r.media[1] === "@media (max-height: 399px)" &&
      selectorsOf(r).includes(rowSelector),
  );
  assert.equal(short.length, 1, "one short-frame rule for the row");
  assert.equal(short[0].decls.display, "none");
  const shown = rules.findIndex(
    (r) => inScope(r) && r.media.length === 1 && selectorsOf(r).includes(rowSelector),
  );
  assert.ok(rules.indexOf(short[0]) > shown, "the short-frame rule comes after the row's own");
});

test("with reduced motion the panel hides at once, leaving no strip at the edge", () => {
  const reduced = rules.filter(
    (r) =>
      inScope(r) &&
      r.media.includes("@media (prefers-reduced-motion: reduce)") &&
      selectorsOf(r).includes(`${SHELL}.search-open .checkin-sidebar`),
  );
  assert.equal(reduced.length, 1);
  assert.match(reduced[0].decls.transition, /visibility 0s linear 0s/);
  assert.match(reduced[0].decls.transition, /\btransform var\(--slide-duration\)/);
  // The house rule cuts every transition to almost nothing rather than removing it.
  assert.match(css, /transition-duration: 0\.01ms !important/);
});

test("a click or a typed change sends the panel aside; focus and Clear alone don't", () => {
  assert.equal(searchOpenAfter(false, "click"), true);
  assert.equal(searchOpenAfter(false, "typed"), true);
  assert.equal(searchOpenAfter(false, "focus"), false);
  assert.equal(searchOpenAfter(false, "clear"), false);
  assert.equal(searchOpenAfter(false, "blur"), false);
  assert.equal(searchOpenAfter(false, "unmount"), false);
});

test("leaving the box or the screen brings the panel back; nothing else does", () => {
  assert.equal(searchOpenAfter(true, "blur"), false);
  assert.equal(searchOpenAfter(true, "unmount"), false);
  assert.equal(searchOpenAfter(true, "focus"), true);
  assert.equal(searchOpenAfter(true, "clear"), true);
  assert.equal(searchOpenAfter(true, "click"), true);
  assert.equal(searchOpenAfter(true, "typed"), true);
});

/** The text of `{ ... }` starting at `open`, braces matched. */
function braced(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(open + 1, j);
  }
  throw new Error("unbalanced braces");
}
/** The JSX event handlers on the element starting at `start`: { name: body }. */
function handlers(text, start) {
  const out = {};
  let j = start;
  // Walk attribute by attribute until the tag closes outside any braces.
  while (j < text.length) {
    if (text[j] === "{") {
      j += braced(text, j).length + 2;
      continue;
    }
    if (text[j] === ">") break;
    const m = /^(on[A-Z]\w*)=\{/.exec(text.slice(j));
    if (m) {
      const value = braced(text, j + m[1].length + 1);
      out[m[1]] = value;
      j += m[1].length + 1 + value.length + 2;
      continue;
    }
    j++;
  }
  return out;
}

test("only a click, a typed change and blur on the name box reach the panel", () => {
  const input = app.indexOf("<input\n            ref={searchRef}");
  assert.ok(input > 0, "the name input");
  const on = handlers(app, input);
  const reaching = Object.keys(on).filter((name) => /reportSearch|onSearchOpen/.test(on[name]));
  assert.deepEqual(reaching.sort(), ["onBlur", "onChange", "onClick"]);
  for (const name of ["onFocus", "onPointerDown", "onPointerUp", "onTouchStart", "onTouchEnd"])
    assert.ok(!(name in on), `no ${name} on the name box`);
  assert.match(on.onClick, /reportSearch\("click"\)/);
  assert.match(on.onBlur, /reportSearch\("blur"\)/);
  assert.match(on.onChange, /reportSearch\("typed"\)/);

  // The screen tells the app only through the rule, and says false when it closes.
  const welcome = app.slice(
    app.indexOf("function Welcome("),
    app.indexOf("function CheckedInSidebar("),
  );
  assert.equal(welcome.match(/onSearchOpen\(/g).length, 1);
  assert.match(welcome, /searchOpenAfter\(searchOpen\.current, event\)/);
  assert.match(welcome, /useEffect\(\(\) => \(\) => reportSearch\("unmount"\), \[\]\)/);
  // The app renders the class from its state, on the welcome screen only.
  assert.match(app, /\$\{searchOpen && screen === "welcome" \? " search-open" : ""\}/);
});

test("the hours search keeps one landscape place: the card where it sits with the panel aside", () => {
  const card = `${SHELL}.hours-search .name-search-card`;
  const row = `${SHELL}.hours-search .welcome-header`;
  const hours = rules.filter((r) => r.selector.includes("hours-search"));
  assert.equal(hours.length, 1);
  assert.equal(hours[0].media[0], SCOPE, "in the landscape block");
  assert.deepEqual(Object.keys(hours[0].decls), ["transform"], "it only places the card and row");
  assert.equal(
    scoped(card, "transform"),
    scoped(`${SHELL}.search-open .name-search-card`, "transform"),
  );
  assert.equal(scoped(row, "transform"), scoped(card, "transform"));
  // The class comes from the screen alone, never from focus or typing; it keeps the welcome
  // screen's layout, and the panel isn't rendered there.
  assert.match(app, /const shellScreen = screen === "hours" \? "welcome hours-search" : screen;/);
  const hoursScreen = app.slice(
    app.indexOf('{code && screen === "hours" && ('),
    app.indexOf('{code && screen === "hours-confirm"'),
  );
  assert.ok(!hoursScreen.includes("CheckedInSidebar"));
  assert.match(hoursScreen, /focusOnOpen=\{false\}/);
  assert.match(hoursScreen, /onSearchOpen=\{\(\) => \{\}\}/);
});

test("tapping Clear keeps focus in the name box", () => {
  const clear = app.lastIndexOf("<button", app.indexOf('aria-label="Clear name"'));
  const on = handlers(app, clear);
  assert.match(on.onMouseDown, /event\.preventDefault\(\)/);
  assert.match(on.onClick, /updateQuery\(""\)/);
});

test("a tap that goes home leaves the name box unfocused; load and timers still focus it", () => {
  // Focus given during a tap raises the tablet's keyboard, and focus alone keeps the panel in
  // place, so the box focuses itself only when no tap brought the welcome screen up.
  const input = app.indexOf("<input\n            ref={searchRef}");
  // The hours search never focuses its box by itself.
  assert.match(app.slice(input, input + 120), /autoFocus=\{focusOnOpen && !hours\}/);
  assert.match(app, /focusOnOpen=\{focusNameBox\}/);
  assert.match(app, /useState\(true\);\n  const \[screen, setScreen\]/);
  assert.match(app, /const goHome = \(byTap = false\) => \{\n    setFocusNameBox\(!byTap\);/);
  assert.match(app, /const tapHome = \(\) => goHome\(true\);/);
  // Every button home is a tap; none hands goHome its click event.
  assert.doesNotMatch(app, /=\{goHome\}/);
  assert.equal(app.match(/onBack=\{tapHome\}/g).length, 3);
  assert.equal(app.match(/onBack: tapHome/g).length, 1, "the hours search's Back");
  assert.equal(app.match(/onDone=\{tapHome\}/g).length, 4);
  // The timers go home as no tap, and pass setTimeout no function that takes the flag.
  assert.equal(app.match(/window\.setTimeout\(\(\) => goHome\(\), ms\)/g).length, 2);
  assert.doesNotMatch(app, /setTimeout\(goHome/);
});

// The phone step (last four digits) in landscape: while the box has focus, the card sits at
// the top of the screen with its message, the box and both buttons above the keyboard. The
// same limits as the name box: the box ends by frame y 196, the card by 235.
const PHONE = ".confirmation-panel.phone-check";
const FOCUSED = `${PHONE}:focus-within`;

test("the phone step's box and buttons fit above the keyboard on a 1024x768 iPad", () => {
  const prop = (name) => px(scoped(PHONE, name));
  const top = prop("--phone-top");
  const border = prop("--phone-border");
  const padding = prop("--phone-padding");
  const boxEnd =
    top +
    border +
    padding +
    2 * prop("--phone-line") +
    prop("--phone-gap") +
    prop("--phone-box-height");
  assert.ok(boxEnd <= 196, `box ends at ${boxEnd}, Safari scrolls past 196`);
  const cardEnd =
    boxEnd +
    prop("--phone-box-margin") +
    prop("--phone-buttons-gap") +
    prop("--phone-button-height") +
    padding +
    border;
  assert.ok(cardEnd <= 235, `card ends at ${cardEnd}, past 235`);
});

test("every length from the screen's top to the phone card's bottom is one of the properties", () => {
  // The card's top margin undoes the screen's 30px top padding.
  const screen = rules.find(
    (r) => r.media.length === 0 && selectorsOf(r).includes(".center-screen"),
  );
  assert.equal(screen.decls.padding, "30px");
  assert.equal(scoped(FOCUSED, "margin-top"), "calc(var(--phone-top) - 30px)");
  assert.equal(scoped(FOCUSED, "align-self"), "start");
  assert.equal(scoped(FOCUSED, "padding"), "var(--phone-padding) 30px");
  assert.equal(scoped(FOCUSED, "border-width"), "var(--phone-border)");
  for (const hidden of [".spark", ".eyebrow", "h1"])
    assert.equal(scoped(`${FOCUSED} ${hidden}`, "display"), "none", hidden);
  assert.equal(scoped(`${FOCUSED} > p`, "margin"), "0 auto var(--phone-gap)");
  assert.equal(scoped(`${FOCUSED} > p`, "line-height"), "var(--phone-line)");
  assert.equal(scoped(`${FOCUSED} .phone-digits`, "margin-bottom"), "var(--phone-box-margin)");
  assert.equal(scoped(`${FOCUSED} .phone-digits input`, "height"), "var(--phone-box-height)");
  assert.equal(scoped(`${FOCUSED} .phone-digits input`, "min-height"), "0");
  assert.equal(scoped(`${FOCUSED} .button-stack`, "grid-template-columns"), "1fr 1fr");
  assert.equal(scoped(`${FOCUSED} .button-stack`, "margin-top"), "var(--phone-buttons-gap)");
  assert.equal(scoped(`${FOCUSED} .button`, "height"), "var(--phone-button-height)");
  assert.equal(scoped(`${FOCUSED} .button`, "min-height"), "0");
});

test("the phone card changes only with focus, only in landscape, and only on the phone step", () => {
  // Focus itself, not a script: Safari measures the box for the keyboard before the page
  // hears about the focus, and a style that follows focus is in place by then.
  for (const rule of rules.filter((r) => r.selector.includes("phone-check"))) {
    assert.equal(rule.media[0], SCOPE, `${rule.selector} sits in the landscape block`);
    for (const selector of selectorsOf(rule)) {
      if (selector === PHONE) {
        for (const prop of Object.keys(rule.decls)) assert.ok(prop.startsWith("--phone-"), prop);
      } else {
        assert.ok(selector.startsWith(FOCUSED), selector);
      }
    }
  }
  // The check-in and check-out screens, and the hours confirm screen.
  assert.equal(app.match(/\$\{phoneStep === "entry" \? " phone-check" : ""\}/g).length, 2);
  assert.equal(app.match(/phone-check/g).length, 2);
});

test("the phone box asks for a code, with the number keyboard", () => {
  const start = app.indexOf("function PhoneDigits(");
  const box = app.slice(start, app.indexOf("\nfunction ", start + 1));
  assert.match(box, /inputMode="numeric"/);
  assert.match(box, /autoComplete="one-time-code"/);
  assert.match(box, /autoFocus\n/);
});
