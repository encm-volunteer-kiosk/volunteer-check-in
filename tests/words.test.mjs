// The sheet's words: Word for a person, Word for people, Word for staff and Header word.
// Text is written with the default words, and wordText gives it in the sheet's: the server's
// (Logic.js), the page's (src/words.ts) and the admin window's lines, which the server words.
// Under the default words every text is as written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as page from "../src/words.ts";
import { readStoredList, storeList, noListExtras } from "../src/listStore.ts";
import { BRAND_LOGO_URL, BRAND_ORGANIZATION_NAME } from "../src/brand.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

function logic() {
  const L = {};
  vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
  return L;
}
const L = logic();

const settings = (person, people, staff, header = "") => ({
  "Word for a person": person,
  "Word for people": people,
  "Word for staff": staff,
  "Header word": header,
});
// "an usher": the rule alone gives a u word "a", so the row's article is typed.
const USHER = plain(L.sheetWords(settings("an usher", "ushers", "staff member", "usher")));
const HELPER = plain(L.sheetWords(settings("an hourly helper", "hourly helpers", "a coordinator")));

const SAMPLES = [
  "This kiosk needs to be set up. Please ask a board member.",
  "A volunteer taps the link, finds their name, and taps Send.",
  "Volunteers who asked on the tablet arrive ticked.",
  "The volunteer's first and last name, from Volunteer Profiles.",
  "Thank you for volunteering.",
  "Thank you for volunteering with us.",
  "Keep Volunteering",
  "Please try again or ask a volunteer coordinator for help.",
  "Board member: kiosk access code",
  "The header of the volunteer list's first name column; blank means Volunteer First Name.",
  "Rename Volunteer Name and Volunteer Role/Type on the Log.",
  'The Log has no "volunteer name" column.',
  "Volunteer hour value on the Settings tab",
  "",
];

test("under the default words, or none, every text is as written", () => {
  const defaults = plain(L.defaultWords());
  assert.deepEqual(defaults, {
    person: "volunteer",
    personArticle: "a",
    people: "volunteers",
    staff: "board member",
    staffArticle: "a",
    header: "volunteer",
  });
  assert.equal(L.wordsAreDefault(defaults), true);
  for (const t of SAMPLES) {
    assert.equal(L.wordText(t, defaults), t);
    assert.equal(L.wordText(t, null), t);
    assert.equal(page.wordText(t, defaults), t);
    assert.equal(page.wordText(t), t);
  }
  // Typed words that equal the defaults are the defaults.
  assert.equal(
    L.wordsAreDefault(L.sheetWords(settings("a volunteer", "volunteers", "board member"))),
    true,
  );
});

test("other words: the noun, its capital, its article, the verb made neutral, names kept", () => {
  const w = (t) => L.wordText(t, USHER);
  assert.equal(w(SAMPLES[0]), "This kiosk needs to be set up. Please ask a staff member.");
  assert.equal(w(SAMPLES[1]), "An usher taps the link, finds their name, and taps Send.");
  assert.equal(w(SAMPLES[2]), "Ushers who asked on the tablet arrive ticked.");
  assert.equal(w(SAMPLES[3]), "The usher's first and last name, from Volunteer Profiles.");
  assert.equal(w(SAMPLES[4]), "Thank you.");
  assert.equal(w(SAMPLES[5]), "Thank you.");
  assert.equal(w(SAMPLES[6]), "Not yet");
  assert.equal(w(SAMPLES[7]), "Please try again or ask a staff member for help.");
  assert.equal(w(SAMPLES[8]), "Staff member: kiosk access code");
  assert.equal(
    w(SAMPLES[9]),
    "The header of the usher list's first name column; blank means Volunteer First Name.",
  );
  // Header names take the Header word.
  assert.equal(w(SAMPLES[10]), "Rename Usher Name and Usher Role/Type on the Log.");
  assert.equal(w(SAMPLES[11]), 'The Log has no "usher name" column.');
  assert.equal(w(SAMPLES[12]), SAMPLES[12]);
  // A typed article is used; the plural takes none.
  const h = (t) => L.wordText(t, HELPER);
  assert.equal(h("A volunteer and a board member."), "An hourly helper and a coordinator.");
  assert.equal(h("Two volunteers."), "Two hourly helpers.");
  // With no article typed: a, e, i or o take an, any other letter a.
  const article = (word) => plain(L.parseWordSetting(word, "x")).article;
  assert.deepEqual(["usher", "employee", "intern", "officer", "member", "user"].map(article), [
    "a",
    "an",
    "an",
    "an",
    "a",
    "a",
  ]);
});

test("the page's rewrite gives what the server's gives", () => {
  const pageWords = (w) => ({
    person: w.person,
    personArticle: w.personArticle,
    people: w.people,
    staff: w.staff,
    staffArticle: w.staffArticle,
  });
  for (const words of [USHER, HELPER]) {
    for (const t of SAMPLES.filter((s) => !/Name|Role\/Type|name"/.test(s))) {
      assert.equal(page.wordText(t, pageWords(words)), L.wordText(t, words), t);
    }
  }
});

test("the admin window: every line it words is one the server words, and none under the defaults", () => {
  const html = read("apps-script/AdminDialog.html");
  const used = [...html.matchAll(/\bw\(\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g)].map((m) =>
    JSON.parse(m[1]),
  );
  used.push("volunteer", "volunteers");
  const lines = plain(L.adminDialogLines());
  assert.deepEqual([...new Set(used)].sort(), [...lines].sort());
  assert.deepEqual(plain(L.adminDialogWords(L.defaultWords())), {
    person: "Volunteer",
    people: "Volunteers",
    findShiftHint: "(paste it, or find the shift by volunteer and date)",
    texts: {},
  });
  const usher = plain(L.adminDialogWords(USHER));
  assert.equal(usher.person, "Usher");
  assert.equal(usher.texts["Please choose a volunteer."], "Please choose an usher.");
  // Each scriptlet the window prints is set by the opener.
  const opener = read("apps-script/Admin.js");
  for (const [, name] of html.matchAll(/<\?= (\w+) \?>/g)) {
    assert.match(opener, new RegExp("page\\." + name + " = "), name);
  }
});

test("a refusal and the sender name follow the Settings this run read", () => {
  const S = logic();
  assert.equal(
    S.refusal("NOT_FOUND").message,
    "We couldn't find your profile. Please see a board member.",
  );
  assert.equal(S.flagsEmailSenderName(), S.brandSenderName());
  S.useSettings({
    ...settings("usher", "ushers", "staff member"),
    "Organization name": "Riverside Pantry",
  });
  assert.equal(
    S.refusal("NOT_FOUND").message,
    "We couldn't find your profile. Please see a staff member.",
  );
  assert.equal(S.flagsEmailSenderName(), "Riverside Pantry Check-In Kiosk");
  assert.match(
    S.hoursEmailMessage({
      firstName: "Ana",
      plan: {
        period: { month: "2026-10", choice: "last", asOf: "2026-10-31" },
        all: { shifts: 0 },
        monthShifts: [],
      },
    }).body,
    /Thank you\.$/,
  );
});

test("the person-word headers: either word is one header, and both are two", () => {
  const S = logic();
  const log = (word) => Object.values(plain(S.logHeaderNames(word)));
  assert.deepEqual(log(), Object.values(plain(S.logHeaderNames("volunteer"))));
  assert.equal(S.logHeaderNames("an usher").name, "Usher\nName");
  assert.equal(S.flagHeaderNames("usher").name, "Usher Name");
  const worded = log("usher");
  // Before the sheet's Header word is read, only today's names match.
  assert.throws(() => S.logColumns(worded), /no "volunteer name" column/);
  S.useSettings({ "Header word": "usher" });
  const cols = plain(S.logColumns(worded));
  assert.equal(cols["Volunteer\nName"], 2);
  assert.deepEqual(plain(S.logColumns(log())), plain(S.logColumns(worded)));
  assert.throws(
    () => S.logColumns([...worded, "Volunteer Name"]),
    /more than one "usher name" column/,
  );
  assert.equal(
    plain(S.flagColumns(Object.values(plain(S.flagHeaderNames("usher")))))["Volunteer Name"],
    1,
  );
  // A row moves between a tab under one word and a tab under the other with every cell.
  const row = worded.map((h, i) => "cell " + i);
  assert.deepEqual(plain(S.headerMapCopy(worded, row, log(), worded.length)), row);
  assert.deepEqual(plain(S.headerMapCopy(log(), row, worded, worded.length)), row);
  // Removed shifts holding the other word's names gets no second copy of them.
  const removed = [...log(), ...Object.values(plain(S.removedExtraHeaders()))];
  assert.deepEqual(plain(S.removedHeaderWrites(worded, removed)), []);
  // Notes: in the Header word, and today's still counted as the kiosk's own.
  const notes = plain(S.logHeaderNotes("usher"));
  assert.match(notes.name, /^The usher's first and last name/);
  const kiosk = plain(S.headerNoteKioskTexts("usher"));
  assert.ok(kiosk.includes(notes.name));
  assert.ok(kiosk.includes(plain(S.logHeaderNotes()).name));
  assert.equal(
    S.headerNotesRow(worded, S.logHeaderNames("usher"), notes, [], kiosk)[2],
    notes.name,
  );
});

test("which headers setupSheets rewrites, and when the Header word is written", () => {
  assert.equal(L.headerWordToWrite({}), null);
  assert.equal(L.headerWordToWrite(settings("volunteer", "", "", "")), null);
  assert.equal(L.headerWordToWrite(settings("an usher", "", "", "")), "usher");
  assert.equal(L.headerWordToWrite(settings("usher", "", "", "Usher")), null);
  assert.equal(L.headerWordToWrite(settings("", "", "", "usher")), "volunteer");
  const today = Object.values(plain(L.logHeaderNames()));
  assert.deepEqual(
    plain(L.headerWordWrites(today, L.logHeaderNames, ["name", "role"], "volunteer", "usher")),
    [
      { col: 3, header: "Usher\nName" },
      { col: 4, header: "Usher\nRole/Type" },
    ],
  );
  const usher = Object.values(plain(L.logHeaderNames("usher")));
  assert.deepEqual(
    plain(L.headerWordWrites(usher, L.logHeaderNames, ["name", "role"], "usher", "usher")),
    [],
  );
  assert.deepEqual(
    plain(L.headerWordWrites(usher, L.logHeaderNames, ["name", "role"], "usher", "helper")).map(
      (w) => w.header,
    ),
    ["Helper\nName", "Helper\nRole/Type"],
  );
});

test("Settings column C and How to: in the sheet's words, but for the word rows' own sentences", () => {
  const names = ["Kiosk access code", "Word for a person", "Word for staff", "Header word"];
  const d = plain(L.settingsDescriptions());
  assert.deepEqual(
    plain(L.settingsDescriptionColumn(names)),
    names.map((n) => d[n]),
  );
  const worded = plain(L.settingsDescriptionColumn(names, USHER));
  assert.match(worded[0], /^The code a staff member types/);
  assert.deepEqual(
    worded.slice(1),
    names.slice(1).map((n) => d[n]),
  );
  const rows = plain(L.howToRows(USHER));
  assert.equal(rows[0].text, "How to: the usher kiosk sheet");
  const all = rows.map((r) => r.text).join("\n");
  assert.ok(all.includes("Usher Name: The usher's first and last name"));
  assert.doesNotMatch(
    all.replace(/Volunteer (Profiles|First Name|Last Name|Phone|hour value)/g, ""),
    /\bvolunteer/i,
  );
  assert.deepEqual(plain(L.howToRows()), plain(L.howToRows(L.defaultWords())));
});

test("the list reply carries the page's Settings, and the page reads them or the brand's", () => {
  assert.deepEqual(plain(L.pageSettings({})), {
    words: {
      person: "volunteer",
      personArticle: "a",
      people: "volunteers",
      staff: "board member",
      staffArticle: "a",
    },
    organizationName: "",
    logoLink: "",
    switches: {
      milestones: true,
      emailHours: true,
      importPastHours: true,
      arrivalChanges: true,
      checkOutChanges: true,
    },
    timeZone: "America/Chicago",
  });
  const sent = plain(
    L.pageSettings({
      ...settings("usher", "ushers", "staff member"),
      "Organization name": " Riverside ",
      "Logo link": "http://example.org/logo.png",
    }),
  );
  assert.equal(sent.organizationName, "Riverside");
  assert.equal(sent.logoLink, "");
  const read = page.pageSettingsOf(sent);
  assert.deepEqual(read, sent);
  assert.equal(page.pageSettingsOf({}), null);
  assert.equal(page.pageSettingsOf({ words: { person: "" } }), null);
  assert.equal(page.organizationNameOf(page.brandPageSettings), BRAND_ORGANIZATION_NAME);
  assert.equal(page.logoUrlOf(page.brandPageSettings), BRAND_LOGO_URL);
  assert.equal(page.organizationNameOf(read), "Riverside");
  const https = page.pageSettingsOf({ ...sent, logoLink: "https://example.org/logo.png" });
  assert.equal(page.logoUrlOf(https), "https://example.org/logo.png");
  assert.equal(L.pageTitle({}), "Volunteer Check-In");
  assert.equal(L.pageTitle(settings("an usher", "", "")), "Usher Check-In");
});

test("the page reads the switches: only Off is Off, and a reply or kept list without them is all On", () => {
  const ALL_ON = {
    milestones: true,
    emailHours: true,
    importPastHours: true,
    arrivalChanges: true,
    checkOutChanges: true,
  };
  const sent = plain(L.pageSettings({ "Tablet arrival changes": "Off", Milestones: "oN" }));
  assert.deepEqual(sent.switches, { ...ALL_ON, arrivalChanges: false });
  const read = page.pageSettingsOf(sent);
  assert.deepEqual(page.pageSwitchesOf(read), { ...ALL_ON, arrivalChanges: false });
  assert.equal(page.isPageSettings(read), true);
  // A server before the switches: all On.
  const { switches, ...older } = sent;
  assert.deepEqual(page.pageSwitchesOf(page.pageSettingsOf(older)), ALL_ON);
  assert.equal(page.isPageSettings(older), true);
  assert.deepEqual(page.pageSwitchesOf(older), ALL_ON);
  assert.deepEqual(page.pageSwitchesOf(page.brandPageSettings), ALL_ON);
  // Anything but false reads On; a kept list with a bad switch isn't page Settings.
  const odd = page.pageSettingsOf({ ...sent, switches: { checkOutChanges: "Off", milestones: 0 } });
  assert.deepEqual(page.pageSwitchesOf(odd), ALL_ON);
  assert.equal(page.isPageSettings({ ...sent, switches: { arrivalChanges: false } }), false);
});

test("a kept list: main's shape reads with no page Settings, and a new one keeps them", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const now = Date.parse("2026-11-18T15:00:00Z");
  storeList(storage, "code", now, [], 8, noListExtras);
  const [key] = store.keys();
  assert.equal("pageSettings" in JSON.parse(store.get(key)), false);
  assert.equal("pageSettings" in readStoredList(storage, "code", now), false);
  const ps = page.pageSettingsOf(
    plain(L.pageSettings(settings("usher", "ushers", "staff member"))),
  );
  storeList(storage, "code", now, [], 8, { ...noListExtras, pageSettings: ps });
  assert.deepEqual(readStoredList(storage, "code", now).pageSettings, ps);
  // A bad one reads as none, and the list is still kept.
  const entry = JSON.parse(store.get(key));
  store.set(key, JSON.stringify({ ...entry, pageSettings: { words: 1 } }));
  const back = readStoredList(storage, "code", now);
  assert.ok(back);
  assert.equal("pageSettings" in back, false);
});

test("doGet: the title takes the person word, and the brand's when Settings can't be read", () => {
  const run = (rows) => {
    const ctx = {
      console: { log: () => {}, error: () => {} },
      CacheService: {
        getScriptCache: () => ({ getAll: () => ({}), put: () => {}, remove: () => {} }),
      },
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ({
          getSheetByName: (name) =>
            rows && name === "Settings"
              ? { getDataRange: () => ({ getValues: () => rows }) }
              : null,
        }),
      },
      HtmlService: {
        XFrameOptionsMode: { DEFAULT: "DEFAULT" },
        createHtmlOutputFromFile: () => {
          const out = {
            setTitle: (t) => ((out.title = t), out),
            addMetaTag: () => out,
            setXFrameOptionsMode: () => out,
          };
          return out;
        },
      },
    };
    vm.createContext(ctx);
    for (const f of ["Brand.js", "Logic.js", "Sheets.js", "Api.js"])
      vm.runInContext(read("apps-script/" + f), ctx);
    return ctx.doGet().title;
  };
  assert.equal(run(null), "Volunteer Check-In");
  assert.equal(run([["Setting", "Value"]]), "Volunteer Check-In");
  assert.equal(
    run([
      ["Setting", "Value"],
      ["Word for a person", "an usher"],
    ]),
    "Usher Check-In",
  );
});
