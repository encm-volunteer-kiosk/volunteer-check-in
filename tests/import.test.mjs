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
import { formatInZone } from "./zoneFormat.mjs";

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

const zoneParts = (ms, zone) => {
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
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
const centralParts = (ms) => zoneParts(ms, TZ);
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
    this.valueReads = 0;
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
      getValues: () => {
        sheet.valueReads++;
        return Array.from({ length: rows }, (_, i) =>
          Array.from(
            { length: cols },
            (_, j) => (sheet.rows[row - 1 + i] || [])[col - 1 + j] ?? "",
          ),
        );
      },
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
 * number giving whether tryLock succeeds), flags (null for no Flags tab), onFlush,
 * removed (rows of a Removed shifts tab; none by default),
 * sourceZone (the source spreadsheet's time zone, Central by default).
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const errors = [];
  const logs = [];
  const shown = [];
  const sheets = {
    Log: new FakeSheet(opts.log || [LOG_HEADER]),
    Settings: new FakeSheet(opts.settings || settingsRows()),
  };
  if (opts.flags !== null) sheets.Flags = new FakeSheet(opts.flags || [FLAG_HEADER]);
  if (opts.ledger) sheets["Import ledger"] = new FakeSheet(opts.ledger);
  if (opts.removed) sheets["Removed shifts"] = new FakeSheet(opts.removed);
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
    console: {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
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
          getSpreadsheetTimeZone: () => opts.sourceZone || TZ,
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
        assert.ok([TZ, opts.sourceZone].includes(tz), "unexpected time zone " + tz);
        if (format === "yyyy-MM-dd HH:mm:ss") return formatInZone(date, tz, format);
        const p = zoneParts(date.getTime(), tz);
        if (format === "yyyy-MM-dd") return p.year + "-" + p.month + "-" + p.day;
        if (format === "HH:mm") {
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
  return { ctx, calls, cache, sheets, source, shown, errors, logs };
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
    ["2026-06-15", "Avery", "Quinn", 3, "", ""], // 5: the launch date itself: in
    ["2026-07-01", "Avery", "Quinn", 3, "", ""], // 6: after the launch date: in
    ["2026-01-05", "", " ", 3, "", ""], // 7: no name
    ["2026-01-05", "Avery", "Quinn", 0, "", ""], // 8: zero hours
    ["2026-01-05", "Avery", "Quinn", -1, "", ""], // 9: negative
    ["2026-01-05", "Avery", "Quinn", 16.01, "", ""], // 10: over the Log check's 16
    ["2026-01-05", "Avery", "Quinn", "three", "", ""], // 11: text
    ["2026-01-05", "Avery", "Quinn", "", "", ""], // 12: blank
    ["2026-01-05", "Avery", "Quinn", 16, "", ""], // 13: 16 is in
    ["1/6/2026", "Avery", "Quinn", "2.5", "", ""], // 14: m/d/yyyy and hours as text
    ["2026-06-14", "", "Quinn", 1, "", ""], // 15: last name alone
  ]);
  assert.deepEqual(plain(p.leftOut), [
    { row: 2, reason: "date" },
    { row: 3, reason: "date" },
    { row: 4, reason: "future" },
    { row: 7, reason: "name" },
    { row: 8, reason: "hours" },
    { row: 9, reason: "hours" },
    { row: 10, reason: "hours" },
    { row: 11, reason: "hours" },
    { row: 12, reason: "hours" },
  ]);
  assert.deepEqual(plain(p.toImport.map((i) => [i.sourceRow, i.date, i.hours])), [
    [5, "2026-06-15", 3],
    [6, "2026-07-01", 3],
    [13, "2026-01-05", 16],
    [14, "2026-01-06", 2.5],
    [15, "2026-06-14", 1],
  ]);
  // Left-out rows aren't in the ledger, so fixing one in the source brings it in.
  const s = plain(L.importSummary(p));
  assert.deepEqual(s.leftOutRows, [
    { reason: "date can't be read", rows: [2, 3] },
    { reason: "date is after today", rows: [4] },
    { reason: "no first or last name", rows: [7] },
    { reason: "hours aren't a number above 0 and at most 16", rows: [8, 9, 10, 11, 12] },
  ]);
  assert.deepEqual(Object.keys(L.importLeftOutReasons()), ["date", "future", "name", "hours"]);
});

test("the plan takes no launch date and doesn't refuse without one", () => {
  const p = plan(SOURCE_ROWS);
  assert.equal(p.refusal, undefined);
  assert.equal(p.toImport.length, 13);
  // A launch date passed in anyway changes nothing.
  for (const launchDate of ["", "soon", "2025-12-03"]) {
    assert.deepEqual(plain(plan(SOURCE_ROWS, { launchDate })), plain(p), launchDate);
  }
  assert.equal(L.importLaunchDate, undefined);
  assert.throws(() => L.importRefusal("IMPORT_LAUNCH_DATE"), /Unknown import refusal code/);
});

test("a header row without First name and Last name refuses the plan", () => {
  const missing = L.importPlan({ header: ["Date", "Name"], rows: [] });
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

test("row counts: a row fixed above imported rows takes a free count; a moved row falls back to place", () => {
  const rows = (...list) => list.map(([row, group]) => ({ row, group }));
  const G = "2025-11-05|jane|doe";
  const counts = (r, keys, lines) => plain([...L.importRowCounts(r, new Set(keys), lines)]);
  // Row 3 came in as G|1; row 2 is fixed above it, row 4 was left out for its hours.
  assert.deepEqual(counts(rows([2, G], [3, G], [4, G]), [G + "|1"], [{ key: G + "|1", row: 3 }]), [
    [3, 1],
    [4, 3],
    [2, 2],
  ]);
  // A key from another tab is skipped too.
  assert.deepEqual(
    counts(rows([2, G], [3, G]), [G + "|1", G + "|2"], [{ key: G + "|1", row: 3 }]),
    [
      [3, 1],
      [2, 3],
    ],
  );
  // A line whose row now holds another date or name: every row by its place.
  assert.deepEqual(
    counts(
      rows([2, G], [3, G], [4, "2025-11-06|jane|doe"]),
      [G + "|1", "2025-11-06|jane|doe|1"],
      [
        { key: G + "|1", row: 3 },
        { key: "2025-11-06|jane|doe|1", row: 5 },
      ],
    ),
    [
      [2, 1],
      [3, 2],
      [4, 1],
    ],
  );
  // The ledger's Source names the file, the tab and the row.
  assert.equal(
    L.importLedgerSourceRow("f1, Historical Hours, row 12", "f1", "Historical Hours"),
    12,
  );
  assert.equal(L.importLedgerSourceRow("f1, Other, row 12", "f1", "Historical Hours"), 0);
  assert.equal(
    L.importLedgerSourceRow("f2, Historical Hours, row 12", "f1", "Historical Hours"),
    0,
  );
  assert.equal(L.importLedgerSourceRow("f1, Historical Hours, row x", "f1", "Historical Hours"), 0);
});

test("the ledger and the Log's Shift IDs keep a key from importing twice", () => {
  const first = plan(SOURCE_ROWS);
  const [a, b] = first.toImport;
  const p = plan(SOURCE_ROWS, { ledgerKeys: [a.key], logShiftIds: [b.shiftId, "other"] });
  assert.deepEqual(plain(p.alreadyImported.map((i) => i.key)), [a.key]);
  assert.deepEqual(plain(p.onLog.map((i) => i.key)), [b.key]);
  assert.equal(p.toImport.length, first.toImport.length - 2);
});

test("the import leaves out the hours the Log check calls impossible", () => {
  const most = L.logCheckMaxHours();
  const p = plan([
    ["2026-01-05", "Avery", "Quinn", most, "", ""], // 2: at the limit: in
    ["2026-01-06", "Avery", "Quinn", most + 0.01, "", ""], // 3: over it
    ["2026-01-07", "Avery", "Quinn", 20, "", ""], // 4: over it
  ]);
  assert.deepEqual(plain(p.toImport.map((i) => [i.sourceRow, i.hours])), [[2, most]]);
  assert.deepEqual(plain(p.leftOut), [
    { row: 3, reason: "hours" },
    { row: 4, reason: "hours" },
  ]);
  assert.equal(L.importLeftOutReasons().hours, "hours aren't a number above 0 and at most " + most);
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
    sameDay: 0,
    sameDayRows: [],
    unmatchedNames: [
      { name: "Casey Lindqvist", rows: 2, matches: 0 },
      { name: "Jordan Vale", rows: 1, matches: 2 },
      { name: "Kit", rows: 2, matches: 0 },
      { name: "Lee / Max Fenn", rows: 1, matches: 0 },
      { name: "R. Tamsin", rows: 1, matches: 0 },
    ],
    leftOutRows: [{ reason: "hours aren't a number above 0 and at most 16", rows: [11] }],
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
  // No Kiosk contact row: no contact line.
  assert.equal(fresh.shown[0].output.template.contactNote, "");
});

test("the opener puts the Kiosk contact line into the window", () => {
  const s = server({
    keys: [],
    settings: settingsRows([["Kiosk contact", "Pat Example\n 555-0100 \n"]]),
  });
  s.ctx.openImportDialog();
  assert.equal(
    s.shown[0].output.template.contactNote,
    "If this keeps happening, contact: Pat Example, 555-0100",
  );
  const blank = server({ keys: [], settings: settingsRows([["Kiosk contact", "\n"]]) });
  blank.ctx.openImportDialog();
  assert.equal(blank.shown[0].output.template.contactNote, "");
});

test("a blank, unreadable or missing launch date changes nothing: Preview and Import work", () => {
  const withDate = server();
  const expected = plain(withDate.ctx.adminImportPreview("k", FORM)).summary;
  withDate.ctx.adminImportRun("k", FORM);
  const base = [
    ["Setting", "Value"],
    ["Volunteer Profiles file ID", "file-1"],
  ];
  for (const settings of [
    [...base, ["Kiosk launch date", ""]],
    [...base, ["Kiosk launch date", "next week"]],
    base,
  ]) {
    const s = server({ settings });
    const label = JSON.stringify(settings.slice(2));
    const preview = plain(s.ctx.adminImportPreview("k", FORM));
    assert.equal(preview.ok, true, label);
    assert.deepEqual(preview.summary, expected, label);
    const reply = plain(s.ctx.adminImportRun("k", FORM));
    assert.equal(reply.ok, true, label);
    assert.equal(reply.imported, 13, label);
    assert.deepEqual(s.sheets.Log.rows, withDate.sheets.Log.rows, label);
    assert.deepEqual(
      s.sheets["Import ledger"].rows.map((r) => r.slice(0, 2)),
      withDate.sheets["Import ledger"].rows.map((r) => r.slice(0, 2)),
      label,
    );
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

test("date cells in the source are read in the source spreadsheet's time zone", () => {
  // Sheets hands a date cell over as midnight in its own spreadsheet's time zone.
  const rows = (offsets) => [
    SOURCE_HEADER,
    [new Date("2025-12-02T00:00:00" + offsets[0]), "Avery", "Quinn", 3, "2025.12", "C3"],
    [new Date("2026-05-30T00:00:00" + offsets[1]), "Blake", "Morrow", 2, "2026.05", "E2"],
  ];
  const cases = [
    ["America/Chicago", ["-06:00", "-05:00"]],
    ["America/New_York", ["-05:00", "-04:00"]],
    ["Etc/GMT", ["Z", "Z"]],
  ];
  for (const [zone, offsets] of cases) {
    const s = server({ source: rows(offsets), sourceZone: zone });
    const reply = plain(s.ctx.adminImportRun("k", FORM));
    assert.equal(reply.imported, 2, zone);
    const log = s.sheets.Log.records();
    assert.deepEqual(
      log.map((r) => r.Date),
      ["2025-12-02", "2026-05-30"],
      zone,
    );
    // The source key, and so the Shift ID, is the same whatever the source's zone.
    assert.deepEqual(
      s.sheets["Import ledger"].rows.slice(1, 3).map((r) => r[0]),
      ["2025-12-02|avery|quinn|1", "2026-05-30|blake|morrow|1"],
      zone,
    );
    assert.equal(log[0]["Shift ID"], "import-" + sha256("2025-12-02|avery|quinn|1").slice(0, 16));
  }
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

test("a left-out row fixed in place comes in, and the row below it isn't imported twice", () => {
  const s = server({
    source: [
      SOURCE_HEADER,
      ["2025-11-5", "Jane", "Doe", 2, "", ""], // row 2: left out, its date doesn't read
      ["2025-11-05", "Jane", "Doe", 3, "", ""], // row 3
    ],
  });
  const first = plain(s.ctx.adminImportRun("k", FORM));
  assert.deepEqual([first.imported, first.hours], [1, 3]);
  // Staff fix row 2's date where it is, as the preview tells them to, and run again.
  s.source.rows[1][0] = "2025-11-05";
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.deepEqual([preview.toImport, preview.hours, preview.alreadyImported], [1, 2, 1]);
  const second = plain(s.ctx.adminImportRun("k", FORM));
  assert.deepEqual([second.imported, second.hours], [1, 2]);
  const log = s.sheets.Log.records();
  assert.deepEqual(
    log.map((r) => [r.Notes.replace(/^.* row /, "row "), r["Hours Served (stated)"]]),
    [
      ["row 3", 3],
      ["row 2", 2],
    ],
  );
  assert.notEqual(log[0]["Shift ID"], log[1]["Shift ID"]);
  // Row 3 keeps the key it came in under.
  assert.equal(log[0]["Shift ID"], "import-" + sha256("2025-11-05|jane|doe|1").slice(0, 16));
  const third = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(third.imported, 0);
  assert.equal(third.summary.alreadyImported, 2);
});

test("rows that moved in the source keep their keys by their place among the same date and name", () => {
  const s = server();
  s.ctx.adminImportRun("k", FORM);
  // A row added at the top moves every row down one: no ledger line's row still holds
  // its date and name, so each row is known by its place, as before.
  s.source.rows.splice(1, 0, ["2025-11-30", "Avery", "Quinn", 1, "", ""]);
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.deepEqual([preview.toImport, preview.alreadyImported, preview.hours], [1, 13, 1]);
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

// ---------------------------------------------------------------------------
// Same day as a kiosk shift

test("an import row is known by its Shift ID's import- start, in any capitals", () => {
  for (const id of ["import-abc", "  IMPORT-ABC  ", "Import-1"]) {
    assert.equal(L.isImportShiftId(id), true, id);
  }
  for (const id of ["probe-1", "", "imported-x", "x-import-1", "import", null, undefined]) {
    assert.equal(L.isImportShiftId(id), false, String(id));
  }
});

test("kiosk days: open and closed rows that aren't imports, with a token and a readable date", () => {
  const row = (fields) => ({
    dateText: "2026-11-02",
    token: "tok-avery",
    status: "closed",
    shiftId: "kiosk-1",
    ...fields,
  });
  const days = (rows) => [...L.importKioskDays(rows)].sort();
  assert.deepEqual(days([row({})]), ["2026-11-02|tok-avery"]);
  assert.deepEqual(days([row({ status: "OPEN", dateText: "2026-11-03" })]), [
    "2026-11-03|tok-avery",
  ]);
  assert.deepEqual(days([row({ status: "Closed" })]), ["2026-11-02|tok-avery"]);
  // A date-time text counts on its day; a blank Shift ID counts.
  assert.deepEqual(days([row({ dateText: "2026-11-20 9:00", shiftId: "" })]), [
    "2026-11-20|tok-avery",
  ]);
  // None of these counts.
  assert.deepEqual(
    days([
      row({ shiftId: "import-0123" }),
      row({ shiftId: " IMPORT-0123" }),
      row({ token: "" }),
      row({ token: "  " }),
      row({ dateText: "" }),
      row({ dateText: "Nov 2" }),
      row({ dateText: "2026-02-30" }),
      row({ status: "" }),
      row({ status: "void" }),
    ]),
    [],
  );
  assert.deepEqual(days([]), []);
  assert.equal(L.importDayKey("2026-11-02", " tok-avery "), "2026-11-02|tok-avery");
});

test("the plan marks a matched row whose volunteer has a kiosk shift that day", () => {
  const rows = [
    ["2025-12-02", "Avery", "Quinn", 3, "", ""], // 2: Avery's kiosk day
    ["2025-12-03", "Avery", "Quinn", 3, "", ""], // 3: another day
    ["2025-12-02", "Casey", "Lindqvist", 2, "", ""], // 4: unmatched, on a kiosk day
    ["2025-12-02", "Jordan", "Vale", 2, "", ""], // 5: a same-name group
    ["2025-11-30", "Blake", "Morrow", 2, "", ""], // 6: Blake's kiosk day
  ];
  const kioskDays = L.importKioskDays([
    { dateText: "2025-12-02", token: "tok-avery", status: "closed", shiftId: "k-1" },
    { dateText: "2025-12-02", token: "import:casey lindqvist", status: "closed", shiftId: "k-2" },
    { dateText: "2025-12-02", token: "tok-jordan-1", status: "closed", shiftId: "k-3" },
    { dateText: "2025-11-30", token: "tok-blake", status: "open", shiftId: "" },
  ]);
  const p = plan(rows, { kioskDays });
  assert.deepEqual(plain(p.toImport.map((i) => [i.sourceRow, i.sameDay])), [
    [2, true],
    [3, false],
    [4, false],
    [5, false],
    [6, true],
  ]);
  const s = plain(L.importSummary(p));
  assert.equal(s.sameDay, 2);
  assert.equal(s.matched, 3);
  assert.deepEqual(s.sameDayRows, [
    { name: "Avery Quinn", date: "2025-12-02", row: 2 },
    { name: "Blake Morrow", date: "2025-11-30", row: 6 },
  ]);
  assert.ok(!JSON.stringify(s).includes("tok-"), "no User Token in the summary");
  // No kioskDays reads as empty.
  const none = plan(rows);
  assert.ok(none.toImport.every((i) => i.sameDay === false));
  assert.equal(L.importSummary(none).sameDay, 0);
  assert.deepEqual(plain(L.importSummary(none).sameDayRows), []);
});

test("a same-day row already imported or already on the Log isn't counted as same day", () => {
  const rows = [
    ["2025-12-02", "Avery", "Quinn", 3, "", ""], // 2: same day, in the ledger
    ["2025-11-30", "Blake", "Morrow", 2, "", ""], // 3: same day, its Shift ID on the Log
    ["2025-12-02", "Avery", "Quinn", 1, "", ""], // 4: same day, to import
  ];
  const kioskDays = L.importKioskDays([
    { dateText: "2025-12-02", token: "tok-avery", status: "closed", shiftId: "k-1" },
    { dateText: "2025-11-30", token: "tok-blake", status: "closed", shiftId: "k-2" },
  ]);
  const [ledgered, logged] = plan(rows, { kioskDays }).toImport;
  const p = plan(rows, {
    kioskDays,
    ledgerKeys: [ledgered.key],
    logShiftIds: [logged.shiftId],
  });
  assert.deepEqual(plain(p.alreadyImported.map((i) => [i.sourceRow, i.sameDay])), [[2, true]]);
  assert.deepEqual(plain(p.onLog.map((i) => [i.sourceRow, i.sameDay])), [[3, true]]);
  const s = plain(L.importSummary(p));
  assert.equal(s.toImport, 1);
  assert.equal(s.alreadyImported, 1);
  assert.equal(s.onLog, 1);
  assert.equal(s.sameDay, 1);
  assert.deepEqual(s.sameDayRows, [{ name: "Avery Quinn", date: "2025-12-02", row: 4 }]);
});

test("the same-day alert is in Admin Alerts? exactly when the row is same-day", () => {
  const alert = L.importSameDayAlert();
  assert.equal(
    alert,
    "imported: paper and kiosk shift on the same day; if both are the same shift, remove this imported row with Kiosk admin > Remove a shift…",
  );
  assert.match(read("apps-script/Admin.js"), /\.addItem\("Remove a shift…"/);
  const N = L.logHeaderNames();
  const p = plan(SOURCE_ROWS);
  const byRow = (row) => p.toImport.find((i) => i.sourceRow === row);
  const matched = byRow(2);
  assert.equal(plain(L.importCells({ ...matched, sameDay: true }, ""))[N.alerts], alert);
  assert.equal(N.alerts in plain(L.importCells({ ...matched, sameDay: false }, "")), false);
  assert.equal(
    plain(L.importCells(byRow(6), ""))[N.alerts],
    "imported: no Volunteer Profiles match for this name; correct this row on the Log, not in the old sheet",
  );
  assert.equal(
    plain(L.importCells(byRow(4), ""))[N.alerts],
    "imported: name matches 2 Volunteer Profiles rows; correct this row on the Log, not in the old sheet",
  );
});

test("Flags rows: one per same-day row, beside the unmatched names, in Log row order", () => {
  const p = plan([
    ["2025-12-02", "Casey", "Lindqvist", 2, "", ""], // unmatched, first row
    ["2025-12-02", "Avery", "Quinn", 3, "", ""], // same day
    ["2025-12-03", "Casey", "Lindqvist", 2, "", ""], // unmatched, second row
    ["2025-12-03", "Blake", "Morrow", 1, "", ""], // matched, not same day
    ["2025-12-04", "Blake", "Morrow", 4, "", ""], // same day
  ]);
  const items = p.toImport.map((item, i) => ({ ...item, sameDay: [1, 4].includes(i) }));
  const written = items.map((item, i) => ({ item, row: 40 + i }));
  const flagged = new Set();
  const counts = L.importUnmatchedCounts(items);
  const rows = plain(L.importFlagRows(written, counts, flagged, NOW));
  const F = L.flagHeaderNames();
  assert.deepEqual(
    rows.map((r) => [r[F.name], r[F.logRow]]),
    [
      ["Casey Lindqvist", 40],
      ["Avery Quinn", 41],
      ["Blake Morrow", 44],
    ],
  );
  assert.deepEqual(rows[1], {
    [F.date]: "2025-12-02",
    [F.name]: "Avery Quinn",
    [F.shiftId]: items[1].shiftId,
    [F.reason]: L.importSameDayAlert(),
    [F.raisedAt]: NOW,
    [F.reviewed]: false,
    [F.source]: "import",
    [F.logRow]: 41,
  });
  assert.equal(rows[1][F.source], L.flagSources().import);
  // flagged holds the unmatched name keys only.
  assert.deepEqual([...flagged], ["casey|lindqvist"]);
});

test("the block's log line", () => {
  const result = { written: new Array(250), sameDay: 4, ledgerAdded: 2 };
  assert.equal(
    L.importBlockLog(3, 8, result, 2840),
    "Import block 3 of 8: 250 rows written, 4 same day, 2 ledger repairs, 2840 ms under the lock",
  );
});

// Flags with one used row, then rows that hold only an unticked Reviewed box, as setup
// leaves them.
const FLAGS_IN_USE = [
  FLAG_HEADER,
  [
    "2026-11-01",
    "Someone",
    "kiosk-0",
    "arrival differs by 20 min",
    "",
    false,
    "",
    "",
    "kiosk check-in",
    2,
  ],
  ...Array.from({ length: 3 }, () => ["", "", "", "", "", false, "", "", "", ""]),
];
const kioskRow = (shiftId, token, status, date) => [shiftId, token, status, date];

test("Import brings in a same-day row with its alert and a Flags row under the last used one", () => {
  const s = server({
    log: [
      LOG_HEADER,
      kioskRow("kiosk-1", "tok-avery", "closed", "2025-12-02"),
      kioskRow("", "tok-blake", "Open", "2026-02-10 9:00"),
    ],
    flags: FLAGS_IN_USE,
  });
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.equal(preview.sameDay, 2);
  assert.deepEqual(preview.sameDayRows, [
    { name: "Avery Quinn", date: "2025-12-02", row: 2 },
    { name: "Blake Morrow", date: "2026-02-10", row: 10 },
  ]);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 13);
  assert.equal(reply.sameDay, 2);
  assert.equal(reply.flags, 7);
  assert.equal(reply.flagsFailed, 0);

  const log = s.sheets.Log.records();
  const alert = L.importSameDayAlert();
  const avery = log[2];
  assert.equal(avery["Volunteer Name"], "Avery Quinn");
  assert.equal(avery.Date, "2025-12-02");
  assert.equal(avery["Admin Alerts?"], alert);
  const blake = log.find((r) => r.Date === "2026-02-10" && r["Shift ID"].startsWith("import-"));
  assert.equal(blake["Admin Alerts?"], alert);
  // Blake on 2025-12-02 has no kiosk shift that day.
  const otherBlake = log.find(
    (r) => r.Date === "2025-12-02" && r["Volunteer Name"] === "Blake Morrow",
  );
  assert.equal(otherBlake["Admin Alerts?"], "");
  assert.equal(log.filter((r) => r["Admin Alerts?"] === alert).length, 2);

  // The new rows start right under the last used Flags row, over the unticked boxes.
  const flags = s.sheets.Flags.records();
  assert.equal(flags[0]["Shift ID"], "kiosk-0");
  assert.deepEqual(
    flags.slice(1).map((f) => [f["Volunteer Name"], f["Log Row"]]),
    [
      ["Avery Quinn", 4],
      ["Jordan Vale", 6],
      ["Kit", 8],
      ["Casey Lindqvist", 9],
      ["Lee / Max Fenn", 11],
      ["Blake Morrow", 12],
      ["R. Tamsin", 16],
    ],
  );
  assert.equal(s.sheets.Flags.getLastRow(), 9);
  const same = flags[1];
  assert.equal(same.Reason, alert);
  assert.equal(same.Date, "2025-12-02");
  assert.equal(same["Shift ID"], avery["Shift ID"]);
  assert.equal(same.Source, "import");
  assert.equal(same.Reviewed, false);
  assert.equal(same["Raised At"].getTime(), NOW);
  assert.equal(s.sheets.Log.rows[same["Log Row"] - 1][0], avery["Shift ID"]);

  // Again: nothing written, and no second flag.
  const ledger = s.sheets["Import ledger"];
  const before = JSON.stringify([s.sheets.Log.rows, ledger.rows, s.sheets.Flags.rows]);
  const again = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(again.imported, 0);
  assert.equal(again.flags, 0);
  assert.equal(again.sameDay, 0);
  assert.equal(JSON.stringify([s.sheets.Log.rows, ledger.rows, s.sheets.Flags.rows]), before);
});

test("the ledger repair path writes no Flags row", () => {
  const s = server({ log: [LOG_HEADER, kioskRow("kiosk-1", "tok-avery", "closed", "2025-12-02")] });
  assert.equal(plain(s.ctx.adminImportRun("k", FORM)).sameDay, 1);
  const ledger = s.sheets["Import ledger"];
  // Avery's same-day line, and the next three, are lost.
  ledger.rows.splice(1, 4);
  const flagsBefore = JSON.stringify(s.sheets.Flags.rows);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 0);
  assert.equal(reply.ledgerAdded, 4);
  assert.equal(reply.flags, 0);
  assert.equal(reply.sameDay, 0);
  assert.equal(JSON.stringify(s.sheets.Flags.rows), flagsBefore);
});

/** Source rows for Avery Quinn on n days from 2025-01-01, one row a day. */
const averyDays = (n) =>
  Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    return [date, "Avery", "Quinn", 2, "", ""];
  });

test("each block looks at the Log again: a kiosk shift added between blocks is seen by the next", () => {
  const rows = averyDays(251);
  const first = rows[0][0];
  const last = rows[250][0];
  let s;
  s = server({
    source: [SOURCE_HEADER, ...rows],
    lock: (n) => {
      // Before the second block: kiosk shifts on the first item's day and the last item's.
      if (n === 2) {
        s.sheets.Log.rows.push(kioskRow("kiosk-a", "tok-avery", "closed", first));
        s.sheets.Log.rows.push(kioskRow("kiosk-b", "tok-avery", "closed", last));
      }
      return true;
    },
  });
  assert.equal(s.ctx.importBlockSize(), 250);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.done, true);
  assert.equal(reply.imported, 251);
  assert.equal(reply.summary.sameDay, 0);
  assert.equal(reply.sameDay, 1);
  assert.equal(reply.flags, 1);
  const flags = s.sheets.Flags.records();
  assert.equal(flags.length, 1);
  assert.equal(flags[0].Date, last);
  const log = s.sheets.Log.records();
  const imported = (date) =>
    log.find((r) => r.Date === date && r["Shift ID"].startsWith("import-"));
  assert.equal(imported(first)["Admin Alerts?"], "");
  assert.equal(imported(last)["Admin Alerts?"], L.importSameDayAlert());
  // One log line per block.
  assert.deepEqual(s.logs, [
    "Import block 1 of 2: 250 rows written, 0 same day, 0 ledger repairs, 0 ms under the lock",
    "Import block 2 of 2: 1 rows written, 1 same day, 0 ledger repairs, 0 ms under the lock",
  ]);
});

test("a block reads the Log the same number of times for 1 row as for 3", () => {
  const reads = (n) => {
    const s = server({
      source: [SOURCE_HEADER, ...averyDays(n)],
      log: [LOG_HEADER, kioskRow("kiosk-1", "tok-avery", "closed", "2025-01-02")],
    });
    const reply = plain(s.ctx.adminImportRun("k", FORM));
    assert.equal(reply.imported, n);
    assert.equal(reply.sameDay, n >= 2 ? 1 : 0);
    assert.equal(s.logs.length, 1);
    return s.sheets.Log.valueReads;
  };
  assert.equal(reads(1), reads(3));
});

test("a shift on Removed shifts gives no flag", () => {
  const s = server({
    removed: [
      ["Removed At", "Removed By", "Shift ID", "User Token", "Status", "Date"],
      ["", "JP", "kiosk-1", "tok-avery", "closed", "2025-12-02"],
    ],
  });
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.sameDay, 0);
  assert.equal(reply.flags, 5);
  assert.ok(!s.sheets.Log.records().some((r) => r["Admin Alerts?"] === L.importSameDayAlert()));
});

test("a Flags tab that can't be written still leaves the same-day alert on the Log", () => {
  const s = server({
    flags: null,
    log: [LOG_HEADER, kioskRow("kiosk-1", "tok-avery", "closed", "2025-12-02")],
  });
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 13);
  assert.equal(reply.sameDay, 1);
  assert.equal(reply.flags, 0);
  assert.equal(reply.flagsFailed, 6);
  assert.equal(s.sheets["Import ledger"].getLastRow(), 14);
  assert.equal(s.sheets.Log.records()[1]["Admin Alerts?"], L.importSameDayAlert());
  assert.match(s.errors.join("\n"), /Flags: not copied/);
});

test("a same-day row spelt differently in the old sheet is named as on Profiles", () => {
  const s = server({
    source: [SOURCE_HEADER, ["2025-12-02", "avery ", " QUINN", 3, "2025.12", "C3"]],
    log: [LOG_HEADER, kioskRow("kiosk-1", "tok-avery", "closed", "2025-12-02")],
  });
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.equal(preview.matched, 1);
  assert.deepEqual(preview.sameDayRows, [{ name: "Avery Quinn", date: "2025-12-02", row: 2 }]);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.imported, 1);
  assert.equal(reply.sameDay, 1);
  assert.equal(reply.flags, 1);
  const row = s.sheets.Log.records()[1];
  assert.equal(row["Volunteer Name"], "Avery Quinn");
  assert.equal(row["Admin Alerts?"], L.importSameDayAlert());
  const flags = s.sheets.Flags.records();
  assert.equal(flags.length, 1);
  assert.equal(flags[0]["Volunteer Name"], "Avery Quinn");
  assert.equal(flags[0].Reason, L.importSameDayAlert());
  assert.equal(flags[0]["Shift ID"], row["Shift ID"]);
});

test("a Log Date cell holding a date value counts on its Central day", () => {
  // 21:00 Central on 2025-12-02, which is already 2025-12-03 in UTC.
  const evening = new Date("2025-12-03T03:00:00Z");
  const s = server({ log: [LOG_HEADER, kioskRow("kiosk-1", "tok-avery", "closed", evening)] });
  const preview = plain(s.ctx.adminImportPreview("k", FORM)).summary;
  assert.equal(preview.sameDay, 1);
  assert.deepEqual(preview.sameDayRows, [{ name: "Avery Quinn", date: "2025-12-02", row: 2 }]);
  const reply = plain(s.ctx.adminImportRun("k", FORM));
  assert.equal(reply.sameDay, 1);
  const flags = s.sheets.Flags.records().filter((f) => f.Reason === L.importSameDayAlert());
  assert.deepEqual(
    flags.map((f) => [f.Date, f["Volunteer Name"]]),
    [["2025-12-02", "Avery Quinn"]],
  );
});

// ---------------------------------------------------------------------------
// The missed check-out notice skips imported rows

test("the missed check-out notice never counts an imported row", () => {
  const HOUR = 3600000;
  const day = (date, hour) =>
    Date.parse(date + "T" + String(hour + 6).padStart(2, "0") + ":00:00Z");
  const kiosk = (row, date, outBy) => ({
    row,
    shiftId: "kiosk-" + row,
    token: "tok-avery",
    dateText: date,
    recordedInMs: day(date, 9),
    statedInMs: day(date, 9),
    status: "closed",
    outBy,
  });
  const paper = (row, date, shiftId = "import-0123456789abcdef") => ({
    row,
    shiftId,
    token: "tok-avery",
    dateText: date,
    recordedInMs: NaN,
    statedInMs: NaN,
    status: "closed",
    outBy: "import",
  });
  // Every row is dated on or after the launch date and not after today, so the date filter
  // keeps them all and only the import mark can leave a row out.
  const dates = ["2026-11-09", "2026-11-10"];
  dates.forEach((d) => assert.ok(LAUNCH <= d && d <= TODAY, d));
  const missed = (entries) => L.missedSignOut(entries, "tok-avery", LAUNCH);
  const asKiosk = (e) => ({ ...e, shiftId: "kiosk-" + e.row });

  // The only row on or after launch is an imported one.
  const only = [paper(5, "2026-11-10")];
  assert.equal(missed(only), false);
  assert.equal(missed(only.map(asKiosk)), true, "the same row without the import mark");
  // Any capitals.
  assert.equal(missed([paper(5, "2026-11-10", " IMPORT-ABC")]), false);

  // A missed kiosk row, then a later imported row: the notice shows.
  assert.equal(missed([kiosk(2, "2026-11-09", "auto-close"), paper(5, "2026-11-10")]), true);

  // A kiosk row checked out at the tablet, then a later imported row: no notice.
  const later = [kiosk(2, "2026-11-09", "kiosk"), paper(5, "2026-11-10")];
  assert.equal(missed(later), false);
  assert.equal(missed(later.map(asKiosk)), true, "the same rows without the import mark");

  // Both on the same day: the imported row has no times, so it sorts last that day.
  const sameDay = [kiosk(2, "2026-11-10", "kiosk"), paper(5, "2026-11-10")];
  assert.equal(sameDay.slice().sort(L.reportRowOrder).at(-1).row, 5);
  assert.equal(missed(sameDay), false);
  assert.equal(missed(sameDay.map(asKiosk)), true, "the same rows without the import mark");

  // Through decideCheckIn, as the tablet calls it.
  const checkIn = (entries) =>
    L.decideCheckIn({
      volunteers: [VOLUNTEERS[0]],
      id: "a1",
      digits: null,
      entries,
      todayDate: TODAY,
      nowMs: NOW,
      windowMs: 12 * HOUR,
      arrivedMs: null,
      arrivedDate: "",
      flagMinutes: 15,
      launchDate: LAUNCH,
    }).missedSignOut;
  assert.equal(checkIn(sameDay), false);
  assert.equal(checkIn(only), false);
  assert.equal(checkIn([kiosk(2, "2026-11-09", "auto-close"), paper(5, "2026-11-10")]), true);
  assert.equal(checkIn(sameDay.map(asKiosk)), true);
});
