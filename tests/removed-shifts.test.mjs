// Tests for Remove a shift… and Restore a shift…: the pure rules in apps-script/Logic.js
// ("Removed shifts"), and the glue in apps-script/Admin.js and Sheets.js run against an
// in-memory spreadsheet. The server files are loaded into one global scope, as Apps Script
// loads them. The stand-in here has what these two items need that the one in
// tests/admin.test.mjs lacks: insertSheet, deleteRow, protect and per-row number formats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SERVER_FILES = ["Logic.js", "Sheets.js", "Api.js", "Admin.js"].map((f) => [
  f,
  read("apps-script/" + f),
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
const clock = (ms) => {
  const p = centralParts(ms);
  const h = +p.hour;
  return (h % 12 || 12) + ":" + p.minute + " " + (h < 12 ? "AM" : "PM");
};
/** "yyyy-MM-dd HH:mm" Central to a Date. */
const at = (date, hhmm) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let ms = want + 6 * 3600000;
  for (let i = 0; i < 2; i++) {
    const p = centralParts(ms);
    ms += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(ms);
};

// ---------------------------------------------------------------------------
// The stand-in

/**
 * A sheet held as rows of cells with a number format per cell; row and column numbers are
 * 1-based. A range past the last grid row or column throws, as in Sheets. journal (shared
 * across the spreadsheet) gets "write <tab> <what>" for each write and "flush" for each
 * flush. afterFlush, when set, runs on each flush, so a test can change a cell between a
 * write and the read after it.
 */
class FakeSheet {
  constructor(name, rows, journal, maxRows = 1000, maxCols = 26) {
    this.name = name;
    this.rows = rows.map((r) => r.slice());
    this.fmt = rows.map((r) => r.map(() => ""));
    this.maxRows = maxRows;
    this.maxCols = maxCols;
    this.frozen = 0;
    this.protections = [];
    this.journal = journal;
  }
  note(what) {
    this.journal.push("write " + this.name + " " + what);
  }
  lastRow() {
    let last = this.rows.length;
    while (last > 0 && (this.rows[last - 1] || []).every((v) => v === "")) last--;
    return last;
  }
  getLastRow() {
    return this.lastRow();
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach((r) => r.forEach((v, i) => v !== "" && (last = Math.max(last, i + 1))));
    return last;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.lastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  getMaxColumns() {
    return this.maxCols;
  }
  insertRowsAfter(after, count) {
    assert.equal(after, this.maxRows);
    this.note("insertRowsAfter " + after + "," + count);
    this.maxRows += count;
  }
  insertColumnsAfter(after, count) {
    assert.equal(after, this.maxCols);
    this.maxCols += count;
  }
  deleteRow(row) {
    this.note("deleteRow " + row);
    this.rows.splice(row - 1, 1);
    this.fmt.splice(row - 1, 1);
    this.maxRows--;
  }
  setFrozenRows(n) {
    this.frozen = n;
  }
  protect() {
    const p = {
      description: "",
      warningOnly: false,
      setDescription: (d) => ((p.description = d), p),
      setWarningOnly: (w) => ((p.warningOnly = w), p),
    };
    this.protections.push(p);
    return p;
  }
  cell(row, col) {
    return (this.rows[row - 1] || [])[col - 1] ?? "";
  }
  format(row, col) {
    return (this.fmt[row - 1] || [])[col - 1] ?? "";
  }
  put(row, col, value, format) {
    assert.ok(row <= this.maxRows && col <= this.maxCols, "write outside the grid");
    while (this.rows.length < row) this.rows.push([]);
    while (this.fmt.length < row) this.fmt.push([]);
    const r = this.rows[row - 1];
    const f = this.fmt[row - 1];
    while (r.length < col) r.push("");
    while (f.length < col) f.push("");
    if (value !== undefined) r[col - 1] = value;
    if (format !== undefined) f[col - 1] = format;
  }
  getRange(row, col, rows = 1, cols = 1) {
    assert.ok(rows >= 1 && cols >= 1, "empty range");
    if (row + rows - 1 > this.maxRows || col + cols - 1 > this.maxCols) {
      throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
    }
    const sheet = this;
    const where = [row, col, rows, cols].join(",");
    const grid = (get) =>
      Array.from({ length: rows }, (_, i) =>
        Array.from({ length: cols }, (_, j) => get(row + i, col + j)),
      );
    const each = (lines, set) => {
      assert.equal(lines.length, rows);
      lines.forEach((line, i) => {
        assert.equal(line.length, cols);
        line.forEach((v, j) => set(row + i, col + j, v));
      });
    };
    const range = {
      getValues: () => grid((r, c) => sheet.cell(r, c)),
      getNumberFormats: () => grid((r, c) => sheet.format(r, c)),
      setValues: (lines) => {
        sheet.note("setValues " + where);
        each(lines, (r, c, v) => sheet.put(r, c, v));
        return range;
      },
      setNumberFormats: (lines) => {
        sheet.note("setNumberFormats " + where);
        each(lines, (r, c, f) => sheet.put(r, c, undefined, f));
        return range;
      },
      setNumberFormat: (f) => {
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) sheet.put(row + i, col + j, undefined, f);
        return range;
      },
      setValue: (v) => {
        sheet.note("setValue " + where);
        sheet.put(row, col, v);
        return range;
      },
    };
    return range;
  }
  /** One row as {header with spaces for line breaks: value}. */
  byHeader(row) {
    const out = {};
    (this.rows[0] || []).forEach((h, i) => {
      if (h) out[String(h).replace(/\s+/g, " ")] = this.cell(row, i + 1);
    });
    return out;
  }
}

const KEY = "good";
/** The writes in a server's journal; the lock's closing flush isn't one. */
const writes = (s) => s.journal.filter((j) => j !== "flush");

/**
 * A fresh server scope with a Log, a Flags tab and Settings, and the given dialog key
 * issued. opts: log, flags (null for no Flags tab), removed (rows of an existing Removed
 * shifts tab), volunteers (the cached Profiles list), now (ms).
 */
function server(opts = {}) {
  const journal = [];
  const errors = [];
  const cache = new Map();
  const props = new Map();
  const tabs = {};
  const add = (name, rows) => (tabs[name] = new FakeSheet(name, rows, journal));
  add("Log", opts.log || [LOG_HEADER]);
  if (opts.flags !== null) add("Flags", opts.flags || [FLAG_HEADER]);
  add("Settings", [
    ["Setting", "Value"],
    ["Volunteer Profiles file ID", "file-1"],
    ["Volunteer Profiles tab", "Volunteer Profiles"],
  ]);
  if (opts.removed) add("Removed shifts", opts.removed);
  let afterFlush = null;
  const ctx = {
    console: { log: () => {}, error: (...a) => errors.push(a.join(" ")) },
    Session: {
      getActiveUser: () => ({ getEmail: () => "staff@example.org" }),
      getEffectiveUser: () => ({ getEmail: () => "staff@example.org" }),
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
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => tabs[name] || null,
        insertSheet: (name) => {
          journal.push("insertSheet " + name);
          return add(name, []);
        },
      }),
      flush: () => {
        journal.push("flush");
        if (afterFlush) afterFlush();
      },
    },
    Utilities: {
      getUuid: () => "uuid",
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "h:mm a") return clock(date.getTime());
        if (format === "yyyy-MM-dd") return centralDate(date.getTime());
        if (format === "HH:mm") {
          const p = centralParts(date.getTime());
          return p.hour + ":" + p.minute;
        }
        throw new Error("format " + format);
      },
      parseDate: (text) => {
        const [d, t] = text.split(" ");
        return at(d, t);
      },
    },
  };
  vm.createContext(ctx);
  if (opts.now !== undefined) {
    const RealDate = vm.runInContext("Date", ctx);
    ctx.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [opts.now]));
      }
      static now() {
        return opts.now;
      }
    };
  }
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  stubLogCheck(ctx);
  cache.set(ctx.adminKeyCacheKey(KEY), "1");
  if (opts.volunteers) {
    cache.set(
      ctx.profilesCacheKey("file-1", "Volunteer Profiles"),
      JSON.stringify(opts.volunteers),
    );
  }
  return {
    ctx,
    tabs,
    journal,
    errors,
    props,
    onFlush: (fn) => (afterFlush = fn),
  };
}

/**
 * The Log check's Source and its "Shift ID on more than one row" label come from the Log
 * check's own section of Logic.js. Until a branch has that section, these stand in for the
 * two names Remove uses; once it has, the real ones are used.
 */
function stubLogCheck(ctx) {
  if (typeof ctx.logCheckReasons !== "function") {
    ctx.logCheckReasons = () => ({ "duplicate-id": "Shift ID on more than one row" });
  }
  const sources = ctx.flagSources;
  if (!sources().logCheck) ctx.flagSources = () => ({ ...sources(), logCheck: "log check" });
}

// ---------------------------------------------------------------------------
// Fixtures

const LOG_HEADER = [
  "Shift ID",
  "User Token",
  "Status",
  "Date",
  "Day",
  "Volunteer\nName",
  "Notes",
  "Staff column",
  "Check-In\nRecorded\n(timestamp)",
  "Check-In\nStated\n(user)",
  "Check-Out\nRecorded\n(timestamp)",
  "Check-Out\nStated (user)",
  "Hours Served\n(timestamps)",
  "Hours Served\n(stated)",
  "Admin\nAlerts?",
  "Check-In\nEntered By",
  "Check-Out\nEntered By",
];
const FLAG_HEADER = [
  "Shift ID",
  "Date",
  "Volunteer Name",
  "Reason",
  "Raised At",
  "Reviewed",
  "Reviewed By",
  "Notes",
  "Source",
  "Log Row",
];
const logRow = (byHeader) =>
  LOG_HEADER.map((h) => {
    const key = h.replace(/\s+/g, " ");
    return key in byHeader ? byHeader[key] : "";
  });
const DAY = "2026-06-01";
const closed = (shiftId, name = "Sam Lee", token = "tok-sam", extra = {}) =>
  logRow({
    "Shift ID": shiftId,
    "User Token": token,
    Status: "closed",
    Date: DAY,
    Day: "Monday",
    "Volunteer Name": name,
    Notes: "typed by staff",
    "Staff column": "staff's own",
    "Check-In Recorded (timestamp)": at(DAY, "09:00"),
    "Check-In Stated (user)": at(DAY, "09:00"),
    "Check-Out Recorded (timestamp)": at(DAY, "12:00"),
    "Check-Out Stated (user)": at(DAY, "12:00"),
    "Hours Served (timestamps)": 3,
    "Hours Served (stated)": 3,
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": "kiosk",
    ...extra,
  });
const flag = (shiftId, reason, logRowNumber, extra = {}) =>
  FLAG_HEADER.map(
    (h) =>
      ({
        "Shift ID": shiftId,
        Date: DAY,
        "Volunteer Name": "Sam Lee",
        Reason: reason,
        "Raised At": at(DAY, "12:00"),
        Reviewed: false,
        Source: "kiosk check-out",
        "Log Row": logRowNumber,
        ...extra,
      })[h] ?? "",
  );
const SAM = {
  id: "aaaaaaaaaaaaaaaa",
  firstName: "Sam",
  lastName: "Lee",
  phoneLast4: "0131",
  startDate: "2026-01-15",
  needsPhoneCheck: false,
  token: "tok-sam",
  row: 4,
};
const NOW = at("2026-06-03", "10:15").getTime();

// ---------------------------------------------------------------------------
// The pure rules

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);
stubLogCheck(L);
const X = ["Removed by", "Removed at", "Removed reason"];

test("the Removed tab's name, extra headers and protection text", () => {
  assert.equal(L.removedTabName(), "Removed shifts");
  assert.deepEqual(plain(L.removedExtraHeaders()), {
    by: "Removed by",
    at: "Removed at",
    reason: "Removed reason",
  });
  assert.match(L.removedProtectionDescription(), /^Removed shifts: .*Restore a shift…/);
  assert.equal(L.isRemovedExtraHeader("  removed\nBY "), true);
  assert.equal(L.isRemovedExtraHeader("Notes"), false);
});

test("removedHeaderWrites: a new tab copies the Log header, blanks included, then the extras", () => {
  assert.deepEqual(plain(L.removedHeaderWrites(["Shift ID", "", "Date", "", ""], [])), [
    { col: 1, header: "Shift ID" },
    { col: 2, header: "" },
    { col: 3, header: "Date" },
    { col: 4, header: "Removed by" },
    { col: 5, header: "Removed at" },
    { col: 6, header: "Removed reason" },
  ]);
  // A tab with a header gets only what it lacks, right of its last header, once each.
  const removed = ["Shift ID", "Date", ...X, ""];
  assert.deepEqual(
    plain(
      L.removedHeaderWrites(["Shift ID", "NEW  one", "Date", "new one", "Removed by"], removed),
    ),
    [{ col: 6, header: "NEW  one" }],
  );
  assert.deepEqual(plain(L.removedHeaderWrites(["Shift ID", "Date"], removed)), []);
  // An extra staff deleted comes back.
  assert.deepEqual(plain(L.removedHeaderWrites(["Shift ID"], ["Shift ID", "Removed by"])), [
    { col: 3, header: "Removed at" },
    { col: 4, header: "Removed reason" },
  ]);
});

test("headerMapCopy maps by header, leftmost first, and leaves unmatched cells null", () => {
  const out = L.headerMapCopy(["A", "b", "C", "a"], [1, 2, 3, 4], ["c", "", "a", "D", "A", "B"], 7);
  assert.deepEqual(plain(out), [3, null, 1, null, null, 2, null]);
});

test("removeHeaderProblem names a value under a blank, repeated or extra-named header", () => {
  const header = ["Shift ID", "", "Notes", "Notes", "Removed at", "Staff"];
  assert.equal(L.removeHeaderProblem(header, ["s", "", "", "", "", "x"]), "");
  assert.equal(L.removeHeaderProblem(header, ["s", "x", "", "", "", ""]), "B (no header)");
  assert.equal(L.removeHeaderProblem(header, ["s", "", "", "x", "", ""]), "Notes");
  assert.equal(L.removeHeaderProblem(header, ["s", "", "", "", "x", ""]), "Removed at");
  // A value past the header's last column is under a blank header.
  assert.equal(L.removeHeaderProblem(["Shift ID"], ["s", "x"]), "B (no header)");
});

test("restoreHeaderProblem names a value the Log can't take back; the extras are skipped", () => {
  const removed = ["Shift ID", "Gone\ncolumn", "Notes", ...X];
  const log = ["Shift ID", "Notes", "Twice", "Twice"];
  assert.equal(L.restoreHeaderProblem(removed, ["s", "", "n", "JP", "t", "why"], log), "");
  assert.equal(
    L.restoreHeaderProblem(removed, ["s", "x", "", "JP", "t", "why"], log),
    "Gone column",
  );
  assert.equal(
    L.restoreHeaderProblem(["Shift ID", "Twice"], ["s", "x"], log),
    "Twice",
    "a header the Log has twice",
  );
  assert.equal(L.restoreHeaderProblem(["Shift ID", ""], ["s", "x"], log), "B (no header)");
});

test("decideRemove checks in order and picks the row", () => {
  const H = ["Shift ID", "Date"];
  const one = [{ row: 7, values: ["s-1", DAY], entry: {} }];
  const base = {
    candidates: one,
    shiftId: "s-1",
    row: 5,
    reason: "typed twice",
    initials: "jp",
    logHeader: H,
  };
  const code = (input) => L.decideRemove({ ...base, ...input }).refusal;
  assert.equal(code({ initials: "1" }), "ADMIN_INITIALS");
  assert.equal(code({ initials: "1", reason: "" }), "ADMIN_INITIALS");
  assert.equal(code({ reason: "  " }), "ADMIN_REMOVE_REASON");
  assert.equal(code({ reason: "x".repeat(501) }), "ADMIN_NOTE_TOO_LONG");
  assert.equal(code({ shiftId: " " }), "ADMIN_REMOVE_NO_ID");
  assert.equal(code({ candidates: [] }), "ADMIN_REMOVE_NOT_FOUND");
  // One row with the Shift ID: that row, wherever it has moved.
  const ok = L.decideRemove(base);
  assert.equal(ok.target.row, 7);
  assert.equal(ok.initials, "JP");
  assert.equal(ok.reason, "typed twice");
  assert.equal(ok.remaining, 0);
  // Two rows: the one at row, else MOVED.
  const two = [one[0], { row: 9, values: ["s-1", DAY], entry: {} }];
  assert.equal(L.decideRemove({ ...base, candidates: two, row: 9 }).target.row, 9);
  assert.equal(L.decideRemove({ ...base, candidates: two, row: 9 }).remaining, 1);
  assert.equal(code({ candidates: two, row: 8 }), "ADMIN_REMOVE_MOVED");
  const headers = L.decideRemove({ ...base, candidates: [{ row: 7, values: ["s-1", DAY, "x"] }] });
  assert.deepEqual(plain(headers), { refusal: "ADMIN_REMOVE_HEADERS", header: "C (no header)" });
});

test("decideRestore checks in order", () => {
  const entry = { status: "open", token: "tok-sam" };
  const candidates = [{ row: 3, values: ["s-1", "JP"], entry }];
  const base = {
    candidates,
    shiftId: "s-1",
    row: 3,
    initials: "JP",
    logShiftIds: ["s-0", ""],
    tokenEntries: [],
    removedHeader: ["Shift ID", "Removed by"],
    logHeader: ["Shift ID"],
  };
  const code = (input) => L.decideRestore({ ...base, ...input }).refusal;
  assert.equal(code({ initials: "" }), "ADMIN_INITIALS");
  assert.equal(code({ candidates: [] }), "ADMIN_RESTORE_NOT_FOUND");
  assert.equal(code({ shiftId: "" }), "ADMIN_RESTORE_NOT_FOUND");
  assert.equal(
    code({ candidates: [...candidates, { row: 4, values: [], entry }], row: 5 }),
    "ADMIN_RESTORE_MOVED",
  );
  assert.equal(code({ logShiftIds: ["s-0", " s-1 "] }), "ADMIN_RESTORE_IN_LOG");
  const open = { status: "open", token: "tok-sam" };
  assert.equal(code({ tokenEntries: [open] }), "ADMIN_RESTORE_OPEN_SHIFT");
  // A closed row comes back beside an open one.
  const closedEntry = { status: "closed", token: "tok-sam" };
  assert.equal(
    code({ candidates: [{ row: 3, values: ["s-1"], entry: closedEntry }], tokenEntries: [open] }),
    undefined,
  );
  assert.deepEqual(plain(L.decideRestore({ ...base, logHeader: ["Date"] })), {
    refusal: "ADMIN_RESTORE_HEADERS",
    header: "Shift ID",
  });
  assert.equal(L.decideRestore(base).target.row, 3);
});

test("removeFlagMatches ticks only the removed row's flags while the Shift ID is still on the Log", () => {
  const only = (remaining) => ({ row: 7, date: DAY, name: "Sam Lee", remaining });
  const own = { date: DAY, name: "sam  LEE", reason: "x", source: "kiosk check-out", logRow: 7 };
  const other = { ...own, logRow: 9 };
  const dup = {
    date: DAY,
    name: "Sam Lee",
    reason: "Shift ID on more than one row: rows 7, 9",
    source: "log check",
    logRow: 7,
  };
  // No other row has the Shift ID: every flag was the removed row's.
  for (const f of [own, other, dup]) assert.equal(L.removeFlagMatches(f, only(0)), true);
  assert.equal(L.removeFlagMatches(other, null), true);
  // One row left: the row's own flags, and the pair's duplicate flag.
  assert.equal(L.removeFlagMatches(own, only(1)), true);
  assert.equal(L.removeFlagMatches(other, only(1)), false);
  assert.equal(L.removeFlagMatches({ ...own, date: "2026-06-02" }, only(1)), false);
  assert.equal(L.removeFlagMatches({ ...own, name: "Ruth" }, only(1)), false);
  assert.equal(L.removeFlagMatches({ ...own, logRow: "" }, { ...only(1), row: 0 }), false);
  assert.equal(L.removeFlagMatches({ ...dup, logRow: 9 }, only(1)), true);
  // Two left: the pair isn't gone, so its flag stays.
  assert.equal(L.removeFlagMatches({ ...dup, logRow: 9 }, only(2)), false);
  assert.equal(L.removeFlagMatches({ ...dup, logRow: 9, source: "import" }, only(1)), false);
});

test("shiftChoiceLabel gives a one-line label and the row's detail", () => {
  const entry = {
    row: 4,
    shiftId: "s-1",
    name: "Sam Lee",
    dateText: DAY,
    status: "closed",
    statedInMs: at(DAY, "09:00").getTime(),
    recordedInMs: at(DAY, "09:02").getTime(),
    statedOutMs: at(DAY, "12:00").getTime(),
    recordedOutMs: NaN,
    statedHours: 3,
    recordedHours: NaN,
    alerts: "",
    notes: "n",
    inBy: "kiosk",
    outBy: "JP",
  };
  const shown = plain(L.shiftChoiceLabel(entry, clock));
  assert.equal(shown.label, "Mon 2026-06-01 · Sam Lee · in 9:00 AM · closed");
  assert.equal(
    shown.detail,
    [
      "Date: 2026-06-01",
      "Volunteer: Sam Lee",
      "Status: closed",
      "Check-in: stated 9:00 AM, recorded 9:02 AM",
      "Check-out: stated 12:00 PM, recorded blank or unreadable",
      "Hours: stated 3.00, timestamps blank",
      "Entered by: in kiosk, out JP",
      "Admin Alerts?: none",
      "Notes: n",
      "Shift ID: s-1",
    ].join("\n"),
  );
  const removed = L.shiftChoiceLabel(
    {
      ...entry,
      removedBy: "JP",
      removedAtDate: "2026-06-03",
      removedAtMs: at("2026-06-03", "10:15").getTime(),
      removedReason: "typed twice",
    },
    clock,
  );
  assert.match(
    removed.detail,
    /\nRemoved by: JP, at 2026-06-03 10:15 AM\nRemoved reason: typed twice$/,
  );
  assert.equal(
    L.shiftChoiceLabel({}, clock).label,
    "no date · no name · check-in unreadable · no status",
  );
});

test("the notes Remove and Restore add to Flags rows", () => {
  assert.equal(
    L.removeFlagNote("JP", "typed twice", "2026-06-03"),
    "Log row removed by JP on 2026-06-03: typed twice",
  );
  assert.equal(L.restoreFlagNote("JP", "2026-06-03"), "Log row restored by JP on 2026-06-03.");
});

// ---------------------------------------------------------------------------
// The glue

const REMOVE = { shiftId: "s-2", row: 3, reason: "typed twice", initials: "j.p." };

function removeSetup() {
  const s = server({
    now: NOW,
    log: [
      LOG_HEADER,
      closed("s-1"),
      closed("s-2", "Sam Lee"),
      closed("s-3", "Ruth Okafor", "tok-ruth"),
    ],
    flags: [
      FLAG_HEADER,
      flag("s-2", "long shift", 3),
      flag("s-1", "other row", 2),
      flag("s-2", "late", 3, { "Reviewed By": "KB", Notes: "seen" }),
    ],
  });
  s.tabs.Log.put(3, 9, undefined, "yyyy-mm-dd h:mm am/pm");
  s.tabs.Log.put(3, 8, undefined, "0.0");
  return s;
}

test("adminRemoveShift moves the row to a new Removed shifts tab and ticks its flags", () => {
  const s = removeSetup();
  const original = s.tabs.Log.rows[2].slice();
  const reply = plain(s.ctx.adminRemoveShift(KEY, REMOVE));
  assert.deepEqual(reply, {
    ok: true,
    name: "Sam Lee",
    date: DAY,
    flagsMarked: 2,
    flagsLeft: 0,
    flagsFailed: false,
  });
  // The tab: the Log's header, then the three extras; row 1 frozen; one warning-only protection.
  const removed = s.tabs["Removed shifts"];
  assert.deepEqual(removed.rows[0], [...LOG_HEADER, ...X]);
  assert.equal(removed.frozen, 1);
  assert.equal(removed.protections.length, 1);
  assert.equal(removed.protections[0].warningOnly, true);
  assert.equal(
    removed.protections[0].description,
    "Removed shifts: rows removed from the Log. Use Kiosk admin > Restore a shift… to put one back.",
  );
  // The row: every Log cell under its header, staff's column and formats included.
  assert.deepEqual(removed.rows[1].slice(0, LOG_HEADER.length), original);
  assert.equal(removed.format(2, 9), "yyyy-mm-dd h:mm am/pm");
  assert.equal(removed.format(2, 8), "0.0");
  const byHeader = removed.byHeader(2);
  assert.equal(byHeader["Removed by"], "JP");
  assert.equal(byHeader["Removed at"].getTime(), NOW);
  assert.equal(removed.format(2, LOG_HEADER.length + 2), "yyyy-mm-dd h:mm am/pm");
  assert.equal(byHeader["Removed reason"], "typed twice");
  // The Log loses the row; the rows below move up.
  assert.deepEqual(
    s.tabs.Log.rows.slice(1).map((r) => r[0]),
    ["s-1", "s-3"],
  );
  // The Flags rows of s-2 are ticked; Reviewed By is set only where blank; the note is added.
  const flags = s.tabs.Flags;
  assert.deepEqual(flags.byHeader(2).Reviewed, true);
  assert.equal(flags.byHeader(2)["Reviewed By"], "JP");
  assert.equal(flags.byHeader(2).Notes, "Log row removed by JP on 2026-06-03: typed twice");
  assert.equal(flags.byHeader(3).Reviewed, false);
  assert.equal(flags.byHeader(3).Notes, "");
  assert.equal(flags.byHeader(4).Reviewed, true);
  assert.equal(flags.byHeader(4)["Reviewed By"], "KB");
  assert.equal(flags.byHeader(4).Notes, "seen; Log row removed by JP on 2026-06-03: typed twice");
  // Order: the Removed row is written and flushed before the Log row is deleted.
  const order = s.journal.filter((j) => /insertSheet|setValues 2,|flush|deleteRow/.test(j));
  assert.deepEqual(order.slice(0, 4), [
    "insertSheet Removed shifts",
    "write Removed shifts setValues 2,1,1,20",
    "flush",
    "write Log deleteRow 3",
  ]);
});

test("adminRestoreShift puts the row back at the Log's end; a second Restore is refused", () => {
  const s = removeSetup();
  const original = s.tabs.Log.rows[2].slice();
  s.ctx.adminRemoveShift(KEY, REMOVE);
  const list = plain(s.ctx.adminRemovedShifts(KEY));
  assert.equal(list.shifts.length, 1);
  assert.equal(list.shifts[0].shiftId, "s-2");
  assert.equal(list.shifts[0].row, 2);
  assert.equal(list.shifts[0].label, "Mon 2026-06-01 · Sam Lee · in 9:00 AM · closed");
  assert.match(
    list.shifts[0].detail,
    /Removed by: JP, at 2026-06-03 10:15 AM\nRemoved reason: typed twice$/,
  );

  const reply = plain(s.ctx.adminRestoreShift(KEY, { shiftId: "s-2", row: 2, initials: "kb" }));
  assert.deepEqual(reply, { ok: true, name: "Sam Lee", date: DAY, logRow: 4, flagsFailed: false });
  const log = s.tabs.Log;
  assert.deepEqual(log.rows[3], original);
  // Kiosk columns get the kiosk's format; the staff column keeps the copied one.
  assert.equal(log.format(4, 9), "yyyy-mm-dd h:mm am/pm");
  assert.equal(log.format(4, 1), "@");
  assert.equal(log.format(4, 8), "0.0");
  // The Removed row is gone; the Flags rows keep their tick and get a note.
  assert.equal(s.tabs["Removed shifts"].lastRow(), 1);
  assert.equal(s.tabs.Flags.byHeader(2).Reviewed, true);
  assert.equal(
    s.tabs.Flags.byHeader(2).Notes,
    "Log row removed by JP on 2026-06-03: typed twice; Log row restored by KB on 2026-06-03.",
  );
  assert.equal(s.tabs.Flags.byHeader(3).Notes, "");

  const again = plain(s.ctx.adminRestoreShift(KEY, { shiftId: "s-2", row: 2, initials: "kb" }));
  assert.equal(again.refusal, "ADMIN_RESTORE_NOT_FOUND");
});

test("Remove of one of two rows with a Shift ID ticks only that row's flags and the pair's flag", () => {
  const s = server({
    now: NOW,
    log: [LOG_HEADER, closed("dup"), closed("dup")],
    flags: [
      FLAG_HEADER,
      flag("dup", "long shift", 2),
      flag("dup", "late", 3),
      flag("dup", "Shift ID on more than one row: rows 2, 3", 2, { Source: "log check" }),
    ],
  });
  const reply = plain(
    s.ctx.adminRemoveShift(KEY, { shiftId: "dup", row: 2, reason: "copied", initials: "JP" }),
  );
  assert.equal(reply.flagsMarked, 2);
  assert.equal(reply.flagsLeft, 1);
  assert.deepEqual(
    [2, 3, 4].map((r) => s.tabs.Flags.byHeader(r).Reviewed),
    [true, false, true],
  );
  assert.equal(s.tabs.Log.lastRow(), 2);
  // The row that was at row 3 can't be picked by row 2 now that it moved up, but as the
  // only one left, it is found wherever it is.
  const second = plain(
    s.ctx.adminRemoveShift(KEY, { shiftId: "dup", row: 3, reason: "copied", initials: "JP" }),
  );
  assert.equal(second.ok, true);
  // With no other row holding the Shift ID, every flag of it is the removed row's.
  assert.equal(second.flagsMarked, 3);
  assert.equal(second.flagsLeft, 0);
});

test("Remove refuses when the Shift ID left the row before the delete, and takes back the Removed row", () => {
  const s = removeSetup();
  s.onFlush(() => s.tabs.Log.put(3, 1, "someone else"));
  const reply = plain(s.ctx.adminRemoveShift(KEY, REMOVE));
  assert.equal(reply.refusal, "ADMIN_REMOVE_MOVED");
  assert.equal(s.tabs["Removed shifts"].lastRow(), 1);
  assert.equal(s.tabs.Log.lastRow(), 4);
  assert.equal(s.tabs.Flags.byHeader(2).Reviewed, false);
});

test("Remove refusals write nothing; the header refusal names the column", () => {
  const s = removeSetup();
  s.tabs.Log.put(3, 19, "stray");
  const reply = plain(s.ctx.adminRemoveShift(KEY, REMOVE));
  assert.equal(reply.refusal, "ADMIN_REMOVE_HEADERS");
  assert.match(
    reply.message,
    /Give that column a unique header first\. Column: "S \(no header\)"\.$/,
  );
  for (const [form, code] of [
    [{ ...REMOVE, shiftId: "nope" }, "ADMIN_REMOVE_NOT_FOUND"],
    [{ ...REMOVE, reason: "" }, "ADMIN_REMOVE_REASON"],
    [{ ...REMOVE, shiftId: "" }, "ADMIN_REMOVE_NO_ID"],
  ]) {
    assert.equal(s.ctx.adminRemoveShift(KEY, form).refusal, code);
  }
  assert.equal(s.tabs["Removed shifts"], undefined);
  assert.deepEqual(writes(s), []);
});

test("Remove with no Flags tab still moves the row; a broken Flags tab is logged, not thrown", () => {
  const none = server({ now: NOW, flags: null, log: [LOG_HEADER, closed("s-1")] });
  const reply = plain(none.ctx.adminRemoveShift(KEY, { ...REMOVE, shiftId: "s-1", row: 2 }));
  assert.equal(reply.ok, true);
  assert.equal(reply.flagsMarked, 0);
  const broken = server({ now: NOW, flags: [["Shift ID"]], log: [LOG_HEADER, closed("s-1")] });
  const out = plain(broken.ctx.adminRemoveShift(KEY, { ...REMOVE, shiftId: "s-1", row: 2 }));
  assert.equal(out.ok, true);
  assert.equal(out.flagsFailed, true);
  assert.equal(broken.tabs.Log.lastRow(), 1);
  assert.match(broken.errors[0], /^Flags: not marked for Shift ID s-1: /);
});

test("a later Remove adds a new Log header to the Removed tab", () => {
  const s = removeSetup();
  s.ctx.adminRemoveShift(KEY, REMOVE);
  s.tabs.Log.put(1, 18, "Late column");
  s.tabs.Log.put(2, 18, "late value");
  s.ctx.adminRemoveShift(KEY, { ...REMOVE, shiftId: "s-1", row: 2 });
  const removed = s.tabs["Removed shifts"];
  assert.equal(removed.rows[0][20], "Late column");
  assert.equal(removed.byHeader(3)["Late column"], "late value");
  assert.equal(removed.byHeader(2)["Late column"], "");
});

test("Restore refusals: already in the Log, an open shift beside an open one, a lost column", () => {
  const open = closed("s-9", "Sam Lee", "tok-sam", {
    Status: "open",
    "Check-Out Recorded (timestamp)": "",
    "Check-Out Stated (user)": "",
    "Hours Served (timestamps)": "",
    "Hours Served (stated)": "",
  });
  const removedRow = (row, extra = []) => [...row, "JP", new Date(NOW), "why", ...extra];
  const s = server({
    now: NOW,
    log: [LOG_HEADER, closed("s-1"), open],
    removed: [
      [...LOG_HEADER, ...X, "Gone"],
      removedRow(closed("s-1")),
      removedRow(open.map((v, i) => (i === 0 ? "s-8" : v))),
      removedRow(closed("s-7"), ["kept here"]),
    ],
  });
  const code = (shiftId, row) =>
    s.ctx.adminRestoreShift(KEY, { shiftId, row, initials: "JP" }).refusal;
  assert.equal(code("s-1", 2), "ADMIN_RESTORE_IN_LOG");
  assert.equal(code("s-8", 3), "ADMIN_RESTORE_OPEN_SHIFT");
  const headers = plain(s.ctx.adminRestoreShift(KEY, { shiftId: "s-7", row: 4, initials: "JP" }));
  assert.equal(headers.refusal, "ADMIN_RESTORE_HEADERS");
  assert.match(headers.message, /Column: "Gone"\.$/);
  assert.equal(code("s-1", 2), "ADMIN_RESTORE_IN_LOG");
  assert.deepEqual(writes(s), []);
  // Restore refuses with nothing written when the chosen row lost its Shift ID under the lock.
  const moved = server({
    now: NOW,
    removed: [[...LOG_HEADER, ...X], removedRow(closed("s-5"))],
  });
  const tab = moved.tabs["Removed shifts"];
  const realRange = tab.getRange.bind(tab);
  tab.getRange = (row, col, rows, cols) => {
    if (row === 2 && col === 1 && rows === undefined) tab.put(2, 1, "changed");
    return realRange(row, col, rows, cols);
  };
  const reply = plain(moved.ctx.adminRestoreShift(KEY, { shiftId: "s-5", row: 2, initials: "JP" }));
  assert.equal(reply.refusal, "ADMIN_RESTORE_MOVED");
  assert.equal(moved.tabs.Log.lastRow(), 1);
  assert.equal(tab.lastRow(), 2);
});

test("adminRemovedShifts lists newest Removed at first, and only rows with a Shift ID", () => {
  const row = (id, ms) => [...closed(id), "JP", ms === null ? "" : new Date(ms), "why"];
  const s = server({
    removed: [
      [...LOG_HEADER, ...X],
      row("old", NOW - 1000),
      row("", NOW),
      row("new", NOW),
      row("none", null),
    ],
  });
  const list = plain(s.ctx.adminRemovedShifts(KEY));
  assert.deepEqual(
    list.shifts.map((x) => [x.shiftId, x.row]),
    [
      ["new", 4],
      ["old", 2],
      ["none", 5],
    ],
  );
});

test("adminFindShifts finds by Shift ID, or by volunteer and date, and skips rows with no Shift ID", () => {
  const s = server({
    volunteers: [SAM],
    log: [
      LOG_HEADER,
      closed("s-1"),
      closed(""),
      closed("s-3", "Ruth Okafor", "tok-ruth"),
      closed("s-4", "Sam Lee", "tok-sam", { Date: "2026-06-02" }),
      closed("s-1"),
    ],
  });
  const byId = plain(s.ctx.adminFindShifts(KEY, { shiftId: " s-1 " }));
  assert.deepEqual(
    byId.shifts.map((x) => [x.shiftId, x.row, x.label]),
    [
      ["s-1", 2, "Mon 2026-06-01 · Sam Lee · in 9:00 AM · closed"],
      ["s-1", 6, "Mon 2026-06-01 · Sam Lee · in 9:00 AM · closed"],
    ],
  );
  assert.match(byId.shifts[0].detail, /^Date: 2026-06-01\n/);
  const byDay = plain(s.ctx.adminFindShifts(KEY, { id: SAM.id, date: DAY }));
  assert.deepEqual(
    byDay.shifts.map((x) => x.row),
    [2, 6],
  );
  assert.equal(s.ctx.adminFindShifts(KEY, { id: "nobody", date: DAY }).refusal, "ADMIN_NOT_FOUND");
  assert.equal(s.ctx.adminFindShifts(KEY, { id: SAM.id, date: "June" }).refusal, "ADMIN_BAD_TIME");
  assert.deepEqual(plain(s.ctx.adminFindShifts(KEY, { shiftId: "none" })), {
    ok: true,
    shifts: [],
  });
  assert.deepEqual(writes(s), []);
});

test("cellBack_ writes text so it reads back as text; other values as they are", () => {
  const { ctx } = removeSetup();
  assert.equal(ctx.cellBack_(null), "");
  assert.equal(ctx.cellBack_("=1+1"), "'=1+1");
  assert.equal(ctx.cellBack_("'Neil"), "''Neil");
  assert.equal(ctx.cellBack_("Sam Lee"), "Sam Lee");
  assert.equal(ctx.cellBack_(2.5), 2.5);
  assert.equal(ctx.cellBack_(true), true);
  const d = new Date(Date.UTC(2026, 5, 1));
  assert.equal(ctx.cellBack_(d), d);
  assert.equal(ctx.isDateValue_(d), true);
  assert.equal(ctx.isDateValue_("2026-06-01"), false);
});
