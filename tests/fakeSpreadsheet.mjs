// An in-memory stand-in for SpreadsheetApp and the advanced Sheets service, enough for the
// real setupSheets to run against: tabs with values, formulas, formats, validations, notes,
// protections and styles, and the spreadsheet's filter views, bandings, conditional format
// rules and developer metadata. setup.test.mjs and the setupSheets parity test use it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

export const OWNER = "owner@example.org";
// ---------------------------------------------------------------------------
// In-memory spreadsheet

export class FakeRange {
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
  // A formula is kept apart from the values; the cell's value stays as it was written.
  setFormula(formula) {
    assert.equal(this.rows * this.cols, 1, "setFormula on one cell");
    this.sheet.formulas.set(this.row + "," + this.col, formula);
    return this;
  }
  getFormula() {
    return this.sheet.formulas.get(this.row + "," + this.col) || "";
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
  each(fn) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) fn(this.row + r, this.col + c, r, c);
    }
  }
  clearContent() {
    this.each((r, c) => this.sheet.set(r, c, ""));
    return this;
  }
  getNotes() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(this.sheet.note(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setNote(note) {
    assert.equal(this.rows * this.cols, 1, "setNote on one cell");
    this.sheet.noteWrites.push([this.row, this.col, note]);
    const key = this.row + "," + this.col;
    if (note === "" || note === null) this.sheet.notes.delete(key);
    else this.sheet.notes.set(key, String(note));
    return this;
  }
  setNotes() {
    assert.fail("the kiosk writes header notes one changed cell at a time");
  }
  // The per-cell format arrays the How to tab sets, kept by format name.
  setStyles(name, values) {
    assert.equal(values.length, this.rows, name + " row count");
    this.each((r, c, i, j) => this.sheet.styles.set(name + " " + r + "," + c, values[i][j]));
    return this;
  }
  setFontWeights(v) {
    return this.setStyles("weight", v);
  }
  setFontSizes(v) {
    return this.setStyles("size", v);
  }
  setFontColors(v) {
    return this.setStyles("colour", v);
  }
  setBackgrounds(v) {
    return this.setStyles("background", v);
  }
  setFontStyles(v) {
    return this.setStyles("style", v);
  }
  setWrap(on) {
    this.sheet.wraps.set(this.a1(), on);
    return this;
  }
  a1() {
    return this.row + "," + this.col + "," + this.rows + "," + this.cols;
  }
  protect() {
    return this.sheet.addProtection("RANGE", this.a1());
  }
}

export class FakeProtection {
  constructor(sheet, type, where) {
    Object.assign(this, { sheet, type, where, description: "", warningOnly: false });
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
}

export class FakeSheet {
  constructor(name, maxRows = 1000, maxCols = 26, sheetId = 0) {
    this.name = name;
    this.sheetId = sheetId;
    this.values = new Map();
    // Formulas by "row,col"; writing a value to the cell removes its formula, as in Sheets.
    this.formulas = new Map();
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
    // Header notes by "row,col", and every setNote call in order.
    this.notes = new Map();
    this.noteWrites = [];
    this.protections = [];
    this.styles = new Map();
    this.wraps = new Map();
    this.colWidths = new Map();
    this.tabColorHex = null;
  }
  note(r, c) {
    return this.notes.has(r + "," + c) ? this.notes.get(r + "," + c) : "";
  }
  addProtection(type, where) {
    const p = new FakeProtection(this, type, where);
    this.protections.push(p);
    return p;
  }
  protect() {
    return this.addProtection("SHEET", "sheet");
  }
  getProtections(type) {
    assert.ok(type === "RANGE" || type === "SHEET", "a protection type: " + type);
    return this.protections.filter((p) => p.type === type);
  }
  clear() {
    this.values.clear();
    this.formulas.clear();
    this.formats.clear();
    this.styles.clear();
    this.wraps.clear();
  }
  insertRowsAfter(after, count) {
    assert.equal(after, this.maxRows, "rows are only added at the end");
    this.maxRows += count;
  }
  setColumnWidth(col, px) {
    this.colWidths.set(col, px);
  }
  setTabColor(hex) {
    this.tabColorHex = hex;
  }
  addDeveloperMetadata(key, value) {
    this.ss.metadata.push({ key, value, sheet: this });
  }
  get(r, c) {
    return this.values.has(r + "," + c) ? this.values.get(r + "," + c) : "";
  }
  set(r, c, v) {
    assert.ok(r <= this.maxRows && c <= this.maxCols, "write outside the sheet at " + r + "," + c);
    this.formulas.delete(r + "," + c);
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
      // Only column A1 ranges such as "A:B" or "C2:C" are used.
      const m = /^([A-Z])(\d*):([A-Z])$/.exec(row);
      assert.ok(m, "an A1 range the stand-in knows: " + row);
      const a = m[1].charCodeAt(0) - 64;
      const b = m[3].charCodeAt(0) - 64;
      const top = m[2] ? Number(m[2]) : 1;
      return new FakeRange(this, top, a, this.maxRows - top + 1, b - a + 1);
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
  /** Every cell's value and formula go; formats and notes stay, as in Sheets. */
  clearContents() {
    this.values.clear();
    this.formulas.clear();
    return this;
  }
  row(r) {
    return this.getRange(r, 1, 1, Math.max(this.getLastColumn(), 1)).getValues()[0];
  }
  snapshot() {
    return {
      name: this.name,
      values: [...this.values.entries()].sort(),
      formulas: [...this.formulas.entries()].sort(),
      formats: [...this.formats.entries()].sort(),
      validations: [...this.validations.entries()].sort(),
      maxCols: this.maxCols,
      frozen: this.frozen,
      cellLook: [...this.cellLook.entries()].sort(),
      dims: [...this.dims.entries()].sort(),
      tabColor: this.tabColor,
      notes: [...this.notes.entries()].sort(),
      protections: this.protections.map((p) => [p.type, p.where, p.description, p.warningOnly]),
      styles: [...this.styles.entries()].sort(),
      wraps: [...this.wraps.entries()].sort(),
      colWidths: [...this.colWidths.entries()].sort(),
      tabColorHex: this.tabColorHex,
    };
  }
}

export class FakeSpreadsheet {
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
    // Developer metadata on sheets, as {key, value, sheet}.
    this.metadata = [];
  }
  getId() {
    return "file-1";
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name, index) {
    // Sheets refuses a name that differs from a tab's only in capitals.
    assert.ok(
      !this.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()),
      "a tab named " + name + " already exists",
    );
    const sheet = new FakeSheet(name, 1000, 26, this.nextSheetId++);
    sheet.ss = this;
    if (index === undefined) this.sheets.push(sheet);
    else this.sheets.splice(index, 0, sheet);
    return sheet;
  }
  getSheets() {
    return [...this.sheets];
  }
  deleteSheet(sheet) {
    this.sheets = this.sheets.filter((s) => s !== sheet);
    this.metadata = this.metadata.filter((m) => m.sheet !== sheet);
  }
  moveSheet(sheet, index) {
    this.sheets = this.sheets.filter((s) => s !== sheet);
    this.sheets.splice(index, 0, sheet);
  }
  createDeveloperMetadataFinder() {
    const ss = this;
    let key = null;
    const finder = {
      withKey: (k) => ((key = k), finder),
      find: () =>
        ss.metadata
          .filter((m) => m.key === key)
          .map((m) => ({
            getKey: () => m.key,
            getValue: () => m.value,
            getLocation: () => ({ getSheet: () => m.sheet }),
          })),
    };
    return finder;
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
      metadata: this.metadata.map((m) => [m.key, m.value, m.sheet.sheetId]),
    };
  }
}

/** True when two GridRanges share a cell; a missing end runs to the tab's edge. */
export function overlaps(a, b) {
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
export function sheetsService(ss, opts = {}) {
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
 * opts.failOn is passed to sheetsService. opts.cache is the script cache, a Map of key
 * to value (a new one by default); opts.props the script properties, also a Map (new by
 * default); opts.onFlush runs on each SpreadsheetApp.flush;
 * opts.errors collects what the server logs with console.error. opts.code is a list of
 * server sources to load in order in place of this tree's Brand.js, Logic.js and Sheets.js
 * (another revision's, say).
 */
export function server(ss, opts = {}) {
  const cache = opts.cache || new Map();
  const props = opts.props || new Map();
  const checkbox = () => {
    const rule = {};
    const b = {
      requireCheckbox: () => ((rule.checkbox = true), b),
      build: () => rule,
    };
    return b;
  };
  const ctx = {
    console: {
      log: () => {},
      error: (...args) => (opts.errors || []).push(args.join(" ")),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => void cache.set(k, v),
      }),
    },
    // Script properties, where Log writes put the Log changed stamp.
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => void props.set(k, String(v)),
        deleteProperty: (k) => void props.delete(k),
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newDataValidation: checkbox,
      ProtectionType: { RANGE: "RANGE", SHEET: "SHEET" },
      flush: () => (opts.onFlush ? opts.onFlush() : undefined),
    },
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
  if (opts.code) {
    for (const code of opts.code) vm.runInContext(code, ctx);
  } else {
    vm.runInContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), ctx);
    vm.runInContext(read("apps-script/Sheets.js"), ctx);
  }
  return ctx;
}

export function sheetWith(ss, name, rows, maxCols = 26) {
  const sheet = new FakeSheet(name, 1000, maxCols, ss.nextSheetId++);
  sheet.ss = ss;
  rows.forEach((line, r) => line.forEach((v, c) => sheet.set(r + 1, c + 1, v)));
  ss.sheets.push(sheet);
  return sheet;
}

// ---------------------------------------------------------------------------
// A whole spreadsheet as JSON and back, so a sheet one revision's setupSheets made can be
// kept as a file and set up again by another.

const SHEET_MAPS = [
  "values",
  "formulas",
  "formats",
  "validations",
  "cellLook",
  "dims",
  "notes",
  "styles",
  "wraps",
  "colWidths",
];
const SHEET_FIELDS = ["name", "sheetId", "maxRows", "maxCols", "frozen", "tabColor", "tabColorHex"];
const SS_MAPS = ["views", "bandings", "rules"];
const SS_FIELDS = ["timeZone", "nextSheetId", "nextViewId", "nextBandingId"];

// Number formats are kept as runs, [column, format, first row, last row], since a format
// set on a whole column is one entry per cell.
function formatRuns(formats) {
  const cells = [...formats.entries()]
    .map(([k, f]) => [...k.split(",").map(Number), f])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const runs = [];
  for (const [r, c, f] of cells) {
    const last = runs[runs.length - 1];
    if (last && last[0] === c && last[1] === f && last[3] === r - 1) last[3] = r;
    else runs.push([c, f, r, r]);
  }
  return runs;
}
function formatCells(runs) {
  const cells = new Map();
  for (const [c, f, from, to] of runs) for (let r = from; r <= to; r++) cells.set(r + "," + c, f);
  return cells;
}

// A cell's Date is kept as {date: ISO}; JSON would turn it into a plain string.
const cellOut = (v) => (v instanceof Date ? { date: v.toISOString() } : v);
const cellIn = (v) => (v && typeof v === "object" && "date" in v ? new Date(v.date) : v);

/** Everything a FakeSpreadsheet holds, as plain JSON. */
export function dumpSpreadsheet(ss) {
  const out = { metadata: ss.metadata.map((m) => [m.key, m.value, m.sheet.sheetId]) };
  for (const f of SS_FIELDS) out[f] = ss[f];
  for (const f of SS_MAPS) out[f] = plain([...ss[f].entries()]);
  out.sheets = ss.sheets.map((s) => {
    const sheet = {
      protections: s.protections.map((p) => [p.type, p.where, p.description, p.warningOnly]),
    };
    for (const f of SHEET_FIELDS) sheet[f] = s[f];
    for (const f of SHEET_MAPS) {
      const entries = [...s[f].entries()];
      if (f === "values") sheet[f] = entries.map(([k, v]) => [k, cellOut(v)]);
      else if (f === "formats") sheet[f] = formatRuns(s[f]);
      else sheet[f] = plain(entries);
    }
    return sheet;
  });
  return out;
}

/** The FakeSpreadsheet dumpSpreadsheet gave this JSON for. */
export function restoreSpreadsheet(json) {
  const ss = new FakeSpreadsheet();
  for (const f of SS_FIELDS) ss[f] = json[f];
  for (const f of SS_MAPS) ss[f] = new Map(plain(json[f]));
  ss.sheets = json.sheets.map((d) => {
    const s = new FakeSheet(d.name, d.maxRows, d.maxCols, d.sheetId);
    s.ss = ss;
    for (const f of SHEET_FIELDS) s[f] = d[f];
    for (const f of SHEET_MAPS) {
      if (f === "values") s[f] = new Map(d[f].map(([k, v]) => [k, cellIn(v)]));
      else if (f === "formats") s[f] = formatCells(d[f]);
      else s[f] = new Map(plain(d[f]));
    }
    s.protections = d.protections.map(([type, where, description, warningOnly]) =>
      Object.assign(new FakeProtection(s, type, where), { description, warningOnly }),
    );
    return s;
  });
  ss.metadata = json.metadata.map(([key, value, sheetId]) => ({
    key,
    value,
    sheet: ss.sheets.find((s) => s.sheetId === sheetId),
  }));
  return ss;
}

/**
 * The Kiosk admin menu onOpen builds on the server ctx's spreadsheet, as [label, function]
 * pairs. adminCode is an Admin.js source; the Hours note onOpen makes after the menu is
 * left out, since only the menu is looked at.
 */
export function menuOf(ctx, adminCode) {
  const items = [];
  const menu = {
    addItem: (label, fn) => (items.push([label, fn]), menu),
    addToUi: () => {},
  };
  ctx.SpreadsheetApp.getUi = () => ({ createMenu: () => menu });
  vm.runInContext(adminCode, ctx);
  vm.runInContext(
    "function hoursHold_() { return null; }\n" +
      "function noteHoursOnOpen_() {}\n" +
      "function releaseHoursLock_() {}",
    ctx,
  );
  ctx.onOpen();
  return items;
}
