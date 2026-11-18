// Tests for the kiosk's time zone on the page (src/kioskZone.ts, imported as it is; Node
// strips its types): the zone the list reply carries in the page's Settings, the zone a reply
// or kept list without it reads as (America/Chicago), and the kept list's day check in the
// zone it was kept with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { kioskDay, kioskZone, setKioskZone, UNNAMED_ZONE, zoneOf } from "../src/kioskZone.ts";
import { isPageSettings, pageSettingsOf } from "../src/words.ts";
import { readStoredList, storeList, noListExtras } from "../src/listStore.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);

const MINUTE = 60_000;
const CHICAGO = "America/Chicago";
const LONDON = "Europe/London";

function fakeStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

/** Runs fn with the page on zone, then puts the page back on Chicago. */
function inZone(zone, fn) {
  setKioskZone(zone);
  try {
    return fn();
  } finally {
    setKioskZone(undefined);
  }
}

test("the list reply's page Settings carry the Time zone row's zone", () => {
  assert.equal(L.pageSettings({}).timeZone, CHICAGO);
  assert.equal(L.pageSettings({ "Time zone": " Europe/London " }).timeZone, LONDON);
  // The name Intl gives the row: wrong capitals read as the proper spelling.
  assert.equal(L.pageSettings({ "Time zone": "europe/london" }).timeZone, LONDON);
  // Blank or not a zone: the tablet is refused before it gets a list, and the field is "".
  assert.equal(L.pageSettings({ "Time zone": "" }).timeZone, "");
  assert.equal(L.pageSettings({ "Time zone": "Mars/Base" }).timeZone, "");
  const sent = plain(L.pageSettings({ "Time zone": "Asia/Kolkata" }));
  const read = pageSettingsOf(sent);
  assert.equal(read.timeZone, sent.timeZone);
  assert.equal(isPageSettings(read), true);
});

test("a reply without the zone, or with one the browser doesn't know, reads as Chicago", () => {
  const sent = plain(L.pageSettings({}));
  delete sent.timeZone;
  // A server older than the Time zone row.
  assert.equal(pageSettingsOf(sent).timeZone, CHICAGO);
  for (const odd of ["", "Mars/Base", 5, null]) {
    assert.equal(pageSettingsOf({ ...sent, timeZone: odd }).timeZone, CHICAGO, String(odd));
    assert.equal(zoneOf(odd), CHICAGO, String(odd));
  }
  assert.equal(UNNAMED_ZONE, CHICAGO);
  assert.equal(zoneOf(LONDON), LONDON);
});

test("kept page Settings with no zone are still page Settings; a zone that isn't text isn't", () => {
  const ps = pageSettingsOf(plain(L.pageSettings({ "Time zone": LONDON })));
  const older = { ...ps };
  delete older.timeZone;
  assert.equal(isPageSettings(older), true);
  assert.equal(isPageSettings(ps), true);
  assert.equal(isPageSettings({ ...ps, timeZone: 3 }), false);
  assert.equal(isPageSettings({ ...ps, timeZone: null }), false);
});

test("the page works in the zone it was given, and in Chicago until then", () => {
  assert.equal(kioskZone(), CHICAGO);
  // 2026-11-14 00:30 in London is 2026-11-13 18:30 in Chicago.
  const ms = Date.parse("2026-11-14T00:30:00Z");
  assert.equal(kioskDay(ms), "2026-11-13");
  inZone(LONDON, () => {
    assert.equal(kioskZone(), LONDON);
    assert.equal(kioskDay(ms), "2026-11-14");
    assert.equal(kioskDay(ms, CHICAGO), "2026-11-13");
  });
  inZone("Mars/Base", () => assert.equal(kioskZone(), CHICAGO));
  assert.equal(kioskZone(), CHICAGO);
});

test("a kept list is used on the same day in the zone it was kept with, whatever the page's", () => {
  // 11:58 PM in London on Nov 13, read 5 minutes later: Nov 14 in London, still Nov 13
  // (evening) in Chicago.
  const saved = Date.parse("2026-11-13T23:58:00Z");
  const now = saved + 5 * MINUTE;
  const keep = (timeZone) => {
    const storage = fakeStorage();
    const pageSettings = pageSettingsOf(plain(L.pageSettings({ "Time zone": timeZone })));
    storeList(storage, "4417", saved, [], 8, { ...noListExtras, pageSettings });
    return storage;
  };
  for (const pageZone of [CHICAGO, LONDON]) {
    inZone(pageZone, () => {
      assert.equal(readStoredList(keep(LONDON), "4417", now), null, pageZone);
      assert.ok(readStoredList(keep(CHICAGO), "4417", now), pageZone);
      // Kept with no page Settings, as a page before them kept it: Chicago's day.
      const storage = fakeStorage();
      storeList(storage, "4417", saved, [], 8);
      assert.ok(readStoredList(storage, "4417", now), pageZone);
    });
  }
  // The kept zone comes back with the list, for the page to work in.
  const kept = readStoredList(keep(LONDON), "4417", saved + MINUTE);
  assert.equal(kept.pageSettings.timeZone, LONDON);
});
