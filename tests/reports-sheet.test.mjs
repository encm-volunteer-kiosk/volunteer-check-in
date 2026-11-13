// Tests for apps-script/Reports.js against stand-ins for the spreadsheet, its protections
// and the advanced Sheets service. The server files are loaded into one global scope, as
// Apps Script loads them. What Sheets itself does with the formulas, views and
// protections can't be checked here; these tests check what Reports.js asks of it:
//
// - setupReports writes the Monthly Hours tab, the filter views and the soft warnings from
//   the header map, touches only what it marks, and a second run changes nothing.
// - adminMonthlyReport reads the Log without writing it and writes a new tab each time,
//   never changing an earlier one, with no User Token anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const SERVER_FILES = ["Logic.js", "Sheets.js", "Api.js", "Admin.js", "Reports.js"].map((f) => [
  f,
  readFileSync(new URL("apps-script/" + f, root), "utf8"),
]);
const plain = (x) => JSON.parse(JSON.stringify(x));
const TZ = "America/Chicago";

// ---------------------------------------------------------------------------
// Central time without Apps Script

const centralParts = (ms) => {
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(ms))
    .forEach((p) => (parts[p.type] = p.value));
  return parts;
};
const centralDate = (ms) => {
  const p = centralParts(ms);
  return p.year + "-" + p.month + "-" + p.day;
};
const centralClock = (ms) => {
  const p = centralParts(ms);
  const h = +p.hour;
  return (h % 12 || 12) + ":" + p.minute + " " + (h < 12 ? "AM" : "PM");
};
/** A Central time on a date as a Date (Central is UTC-5 in October, UTC-6 in November). */
const at = (date, hhmm) =>
  new Date(date + "T" + hhmm + ":00" + (date < "2026-11-01" ? "-05:00" : "-06:00"));

// ---------------------------------------------------------------------------
// Stand-ins for the spreadsheet

const colNumber = (letters) =>
  letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

class FakeProtection {
  constructor(sheet, type, range) {
    Object.assign(this, { sheet, type, range, description: "", warningOnly: false });
    this.unprotected = [];
  }
  setDescription(d) {
    this.description = d;
    return this;
  }
  getDescription() {
    return this.description;
  }
  setWarningOnly(w) {
    this.warningOnly = w;
    return this;
  }
  isWarningOnly() {
    return this.warningOnly;
  }
  setUnprotectedRanges(ranges) {
    this.unprotected = ranges.map((r) => r.getA1Notation());
    return this;
  }
  getRange() {
    return this.range;
  }
  remove() {
    this.sheet.protections = this.sheet.protections.filter((p) => p !== this);
  }
  state() {
    return plain({
      type: this.type,
      range: this.range ? this.range.getA1Notation() : "",
      description: this.description,
      warningOnly: this.warningOnly,
      unprotected: this.unprotected,
    });
  }
}

class FakeRange {
  constructor(sheet, row, col, rows, cols, a1) {
    Object.assign(this, { sheet, row, col, rows, cols, a1 });
  }
  each(fn) {
    for (let i = 0; i < this.rows; i++)
      for (let j = 0; j < this.cols; j++) fn(this.row + i, this.col + j, i, j);
  }
  getA1Notation() {
    if (this.a1) return this.a1;
    const first = colLetters(this.col) + this.row;
    if (this.rows === 1 && this.cols === 1) return first;
    return first + ":" + colLetters(this.col + this.cols - 1) + (this.row + this.rows - 1);
  }
  getRow() {
    return this.row;
  }
  getColumn() {
    return this.col;
  }
  getValues() {
    const out = Array.from({ length: this.rows }, () => Array(this.cols).fill(""));
    this.each((r, c, i, j) => (out[i][j] = this.sheet.get(r, c)));
    return out;
  }
  getValue() {
    return this.sheet.get(this.row, this.col);
  }
  setValue(v) {
    this.sheet.formulas.delete(this.row + ":" + this.col);
    this.sheet.set(this.row, this.col, v);
    return this;
  }
  setValues(values) {
    assert.equal(values.length, this.rows);
    this.each((r, c, i, j) => {
      assert.equal(values[i].length, this.cols);
      this.sheet.set(r, c, values[i][j]);
    });
    return this;
  }
  setFormula(f) {
    this.sheet.set(this.row, this.col, "");
    this.sheet.formulas.set(this.row + ":" + this.col, f);
    return this;
  }
  setNumberFormat(f) {
    this.sheet.rangeFormats.set(this.getA1Notation(), f);
    return this;
  }
  setNumberFormats(formats) {
    assert.equal(formats.length, this.rows);
    this.each((r, c, i, j) => this.sheet.cellFormats.set(r + ":" + c, formats[i][j]));
    return this;
  }
  clearContent() {
    this.each((r, c) => {
      this.sheet.set(r, c, "");
      this.sheet.formulas.delete(r + ":" + c);
    });
    return this;
  }
  setDataValidation(rule) {
    this.sheet.validations.set(this.getA1Notation(), rule);
    return this;
  }
  protect() {
    const p = new FakeProtection(this.sheet, "RANGE", this);
    this.sheet.protections.push(p);
    return p;
  }
}

class FakeSheet {
  constructor(name, sheetId, rows = []) {
    Object.assign(this, { name, sheetId, maxRows: 1000, maxCols: 26 });
    this.cells = new Map();
    this.formulas = new Map();
    this.rangeFormats = new Map();
    this.cellFormats = new Map();
    this.validations = new Map();
    this.hidden = new Set();
    this.protections = [];
    rows.forEach((r, i) => r.forEach((v, j) => this.set(i + 1, j + 1, v)));
  }
  get(r, c) {
    return this.cells.has(r + ":" + c) ? this.cells.get(r + ":" + c) : "";
  }
  set(r, c, v) {
    assert.ok(r <= this.maxRows && c <= this.maxCols, "outside the sheet: " + r + ":" + c);
    if (v === "" || v === null || v === undefined) this.cells.delete(r + ":" + c);
    else this.cells.set(r + ":" + c, v);
  }
  getName() {
    return this.name;
  }
  getSheetId() {
    return this.sheetId;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  insertRowsAfter(after, n) {
    this.maxRows += n;
  }
  insertColumnsAfter(after, n) {
    this.maxCols += n;
  }
  getLastRow() {
    return Math.max(0, ...[...this.cells.keys()].map((k) => +k.split(":")[0]));
  }
  getLastColumn() {
    return Math.max(0, ...[...this.cells.keys()].map((k) => +k.split(":")[1]));
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  getRange(a, col, rows = 1, cols = 1) {
    if (typeof a === "number") return new FakeRange(this, a, col, rows, cols);
    const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a);
    assert.ok(m, "A1 reference " + a);
    const c1 = colNumber(m[1]);
    const r1 = m[2] ? +m[2] : 1;
    const c2 = m[3] ? colNumber(m[3]) : c1;
    const r2 = m[3] ? (m[4] ? +m[4] : this.maxRows) : r1;
    assert.ok(c2 <= this.maxCols, "column outside the sheet: " + a);
    return new FakeRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1, a);
  }
  hideColumn(range) {
    this.hidden.add(colLetters(range.getColumn()));
  }
  getProtections(type) {
    return this.protections.filter((p) => p.type === type);
  }
  protect() {
    const p = new FakeProtection(this, "SHEET", null);
    this.protections.push(p);
    return p;
  }
  /** Everything a run could change, as plain data. */
  state() {
    return plain({
      name: this.name,
      maxRows: this.maxRows,
      maxCols: this.maxCols,
      cells: [...this.cells].map(([k, v]) => [k, v instanceof Date ? "D" + v.getTime() : v]),
      formulas: [...this.formulas],
      rangeFormats: [...this.rangeFormats],
      cellFormats: [...this.cellFormats],
      validations: [...this.validations],
      hidden: [...this.hidden],
      protections: this.protections.map((p) => p.state()),
    });
  }
}

/**
 * A fresh server scope over a spreadsheet holding the given Log and Settings rows.
 * opts.busy makes the script lock unavailable.
 */
function server(logRows, opts = {}) {
  const logs = [];
  let nextSheetId = 100;
  let nextViewId = 500;
  const ss = {
    sheets: [
      new FakeSheet("Log", 0, logRows),
      new FakeSheet("Settings", 1, [
        ["Setting", "Value"],
        ["Volunteer hour value", opts.rate ?? "34.79"],
      ]),
    ],
    active: null,
    views: new Map(), // sheetId -> [FilterView]
    batches: 0,
    getId: () => "file-1",
    getSheets: () => ss.sheets.slice(),
    getNumSheets: () => ss.sheets.length,
    getSheetByName: (name) =>
      ss.sheets.find((s) => s.name.toLowerCase() === String(name).toLowerCase()) || null,
    insertSheet: (name, index) => {
      if (ss.getSheetByName(name))
        throw new Error("A sheet with the name " + name + " already exists.");
      const sheet = new FakeSheet(name, nextSheetId++);
      ss.sheets.splice(index ?? ss.sheets.length, 0, sheet);
      ss.active = sheet;
      return sheet;
    },
    setActiveSheet: (sheet) => (ss.active = sheet),
    getSpreadsheetTimeZone: () => TZ,
  };
  const validation = () => {
    const rule = {};
    const b = {
      requireValueInRange: (range, show) => (
        (rule.list = range.getA1Notation()),
        (rule.dropdown = show),
        b
      ),
      setAllowInvalid: (allow) => ((rule.allowInvalid = allow), b),
      build: () => rule,
    };
    return b;
  };
  const lockCalls = [];
  const ctx = {
    console: { log: (text) => logs.push(text) },
    Session: {
      getActiveUser: () => ({ getEmail: () => "staff@example.org" }),
      getEffectiveUser: () => ({ getEmail: () => "staff@example.org" }),
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => (k === "admin-key:k" ? "1" : null), put: () => {} }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (lockCalls.push("tryLock"), !opts.busy),
        releaseLock: () => lockCalls.push("release"),
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => {
        throw new Error("Cannot call SpreadsheetApp.getUi() from this context.");
      },
      ProtectionType: { RANGE: "RANGE", SHEET: "SHEET" },
      newDataValidation: validation,
      flush: () => {},
    },
    Sheets: {
      Spreadsheets: {
        get: (id, params) => {
          assert.equal(id, "file-1");
          assert.match(params.fields, /filterViews\(filterViewId,title\)/);
          return {
            sheets: ss.sheets.map((s) => {
              const out = { properties: { sheetId: s.sheetId } };
              const views = ss.views.get(s.sheetId);
              if (views && views.length) out.filterViews = plain(views);
              return out;
            }),
          };
        },
        batchUpdate: (body, id) => {
          assert.equal(id, "file-1");
          ss.batches++;
          for (const r of body.requests) {
            if (r.addFilterView) {
              const view = { ...plain(r.addFilterView.filter), filterViewId: nextViewId++ };
              const list = ss.views.get(view.range.sheetId) || [];
              list.push(view);
              ss.views.set(view.range.sheetId, list);
            } else {
              const f = plain(r.updateFilterView.filter);
              assert.equal(r.updateFilterView.fields, "title,range,filterSpecs");
              const list = ss.views.get(f.range.sheetId);
              const i = list.findIndex((v) => v.filterViewId === f.filterViewId);
              assert.ok(i >= 0, "updated view exists");
              list[i] = f;
            }
          }
        },
      },
    },
    Utilities: {
      getUuid: () => "uuid",
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "yyyy-MM-dd") return centralDate(date.getTime());
        if (format === "HH:mm") {
          const p = centralParts(date.getTime());
          return p.hour + ":" + p.minute;
        }
        if (format === "yyyy-MM-dd h:mm a") {
          return centralDate(date.getTime()) + " " + centralClock(date.getTime());
        }
        throw new Error("format " + format);
      },
    },
  };
  vm.createContext(ctx);
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  const sheet = (name) => ss.getSheetByName(name);
  const snapshot = () =>
    plain({
      sheets: ss.sheets.map((s) => s.state()),
      views: [...ss.views],
    });
  return { ctx, ss, sheet, logs, lockCalls, snapshot };
}

// ---------------------------------------------------------------------------
// The Log: the kiosk's columns moved about, with staff columns between

const HEADER = [
  "Shift ID",
  "Staff column",
  "User Token",
  "Status",
  "Date",
  "Day",
  "Volunteer\nName",
  "Volunteer\nRole/Type",
  "Notes",
  "Check-In\nRecorded\n(timestamp)",
  "Check-In\nStated\n(user)",
  "Check-Out\nRecorded\n(timestamp)",
  "Check-Out\nStated (user)",
  "Hours Served\n(timestamps)",
  "Hours Served\n(stated)",
  "Admin\nAlerts?",
  "Activity",
  "Check-In\nEntered By",
  "Check-Out\nEntered By",
];
const row = (byHeader) =>
  HEADER.map((h) => {
    const key = h.replace(/\s+/g, " ");
    return key in byHeader ? byHeader[key] : "";
  });
const shift = (date, name, token, inAt, outAt, hours, extra = {}) =>
  row({
    "Shift ID": "s-" + date + "-" + token,
    "User Token": token,
    Status: "closed",
    Date: date,
    "Volunteer Name": name,
    "Check-In Recorded (timestamp)": at(date, inAt),
    "Check-In Stated (user)": at(date, inAt),
    "Check-Out Recorded (timestamp)": at(date, outAt),
    "Check-Out Stated (user)": at(date, outAt),
    "Hours Served (timestamps)": hours,
    "Hours Served (stated)": hours,
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": "kiosk",
    ...extra,
  });
const LOG = [
  HEADER,
  shift("2026-10-28", "Ben Ott", "tB", "09:00", "12:00", 3),
  // One Date typed as a date value.
  shift(at("2026-11-02", "00:00"), "Ana Ruiz", "tA", "09:00", "12:00", 3, {
    Date: at("2026-11-02", "00:00"),
    "Check-In Recorded (timestamp)": at("2026-11-02", "09:00"),
    "Check-In Stated (user)": at("2026-11-02", "09:00"),
    "Check-Out Recorded (timestamp)": at("2026-11-02", "12:00"),
    "Check-Out Stated (user)": at("2026-11-02", "12:00"),
    Activity: "Pantry",
  }),
  shift("2026-11-04", "Ben Ott", "tB", "10:00", "12:30", 2.5, {
    "Check-In Recorded (timestamp)": at("2026-11-04", "10:24"),
    "Hours Served (timestamps)": 2.1,
    "Admin Alerts?": "arrival differs by 24 min",
  }),
  row({
    "Shift ID": "s5",
    "User Token": "tA",
    Status: "closed",
    Date: "2026-11-04",
    "Volunteer Name": "Ana Ruiz",
    "Check-In Stated (user)": at("2026-11-04", "13:00"),
    "Check-Out Stated (user)": at("2026-11-04", "17:00"),
    "Hours Served (stated)": 4,
    "Check-In Entered By": "JP",
    "Check-Out Entered By": "JP",
  }),
  row({
    "Shift ID": "s6",
    "User Token": "tC",
    Status: "closed",
    Date: "2026-11-09",
    "Volunteer Name": "Cal Diaz",
    "Check-In Recorded (timestamp)": at("2026-11-09", "13:00"),
    "Check-In Stated (user)": at("2026-11-09", "13:00"),
    "Check-Out Stated (user)": at("2026-11-09", "15:00"),
    "Hours Served (stated)": 2,
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": "MK",
  }),
  row({
    "Shift ID": "s7",
    "User Token": "tB",
    Status: "open",
    Date: "2026-11-10",
    "Volunteer Name": "Ben Ott",
    "Check-In Recorded (timestamp)": at("2026-11-10", "09:00"),
    "Check-In Stated (user)": at("2026-11-10", "09:00"),
    "Check-In Entered By": "kiosk",
  }),
];
const letter = (header) => colLetters(HEADER.indexOf(header) + 1);
const thisMonth = () => centralDate(Date.now()).slice(0, 7);

// ---------------------------------------------------------------------------
// setupReports

test("setupReports writes the Monthly Hours tab from the header map, B1 a plain-text picker", () => {
  const s = server(LOG);
  const logBefore = s.sheet("Log").state().cells;
  s.ctx.setupReports();
  const tab = s.sheet("Monthly Hours");
  assert.ok(tab);
  const cols = s.ctx.reportColumns(HEADER.map((h) => h));
  const plan = plain(s.ctx.monthlyHoursFormulas(cols, "Log"));
  for (const c of plan.cells) {
    const [r, col] = [+/\d+/.exec(c.a1)[0], colNumber(/^[A-Z]+/.exec(c.a1)[0])];
    if (c.value.startsWith("=")) assert.equal(tab.formulas.get(r + ":" + col), c.value, c.a1);
    else assert.equal(tab.get(r, col), c.value, c.a1);
  }
  // The formulas read the Log by the map's letters.
  assert.ok(tab.formulas.get("2:8").includes("'Log'!" + letter("User Token") + "2:"));
  for (const f of plan.formats) assert.equal(tab.rangeFormats.get(f.range), f.format, f.range);
  // B1: plain text set before the month, and the current month.
  assert.equal(tab.rangeFormats.get("B1"), "@");
  assert.equal(tab.get(1, 2), thisMonth());
  assert.deepEqual(tab.validations.get("B1"), {
    list: "N1:N",
    dropdown: true,
    allowInvalid: false,
  });
  assert.deepEqual([...tab.hidden].sort(), ["H", "I", "J", "K", "L", "N"]);
  assert.ok(tab.maxRows >= 5000);
  // One warning-only protection on the tab, B1 left open.
  assert.deepEqual(
    tab.protections.map((p) => p.state()),
    [
      {
        type: "SHEET",
        range: "",
        description: s.ctx.monthlyHoursDescription(),
        warningOnly: true,
        unprotected: ["B1"],
      },
    ],
  );
  // The Log's cells are untouched.
  assert.deepEqual(s.sheet("Log").state().cells, logBefore);
});

test("setupReports adds the seven filter views and the soft warnings on the kiosk columns", () => {
  const s = server(LOG);
  s.ctx.setupReports();
  const views = s.ss.views.get(0);
  const specs = plain(s.ctx.filterViewSpecs(s.ctx.reportColumns(HEADER), 0));
  assert.equal(views.length, 7);
  assert.deepEqual(
    views.map(({ filterViewId, ...v }) => v),
    specs,
  );
  const warned = s.sheet("Log").protections.map((p) => p.state());
  const wanted = plain(s.ctx.kioskWarnHeaders())
    .map((h) =>
      HEADER.findIndex(
        (x) => x.replace(/\s+/g, " ").toLowerCase() === h.replace(/\s+/g, " ").toLowerCase(),
      ),
    )
    .map((i) => colLetters(i + 1) + ":" + colLetters(i + 1));
  assert.equal(wanted.length, 14);
  assert.deepEqual(warned.map((p) => p.range).sort(), wanted.slice().sort());
  for (const p of warned) {
    assert.equal(p.type, "RANGE");
    assert.equal(p.warningOnly, true);
    assert.equal(p.description, s.ctx.kioskWarnDescription());
  }
  // Staff columns are not warned.
  for (const h of ["Staff column", "Notes", "Activity", "Volunteer\nRole/Type", "Admin\nAlerts?"]) {
    assert.ok(!warned.some((p) => p.range === letter(h) + ":" + letter(h)), h);
  }
  const text = s.logs.join("\n");
  assert.match(text, /Filter views: 0 updated, 7 added\./);
  assert.match(text, /Kiosk column warnings: 0 kept, 14 added, 0 removed\./);
  assert.match(text, /After a Log column is inserted, deleted or moved/);
});

test("running setupReports twice changes nothing, and the views keep their ids", () => {
  const s = server(LOG);
  s.ctx.setupReports();
  const first = s.snapshot();
  s.logs.length = 0;
  s.ctx.setupReports();
  assert.deepEqual(s.snapshot(), first);
  assert.match(s.logs[0], /Filter views: 7 updated, 0 added\./);
  assert.match(s.logs[0], /Kiosk column warnings: 14 kept, 0 added, 0 removed\./);
});

test("setupReports keeps a picked month in B1, and replaces anything else", () => {
  const s = server(LOG);
  s.ctx.setupReports();
  const b1 = s.sheet("Monthly Hours").getRange("B1");
  b1.setValue("2026-09");
  s.ctx.setupReports();
  assert.equal(b1.getValue(), "2026-09");
  // A date value, as an Automatic-format cell would have turned "2026-09" into.
  b1.setValue(at("2026-09-01", "00:00"));
  s.ctx.setupReports();
  assert.equal(b1.getValue(), thisMonth());
  b1.setValue("September");
  s.ctx.setupReports();
  assert.equal(b1.getValue(), thisMonth());
});

test("setupReports clears what was typed over its tab, and leaves other tabs alone", () => {
  const s = server(LOG);
  s.ctx.setupReports();
  const tab = s.sheet("Monthly Hours");
  const clean = tab.state();
  tab.getRange("A8").setValue("typed in the spill's way");
  tab.getRange("H2").setValue("typed over the formula");
  tab.getRange("Z40").setValue("x");
  s.ctx.setupReports();
  assert.deepEqual(tab.state(), clean);
});

test("setupReports touches only the protections and views it marks", () => {
  const s = server(LOG);
  s.ctx.setupReports();
  // A report tab, with its own protection.
  assert.equal(s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "jp" }).ok, true);
  const report = s.sheet("Report 2026-11");
  const reportProtection = report.protections[0];
  const reportBefore = report.state();
  // Staff's own protection and view on the Log, and a second sheet protection on the tab.
  const log = s.sheet("Log");
  log.getRange("B:B").protect().setDescription("Staff: payroll");
  log.getRange("A2:C9").protect();
  s.sheet("Monthly Hours").protect().setDescription("Staff: hands off");
  s.ss.views.get(0).push({ filterViewId: 9, title: "Andrea's view", range: { sheetId: 0 } });
  // A duplicate of one of its own warnings, and one left on a column it no longer names.
  const notes = letter("Notes");
  log
    .getRange(notes + ":" + notes)
    .protect()
    .setDescription(s.ctx.kioskWarnDescription());
  const date = letter("Date");
  log
    .getRange(date + ":" + date)
    .protect()
    .setDescription(s.ctx.kioskWarnDescription());
  // Its own warning made blocking by hand.
  log.protections[0].setWarningOnly(false);
  s.logs.length = 0;

  s.ctx.setupReports();
  assert.match(s.logs[0], /14 kept, 0 added, 2 removed/);
  assert.deepEqual(report.state(), reportBefore);
  assert.equal(report.protections[0], reportProtection);
  assert.ok(log.protections.some((p) => p.description === "Staff: payroll"));
  assert.ok(log.protections.some((p) => p.range.getA1Notation() === "A2:C9"));
  const own = log.protections.filter((p) => p.description.startsWith("Kiosk column:"));
  assert.equal(own.length, 14);
  assert.ok(own.every((p) => p.warningOnly));
  assert.ok(!own.some((p) => p.range.getA1Notation() === notes + ":" + notes));
  const tabProtections = s.sheet("Monthly Hours").protections.map((p) => p.description);
  assert.deepEqual(tabProtections, [s.ctx.monthlyHoursDescription(), "Staff: hands off"]);
  assert.ok(s.ss.views.get(0).some((v) => v.title === "Andrea's view" && v.filterViewId === 9));
  assert.equal(s.ss.views.get(0).length, 8);
});

test("setupReports on a Log missing a kiosk column throws the kiosk's message and changes nothing", () => {
  const header = HEADER.filter((h) => h !== "User Token");
  const s = server([header]);
  const before = s.snapshot();
  assert.throws(
    () => s.ctx.setupReports(),
    /The Log has no "user token" column\. Run setupSheets\(\)\./,
  );
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.ss.batches, 0);
});

// ---------------------------------------------------------------------------
// The Monthly report

test("adminReportMonths lists the Log's months up to now, newest first, with labels", () => {
  const s = server([
    ...LOG,
    shift("2999-01-05", "Fay Lin", "tF", "09:00", "10:00", 1),
    shift("11/02/2026", "Gus Orr", "tG", "09:00", "10:00", 1),
  ]);
  const reply = plain(s.ctx.adminReportMonths("k"));
  assert.equal(reply.ok, true);
  const months = reply.months.map((m) => m.month);
  assert.deepEqual(months, [...new Set([thisMonth(), "2026-11", "2026-10"])].sort().reverse());
  assert.deepEqual(
    reply.months.find((m) => m.month === "2026-10"),
    { month: "2026-10", label: "October 2026" },
  );
  assert.ok(months.includes(reply.defaultMonth));
});

test("adminMonthlyReport writes a new protected tab from the Log, read under the lock", () => {
  const s = server(LOG);
  const logBefore = s.sheet("Log").state();
  const reply = plain(s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "j.p." }));
  assert.equal(reply.ok, true);
  assert.equal(reply.tabName, "Report 2026-11");
  const tab = s.sheet("Report 2026-11");
  assert.equal(s.ss.sheets[s.ss.sheets.length - 1], tab);
  assert.equal(s.ss.active, tab);
  assert.deepEqual(reply, {
    ok: true,
    tabName: "Report 2026-11",
    csvUrl: "https://docs.google.com/spreadsheets/d/file-1/export?format=csv&gid=" + tab.sheetId,
    pdfUrl:
      "https://docs.google.com/spreadsheets/d/file-1/export?format=pdf&gid=" +
      tab.sheetId +
      "&portrait=false&fitw=true&gridlines=false",
  });
  // The values and formats reportRows makes, every cell with its format.
  const values = tab.getRange(1, 1, tab.getLastRow(), 5).getValues();
  assert.match(values[0][0], /^Monthly report for November 2026 \(2026-11\)$/);
  assert.match(values[1][0], /by JP from the Log tab\./);
  const flat = values.flat();
  assert.ok(flat.includes(11.5), "total stated hours");
  assert.ok(flat.includes(400.09), "volunteer value at 34.79");
  assert.equal(tab.cellFormats.size, values.length * 5);
  // No User Token anywhere in the tab or the reply.
  for (const token of ["tA", "tB", "tC"]) {
    assert.ok(!flat.some((v) => String(v).includes(token)), token);
    assert.ok(!JSON.stringify(reply).includes(token), token);
  }
  assert.deepEqual(
    tab.protections.map((p) => p.state()),
    [
      {
        type: "SHEET",
        range: "",
        description: s.ctx.reportTabDescription(),
        warningOnly: true,
        unprotected: [],
      },
    ],
  );
  assert.deepEqual(s.lockCalls, ["tryLock", "release"]);
  assert.deepEqual(s.sheet("Log").state(), logBefore);
});

test("a second report for a month makes a new tab and leaves the first as it was", () => {
  const s = server(LOG);
  s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "JP" });
  const first = s.sheet("Report 2026-11").state();
  s.sheet("Log")
    .getRange(7, HEADER.indexOf("Status") + 1)
    .setValue("closed");
  const reply = plain(s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "MK" }));
  assert.equal(reply.tabName, "Report 2026-11 (2)");
  assert.deepEqual(s.sheet("Report 2026-11").state(), first);
  assert.notEqual(s.sheet("Report 2026-11 (2)").sheetId, s.sheet("Report 2026-11").sheetId);
});

test("adminMonthlyReport refusals write nothing", () => {
  const s = server(LOG);
  const before = s.snapshot();
  const cases = [
    [{ month: "2026-11", initials: "1" }, "ADMIN_INITIALS"],
    [{ month: "2026-11" }, "ADMIN_INITIALS"],
    [{ month: "2026-13", initials: "JP" }, "ADMIN_BAD_MONTH"],
    [{ month: "", initials: "JP" }, "ADMIN_BAD_MONTH"],
    [{ month: "2999-01", initials: "JP" }, "ADMIN_FUTURE"],
  ];
  for (const [form, code] of cases) {
    assert.deepEqual(plain(s.ctx.adminMonthlyReport("k", form)), plain(s.ctx.refusal(code)), code);
  }
  assert.deepEqual(
    plain(s.ctx.adminMonthlyReport("k", null)),
    plain(s.ctx.refusal("ADMIN_INITIALS")),
  );
  assert.deepEqual(s.snapshot(), before);
  assert.deepEqual(s.lockCalls, []);

  const busy = server(LOG, { busy: true });
  assert.deepEqual(
    plain(busy.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "JP" })),
    plain(busy.ctx.refusal("BUSY")),
  );
  assert.equal(busy.ss.sheets.length, 2);
});

test("a blank hour value prints the Settings message instead of a dollar figure", () => {
  const s = server(LOG, { rate: "" });
  s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "JP" });
  const flat = s.sheet("Report 2026-11").getRange(1, 1, 200, 5).getValues().flat();
  assert.ok(flat.includes("Set Volunteer hour value in Settings"));
});
