// This brand's Settings: a sheet gets the rows it had before the general settings, in the
// same order with the same values, then the general rows and the time zone rows with values
// that change nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const plain = (x) => JSON.parse(JSON.stringify(x));
// settingsDefaults("2026-11-13") before the general settings rows.
const BEFORE = JSON.parse(read("tests/brand-fixtures/settings-defaults-before.json"));

test("the brand names no Settings default of its own", () => {
  assert.deepEqual(plain(L.brandSettingsDefaults()), {});
});

test("settingsDefaults is the earlier list, then the general rows and the time zone rows appended last", () => {
  assert.deepEqual(plain(L.settingsDefaults("2026-11-13")), [
    ...BEFORE,
    ["Word for a person", "volunteer"],
    ["Word for people", "volunteers"],
    ["Word for staff", "board member"],
    ["Header word", ""],
    ["Organization name", ""],
    ["Logo link", ""],
    ["Roster column: first name", ""],
    ["Roster column: last name", ""],
    ["Roster column: full name", ""],
    ["Roster column: phone", ""],
    ["Roster column: email", ""],
    ["Roster column: start date", ""],
    ["Roster column: ID", ""],
    ["Milestones", "On"],
    ["Email hours", "On"],
    ["Import past hours", "On"],
    ["Tablet arrival changes", "On"],
    ["Tablet check-out changes", "On"],
    ["Time zone", "America/Chicago"],
    ["Time zone problem", ""],
  ]);
});
