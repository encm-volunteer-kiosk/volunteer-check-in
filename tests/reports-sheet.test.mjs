// Tests for apps-script/Reports.js against stand-ins for the spreadsheet, its protections
// and the advanced Sheets service. The server files are loaded into one global scope, as
// Apps Script loads them. What Sheets itself does with the formulas, views and
// protections can't be checked here; these tests check what Reports.js asks of it:
//
// - setupReports builds and fills the Hours and Hours data tabs, writes the filter views and
//   the soft warnings from the header map, touches only what it marks, and a second run at
//   the same time changes nothing.
// - Every write to Hours, Hours data and the state cells falls inside one hold of the
//   document lock, and inside a hold the writes are exactly hoursNextState's steps, in
//   order; B1 is written only by renderHoursLine_; nothing is deleted before the write it
//   depends on reads back done. The stand-ins record every write in order to check this.
// - adminMonthlyReport reads the Log without writing it and writes a new tab each time,
//   never changing an earlier one, with no User Token anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { formatInZone } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const SERVER_FILES = ["Logic.js", "Sheets.js", "Api.js", "Admin.js", "Reports.js", "Jobs.js"].map(
  (f) => [f, readFileSync(new URL("apps-script/" + f, root), "utf8")],
);
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

// Every write a stand-in sees, in order, as {sheet, op, a1, value}, plus the lock, flush,
// batchUpdate and alert calls: the calls array of the server() that is running. Tests in
// one file run one at a time, so one array at a time is enough.
// FAIL, when set, throws "injected" at the first call it matches, before the call acts.
let RECORD = null;
let FAIL = null;
const rec = (entry) => {
  if (RECORD) RECORD.push(entry);
  if (FAIL && FAIL(entry)) {
    FAIL = null;
    throw new Error("injected");
  }
};

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
    rec({ sheet: this.sheet.name, op: "setValue", a1: this.getA1Notation(), value: v });
    this.sheet.formulas.delete(this.row + ":" + this.col);
    this.sheet.set(this.row, this.col, v);
    return this;
  }
  setValues(values) {
    rec({ sheet: this.sheet.name, op: "setValues", a1: this.getA1Notation(), value: values });
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
    rec({ sheet: this.sheet.name, op: "setNumberFormat", a1: this.getA1Notation(), value: f });
    this.sheet.rangeFormats.set(this.getA1Notation(), f);
    return this;
  }
  setNumberFormats(formats) {
    rec({ sheet: this.sheet.name, op: "setNumberFormats", a1: this.getA1Notation() });
    assert.equal(formats.length, this.rows);
    this.each((r, c, i, j) => this.sheet.cellFormats.set(r + ":" + c, formats[i][j]));
    return this;
  }
  clearContent() {
    rec({ sheet: this.sheet.name, op: "clearContent", a1: this.getA1Notation() });
    this.each((r, c) => {
      this.sheet.set(r, c, "");
      this.sheet.formulas.delete(r + ":" + c);
    });
    return this;
  }
  breakApart() {
    rec({ sheet: this.sheet.name, op: "breakApart", a1: this.getA1Notation() });
    this.sheet.merges = [];
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
    // Styles set through range lists, as [a1, what, value] in call order; widths by column.
    this.styles = [];
    this.widths = new Map();
    this.tabColor = null;
    // Developer metadata as [key, value]; what the advanced Sheets service put on the tab.
    this.metadata = [];
    this.slicers = [];
    this.pivots = [];
    this.rules = [];
    this.merges = [];
    this.frozenRows = 0;
    this.hiddenSheet = false;
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
    rec({ sheet: this.name, op: "insertRowsAfter", value: [after, n] });
    this.maxRows += n;
  }
  insertColumnsAfter(after, n) {
    rec({ sheet: this.name, op: "insertColumnsAfter", value: [after, n] });
    this.maxCols += n;
  }
  /** Deletes rows start to start + n - 1; the cells below move up. */
  deleteRows(start, n) {
    rec({ sheet: this.name, op: "deleteRows", value: [start, n] });
    assert.ok(start >= 1 && start + n - 1 <= this.maxRows, "rows outside the sheet");
    const moved = new Map();
    for (const [k, v] of this.cells) {
      const [r, c] = k.split(":").map(Number);
      if (r < start) moved.set(k, v);
      else if (r >= start + n) moved.set(r - n + ":" + c, v);
    }
    this.cells = moved;
    this.maxRows -= n;
  }
  clear() {
    rec({ sheet: this.name, op: "clear" });
    this.cells.clear();
    this.formulas.clear();
    this.rangeFormats.clear();
    this.cellFormats.clear();
  }
  addDeveloperMetadata(key, value) {
    rec({ sheet: this.name, op: "addDeveloperMetadata", value: [key, value] });
    this.metadata.push([key, value]);
    return this;
  }
  getSlicers() {
    return this.slicers.map((spec) => ({
      remove: () => {
        rec({ sheet: this.name, op: "removeSlicer" });
        this.slicers = this.slicers.filter((x) => x !== spec);
      },
    }));
  }
  getPivotTables() {
    return this.pivots.map((spec) => ({
      remove: () => {
        rec({ sheet: this.name, op: "removePivot" });
        this.pivots = this.pivots.filter((x) => x !== spec);
      },
    }));
  }
  clearConditionalFormatRules() {
    rec({ sheet: this.name, op: "clearConditionalFormatRules" });
    this.rules = [];
  }
  setFrozenRows(n) {
    rec({ sheet: this.name, op: "setFrozenRows", value: n });
    this.frozenRows = n;
  }
  hideSheet() {
    rec({ sheet: this.name, op: "hideSheet" });
    this.hiddenSheet = true;
    return this;
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
  getRangeList(a1s) {
    a1s.forEach((a1) => this.getRange(a1));
    const record =
      (what) =>
      (...args) => {
        a1s.forEach((a1) => this.styles.push([a1, what, args.length === 1 ? args[0] : args]));
        return list;
      };
    const list = {
      setBackground: record("background"),
      setFontColor: record("fontColor"),
      setFontSize: record("fontSize"),
      setFontWeight: record("fontWeight"),
      setBorder: record("border"),
    };
    return list;
  }
  setColumnWidth(col, px) {
    assert.ok(col >= 1 && col <= this.maxCols, "column outside the sheet: " + col);
    this.widths.set(col, px);
    return this;
  }
  setTabColor(color) {
    rec({ sheet: this.name, op: "setTabColor", value: color });
    this.tabColor = color;
    return this;
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
      styles: this.styles,
      widths: [...this.widths],
      tabColor: this.tabColor,
      metadata: this.metadata,
      slicers: this.slicers,
      pivots: this.pivots,
      rules: this.rules,
      merges: this.merges,
      frozenRows: this.frozenRows,
      hiddenSheet: this.hiddenSheet,
    });
  }
}

/**
 * A fresh server scope over a spreadsheet holding the given Log and Settings rows.
 * opts.busy makes the script lock unavailable, opts.docBusy the document lock; opts.now
 * fixes the server's clock (ms); opts.ui gives a spreadsheet UI whose alerts land in
 * alerts; opts.onFlush runs at each SpreadsheetApp.flush.
 */
function server(logRows, opts = {}) {
  const logs = [];
  const calls = [];
  const alerts = [];
  RECORD = calls;
  FAIL = null;
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
    deleteSheet: (sheet) => {
      rec({ sheet: sheet.name, op: "deleteSheet" });
      ss.sheets = ss.sheets.filter((x) => x !== sheet);
    },
    createDeveloperMetadataFinder: () => {
      let key = null;
      const finder = {
        withKey: (k) => ((key = k), finder),
        find: () =>
          ss.sheets.flatMap((sheet) =>
            sheet.metadata
              .filter(([k]) => k === key)
              .map(([k, v]) => ({
                getKey: () => k,
                getValue: () => v,
                getLocation: () => ({ getSheet: () => sheet }),
              })),
          ),
      };
      return finder;
    },
  };
  const bySheetId = (id) => ss.sheets.find((x) => x.sheetId === id);
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
    ScriptApp: {
      getProjectTriggers: () => [
        { getUniqueId: () => "t-hours", getHandlerFunction: () => "runHoursRefresh" },
      ],
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => (k === "admin-key:k" ? "1" : null), put: () => {} }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (lockCalls.push("tryLock"), rec({ op: "scriptLock.tryLock" }), !opts.busy),
        releaseLock: () => (lockCalls.push("release"), rec({ op: "scriptLock.release" })),
      }),
      getDocumentLock: () => ({
        tryLock: (wait) => {
          rec({ op: "docLock.tryLock", value: wait });
          return !opts.docBusy;
        },
        releaseLock: () => rec({ op: "docLock.release" }),
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => {
        if (!opts.ui) throw new Error("Cannot call SpreadsheetApp.getUi() from this context.");
        return { alert: (text) => (rec({ op: "alert", value: text }), alerts.push(text)) };
      },
      ProtectionType: { RANGE: "RANGE", SHEET: "SHEET" },
      BorderStyle: { SOLID: "SOLID" },
      newDataValidation: validation,
      flush: () => {
        rec({ op: "flush" });
        if (opts.onFlush) opts.onFlush();
      },
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
          rec({ op: "batchUpdate", value: body.requests.length });
          for (const r of body.requests) {
            if (r.addSlicer) {
              const sheet = bySheetId(
                r.addSlicer.slicer.position.overlayPosition.anchorCell.sheetId,
              );
              sheet.slicers.push(plain(r.addSlicer.slicer));
            } else if (r.updateCells && r.updateCells.fields === "pivotTable") {
              const sheet = bySheetId(r.updateCells.start.sheetId);
              sheet.pivots.push(plain(r.updateCells));
            } else if (r.addConditionalFormatRule) {
              const rule = r.addConditionalFormatRule;
              bySheetId(rule.rule.ranges[0].sheetId).rules.splice(rule.index, 0, plain(rule.rule));
            } else if (r.mergeCells) {
              bySheetId(r.mergeCells.range.sheetId).merges.push(plain(r.mergeCells.range));
            } else if (r.unmergeCells || r.repeatCell || r.updateDimensionProperties) {
              // Formats and sizes: what was asked is checked against hoursTabPlan.
            } else if (r.addFilterView) {
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
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest: (algorithm, text) => {
        assert.equal(algorithm, "SHA_256");
        return [...createHash("sha256").update(String(text), "utf8").digest()].map((b) =>
          b > 127 ? b - 256 : b,
        );
      },
      getUuid: () => "uuid",
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "yyyy-MM-dd HH:mm:ss") return formatInZone(date, tz, format);
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
  if (opts.now !== undefined) {
    const RealDate = vm.runInContext("Date", ctx);
    const now = () => (typeof opts.now === "function" ? opts.now() : opts.now);
    ctx.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [now()]));
      }
      static now() {
        return now();
      }
    };
  }
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  // Who releases the Hours lock: the function that called releaseHoursLock_.
  const release = ctx.releaseHoursLock_;
  ctx.releaseHoursLock_ = (hold) => {
    const caller = /at (\S+)/.exec(new Error().stack.split("\n")[2]);
    rec({ op: "release-by", value: caller ? caller[1].replace(/^Object\./, "") : "?" });
    return release(hold);
  };
  const sheet = (name) => ss.getSheetByName(name);
  const snapshot = () =>
    plain({
      sheets: ss.sheets.map((s) => s.state()),
      views: [...ss.views],
    });
  return { ctx, ss, sheet, logs, lockCalls, snapshot, calls, alerts };
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
// 2026-11-13 9:14 AM Central.
const NOW = Date.UTC(2026, 10, 13, 15, 14);

// ---------------------------------------------------------------------------
// setupReports

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
  const s = server(LOG, { now: NOW });
  s.ctx.setupReports();
  const first = s.snapshot();
  s.logs.length = 0;
  s.ctx.setupReports();
  assert.deepEqual(s.snapshot(), first);
  assert.match(s.logs[0], /Filter views: 7 updated, 0 added\./);
  assert.match(s.logs[0], /Kiosk column warnings: 14 kept, 0 added, 0 removed\./);
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

test("a new report tab is styled by row kind: title, section headings, table headers, widths, tab colour", () => {
  const s = server(LOG);
  s.ctx.adminMonthlyReport("k", { month: "2026-11", initials: "JP" });
  const tab = s.sheet("Report 2026-11");
  const values = tab.getRange(1, 1, tab.getLastRow(), 5).getValues();
  const rowOf = (a1) => +/\d+$/.exec(a1)[0];
  const styled = (what, value) =>
    tab.styles.filter((x) => x[1] === what && JSON.stringify(x[2]) === JSON.stringify(value));
  // The title: A1, navy, 14 pt, bold.
  assert.deepEqual(
    styled("fontSize", 14).map((x) => x[0]),
    ["A1"],
  );
  assert.ok(styled("fontColor", "#062f5a").some((x) => x[0] === "A1"));
  // Section headings: the light-blue fill across A:E, on each section's title row.
  const sections = styled("background", "#dff3fb").map((x) => x[0]);
  for (const title of [
    "Summary",
    "Month over month",
    "Year to date",
    "Hours per volunteer",
    "Rows to review",
  ]) {
    const row = values.findIndex((r) => r[0] === title) + 1;
    assert.ok(sections.includes("A" + row + ":E" + row), title);
  }
  assert.ok(sections.every((a1) => /^A(\d+):E\1$/.test(a1)));
  assert.ok(!sections.some((a1) => values[rowOf(a1) - 1][0] === "Stated hours"));
  // Table headers: bold with a navy bottom border, from A to the last header cell.
  const borders = styled("border", [null, null, true, null, null, null, "#062f5a", "SOLID"]).map(
    (x) => x[0],
  );
  const volunteerHeader = values.findIndex((r) => r[0] === "Volunteer" && r[1] === "Shifts") + 1;
  assert.ok(borders.includes("A" + volunteerHeader + ":C" + volunteerHeader));
  assert.ok(borders.every((a1) => styled("fontWeight", "bold").some((x) => x[0] === a1)));
  assert.deepEqual(tab.widths.size, 5);
  assert.equal(tab.tabColor, "#0669a9");
  // Styling changes no value or number format.
  assert.equal(tab.cellFormats.size, values.length * 5);
  assert.match(values[0][0], /^Monthly report for November 2026/);
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

// ---------------------------------------------------------------------------
// The Hours tab: setupReports, the refresh, and the write rule

const STATE = ["L1", "M1", "N1", "O1", "P1", "Q1"];
const isHoursWrite = (c) => c.sheet === "Hours" || c.sheet === "Hours data";
const cellsOf = (s) => STATE.map((a1) => s.sheet("Hours data").getRange(a1).getValue());
const TRIGGER = { triggerUid: "t-hours" };

/**
 * A server after setupReports at NOW, its calls and logs cleared. o.at is the clock from
 * then on; o.docBusy and o.ui can be changed later too.
 */
function built(opts = {}, log = LOG) {
  const o = Object.assign({ at: NOW, ui: true }, opts);
  o.now = () => o.at;
  const s = server(log, o);
  s.ctx.setupReports();
  s.calls.length = 0;
  s.logs.length = 0;
  s.o = o;
  return s;
}

/** Each entry point the refresh has, run once. */
const ENTRY = {
  menu: (s) => s.ctx.refreshHoursNow(),
  nightly: (s) => s.ctx.runHoursRefresh(TRIGGER),
  open: (s) => {
    const hold = s.ctx.hoursHold_();
    try {
      return s.ctx.refreshHoursOnOpen_(hold, s.o.at);
    } finally {
      s.ctx.releaseHoursLock_(hold);
    }
  },
};

/** The recorded calls read back as hoursNextState's step ops, in order. */
function hoursOps(calls) {
  const out = [];
  for (const c of calls) {
    if (c.op === "flush") out.push({ op: "flush" });
    else if (c.sheet === "Hours" && c.op === "setValue" && c.a1 === "B1")
      out.push({ op: "render" });
    else if (c.sheet === "Hours" && c.op === "setValue" && c.a1 === "A3")
      out.push({ op: "counts" });
    else if (c.sheet === "Hours data") {
      if (c.op === "setValue" && STATE.includes(c.a1)) {
        out.push({ op: "set", cell: c.a1, value: c.value });
      } else if (c.op === "insertRowsAfter") out.push({ op: "grow" });
      else if (c.op === "setValues" && c.a1.startsWith("A2:")) out.push({ op: "values" });
      else if (c.op === "clearContent" && c.a1 === "A2:J2") out.push({ op: "clear" });
      else if (c.op === "deleteRows") out.push({ op: "trim" });
      else if (c.op !== "setNumberFormats") out.push({ op: "unexpected " + c.op });
    } else if (isHoursWrite(c)) out.push({ op: "unexpected " + c.op + " " + c.a1 });
  }
  return out;
}

/**
 * Checks one hold: one document lock request; one release, by an entry point's finally
 * (ENTRY.open stands in for onOpen); every Hours write between.
 */
function checkOneHold(calls, label) {
  const asks = calls.flatMap((c, i) => (c.op === "docLock.tryLock" ? [i] : []));
  const releases = calls.flatMap((c, i) => (c.op === "docLock.release" ? [i] : []));
  assert.equal(asks.length, 1, label + ": one lock request");
  assert.equal(releases.length, 1, label + ": one release");
  const by = calls[releases[0] - 1];
  assert.equal(by.op, "release-by", label);
  assert.ok(
    ["setupReports", "refreshHoursNow", "runHoursRefresh", "open"].includes(by.value),
    label + ": released by " + by.value,
  );
  calls.forEach((c, i) => {
    if (isHoursWrite(c)) {
      assert.ok(i > asks[0] && i < releases[0], label + ": outside the hold " + JSON.stringify(c));
    }
  });
  assert.ok(!calls.some((c) => c.op.startsWith("scriptLock")), label + ": the script lock");
}

test("setupReports builds Hours and Hours data, marked, fills them, and then deletes the kiosk's Monthly Hours tab", () => {
  const s = server(LOG, { now: NOW });
  s.ss.insertSheet("Monthly Hours").protect().setDescription("Monthly Hours tab: kiosk");
  const logBefore = s.sheet("Log").state().cells;
  s.calls.length = 0;
  s.ctx.setupReports();
  const data = s.sheet("Hours data");
  const hours = s.sheet("Hours");
  assert.deepEqual(data.metadata, [["kiosk-tab", "hours-data"]]);
  assert.deepEqual(hours.metadata, [["kiosk-tab", "hours"]]);
  assert.equal(data.hiddenSheet, true);
  const table = plain(s.ctx.readHoursTable_().table);
  assert.ok(table.rows.length >= 3);
  assert.deepEqual(data.getRange("A1:J1").getValues()[0], table.header);
  assert.deepEqual(data.getRange(2, 1, table.rows.length, 10).getValues(), table.rows);
  assert.equal(data.maxRows, table.rows.length + 1);
  assert.equal(data.rangeFormats.get("A2:A"), "@");
  assert.equal(data.rangeFormats.get("G2:G"), "0");
  assert.equal(data.rangeFormats.get("H2:H"), "0.00");
  assert.equal(data.rangeFormats.get("L1:Q1"), "@");
  const [l1, m1, n1, o1, p1, q1] = cellsOf(s);
  assert.deepEqual(
    [l1, m1, n1, o1, q1],
    [
      String(NOW),
      "complete",
      "refreshed|setupReports|" + NOW + "|" + NOW + "|",
      "0|0|0|" + table.rows.length,
      "built " + NOW,
    ],
  );
  assert.match(p1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hours.get(1, 1), "Volunteer hours");
  assert.equal(hours.get(1, 2), "As of 2026-11-13 9:14 AM, refreshed by setupReports.");
  assert.equal(hours.get(3, 1), table.countsLine);
  assert.match(hours.get(2, 1), /the last refresh from the menu, at night or by setupReports\./);
  assert.equal(hours.frozenRows, 1);
  assert.equal(hours.slicers.length, 5);
  assert.equal(hours.pivots.length, 3);
  const source = plain(s.ctx.hoursSourceRange(data.sheetId));
  for (const slicer of hours.slicers) assert.deepEqual(slicer.spec.dataRange, source);
  for (const p of hours.pivots) assert.deepEqual(p.rows[0].values[0].pivotTable.source, source);
  // Monthly Hours goes last: after M1 "complete", a flush and the read-back.
  assert.equal(s.sheet("Monthly Hours"), null);
  const at = (pred) => s.calls.findIndex(pred);
  const complete = at((c) => c.sheet === "Hours data" && c.a1 === "M1" && c.value === "complete");
  const deleted = at((c) => c.op === "deleteSheet");
  assert.ok(complete > 0 && deleted > complete);
  assert.ok(s.calls.slice(complete, deleted).some((c) => c.op === "flush"));
  // The spare rows went only after the table's setValues.
  const values = at((c) => c.sheet === "Hours data" && c.op === "setValues" && c.a1 !== "A1:J1");
  assert.ok(values > 0 && at((c) => c.op === "deleteRows") > values);
  const text = s.logs.join("\n");
  assert.match(text, /Hours is filled as of 2026-11-13 9:14 AM\./);
  assert.match(text, /The Monthly Hours tab was deleted/);
  assert.deepEqual(s.sheet("Log").state().cells, logBefore);
});

test("setupReports leaves a Monthly Hours tab without the kiosk's protection, and says so", () => {
  const s = server(LOG, { now: NOW });
  s.ss.insertSheet("Monthly Hours").protect().setDescription("Staff: hands off");
  s.ctx.setupReports();
  assert.ok(s.sheet("Monthly Hours"));
  assert.match(s.logs.join("\n"), /A tab named Monthly Hours was left alone/);
});

test("a tab named Hours or Hours data that isn't the kiosk's stops setupReports before any change, and gets no refresh write", () => {
  for (const name of ["Hours", "Hours data"]) {
    const s = server(LOG, { now: NOW, ui: true });
    s.ss.insertSheet(name).getRange("A1").setValue("staff's");
    const before = s.snapshot();
    s.calls.length = 0;
    assert.throws(() => s.ctx.setupReports(), new RegExp('"' + name + "\" isn't the kiosk's"));
    assert.deepEqual(s.snapshot(), before, name);
    assert.deepEqual(s.calls, [], name);
    s.ctx.refreshHoursNow();
    assert.deepEqual(s.alerts, ["Run setupReports."]);
    assert.deepEqual(s.snapshot(), before, name);
  }
});

test("every Hours write falls inside one hold of the document lock, released last, never the script lock", () => {
  const s = server(LOG, { now: NOW });
  s.ctx.setupReports();
  checkOneHold(s.calls, "setupReports");
  assert.deepEqual(
    s.calls.filter((c) => c.op === "docLock.tryLock").map((c) => c.value),
    [60000],
  );
  const waits = { menu: 30000, nightly: 120000, open: 2000 };
  for (const name of Object.keys(ENTRY)) {
    const b = built();
    b.o.at = NOW + 60000;
    ENTRY[name](b);
    checkOneHold(b.calls, name);
    assert.equal(b.calls.find((c) => c.op === "docLock.tryLock").value, waits[name], name);
  }
  // A throw in the read (a Log column gone) and one in the table write both end released.
  const read = built();
  read.o.at = NOW + 60000;
  read.sheet("Log").set(1, HEADER.indexOf("User Token") + 1, "Renamed");
  read.ctx.refreshHoursNow();
  checkOneHold(read.calls, "read throws");
  assert.match(cellsOf(read)[2], /^failed-read\|menu\|/);
  const write = built();
  write.o.at = NOW + 60000;
  FAIL = (c) => c.sheet === "Hours data" && c.op === "setValues";
  write.ctx.refreshHoursNow();
  checkOneHold(write.calls, "write throws");
  assert.equal(cellsOf(write)[1], "stopped " + (NOW + 60000));
  assert.match(write.alerts[0], /^The refresh from the menu at .* failed part way: injected\./);
});

test("a busy document lock writes nothing: the menu says so, setupReports and nightly throw, open logs", () => {
  const busy = "Another refresh or setupReports is writing Hours. Try again in a minute.";
  const s = built();
  s.o.docBusy = true;
  const before = s.snapshot();
  s.ctx.refreshHoursNow();
  assert.deepEqual(s.alerts, [busy]);
  assert.throws(() => s.ctx.runHoursRefresh(TRIGGER), /writing Hours/);
  assert.equal(ENTRY.open(s).kind, "busy");
  assert.match(s.logs.join("\n"), /Hours refresh \(open\): busy/);
  assert.throws(() => s.ctx.setupReports(), /A refresh is writing Hours; run setupReports again/);
  assert.ok(!s.calls.some(isHoursWrite));
  assert.ok(!s.calls.some((c) => c.op === "docLock.release"));
  const after = s.snapshot();
  for (const name of ["Hours", "Hours data"]) {
    const one = (snap) => snap.sheets.find((x) => x.name === name);
    assert.deepEqual(one(after), one(before), name);
  }
});

test("a refresh writes exactly the steps hoursNextState lists, in order, one call each", () => {
  const later = NOW + 60000;
  const cases = [
    { name: "menu, same rows", entry: "menu" },
    { name: "menu, short tab", entry: "menu", prep: (s) => s.sheet("Hours data").deleteRows(2, 1) },
    {
      name: "menu, rows to trim",
      entry: "menu",
      prep: (s) => s.sheet("Hours data").insertRowsAfter(s.sheet("Hours data").maxRows, 5),
    },
    {
      name: "menu, no rows",
      entry: "menu",
      log: [HEADER],
      prep: (s) => s.sheet("Hours data").getRange("A2").setValue("old row"),
    },
    {
      name: "menu, newer table in",
      entry: "menu",
      prep: (s) =>
        s
          .sheet("Hours data")
          .getRange("L1")
          .setValue(String(NOW + 1e9)),
    },
    { name: "nightly", entry: "nightly" },
    { name: "open, unchanged", entry: "open" },
    {
      name: "open, no timing",
      entry: "open",
      prep: (s) => s.sheet("Hours data").getRange("O1").setValue(""),
    },
    {
      name: "open, killed write left behind",
      entry: "open",
      prep: (s) =>
        s
          .sheet("Hours data")
          .getRange("M1")
          .setValue("writing " + (NOW - 5)),
    },
    {
      name: "menu, read fails",
      entry: "menu",
      fails: true,
      prep: (s) => s.sheet("Log").set(1, HEADER.indexOf("User Token") + 1, "Renamed"),
    },
  ];
  for (const c of cases) {
    const s = built({}, c.log || LOG);
    if (c.prep) c.prep(s);
    s.o.at = later;
    s.calls.length = 0;
    const data = s.sheet("Hours data");
    const state = s.ctx.hoursState(cellsOf(s));
    let read = null;
    let message = null;
    try {
      read = s.ctx.readHoursTable_();
    } catch (err) {
      message = err.message;
    }
    assert.equal(Boolean(message), Boolean(c.fails), c.name);
    const rows = read ? read.table.rows.length : 0;
    const run = {
      cause: c.entry,
      t: later,
      w: later,
      mark: later,
      held: false,
      markWritten: false,
      digest: read ? read.digest : null,
      rows,
      budget: c.entry === "open" ? s.ctx.hoursBudget(0, state, rows) : null,
    };
    const next = plain(
      s.ctx.hoursNextState(state, run, message ? { kind: "failed", message } : { kind: "read" }),
    );
    const grows = data.maxRows < rows + 1;
    const trims = data.maxRows > Math.max(2, rows + 1);
    const expected = next.steps.flatMap((st) => {
      if (st.op === "grow") return grows ? [st] : [];
      if (st.op === "trim") return trims ? [st] : [];
      if (st.op === "values") return rows ? [st] : [];
      if (st.timing) return [{ op: "set", cell: "O1", value: "0|0|0|" + rows }];
      return [st];
    });
    s.calls.length = 0;
    const result = ENTRY[c.entry](s);
    assert.deepEqual(hoursOps(s.calls), expected, c.name);
    checkOneHold(s.calls, c.name);
    if (c.entry === "open") assert.equal(result.kind, next.decision, c.name);
    if (c.entry === "menu") {
      const b1 = s.sheet("Hours").get(1, 2);
      const newer =
        next.decision === "newer-in" ? "Another refresh already put in newer tables. " : "";
      assert.deepEqual(s.alerts, [newer + b1], c.name);
    }
    if (c.log) assert.equal(data.get(2, 1), "", c.name + ": the old row 2 is gone");
  }
});

test("B1 is written only by renderHoursLine_, always hoursLine of the cells, and every hold ends with a render and a flush", () => {
  const watch = (s) => {
    const render = s.ctx.renderHoursLine_;
    s.ctx.renderHoursLine_ = (tabs) => {
      s.calls.push({ op: "render-begin" });
      const line = render(tabs);
      s.calls.push({ op: "render-end" });
      if (tabs.hours) {
        assert.equal(line, s.ctx.hoursLine(s.ctx.hoursState(cellsOf(s)), s.ctx.hoursTime_));
      }
      return line;
    };
  };
  const check = (s, label) => {
    let inside = false;
    let lastHoursWrite = null;
    s.calls.forEach((c, i) => {
      if (c.op === "render-begin") inside = true;
      if (c.op === "render-end") inside = false;
      if (c.sheet === "Hours" && c.a1 === "B1" && c.op !== "breakApart") {
        assert.ok(inside, label + ": B1 written outside the render");
      }
      if (isHoursWrite(c)) lastHoursWrite = i;
    });
    const release = s.calls.findIndex((c) => c.op === "docLock.release");
    const last = s.calls[lastHoursWrite];
    assert.equal(last.a1, "B1", label + ": the hold's last write is the render");
    assert.ok(
      s.calls.slice(lastHoursWrite, release).some((c) => c.op === "flush"),
      label + ": a flush after it",
    );
  };
  const fresh = server(LOG, { now: NOW });
  watch(fresh);
  fresh.ctx.setupReports();
  check(fresh, "setupReports");
  for (const name of Object.keys(ENTRY)) {
    const s = built();
    watch(s);
    s.o.at = NOW + 60000;
    ENTRY[name](s);
    check(s, name);
  }
  const failing = built();
  watch(failing);
  failing.o.at = NOW + 60000;
  failing.sheet("Hours data").insertRowsAfter(failing.sheet("Hours data").maxRows, 3);
  failing.calls.length = 0;
  FAIL = (c) => c.sheet === "Hours data" && c.op === "deleteRows";
  failing.ctx.refreshHoursNow();
  check(failing, "a throw at the trim");
  assert.match(failing.sheet("Hours").get(1, 2), /stopped part way|failed part way/);
});

test("setupReports keeps Monthly Hours and throws when laying out Hours or writing the table fails", () => {
  const cases = [
    {
      name: "laying out Hours",
      fail: (c) => c.op === "batchUpdate" && c.value > 40,
      q1: "building " + NOW,
      b1: /^Hours is being set up by setupReports since 2026-11-13 9:14 AM; .* The refresh by setupReports at 2026-11-13 9:14 AM failed part way: injected\./,
    },
    {
      name: "writing the table",
      fail: (c) => c.sheet === "Hours data" && c.op === "setValues" && c.a1.startsWith("A2:"),
      q1: "built " + NOW,
      b1: /^The refresh by setupReports at 2026-11-13 9:14 AM failed part way: injected\. The tables may be incomplete/,
    },
  ];
  for (const c of cases) {
    const s = server(LOG, { now: NOW });
    s.ss.insertSheet("Monthly Hours").protect().setDescription("Monthly Hours tab: kiosk");
    s.calls.length = 0;
    FAIL = c.fail;
    assert.throws(
      () => s.ctx.setupReports(),
      /^Error: Hours was not filled \(.*\); Monthly Hours was kept\. Fix that and run setupReports again\.$/,
      c.name,
    );
    assert.ok(s.sheet("Monthly Hours"), c.name);
    const [, m1, n1, , , q1] = cellsOf(s);
    assert.equal(m1, "stopped " + NOW, c.name);
    assert.equal(q1, c.q1, c.name);
    assert.match(n1, new RegExp("^failed-write\\|setupReports\\|" + NOW + "\\|"), c.name);
    assert.match(s.sheet("Hours").get(1, 2), c.b1, c.name);
    checkOneHold(s.calls, c.name);
  }
});
