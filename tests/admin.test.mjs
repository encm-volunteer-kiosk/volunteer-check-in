// Tests for apps-script/Admin.js, the Kiosk admin menu, the public functions of
// apps-script/Reports.js, which the menu's Monthly report item calls, and the guard on the
// public functions of apps-script/Jobs.js, the daily jobs. The server files are loaded into
// one global scope, as Apps Script loads them, with stand-ins for the Google services
// that record every call. Two kinds of test:
//
// - The guard. Every public function in Admin.js, Reports.js and Jobs.js (a top-level
//   function whose name doesn't end in _) can be named by the kiosk page through
//   google.script.run. Each must check that the person at the sheet runs it, and that it
//   holds a dialog key the spreadsheet's menu issued, before it reads or writes anything.
//   Three kinds are exempt from the key only: the dialog openers, which make it; the
//   functions run from the editor as setupSheets is (setupReports, setupDailyJobs,
//   removeDailyJobs); and the trigger handlers, which check the trigger's id instead. The
//   list of functions comes from the files' source, so a public function added later is
//   held to the same rule.
// - The glue: the admin functions read and write an in-memory Log through Sheets.js, and
//   the kiosk's check-in and check-out copy their flags to an in-memory Flags tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SERVER_FILES = [
  "Logic.js",
  "Sheets.js",
  "Api.js",
  "Admin.js",
  "Reports.js",
  "Jobs.js",
  "Import.js",
].map((f) => [f, read("apps-script/" + f)]);
const GUARDED_FILES = ["Admin.js", "Reports.js", "Jobs.js", "Import.js"].map((f) => [
  f,
  read("apps-script/" + f),
]);

const plain = (x) => JSON.parse(JSON.stringify(x));
const TZ = "America/Chicago";
// The Flags tab, with a staff column between the script's headers.
const FLAG_HEADER = [
  "Shift ID",
  "Date",
  "Volunteer Name",
  "Reason",
  "Staff column",
  "Raised At",
  "Reviewed",
  "Reviewed By",
  "Notes",
  "Source",
  "Log Row",
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
/** "yyyy-MM-dd HH:mm" Central to milliseconds. */
const centralMs = (text) => {
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let ms = want + 6 * 3600000;
  for (let i = 0; i < 2; i++) {
    const p = centralParts(ms);
    ms += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return ms;
};
const clock = (ms) => {
  const p = centralParts(ms);
  const h = +p.hour;
  return (h % 12 || 12) + ":" + p.minute + " " + (h < 12 ? "AM" : "PM");
};

// ---------------------------------------------------------------------------
// Stand-ins for the Google services

/**
 * A sheet held as rows of cells; row and column numbers are 1-based, as in Apps Script.
 * A write past the last grid row (maxRows) fails, as it does in Sheets, so an append must
 * grow the sheet with insertRowsAfter first.
 */
class FakeSheet {
  constructor(rows, maxRows = 1000) {
    this.rows = rows.map((r) => r.slice());
    this.formats = {};
    this.maxRows = maxRows;
    this.inserted = [];
    // Data validations by "row:col".
    this.validations = {};
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
    this.inserted.push(count);
    this.maxRows += count;
  }
  put(row, col, value) {
    assert.ok(row <= this.maxRows, "write past the last grid row " + this.maxRows + ": " + row);
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1];
    while (r.length < col) r.push("");
    r[col - 1] = value;
  }
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn());
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
        sheet.formats[row + ":" + col] = format;
        return range;
      },
      setValue: (value) => {
        sheet.put(row, col, value);
        return range;
      },
      setValues: (values) => {
        assert.equal(values.length, rows, "setValues row count");
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
      setDataValidation: (rule) => {
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) sheet.validations[row + i + ":" + (col + j)] = rule;
        }
        return range;
      },
    };
    return range;
  }
  /** One row as {normalized header: value}. */
  rowByHeader(row) {
    const out = {};
    this.rows[0].forEach((h, i) => {
      if (h) out[String(h).replace(/\s+/g, " ")] = (this.rows[row - 1] || [])[i] ?? "";
    });
    return out;
  }
}

/**
 * A fresh server scope. calls records every service call as "Service.method" in order.
 * opts: active and effective (the two Session emails), ui (false: getUi throws), log and
 * settings (rows), volunteers (the cached Profiles list), keys (dialog keys already
 * issued), flags (the Flags tab's rows, FLAG_HEADER alone by default; null for no Flags
 * tab), flagsMaxRows (its last grid row), now (a fixed server clock, in ms), onFlush
 * (run on each SpreadsheetApp.flush), triggers (this account's project triggers, as
 * [{uid, handler}]). errors collects what the server logs with console.error.
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const errors = [];
  const sheets = {
    Log: new FakeSheet(opts.log || [[]]),
    Flags:
      opts.flags === null
        ? undefined
        : new FakeSheet(opts.flags || [FLAG_HEADER], opts.flagsMaxRows ?? 1000),
    Settings: new FakeSheet(
      opts.settings || [
        ["Setting", "Value"],
        ["Volunteer Profiles file ID", "file-1"],
        ["Volunteer Profiles tab", "Volunteer Profiles"],
      ],
    ),
  };
  const shown = [];
  const menu = [];
  let uuid = 0;

  /** A service whose every method call is recorded; a method it lacks throws. */
  const service = (name, methods) =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop !== "string") return undefined;
          return (...args) => {
            calls.push(name + "." + prop);
            if (!methods[prop]) throw new Error("unexpected call " + name + "." + prop);
            return methods[prop](...args);
          };
        },
      },
    );
  const email = (value) => ({ getEmail: () => value });
  const builder = service("menu", {
    addItem: (label, fn) => (menu.push([label, fn]), builder),
    addToUi: () => undefined,
  });

  const ctx = {
    console: { log: console.log, error: (...args) => errors.push(args.join(" ")) },
    Session: service("Session", {
      getActiveUser: () => email(opts.active ?? "staff@example.org"),
      getEffectiveUser: () => email(opts.effective ?? opts.active ?? "staff@example.org"),
    }),
    CacheService: service("CacheService", {
      getScriptCache: () =>
        service("cache", {
          get: (k) => (cache.has(k) ? cache.get(k) : null),
          put: (k, v) => void cache.set(k, v),
        }),
    }),
    ScriptApp: service("ScriptApp", {
      getProjectTriggers: () =>
        (opts.triggers || []).map((t) =>
          service("trigger", {
            getUniqueId: () => t.uid,
            getHandlerFunction: () => t.handler,
          }),
        ),
    }),
    MailApp: service("MailApp", {}),
    LockService: service("LockService", {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    }),
    SpreadsheetApp: service("SpreadsheetApp", {
      getUi: () => {
        if (opts.ui === false)
          throw new Error("Cannot call SpreadsheetApp.getUi() from this context.");
        return {
          createMenu: (title) => (menu.push(title), builder),
          showModalDialog: (output, title) => shown.push({ output, title }),
        };
      },
      getActiveSpreadsheet: () => ({ getSheetByName: (name) => sheets[name] || null }),
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
        if (format === "h:mm a") return clock(date.getTime());
        // A time typed with no date comes back as a date on 1899-12-30 whose Central clock
        // is the time as typed.
        if (format === "HH:mm") {
          const p = centralParts(date.getTime());
          return p.hour + ":" + p.minute;
        }
        throw new Error("format " + format);
      },
      parseDate: (text, tz, format) => {
        assert.equal(tz, TZ);
        assert.equal(format, "yyyy-MM-dd HH:mm");
        return new Date(centralMs(text));
      },
    }),
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
  if (opts.volunteers) {
    cache.set(
      ctx.profilesCacheKey("file-1", "Volunteer Profiles"),
      JSON.stringify(opts.volunteers),
    );
  }
  for (const key of opts.keys || []) cache.set(ctx.adminKeyCacheKey(key), "1");
  calls.length = 0;
  return { ctx, calls, cache, sheets, shown, menu, errors };
}

// ---------------------------------------------------------------------------
// The guard

/** Top-level function names declared in Admin.js, Reports.js and Jobs.js. */
const declared = GUARDED_FILES.flatMap(([, source]) =>
  [...source.matchAll(/^function\s+([\w$]+)\s*\(/gm)].map((m) => m[1]),
);
const PUBLIC = declared.filter((name) => !name.endsWith("_"));
const isOpener = (name) => /^open\w*Dialog$/.test(name);
// Run by hand from the editor, guarded like setupSheets: no dialog, so no key.
const EDITOR_ONLY = ["setupReports", "setupDailyJobs", "removeDailyJobs"];
// Run by a trigger: the trigger's id stands in for the key.
const TRIGGER_ONLY = ["runFlagsEmail"];
const KEYED = PUBLIC.filter(
  (name) =>
    name !== "onOpen" &&
    !isOpener(name) &&
    !EDITOR_ONLY.includes(name) &&
    !TRIGGER_ONLY.includes(name),
);
const onlyFrom = (calls, allowed) =>
  calls.filter((c) => !allowed.some((a) => (a.endsWith(".") ? c.startsWith(a) : c === a)));

test("Admin.js, Reports.js and Jobs.js declare the public functions, and only functions", () => {
  for (const name of [
    ...EDITOR_ONLY,
    ...TRIGGER_ONLY,
    "onOpen",
    "openAddShiftDialog",
    "openFixSignOutDialog",
    "adminRoster",
    "adminOpenShifts",
    "adminAddShift",
    "adminFixSignOut",
    "setupReports",
    "openMonthlyReportDialog",
    "adminReportMonths",
    "adminMonthlyReport",
  ]) {
    assert.ok(PUBLIC.includes(name), name);
  }
  for (const name of ["adminReportMonths", "adminMonthlyReport"]) {
    assert.ok(KEYED.includes(name), name);
  }
  const { ctx, calls } = server();
  for (const name of declared) assert.equal(typeof ctx[name], "function", name);
  // Loading the file calls nothing.
  assert.deepEqual(calls, []);
  // Anything at the top level other than a function would be code that runs on every call
  // of the web app too.
  for (const [file, source] of GUARDED_FILES) {
    const topLevel = source.split("\n").filter((line) => /^\S/.test(line));
    for (const line of topLevel) {
      assert.match(line, /^(function |\}|\/\*\*| \*|\/\/)/, file + ": " + line);
    }
  }
});

test("every function the report dialog or menu names is public; every writer is private", () => {
  const html = read("apps-script/Report.html");
  const called = [...html.matchAll(/call\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(called.sort(), ["adminMonthlyReport", "adminReportMonths"]);
  for (const name of called) assert.ok(KEYED.includes(name), name);
  // The Sheets-writing helpers end in _, so google.script.run can't name them.
  const reports = GUARDED_FILES.find(([f]) => f === "Reports.js")[1];
  const reportPublic = [...reports.matchAll(/^function\s+([\w$]+)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith("_"));
  assert.deepEqual(reportPublic.sort(), [
    "adminMonthlyReport",
    "adminReportMonths",
    "openMonthlyReportDialog",
    "setupReports",
  ]);
});

test("ImportDialog.html calls only keyed functions; Import.js's other public name is its opener", () => {
  const html = read("apps-script/ImportDialog.html");
  const called = [...html.matchAll(/call\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ["adminImportPreview", "adminImportRun"]);
  for (const name of called) assert.ok(KEYED.includes(name), name);
  // Every server call goes through call(), which passes the key first.
  assert.equal(html.match(/google\.script\.run/g).length, 1);
  assert.match(html, /\[name\]\(KEY, \.\.\.args\)/);
  const source = GUARDED_FILES.find(([f]) => f === "Import.js")[1];
  const importPublic = [...source.matchAll(/^function\s+([\w$]+)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith("_"));
  assert.deepEqual(importPublic.sort(), [
    "adminImportPreview",
    "adminImportRun",
    "openImportDialog",
  ]);
});

test("every public admin function refuses a caller who isn't the person at the sheet, before anything else", () => {
  const callers = [
    { active: "" },
    { active: "owner@example.org", effective: "someone@example.org" },
  ];
  for (const name of PUBLIC.filter((n) => n !== "onOpen")) {
    for (const who of callers) {
      const { ctx, calls } = server({ ...who, keys: ["good"] });
      assert.throws(
        () => ctx[name]("good", { id: "x" }),
        /Run this from the Apps Script editor/,
        name,
      );
      assert.deepEqual(onlyFrom(calls, ["Session."]), [], name);
    }
  }
});

test("every keyed admin function refuses a missing or unknown key before it reads or writes", () => {
  assert.ok(KEYED.length >= 4);
  for (const name of KEYED) {
    for (const key of [undefined, null, "", "  ", "bogus", { key: "good" }]) {
      const { ctx, calls } = server({ keys: ["good"] });
      const reply = plain(ctx[name](key, { id: "x", shiftId: "x" }));
      assert.deepEqual(reply, plain(ctx.refusal("ADMIN_EXPIRED")), name + " " + key);
      assert.deepEqual(
        onlyFrom(calls, ["Session.", "CacheService.getScriptCache", "cache.get"]),
        [],
        name,
      );
    }
  }
});

test("Jobs.js's public functions are the editor-run setup and the trigger handlers", () => {
  const jobs = GUARDED_FILES.find(([f]) => f === "Jobs.js")[1];
  const jobsPublic = [...jobs.matchAll(/^function\s+([\w$]+)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith("_"));
  assert.deepEqual(jobsPublic.sort(), ["removeDailyJobs", "runFlagsEmail", "setupDailyJobs"]);
  // Every daily job's handler is a trigger-only public function.
  const { ctx } = server();
  for (const job of plain(ctx.dailyJobs()))
    assert.ok(TRIGGER_ONLY.includes(job.handler), job.handler);
});

test("every trigger handler refuses a missing, forged or another account's trigger id before it reads or writes", () => {
  // This account's triggers: one for each handler, and one for something else.
  const triggers = [
    ...TRIGGER_ONLY.map((handler, i) => ({ uid: "own-" + i, handler })),
    { uid: "own-other", handler: "someOtherFunction" },
  ];
  for (const name of TRIGGER_ONLY) {
    const events = [
      undefined,
      null,
      "own-0",
      {},
      { triggerUid: "" },
      { triggerUid: "forged" },
      // Another account's trigger: getProjectTriggers never lists it.
      { triggerUid: "other-account-1" },
      // This account's trigger, but for another handler.
      { triggerUid: "own-other" },
    ];
    for (const e of events) {
      const { ctx, calls } = server({ triggers });
      assert.throws(
        () => ctx[name](e),
        /runs only from its trigger/,
        name + " " + JSON.stringify(e),
      );
      assert.deepEqual(
        onlyFrom(calls, ["Session.", "ScriptApp.getProjectTriggers", "trigger."]),
        [],
        name,
      );
    }
  }
});

test("the dialog openers issue no key outside the spreadsheet's UI", () => {
  for (const name of PUBLIC.filter(isOpener)) {
    const { ctx, calls, cache } = server({ ui: false });
    assert.throws(() => ctx[name](), /getUi/, name);
    assert.deepEqual(onlyFrom(calls, ["Session.", "SpreadsheetApp.getUi"]), [], name);
    assert.equal(cache.size, 0, name);
  }
});

test("onOpen only adds the menu, and its items name the openers", () => {
  const { ctx, calls, menu } = server({ active: "" });
  assert.equal(ctx.onOpen({}), undefined);
  assert.deepEqual(onlyFrom(calls, ["SpreadsheetApp.getUi", "menu."]), []);
  assert.deepEqual(menu, [
    "Kiosk admin",
    ["Add a shift…", "openAddShiftDialog"],
    ["Fix a sign-out…", "openFixSignOutDialog"],
    ["Monthly report…", "openMonthlyReportDialog"],
    ["Import past hours…", "openImportDialog"],
  ]);
  for (const [, fn] of menu.slice(1)) assert.ok(PUBLIC.filter(isOpener).includes(fn), fn);
  // From the web app it throws at getUi and does nothing else.
  const web = server({ ui: false });
  assert.throws(() => web.ctx.onOpen(), /getUi/);
  assert.deepEqual(onlyFrom(web.calls, ["SpreadsheetApp.getUi"]), []);
});

test("an opener puts a fresh key only into the dialog's HTML, and the key then works", () => {
  const s = server({ volunteers: [] });
  assert.equal(s.ctx.openAddShiftDialog(), undefined);
  assert.equal(s.shown.length, 1);
  const { template } = s.shown[0].output;
  assert.equal(s.shown[0].title, "Add a shift");
  assert.equal(template.file, "AdminDialog");
  assert.equal(template.mode, "add");
  assert.ok(template.key);
  assert.ok(s.cache.has("admin-key:" + template.key));
  assert.equal(s.ctx.adminRoster(template.key).ok, true);

  s.ctx.openFixSignOutDialog();
  assert.equal(s.shown[1].output.template.mode, "fix");
  assert.notEqual(s.shown[1].output.template.key, template.key);
});

test("the Monthly report opener serves Report.html with a fresh key, and the key then works", () => {
  const s = server({ log: [LOG_HEADER] });
  assert.equal(s.ctx.openMonthlyReportDialog(), undefined);
  assert.equal(s.shown.length, 1);
  const { template } = s.shown[0].output;
  assert.equal(s.shown[0].title, "Monthly report");
  assert.equal(template.file, "Report");
  assert.ok(template.key);
  assert.ok(s.cache.has("admin-key:" + template.key));
  const reply = plain(s.ctx.adminReportMonths(template.key));
  assert.equal(reply.ok, true);
  assert.equal(reply.months[0].month, centralDate(Date.now()).slice(0, 7));
});

// ---------------------------------------------------------------------------
// The glue

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
const logRow = (byHeader) =>
  LOG_HEADER.map((h) => {
    const key = h.replace(/\s+/g, " ");
    return key in byHeader ? byHeader[key] : "";
  });
const at = (date, hhmm) => new Date(centralMs(date + " " + hhmm));

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
const RUTH = {
  ...SAM,
  id: "bbbbbbbbbbbbbbbb",
  firstName: "Ruth",
  lastName: "Okafor",
  token: "tok-ruth",
  row: 5,
};

// A past date and today, for rows the menu writes or fixes.
const DAY = "2026-06-01";
const kioskOpen = (shiftId, date, hhmm, token = "tok-sam", name = "Sam Lee") =>
  logRow({
    "Shift ID": shiftId,
    "User Token": token,
    Status: "open",
    Date: date,
    Day: "Monday",
    "Volunteer Name": name,
    Notes: "staff wrote this",
    "Check-In Recorded (timestamp)": at(date, hhmm),
    "Check-In Stated (user)": at(date, hhmm),
    "Check-In Entered By": "kiosk",
  });

test("adminRoster and adminOpenShifts", () => {
  const s = server({
    keys: ["k"],
    volunteers: [SAM, RUTH],
    log: [
      LOG_HEADER,
      kioskOpen("s-1", DAY, "09:00"),
      kioskOpen("s-2", "2026-06-02", "13:30", "tok-ruth", "Ruth Okafor"),
    ],
  });
  const roster = plain(s.ctx.adminRoster("k"));
  assert.equal(roster.today, centralDate(Date.now()));
  assert.deepEqual(roster.volunteers, [
    { id: SAM.id, label: "Sam Lee" },
    { id: RUTH.id, label: "Ruth Okafor" },
  ]);
  assert.deepEqual(plain(s.ctx.adminOpenShifts("k")), {
    ok: true,
    shifts: [
      { shiftId: "s-2", label: "Tue 2026-06-02 · Ruth Okafor · in 1:30 PM" },
      { shiftId: "s-1", label: "Mon 2026-06-01 · Sam Lee · in 9:00 AM" },
    ],
  });
});

const addForm = (fields) => ({
  id: SAM.id,
  date: DAY,
  inTime: "09:00",
  outTime: "11:45",
  note: "emailed Andrea",
  initials: "j.p.",
  ...fields,
});

test("adminAddShift appends a closed row found by header, with stated times only", () => {
  const s = server({ keys: ["k"], volunteers: [SAM], log: [LOG_HEADER] });
  const reply = plain(s.ctx.adminAddShift("k", addForm({})));
  assert.deepEqual(reply, { ok: true, row: 2, name: "Sam Lee", hours: 2.75 });
  const row = s.sheets.Log.rowByHeader(2);
  assert.equal(row["Shift ID"], "uuid-1");
  assert.equal(row["User Token"], "tok-sam");
  assert.equal(row.Status, "closed");
  assert.equal(row.Date, DAY);
  assert.equal(row.Day, "Monday");
  assert.equal(row["Volunteer Name"], "Sam Lee");
  assert.equal(row.Notes, "emailed Andrea");
  assert.equal(row["Check-In Stated (user)"].getTime(), at(DAY, "09:00").getTime());
  assert.equal(row["Check-Out Stated (user)"].getTime(), at(DAY, "11:45").getTime());
  assert.equal(row["Hours Served (stated)"], 2.75);
  assert.equal(row["Check-In Entered By"], "JP");
  assert.equal(row["Check-Out Entered By"], "JP");
  for (const blank of [
    "Check-In Recorded (timestamp)",
    "Check-Out Recorded (timestamp)",
    "Hours Served (timestamps)",
    "Admin Alerts?",
    "Staff column",
    "Volunteer Role/Type",
    "Activity",
  ]) {
    assert.equal(row[blank], "", blank);
  }
  // Each written cell got its column's format first.
  const col = (h) => LOG_HEADER.indexOf(h) + 1;
  assert.equal(
    s.sheets.Log.formats["2:" + col("Check-In\nStated\n(user)")],
    "yyyy-mm-dd h:mm am/pm",
  );
  assert.equal(s.sheets.Log.formats["2:" + col("Hours Served\n(stated)")], "0.00");
  assert.equal(s.sheets.Log.formats["2:" + col("User Token")], "@");
  // The work ran under the lock.
  assert.ok(s.calls.includes("LockService.getScriptLock"));
});

test("adminAddShift refusals reach the dialog with their messages, and write nothing", () => {
  const s = server({
    keys: ["k"],
    volunteers: [SAM],
    log: [
      LOG_HEADER,
      logRow({
        "Shift ID": "s-1",
        "User Token": "tok-sam",
        Status: "closed",
        Date: DAY,
        "Check-In Stated (user)": at(DAY, "10:00"),
        "Check-Out Stated (user)": at(DAY, "12:30"),
        "Hours Served (stated)": 2.5,
      }),
    ],
  });
  const before = JSON.stringify(s.sheets.Log.rows);
  const cases = [
    [{ initials: "1" }, "ADMIN_INITIALS"],
    [{ id: "nobody" }, "ADMIN_NOT_FOUND"],
    [{ inTime: "25:00" }, "ADMIN_BAD_TIME"],
    [{ date: "2026-02-30" }, "ADMIN_BAD_TIME"],
    [{ date: "2999-01-01" }, "ADMIN_FUTURE"],
    [{ outTime: "08:00" }, "ADMIN_OUT_BEFORE_IN"],
  ];
  for (const [fields, code] of cases) {
    const reply = plain(s.ctx.adminAddShift("k", addForm(fields)));
    assert.deepEqual(reply, plain(s.ctx.refusal(code)), code);
  }
  const overlap = plain(s.ctx.adminAddShift("k", addForm({})));
  assert.equal(overlap.refusal, "ADMIN_OVERLAP");
  assert.match(overlap.message, /The other shift is 10:00 AM to 12:30 PM, on Log row 2\.$/);
  assert.equal(JSON.stringify(s.sheets.Log.rows), before);
});

test("adminAddShift with a note throws when the Log has no Notes column, before any write", () => {
  const header = LOG_HEADER.filter((h) => h !== "Notes");
  const s = server({ keys: ["k"], volunteers: [SAM], log: [header] });
  assert.throws(() => s.ctx.adminAddShift("k", addForm({})), /no "notes" column/);
  assert.equal(s.sheets.Log.getLastRow(), 1);
  assert.equal(plain(s.ctx.adminAddShift("k", addForm({ note: "" }))).ok, true);
});

test("adminFixSignOut closes the row found by Shift ID, on that row's date", () => {
  const s = server({
    keys: ["k"],
    log: [
      LOG_HEADER,
      kioskOpen("s-other", DAY, "08:00", "tok-ruth"),
      kioskOpen("s-1", DAY, "09:00"),
    ],
  });
  const reply = plain(
    s.ctx.adminFixSignOut("k", {
      shiftId: "s-1",
      outTime: "12:15",
      note: "left at noon",
      initials: "ab",
    }),
  );
  assert.deepEqual(reply, { ok: true, row: 3, name: "Sam Lee", hours: 3.25 });
  const row = s.sheets.Log.rowByHeader(3);
  assert.equal(row.Status, "closed");
  assert.equal(row["Check-Out Stated (user)"].getTime(), at(DAY, "12:15").getTime());
  assert.equal(row["Hours Served (stated)"], 3.25);
  assert.equal(row["Check-Out Entered By"], "AB");
  assert.equal(row["Check-In Entered By"], "kiosk");
  assert.equal(row.Notes, "staff wrote this; left at noon");
  assert.equal(row["Check-Out Recorded (timestamp)"], "");
  assert.equal(row["Hours Served (timestamps)"], "");
  // The other open row is untouched.
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  // Fixing it again: no longer open.
  assert.equal(
    plain(s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "12:15", initials: "ab" })).refusal,
    "ADMIN_NOT_OPEN",
  );
});

test("adminFixSignOut on a row inside a menu shift names the shift to fix first", () => {
  const s = server({
    keys: ["k"],
    log: [
      LOG_HEADER,
      logRow({
        "Shift ID": "s-menu",
        "User Token": "tok-sam",
        Status: "closed",
        Date: DAY,
        "Check-In Stated (user)": at(DAY, "08:00"),
        "Check-Out Stated (user)": at(DAY, "11:00"),
        "Hours Served (stated)": 3,
        "Check-In Entered By": "JP",
        "Check-Out Entered By": "JP",
      }),
      kioskOpen("s-1", DAY, "10:00"),
    ],
  });
  const reply = plain(
    s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "13:00", initials: "ab" }),
  );
  assert.equal(reply.refusal, "ADMIN_OVERLAP");
  assert.match(reply.message, /The other shift is 8:00 AM to 11:00 AM, on Log row 2\./);
  assert.match(reply.message, /This open shift starts at 10:00 AM, inside that one/);
  assert.equal(s.sheets.Log.rowByHeader(3).Status, "open");
});

test("adminFixSignOut refuses a row whose check-in time can't be read", () => {
  const broken = kioskOpen("s-1", DAY, "09:00");
  // Text that is neither a time of day nor a date-time can't be read.
  broken[LOG_HEADER.indexOf("Check-In\nStated\n(user)")] = "9ish";
  broken[LOG_HEADER.indexOf("Check-In\nRecorded\n(timestamp)")] = "";
  const s = server({ keys: ["k"], log: [LOG_HEADER, broken] });
  const reply = plain(
    s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "12:00", initials: "ab" }),
  );
  assert.equal(reply.refusal, "ADMIN_BAD_ROW");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
});

// ---------------------------------------------------------------------------
// The kiosk's flags on the Flags tab

const CODE = "lettersonlylettersonly";
const KIOSK_SETTINGS = [
  ["Setting", "Value"],
  ["Volunteer Profiles file ID", "file-1"],
  ["Volunteer Profiles tab", "Volunteer Profiles"],
  ["Kiosk access code", CODE],
];
const TODAY = "2026-11-12";
const NOW = centralMs(TODAY + " 10:00");
const minutesBefore = (n) => new Date(NOW - n * 60000).toISOString();
const kiosk = (opts) =>
  server({ now: NOW, settings: KIOSK_SETTINGS, volunteers: [SAM], log: [LOG_HEADER], ...opts });

test("apiCheckIn with an arrival flag appends one Flags row with the Log's text", () => {
  const s = kiosk({});
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null));
  assert.equal(reply.ok, true);
  assert.equal(reply.shiftId, "uuid-1");
  const log = s.sheets.Log.rowByHeader(2);
  assert.equal(log["Admin Alerts?"], "arrival differs by 24 min");

  const flags = s.sheets.Flags;
  assert.equal(flags.getLastRow(), 2);
  const row = flags.rowByHeader(2);
  assert.equal(row["Raised At"].getTime(), NOW);
  delete row["Raised At"];
  assert.deepEqual(row, {
    "Shift ID": "uuid-1",
    Date: TODAY,
    "Volunteer Name": "Sam Lee",
    Reason: log["Admin Alerts?"],
    "Staff column": "",
    Reviewed: false,
    "Reviewed By": "",
    Notes: "",
    Source: "kiosk check-in",
    "Log Row": 2,
  });
  // No User Token on the Flags tab.
  assert.ok(!flags.rows[1].includes("tok-sam"));
  // The new Reviewed cell has the tickbox; each script column its format.
  const col = (h) => FLAG_HEADER.indexOf(h) + 1;
  assert.deepEqual(flags.validations, { ["2:" + col("Reviewed")]: "checkbox" });
  assert.equal(flags.formats["2:" + col("Raised At")], "yyyy-mm-dd h:mm am/pm");
  assert.equal(flags.formats["2:" + col("Log Row")], "0");
  assert.equal(flags.formats["2:" + col("Shift ID")], "@");
  assert.equal(flags.formats["2:" + col("Staff column")], "", "a staff column keeps its format");
  assert.deepEqual(s.errors, []);
  assert.deepEqual(flags.inserted, []);

  // A check-in with nothing flagged appends no Flags row.
  const quiet = kiosk({});
  assert.equal(plain(quiet.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(quiet.sheets.Flags.getLastRow(), 1);
});

test("apiCheckIn with the Flags tab missing still writes the Log row and logs the Shift ID", () => {
  const s = kiosk({ flags: null });
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null));
  assert.equal(reply.ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2)["Admin Alerts?"], "arrival differs by 24 min");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  assert.deepEqual(s.errors, [
    'Flags: not copied for Shift ID uuid-1: The "Flags" tab is missing. Run setupSheets().',
  ]);
});

test("a Flags builder that throws is caught: the check-in stands and the error is logged", () => {
  const s = kiosk({});
  s.ctx.flagRows = () => {
    throw new Error("builder broke");
  };
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null));
  assert.equal(reply.ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.deepEqual(s.errors, ["Flags: not copied for Shift ID uuid-1: builder broke"]);
});

test("a Log write that fails still fails the check-in; the Flags step doesn't swallow it", () => {
  const s = kiosk({
    onFlush: () => {
      throw new Error("Log write failed");
    },
  });
  assert.throws(() => s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null), /Log write failed/);
  assert.deepEqual(s.errors, []);
  assert.equal(s.sheets.Flags.getLastRow(), 1);
});

test("apiCheckOut with two flags on a full Flags tab grows it and writes both rows", () => {
  // Today's open row with both check-in times blank: no readable start.
  const open = logRow({
    "Shift ID": "s-open",
    "User Token": "tok-sam",
    Status: "open",
    Date: TODAY,
    "Volunteer Name": "Sam Lee",
    "Check-In Entered By": "kiosk",
  });
  const earlier = FLAG_HEADER.map((h) =>
    h === "Shift ID" ? "s-old" : h === "Reviewed" ? true : "",
  );
  const s = kiosk({ log: [LOG_HEADER, open], flags: [FLAG_HEADER, earlier], flagsMaxRows: 2 });
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.equal(reply.ok, true);
  const log = s.sheets.Log.rowByHeader(2);
  assert.equal(log.Status, "closed");
  assert.equal(
    log["Admin Alerts?"],
    "check-out differs by 30 min; check-in time unreadable, stated hours left blank",
  );

  const flags = s.sheets.Flags;
  assert.deepEqual(flags.inserted, [50], "the append grew the tab before writing");
  assert.equal(flags.getLastRow(), 4);
  const reasons = [3, 4].map((r) => flags.rowByHeader(r));
  assert.deepEqual(
    reasons.map((r) => r.Reason),
    ["check-out differs by 30 min", "check-in time unreadable, stated hours left blank"],
  );
  for (const r of reasons) {
    assert.equal(r["Shift ID"], "s-open");
    assert.equal(r.Date, TODAY);
    assert.equal(r["Volunteer Name"], "Sam Lee");
    assert.equal(r.Source, "kiosk check-out");
    assert.equal(r["Log Row"], 2);
    assert.equal(r.Reviewed, false);
    assert.equal(r["Raised At"].getTime(), NOW);
  }
  const reviewed = FLAG_HEADER.indexOf("Reviewed") + 1;
  assert.deepEqual(flags.validations, {
    ["3:" + reviewed]: "checkbox",
    ["4:" + reviewed]: "checkbox",
  });
  // The row staff ticked is untouched.
  assert.equal(flags.rowByHeader(2).Reviewed, true);
  assert.deepEqual(s.errors, []);
});

test("apiCheckOut with nothing flagged appends no Flags row", () => {
  const open = kioskOpen("s-open", TODAY, "08:00");
  const s = kiosk({ log: [LOG_HEADER, open] });
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.deepEqual(s.errors, []);
});

test("the admin menu's Add a shift and Fix a sign-out leave the Flags tab untouched", () => {
  const s = server({
    keys: ["k"],
    volunteers: [SAM],
    log: [LOG_HEADER, kioskOpen("s-1", "2026-06-02", "09:00")],
  });
  const before = JSON.stringify(s.sheets.Flags);
  assert.equal(plain(s.ctx.adminAddShift("k", addForm({}))).ok, true);
  assert.equal(
    plain(s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "12:15", initials: "ab" })).ok,
    true,
  );
  assert.equal(JSON.stringify(s.sheets.Flags), before);
  assert.ok(!s.calls.includes("SpreadsheetApp.newDataValidation"));
  assert.deepEqual(s.errors, []);
});

test("apiCheckOut on a row whose Date was typed as text writes the Flags Date as yyyy-MM-dd", () => {
  const open = logRow({
    "Shift ID": "s-open",
    "User Token": "tok-sam",
    Status: "open",
    Date: "11/12/2026",
    "Volunteer Name": "Sam Lee",
    "Check-In Entered By": "kiosk",
  });
  const s = kiosk({ log: [LOG_HEADER, open] });
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.equal(reply.ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  const flags = s.sheets.Flags;
  assert.ok(flags.getLastRow() >= 2);
  for (let r = 2; r <= flags.getLastRow(); r++) {
    assert.equal(flags.rowByHeader(r).Date, TODAY);
  }
  // The Log cell keeps what staff typed.
  assert.equal(s.sheets.Log.rowByHeader(2).Date, "11/12/2026");
});

test("adminFixSignOut closes a row whose check-in was typed as a time with no date", () => {
  const typed = kioskOpen("s-1", DAY, "09:00");
  // Sheets keeps "9:00 AM" typed into the cell as 9:00 on 1899-12-30.
  typed[LOG_HEADER.indexOf("Check-In\nStated\n(user)")] = at("1899-12-30", "09:00");
  typed[LOG_HEADER.indexOf("Check-In\nRecorded\n(timestamp)")] = "";
  const s = server({ keys: ["k"], log: [LOG_HEADER, typed] });
  assert.deepEqual(plain(s.ctx.adminOpenShifts("k")).shifts, [
    { shiftId: "s-1", label: "Mon 2026-06-01 · Sam Lee · in 9:00 AM" },
  ]);
  const reply = plain(
    s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "12:15", initials: "ab" }),
  );
  assert.deepEqual(reply, { ok: true, row: 2, name: "Sam Lee", hours: 3.25 });
  const row = s.sheets.Log.rowByHeader(2);
  assert.equal(row.Status, "closed");
  assert.equal(row["Check-Out Stated (user)"].getTime(), at(DAY, "12:15").getTime());
  assert.equal(row["Hours Served (stated)"], 3.25);
  // The typed cell is never rewritten.
  assert.equal(row["Check-In Stated (user)"].getTime(), at("1899-12-30", "09:00").getTime());
});

// ---------------------------------------------------------------------------
// The window after the tap, the missed check-out and the long-shift flag, end to end

const WINDOW_SETTINGS = [
  ...KIOSK_SETTINGS,
  ["Kiosk launch date", "2026-11-01"],
  ["Auto clock-out after hours", "12"],
  ["Long shift flag hours", "8"],
];
const YESTERDAY = "2026-11-11";
const closedBy = (shiftId, date, outBy) =>
  logRow({
    "Shift ID": shiftId,
    "User Token": "tok-sam",
    Status: "closed",
    Date: date,
    "Volunteer Name": "Sam Lee",
    "Check-In Recorded (timestamp)": at(date, "09:00"),
    "Check-In Stated (user)": at(date, "09:00"),
    "Check-Out Stated (user)": at(date, "12:00"),
    "Hours Served (stated)": 3,
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": outBy,
  });

test("apiCheckIn's reply carries missedSignOut, from the whole Log", () => {
  const reply = (outBy) =>
    plain(
      kiosk({
        settings: WINDOW_SETTINGS,
        log: [LOG_HEADER, closedBy("s-old", "2026-11-03", outBy)],
      }).ctx.apiCheckIn(CODE, SAM.id, null, null),
    );
  const missed = reply("auto-close");
  assert.deepEqual(Object.keys(missed).sort(), [
    "arrivedAt",
    "id",
    "missedSignOut",
    "ok",
    "shiftId",
    "tappedAt",
  ]);
  assert.equal(missed.ok, true);
  assert.equal(missed.missedSignOut, true);
  assert.equal(reply("EM").missedSignOut, true);
  assert.equal(reply("kiosk").missedSignOut, false);
  // No rows since launch: no notice.
  assert.equal(
    plain(kiosk({ settings: WINDOW_SETTINGS }).ctx.apiCheckIn(CODE, SAM.id, null, null))
      .missedSignOut,
    false,
  );
});

test("an evening check-in stays checked in past midnight: listed, refused a second check-in, and checked out", () => {
  const evening = kioskOpen("s-eve", YESTERDAY, "23:00");
  const s = kiosk({ settings: WINDOW_SETTINGS, log: [LOG_HEADER, evening] });
  const [listed] = plain(s.ctx.apiListVolunteers(CODE).volunteers);
  assert.equal(listed.checkedIn, true);
  assert.equal(listed.openShiftArrival, at(YESTERDAY, "23:00").toISOString());
  assert.deepEqual(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)), {
    ok: false,
    refusal: "ALREADY_IN",
    message: "You're already checked in.",
  });
  const out = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null));
  assert.equal(out.ok, true);
  const row = s.sheets.Log.rowByHeader(2);
  assert.equal(row.Status, "closed");
  assert.equal(row["Hours Served (stated)"], 11);
  // Eleven stated hours is a long shift.
  assert.equal(row["Admin Alerts?"], "long shift: 11 h stated, over 8 h");
  // A row checked in more than 12 hours ago is no longer the tablet's.
  const old = kiosk({
    settings: WINDOW_SETTINGS,
    log: [LOG_HEADER, kioskOpen("s-old", YESTERDAY, "21:59")],
  });
  assert.equal(plain(old.ctx.apiListVolunteers(CODE).volunteers)[0].checkedIn, false);
  assert.equal(plain(old.ctx.apiCheckOut(CODE, SAM.id, null, null)).refusal, "NOT_IN");
});

test("apiCheckOut flags a long shift in Admin Alerts? and on the Flags tab, after the check-out flag", () => {
  const open = kioskOpen("s-long", TODAY, "00:30");
  const s = kiosk({ settings: WINDOW_SETTINGS, log: [LOG_HEADER, open] });
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30))).ok, true);
  const log = s.sheets.Log.rowByHeader(2);
  assert.equal(log["Hours Served (stated)"], 9);
  assert.equal(
    log["Admin Alerts?"],
    "check-out differs by 30 min; long shift: 9 h stated, over 8 h",
  );
  const flags = [2, 3].map((r) => s.sheets.Flags.rowByHeader(r));
  assert.deepEqual(
    flags.map((f) => [f.Reason, f.Source, f["Shift ID"]]),
    [
      ["check-out differs by 30 min", "kiosk check-out", "s-long"],
      ["long shift: 9 h stated, over 8 h", "kiosk check-out", "s-long"],
    ],
  );
  // A Long shift flag hours of 10 moves the line.
  const t = kiosk({
    settings: [...KIOSK_SETTINGS, ["Long shift flag hours", "10"]],
    log: [LOG_HEADER, kioskOpen("s-long", TODAY, "00:30")],
  });
  t.ctx.apiCheckOut(CODE, SAM.id, null, null);
  assert.equal(t.sheets.Log.rowByHeader(2)["Admin Alerts?"], "");
  assert.equal(t.sheets.Flags.getLastRow(), 1);
});
