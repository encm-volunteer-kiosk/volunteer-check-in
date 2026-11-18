// setupSheets on a sheet the release before set up. tests/brand-fixtures/sheet-before.json
// holds such a sheet, made by that release's setupSheets with shifts on the Log, a separate
// Profiles file named, staff columns, staff notes and a staff Settings value (see
// tests/brand-fixtures/make.mjs), and the Kiosk admin menu that release showed on it. This
// release's setupSheets may append Settings rows with their What it does sentences and add
// the How to lines about them. Every other cell, note, format, look and tab stays as it was.
// The sentences that may change on an existing row are the Profiles file ID's, which now
// says that a blank ID means this spreadsheet, and the Flags email hour's, which said
// Central time and now names the Time zone row's zone, as does its How to step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { menuOf, restoreSpreadsheet, server } from "./fakeSpreadsheet.mjs";

const root = new URL("../", import.meta.url);
const GOLDEN = new URL("tests/brand-fixtures/sheet-before.json", root);
const skip = existsSync(GOLDEN) ? false : "this brand has no sheet from an earlier release";
const plain = (x) => JSON.parse(JSON.stringify(x));

const FILE_ID = "Volunteer Profiles file ID";
// The How to sections about the appended rows, in their order on the tab.
const NEW_SECTIONS = [
  "Use your own words, name and logo",
  "Turn parts of the kiosk on or off",
  "Read your own volunteer list",
  "Set the time zone",
];
const FLAGS_HOUR = "Flags email hour";
// The How to step that said Central time, as it was and as it is now.
const HOUR_STEP = [
  "2. Change Flags email day and Flags email hour (Central time) if Monday at 8 AM doesn't suit.",
  "2. Change Flags email day and Flags email hour (in the Time zone row's zone) if Monday at 8 AM doesn't suit.",
];

function setUpAgain() {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const ss = restoreSpreadsheet(golden.sheet);
  const before = ss.snapshot();
  const S = server(ss);
  S.setupSheets();
  return { golden, ss, S, before, after: ss.snapshot() };
}

const cell = (snap, key) => {
  const hit = snap.values.find(([k]) => k === key);
  return hit ? hit[1] : "";
};
const lastRow = (snap) => Math.max(...snap.values.map(([k]) => Number(k.split(",")[0])));
const without = (snap, ...fields) => {
  const out = { ...snap };
  for (const f of fields) delete out[f];
  return out;
};

/** Each How to row as its text, formula, number format and styles, top to bottom. */
function howToRows(sheet) {
  const rows = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const styles = {};
    for (const [key, value] of sheet.styles) {
      const [name, at] = key.split(" ");
      const [row, col] = at.split(",");
      if (Number(row) === r) styles[name + " " + col] = value;
    }
    rows.push(
      JSON.stringify([
        sheet.get(r, 1),
        sheet.formulas.get(r + ",1") || "",
        sheet.formats.get(r + ",1") || "",
        styles,
      ]),
    );
  }
  return rows;
}

test(
  "setupSheets keeps every tab but Settings and How to as it was, and makes no tab",
  { skip },
  () => {
    const { before, after } = setUpAgain();
    assert.deepEqual(
      after.sheets.map((s) => s.name),
      before.sheets.map((s) => s.name),
    );
    assert.deepEqual(without(after, "sheets"), without(before, "sheets"));
    before.sheets.forEach((tab, i) => {
      if (tab.name === "Settings" || tab.name === "How to") return;
      assert.deepEqual(after.sheets[i], tab, tab.name + " is as it was");
    });
  },
);

test(
  "Settings: the rows stay, the new rows are appended with their sentences, and only the file ID's and Flags email hour's sentences change",
  { skip },
  () => {
    const { S, before, after } = setUpAgain();
    const was = before.sheets.find((s) => s.name === "Settings");
    const now = after.sheets.find((s) => s.name === "Settings");
    assert.deepEqual(without(now, "values"), without(was, "values"), "only values change");

    const end = lastRow(was);
    const names = [];
    for (let r = 1; r <= end; r++) {
      const name = cell(was, r + ",1");
      names.push(name);
      assert.equal(cell(now, r + ",1"), name, "row " + r + " name");
      assert.equal(cell(now, r + ",2"), cell(was, r + ",2"), name + " value");
      if (name === FILE_ID) {
        assert.notEqual(cell(now, r + ",3"), cell(was, r + ",3"));
        assert.equal(cell(now, r + ",3"), S.settingsDescriptions()[FILE_ID]);
      } else if (name === FLAGS_HOUR) {
        const was3 = cell(was, r + ",3");
        assert.equal(
          cell(now, r + ",3"),
          was3.replace("Central time", "in the Time zone row's zone"),
        );
      } else {
        assert.equal(cell(now, r + ",3"), cell(was, r + ",3"), name + " sentence");
      }
    }
    assert.ok(
      names.includes(FILE_ID) && cell(was, names.indexOf(FILE_ID) + 1 + ",2"),
      "a file ID is set",
    );

    const appended = plain(S.settingsDefaults("2000-01-01")).filter(
      ([name]) => !names.includes(name),
    );
    assert.ok(
      appended.some(([name]) => name === "Header word"),
      "the general rows are new to it",
    );
    assert.equal(lastRow(now), end + appended.length);
    appended.forEach(([name, value], i) => {
      const r = end + 1 + i;
      assert.deepEqual([cell(now, r + ",1"), cell(now, r + ",2")], [name, value]);
      assert.ok(cell(now, r + ",3"), name + " has a sentence");
    });
    // On a sheet with shifts, Header word and the Roster column rows stay blank.
    for (const [name, value] of appended) {
      if (name === "Header word" || name.startsWith("Roster column:"))
        assert.equal(value, "", name);
    }
  },
);

test(
  "How to: every row stays, in order and styled as it was, and the new lines are the sections about the new rows",
  { skip },
  () => {
    const { ss, before, after } = setUpAgain();
    const was = before.sheets.find((s) => s.name === "How to");
    const now = after.sheets.find((s) => s.name === "How to");
    assert.deepEqual(
      without(now, "values", "styles", "formulas", "formats"),
      without(was, "values", "styles", "formulas", "formats"),
    );

    const old = howToRows(
      restoreSpreadsheet(JSON.parse(readFileSync(GOLDEN, "utf8")).sheet).getSheetByName("How to"),
    ).map((row) => {
      const r = JSON.parse(row);
      return r[0] === HOUR_STEP[0] ? JSON.stringify([HOUR_STEP[1], ...r.slice(1)]) : row;
    });
    const rows = howToRows(ss.getSheetByName("How to"));
    const added = [];
    let i = 0;
    rows.forEach((row, at) => {
      if (i < old.length && row === old[i]) i++;
      else added.push(at);
    });
    assert.equal(i, old.length, "every earlier row is there, in order");
    assert.ok(added.length > 0);
    assert.equal(
      added[added.length - 1] - added[0] + 1,
      added.length,
      "the new lines are one block",
    );
    const texts = added.map((at) => JSON.parse(rows[at])[0]);
    assert.equal(texts[0], NEW_SECTIONS[0]);
    assert.deepEqual(
      texts.filter((t) => NEW_SECTIONS.includes(t)),
      NEW_SECTIONS,
    );
  },
);

test("the Kiosk admin menu is the one the release before showed", { skip }, () => {
  const { golden, S } = setUpAgain();
  const admin = readFileSync(new URL("apps-script/Admin.js", root), "utf8");
  assert.equal(golden.menu.length, 9);
  assert.deepEqual(menuOf(S, admin), golden.menu);
});
