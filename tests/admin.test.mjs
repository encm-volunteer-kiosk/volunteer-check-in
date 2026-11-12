// Tests for apps-script/Admin.js, the Kiosk admin menu. The server files are loaded into
// one global scope, as Apps Script loads them, with stand-ins for the Google services
// that record every call. Two kinds of test:
//
// - The guard. Every public function in Admin.js (a top-level function whose name doesn't
//   end in _) can be named by the kiosk page through google.script.run. Each must check
//   that the person at the sheet runs it, and that it holds a dialog key the spreadsheet's
//   menu issued, before it reads or writes anything. The list of functions comes from
//   Admin.js's source, so a public function added later is held to the same rule.
// - The glue: the admin functions read and write an in-memory Log through Sheets.js.

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
const ADMIN_SOURCE = read("apps-script/Admin.js");

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

/** A sheet held as rows of cells; row and column numbers are 1-based, as in Apps Script. */
class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((r) => r.slice());
    this.formats = {};
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
    return 1000;
  }
  insertRowsAfter() {}
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
        while (sheet.rows.length < row) sheet.rows.push([]);
        const r = sheet.rows[row - 1];
        while (r.length < col) r.push("");
        r[col - 1] = value;
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
 * issued).
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const sheets = {
    Log: new FakeSheet(opts.log || [[]]),
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
    console,
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
      flush: () => {},
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
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  if (opts.volunteers) {
    cache.set(
      ctx.profilesCacheKey("file-1", "Volunteer Profiles"),
      JSON.stringify(opts.volunteers),
    );
  }
  for (const key of opts.keys || []) cache.set(ctx.adminKeyCacheKey(key), "1");
  calls.length = 0;
  return { ctx, calls, cache, sheets, shown, menu };
}

// ---------------------------------------------------------------------------
// The guard

/** Top-level function names declared in Admin.js. */
const declared = [...ADMIN_SOURCE.matchAll(/^function\s+([\w$]+)\s*\(/gm)].map((m) => m[1]);
const PUBLIC = declared.filter((name) => !name.endsWith("_"));
const isOpener = (name) => /^open\w*Dialog$/.test(name);
const KEYED = PUBLIC.filter((name) => name !== "onOpen" && !isOpener(name));
const onlyFrom = (calls, allowed) =>
  calls.filter((c) => !allowed.some((a) => (a.endsWith(".") ? c.startsWith(a) : c === a)));

test("Admin.js declares the menu's public functions, and only functions", () => {
  for (const name of [
    "onOpen",
    "openAddShiftDialog",
    "openFixSignOutDialog",
    "adminRoster",
    "adminOpenShifts",
    "adminAddShift",
    "adminFixSignOut",
  ]) {
    assert.ok(PUBLIC.includes(name), name);
  }
  const { ctx, calls } = server();
  for (const name of declared) assert.equal(typeof ctx[name], "function", name);
  // Loading the file calls nothing.
  assert.deepEqual(calls, []);
  // Anything at the top level other than a function would be code that runs on every call
  // of the web app too.
  const topLevel = ADMIN_SOURCE.split("\n").filter((line) => /^\S/.test(line));
  for (const line of topLevel) {
    assert.match(line, /^(function |\}|\/\*\*| \*|\/\/)/, line);
  }
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
  assert.equal(template.file, "Admin");
  assert.equal(template.mode, "add");
  assert.ok(template.key);
  assert.ok(s.cache.has("admin-key:" + template.key));
  assert.equal(s.ctx.adminRoster(template.key).ok, true);

  s.ctx.openFixSignOutDialog();
  assert.equal(s.shown[1].output.template.mode, "fix");
  assert.notEqual(s.shown[1].output.template.key, template.key);
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
  // A time typed without a date reads as 1899-12-30, not on the row's Date.
  broken[LOG_HEADER.indexOf("Check-In\nStated\n(user)")] = new Date(Date.UTC(1899, 11, 30, 15));
  broken[LOG_HEADER.indexOf("Check-In\nRecorded\n(timestamp)")] = "";
  const s = server({ keys: ["k"], log: [LOG_HEADER, broken] });
  const reply = plain(
    s.ctx.adminFixSignOut("k", { shiftId: "s-1", outTime: "12:00", initials: "ab" }),
  );
  assert.equal(reply.refusal, "ADMIN_BAD_ROW");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
});
