// Tests for setupSheets (apps-script/Sheets.js) and the pure header and look helpers it
// uses in apps-script/Logic.js. Logic.js and Sheets.js are loaded into one context the way
// Apps Script loads them, with the in-memory stand-in for SpreadsheetApp and the advanced
// Sheets service in fakeSpreadsheet.mjs, so the real setupSheets runs against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { cachedLogMap } from "./log-cache-tap.mjs";
import { FakeSheet, FakeSpreadsheet, OWNER, server, sheetWith } from "./fakeSpreadsheet.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

// The Log header, line breaks included. Columns A to N are the staff's own layout, from
// the Log tab the kiosk was first fitted to, as read live on 2026-11-12; O to R are the
// kiosk's own.
const BASE_LOG_HEADERS = [
  "Date",
  "Day",
  "Volunteer\nName",
  "Volunteer\nRole/Type",
  "Check-In\nRecorded\n(timestamp)",
  "Check-In\nStated\n(user)",
  "Check-Out\nRecorded\n(timestamp)",
  "Check-Out\nStated (user)",
  "Hours Served\n(timestamps)",
  "Hours Served\n(stated)",
  "Admin\nAlerts?",
  "Activity",
  "Notes",
  "User Token",
];
const KIOSK_LOG_HEADERS = ["Status", "Check-In\nEntered By", "Check-Out\nEntered By", "Shift ID"];
const LOG_HEADERS = [...BASE_LOG_HEADERS, ...KIOSK_LOG_HEADERS];
const OLD_LOG_HEADERS = [
  "Shift ID",
  "Volunteer ID",
  "First name",
  "Last name",
  "Date",
  "Tapped in at",
  "Arrived at",
  "Signed out at",
  "Hours",
  "Status",
  "Flag",
  "Staff note",
];
const TIME_FORMAT = "yyyy-mm-dd h:mm am/pm";

function expectKioskFormats(sheet, header) {
  header.forEach((h, i) => {
    const at = LOG_HEADERS.indexOf(h);
    if (at < 0) return;
    let want = "@";
    if (at >= 4 && at <= 7) want = TIME_FORMAT;
    if (at === 8 || at === 9) want = "0.00";
    assert.equal(sheet.format(2, i + 1), want, "format of " + JSON.stringify(h));
    assert.equal(sheet.format(1000, i + 1), want, "format of " + JSON.stringify(h) + " to the end");
  });
}

// ---------------------------------------------------------------------------
// Pure helpers in Logic.js

const L = server(new FakeSpreadsheet());

test("an empty header row gets logHeaders() from column A", () => {
  const full = LOG_HEADERS.map((header, i) => ({ col: i + 1, header }));
  assert.deepEqual(plain(L.logHeaderWrites([])), full);
  assert.deepEqual(plain(L.logHeaderWrites(["", " ", ""])), full);
  assert.deepEqual(
    plain(L.logHeaderWrites([])).map((w) => w.header),
    plain(L.logHeaders()),
  );
});

test("a full header row gets nothing, in any order", () => {
  assert.deepEqual(plain(L.logHeaderWrites(LOG_HEADERS)), []);
  assert.deepEqual(plain(L.logHeaderWrites([...LOG_HEADERS].reverse())), []);
  assert.deepEqual(plain(L.logHeaderWrites(LOG_HEADERS.map((h) => h.replace(/\n/g, " ")))), []);
});

test("the base fourteen headers get the kiosk's four after them", () => {
  assert.deepEqual(plain(L.logHeaderWrites(BASE_LOG_HEADERS)), [
    { col: 15, header: "Status" },
    { col: 16, header: "Check-In\nEntered By" },
    { col: 17, header: "Check-Out\nEntered By" },
    { col: 18, header: "Shift ID" },
  ]);
});

test("missing headers go after the last header, not into a gap", () => {
  const header = ["Date", "", "Day", "Staff column", ""];
  const writes = plain(L.logHeaderWrites(header));
  assert.equal(writes[0].col, 5);
  assert.deepEqual(
    writes.map((w) => w.col),
    writes.map((_, i) => 5 + i),
  );
  assert.ok(!writes.some((w) => w.header === "Date" || w.header === "Day"));
});

test("Notes is added when missing; Role/Type and Activity are not", () => {
  const header = LOG_HEADERS.filter(
    (h) => !["Volunteer\nRole/Type", "Activity", "Notes"].includes(h),
  );
  assert.deepEqual(plain(L.logHeaderWrites(header)), [{ col: header.length + 1, header: "Notes" }]);
  const withNotes = [...header, "notes"];
  assert.deepEqual(plain(L.logHeaderWrites(withNotes)), []);
});

test("logColumnFormats formats kiosk columns only, in column order", () => {
  const header = ["Staff", "Date", "Check-In\nStated\n(user)", "Hours Served\n(stated)", "Notes"];
  assert.deepEqual(plain(L.logColumnFormats(header)), [
    { col: 2, kind: "text" },
    { col: 3, kind: "time" },
    { col: 4, kind: "hours" },
    { col: 5, kind: "text" },
  ]);
  assert.equal(L.logColumnFormats(LOG_HEADERS).length, 18);
});

// ---------------------------------------------------------------------------
// setupSheets on the in-memory spreadsheet

test("on a new spreadsheet the Log header is exactly logHeaders() and the base layout", () => {
  const ss = new FakeSpreadsheet();
  ss.timeZone = "America/New_York";
  const S = server(ss);
  S.setupSheets();
  assert.equal(ss.timeZone, "America/Chicago");
  const log = ss.getSheetByName("Log");
  assert.deepEqual(log.row(1), plain(S.logHeaders()));
  assert.deepEqual(log.row(1).slice(0, 14), BASE_LOG_HEADERS);
  assert.deepEqual(log.row(1), LOG_HEADERS);
  assert.equal(log.frozen, 1);
  assert.equal(log.getLastRow(), 1);
  expectKioskFormats(log, LOG_HEADERS);
  // The kiosk reads the header it wrote.
  assert.deepEqual(
    Object.values(plain(S.logColumns(log.row(1)))),
    LOG_HEADERS.map((_, i) => i),
  );
});

test("on a new spreadsheet Settings gets every default, the check-out flag at 15", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const settings = ss.getSheetByName("Settings");
  assert.deepEqual(settings.row(1), ["Setting", "Value", "What it does"]);
  const rows = settings.getDataRange().getValues().slice(1);
  // One row per default: 24, worked out from settingsDefaults, then the general settings.
  assert.equal(rows.length, S.settingsDefaults("2026-11-13").length);
  assert.equal(rows.length, 24 + S.generalSettingsDefaults().length);
  const names = rows.map((r) => r[0]);
  assert.equal(names.indexOf("Check-out flag minutes"), names.indexOf("Arrival flag minutes") + 1);
  assert.deepEqual(rows.find((r) => r[0] === "Check-out flag minutes").slice(0, 2), [
    "Check-out flag minutes",
    "15",
  ]);
});

test("setupSheets stamps the Settings cache after its Settings rows reach the sheet", () => {
  const ss = new FakeSpreadsheet();
  const cache = new Map();
  const atFlush = [];
  const errors = [];
  const S = server(ss, {
    cache,
    errors,
    onFlush: () =>
      atFlush.push({
        stamped: cache.has(S.settingsStampKey()),
        rows: ss.getSheetByName("Settings").getDataRange().getValues().length,
      }),
  });
  // A copy of Settings cached a second before the run.
  const before = Date.now() - 1000;
  cache.set(S.settingsCacheKey(), S.settingsCacheValue({ "Kiosk access code": "x" }, before));
  S.setupSheets();
  // The header and one row per default: 25, then the general settings.
  assert.deepEqual(atFlush, [
    { stamped: false, rows: S.settingsDefaults("2026-11-13").length + 1 },
  ]);
  assert.equal(atFlush[0].rows, 25 + S.generalSettingsDefaults().length);
  const stamp = cache.get(S.settingsStampKey());
  assert.match(stamp, /^\d+$/);
  assert.ok(Number(stamp) >= before + 1000);
  assert.equal(S.settingsFromCache(cache.get(S.settingsCacheKey()), stamp, Date.now()), null);
  assert.deepEqual(errors, []);
});

test("setupSheets writes the Log changed stamp, so the next tap reads the whole Log", () => {
  const ss = new FakeSpreadsheet();
  const props = new Map();
  const S = server(ss, { props });
  // First run: a new Log. Second run: nothing changes in the Log's cells, and it still stamps.
  for (const run of ["first", "second"]) {
    props.clear();
    // A map of the whole Log read 10 seconds before the run.
    const readAt = Date.now() - 10000;
    S.setupSheets();
    const stamp = props.get(S.logStampProperty());
    assert.ok(Number(stamp) >= readAt + S.logCacheMarginMs(), run);
    const values = ss.getSheetByName("Log").getDataRange().getValues();
    const nextTap = cachedLogMap(S, values, readAt);
    // The map matches the Log as the run left it, so without the stamp it would be used.
    assert.equal(nextTap(null, Date.now() + 1000), "hit", run);
    assert.equal(nextTap(stamp, Date.now() + 1000), "miss (edited)", run);
  }
});

test("setupSheets writes the Log changed stamp after its Log part even when a Log write throws", () => {
  const ss = new FakeSpreadsheet();
  const log = sheetWith(ss, "Log", [LOG_HEADERS]);
  const events = [];
  const props = new (class extends Map {
    set(k, v) {
      if (k === S.logStampProperty()) events.push("stamp");
      return super.set(k, v);
    }
  })();
  const S = server(ss, { props });
  let thrownAt = 0;
  log.setFrozenRows = () => {
    events.push("write failed");
    thrownAt = Date.now();
    throw new Error("setFrozenRows failed");
  };
  assert.throws(() => S.setupSheets(), /setFrozenRows failed/);
  assert.deepEqual(events, ["stamp", "write failed", "stamp"]);
  assert.ok(Number(props.get(S.logStampProperty())) >= thrownAt);
});

test("running setupSheets twice changes nothing", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const first = JSON.stringify(ss.snapshot());
  S.setupSheets();
  assert.equal(JSON.stringify(ss.snapshot()), first);
});

test("an old-layout Log is renamed and a new Log started; old rows are left as they are", () => {
  const ss = new FakeSpreadsheet();
  const oldRow = ["s1", "abcd", "Ana", "Ruiz", "2026-11-10", "x", "x", "x", 2, "closed", "", ""];
  const old = sheetWith(ss, "Log", [OLD_LOG_HEADERS, oldRow]);
  sheetWith(ss, "Settings", [["Setting", "Value"]]);
  const before = JSON.stringify(old.values ? [...old.values.entries()].sort() : null);
  const S = server(ss);
  S.setupSheets();
  // With no Profiles file named, the volunteer list tab is made in this spreadsheet.
  assert.deepEqual(ss.tabNames(), [
    "How to",
    "Log (old layout)",
    "Settings",
    "Log",
    "Flags",
    "Volunteer Profiles",
  ]);
  assert.equal(ss.getSheetByName("Log (old layout)"), old);
  assert.equal(JSON.stringify([...old.values.entries()].sort()), before);
  const log = ss.getSheetByName("Log");
  assert.deepEqual(log.row(1), LOG_HEADERS);
  assert.equal(log.getLastRow(), 1);

  const after = JSON.stringify(ss.snapshot());
  S.setupSheets();
  assert.equal(JSON.stringify(ss.snapshot()), after, "a second run renames nothing more");
});

test("an old-layout Log beside an existing old-layout tab stops and names it", () => {
  const ss = new FakeSpreadsheet();
  const log = sheetWith(ss, "Log", [OLD_LOG_HEADERS]);
  sheetWith(ss, "Log (old layout)", [OLD_LOG_HEADERS]);
  const S = server(ss);
  assert.throws(() => S.setupSheets(), /"Log \(old layout\)" tab already exists/);
  assert.equal(log.name, "Log");
  assert.deepEqual(ss.tabNames(), ["Log", "Log (old layout)"]);
});

test("the base header with a staff column after it gets the kiosk's four, nothing overwritten", () => {
  const ss = new FakeSpreadsheet();
  const header = [...BASE_LOG_HEADERS, "Checked by"];
  const row = [
    "2026-11-03",
    "Tuesday",
    "Ana Ruiz",
    "Pantry",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "tok",
    "AR",
  ];
  const log = sheetWith(ss, "Log", [header, row], 15);
  const S = server(ss);
  S.setupSheets();
  assert.equal(log.getMaxColumns(), 19);
  assert.deepEqual(log.row(1), [...header, ...KIOSK_LOG_HEADERS]);
  assert.deepEqual(log.row(2).slice(0, 15), row);
  assert.equal(log.format(2, 15), undefined, "the staff column keeps its own format");
  expectKioskFormats(log, log.row(1));
  assert.doesNotThrow(() => S.logColumns(log.row(1)));
});

test("a Log with no Notes column gets one, and an admin note can then be written", () => {
  const ss = new FakeSpreadsheet();
  const header = LOG_HEADERS.filter((h) => h !== "Notes");
  const log = sheetWith(ss, "Log", [header]);
  const S = server(ss);
  const H = S.logHeaderNames();
  assert.throws(
    () => S.cellWrites({ [H.notes]: "late" }, S.logColumns(log.row(1))),
    /The Log has no "notes" column\. Run setupSheets\(\)\./,
  );
  S.setupSheets();
  assert.deepEqual(log.row(1), [...header, "Notes"]);
  assert.equal(log.format(2, 18), "@");
  const writes = plain(S.cellWrites({ [H.notes]: "late" }, S.logColumns(log.row(1))));
  assert.deepEqual(writes, [{ col: 18, value: "late", kind: "text" }]);
});

test("a Log missing a required header gets it after the last header", () => {
  const ss = new FakeSpreadsheet();
  const header = LOG_HEADERS.filter((h) => h !== "Day" && h !== "Shift ID");
  const log = sheetWith(ss, "Log", [header]);
  const S = server(ss);
  S.setupSheets();
  assert.deepEqual(log.row(1), [...header, "Day", "Shift ID"]);
  assert.doesNotThrow(() => S.logColumns(log.row(1)));
});

test("existing Settings values are kept and missing rows appended", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Log", [LOG_HEADERS]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Kiosk access code", "lettersonlylettersonly"],
    ["Arrival flag minutes", "20"],
  ]);
  const S = server(ss);
  S.setupSheets();
  const rows = settings
    .getDataRange()
    .getValues()
    .slice(1)
    .map((r) => r.slice(0, 2));
  assert.deepEqual(rows[0], ["Kiosk access code", "lettersonlylettersonly"]);
  assert.deepEqual(rows[1], ["Arrival flag minutes", "20"]);
  assert.equal(rows.length, S.settingsDefaults("2026-11-13").length);
  assert.equal(rows.length, 24 + S.generalSettingsDefaults().length);
  assert.deepEqual(
    rows.find((r) => r[0] === "Check-out flag minutes"),
    ["Check-out flag minutes", "15"],
  );
});

test("setupSheets refuses a caller that isn't the script owner", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.Session.getActiveUser = () => ({ getEmail: () => "" });
  assert.throws(() => S.setupSheets(), /Run this from the Apps Script editor/);
  assert.deepEqual(ss.tabNames(), []);
});

// ---------------------------------------------------------------------------
// The Flags tab

const FLAG_HEADERS = [
  "Date",
  "Volunteer Name",
  "Shift ID",
  "Reason",
  "Raised At",
  "Reviewed",
  "Reviewed By",
  "Notes",
  "Source",
  "Log Row",
];
const CHECKBOX = JSON.stringify({ checkbox: true });

test("setupSheets makes the Flags tab: header, formats, checkbox, frozen row and view", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  // With no Profiles file named, the volunteer list tab is made in this spreadsheet.
  assert.deepEqual(ss.tabNames(), ["How to", "Log", "Settings", "Flags", "Volunteer Profiles"]);
  const flags = ss.getSheetByName("Flags");
  assert.deepEqual(flags.row(1), FLAG_HEADERS);
  assert.equal(flags.getLastRow(), 1);
  assert.equal(flags.frozen, 1);
  // The checkbox covers Reviewed (F) from row 2 to the tab's last row, and nothing else.
  assert.deepEqual([...flags.validations.entries()], [["2,6,999,1", CHECKBOX]]);
  const want = ["@", "@", "@", "@", TIME_FORMAT, undefined, "@", "@", "@", "0"];
  want.forEach((format, i) => {
    assert.equal(flags.format(2, i + 1), format, "format of " + FLAG_HEADERS[i]);
    assert.equal(flags.format(1000, i + 1), format, "format of " + FLAG_HEADERS[i] + " to the end");
  });
  assert.deepEqual(plain(ss.views.get(flags.sheetId)), [
    {
      title: "Flags: Unreviewed",
      range: { sheetId: flags.sheetId },
      filterSpecs: [
        {
          columnIndex: 5,
          filterCriteria: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [{ userEnteredValue: '=AND(TRIM($C2) <> "", $F2 <> TRUE)' }],
            },
          },
        },
      ],
      sortSpecs: [{ dimensionIndex: 4, sortOrder: "DESCENDING" }],
      filterViewId: 1,
    },
  ]);
  // No view goes on the Log.
  assert.equal(ss.views.get(ss.getSheetByName("Log").sheetId), undefined);

  const first = JSON.stringify(ss.snapshot());
  S.setupSheets();
  assert.equal(JSON.stringify(ss.snapshot()), first, "a second run changes nothing");
  assert.equal(ss.views.get(flags.sheetId).length, 1);
});

test("the Flags view is updated in place by title; other views are left alone", () => {
  const ss = new FakeSpreadsheet();
  const flags = sheetWith(ss, "Flags", [FLAG_HEADERS]);
  const staff = { title: "Mine", range: { sheetId: flags.sheetId }, filterViewId: 50 };
  const kiosk = { title: "Kiosk: Flagged", range: { sheetId: flags.sheetId }, filterViewId: 51 };
  const stale = { title: "Flags: Unreviewed", range: { sheetId: flags.sheetId }, filterViewId: 52 };
  ss.views.set(flags.sheetId, [staff, kiosk, stale]);
  server(ss).setupSheets();
  const views = ss.views.get(flags.sheetId);
  assert.deepEqual(views.slice(0, 2), [staff, kiosk]);
  assert.equal(views.length, 3);
  assert.equal(views[2].filterViewId, 52);
  assert.equal(views[2].sortSpecs[0].dimensionIndex, 4);
});

test("a Flags tab with a staff column and no Reviewed By gets nothing overwritten", () => {
  const ss = new FakeSpreadsheet();
  const header = [
    "Date",
    "Volunteer Name",
    "Shift ID",
    "Checked with",
    "Reason",
    "Raised At",
    "Reviewed",
    "Notes",
    "Source",
    "Log Row",
  ];
  const row = ["2026-11-12", "Sam Lee", "s-1", "Andrea", "arrival differs by 24 min"];
  const flags = sheetWith(ss, "Flags", [header, row]);
  const S = server(ss);
  S.setupSheets();
  assert.deepEqual(flags.row(1), header, "Reviewed By isn't required, so it isn't added");
  assert.deepEqual(flags.row(2).slice(0, 5), row);
  assert.equal(flags.format(2, 4), undefined, "the staff column keeps its own format");
  assert.deepEqual([...flags.validations.keys()], ["2,7,999,1"]);
  assert.doesNotThrow(() => S.flagColumns(flags.row(1)));
});

test("a Flags tab missing Source and Log Row gets them after the last header", () => {
  const ss = new FakeSpreadsheet();
  const flags = sheetWith(ss, "Flags", [FLAG_HEADERS.slice(0, 8)], 8);
  server(ss).setupSheets();
  assert.deepEqual(flags.row(1), FLAG_HEADERS);
  assert.equal(flags.getMaxColumns(), 10);
  assert.equal(flags.format(2, 10), "0");
});

test("a validation staff set on another Flags column survives setupSheets", () => {
  const ss = new FakeSpreadsheet();
  const flags = sheetWith(ss, "Flags", [FLAG_HEADERS]);
  flags.getRange(2, 7, 999, 1).setDataValidation({ list: "initials" });
  server(ss).setupSheets();
  assert.deepEqual([...flags.validations.entries()].sort(), [
    ["2,6,999,1", CHECKBOX],
    ["2,7,999,1", JSON.stringify({ list: "initials" })],
  ]);
});

test("without the advanced Sheets service, setupSheets names the view step and the rest is done", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss, { noSheetsService: true });
  assert.throws(
    () => S.setupSheets(),
    /^Error: The Flags tab is set up, but the "Flags: Unreviewed" view could not be made: .+\. Check that the Sheets API advanced service is on \(it is in appsscript\.json\), then run setupSheets\(\) again\.$/,
  );
  const flags = ss.getSheetByName("Flags");
  assert.deepEqual(flags.row(1), FLAG_HEADERS);
  assert.equal(flags.frozen, 1);
  assert.deepEqual([...flags.validations.entries()], [["2,6,999,1", CHECKBOX]]);
  assert.deepEqual(ss.getSheetByName("Log").row(1), LOG_HEADERS);
  const settingsRows = ss.getSheetByName("Settings").getDataRange().getValues().length;
  assert.equal(settingsRows, S.settingsDefaults("2026-11-13").length + 1);
  assert.equal(settingsRows, 25 + S.generalSettingsDefaults().length);
  assert.equal(ss.views.size, 0);
});

// ---------------------------------------------------------------------------
// The look of the Log, Flags and Settings

const NAVY = "#062f5a";
const TEAL = "#168c86";
const rgb = (hex) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});
const MARK = 'N("kiosk look")';
// The Log's header colours (N navy, T teal) and widths, in LOG_HEADERS order.
const LOG_LOOK = [
  ["N", 95],
  ["N", 90],
  ["N", 170],
  ["T", 130],
  ["N", 150],
  ["N", 150],
  ["N", 150],
  ["N", 150],
  ["N", 95],
  ["N", 95],
  ["N", 220],
  ["T", 130],
  ["T", 260],
  ["N", 120],
  ["N", 75],
  ["N", 95],
  ["N", 95],
  ["N", 120],
];
const FLAG_LOOK = [
  ["N", 95],
  ["N", 170],
  ["N", 120],
  ["N", 260],
  ["N", 150],
  ["T", 80],
  ["T", 95],
  ["T", 260],
  ["N", 90],
  ["N", 75],
];
const colour = (c) => (c === "N" ? NAVY : TEAL);
const formulaOf = (rule) => rule.booleanRule.condition.values[0].userEnteredValue;

test("the palette is the kiosk page's colours, and the tints are light", () => {
  const css = read("src/brand.css");
  const page = (name) => new RegExp("--" + name + ":\\s*(#[0-9a-f]{6});").exec(css)[1];
  const P = plain(L.lookPalette());
  assert.equal(P.navy, page("navy"));
  assert.equal(P.teal, page("teal"));
  assert.equal(P.yellow, page("yellow"));
  assert.equal(P.grey, page("muted"));
  assert.equal(P.blue, page("blue"));
  assert.equal(P.section, page("light-blue"));
  const light = (hex) => Object.values(rgb(hex)).every((v) => v > 0.8);
  for (const tint of ["band", "open", "alert"]) assert.ok(light(P[tint]), tint);
  assert.deepEqual(plain(L.lookTabColours()), {
    log: P.navy,
    flags: P.yellow,
    settings: P.grey,
    hours: P.teal,
    hoursData: P.grey,
    report: P.blue,
    howTo: P.blue,
  });
});

test("lookPlan for the Log: header colours and widths by header, a staff header teal with no width", () => {
  const header = [...LOG_HEADERS.slice(0, 14), "Checked by", ...LOG_HEADERS.slice(14)];
  const plan = plain(L.lookPlan(header, "log"));
  const want = [...LOG_LOOK.slice(0, 14), ["T", null], ...LOG_LOOK.slice(14)];
  assert.equal(plan.width, 19);
  assert.deepEqual(
    plan.headerColours,
    want.map(([c]) => colour(c)),
  );
  assert.deepEqual(
    plan.widths,
    want.flatMap(([, px], col) => (px ? [{ col, px }] : [])),
  );
  assert.equal(plan.headerHeight, 40);
  assert.deepEqual(plan.wrapColumns, []);
  assert.deepEqual(plan.banding, { startRow: 1, endCol: 19, first: "#ffffff", second: "#eef7fc" });
  assert.equal(plan.tabColour, NAVY);
  // Admin Alerts? is K; Status moved one right to P. The alert cell's rule comes first.
  assert.deepEqual(plan.rules, [
    {
      ranges: [{ startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
      booleanRule: {
        condition: {
          type: "CUSTOM_FORMULA",
          values: [{ userEnteredValue: "=AND(" + MARK + ' = 0, TRIM($K2) <> "")' }],
        },
        format: { backgroundColorStyle: { rgbColor: rgb("#fbe3e2") } },
      },
    },
    {
      ranges: [{ startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 19 }],
      booleanRule: {
        condition: {
          type: "CUSTOM_FORMULA",
          values: [{ userEnteredValue: "=AND(" + MARK + ' = 0, LOWER(TRIM($P2)) = "open")' }],
        },
        format: { backgroundColorStyle: { rgbColor: rgb("#fff4d6") } },
      },
    },
  ]);
});

test("lookPlan follows a reordered Log header; blank cells between headers are teal", () => {
  const header = [...LOG_HEADERS].reverse();
  header.splice(3, 0, "");
  const plan = plain(L.lookPlan([...header, "", ""], "log"));
  assert.equal(plan.width, 19, "trailing blanks are not the header's");
  assert.equal(plan.headerColours[3], TEAL);
  assert.ok(!plan.widths.some((w) => w.col === 3));
  const alerts = header.indexOf("Admin\nAlerts?");
  const status = header.indexOf("Status");
  const letter = (i) => String.fromCharCode(65 + i);
  assert.equal(
    formulaOf(plan.rules[0]),
    "=AND(" + MARK + " = 0, TRIM($" + letter(alerts) + '2) <> "")',
  );
  assert.deepEqual(plan.rules[0].ranges[0], {
    startRowIndex: 1,
    startColumnIndex: alerts,
    endColumnIndex: alerts + 1,
  });
  assert.match(formulaOf(plan.rules[1]), new RegExp("\\$" + letter(status) + '2\\)\\) = "open"'));
  // Every known header still gets its own colour and width wherever it is.
  LOG_HEADERS.forEach((h, i) => {
    const at = header.indexOf(h);
    assert.equal(plan.headerColours[at], colour(LOG_LOOK[i][0]), h);
    assert.ok(
      plan.widths.some((w) => w.col === at && w.px === LOG_LOOK[i][1]),
      h,
    );
  });
});

test("lookPlan for Flags and Settings", () => {
  const flags = plain(L.lookPlan(FLAG_HEADERS, "flags"));
  assert.deepEqual(
    flags.headerColours,
    FLAG_LOOK.map(([c]) => colour(c)),
  );
  assert.deepEqual(
    flags.widths,
    FLAG_LOOK.map(([, px], col) => ({ col, px })),
  );
  assert.equal(flags.tabColour, "#f9bd2f");
  assert.deepEqual(flags.rules, [
    {
      ranges: [{ startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 }],
      booleanRule: {
        condition: {
          type: "CUSTOM_FORMULA",
          values: [{ userEnteredValue: "=AND(" + MARK + " = 0, $F2 = TRUE)" }],
        },
        format: { textFormat: { foregroundColorStyle: { rgbColor: rgb("#8a9aa8") } } },
      },
    },
  ]);

  const settings = plain(L.lookPlan(["Setting", "Value"], "settings"));
  assert.deepEqual(settings.headerColours, [NAVY, TEAL]);
  assert.deepEqual(settings.widths, [
    { col: 0, px: 230 },
    { col: 1, px: 380 },
  ]);
  assert.deepEqual(settings.wrapColumns, [1]);
  assert.deepEqual(settings.rules, []);
  assert.equal(settings.tabColour, "#52687b");
  assert.equal(settings.banding.endCol, 2);

  // The What it does column is navy (the kiosk writes it), wide and wrapped.
  const described = plain(L.lookPlan(["Setting", "Value", "What it does"], "settings"));
  assert.deepEqual(described.headerColours, [NAVY, TEAL, NAVY]);
  assert.deepEqual(described.widths, [
    { col: 0, px: 230 },
    { col: 1, px: 380 },
    { col: 2, px: 420 },
  ]);
  assert.deepEqual(described.wrapColumns, [1, 2]);
  assert.equal(described.banding.endCol, 3);
  assert.throws(() => L.lookPlan(["A"], "Hours"), /No look for a tab called Hours/);
});

test("isLookRule finds the marker; lookRuleRequests keeps staff's rules, first and in order", () => {
  const rule = (formula) => ({
    ranges: [{ sheetId: 7, startRowIndex: 1 }],
    booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] } },
  });
  const staffA = rule('=$A2 = "x"');
  const kitX = rule("=AND(" + MARK + " = 0, $B2)");
  const staffB = { ranges: [{ sheetId: 7 }], gradientRule: {} };
  const kitY = rule('=AND(N("kiosk look")=0,$C2)');
  assert.deepEqual(
    [staffA, kitX, staffB, kitY].map((r) => L.isLookRule(r)),
    [false, true, false, true],
  );
  const fresh = [
    { ranges: [{ startRowIndex: 1 }], booleanRule: { condition: {} } },
    { ranges: [{ startRowIndex: 2 }], booleanRule: { condition: {} } },
  ];
  assert.deepEqual(plain(L.lookRuleRequests(7, [staffA, kitX, staffB, kitY], fresh)), [
    { deleteConditionalFormatRule: { sheetId: 7, index: 3 } },
    { deleteConditionalFormatRule: { sheetId: 7, index: 1 } },
    {
      addConditionalFormatRule: {
        index: 2,
        rule: { ranges: [{ sheetId: 7, startRowIndex: 1 }], booleanRule: { condition: {} } },
      },
    },
    {
      addConditionalFormatRule: {
        index: 3,
        rule: { ranges: [{ sheetId: 7, startRowIndex: 2 }], booleanRule: { condition: {} } },
      },
    },
  ]);
  assert.deepEqual(plain(L.lookRuleRequests(7, [], [])), []);
});

test("setupSheets puts the look on the Log, Flags and Settings", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const tabs = [
    ["Log", LOG_LOOK, NAVY, 2],
    ["Flags", FLAG_LOOK, "#f9bd2f", 1],
    [
      "Settings",
      [
        ["N", 230],
        ["T", 380],
        ["N", 420],
      ],
      "#52687b",
      0,
    ],
  ];
  for (const [name, look, tab, ruleCount] of tabs) {
    const sheet = ss.getSheetByName(name);
    const id = sheet.sheetId;
    assert.deepEqual(sheet.tabColor, { rgbColor: rgb(tab) }, name);
    assert.equal(sheet.dims.get("ROWS 0-1"), 40, name);
    look.forEach(([c, px], col) => {
      assert.equal(sheet.dims.get("COLUMNS " + col + "-" + (col + 1)), px, name + " width " + col);
      const styled = [...sheet.cellLook.entries()].find(([key]) => {
        const where = JSON.parse(key.split(" ")[0]);
        return (
          where.endRowIndex === 1 && where.startColumnIndex <= col && col < where.endColumnIndex
        );
      });
      assert.ok(styled, name + " header " + col);
      const format = styled[1].userEnteredFormat;
      assert.deepEqual(format.backgroundColorStyle, { rgbColor: rgb(colour(c)) });
      assert.deepEqual(format.textFormat, {
        foregroundColorStyle: { rgbColor: rgb("#ffffff") },
        bold: true,
      });
      assert.equal(format.wrapStrategy, "WRAP");
      assert.equal(format.verticalAlignment, "MIDDLE");
    });
    // One banding from row 2 over the header's columns, with no end row.
    assert.deepEqual(
      plain(ss.bandings.get(id)).map(({ bandedRangeId, ...b }) => b),
      [
        {
          range: {
            sheetId: id,
            startRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: look.length,
          },
          rowProperties: {
            firstBandColorStyle: { rgbColor: rgb("#ffffff") },
            secondBandColorStyle: { rgbColor: rgb("#eef7fc") },
          },
        },
      ],
    );
    const rules = ss.rules.get(id) || [];
    assert.equal(rules.length, ruleCount, name);
    assert.ok(rules.every((r) => S.isLookRule(r) && r.ranges[0].endRowIndex === undefined));
    // The header keeps its text and plain-text format.
    assert.equal(sheet.format(1, 1), "@");
  }
  const settings = ss.getSheetByName("Settings");
  assert.deepEqual(
    settings.cellLook.get(
      '{"startColumnIndex":1,"endColumnIndex":2} userEnteredFormat.wrapStrategy',
    ),
    { userEnteredFormat: { wrapStrategy: "WRAP" } },
  );
  assert.deepEqual(
    settings.cellLook.get(
      '{"startColumnIndex":2,"endColumnIndex":3} userEnteredFormat.wrapStrategy',
    ),
    { userEnteredFormat: { wrapStrategy: "WRAP" } },
  );
});

test("setupSheets replaces staff's banding and its own rules, and keeps staff's rules first", () => {
  const ss = new FakeSpreadsheet();
  const log = sheetWith(ss, "Log", [[...LOG_HEADERS, "Checked by"]]);
  const id = log.sheetId;
  ss.bandings.set(id, [
    { bandedRangeId: 900, range: { sheetId: id, startRowIndex: 0, endRowIndex: 50 } },
  ]);
  const staffRule = {
    ranges: [{ sheetId: id, startColumnIndex: 18, endColumnIndex: 19 }],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=$S1 = "x"' }] },
      format: { textFormat: { bold: true } },
    },
  };
  ss.rules.set(id, [plain(staffRule)]);
  const S = server(ss);
  S.setupSheets();
  assert.equal(ss.bandings.get(id).length, 1);
  assert.equal(ss.bandings.get(id)[0].range.endColumnIndex, 19);
  assert.deepEqual(
    ss.rules.get(id).map((r) => S.isLookRule(r)),
    [false, true, true],
  );
  // The staff column's header is teal and its width is left alone.
  assert.equal(log.dims.has("COLUMNS 18-19"), false);
  assert.ok(
    [...log.cellLook.entries()].some(
      ([key, cell]) =>
        key.startsWith('{"startRowIndex":0,"endRowIndex":1,"startColumnIndex":18,') &&
        cell.userEnteredFormat.backgroundColorStyle.rgbColor.green === rgb(TEAL).green,
    ),
  );

  // A staff rule added after the kiosk's moves ahead of them on the next run.
  const later = { ...plain(staffRule), booleanRule: { ...staffRule.booleanRule, format: {} } };
  ss.rules.get(id).push(later);
  S.setupSheets();
  assert.deepEqual(plain(ss.rules.get(id)).slice(0, 2), [plain(staffRule), later]);
  assert.equal(ss.rules.get(id).filter((r) => S.isLookRule(r)).length, 2);
  const after = JSON.stringify(ss.snapshot());
  S.setupSheets();
  assert.equal(JSON.stringify(ss.snapshot()), after, "a further run changes nothing");
});

test("when the look is refused, setupSheets says the tabs are set up and what to check", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss, { failOn: "addBanding" });
  assert.throws(
    () => S.setupSheets(),
    /^Error: The tabs are set up, but their look could not be applied: Invalid requests\[0\]\.addBanding\. Check that the Sheets API advanced service is on \(it is in appsscript\.json\), then run setupSheets\(\) again\.$/,
  );
  assert.deepEqual(ss.getSheetByName("Log").row(1), LOG_HEADERS);
  assert.deepEqual(ss.getSheetByName("Flags").row(1), FLAG_HEADERS);
  assert.equal(ss.views.get(ss.getSheetByName("Flags").sheetId).length, 1);
});

// ---------------------------------------------------------------------------
// Staff help: Settings' What it does column, header notes and the How to tab

const settingsAB = (sheet) =>
  [...sheet.values.entries()].filter(([key]) => Number(key.split(",")[1]) <= 2).sort();
const columnC = (sheet) =>
  sheet
    .getRange(1, 3, Math.max(sheet.getLastRow(), 1), 1)
    .getValues()
    .map((r) => r[0]);

test("setupSheets writes Settings' What it does column and leaves A:B cell for cell", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Log", [LOG_HEADERS]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Kiosk access code", "lettersonlylettersonly"],
    ["Closing time", "17:00"],
    ["", "a value with no name"],
    ["Arrival flag minutes", "20"],
    ["Arrival flag minutes", "30"],
    ["Flags email ", "On"],
    ["flags email", "on"],
  ]);
  const S = server(ss);
  const original = settingsAB(settings);
  S.setupSheets();
  // The first run leaves every A:B cell that was there as it was; it may only append rows.
  original.forEach(([key, v]) => assert.equal(settings.values.get(key), v, key));
  const before = settingsAB(settings);
  S.setupSheets();
  assert.deepEqual(settingsAB(settings), before, "a second run changes nothing in A:B");

  const fresh = new FakeSpreadsheet();
  sheetWith(fresh, "Log", [LOG_HEADERS]);
  const untouched = sheetWith(fresh, "Settings", [
    ["Setting", "Value"],
    ["Kiosk access code", "lettersonlylettersonly"],
  ]);
  const ab = settingsAB(untouched);
  const F = server(fresh);
  F.setupSheets();
  // A:B gains only the appended default rows; the rows that were there are unchanged.
  ab.forEach(([key, v]) => assert.equal(untouched.values.get(key), v, key));

  const d = S.settingsDescriptions();
  const c = columnC(settings);
  assert.equal(c[0], "What it does");
  assert.equal(c[1], d["Kiosk access code"]);
  assert.equal(c[2], "The kiosk doesn't use this row.");
  assert.equal(c[3], "");
  assert.equal(c[4], d["Arrival flag minutes"]);
  assert.equal(c[5], "Not used: an earlier row has the same name, and only the first one counts.");
  // Each matches what readSettings_ reads: names are trimmed, and case counts.
  assert.equal(c[6], d["Flags email"]);
  assert.equal(c[7], "The kiosk doesn't use this row.");
  const read = S.readSettings_();
  assert.equal(read["Flags email"], "On");
  assert.equal(read["Arrival flag minutes"], "20");
  // Every row from 2 down has its description, the appended defaults included.
  settings
    .getDataRange()
    .getValues()
    .slice(1)
    .forEach((row, i) => {
      if (row[0] && !["Closing time", "flags email"].includes(row[0]) && i !== 4) {
        assert.equal(row[2], d[String(row[0]).trim()], "row " + (i + 2));
      }
    });
  assert.equal(settings.format(1, 3), "@");
  assert.equal(settings.format(500, 3), "@");
});

test("Settings column C: a staff edit is replaced, a deleted row's text cleared, one protection", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const settings = ss.getSheetByName("Settings");
  const last = settings.getLastRow();
  settings.set(3, 3, "my own words");
  // Delete the last setting's name and value; its old text stays in C until the next run.
  const lastName = settings.get(last, 1);
  settings.set(last, 1, "");
  settings.set(last, 2, "");
  S.setupSheets();
  assert.equal(settings.get(3, 3), S.settingsDescriptionColumn([settings.get(3, 1)])[0]);
  // setupSheets put the deleted row back below, and its old place is blank in A to C.
  assert.equal(settings.get(last, 3), "");
  assert.equal(settings.get(last + 1, 1), lastName);
  assert.equal(settings.get(last + 1, 3), S.settingsDescriptions()[lastName]);

  // Leftover text under the last named row is cleared.
  settings.set(last + 5, 3, "stale");
  S.setupSheets();
  assert.equal(settings.get(last + 5, 3), "");
  assert.equal(settings.getLastRow(), last + 1);

  const protections = settings.getProtections("RANGE");
  assert.equal(protections.length, 1);
  assert.equal(protections[0].where, "2,3,999,1", "C2 to the end of column C");
  assert.equal(protections[0].getDescription(), S.settingsDescriptionProtection());
  assert.equal(protections[0].isWarningOnly(), true);
});

test("setSetting_ appending a missing row writes its What it does; an update writes only B", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const settings = ss.getSheetByName("Settings");
  const rows = settings.getDataRange().getValues();
  const at = rows.findIndex((r) => r[0] === "Flags email last run") + 1;
  settings.set(at, 1, "");
  settings.set(at, 2, "");
  settings.set(at, 3, "");
  S.setSetting_("Flags email last run", "2026-11-13 08:00, nothing to send");
  const row = settings.getLastRow();
  assert.deepEqual(settings.row(row), [
    "Flags email last run",
    "2026-11-13 08:00, nothing to send",
    S.settingsDescriptions()["Flags email last run"],
  ]);
  settings.set(row, 3, "kept");
  S.setSetting_("Flags email last run", "later");
  assert.equal(settings.get(row, 3), "kept");
  S.setSetting_("Something new", "x");
  assert.deepEqual(settings.row(settings.getLastRow()), ["Something new", "x", ""]);
});

const notesRow = (sheet) => sheet.getRange(1, 1, 1, sheet.getLastColumn()).getNotes()[0];

test("on a new spreadsheet every Log and Flags header gets exactly its kiosk note", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const logNotes = S.logHeaderNotes();
  const flagNotes = S.flagHeaderNotes();
  assert.deepEqual(notesRow(ss.getSheetByName("Log")), Object.values(plain(logNotes)));
  assert.deepEqual(notesRow(ss.getSheetByName("Flags")), Object.values(plain(flagNotes)));
  assert.equal(ss.getSheetByName("Settings").notes.size, 0);

  // A second run writes no note at all.
  ss.sheets.forEach((s) => (s.noteWrites = []));
  S.setupSheets();
  ss.sheets.forEach((s) => assert.deepEqual(s.noteWrites, [], s.name));
});

test("header notes: staff notes are never written, a deleted note comes back, a moved column keeps its note", () => {
  const ss = new FakeSpreadsheet();
  const log = sheetWith(ss, "Log", [LOG_HEADERS]);
  const staffNote = "Andrea: check this one\nevery Friday.";
  log.notes.set("1,1", staffNote);
  const S = server(ss);
  S.setupSheets();
  S.setupSheets();
  assert.equal(log.note(1, 1), staffNote, "a staff note from before the first run stays");
  const notes = plain(S.logHeaderNotes());

  // Staff change one kiosk note by a character, give others notes Sheets might reshape,
  // and delete one.
  const changed = notes.day.replace("weekday", "Weekday");
  const shaped = {
    3: notes.name + " ",
    4: notes.role + "\n",
    5: "Two lines\n\nwith a blank between",
    6: "two  spaces and a\ttab",
  };
  log.notes.set("1,2", changed);
  Object.entries(shaped).forEach(([col, n]) => log.notes.set("1," + col, n));
  log.notes.delete("1,7");
  log.noteWrites = [];
  S.setupSheets();
  assert.deepEqual(log.noteWrites, [[1, 7, notes.recordedOut]], "only the deleted note is written");
  assert.equal(log.note(1, 1), staffNote);
  assert.equal(log.note(1, 2), changed);
  Object.entries(shaped).forEach(([col, n]) => assert.equal(log.note(1, Number(col)), n, col));

  // Moving a column carries its value and note together (as Sheets does): nothing to write.
  const move = (from, to) => {
    const v = log.get(1, from);
    const n = log.note(1, from);
    log.set(1, from, log.get(1, to));
    log.notes.set("1," + from, log.note(1, to));
    log.set(1, to, v);
    log.notes.set("1," + to, n);
  };
  move(8, 18);
  log.noteWrites = [];
  S.setupSheets();
  assert.deepEqual(log.noteWrites, []);
  assert.equal(log.get(1, 18), LOG_HEADERS[7]);
  assert.equal(log.note(1, 18), notes.statedOut);
});

test("header notes: a renamed kiosk header loses its unchanged note, and the restored header gets one", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const log = ss.getSheetByName("Log");
  const notes = plain(S.logHeaderNotes());
  const status = LOG_HEADERS.indexOf("Status") + 1;
  const shiftId = LOG_HEADERS.indexOf("Shift ID") + 1;
  log.set(1, status, "State");
  log.set(1, shiftId, "Row key");
  log.notes.set("1," + shiftId, notes.shiftId + " Ours now.");
  S.setupSheets();
  const header = log.row(1);
  assert.deepEqual(header.slice(-2), ["Status", "Shift ID"]);
  assert.equal(log.note(1, status), "", "the renamed cell's kiosk note is cleared");
  assert.equal(log.note(1, shiftId), notes.shiftId + " Ours now.", "a changed note stays");
  assert.equal(log.note(1, header.length - 1), notes.status);
  assert.equal(log.note(1, header.length), notes.shiftId);
});

const howTo = (ss) => ss.sheets.find((s) => ss.metadata.some((m) => m.sheet === s));
const columnA = (sheet) =>
  sheet
    .getRange(1, 1, sheet.getLastRow(), 1)
    .getValues()
    .map((r) => r[0]);
const howToText = (S) => plain(S.howToRows()).map((r) => r.text);
// getValues gives "" for a blank row, so the text ends at the last row with text.
const trimTail = (list) => {
  const out = [...list];
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
};

test("How to, first run: the first tab, marked, warning-only, plain text, styled", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const sheet = ss.sheets[0];
  assert.equal(sheet.name, "How to");
  assert.deepEqual(plain(ss.metadata.map((m) => [m.key, m.value, m.sheet.name])), [
    ["kiosk-guide", "how-to", "How to"],
  ]);
  const protections = sheet.getProtections("SHEET");
  assert.equal(protections.length, 1);
  assert.equal(protections[0].getDescription(), S.howToProtectionDescription());
  assert.equal(protections[0].isWarningOnly(), true);
  assert.deepEqual(columnA(sheet), trimTail(howToText(S)));
  assert.equal(sheet.format(1, 1), "@");
  assert.equal(sheet.format(1000, 1), "@");
  assert.equal(sheet.frozen, 1);
  assert.equal(sheet.colWidths.get(1), 820);
  assert.equal(sheet.tabColorHex, S.lookTabColours().howTo);
  const rows = plain(S.howToRows());
  const styles = plain(S.howToStyles());
  rows.forEach((r, i) => {
    assert.equal(sheet.styles.get("weight " + (i + 1) + ",1"), styles[r.kind].weight);
    assert.equal(sheet.styles.get("background " + (i + 1) + ",1"), styles[r.kind].background);
    assert.equal(sheet.styles.get("style " + (i + 1) + ",1"), styles[r.kind].style);
  });
});

test("How to: the contact cell holds the live formula in General format; every other row is plain text", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  const sheet = howTo(ss);
  const rows = plain(S.howToRows());
  const at = rows.findIndex((r) => r.kind === "contact") + 1;
  assert.equal(at, 6, "under the first heading");
  assert.equal(sheet.get(at, 1), "");
  assert.equal(sheet.getRange(at, 1).getFormula(), S.kioskContactFormula());
  assert.equal(sheet.format(at, 1), "General");
  rows.forEach((r, i) => {
    if (i + 1 === at) return;
    assert.equal(sheet.getRange(i + 1, 1).getFormula(), "", "row " + (i + 1));
    assert.equal(sheet.format(i + 1, 1), "@", "row " + (i + 1));
  });
  assert.deepEqual(columnA(sheet), trimTail(howToText(S)));
  assert.deepEqual([...sheet.formulas.keys()], [at + ",1"]);
  // A second run gives the same tab: one formula, the same cell.
  const once = JSON.stringify(sheet.snapshot());
  S.setupSheets();
  assert.equal(JSON.stringify(sheet.snapshot()), once);
});

test("Kiosk contact: a staff value survives every run; a tab without the row gets it once, last, blank", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Log", [LOG_HEADERS]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Kiosk access code", "lettersonlylettersonly"],
    ["Kiosk contact", "Pat Example\n555-0100"],
  ]);
  const S = server(ss);
  S.setupSheets();
  S.setupSheets();
  assert.deepEqual(settings.row(3).slice(0, 2), ["Kiosk contact", "Pat Example\n555-0100"]);
  assert.equal(settings.get(3, 3), S.settingsDescriptions()["Kiosk contact"]);
  const names = settings
    .getDataRange()
    .getValues()
    .map((r) => r[0]);
  assert.equal(names.filter((n) => n === "Kiosk contact").length, 1);
  assert.equal(S.kioskContact_(), "Pat Example\n555-0100");

  // A Settings tab from before the row: it is appended once, at the bottom, with B blank.
  const old = new FakeSpreadsheet();
  sheetWith(old, "Log", [LOG_HEADERS]);
  const rows = [["Setting", "Value"]].concat(
    plain(S.settingsDefaults("2026-11-13"))
      .filter((r) => r[0] !== "Kiosk contact")
      // Header word stays blank: setupSheets writes it while the Log holds no rows.
      .map((r) => [r[0], r[1] || (r[0] === "Header word" ? "" : "kept")]),
  );
  const tab = sheetWith(old, "Settings", rows);
  const O = server(old);
  O.setupSheets();
  O.setupSheets();
  const last = tab.getLastRow();
  assert.equal(last, rows.length + 1);
  assert.deepEqual(tab.row(last), ["Kiosk contact", "", S.settingsDescriptions()["Kiosk contact"]]);
  rows.forEach((r, i) => assert.deepEqual(tab.row(i + 1).slice(0, 2), r, "row " + (i + 1)));
  assert.equal(O.kioskContact_(), "");
});

test("the hours email rows: staff values survive every run; a tab without them gets both, last, blank", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Log", [LOG_HEADERS]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Hours email contact", "Pat Example\npat@example.org"],
    ["Hours email signature", "Pat Example\nVolunteer desk"],
  ]);
  const S = server(ss);
  S.setupSheets();
  S.setupSheets();
  assert.deepEqual(settings.row(2).slice(0, 2), [
    "Hours email contact",
    "Pat Example\npat@example.org",
  ]);
  assert.deepEqual(settings.row(3).slice(0, 2), [
    "Hours email signature",
    "Pat Example\nVolunteer desk",
  ]);
  assert.equal(settings.get(2, 3), S.settingsDescriptions()["Hours email contact"]);
  assert.equal(settings.get(3, 3), S.settingsDescriptions()["Hours email signature"]);
  const names = settings
    .getDataRange()
    .getValues()
    .map((r) => r[0]);
  assert.equal(names.length, S.settingsDefaults("2026-11-13").length + 1);
  assert.equal(names.filter((n) => n === "Hours email contact").length, 1);
  assert.equal(names.filter((n) => n === "Hours email signature").length, 1);

  // A Settings tab from before the two rows: they are appended once, at the bottom, B blank.
  const old = new FakeSpreadsheet();
  sheetWith(old, "Log", [LOG_HEADERS]);
  const rows = [["Setting", "Value"]].concat(
    plain(S.settingsDefaults("2026-11-13"))
      .filter((r) => !r[0].startsWith("Hours email"))
      // Header word stays blank: setupSheets writes it while the Log holds no rows.
      .map((r) => [r[0], r[1] || (r[0] === "Header word" ? "" : "kept")]),
  );
  const tab = sheetWith(old, "Settings", rows);
  const O = server(old);
  O.setupSheets();
  O.setupSheets();
  const last = tab.getLastRow();
  assert.equal(last, rows.length + 2);
  assert.deepEqual(tab.row(last - 1), [
    "Hours email contact",
    "",
    S.settingsDescriptions()["Hours email contact"],
  ]);
  assert.deepEqual(tab.row(last), [
    "Hours email signature",
    "",
    S.settingsDescriptions()["Hours email signature"],
  ]);
  rows.forEach((r, i) => assert.deepEqual(tab.row(i + 1).slice(0, 2), r, "row " + (i + 1)));
});

test("kioskContact_ is blank, logged, when Settings can't be read", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  const logs = [];
  S.console = { log: (...a) => logs.push(a.join(" ")) };
  assert.equal(S.kioskContact_(), "");
  assert.deepEqual(logs, [
    'Kiosk contact not read: The "Settings" tab is missing. Run setupSheets().',
  ]);
});

test("How to, staff changes: edits are rewritten, a moved and renamed tab stays put, a deleted tab comes back", () => {
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  ["Shifts", "Notes A", "Notes B"].forEach((n) => sheetWith(ss, n, [["x"]]));
  const sheet = howTo(ss);
  sheet.set(5, 1, "my edit");
  sheet.set(200, 1, "scratch below");
  S.setupSheets();
  assert.deepEqual(columnA(sheet), trimTail(howToText(S)));

  ss.moveSheet(sheet, 5);
  sheet.setName("Help");
  S.setupSheets();
  assert.equal(ss.sheets.indexOf(sheet), 5);
  assert.equal(sheet.name, "Help");
  assert.equal(ss.sheets.filter((s) => s.name === "How to").length, 0);
  assert.equal(sheet.getProtections("SHEET").length, 1);
  assert.deepEqual(columnA(sheet), trimTail(howToText(S)));

  ss.deleteSheet(sheet);
  S.setupSheets();
  assert.equal(ss.sheets[0].name, "How to");
  assert.equal(howTo(ss), ss.sheets[0]);
});

test("How to, stop cases: an unmarked tab of that name in any capitals, and two marked tabs", () => {
  for (const name of ["How to", "how to", "HOW TO"]) {
    const ss = new FakeSpreadsheet();
    sheetWith(ss, name, [["staff's own"]]);
    const S = server(ss);
    assert.throws(
      () => S.setupSheets(),
      new RegExp(
        '^Error: A tab named "' +
          name +
          "\" is already there and isn't the kiosk's\\. Rename it, then run setupSheets again\\.$",
      ),
    );
    // Everything before the last step is done.
    assert.deepEqual(ss.getSheetByName("Log").row(1), LOG_HEADERS);
    assert.deepEqual(ss.getSheetByName("Flags").row(1), FLAG_HEADERS);
    assert.equal(ss.getSheetByName("Settings").get(1, 3), "What it does");
    assert.equal(ss.getSheetByName("Log").note(1, 1), S.logHeaderNotes().date);
    assert.equal(ss.getSheetByName(name).get(1, 1), "staff's own");
    assert.equal(ss.metadata.length, 0);
  }

  // A marked tab renamed Help: a staff tab named How to is left alone.
  const ss = new FakeSpreadsheet();
  const S = server(ss);
  S.setupSheets();
  howTo(ss).setName("Help");
  const staff = sheetWith(ss, "How to", [["staff's own"]]);
  assert.doesNotThrow(() => S.setupSheets());
  assert.equal(staff.get(1, 1), "staff's own");
  assert.equal(staff.protections.length, 0);

  // A duplicated tab carries the mark too.
  const copy = sheetWith(ss, "Copy of Help", [["x"]]);
  copy.addDeveloperMetadata("kiosk-guide", "how-to");
  assert.throws(
    () => S.setupSheets(),
    /^Error: These tabs all carry the kiosk's How to mark: Help, Copy of Help\. Delete the copy, then run setupSheets again\.$/,
  );
});

// ---------------------------------------------------------------------------
// The header words

const settingValue = (tab, name) => {
  const row = tab
    .getDataRange()
    .getValues()
    .find((r) => r[0] === name);
  return row ? row[1] : undefined;
};

test("a sheet whose Log and Flags hold no rows takes the person word into its headers and Header word", () => {
  const ss = new FakeSpreadsheet();
  const log = sheetWith(ss, "Log", [LOG_HEADERS]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Word for a person", "an usher"],
  ]);
  const S = server(ss);
  S.setupSheets();
  assert.equal(log.get(1, 3), "Usher\nName");
  assert.equal(log.get(1, 4), "Usher\nRole/Type");
  assert.equal(ss.getSheetByName("Flags").get(1, 2), "Usher Name");
  assert.equal(settingValue(settings, "Header word"), "usher");
  assert.match(notesRow(log)[2], /^The usher's first and last name/);
  // The Log still reads, and a second run changes nothing.
  assert.equal(S.readLogColumns_()["Volunteer\nName"], 2);
  const before = JSON.stringify([log.row(1), notesRow(log), settings.getDataRange().getValues()]);
  S.setupSheets();
  assert.equal(
    JSON.stringify([log.row(1), notesRow(log), settings.getDataRange().getValues()]),
    before,
  );
});

test("with a shift on the Log, the headers and Header word stay as they are", () => {
  const ss = new FakeSpreadsheet();
  const shift = LOG_HEADERS.map(() => "");
  shift[0] = "2026-11-02";
  const log = sheetWith(ss, "Log", [LOG_HEADERS, shift]);
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Word for a person", "usher"],
  ]);
  server(ss).setupSheets();
  assert.deepEqual(log.row(1).slice(0, LOG_HEADERS.length), LOG_HEADERS);
  assert.equal(ss.getSheetByName("Flags").get(1, 2), "Volunteer Name");
  assert.equal(settingValue(settings, "Header word"), "");
});

// ---------------------------------------------------------------------------
// The volunteer list in this spreadsheet, and the launch date

const PEOPLE_HEADER = [
  "Volunteer First Name",
  "Volunteer Last Name",
  "Volunteer Phone",
  "Email",
  "Start Date mm/dd/yyyy",
  "User Token",
];

test("with Volunteer Profiles file ID blank, setupSheets makes the list tab with the kiosk's headers, once", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Volunteer Profiles tab", "People"],
  ]);
  const S = server(ss);
  S.setupSheets();
  const people = ss.getSheetByName("People");
  assert.deepEqual(people.row(1), PEOPLE_HEADER);
  assert.equal(people.getLastRow(), 1);
  assert.equal(people.frozen, 1);
  // The list reads it with every Roster column row blank.
  assert.deepEqual(plain(S.parseProfiles(people.row(1), [], () => "0".repeat(64))), {
    volunteers: [],
    problems: [],
  });
  // A tab already there, with people on it, is left as it is.
  people.getRange(2, 1, 1, 6).setValues([["Ana", "Diaz", "", "", "", "t-1"]]);
  people.getRange(1, 3).setValue("Mobile");
  S.setupSheets();
  assert.deepEqual(people.row(1), [
    "Volunteer First Name",
    "Volunteer Last Name",
    "Mobile",
    "Email",
    "Start Date mm/dd/yyyy",
    "User Token",
  ]);
  assert.equal(ss.sheets.filter((t) => t.name === "People").length, 1);
});

test("with a Profiles file named, setupSheets makes no list tab", () => {
  const ss = new FakeSpreadsheet();
  sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Volunteer Profiles file ID", "file-1"],
  ]);
  server(ss).setupSheets();
  assert.equal(ss.getSheetByName("Volunteer Profiles"), null);
});

test("setupSheets fills a blank Kiosk launch date with today, and keeps a date", () => {
  const ss = new FakeSpreadsheet();
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Kiosk launch date", ""],
  ]);
  const S = server(ss);
  S.setupSheets();
  const today = S.centralDate_(new Date());
  assert.equal(settingValue(settings, "Kiosk launch date"), today);
  assert.equal(
    settings
      .getDataRange()
      .getValues()
      .filter((r) => r[0] === "Kiosk launch date").length,
    1,
  );
  const kept = new FakeSpreadsheet();
  const keptSettings = sheetWith(kept, "Settings", [
    ["Setting", "Value"],
    ["Kiosk launch date", "2025-06-01"],
  ]);
  server(kept).setupSheets();
  assert.equal(settingValue(keptSettings, "Kiosk launch date"), "2025-06-01");
});

test("setupSampleProfiles fills this spreadsheet's header-only list tab, and refuses one with people or a mapped column", () => {
  const ss = new FakeSpreadsheet();
  const settings = sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Volunteer Profiles file ID", ""],
  ]);
  const S = server(ss);
  vm.runInContext(read("apps-script/SampleData.js"), S);
  const logs = [];
  S.Logger = { log: (m) => logs.push(m) };
  S.setupSheets();
  const people = ss.getSheetByName("Volunteer Profiles");
  const sample = plain(S.sampleProfileRows_());
  S.setupSampleProfiles();
  assert.equal(people.getLastRow(), sample.length);
  assert.deepEqual(people.row(1), sample[0]);
  // The list reads the sample with every Roster column row blank.
  const parsed = S.parseProfiles(people.row(1), sample.slice(1), (t) =>
    createHash("sha256").update(t, "utf8").digest("hex"),
  );
  assert.ok(parsed.volunteers.length > 0);
  // Run again: the tab has people now, so nothing changes.
  const before = JSON.stringify(people.getDataRange().getValues());
  S.setupSampleProfiles();
  assert.equal(JSON.stringify(people.getDataRange().getValues()), before);
  assert.equal(logs.at(-1), "The Volunteer Profiles tab has rows below its header; nothing done.");
  // A filled Roster column row: nothing done.
  const mapped = new FakeSpreadsheet();
  sheetWith(mapped, "Settings", [
    ["Setting", "Value"],
    ["Roster column: phone", "Mobile"],
  ]);
  const M = server(mapped);
  M.Logger = { log: (m) => logs.push(m) };
  M.setupSampleProfiles();
  assert.match(logs.at(-1), /Roster column row/);
  assert.equal(mapped.getSheetByName("Volunteer Profiles"), null);
  assert.equal(settingValue(settings, "Volunteer Profiles file ID"), "");
});
