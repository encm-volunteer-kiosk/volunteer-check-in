// Tests for setupSheets (apps-script/Sheets.js) and the pure header helpers it uses in
// apps-script/Logic.js. Logic.js and Sheets.js are loaded into one context the way Apps
// Script loads them, with a small in-memory stand-in for SpreadsheetApp, so the real
// setupSheets runs against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

// The Log header, line breaks included. Columns A to N are ENCM's "2026-11 Log" tab of
// their Volunteer Kiosk Log spreadsheet, as read live on 2026-11-12; O to R are the
// kiosk's own.
const ENCM_LOG_HEADERS = [
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
const LOG_HEADERS = [...ENCM_LOG_HEADERS, ...KIOSK_LOG_HEADERS];
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
const OWNER = "owner@example.org";

// ---------------------------------------------------------------------------
// In-memory spreadsheet

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(this.sheet.get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    assert.equal(values.length, this.rows, "setValues row count");
    values.forEach((line, r) => {
      assert.equal(line.length, this.cols, "setValues column count");
      line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v));
    });
    return this;
  }
  setValue(value) {
    this.sheet.set(this.row, this.col, value);
    return this;
  }
  setNumberFormat(format) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.sheet.formats.set(this.row + r + "," + (this.col + c), format);
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(name, maxRows = 1000, maxCols = 26) {
    this.name = name;
    this.values = new Map();
    this.formats = new Map();
    this.maxRows = maxRows;
    this.maxCols = maxCols;
    this.frozen = 0;
  }
  get(r, c) {
    return this.values.has(r + "," + c) ? this.values.get(r + "," + c) : "";
  }
  set(r, c, v) {
    assert.ok(r <= this.maxRows && c <= this.maxCols, "write outside the sheet at " + r + "," + c);
    if (v === "") this.values.delete(r + "," + c);
    else this.values.set(r + "," + c, v);
  }
  format(r, c) {
    return this.formats.get(r + "," + c);
  }
  getName() {
    return this.name;
  }
  setName(name) {
    this.name = name;
    return this;
  }
  getLastRow() {
    let last = 0;
    for (const key of this.values.keys()) last = Math.max(last, Number(key.split(",")[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const key of this.values.keys()) last = Math.max(last, Number(key.split(",")[1]));
    return last;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  insertColumnsAfter(after, count) {
    assert.equal(after, this.maxCols, "columns are only added at the end");
    this.maxCols += count;
  }
  getRange(row, col, rows = 1, cols = 1) {
    if (typeof row === "string") {
      // Only whole-column A1 ranges such as "A:B" are used, for formats.
      const [a, b] = row.split(":").map((s) => s.charCodeAt(0) - 64);
      return new FakeRange(this, 1, a, this.maxRows, b - a + 1);
    }
    assert.ok(rows >= 1 && cols >= 1, "a range needs at least one row and column");
    return new FakeRange(this, row, col, rows, cols);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  setFrozenRows(n) {
    this.frozen = n;
  }
  row(r) {
    return this.getRange(r, 1, 1, Math.max(this.getLastColumn(), 1)).getValues()[0];
  }
  snapshot() {
    return {
      name: this.name,
      values: [...this.values.entries()].sort(),
      formats: [...this.formats.entries()].sort(),
      maxCols: this.maxCols,
      frozen: this.frozen,
    };
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.timeZone = "America/Chicago";
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    assert.equal(this.getSheetByName(name), null, "a tab named " + name + " already exists");
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  getSpreadsheetTimeZone() {
    return this.timeZone;
  }
  setSpreadsheetTimeZone(tz) {
    this.timeZone = tz;
  }
  tabNames() {
    return this.sheets.map((s) => s.name);
  }
  snapshot() {
    return { timeZone: this.timeZone, sheets: this.sheets.map((s) => s.snapshot()) };
  }
}

/** A fresh context with Logic.js and Sheets.js loaded and SpreadsheetApp pointing at ss. */
function server(ss) {
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Session: {
      getActiveUser: () => ({ getEmail: () => OWNER }),
      getEffectiveUser: () => ({ getEmail: () => OWNER }),
    },
    Utilities: {
      formatDate: (date, tz, format) => {
        assert.equal(format, "yyyy-MM-dd");
        return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read("apps-script/Logic.js"), ctx);
  vm.runInContext(read("apps-script/Sheets.js"), ctx);
  return ctx;
}

function sheetWith(ss, name, rows, maxCols = 26) {
  const sheet = new FakeSheet(name, 1000, maxCols);
  rows.forEach((line, r) => line.forEach((v, c) => sheet.set(r + 1, c + 1, v)));
  ss.sheets.push(sheet);
  return sheet;
}

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

test("ENCM's fourteen headers get the kiosk's four after them", () => {
  assert.deepEqual(plain(L.logHeaderWrites(ENCM_LOG_HEADERS)), [
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

test("on a new spreadsheet the Log header is exactly logHeaders() and ENCM's live tab", () => {
  const ss = new FakeSpreadsheet();
  ss.timeZone = "America/New_York";
  const S = server(ss);
  S.setupSheets();
  assert.equal(ss.timeZone, "America/Chicago");
  const log = ss.getSheetByName("Log");
  assert.deepEqual(log.row(1), plain(S.logHeaders()));
  assert.deepEqual(log.row(1).slice(0, 14), ENCM_LOG_HEADERS);
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
  assert.deepEqual(settings.row(1), ["Setting", "Value"]);
  const rows = settings.getDataRange().getValues().slice(1);
  assert.equal(rows.length, 15);
  const names = rows.map((r) => r[0]);
  assert.equal(names.indexOf("Check-out flag minutes"), names.indexOf("Arrival flag minutes") + 1);
  assert.deepEqual(
    rows.find((r) => r[0] === "Check-out flag minutes"),
    ["Check-out flag minutes", "15"],
  );
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
  assert.deepEqual(ss.tabNames(), ["Log (old layout)", "Settings", "Log"]);
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

test("ENCM's sketch header with a staff column after it gets the kiosk's four, nothing overwritten", () => {
  const ss = new FakeSpreadsheet();
  const header = [...ENCM_LOG_HEADERS, "Checked by"];
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
  const rows = settings.getDataRange().getValues().slice(1);
  assert.deepEqual(rows[0], ["Kiosk access code", "lettersonlylettersonly"]);
  assert.deepEqual(rows[1], ["Arrival flag minutes", "20"]);
  assert.equal(rows.length, 15);
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
