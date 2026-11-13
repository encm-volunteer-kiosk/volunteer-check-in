// Tests for Import past hours: the pure rules in apps-script/Logic.js (section "Past hours
// import") and apps-script/Import.js against stand-ins for the spreadsheets. The server
// files are loaded into one global scope, as Apps Script loads them.
//
// The source tab is invented, in the layout of ENCM's "Historical Hours" tab: Date, First
// name, Last name, an unheaded hours column, an unheaded source-tab column and Source
// cell. Every name in it is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SERVER_FILES = ["Logic.js", "Sheets.js", "Api.js", "Admin.js", "Import.js"].map((f) => [
  f,
  read("apps-script/" + f),
]);
const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);

const plain = (x) => JSON.parse(JSON.stringify(x));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const TZ = "America/Chicago";
// 10:00 Central on 2026-11-12.
const NOW = Date.parse("2026-11-12T16:00:00Z");
const TODAY = "2026-11-12";
const LAUNCH = "2026-06-15";
const FILE_ID = "srcfile-0123456789";
const FILE_LINK = "https://docs.google.com/spreadsheets/d/" + FILE_ID + "/edit#gid=0";

// ---------------------------------------------------------------------------
// The invented source tab, in ENCM's layout

const SOURCE_HEADER = ["Date", "First name", "Last name", "", "", "Source cell"];
const SOURCE_ROWS = [
  ["2025-12-02", "Avery", "Quinn", 3, "2025.12", "C3"],
  ["2025-12-02", "Blake", "Morrow", 2.5, "2025.12", "C4"],
  ["2025-12-02", "Jordan", "Vale", 4, "2025.12", "C5"],
  ["2025-12-04", "Avery", "Quinn", 3, "2025.12", "D3"],
  ["2025-12-04", "Kit", "", 2, "2025.12", "D9"],
  ["2026-01-06", "Casey", "Lindqvist", 3.25, "2026.01", "C3"],
  ["2026-01-06", "casey ", " Lindqvist", 1.5, "2026.01", "C4"],
  ["2026-01-08", "Lee / Max", "Fenn", 4, "2026.01", "D3"],
  ["2026-02-10", "Blake", "Morrow", 5.15, "2026.02", "C3"],
  ["2026-03-19", "Dana", "Whitcombe", 78, "2026.03", "C7"],
  ["2026-03-21", "Dana", "Whitcombe", 6, "2026.03", "D7"],
  ["2026-04-07", "Ellis", "Navarro", 0.75, "2026.04", "C3"],
  ["2026-05-30", "Kit", "", 3, "2026.05", "E2"],
  ["2026-05-30", "R.", "Tamsin", 2, "2026.05", "E3"],
  ["", "", "", "", "", ""],
];

const person = (id, firstName, lastName, token, row) => ({
  id,
  firstName,
  lastName,
  phoneLast4: "",
  startDate: "",
  needsPhoneCheck: false,
  token,
  row,
});
const VOLUNTEERS = [
  person("a1", "Avery", "Quinn", "tok-avery", 2),
  person("b1", "Blake", "Morrow", "tok-blake", 3),
  person("d1", "Dana", "Whitcombe", "tok-dana", 4),
  person("e1", "Ellis", "Navarro", "tok-ellis", 5),
  person("j1", "Jordan", "Vale", "tok-jordan-1", 6),
  person("j2", "Jordan", "Vale", "tok-jordan-2", 7),
];

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

// ---------------------------------------------------------------------------
// Stand-ins for the Google services

class FakeSheet {
  constructor(rows, maxRows = 1000) {
    this.rows = rows.map((r) => r.slice());
    this.formats = {};
    this.maxRows = maxRows;
    this.frozen = 0;
    this.valueWrites = 0;
  }
  getLastRow() {
    let last = this.rows.length;
    while (last > 0 && this.rows[last - 1].every((v) => v === "")) last--;
    return last;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getMaxRows() {
    return this.maxRows;
  }
  insertRowsAfter(after, count) {
    assert.equal(after, this.maxRows, "rows are only added at the end");
    this.maxRows += count;
  }
  setFrozenRows(n) {
    this.frozen = n;
  }
  put(row, col, value) {
    assert.ok(row <= this.maxRows, "write past the last grid row " + this.maxRows + ": " + row);
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1];
    while (r.length < col) r.push("");
    r[col - 1] = value;
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  getRange(row, col, rows = 1, cols = 1) {
    const sheet = this;
    const range = {
      getValues: () =>
        Array.from({ length: rows }, (_, i) =>
          Array.from(
            { length: cols },
            (_, j) => (sheet.rows[row - 1 + i] || [])[col - 1 + j] ?? "",
          ),
        ),
      setNumberFormat: (format) => {
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) sheet.formats[row + i + ":" + (col + j)] = format;
        }
        return range;
      },
      setValue: (value) => {
        sheet.put(row, col, value);
        return range;
      },
      setValues: (values) => {
        assert.equal(values.length, rows, "setValues row count");
        sheet.valueWrites++;
        values.forEach((line, i) => {
          assert.equal(line.length, cols, "setValues column count");
          line.forEach((v, j) => sheet.put(row + i, col + j, v));
        });
        return range;
      },
      getNumberFormats: () =>
        Array.from({ length: rows }, (_, i) =>
          Array.from({ length: cols }, (_, j) => sheet.formats[row + i + ":" + (col + j)] ?? ""),
        ),
      setNumberFormats: (formats) => {
        assert.equal(formats.length, rows, "setNumberFormats row count");
        formats.forEach((line, i) => {
          assert.equal(line.length, cols, "setNumberFormats column count");
          line.forEach((f, j) => (sheet.formats[row + i + ":" + (col + j)] = f));
        });
        return range;
      },
      setDataValidation: () => range,
    };
    return range;
  }
  /** Data rows as {header with spaces for line breaks: value}. */
  records() {
    const header = this.rows[0].map((h) => String(h).replace(/\s+/g, " "));
    return this.rows
      .slice(1, this.getLastRow())
      .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]).filter(([h]) => h)));
  }
}

// The Log with staff's columns moved about and one of their own between.
const LOG_HEADER = [
  "Shift ID",
  "User Token",
  "Status",
  "Date",
  "Day",
  "Volunteer\nName",
  "Volunteer\nRole/Type",
  "Notes",
  "Staff column",
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
const FLAG_HEADER = [
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
const settingsRows = (extra = []) => [
  ["Setting", "Value"],
  ["Volunteer Profiles file ID", "file-1"],
  ["Volunteer Profiles tab", "Volunteer Profiles"],
  ["Kiosk launch date", LAUNCH],
  ...extra,
];

/**
 * A fresh server scope. opts: log (rows, LOG_HEADER alone by default), settings (rows),
 * source (rows of the source tab, header included), ledger (rows of an Import ledger tab;
 * none by default), volunteers, keys (dialog keys issued), lock (a function of the call
 * number giving whether tryLock succeeds), flags (null for no Flags tab), onFlush.
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const errors = [];
  const shown = [];
  const sheets = {
    Log: new FakeSheet(opts.log || [LOG_HEADER]),
    Settings: new FakeSheet(opts.settings || settingsRows()),
  };
  if (opts.flags !== null) sheets.Flags = new FakeSheet(opts.flags || [FLAG_HEADER]);
  if (opts.ledger) sheets["Import ledger"] = new FakeSheet(opts.ledger);
  const source = new FakeSheet(opts.source || [SOURCE_HEADER, ...SOURCE_ROWS]);
  let uuid = 0;
  let locks = 0;

  const service = (name, methods) =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop in methods && typeof methods[prop] !== "function") return methods[prop];
          return (...args) => {
            calls.push(name + "." + prop);
            if (!methods[prop]) throw new Error("unexpected call " + name + "." + prop);
            return methods[prop](...args);
          };
        },
      },
    );
  const email = (value) => ({ getEmail: () => value });
  const ctx = {
    console: { log: () => {}, error: (...args) => errors.push(args.join(" ")) },
    Session: service("Session", {
      getActiveUser: () => email("staff@example.org"),
      getEffectiveUser: () => email("staff@example.org"),
    }),
    CacheService: service("CacheService", {
      getScriptCache: () =>
        service("cache", {
          get: (k) => (cache.has(k) ? cache.get(k) : null),
          put: (k, v) => void cache.set(k, v),
        }),
    }),
    LockService: service("LockService", {
      getScriptLock: () => ({
        tryLock: () => (opts.lock ? opts.lock(++locks) : true),
        releaseLock: () => {},
      }),
    }),
    SpreadsheetApp: service("SpreadsheetApp", {
      getUi: () => ({ showModalDialog: (output, title) => shown.push({ output, title }) }),
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => (sheets[name] = new FakeSheet([])),
      }),
      openById: (id) => {
        if (id !== FILE_ID)
          throw new Error("Unexpected error while getting the method or property openById");
        return {
          getName: () => "Old Volunteer Hours",
          getSheetByName: (name) => (name === "Historical Hours" ? source : null),
        };
      },
      flush: () => (opts.onFlush ? opts.onFlush() : undefined),
      newDataValidation: () => {
        const b = { requireCheckbox: () => b, build: () => "checkbox" };
        return b;
      },
    }),
    HtmlService: service("HtmlService", {
      createTemplateFromFile: (file) => {
        const template = { file };
        template.evaluate = () => {
          const output = { template: { ...template } };
          output.setWidth = () => output;
          output.setHeight = () => output;
          return output;
        };
        return template;
      },
    }),
    Utilities: service("Utilities", {
      getUuid: () => "uuid-" + ++uuid,
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "yyyy-MM-dd") return centralDate(date.getTime());
        if (format === "HH:mm") {
          const p = centralParts(date.getTime());
          return p.hour + ":" + p.minute;
        }
        throw new Error("format " + format);
      },
      computeDigest: (algorithm, text) => {
        assert.equal(algorithm, "SHA_256");
        return [...createHash("sha256").update(text, "utf8").digest()].map((b) =>
          b > 127 ? b - 256 : b,
        );
      },
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      sleep: () => {},
    }),
  };
  vm.createContext(ctx);
  const RealDate = vm.runInContext("Date", ctx);
  ctx.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  };
  for (const [file, src] of SERVER_FILES) vm.runInContext(src, ctx, { filename: file });
  cache.set(
    ctx.profilesCacheKey("file-1", "Volunteer Profiles"),
    JSON.stringify(opts.volunteers || VOLUNTEERS),
  );
  for (const key of opts.keys || ["k"]) cache.set(ctx.adminKeyCacheKey(key), "1");
  calls.length = 0;
  return { ctx, calls, cache, sheets, source, shown, errors };
}

const FORM = { file: FILE_LINK, tab: "Historical Hours", initials: "j.p." };

// ---------------------------------------------------------------------------
// Pure rules

test("the header map takes an unheaded hours column after Last name, or a column headed Hours", () => {
  assert.deepEqual(plain(L.importColumns(SOURCE_HEADER)), {
    cols: { date: 0, firstName: 1, lastName: 2, hours: 3, sourceTab: 4, sourceCell: 5 },
    missing: [],
  });
  // Headed Hours anywhere, any case; the unheaded column left of Source cell is the tab.
  assert.deepEqual(
    plain(L.importColumns(["HOURS", " last  name", "First Name", "DATE", "", "Source Cell"])),
    {
      cols: { date: 3, firstName: 2, lastName: 1, hours: 0, sourceTab: 4, sourceCell: 5 },
      missing: [],
    },
  );
  // Source cell right after the hours column: no source tab.
  assert.deepEqual(
    plain(L.importColumns(["Date", "First name", "Last name", "", "Source cell"])).cols,
    {
      date: 0,
      firstName: 1,
      lastName: 2,
      hours: 3,
      sourceTab: -1,
      sourceCell: 4,
    },
  );
  // No Source cell at all.
  assert.equal(L.importColumns(["Date", "First name", "Last name", "Hours"]).cols.sourceCell, -1);
  assert.deepEqual(plain(L.importColumns(["When", "First name", "Surname"]).missing), [
    "Date",
    "Last name",
  ]);
});

test("a spreadsheet is found from its link or its ID", () => {
  assert.equal(L.importFileId(FILE_LINK), FILE_ID);
  assert.equal(L.importFileId("  " + FILE_ID + " "), FILE_ID);
  assert.equal(L.importFileId(""), "");
  assert.equal(L.importFileId("Old Volunteer Hours"), "");
});

const plan = (rows, extra = {}) =>
  L.importPlan({
    header: SOURCE_HEADER,
    rows,
    launchDate: LAUNCH,
    todayDate: TODAY,
    volunteers: VOLUNTEERS,
    ledgerKeys: [],
    logShiftIds: [],
    hashFn: sha256,
    ...extra,
  });

test("every left-out reason, by source row, and none is remembered", () => {
  const p = plan([
    ["2026-13-01", "Avery", "Quinn", 3, "", ""], // 2: not a day
    ["Dec 2", "Avery", "Quinn", 3, "", ""], // 3: not a format it reads
    ["2026-11-13", "Avery", "Quinn", 3, "", ""], // 4: after today
    ["2026-06-15", "Avery", "Quinn", 3, "", ""], // 5: the launch date itself
    ["2026-07-01", "Avery", "Quinn", 3, "", ""], // 6: after the launch date
    ["2026-01-05", "", " ", 3, "", ""], // 7: no name
    ["2026-01-05", "Avery", "Quinn", 0, "", ""], // 8: zero hours
    ["2026-01-05", "Avery", "Quinn", -1, "", ""], // 9: negative
    ["2026-01-05", "Avery", "Quinn", 24.01, "", ""], // 10: over 24
    ["2026-01-05", "Avery", "Quinn", "three", "", ""], // 11: text
    ["2026-01-05", "Avery", "Quinn", "", "", ""], // 12: blank
    ["2026-01-05", "Avery", "Quinn", 24, "", ""], // 13: 24 is in
    ["1/6/2026", "Avery", "Quinn", "2.5", "", ""], // 14: m/d/yyyy and hours as text
    ["2026-06-14", "", "Quinn", 1, "", ""], // 15: last name alone, the day before launch
  ]);
  assert.deepEqual(plain(p.leftOut), [
    { row: 2, reason: "date" },
    { row: 3, reason: "date" },
    { row: 4, reason: "future" },
    { row: 5, reason: "launch" },
    { row: 6, reason: "launch" },
    { row: 7, reason: "name" },
    { row: 8, reason: "hours" },
    { row: 9, reason: "hours" },
    { row: 10, reason: "hours" },
    { row: 11, reason: "hours" },
    { row: 12, reason: "hours" },
  ]);
  assert.deepEqual(plain(p.toImport.map((i) => [i.sourceRow, i.date, i.hours])), [
    [13, "2026-01-05", 24],
    [14, "2026-01-06", 2.5],
    [15, "2026-06-14", 1],
  ]);
  // Left-out rows aren't in the ledger, so fixing one in the source brings it in.
  const s = plain(L.importSummary(p));
  assert.deepEqual(s.leftOutRows, [
    { reason: "date can't be read", rows: [2, 3] },
    { reason: "date is after today", rows: [4] },
    { reason: 'date is on or after the "Kiosk launch date"', rows: [5, 6] },
    { reason: "no first or last name", rows: [7] },
    { reason: "hours aren't a number above 0 and at most 24", rows: [8, 9, 10, 11, 12] },
  ]);
});

test("a blank or unreadable launch date refuses the plan, naming the setting", () => {
  for (const launch of ["", "soon", "2026-02-30", "6/15/26"]) {
    const p = plan(SOURCE_ROWS, { launchDate: launch });
    assert.equal(p.refusal.refusal, "IMPORT_LAUNCH_DATE", launch);
    assert.match(p.refusal.message, /"Kiosk launch date"/);
  }
  const missing = L.importPlan({ header: ["Date", "Name"], rows: [], launchDate: LAUNCH });
  assert.equal(missing.refusal.refusal, "IMPORT_HEADERS");
  assert.equal(
    missing.refusal.message,
    'The tab\'s first row has no "First name" or "Last name" column.',
  );
});

test("names: one Profiles match, none, or a same-name group", () => {
  const p = plan(SOURCE_ROWS);
  const byRow = (row) => p.toImport.find((i) => i.sourceRow === row);
  assert.equal(byRow(2).volunteer.token, "tok-avery");
  assert.equal(byRow(2).matches, 1);
  // Jordan Vale is two Profiles volunteers: unmatched, and the alert says so.
  assert.equal(byRow(4).volunteer, null);
  assert.equal(byRow(4).matches, 2);
  // Kit has no last name; Casey isn't in Profiles. Case and spaces don't matter.
  assert.equal(byRow(6).volunteer, null);
  assert.equal(byRow(6).name, "Kit");
  assert.equal(byRow(8).nameKey, byRow(7).nameKey);
  assert.equal(byRow(8).name, "casey Lindqvist");

  const cells = (item) => plain(L.importCells(item, "a note"));
  const N = L.logHeaderNames();
  const matched = cells(byRow(2));
  assert.deepEqual(matched, {
    [N.date]: "2025-12-02",
    [N.day]: "Tuesday",
    [N.name]: "Avery Quinn",
    [N.statedHours]: 3,
    [N.token]: "tok-avery",
    [N.status]: "closed",
    [N.inBy]: "import",
    [N.outBy]: "import",
    [N.shiftId]: byRow(2).shiftId,
    [N.notes]: "a note",
  });
  assert.equal(L.entrySource(matched[N.inBy]), "other");
  const group = cells(byRow(4));
  assert.equal(group[N.token], "import:jordan vale");
  assert.equal(group[N.name], "Jordan Vale");
  assert.equal(
    group[N.alerts],
    "imported: name matches 2 Volunteer Profiles rows; correct this row on the Log, not in the old sheet",
  );
  const none = cells(byRow(6));
  assert.equal(none[N.token], "import:kit");
  assert.equal(
    none[N.alerts],
    "imported: no Volunteer Profiles match for this name; correct this row on the Log, not in the old sheet",
  );
  assert.equal(cells(byRow(8))[N.token], "import:casey lindqvist");
  // No times are written, and no Notes when there is none to write.
  assert.equal(N.notes in plain(L.importCells(byRow(2), "")), false);
  for (const h of [N.recordedIn, N.statedIn, N.recordedOut, N.statedOut, N.recordedHours]) {
    assert.equal(h in matched, false, h);
  }
  // Imported rows count in the reports, under the token.
  const entry = { status: "closed", token: group[N.token] };
  assert.equal(L.isCountedRow(entry), true);
});

test("keys: a repeated date and name counts up in source order; the Shift ID is its hash", () => {
  const rows = [
    ["2026-01-05", "Avery", "Quinn", 2, "2026.01", "C3"],
    ["2026-01-05", "Avery", "Quinn", 0, "2026.01", "C9"], // left out, but counted
    ["2026-01-05", "AVERY", "quinn ", 1, "2026.01", "C12"],
    ["2026-01-06", "Avery", "Quinn", 1, "2026.01", "D3"],
  ];
  const p = plan(rows);
  assert.deepEqual(plain(p.toImport.map((i) => i.key)), [
    "2026-01-05|avery|quinn|1",
    "2026-01-05|avery|quinn|3",
    "2026-01-06|avery|quinn|1",
  ]);
  for (const item of p.toImport) {
    assert.equal(item.shiftId, "import-" + sha256(item.key).slice(0, 16));
  }
  // Fixing the left-out row's hours doesn't change its neighbours' keys.
  rows[1][3] = 3;
  assert.deepEqual(plain(plan(rows).toImport.map((i) => i.key)), [
    "2026-01-05|avery|quinn|1",
    "2026-01-05|avery|quinn|2",
    "2026-01-05|avery|quinn|3",
    "2026-01-06|avery|quinn|1",
  ]);
  // Neither the cell nor the hours is in the key: a moved or re-flattened row is the same.
  rows[0][5] = "Z99";
  rows[0][3] = 2.25;
  assert.equal(plan(rows).toImport[0].key, "2026-01-05|avery|quinn|1");
});

test("the ledger and the Log's Shift IDs keep a key from importing twice", () => {
  const first = plan(SOURCE_ROWS);
  const [a, b] = first.toImport;
  const p = plan(SOURCE_ROWS, { ledgerKeys: [a.key], logShiftIds: [b.shiftId, "other"] });
  assert.deepEqual(plain(p.alreadyImported.map((i) => i.key)), [a.key]);
  assert.deepEqual(plain(p.onLog.map((i) => i.key)), [b.key]);
  assert.equal(p.toImport.length, first.toImport.length - 2);
});

test("the invented ENCM-layout tab previews as expected", () => {
  const s = plain(L.importSummary(plan(SOURCE_ROWS)));
  assert.deepEqual(s, {
    rowsRead: 14,
    toImport: 13,
    matched: 6,
    unmatched: 7,
    hours: 40.15,
    alreadyImported: 0,
    onLog: 0,
    leftOut: 1,
    unmatchedNames: [
      { name: "Casey Lindqvist", rows: 2, matches: 0 },
      { name: "Jordan Vale", rows: 1, matches: 2 },
      { name: "Kit", rows: 2, matches: 0 },
      { name: "Lee / Max Fenn", rows: 1, matches: 0 },
      { name: "R. Tamsin", rows: 1, matches: 0 },
    ],
    leftOutRows: [{ reason: "hours aren't a number above 0 and at most 24", rows: [11] }],
  });
});

test("the note names who imported it and where the row came from", () => {
  const item = plan(SOURCE_ROWS).toImport[0];
  assert.equal(
    L.importNote("JP", "Old Volunteer Hours", "Historical Hours", item),
    "Imported by JP from Old Volunteer Hours › Historical Hours row 2 (2025.12 C3)",
  );
  assert.equal(
    L.importNote("JP", "Old", "Tab", { ...item, sourceTab: "", sourceCell: "" }),
    "Imported by JP from Old › Tab row 2",
  );
});

// ---------------------------------------------------------------------------
// The menu item

test("the opener prefills the dialog from Settings, and its key works", () => {
  const s = server({
    keys: [],
    settings: settingsRows([
      ["Past hours file ID", FILE_ID],
      ["Past hours tab", "Old tab"],
    ]),
  });
  s.ctx.openImportDialog();
  const { template } = s.shown[0].output;
  assert.equal(s.shown[0].title, "Import past hours");
  assert.equal(template.file, "ImportDialog");
  assert.equal(template.fileId, FILE_ID);
  assert.equal(template.tab, "Old tab");
  assert.equal(s.ctx.adminImportPreview(template.key, FORM).ok, true);

  // No Past hours rows yet: the default tab.
  const fresh = server({ keys: [] });
  fresh.ctx.openImportDialog();
  assert.equal(fresh.shown[0].output.template.fileId, "");
  assert.equal(fresh.shown[0].output.template.tab, "Historical Hours");
});

test("a blank or unreadable launch date refuses Preview and Import before the source is opened", () => {
  for (const launch of ["", "next week"]) {
    const s = server({
      settings: [
        ["Setting", "Value"],
        ["Volunteer Profiles file ID", "file-1"],
        ["Kiosk launch date", launch],
      ],
    });
    for (const name of ["adminImportPreview", "adminImportRun"]) {
      const reply = plain(s.ctx[name]("k", FORM));
      assert.equal(reply.refusal, "IMPORT_LAUNCH_DATE", name);
      assert.match(reply.message, /Kiosk launch date/);
    }
    assert.ok(!s.calls.includes("SpreadsheetApp.openById"));
    assert.deepEqual(s.sheets.Log.rows, [LOG_HEADER]);
    assert.equal(s.sheets["Import ledger"], undefined);
  }
});

test("Preview writes nothing; the refusals name what's wrong", () => {
  const s = server();
  const reply = plain(s.ctx.adminImportPreview("k", FORM));
  assert.equal(reply.ok, true);
  assert.equal(reply.fileName, "Old Volunteer Hours");
  assert.equal(reply.summary.toImport, 13);
  assert.deepEqual(s.sheets.Log.rows, [LOG_HEADER]);
  assert.equal(s.sheets["Import ledger"], undefined);
  assert.deepEqual(s.sheets.Flags.rows, [FLAG_HEADER]);
  assert.ok(!s.calls.includes("cache.put"));

  const refused = (form) => plain(s.ctx.adminImportPreview("k", form)).refusal;
  assert.equal(refused({ ...FORM, file: "" }), "IMPORT_FILE_ID");
  assert.equal(refused({ ...FORM, file: "someone-elses-file-id" }), "IMPORT_FILE");
  assert.equal(refused({ ...FORM, tab: "Nope" }), "IMPORT_TAB");
  assert.equal(
    plain(s.ctx.adminImportPreview("k", { ...FORM, tab: "Nope" })).message,
    'That spreadsheet has no tab named "Nope".',
  );
  assert.equal(
    plain(s.ctx.adminImportRun("k", { ...FORM, initials: "1" })).refusal,
    "ADMIN_INITIALS",
  );
  assert.deepEqual(s.sheets.Log.rows, [LOG_HEADER]);
});

test("Import writes the rows, the ledger and one Flags row per unmatched name; a second run adds nothing", () => {
  const s = server({ log: [LOG_HEADER, ["kiosk-1", "tok-avery", "closed", "2026-11-02"]] });
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.deepEqual(
    {
      done: reply.done,
      imported: reply.imported,
      matched: reply.matched,
      unmatched: reply.unmatched,
      hours: reply.hours,
      ledgerAdded: reply.ledgerAdded,
      flags: reply.flags,
    },
    { done: true, imported: 13, matched: 6, unmatched: 7, hours: 40.15, ledgerAdded: 0, flags: 5 },
  );
  const log = s.sheets.Log.records();
  assert.equal(log.length, 14);
  const first = log[1];
  assert.equal(first["Shift ID"], "import-" + sha256("2025-12-02|avery|quinn|1").slice(0, 16));
  assert.equal(first["Volunteer Name"], "Avery Quinn");
  assert.equal(
    first.Notes,
    "Imported by JP from Old Volunteer Hours › Historical Hours row 2 (2025.12 C3)",
  );
  assert.equal(first["Hours Served (stated)"], 3);
  assert.equal(first["Check-In Stated (user)"], "");
  assert.equal(first["Check-In Entered By"], "import");

  const ledger = s.sheets["Import ledger"];
  assert.deepEqual(ledger.rows[0], [
    "Source key",
    "Shift ID",
    "Imported At",
    "Imported By",
    "Source",
  ]);
  assert.equal(ledger.frozen, 1);
  assert.equal(ledger.getLastRow(), 14);
  assert.deepEqual(ledger.rows[1].slice(0, 2), ["2025-12-02|avery|quinn|1", first["Shift ID"]]);
  assert.equal(ledger.rows[1][2].getTime(), NOW);
  assert.deepEqual(ledger.rows[1].slice(3), ["JP", FILE_ID + ", Historical Hours, row 2"]);
  assert.equal(ledger.formats["2:3"], "yyyy-mm-dd h:mm am/pm");
  assert.equal(ledger.formats["2:1"], "@");

  const flags = s.sheets.Flags.records();
  assert.deepEqual(
    flags.map((f) => [f["Volunteer Name"], f.Source, f["Log Row"]]),
    [
      ["Jordan Vale", "import", 5],
      ["Kit", "import", 7],
      ["Casey Lindqvist", "import", 8],
      ["Lee / Max Fenn", "import", 10],
      ["R. Tamsin", "import", 15],
    ],
  );
  assert.equal(
    flags[1].Reason,
    "imported: no Volunteer Profiles match for this name; correct this row on the Log, not in the old sheet (2 rows in this import)",
  );
  assert.equal(flags[1]["Shift ID"], log[5]["Shift ID"]);
  assert.equal(flags[1].Date, "2025-12-04");
  assert.equal(flags[1].Reviewed, false);
  assert.match(
    flags[0].Reason,
    /^imported: name matches 2 Volunteer Profiles rows; .* \(1 row in this import\)$/,
  );

  // The run saved what it used.
  const settings = s.ctx.readSettings_();
  assert.equal(settings["Past hours file ID"], FILE_ID);
  assert.equal(settings["Past hours tab"], "Historical Hours");

  // Again: nothing to import, nothing written.
  const before = JSON.stringify([s.sheets.Log.rows, ledger.rows, s.sheets.Flags.rows]);
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.equal(preview.toImport, 0);
  assert.equal(preview.alreadyImported, 13);
  const again = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(again.imported, 0);
  assert.equal(again.flags, 0);
  assert.equal(JSON.stringify([s.sheets.Log.rows, ledger.rows, s.sheets.Flags.rows]), before);
});

test("a row staff delete from the Log stays deleted", () => {
  const s = server();
  s.ctx.adminImportRun("k", FORM);
  const deleted = s.sheets.Log.rows.splice(3, 1)[0];
  const again = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(again.imported, 0);
  assert.equal(again.summary.alreadyImported, 13);
  assert.ok(!s.sheets.Log.rows.some((r) => r[0] === deleted[0]));
});

test("a ledger missing a block's lines is repaired from the Log's Shift IDs", () => {
  const s = server();
  s.ctx.adminImportRun("k", FORM);
  const ledger = s.sheets["Import ledger"];
  // A run that died after its Log write: its ledger lines are gone.
  const lost = ledger.rows.splice(5, 4);
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.equal(preview.toImport, 0);
  assert.equal(preview.onLog, 4);
  const logBefore = JSON.stringify(s.sheets.Log.rows);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 0);
  assert.equal(reply.ledgerAdded, 4);
  assert.equal(JSON.stringify(s.sheets.Log.rows), logBefore);
  assert.deepEqual(
    ledger.rows.slice(-4).map((r) => r[0]),
    lost.map((r) => r[0]),
  );
  assert.equal(plain(s.ctx.adminImportPreview("k", FORM)).summary.onLog, 0);
});

test("block writes are one write each and keep staff's columns and formats", () => {
  const s = server({ log: [LOG_HEADER, ["kiosk-1", "tok-avery", "closed"]] });
  const staff = LOG_HEADER.indexOf("Staff column") + 1;
  const col = (h) => LOG_HEADER.indexOf(h) + 1;
  for (let row = 3; row <= 20; row++) {
    s.sheets.Log.formats[row + ":" + staff] = "0%";
    s.sheets.Log.formats[row + ":" + col("Check-In\nStated\n(user)")] = "h:mm";
  }
  s.sheets.Log.maxRows = 5;
  s.ctx.importBlockSize = () => 5;
  assert.equal(plain(s.ctx.adminImportRun("k", FORM)).imported, 13);
  // 13 rows in blocks of 5, 5 and 3: one Log write per block, growing the tab first.
  assert.equal(s.sheets.Log.valueWrites, 3);
  assert.equal(s.sheets.Log.getLastRow(), 15);
  assert.ok(s.sheets.Log.maxRows >= 15);
  assert.equal(s.sheets.Log.formats["3:" + staff], "0%");
  assert.equal(s.sheets.Log.formats["15:" + staff], "0%");
  assert.equal(s.sheets.Log.rows[2][staff - 1], "");
  assert.equal(s.sheets.Log.formats["3:" + col("Hours Served\n(stated)")], "0.00");
  assert.equal(s.sheets.Log.formats["3:" + col("Date")], "@");
  // Columns no row names keep their format.
  assert.equal(s.sheets.Log.formats["15:" + col("Check-In\nStated\n(user)")], "h:mm");
});

test("a Log with no Notes column gets no note", () => {
  const header = LOG_HEADER.filter((h) => h !== "Notes");
  const s = server({ log: [header] });
  assert.equal(plain(s.ctx.adminImportRun("k", FORM)).imported, 13);
  assert.equal(s.sheets.Log.records()[0].Notes, undefined);
});

test("each block flags the unmatched names first seen in it, so a run stopped part way has flagged them", () => {
  // Blocks of 3; the lock is busy for the third block.
  const s = server({ lock: (n) => n !== 3 });
  s.ctx.importBlockSize = () => 3;
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.done, false);
  assert.match(reply.message, /busy.*Run it again/);
  assert.equal(reply.imported, 6);
  // Rows 2-7 landed: Jordan Vale and Kit were first seen there and are flagged.
  assert.deepEqual(
    s.sheets.Flags.records().map((f) => f["Volunteer Name"]),
    ["Jordan Vale", "Kit", "Casey Lindqvist"],
  );
  assert.equal(s.sheets["Import ledger"].getLastRow(), 7);

  // The next run finishes: only the names first seen in its own rows are flagged.
  s.ctx.importBlockSize = () => 3;
  const rest = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(rest.done, true);
  assert.equal(rest.imported, 7);
  assert.deepEqual(
    s.sheets.Flags.records().map((f) => f["Volunteer Name"]),
    [
      "Jordan Vale",
      "Kit",
      "Casey Lindqvist",
      "casey Lindqvist",
      "Lee / Max Fenn",
      "Kit",
      "R. Tamsin",
    ],
  );
  assert.equal(s.sheets.Log.getLastRow(), 14);
});

test("the time limit stops the run between blocks", () => {
  const s = server();
  s.ctx.importBlockSize = () => 4;
  let checks = 0;
  s.ctx.importTimeBudgetMs = () => (checks++ < 2 ? Infinity : -1);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.done, false);
  assert.equal(reply.imported, 8);
  assert.equal(reply.remaining, 5);
  assert.match(reply.message, /time limit/);
  assert.equal(plain(s.ctx.adminImportPreview("k", FORM)).summary.toImport, 5);
});

test("a Flags tab that can't be written leaves the rows and ledger, and is reported", () => {
  const s = server({ flags: null });
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 13);
  assert.equal(reply.flags, 0);
  assert.equal(reply.flagsFailed, 5);
  assert.equal(s.sheets["Import ledger"].getLastRow(), 14);
  assert.match(s.errors.join("\n"), /Flags: not copied/);
});

test("a ledger tab with a header removed stops the import before it writes", () => {
  const s = server({ ledger: [["Source key", "Shift", "Imported At", "Imported By", "Source"]] });
  assert.throws(() => s.ctx.adminImportPreview("k", FORM), /"Shift ID" column/);
  assert.throws(() => s.ctx.adminImportRun("k", FORM), /"Shift ID" column/);
  assert.deepEqual(s.sheets.Log.rows, [LOG_HEADER]);
});
