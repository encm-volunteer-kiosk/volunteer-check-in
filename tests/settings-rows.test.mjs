// The general settings rows: their code defaults read as the kiosk's behaviour before
// the rows existed, through the same parsers the kiosk uses, and the parsers read what
// staff type the way each row's What it does sentence says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { BRAND } from "./brandFiles.mjs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const plain = (x) => JSON.parse(JSON.stringify(x));

const BEFORE_WORDS = {
  person: "volunteer",
  personArticle: "a",
  people: "volunteers",
  staff: "board member",
  staffArticle: "a",
};
const ALL_ON = {
  milestones: true,
  emailHours: true,
  importPastHours: true,
  arrivalChanges: true,
  checkOutChanges: true,
};

test("each row's code default, and a missing row, read as the kiosk before the rows", () => {
  const written = Object.fromEntries(plain(L.generalSettingsDefaults()));
  for (const settings of [written, {}, undefined]) {
    assert.deepEqual(plain(L.kioskWords(settings)), BEFORE_WORDS);
    assert.deepEqual(plain(L.kioskSwitches(settings)), ALL_ON);
    assert.equal(L.headerWord(settings), "volunteer");
    assert.equal(L.kioskOrganizationName(settings), BRAND.brandOrganizationName());
    assert.equal(L.kioskSenderName(settings), BRAND.brandSenderName());
    assert.equal(L.parseLogoLink((settings || {})["Logo link"]), "");
    assert.deepEqual(Object.values(plain(L.rosterColumnMapping(settings))), [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }
});

test("the general rows come after every older row, each once, with a sentence", () => {
  const rows = plain(L.settingsDefaults("2026-11-13"));
  const general = plain(L.generalSettingsDefaults());
  assert.equal(general.length, 18);
  assert.deepEqual(
    rows.slice(-general.length).map((r) => r[0]),
    general.map((r) => r[0]),
  );
  const names = rows.map((r) => r[0]);
  assert.equal(new Set(names).size, names.length);
  const d = plain(L.settingsDescriptions());
  general.forEach(([name]) => assert.ok(d[name], name));
});

test("an On/Off row reads on and off in any case, and anything else as its default", () => {
  for (const text of ["on", "On", " ON ", "oN"])
    assert.equal(L.parseOnOffSetting(text, false), true);
  for (const text of ["off", "Off", " OFF\n"]) assert.equal(L.parseOnOffSetting(text, true), false);
  for (const text of ["", "  ", "of", "yes", "no", "true", "0", "On.", undefined, null]) {
    assert.equal(L.parseOnOffSetting(text, true), true, String(text));
    assert.equal(L.parseOnOffSetting(text, false), false, String(text));
  }
  const s = L.kioskSwitches({
    Milestones: "off",
    "Tablet check-out changes": "OFF",
    "Email hours": "Of",
  });
  assert.deepEqual(plain(s), { ...ALL_ON, milestones: false, checkOutChanges: false });
});

test("a word row takes its article from the word, or from the one typed before it", () => {
  const word = (text) => plain(L.parseWordSetting(text, "volunteer"));
  assert.deepEqual(word("usher"), { word: "usher", article: "a" });
  assert.deepEqual(word("an usher"), { word: "usher", article: "an" });
  assert.deepEqual(word("a user"), { word: "user", article: "a" });
  assert.deepEqual(word("An hourly helper"), { word: "hourly helper", article: "an" });
  assert.deepEqual(word("  greeter  "), { word: "greeter", article: "a" });
  assert.deepEqual(word("attendee"), { word: "attendee", article: "an" });
  assert.deepEqual(word("intern"), { word: "intern", article: "an" });
  assert.deepEqual(word("organizer"), { word: "organizer", article: "an" });
  assert.deepEqual(word("elder"), { word: "elder", article: "an" });
  assert.deepEqual(word("staff  member"), { word: "staff member", article: "a" });
  assert.deepEqual(word(""), { word: "volunteer", article: "a" });
  const w = plain(L.kioskWords({ "Word for a person": "an usher", "Word for people": " ushers " }));
  assert.equal(w.person, "usher");
  assert.equal(w.personArticle, "an");
  assert.equal(w.people, "ushers");
  assert.equal(L.headerWord({ "Header word": "An Usher" }), "Usher");
});

test("Organization name names the sender, and blank keeps the brand's", () => {
  const s = { "Organization name": "  Hillside Pantry " };
  assert.equal(L.kioskOrganizationName(s), "Hillside Pantry");
  assert.equal(L.kioskSenderName(s), "Hillside Pantry Check-In Kiosk");
  assert.equal(L.kioskSenderName({ "Organization name": " " }), BRAND.brandSenderName());
});

test("a Logo link is used only when it starts https://", () => {
  assert.equal(L.parseLogoLink(" https://example.org/logo.png "), "https://example.org/logo.png");
  for (const text of ["http://example.org/logo.png", "example.org/logo.png", "ftp://x", "", null]) {
    assert.equal(L.parseLogoLink(text), "", String(text));
  }
});

test("a Roster column row is the trimmed header text it holds", () => {
  const m = plain(
    L.rosterColumnMapping({ "Roster column: full name": "  Name ", "Roster column: ID": "Badge" }),
  );
  assert.equal(m.fullName, "Name");
  assert.equal(m.token, "Badge");
  assert.equal(m.firstName, "");
});

test("a row the brand gives a default gets the brand's value on a new sheet, every other the code's", () => {
  const B = {};
  vm.runInNewContext(
    read("apps-script/Logic.js") +
      '\nfunction brandSettingsDefaults() { return { "Word for staff": "staff member", "Import past hours": "Off" }; }',
    B,
  );
  const rows = Object.fromEntries(plain(B.settingsDefaults("2026-11-13")));
  const code = Object.fromEntries(plain(L.settingsDefaults("2026-11-13")));
  assert.equal(rows["Word for staff"], "staff member");
  assert.equal(rows["Import past hours"], "Off");
  for (const name of Object.keys(code)) {
    if (name !== "Word for staff" && name !== "Import past hours")
      assert.equal(rows[name], code[name], name);
  }
});
