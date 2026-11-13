// Tests for setupSheets (apps-script/Sheets.js) and the pure header and look helpers it
// uses in apps-script/Logic.js. Logic.js and Sheets.js are loaded into one context the way
// Apps Script loads them, with a small in-memory stand-in for SpreadsheetApp and the
// advanced Sheets service's filter views, bandings, conditional formats and formats, so
// the real setupSheets runs against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone } from "./zoneFormat.mjs";

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
  setDataValidation(rule) {
    this.sheet.validations.set(
      this.row + "," + this.col + "," + this.rows + "," + this.cols,
      JSON.stringify(rule),
    );
    return this;
  }
}

class FakeSheet {
  constructor(name, maxRows = 1000, maxCols = 26, sheetId = 0) {
    this.name = name;
    this.sheetId = sheetId;
    this.values = new Map();
    this.formats = new Map();
    // Data validations by "row,col,rows,cols" of the range they were set on.
    this.validations = new Map();
    this.maxRows = maxRows;
    this.maxCols = maxCols;
    this.frozen = 0;
    // What the advanced Sheets service's look requests set, by range and fields.
    this.cellLook = new Map();
    this.dims = new Map();
    this.tabColor = null;
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
  getSheetId() {
    return this.sheetId;
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
      validations: [...this.validations.entries()].sort(),
      maxCols: this.maxCols,
      frozen: this.frozen,
      cellLook: [...this.cellLook.entries()].sort(),
      dims: [...this.dims.entries()].sort(),
      tabColor: this.tabColor,
    };
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.timeZone = "America/Chicago";
    // Filter views, bandings and conditional format rules by sheetId, as the advanced
    // Sheets service holds them.
    this.views = new Map();
    this.bandings = new Map();
    this.rules = new Map();
    this.nextSheetId = 100;
    this.nextViewId = 1;
    this.nextBandingId = 1;
  }
  getId() {
    return "file-1";
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    assert.equal(this.getSheetByName(name), null, "a tab named " + name + " already exists");
    const sheet = new FakeSheet(name, 1000, 26, this.nextSheetId++);
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
    return {
      timeZone: this.timeZone,
      sheets: this.sheets.map((s) => s.snapshot()),
      views: [...this.views.entries()].sort(),
      // A banding's id changes when it is replaced; its range and colours are the look.
      bandings: [...this.bandings.entries()]
        .sort()
        .map(([id, list]) => [id, list.map(({ bandedRangeId, ...b }) => b)]),
      rules: [...this.rules.entries()].sort(),
    };
  }
}

/** True when two GridRanges share a cell; a missing end runs to the tab's edge. */
function overlaps(a, b) {
  const meet = (s1, e1, s2, e2) => (s1 || 0) < (e2 ?? Infinity) && (s2 || 0) < (e1 ?? Infinity);
  return (
    meet(a.startRowIndex, a.endRowIndex, b.startRowIndex, b.endRowIndex) &&
    meet(a.startColumnIndex, a.endColumnIndex, b.startColumnIndex, b.endColumnIndex)
  );
}

/**
 * The advanced Sheets service's calls setupSheets makes: filter views on ss.views,
 * bandings on ss.bandings, conditional format rules on ss.rules, and the formats the look
 * sets on each sheet. opts.failOn names a request type that throws, as the API does when
 * it refuses a request.
 */
function sheetsService(ss, opts = {}) {
  const byId = (sheetId) => {
    const sheet = ss.sheets.find((s) => s.sheetId === sheetId);
    assert.ok(sheet, "no sheet " + sheetId);
    return sheet;
  };
  return {
    Spreadsheets: {
      get: (id, params) => {
        assert.equal(id, "file-1");
        const fields = params.fields;
        return {
          sheets: ss.sheets.map((s) => {
            const out = { properties: { sheetId: s.sheetId } };
            const views = ss.views.get(s.sheetId);
            if (/filterViews\(filterViewId,title\)/.test(fields) && views && views.length) {
              out.filterViews = plain(views);
            }
            const bands = ss.bandings.get(s.sheetId);
            if (/bandedRanges\(bandedRangeId\)/.test(fields) && bands && bands.length) {
              out.bandedRanges = bands.map((b) => ({ bandedRangeId: b.bandedRangeId }));
            }
            const rules = ss.rules.get(s.sheetId);
            if (/conditionalFormats/.test(fields) && rules && rules.length) {
              out.conditionalFormats = plain(rules);
            }
            return out;
          }),
        };
      },
      batchUpdate: (body, id) => {
        assert.equal(id, "file-1");
        for (const r of body.requests) {
          const type = Object.keys(r)[0];
          if (type === opts.failOn) throw new Error("Invalid requests[0]." + type);
          if (r.deleteBanding) {
            const found = [...ss.bandings.values()].find((list) =>
              list.some((b) => b.bandedRangeId === r.deleteBanding.bandedRangeId),
            );
            assert.ok(found, "deleted banding exists");
            found.splice(
              found.findIndex((b) => b.bandedRangeId === r.deleteBanding.bandedRangeId),
              1,
            );
          } else if (r.addBanding) {
            const band = plain(r.addBanding.bandedRange);
            const list = ss.bandings.get(band.range.sheetId) || [];
            // Two bandings may not share a cell.
            assert.ok(!list.some((b) => overlaps(b.range, band.range)), "bandings overlap");
            list.push({ ...band, bandedRangeId: ss.nextBandingId++ });
            ss.bandings.set(band.range.sheetId, list);
          } else if (r.deleteConditionalFormatRule) {
            const { sheetId, index } = r.deleteConditionalFormatRule;
            const list = ss.rules.get(sheetId) || [];
            assert.ok(index >= 0 && index < list.length, "deleted rule exists");
            list.splice(index, 1);
          } else if (r.addConditionalFormatRule) {
            const { index, rule } = plain(r.addConditionalFormatRule);
            const sheetId = rule.ranges[0].sheetId;
            assert.ok(
              rule.ranges.every((g) => g.sheetId === sheetId),
              "one sheet per rule",
            );
            const list = ss.rules.get(sheetId) || [];
            assert.ok(index >= 0 && index <= list.length, "rule index in the list");
            list.splice(index, 0, rule);
            ss.rules.set(sheetId, list);
          } else if (r.repeatCell) {
            const { range, cell, fields } = plain(r.repeatCell);
            const { sheetId, ...where } = range;
            byId(sheetId).cellLook.set(JSON.stringify(where) + " " + fields, cell);
          } else if (r.updateDimensionProperties) {
            const { range, properties, fields } = plain(r.updateDimensionProperties);
            assert.equal(fields, "pixelSize");
            byId(range.sheetId).dims.set(
              range.dimension + " " + range.startIndex + "-" + range.endIndex,
              properties.pixelSize,
            );
          } else if (r.updateSheetProperties) {
            const { properties, fields } = plain(r.updateSheetProperties);
            assert.equal(fields, "tabColorStyle");
            byId(properties.sheetId).tabColor = properties.tabColorStyle;
          } else if (r.addFilterView) {
            const view = { ...plain(r.addFilterView.filter), filterViewId: ss.nextViewId++ };
            const list = ss.views.get(view.range.sheetId) || [];
            list.push(view);
            ss.views.set(view.range.sheetId, list);
          } else {
            assert.ok(r.updateFilterView, "a request the stand-in knows: " + type);
            const { filterViewId, ...view } = plain(r.updateFilterView.filter);
            assert.equal(r.updateFilterView.fields, "title,range,filterSpecs,sortSpecs");
            const list = ss.views.get(view.range.sheetId) || [];
            const i = list.findIndex((v) => v.filterViewId === filterViewId);
            assert.ok(i >= 0, "updated view exists");
            list[i] = { ...view, filterViewId };
          }
        }
      },
    },
  };
}

/**
 * A fresh context with Logic.js and Sheets.js loaded and SpreadsheetApp pointing at ss.
 * opts.noSheetsService leaves the advanced Sheets service out, as when it is off;
 * opts.failOn is passed to sheetsService.
 */
function server(ss, opts = {}) {
  const checkbox = () => {
    const rule = {};
    const b = {
      requireCheckbox: () => ((rule.checkbox = true), b),
      build: () => rule,
    };
    return b;
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newDataValidation: checkbox },
    Session: {
      getActiveUser: () => ({ getEmail: () => OWNER }),
      getEffectiveUser: () => ({ getEmail: () => OWNER }),
    },
    Utilities: {
      formatDate: (date, tz, format) => {
        if (format === "yyyy-MM-dd HH:mm:ss") return formatInZone(date, tz, format);
        assert.equal(format, "yyyy-MM-dd");
        return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
      },
    },
  };
  if (!opts.noSheetsService) ctx.Sheets = sheetsService(ss, opts);
  vm.createContext(ctx);
  vm.runInContext(read("apps-script/Logic.js"), ctx);
  vm.runInContext(read("apps-script/Sheets.js"), ctx);
  return ctx;
}

function sheetWith(ss, name, rows, maxCols = 26) {
  const sheet = new FakeSheet(name, 1000, maxCols, ss.nextSheetId++);
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
  assert.equal(rows.length, 19);
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
  assert.deepEqual(ss.tabNames(), ["Log (old layout)", "Settings", "Log", "Flags"]);
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
  assert.equal(rows.length, 19);
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
  assert.deepEqual(ss.tabNames(), ["Log", "Settings", "Flags"]);
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
  assert.equal(ss.getSheetByName("Settings").getDataRange().getValues().length, 20);
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
  const css = read("src/index.css");
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
