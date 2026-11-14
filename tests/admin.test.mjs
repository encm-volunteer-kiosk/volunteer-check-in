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
//   Four kinds are exempt from the key only: the dialog openers, which make it; the menu
//   items that open no dialog (refreshHoursNow, checkLogNow), which check getUi as the
//   openers do; the functions run from the editor as setupSheets is (setupReports,
//   setupDailyJobs, removeDailyJobs); and the trigger handlers, which check the trigger's
//   id instead. The list of functions comes from the files' source, so a public function
//   added later is held to the same rule.
// - The glue: the admin functions read and write an in-memory Log through Sheets.js, and
//   the kiosk's check-in and check-out copy their flags to an in-memory Flags tab.
// - Email hours: the preview and the send against stand-in MailApp, lock, cache and Hours
//   emails tab, each of which a test can make busy or throw at the point it names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { formatInZone } from "./zoneFormat.mjs";

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
  "HoursSort.js",
].map((f) => [f, read("apps-script/" + f)]);
const GUARDED_FILES = ["Admin.js", "Reports.js", "Jobs.js", "Import.js", "HoursSort.js"].map(
  (f) => [f, read("apps-script/" + f)],
);

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
 * grow the sheet with insertRowsAfter first. As in Sheets, a range of no rows or no
 * columns throws, and so does a read past the last grid row. reads records each read the
 * script makes, in order: "getLastRow", "getLastColumn", "getMaxRows", "getValues
 * row,col,rows,cols" and "getNumberFormats row,col,rows,cols". When server() gives the
 * sheet a journal, each read goes there too as "read <tab> <read>", and each write as
 * "write <tab> <method> <args>", so one list holds the order across tabs. afterValues,
 * when set, runs after each getValues has returned its cells, so a test can move rows
 * between two reads.
 */
class FakeSheet {
  constructor(rows, maxRows = Math.max(1000, rows.length)) {
    this.rows = rows.map((r) => r.slice());
    this.formats = {};
    this.maxRows = maxRows;
    this.inserted = [];
    // Data validations by "row:col".
    this.validations = {};
    this.reads = [];
    this.name = "";
    this.afterValues = null;
    this.frozenRows = 0;
    this.protections = [];
  }
  setFrozenRows(n) {
    this.noteWrite("setFrozenRows " + n);
    this.frozenRows = n;
  }
  /** A tab protection, as protect() makes it: a description and warning-only, both set later. */
  protect() {
    this.noteWrite("protect");
    const p = { description: "", warningOnly: false };
    const protection = {
      setDescription: (d) => ((p.description = d), protection),
      setWarningOnly: (w) => ((p.warningOnly = w), protection),
      getDescription: () => p.description,
      state: p,
    };
    this.protections.push(protection);
    return protection;
  }
  getProtections(type) {
    assert.equal(type, "SHEET", "a tab's protections are asked for by ProtectionType.SHEET");
    return this.protections.slice();
  }
  getSheetId() {
    return 0;
  }
  noteRead(what) {
    this.reads.push(what);
    if (this.journal) this.journal.push("read " + this.name + " " + what);
  }
  noteWrite(what) {
    if (this.journal) this.journal.push("write " + this.name + " " + what);
  }
  lastRow() {
    let last = this.rows.length;
    while (last > 0 && this.rows[last - 1].every((v) => v === "")) last--;
    return last;
  }
  lastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getLastRow() {
    this.noteRead("getLastRow");
    return this.lastRow();
  }
  getLastColumn() {
    this.noteRead("getLastColumn");
    return this.lastColumn();
  }
  getMaxRows() {
    this.noteRead("getMaxRows");
    return this.maxRows;
  }
  insertRowsAfter(after, count) {
    this.noteWrite("insertRowsAfter " + after + "," + count);
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
    // Sheets gives an empty tab a data range of one cell, A1.
    return this.getRange(1, 1, Math.max(this.lastRow(), 1), Math.max(this.lastColumn(), 1));
  }
  getRange(row, col, rows = 1, cols = 1) {
    if (!(rows >= 1)) throw new Error("The number of rows in the range must be at least 1.");
    if (!(cols >= 1)) throw new Error("The number of columns in the range must be at least 1.");
    const sheet = this;
    const where = [row, col, rows, cols].join(",");
    const range = {
      getValues: () => {
        sheet.noteRead("getValues " + where);
        if (row + rows - 1 > sheet.maxRows) {
          throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
        }
        const values = Array.from({ length: rows }, (_, i) =>
          Array.from(
            { length: cols },
            (_, j) => (sheet.rows[row - 1 + i] || [])[col - 1 + j] ?? "",
          ),
        );
        if (sheet.afterValues) sheet.afterValues(sheet);
        return values;
      },
      setNumberFormat: (format) => {
        sheet.noteWrite("setNumberFormat " + where);
        sheet.formats[row + ":" + col] = format;
        return range;
      },
      setValue: (value) => {
        sheet.noteWrite("setValue " + where);
        sheet.put(row, col, value);
        return range;
      },
      setValues: (values) => {
        sheet.noteWrite("setValues " + where);
        assert.equal(values.length, rows, "setValues row count");
        values.forEach((line, i) => {
          assert.equal(line.length, cols, "setValues column count");
          line.forEach((v, j) => sheet.put(row + i, col + j, v));
        });
        return range;
      },
      getNumberFormats: () => {
        sheet.noteRead("getNumberFormats " + where);
        return Array.from({ length: rows }, (_, i) =>
          Array.from({ length: cols }, (_, j) => sheet.formats[row + i + ":" + (col + j)] ?? ""),
        );
      },
      setNumberFormats: (formats) => {
        sheet.noteWrite("setNumberFormats " + where);
        assert.equal(formats.length, rows, "setNumberFormats row count");
        formats.forEach((line, i) => {
          assert.equal(line.length, cols, "setNumberFormats column count");
          line.forEach((f, j) => (sheet.formats[row + i + ":" + (col + j)] = f));
        });
        return range;
      },
      setDataValidation: (rule) => {
        sheet.noteWrite("setDataValidation " + where);
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
 * tab), flagsMaxRows (its last grid row), logMaxRows (the Log's), now (a fixed server
 * clock, in ms), onFlush (run on each SpreadsheetApp.flush), triggers (this account's
 * project triggers, as [{uid, handler}]), settingsCacheFails (every cache call on a
 * Settings key throws), profiles (the Volunteer Profiles tab's rows, header first, which
 * openById("file-1") serves) and profilesCacheFails (every cache call on a Profiles key
 * throws). The cache is a Map of key to value; it never expires an entry, so
 * a test sets the clock to age one. errors collects what the server logs with
 * console.error. journal lists, in order, every sheet read and write (FakeSheet), each tab
 * the script opens ("read <tab> getSheetByName") and each flush ("flush").
 *
 * For Kiosk admin > Email hours…: opts.hoursEmails gives the Hours emails tab's rows (no tab
 * by default; insertSheet makes one) and opts.quota the mail quota left today (1500).
 * mail records the quota and every MailApp.sendEmail ({message, held}); mail.events lists
 * both in order, each with whether the script lock was held. A send uses one of the quota.
 * blobs lists every Utilities.newBlob. lock is the script lock: lock.busy (true, or a
 * function of the try's number from 0) makes tryLock fail, lock.held says whether it is
 * held now, and lock.tries and lock.takes count tryLock calls and the ones that got it.
 * faults holds functions a test sets to make a call throw: sendEmail(message) returns a
 * message to throw with, cachePut(key) and cacheRemove(key) return true to throw, account()
 * returns true to make Session.getActiveUser throw, openById() true to make opening
 * Profiles throw, flush() true to make SpreadsheetApp.flush throw (after it is journaled)
 * and insertSheet() true to make a new tab fail. The other reads are made to throw through
 * a sheet's afterValues.
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const errors = [];
  const journal = [];
  // With opts.settingsCacheFails, every cache call on a Settings key throws, as in a cache
  // outage; the Profiles list and the dialog keys stay cached, so a call gets past them.
  const settingsKey = (k) => String(k).startsWith("settings:");
  const failSettings = (method) => {
    if (opts.settingsCacheFails) throw new Error("cache." + method + " failed");
  };
  const failProfiles = (k, method) => {
    if (opts.profilesCacheFails && String(k).startsWith("profiles:")) {
      throw new Error("cache." + method + " failed");
    }
  };
  const sheets = {
    Log: new FakeSheet(opts.log || [[]], opts.logMaxRows),
    Flags:
      opts.flags === null
        ? undefined
        : new FakeSheet(opts.flags || [FLAG_HEADER], opts.flagsMaxRows ?? 1000),
    Settings:
      opts.settings === null
        ? undefined
        : new FakeSheet(
            opts.settings || [
              ["Setting", "Value"],
              ["Volunteer Profiles file ID", "file-1"],
              ["Volunteer Profiles tab", "Volunteer Profiles"],
            ],
          ),
  };
  for (const [name, sheet] of Object.entries(sheets)) {
    if (!sheet) continue;
    sheet.name = name;
    // Not enumerable, so a JSON copy of one sheet holds only that sheet.
    Object.defineProperty(sheet, "journal", { value: journal });
  }
  if (opts.hoursEmails) sheets["Hours emails"] = new FakeSheet(opts.hoursEmails);
  const register = (name, sheet) => {
    sheet.name = name;
    Object.defineProperty(sheet, "journal", { value: journal });
  };
  if (sheets["Hours emails"]) register("Hours emails", sheets["Hours emails"]);
  const shown = [];
  const menu = [];
  let uuid = 0;
  const faults = {};
  const lock = { held: false, tries: 0, takes: 0, busy: false };
  const mail = { quota: opts.quota ?? 1500, sent: [], events: [] };
  const blobs = [];

  /** A service whose every method call is recorded; a method it lacks throws. */
  const service = (name, methods) =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop !== "string") return undefined;
          // A constant such as SpreadsheetApp.ProtectionType is read, not called.
          if (methods[prop] && typeof methods[prop] !== "function") return methods[prop];
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
      getActiveUser: () => {
        if (faults.account && faults.account()) throw new Error("Session read failed");
        return email(opts.active ?? "staff@example.org");
      },
      getEffectiveUser: () => email(opts.effective ?? opts.active ?? "staff@example.org"),
    }),
    CacheService: service("CacheService", {
      getScriptCache: () =>
        service("cache", {
          get: (k) => {
            failProfiles(k, "get");
            return cache.has(k) ? cache.get(k) : null;
          },
          getAll: (keys) => {
            if (keys.some(settingsKey)) failSettings("getAll");
            const out = {};
            keys.forEach((k) => cache.has(k) && (out[k] = cache.get(k)));
            return out;
          },
          put: (k, v) => {
            if (settingsKey(k)) failSettings("put");
            failProfiles(k, "put");
            if (faults.cachePut && faults.cachePut(k)) throw new Error("cache.put failed");
            cache.set(k, v);
          },
          remove: (k) => {
            if (settingsKey(k)) failSettings("remove");
            if (faults.cacheRemove && faults.cacheRemove(k)) {
              throw new Error("cache.remove failed");
            }
            cache.delete(k);
          },
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
    MailApp: service("MailApp", {
      getRemainingDailyQuota: () => {
        mail.events.push({ what: "quota", held: lock.held });
        return mail.quota;
      },
      sendEmail: (...args) => {
        assert.equal(args.length, 1, "sendEmail takes one message object");
        const message = args[0];
        mail.events.push({ what: "send", to: message.to, held: lock.held });
        const thrown = faults.sendEmail && faults.sendEmail(message);
        if (thrown) throw new Error(thrown);
        mail.sent.push({ message, held: lock.held });
        mail.quota--;
      },
    }),
    LockService: service("LockService", {
      getScriptLock: () => ({
        tryLock: () => {
          const n = lock.tries++;
          const busy = typeof lock.busy === "function" ? lock.busy(n) : lock.busy;
          if (busy) return false;
          assert.equal(lock.held, false, "the script lock is taken twice at once");
          lock.held = true;
          lock.takes++;
          return true;
        },
        releaseLock: () => {
          lock.held = false;
        },
      }),
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
      ProtectionType: { SHEET: "SHEET" },
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => {
          journal.push("read " + name + " getSheetByName");
          return sheets[name] || null;
        },
        insertSheet: (name) => {
          if (faults.insertSheet && faults.insertSheet()) throw new Error("insertSheet failed");
          assert.ok(!sheets[name], "a second tab named " + name);
          journal.push("write " + name + " insertSheet");
          sheets[name] = new FakeSheet([]);
          register(name, sheets[name]);
          return sheets[name];
        },
        getUrl: () => "https://docs.google.com/spreadsheets/d/log-1/edit",
      }),
      openById: (id) => {
        if (faults.openById && faults.openById()) throw new Error("Profiles read failed");
        if (id !== "file-1" || !opts.profiles) throw new Error("no file " + id);
        const profiles = new FakeSheet(opts.profiles);
        return { getSheetByName: (name) => (name === "Volunteer Profiles" ? profiles : null) };
      },
      flush: () => {
        journal.push("flush");
        if (faults.flush && faults.flush()) throw new Error("flush failed");
        return opts.onFlush ? opts.onFlush() : undefined;
      },
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
          output.setWidth = (w) => ((output.width = w), output);
          output.setHeight = (h) => ((output.height = h), output);
          return output;
        };
        return template;
      },
    }),
    Utilities: service("Utilities", {
      getUuid: () => "uuid-" + ++uuid,
      newBlob: (text, type, name) => {
        const blob = { text, type, name };
        blobs.push(blob);
        return blob;
      },
      sleep: () => undefined,
      // The algorithm and charset are read off the stand-in as functions; SHA-256 of UTF-8.
      computeDigest: (algorithm, text) =>
        [...createHash("sha256").update(text, "utf8").digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "yyyy-MM-dd HH:mm:ss") return formatInZone(date, tz, format);
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
  journal.length = 0;
  return { ctx, calls, cache, sheets, shown, menu, errors, journal, mail, lock, faults, blobs };
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
const TRIGGER_ONLY = ["runFlagsEmail", "runAutoClockOut", "runHoursRefresh", "runHoursSort"];
// An edit trigger runs as its installer for every editor's edit, so the active user
// is the editor, not the installer: its trigger id is its only check.
const EDIT_TRIGGER = ["runHoursSort"];
// A Kiosk admin menu item that opens no dialog: like an opener, it checks getUi first.
const MENU_RUN = ["refreshHoursNow", "checkLogNow"];
const KEYED = PUBLIC.filter(
  (name) =>
    name !== "onOpen" &&
    !isOpener(name) &&
    !MENU_RUN.includes(name) &&
    !EDITOR_ONLY.includes(name) &&
    !TRIGGER_ONLY.includes(name),
);
const onlyFrom = (calls, allowed) =>
  calls.filter((c) => !allowed.some((a) => (a.endsWith(".") ? c.startsWith(a) : c === a)));

test("Admin.js, Reports.js and Jobs.js declare the public functions, and only functions", () => {
  for (const name of [
    ...EDITOR_ONLY,
    ...TRIGGER_ONLY,
    ...MENU_RUN,
    "onOpen",
    "openAddShiftDialog",
    "openFixSignOutDialog",
    "openRemoveShiftDialog",
    "openRestoreShiftDialog",
    "adminRoster",
    "adminOpenShifts",
    "adminAddShift",
    "adminFixSignOut",
    "adminFindShifts",
    "adminRemoveShift",
    "adminRemovedShifts",
    "adminRestoreShift",
    "setupReports",
    "openMonthlyReportDialog",
    "adminReportMonths",
    "adminMonthlyReport",
    "openEmailHoursDialog",
    "adminHoursPreview",
    "adminSendHours",
  ]) {
    assert.ok(PUBLIC.includes(name), name);
  }
  for (const name of [
    "adminHoursPreview",
    "adminSendHours",
    "adminReportMonths",
    "adminMonthlyReport",
    "adminFindShifts",
    "adminRemoveShift",
    "adminRemovedShifts",
    "adminRestoreShift",
  ]) {
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
    "refreshHoursNow",
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
  for (const name of PUBLIC.filter((n) => n !== "onOpen" && !EDIT_TRIGGER.includes(n))) {
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

test("the edit trigger is the one public function without the editor-run check, and it refuses anything but its own trigger before it reads", () => {
  assert.deepEqual(EDIT_TRIGGER, ["runHoursSort"]);
  for (const name of EDIT_TRIGGER) assert.ok(TRIGGER_ONLY.includes(name), name);
  const source = GUARDED_FILES.find(([f]) => f === "HoursSort.js")[1];
  const sortPublic = [...source.matchAll(/^function\s+([\w$]+)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith("_"));
  assert.deepEqual(sortPublic, ["runHoursSort"]);
  // This account's triggers: one for the sort, and one for something else.
  const triggers = [
    { uid: "own-0", handler: "runHoursSort" },
    { uid: "own-other", handler: "someOtherFunction" },
  ];
  const callers = [
    { active: "" },
    { active: "owner@example.org" },
    { active: "owner@example.org", effective: "someone@example.org" },
  ];
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
  for (const name of EDIT_TRIGGER) {
    for (const who of callers) {
      for (const e of events) {
        const { ctx, calls } = server({ ...who, triggers });
        assert.throws(
          () => ctx[name](e),
          /runs only from its trigger/,
          name + " " + JSON.stringify(who) + " " + JSON.stringify(e),
        );
        assert.deepEqual(
          onlyFrom(calls, ["Session.", "ScriptApp.getProjectTriggers", "trigger."]),
          [],
          name,
        );
      }
    }
    // The editor at the sheet isn't the installer, as on every other editor's pick.
    const { ctx } = server({ ...callers[2], triggers });
    try {
      ctx[name]({ triggerUid: "own-0" });
    } catch (err) {
      assert.doesNotMatch(err.message, /Run this from the Apps Script editor/, name);
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

test("Jobs.js's public functions are the editor-run setup, the trigger handlers and Check the Log now", () => {
  const jobs = GUARDED_FILES.find(([f]) => f === "Jobs.js")[1];
  const jobsPublic = [...jobs.matchAll(/^function\s+([\w$]+)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith("_"));
  assert.deepEqual(jobsPublic.sort(), [
    "checkLogNow",
    "removeDailyJobs",
    "runAutoClockOut",
    "runFlagsEmail",
    "runHoursRefresh",
    "setupDailyJobs",
  ]);
  // Every daily job's handler is a trigger-only public function.
  const { ctx } = server();
  for (const job of plain(ctx.dailyJobs()))
    assert.ok(TRIGGER_ONLY.includes(job.handler), job.handler);
  // The one other is a menu item that opens no dialog.
  assert.ok(MENU_RUN.includes("checkLogNow"));
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

test("the menu items that open no dialog read nothing outside the spreadsheet's UI", () => {
  for (const name of MENU_RUN) {
    const { ctx, calls } = server({ ui: false });
    assert.throws(() => ctx[name](), /getUi/, name);
    assert.deepEqual(onlyFrom(calls, ["Session.", "SpreadsheetApp.getUi"]), [], name);
  }
});

test("onOpen adds the menu first, and its items name the openers, Refresh Hours and Check the Log now", () => {
  const { ctx, calls, menu } = server({ active: "" });
  const logs = [];
  ctx.console.log = (...args) => logs.push(args.join(" "));
  // getUi comes first and the menu is whole before anything else. The Hours note after it
  // (tests/reports-sheet.test.mjs) finds no Hours tabs on this stand-in and fails; the
  // failure is logged and costs nothing.
  assert.equal(ctx.onOpen({}), undefined);
  assert.equal(calls[0], "SpreadsheetApp.getUi");
  const added = calls.indexOf("menu.addToUi");
  assert.deepEqual(onlyFrom(calls.slice(0, added + 1), ["SpreadsheetApp.getUi", "menu."]), []);
  assert.deepEqual(calls.slice(added + 1), ["SpreadsheetApp.getActiveSpreadsheet"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Hours note \(open\) failed: /);
  assert.deepEqual(menu, [
    "Kiosk admin",
    ["Add a shift…", "openAddShiftDialog"],
    ["Fix a sign-out…", "openFixSignOutDialog"],
    ["Remove a shift…", "openRemoveShiftDialog"],
    ["Restore a shift…", "openRestoreShiftDialog"],
    ["Monthly report…", "openMonthlyReportDialog"],
    ["Email hours…", "openEmailHoursDialog"],
    ["Import past hours…", "openImportDialog"],
    ["Refresh Hours", "refreshHoursNow"],
    ["Check the Log now", "checkLogNow"],
  ]);
  for (const [, fn] of menu.slice(1)) {
    assert.ok(PUBLIC.filter(isOpener).includes(fn) || MENU_RUN.includes(fn), fn);
  }
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

  s.ctx.openRemoveShiftDialog();
  assert.equal(s.shown[2].title, "Remove a shift");
  assert.equal(s.shown[2].output.template.mode, "remove");
  s.ctx.openRestoreShiftDialog();
  assert.equal(s.shown[3].title, "Restore a shift");
  assert.equal(s.shown[3].output.template.mode, "restore");
  const keys = new Set(s.shown.map((d) => d.output.template.key));
  assert.equal(keys.size, 4);
  // An empty spreadsheet has no Removed shifts tab, so the Restore list is empty.
  assert.deepEqual(plain(s.ctx.adminRemovedShifts(s.shown[3].output.template.key)), {
    ok: true,
    shifts: [],
  });
  // Every one of these windows is 480 by 600.
  for (const d of s.shown) assert.deepEqual([d.output.width, d.output.height], [480, 600]);
});

test("the Email hours opener serves the admin window in email mode, 480 by 720, and its key works", () => {
  const s = server({ volunteers: [SAM] });
  assert.equal(s.ctx.openEmailHoursDialog(), undefined);
  assert.equal(s.shown.length, 1);
  const { output, title } = s.shown[0];
  assert.equal(title, "Email volunteers their hours");
  assert.equal(output.template.file, "AdminDialog");
  assert.equal(output.template.mode, "email");
  assert.equal(output.template.contactNote, "");
  assert.deepEqual([output.width, output.height], [480, 720]);
  assert.ok(output.template.key);
  assert.ok(s.cache.has("admin-key:" + output.template.key));
  assert.equal(s.ctx.adminRoster(output.template.key).ok, true);
  // A second window gets a key of its own.
  s.ctx.openEmailHoursDialog();
  assert.notEqual(s.shown[1].output.template.key, output.template.key);
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

const CONTACT_OPENERS = [
  "openAddShiftDialog",
  "openFixSignOutDialog",
  "openRemoveShiftDialog",
  "openRestoreShiftDialog",
  "openMonthlyReportDialog",
  "openEmailHoursDialog",
];

test("the admin and Monthly report openers put the Kiosk contact line into the window", () => {
  const settings = [
    ["Setting", "Value"],
    ["Volunteer Profiles file ID", "file-1"],
    ["Kiosk contact", " Pat Example\n pat@example.org \n"],
  ];
  for (const name of CONTACT_OPENERS) {
    const s = server({ settings, log: [LOG_HEADER] });
    s.ctx[name]();
    assert.equal(
      s.shown[0].output.template.contactNote,
      "If this keeps happening, contact: Pat Example, pat@example.org",
      name,
    );
    // The admin windows are 480 by 600, the Email hours window 480 by 720.
    if (s.shown[0].output.template.file === "AdminDialog") {
      assert.deepEqual(
        [s.shown[0].output.width, s.shown[0].output.height],
        [480, name === "openEmailHoursDialog" ? 720 : 600],
        name,
      );
    }
    // A blank contact adds nothing.
    const blank = server({ settings: [...settings.slice(0, 2), ["Kiosk contact", " \n "]] });
    blank.ctx[name]();
    assert.equal(blank.shown[0].output.template.contactNote, "", name);
    // With no Settings tab the window still opens, with no contact line.
    const none = server({ settings: null });
    const logs = [];
    none.ctx.console.log = (...a) => logs.push(a.join(" "));
    assert.equal(none.ctx[name](), undefined, name);
    assert.equal(none.shown.length, 1, name);
    assert.equal(none.shown[0].output.template.contactNote, "", name);
    assert.ok(none.shown[0].output.template.key, name);
    assert.match(logs.join("\n"), /^Kiosk contact not read: The "Settings" tab is missing/, name);
  }
});

test("each window shows the contact only after an error, never after a refusal, and prints it escaped", () => {
  for (const file of ["AdminDialog", "Report", "ImportDialog"]) {
    const html = read("apps-script/" + file + ".html");
    // HtmlService's <?= ?> escapes the value; <?!= would not.
    assert.match(html, /<body\b(?:[^<>]|<\?= \w+ \?>)*\sdata-contact="<\?= contactNote \?>"/, file);
    assert.ok(!html.includes("<?!="), file);
    // Every scriptlet is an escaping print of one name, comments included.
    (html.match(/<\?[\s\S]*?\?>/g) || []).forEach((t) =>
      assert.match(t, /^<\?= \w+ \?>$/, file + ": " + t),
    );
    assert.ok(html.includes('const CONTACT = document.body.dataset.contact || "";'), file);
    assert.match(
      html,
      /function failed\(text\) \{\s+show\(CONTACT \? text \+ " " \+ CONTACT : text, "error"\);\s+\}/,
      file,
    );
    // CONTACT is read nowhere else, so only failed() can show it.
    assert.equal(html.match(/CONTACT/g).length, 3, file);
    // The failure handler and a reply with no message go through failed(); a refusal's
    // message is shown as it is.
    assert.match(
      html,
      /\.withFailureHandler\(\(error\) => \{[^}]*failed\(\(error && error\.message\) \|\| String\(error\)\);\s+\}\)/,
      file,
    );
    assert.ok(
      html.includes('else if (reply && reply.message) show(reply.message, "error");'),
      file,
    );
    assert.ok(html.includes('else failed("Something went wrong. Please try again.");'), file);
    assert.equal(html.match(/failed\(/g).length, 3, file);
    assert.ok(!/show\([^;\n]*error\.message/.test(html), file);
  }
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

/** A Flags tab as setupSheets leaves it: an unticked box on every row to rows, then flags at the given rows. */
const boxedFlags = (rows, flagged = {}) => {
  const reviewed = FLAG_HEADER.indexOf("Reviewed");
  const out = [FLAG_HEADER];
  for (let r = 2; r <= rows; r++) {
    const line = FLAG_HEADER.map((_, i) => (i === reviewed ? false : ""));
    Object.assign(line, flagged[r] || {});
    out.push(line);
  }
  return out;
};
const flagCells = (byHeader) => {
  const line = {};
  for (const [h, v] of Object.entries(byHeader)) line[FLAG_HEADER.indexOf(h)] = v;
  return line;
};

test("flagRowUsed: a row holding only an unticked box is free; anything else is in use", () => {
  const L = server().ctx;
  const cols = plain(L.flagColumns(FLAG_HEADER));
  const reviewed = FLAG_HEADER.indexOf("Reviewed");
  const line = (at, value) => FLAG_HEADER.map((_, i) => (i === at ? value : ""));
  for (const value of [false, "", "FALSE", "false", null, undefined]) {
    assert.equal(L.flagRowUsed(line(reviewed, value), cols), false, String(value));
  }
  for (const value of [true, "TRUE", "x"]) {
    assert.equal(L.flagRowUsed(line(reviewed, value), cols), true, String(value));
  }
  // Any other cell, staff's columns too, holding anything: a Shift ID, a note, a 0, a false.
  for (const h of ["Shift ID", "Notes", "Staff column", "Log Row", "Source"]) {
    for (const value of ["s-1", 0, false]) {
      const cells = line(reviewed, false);
      cells[FLAG_HEADER.indexOf(h)] = value;
      assert.equal(L.flagRowUsed(cells, cols), true, h + " " + value);
    }
  }
  assert.equal(L.flagRowUsed(line(-1, ""), cols), false);
  assert.equal(L.flagRowUsed(line(FLAG_HEADER.indexOf("Notes"), "  "), cols), false);
});

test("a new flag goes right under the last row in use, not under the tab's unticked boxes", () => {
  const width = FLAG_HEADER.length;
  // ENCM's tab: boxes to row 1150, three flags at the top, and staff's note further down.
  const flag = (id) => flagCells({ "Shift ID": id, Reason: "late", Source: "kiosk check-in" });
  const s = kiosk({
    flags: boxedFlags(1150, { 2: flag("s-a"), 3: flag("s-b"), 4: flag("s-c") }),
    flagsMaxRows: 1150,
  });
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null)).ok, true);
  const flags = s.sheets.Flags;
  assert.equal(flags.rowByHeader(5).Reason, "arrival differs by 24 min");
  assert.equal(flags.rowByHeader(5).Reviewed, false);
  assert.equal(flags.rowByHeader(6).Reason, "");
  assert.deepEqual(flags.inserted, []);
  // The tab's rows are read once, before the Log write, to find the last one in use.
  const { before } = atFirstLogWrite(s.journal.slice());
  assert.ok(before.includes("read Flags getValues 2,1,1149," + width));
  assert.ok(before.includes("read Flags getNumberFormats 5,1,1," + width));
  assert.deepEqual(s.errors, []);

  // Rows that hold anything else count: a ticked box, or a note with no flag.
  const reviewed = { Reviewed: true };
  for (const [what, cells] of [
    ["a ticked box", reviewed],
    ["a note", { Notes: "kept for later" }],
  ]) {
    const t = kiosk({ flags: boxedFlags(40, { 2: flag("s-a"), 9: flagCells(cells) }) });
    assert.equal(plain(t.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null)).ok, true);
    assert.equal(t.sheets.Flags.rowByHeader(10).Reason, "arrival differs by 24 min", what);
  }

  // Only boxes: the first flag goes on row 2.
  const empty = kiosk({ flags: boxedFlags(1150), flagsMaxRows: 1150 });
  assert.equal(plain(empty.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null)).ok, true);
  assert.equal(empty.sheets.Flags.rowByHeader(2).Reason, "arrival differs by 24 min");

  // The last row in use on the last grid row: the tab grows, as before.
  const full = kiosk({ flags: boxedFlags(30, { 30: flag("s-z") }), flagsMaxRows: 30 });
  assert.equal(plain(full.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null)).ok, true);
  assert.deepEqual(full.sheets.Flags.inserted, [50]);
  assert.equal(full.sheets.Flags.rowByHeader(31).Reason, "arrival differs by 24 min");
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

test("apiCheckOut on a hand-typed open row with no Shift ID gives it one and copies its flags", () => {
  // Staff typed the row for a volunteer who forgot to tap in: no Shift ID.
  const typed = logRow({
    "User Token": "tok-sam",
    Status: "open",
    Date: TODAY,
    "Volunteer Name": "Sam Lee",
    "Check-In Stated (user)": at(TODAY, "00:30"),
  });
  const s = kiosk({ settings: WINDOW_SETTINGS, log: [LOG_HEADER, typed] });
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30))).ok, true);
  const log = s.sheets.Log.rowByHeader(2);
  assert.equal(log.Status, "closed");
  assert.equal(log["Shift ID"], "uuid-1");
  assert.equal(
    log["Admin Alerts?"],
    "check-out differs by 30 min; long shift: 9 h stated, over 8 h",
  );
  const flags = [2, 3].map((r) => s.sheets.Flags.rowByHeader(r));
  assert.deepEqual(
    flags.map((f) => [f.Reason, f["Shift ID"], f["Log Row"]]),
    [
      ["check-out differs by 30 min", "uuid-1", 2],
      ["long shift: 9 h stated, over 8 h", "uuid-1", 2],
    ],
  );
  assert.deepEqual(s.errors, []);

  // A row that has a Shift ID keeps it.
  const kept = kiosk({
    settings: WINDOW_SETTINGS,
    log: [LOG_HEADER, kioskOpen("s-k", TODAY, "00:30")],
  });
  assert.equal(plain(kept.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
  assert.equal(kept.sheets.Log.rowByHeader(2)["Shift ID"], "s-k");
  assert.equal(kept.sheets.Flags.rowByHeader(2)["Shift ID"], "s-k");
  assert.ok(!kept.calls.includes("Utilities.getUuid"));
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

// ---------------------------------------------------------------------------
// Reads per kiosk call

const valueReads = (sheet) => sheet.reads.filter((r) => r.startsWith("getValues"));
const WRONG_CODE = "wrongwrongwrongwrong";

/**
 * Swaps in a script lock that notes how many times Settings had been read when the lock
 * was taken. Returns the list it fills, one count per lock taken.
 */
const settingsReadsAtLock = (s) => {
  const seen = [];
  s.ctx.LockService = {
    getScriptLock: () => ({
      tryLock: () => (seen.push(valueReads(s.sheets.Settings).length), true),
      releaseLock: () => undefined,
    }),
  };
  return seen;
};

/** The Log reads a call made before its first range read: the extent calls, if any. */
const logReadsBeforeTable = (s) => {
  const logReads = s.journal.filter((j) => j.startsWith("read Log ") && !/getSheetByName$/.test(j));
  return logReads.slice(
    0,
    logReads.findIndex((j) => j.startsWith("read Log getValues")),
  );
};

test("apiCheckIn reads Settings once and the Log once", () => {
  const log = [LOG_HEADER, closedBy("s-old", "2026-11-03", "auto-close")];
  const s = kiosk({ settings: WINDOW_SETTINGS, log });
  const atLock = settingsReadsAtLock(s);
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null));
  assert.equal(reply.ok, true);
  assert.equal(reply.missedSignOut, true);
  assert.deepEqual(atLock, [1], "Settings are read before the lock is taken");
  assert.deepEqual(valueReads(s.sheets.Settings), [
    "getValues 1,1," + WINDOW_SETTINGS.length + ",2",
  ]);
  // Header and rows in one range.
  assert.deepEqual(valueReads(s.sheets.Log), ["getValues 1,1,2," + LOG_HEADER.length]);
  assert.deepEqual(logReadsBeforeTable(s), [], "the extent comes with the table");
  assert.equal(s.sheets.Log.rowByHeader(3).Status, "open");
  assert.equal(s.sheets.Log.rowByHeader(3)["Shift ID"], reply.shiftId);
});

test("apiCheckOut reads Settings once, the Log table once and its row once more", () => {
  const log = [
    LOG_HEADER,
    closedBy("s-old", "2026-11-03", "kiosk"),
    kioskOpen("s-open", TODAY, "08:00"),
  ];
  const s = kiosk({ settings: WINDOW_SETTINGS, log });
  const atLock = settingsReadsAtLock(s);
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null));
  assert.equal(reply.ok, true);
  assert.equal(reply.minutes, 120);
  assert.deepEqual(atLock, [1], "Settings are read before the lock is taken");
  assert.deepEqual(valueReads(s.sheets.Settings), [
    "getValues 1,1," + WINDOW_SETTINGS.length + ",2",
  ]);
  // The table once, then the open row again just before the write, at the table's width.
  assert.deepEqual(valueReads(s.sheets.Log), [
    "getValues 1,1,3," + LOG_HEADER.length,
    "getValues 3,1,1," + LOG_HEADER.length,
  ]);
  assert.deepEqual(logReadsBeforeTable(s), [], "the extent comes with the table");
  assert.equal(s.sheets.Log.rowByHeader(3).Status, "closed");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
});

test("apiListVolunteers reads Settings once", () => {
  const s = kiosk({
    settings: WINDOW_SETTINGS,
    log: [LOG_HEADER, kioskOpen("s-open", TODAY, "08:00")],
  });
  const [listed] = plain(s.ctx.apiListVolunteers(CODE).volunteers);
  assert.equal(listed.checkedIn, true);
  assert.deepEqual(valueReads(s.sheets.Settings), [
    "getValues 1,1," + WINDOW_SETTINGS.length + ",2",
  ]);
});

test("a wrong code refuses after one Settings read, before the lock", () => {
  const message = plain(kiosk({}).ctx.refusalMessages()).ACCESS;
  const refused = { ok: false, refusal: "ACCESS", message };
  const calls = [
    (s) => s.ctx.apiCheckIn(WRONG_CODE, SAM.id, null, null),
    (s) => s.ctx.apiCheckOut(WRONG_CODE, SAM.id, null, null),
    (s) => s.ctx.apiListVolunteers(WRONG_CODE),
    (s) => s.ctx.apiCheckAccess(WRONG_CODE),
  ];
  for (const call of calls) {
    const s = kiosk({ log: [LOG_HEADER, kioskOpen("s-open", TODAY, "08:00")] });
    assert.deepEqual(plain(call(s)), refused);
    assert.equal(valueReads(s.sheets.Settings).length, 1);
    assert.ok(!s.calls.includes("LockService.getScriptLock"), "no lock taken");
    assert.deepEqual(s.sheets.Log.reads, [], "the Log is not read");
    assert.deepEqual(
      s.calls.filter((c) => c === "Utilities.sleep"),
      ["Utilities.sleep"],
      "a wrong code waits",
    );
    assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  }
});

test("the Log table read gives no entries on a header-only Log and throws the missing-column error on an empty tab", () => {
  const s = kiosk({});
  const table = plain(s.ctx.readLogTable_(SAM.token));
  assert.deepEqual(table.entries, []);
  assert.equal(table.width, LOG_HEADER.length);
  assert.deepEqual(table.cols, plain(s.ctx.readLogColumns_()));
  assert.deepEqual(valueReads(s.sheets.Log)[0], "getValues 1,1,1," + LOG_HEADER.length);

  // An empty tab: one cell read, as Sheets refuses a range of no rows or columns.
  const empty = kiosk({ log: [[]] });
  const missing = (e) => /^The Log has no "[^"]+" column\. Run setupSheets\(\)\.$/.test(e.message);
  assert.throws(() => empty.ctx.readLogTable_(SAM.token), missing);
  assert.deepEqual(valueReads(empty.sheets.Log), ["getValues 1,1,1,1"]);
  assert.throws(() => empty.ctx.apiCheckIn(CODE, SAM.id, null, null), missing);
  assert.throws(() => empty.ctx.apiCheckOut(CODE, SAM.id, null, null), missing);
});

// ---------------------------------------------------------------------------
// Settings from the script cache

const NEW_CODE = "anothercodeanothercode";
const CODE_ROW = KIOSK_SETTINGS.findIndex((r) => r[0] === "Kiosk access code");
const setCode = (s, code) => (s.sheets.Settings.rows[CODE_ROW][1] = code);
/** A kiosk server whose clock a test can move: set clock.now. */
const kioskWithClock = (opts = {}) => {
  const clock = {
    now: NOW,
    settings: KIOSK_SETTINGS,
    volunteers: [SAM],
    log: [LOG_HEADER],
    ...opts,
  };
  return { s: server(clock), clock };
};
/** The edit event Sheets passes onEdit for one cell on the named tab. */
const editOn = (tab) => ({ range: { getSheet: () => ({ getName: () => tab }) } });
const settingsReads = (s) => valueReads(s.sheets.Settings).length;
const sleeps = (s) => s.calls.filter((c) => c === "Utilities.sleep").length;

test("after a list call, check-in and check-out read no Settings and answer as with a cold cache", () => {
  const log = [LOG_HEADER, closedBy("s-old", "2026-11-03", "auto-close")];
  const cold = kiosk({ settings: WINDOW_SETTINGS, log });
  const warm = kiosk({ settings: WINDOW_SETTINGS, log });
  assert.equal(plain(warm.ctx.apiListVolunteers(CODE)).ok, true);
  assert.equal(settingsReads(warm), 1);

  const atLock = settingsReadsAtLock(warm);
  const inCold = plain(cold.ctx.apiCheckIn(CODE, SAM.id, null, null));
  const inWarm = plain(warm.ctx.apiCheckIn(CODE, SAM.id, null, null));
  assert.deepEqual(inWarm, inCold);
  assert.equal(inWarm.missedSignOut, true);
  const outCold = plain(cold.ctx.apiCheckOut(CODE, SAM.id, null, null));
  const outWarm = plain(warm.ctx.apiCheckOut(CODE, SAM.id, null, null));
  assert.deepEqual(outWarm, outCold);
  assert.equal(outWarm.ok, true);

  assert.equal(settingsReads(warm), 1, "no Settings read after the list call");
  assert.deepEqual(atLock, [1, 1]);
  assert.deepEqual(plain(warm.sheets.Log.rows), plain(cold.sheets.Log.rows));
  assert.deepEqual(plain(warm.sheets.Flags.rows), plain(cold.sheets.Flags.rows));
  assert.deepEqual(warm.errors, []);
});

test("a cold check-in, check-out or code check fills the cache, and the next tap reads no Settings", () => {
  const open = [LOG_HEADER, kioskOpen("s-open", TODAY, "08:00")];
  const cases = [
    [
      [LOG_HEADER],
      (s) => s.ctx.apiCheckIn(CODE, SAM.id, null, null),
      (s) => s.ctx.apiCheckOut(CODE, SAM.id, null, null),
    ],
    [
      open,
      (s) => s.ctx.apiCheckOut(CODE, SAM.id, null, null),
      (s) => s.ctx.apiCheckIn(CODE, SAM.id, null, null),
    ],
    [
      [LOG_HEADER],
      (s) => s.ctx.apiCheckAccess(CODE),
      (s) => s.ctx.apiCheckIn(CODE, SAM.id, null, null),
    ],
  ];
  for (const [log, first, next] of cases) {
    const s = kiosk({ log });
    assert.equal(plain(first(s)).ok, true);
    assert.equal(settingsReads(s), 1);
    const cached = s.cache.get(s.ctx.settingsCacheKey());
    assert.deepEqual(
      plain(s.ctx.settingsFromCache(cached, null, NOW)),
      plain(s.ctx.readSettings_()),
    );
    s.sheets.Settings.reads.length = 0;
    assert.equal(plain(next(s)).ok, true);
    assert.equal(settingsReads(s), 0, "the tap after it reads no Settings");
  }
});

test("the list and the code check read Settings from the tab even with a warm cache", () => {
  const s = kiosk({});
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  assert.equal(plain(s.ctx.apiListVolunteers(CODE)).ok, true);
  assert.equal(plain(s.ctx.apiListVolunteers(CODE)).ok, true);
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  assert.equal(settingsReads(s), 4);
  // A code taken away without a stamp is refused at once by the list, which locks the tablet.
  setCode(s, NEW_CODE);
  assert.equal(plain(s.ctx.apiListVolunteers(CODE)).refusal, "ACCESS");
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).refusal, "ACCESS");
});

test("a wrong code with a warm cache is refused after one Settings read, before the lock", () => {
  const message = plain(kiosk({}).ctx.refusalMessages()).ACCESS;
  const refused = { ok: false, refusal: "ACCESS", message };
  const calls = [
    (s) => s.ctx.apiCheckIn(WRONG_CODE, SAM.id, null, null),
    (s) => s.ctx.apiCheckOut(WRONG_CODE, SAM.id, null, null),
  ];
  for (const call of calls) {
    const s = kiosk({ log: [LOG_HEADER, kioskOpen("s-open", TODAY, "08:00")] });
    assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
    s.calls.length = 0;
    s.sheets.Settings.reads.length = 0;
    assert.deepEqual(plain(call(s)), refused);
    assert.equal(settingsReads(s), 1, "the tab is read before the refusal");
    assert.ok(!s.calls.includes("LockService.getScriptLock"), "no lock taken");
    assert.deepEqual(s.sheets.Log.reads, [], "the Log is not read");
    assert.equal(sleeps(s), 1, "a wrong code waits");
    assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  }
});

test("a code changed on the tab works at once with a warm cache, and the old one is then refused", () => {
  const s = kiosk({});
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  setCode(s, NEW_CODE);
  const before = settingsReads(s);
  const reply = plain(s.ctx.apiCheckIn(NEW_CODE, SAM.id, null, null));
  assert.equal(reply.ok, true);
  assert.equal(settingsReads(s), before + 1, "the mismatch reads the tab once");
  assert.equal(sleeps(s), 0, "an accepted code doesn't wait");
  assert.equal(s.sheets.Log.rowByHeader(2)["Shift ID"], reply.shiftId);
  // The read refreshed the cache, so the old code no longer matches it.
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).refusal, "ACCESS");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
});

test("an old code works from a warm cache until a Settings edit stamps it", () => {
  const { s, clock } = kioskWithClock();
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  setCode(s, NEW_CODE);
  clock.now += 1000;
  // The worst case the stamp is there for: the cached copy still holds the old code.
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 1);
  // Staff typed the new code: onEdit stamps, and the next tap reads the tab.
  clock.now += 1000;
  s.ctx.onEdit(editOn("Settings"));
  clock.now += 1000;
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).refusal, "ACCESS");
  assert.equal(settingsReads(s), 2);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  assert.equal(plain(s.ctx.apiCheckOut(NEW_CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 2, "the read after the stamp is cached");
});

test("a cached copy is used until it is 5 minutes old", () => {
  const { s, clock } = kioskWithClock();
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  clock.now = NOW + 300000 - 1;
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 1);
  clock.now = NOW + 300000;
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 2, "5 minutes old: read the tab");
});

test("a Settings read that an edit lands during is not used after the edit's stamp", () => {
  const { s, clock } = kioskWithClock();
  const settings = s.sheets.Settings;
  // Staff change the code while the list call's read is on its way back: the read has the
  // old code, and the stamp comes after the read began but before the copy is cached.
  settings.afterValues = () => {
    settings.afterValues = null;
    setCode(s, NEW_CODE);
    clock.now += 1000;
    s.ctx.onEdit(editOn("Settings"));
    clock.now += 1000;
  };
  assert.equal(plain(s.ctx.apiListVolunteers(CODE)).ok, true);
  assert.ok(s.cache.has(s.ctx.settingsCacheKey()), "the old read was cached");
  // Had the copy carried the time it was put, it would pass; it carries the time the
  // read began, before the stamp, so the old code is checked against the tab.
  clock.now += 1000;
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).refusal, "ACCESS");
  assert.equal(settingsReads(s), 2);
  assert.equal(plain(s.ctx.apiCheckIn(NEW_CODE, SAM.id, null, null)).ok, true);
});

test("setSetting_ writes the value, flushes, then stamps, so the next tap reads the tab", () => {
  let s;
  const atFlush = [];
  ({ s } = kioskWithClock({
    onFlush: () =>
      atFlush.push({
        value: s.sheets.Settings.rows.find((r) => r[0] === "Profiles problems")?.[1],
        stamped: s.cache.has(s.ctx.settingsStampKey()),
      }),
  }));
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  s.ctx.setSetting_("Profiles problems", "row 5: no phone");
  assert.deepEqual(atFlush, [{ value: "row 5: no phone", stamped: false }]);
  assert.ok(s.cache.has(s.ctx.settingsStampKey()), "stamped after the flush");
  s.sheets.Settings.reads.length = 0;
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 1, "the tap reads the tab after the write");
});

test("setSetting_ with the cache down still writes and flushes, and logs the missed stamp", () => {
  const s = kiosk({ settingsCacheFails: true });
  s.ctx.setSetting_("Auto clock-out last run", "2026-11-12 4:10 AM: closed 0");
  assert.equal(
    s.sheets.Settings.rows.find((r) => r[0] === "Auto clock-out last run")[1],
    "2026-11-12 4:10 AM: closed 0",
  );
  assert.ok(s.journal.includes("flush"));
  assert.deepEqual(s.errors, ["Settings edit not stamped: cache.put failed"]);
});

test("onEdit stamps only for an edit on the Settings tab, and reads nothing", () => {
  for (const e of [undefined, null, {}, { range: null }, editOn("Log"), editOn("Flags")]) {
    const s = kiosk({});
    s.ctx.onEdit(e);
    assert.equal(s.cache.has(s.ctx.settingsStampKey()), false, JSON.stringify(e));
    assert.deepEqual(s.calls, [], JSON.stringify(e));
    assert.deepEqual(s.journal, [], JSON.stringify(e));
  }
  const s = kiosk({});
  s.ctx.onEdit(editOn("Settings"));
  assert.equal(s.cache.get(s.ctx.settingsStampKey()), String(NOW));
  assert.deepEqual(s.calls, ["CacheService.getScriptCache", "cache.put"]);
  assert.deepEqual(s.journal, []);
});

test("onEdit with the cache down fails nothing, and the old copy is used for 5 minutes at most", () => {
  const { s, clock } = kioskWithClock();
  assert.equal(plain(s.ctx.apiCheckAccess(CODE)).ok, true);
  setCode(s, NEW_CODE);
  clock.settingsCacheFails = true;
  assert.equal(s.ctx.onEdit(editOn("Settings")), undefined);
  assert.deepEqual(s.errors, ["Settings edit not stamped: cache.put failed"]);
  clock.settingsCacheFails = false;
  clock.now = NOW + 300000 - 1;
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true, "the missed stamp");
  clock.now = NOW + 300000;
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).refusal, "ACCESS");
  assert.equal(plain(s.ctx.apiCheckOut(NEW_CODE, SAM.id, null, null)).ok, true);
});

test("a cached copy that can't be read, or a stamp that can't, reads the tab and answers as usual", () => {
  const good = (s) => s.ctx.settingsCacheValue(plain(s.ctx.readSettings_()), NOW - 1000);
  const bad = [
    () => "not json",
    () => "",
    () => JSON.stringify({ v: 2, readAt: NOW - 1000, settings: {} }),
    (s) => good(s).replace(String(NOW - 1000), '"soon"'),
    (s) =>
      JSON.stringify({
        v: 1,
        readAt: NOW - 1000,
        settings: { ...plain(s.ctx.readSettings_()), "Kiosk access code": 7 },
      }),
    () => JSON.stringify({ v: 1, readAt: NOW - 1000, settings: [] }),
  ];
  for (const value of bad) {
    const s = kiosk({});
    const text = value(s);
    s.cache.set(s.ctx.settingsCacheKey(), text);
    s.sheets.Settings.reads.length = 0;
    assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true, text);
    assert.equal(settingsReads(s), 1, text);
    assert.deepEqual(s.errors, []);
    // The read replaced it with a copy the next tap can use.
    assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
    assert.equal(settingsReads(s), 1, text);
  }
  const s = kiosk({});
  const text = good(s);
  s.cache.set(s.ctx.settingsCacheKey(), text);
  s.cache.set(s.ctx.settingsStampKey(), "yesterday");
  s.sheets.Settings.reads.length = 0;
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 1, "an unreadable stamp");
});

test("with the cache down a tap reads the tab, answers as usual and logs the cache errors", () => {
  const s = kiosk({ settingsCacheFails: true });
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null));
  assert.equal(reply.ok, true);
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 2);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  assert.deepEqual(s.errors, [
    "Settings cache not read: cache.getAll failed",
    "Settings not cached: cache.put failed",
    "Settings cache not read: cache.getAll failed",
    "Settings not cached: cache.put failed",
  ]);
  const wrong = kiosk({ settingsCacheFails: true });
  assert.equal(plain(wrong.ctx.apiCheckIn(WRONG_CODE, SAM.id, null, null)).refusal, "ACCESS");
  assert.equal(settingsReads(wrong), 1);
  assert.equal(sleeps(wrong), 1);
});

const PROFILES = [
  [
    "Volunteer\nFirst Name",
    "Volunteer\nLast Name",
    "Volunteer\nPhone",
    "Start Date\nmm/dd/yyyy",
    "Onboarding\nToken",
  ],
  ["Sam", "Lee", "615-555-0131", "01/15/2026", "tok-sam"],
];
const PROFILE_SAM = createHash("sha256").update("tok-sam", "utf8").digest("hex").slice(0, 16);

test("with the Profiles cache down a tap reads the Profiles tab, answers as usual and logs the cache errors", () => {
  const s = kiosk({ profilesCacheFails: true, profiles: PROFILES });
  assert.equal(plain(s.ctx.apiCheckIn(CODE, PROFILE_SAM, null, null)).ok, true);
  assert.equal(plain(s.ctx.apiCheckOut(CODE, PROFILE_SAM, null, null)).ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  assert.deepEqual(s.errors, [
    "Profiles cache not read: cache.get failed",
    "Profiles not cached: cache.put failed",
    "Profiles cache not read: cache.get failed",
    "Profiles not cached: cache.put failed",
  ]);

  // A cached list that can't be read is a miss too, and the tab's list replaces it.
  const t = kiosk({ profiles: PROFILES });
  const key = t.ctx.profilesCacheKey("file-1", "Volunteer Profiles");
  t.cache.set(key, "not json");
  assert.equal(plain(t.ctx.apiCheckIn(CODE, PROFILE_SAM, null, null)).ok, true);
  assert.equal(JSON.parse(t.cache.get(key))[0].id, PROFILE_SAM);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0], /^Profiles cache not read: /);
});

test("Settings too big to cache are read on every tap, and an older copy is removed", () => {
  const big = [...KIOSK_SETTINGS, ["Profiles problems", "x".repeat(100000)]];
  const s = kiosk({ settings: big });
  // A copy cached while Settings were small.
  s.cache.set(
    s.ctx.settingsCacheKey(),
    s.ctx.settingsCacheValue(Object.fromEntries(KIOSK_SETTINGS.slice(1)), NOW - 1000),
  );
  assert.equal(plain(s.ctx.apiListVolunteers(CODE)).ok, true);
  assert.equal(s.cache.has(s.ctx.settingsCacheKey()), false, "the older copy is gone");
  assert.equal(plain(s.ctx.apiCheckIn(CODE, SAM.id, null, null)).ok, true);
  assert.equal(plain(s.ctx.apiCheckOut(CODE, SAM.id, null, null)).ok, true);
  assert.equal(settingsReads(s), 3);
  assert.equal(s.cache.has(s.ctx.settingsCacheKey()), false, "never put");
  assert.ok(!s.calls.includes("cache.put"), "nothing put");
  assert.deepEqual(s.errors, []);
});

// Two of a same-name group, who must give their phone's last four.
const ANN = {
  ...SAM,
  id: "cccccccccccccccc",
  firstName: "Ann",
  lastName: "Ruiz",
  phoneLast4: "1111",
  needsPhoneCheck: true,
  token: "tok-ann",
};
const ANN_TOO = { ...ANN, id: "dddddddddddddddd", phoneLast4: "2222", token: "tok-ann-2" };

test("a NOT_FOUND or PHONE_WRONG tap returns without reading the Log", () => {
  const taps = [
    ["NOT_FOUND", (s) => s.ctx.apiCheckIn(CODE, "eeeeeeeeeeeeeeee", null, null)],
    ["NOT_FOUND", (s) => s.ctx.apiCheckOut(CODE, "eeeeeeeeeeeeeeee", null, null)],
    ["PHONE_WRONG", (s) => s.ctx.apiCheckIn(CODE, ANN.id, null, "9999")],
    ["PHONE_WRONG", (s) => s.ctx.apiCheckOut(CODE, ANN.id, "9999", null)],
  ];
  for (const [code, tap] of taps) {
    const log = [LOG_HEADER, kioskOpen("s-ann", TODAY, "08:00", ANN.token, "Ann Ruiz")];
    const s = kiosk({ volunteers: [SAM, ANN, ANN_TOO], log });
    assert.equal(plain(tap(s)).refusal, code);
    assert.deepEqual(s.sheets.Log.reads, [], code + ": the Log is not read");
    assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
    assert.equal(s.sheets.Log.getLastRow(), 2);
    // A Log with no header row doesn't change the refusal: the Log is never reached.
    const broken = kiosk({ volunteers: [SAM, ANN, ANN_TOO], log: [[]] });
    assert.equal(plain(tap(broken)).refusal, code);
  }
  // The other member's digits pick that member, whose rows are then read.
  const log = [LOG_HEADER, kioskOpen("s-ann2", TODAY, "08:00", ANN_TOO.token, "Ann Ruiz")];
  const s = kiosk({ volunteers: [SAM, ANN, ANN_TOO], log });
  const out = plain(s.ctx.apiCheckOut(CODE, ANN.id, "2222", null));
  assert.equal(out.ok, true);
  assert.equal(out.id, ANN_TOO.id);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
});

test("the filtered Log read gives the same entries as the whole read filtered by token", () => {
  // More rows than the default 1000 grid rows, so a large Log still reads.
  const cellTokens = ["tok-sam", " tok-sam ", "TOK-SAM", "tok-ruth", "", 4321, "tok-samuel"];
  const log = [LOG_HEADER];
  for (let i = 0; i < 1200; i++) {
    const row = kioskOpen("s-" + i, TODAY, "08:00");
    row[LOG_HEADER.indexOf("User Token")] = cellTokens[i % cellTokens.length];
    // Dates typed as text, and some that can't be read.
    if (i % 3 === 0) row[LOG_HEADER.indexOf("Date")] = "11/" + (1 + (i % 28)) + "/2026";
    if (i % 11 === 0) row[LOG_HEADER.indexOf("Date")] = "soon";
    row[LOG_HEADER.indexOf("Status")] = i % 5 ? "closed" : "open";
    if (i % 7 === 0) row[LOG_HEADER.indexOf("Date")] = at(TODAY, "00:00");
    log.push(row);
  }
  const s = kiosk({ log });
  const cols = s.ctx.readLogColumns_();
  const whole = s.ctx.readLog_(cols);
  assert.equal(whole.length, 1200);
  for (const token of ["tok-sam", " tok-sam", "tok-ruth", "TOK-SAM", "4321", "nobody", "", " "]) {
    const table = s.ctx.readLogTable_(token);
    const want = whole.filter((e) => s.ctx.isTokenRow(e, token));
    assert.deepEqual(plain(table.entries), plain(want), "token " + JSON.stringify(token));
    assert.deepEqual(plain(table.cols), plain(cols));
    assert.equal(table.width, LOG_HEADER.length);
  }
  // Both spellings of tok-sam with padding are Sam's rows; a blank token keeps none.
  const sams = log.filter((r) => String(r[LOG_HEADER.indexOf("User Token")]).trim() === "tok-sam");
  assert.ok(sams.length > 300);
  assert.equal(s.ctx.readLogTable_("tok-sam").entries.length, sams.length);
  assert.deepEqual(plain(s.ctx.readLogTable_("").entries), []);
});

test("a same-name check-out with no digits closes the row of the only member of the name in", () => {
  const log = [LOG_HEADER, kioskOpen("s-ann", TODAY, "08:00", ANN.token, "Ann Ruiz")];
  const s = kiosk({ settings: WINDOW_SETTINGS, volunteers: [SAM, ANN, ANN_TOO], log });
  // The member who isn't in, with no digits: digits are asked for, and nothing is written.
  assert.equal(plain(s.ctx.apiCheckOut(CODE, ANN_TOO.id, null, null)).refusal, "PHONE_NEEDED");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  assert.equal(s.sheets.Log.getLastRow(), 2);
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  // The member who is in, at the tap time and after a short shift.
  const out = plain(s.ctx.apiCheckOut(CODE, ANN.id, null, null));
  assert.equal(out.ok, true);
  assert.equal(out.id, ANN.id);
  assert.equal(out.minutes, 120);
  const row = s.sheets.Log.rowByHeader(2);
  assert.equal(row.Status, "closed");
  assert.equal(row["Check-Out Entered By"], "kiosk");
  assert.equal(row["Admin Alerts?"], "");
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.deepEqual(s.errors, []);
});

test("the list reply carries the sheet's Long shift flag hours, and 8 when the cell is blank", () => {
  const withHours = (value) => [...KIOSK_SETTINGS, ["Long shift flag hours", value]];
  for (const [value, want] of [
    ["10", 10],
    ["8", 8],
    ["", 8],
  ]) {
    const s = kiosk({ settings: withHours(value) });
    const reply = plain(s.ctx.apiListVolunteers(CODE));
    assert.equal(reply.ok, true);
    assert.equal(reply.longShiftHours, want, "Long shift flag hours " + JSON.stringify(value));
  }
  // No such row at all.
  assert.equal(plain(kiosk({}).ctx.apiListVolunteers(CODE)).longShiftHours, 8);
});

test("the Log table read takes one token or a list, and keeps a row whose token is any of them", () => {
  const cellTokens = ["tok-sam", " tok-ruth", "tok-ann", "TOK-SAM", "", 4321, "tok-ann-2 "];
  const log = [LOG_HEADER];
  for (let i = 0; i < 70; i++) {
    const row = kioskOpen("s-" + i, TODAY, "08:00");
    row[LOG_HEADER.indexOf("User Token")] = cellTokens[i % cellTokens.length];
    row[LOG_HEADER.indexOf("Status")] = i % 3 ? "closed" : "open";
    log.push(row);
  }
  const s = kiosk({ log });
  const whole = s.ctx.readLog_(s.ctx.readLogColumns_());
  const keeps = (tokens) => whole.filter((e) => tokens.some((t) => s.ctx.isTokenRow(e, t)));
  // One token as a string, as the admin menu passes it, reads as a list of that one.
  for (const token of ["tok-sam", "tok-ruth", "4321", "", "nobody"]) {
    const one = plain(s.ctx.readLogTable_(token));
    assert.deepEqual(one.entries, plain(keeps([token])), "token " + JSON.stringify(token));
    assert.deepEqual(one, plain(s.ctx.readLogTable_([token])));
  }
  for (const tokens of [
    ["tok-ann", "tok-ann-2"],
    ["tok-sam", "tok-ruth", "tok-ann"],
    ["tok-ann", ""],
    [],
  ]) {
    const table = s.ctx.readLogTable_(tokens);
    assert.deepEqual(plain(table.entries), plain(keeps(tokens)), JSON.stringify(tokens));
    assert.equal(table.width, LOG_HEADER.length);
  }
  assert.equal(s.ctx.readLogTable_(["tok-ann", "tok-ann-2"]).entries.length, 20);
  // The admin menu's callers pass one volunteer's token.
  const admin = read("apps-script/Admin.js");
  const calls = admin.match(/readLogTable_\([^)]*\)/g);
  assert.deepEqual(calls, ["readLogTable_(volunteer.token)", "readLogTable_(picked.entry.token)"]);
});

// ---------------------------------------------------------------------------
// Nothing read after the Log write

const isRead = (entry) => entry.startsWith("read ");
const isLogWrite = (entry) => entry.startsWith("write Log ");

/**
 * The journal split at the call's first Log write: {before, after}, after starting with
 * that write. Fails when the call wrote nothing to the Log.
 */
const atFirstLogWrite = (journal) => {
  const i = journal.findIndex(isLogWrite);
  assert.ok(i > 0, "the call writes the Log");
  return { before: journal.slice(0, i), after: journal.slice(i) };
};

test("a flagged check-in reads nothing after its Log write", () => {
  const s = kiosk({});
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null));
  assert.equal(reply.ok, true);
  const { before, after } = atFirstLogWrite(s.journal.slice());
  assert.deepEqual(after.filter(isRead), [], "no read after the Log write");
  // Every Flags read came before it: the tab, its header, last row, grid and formats. A
  // tab with no rows below the header has no rows to read for the last one in use.
  const width = FLAG_HEADER.length;
  assert.deepEqual(
    before.filter((e) => e.startsWith("read Flags ")),
    [
      "read Flags getSheetByName",
      "read Flags getLastColumn",
      "read Flags getValues 1,1,1," + width,
      "read Flags getLastRow",
      "read Flags getMaxRows",
      "read Flags getNumberFormats 2,1,1," + width,
    ],
  );
  // After it: the Log cells, a flush, the Flags row, a flush, and the lock's closing flush.
  assert.deepEqual(
    after.filter((e) => !isLogWrite(e)),
    [
      "flush",
      "write Flags setNumberFormats 2,1,1," + width,
      "write Flags setValues 2,1,1," + width,
      "write Flags setDataValidation 2," + (FLAG_HEADER.indexOf("Reviewed") + 1) + ",1,1",
      "flush",
      "flush",
    ],
  );
  assert.equal(s.sheets.Flags.rowByHeader(2).Reason, "arrival differs by 24 min");
  assert.equal(s.sheets.Flags.rowByHeader(2)["Shift ID"], reply.shiftId);
  assert.equal(s.sheets.Flags.rowByHeader(2)["Log Row"], 2);
  assert.equal(s.sheets.Log.rowByHeader(2)["Admin Alerts?"], "arrival differs by 24 min");
  assert.deepEqual(s.errors, []);
});

test("a flagged check-out reads nothing after its Log write", () => {
  const s = kiosk({ log: [LOG_HEADER, kioskOpen("s-open", TODAY, "08:00")] });
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.equal(reply.ok, true);
  const { before, after } = atFirstLogWrite(s.journal.slice());
  assert.deepEqual(after.filter(isRead), [], "no read after the Log write");
  assert.ok(before.includes("read Flags getNumberFormats 2,1,1," + FLAG_HEADER.length));
  assert.deepEqual(
    after.filter((e) => e.startsWith("write Flags ")).map((e) => e.split(" ")[2]),
    ["setNumberFormats", "setValues", "setDataValidation"],
  );
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  const flag = s.sheets.Flags.rowByHeader(2);
  assert.deepEqual(
    [flag.Reason, flag["Shift ID"], flag.Source, flag["Log Row"]],
    ["check-out differs by 30 min", "s-open", "kiosk check-out", 2],
  );
  assert.equal(s.sheets.Flags.getLastRow(), 2);
  assert.deepEqual(s.errors, []);
});

test("a full Flags tab grows before the Log write and gets both flag rows", () => {
  // Today's open row with both check-in times blank: two flags on check-out.
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
  const journal = s.journal.slice();
  const { before, after } = atFirstLogWrite(journal);
  assert.deepEqual(after.filter(isRead), [], "no read after the Log write");
  const width = FLAG_HEADER.length;
  const grown = before.indexOf("write Flags insertRowsAfter 2,50");
  const formats = before.indexOf("read Flags getNumberFormats 3,1,2," + width);
  // The rows are read to find the last one in use, then the tab grows.
  const rows = before.indexOf("read Flags getValues 2,1,1," + width);
  assert.ok(rows >= 0 && rows < grown, "the rows were read before growing");
  assert.ok(grown >= 0, "the tab grew before the Log write");
  assert.ok(formats > grown, "the new rows' formats are read after growing");
  assert.deepEqual(s.sheets.Flags.inserted, [50]);
  assert.ok(after.includes("write Flags setValues 3,1,2," + width));
  const flags = s.sheets.Flags;
  assert.equal(flags.getLastRow(), 4);
  assert.deepEqual(
    [3, 4].map((r) => flags.rowByHeader(r).Reason),
    ["check-out differs by 30 min", "check-in time unreadable, stated hours left blank"],
  );
  assert.equal(flags.rowByHeader(2).Reviewed, true, "the row staff ticked is untouched");
  assert.deepEqual(s.errors, []);
});

test("a Flags plan that no longer matches the rows built writes no Flags row and is logged", () => {
  const s = kiosk({});
  const flagRows = s.ctx.flagRows;
  s.ctx.flagRows = (base, reasons) => flagRows(base, [...reasons, "one more"]);
  const reply = plain(s.ctx.apiCheckIn(CODE, SAM.id, minutesBefore(24), null));
  assert.equal(reply.ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.deepEqual(s.errors, [
    "Flags: not copied for Shift ID uuid-1: Flags rows planned for 1 rows, built 2.",
  ]);
});

test("the Flags plan counts only non-blank reasons, and raiseFlags_ with no plan plans itself", () => {
  const s = kiosk({});
  assert.equal(s.ctx.planFlags_([]), null);
  assert.equal(s.ctx.planFlags_(["", "  ", null]), null);
  assert.deepEqual(s.journal, [], "no reasons, no read");
  const base = {
    date: TODAY,
    name: "Sam Lee",
    shiftId: "s-1",
    raisedAtMs: NOW,
    source: "kiosk check-in",
    logRow: 2,
  };
  const plan = s.ctx.planFlags_(["late", " ", "early"]);
  assert.equal(plan.formats.length, 2);
  assert.equal(plan.first, 2);
  s.journal.length = 0;
  assert.equal(s.ctx.raiseFlags_(base, ["late", " ", "early"], plan), true);
  assert.deepEqual(s.journal.filter(isRead), []);
  assert.deepEqual(
    [2, 3].map((r) => s.sheets.Flags.rowByHeader(r).Reason),
    ["late", "early"],
  );
  // The jobs pass no plan: the reads happen here, then the write.
  assert.equal(s.ctx.raiseFlags_({ ...base, shiftId: "s-2" }, ["again"]), true);
  assert.equal(s.sheets.Flags.rowByHeader(4)["Shift ID"], "s-2");
  assert.ok(s.journal.includes("read Flags getNumberFormats 4,1,1," + FLAG_HEADER.length));
  assert.deepEqual(s.errors, []);
});

// ---------------------------------------------------------------------------
// Check-out re-checks its row

/**
 * Runs change once, after the first getValues on the sheet (the Log table read). Returns
 * a holder whose rows is the sheet as JSON just after the change: the Log as staff left it.
 */
const afterTableRead = (sheet, change) => {
  const left = { rows: null };
  sheet.afterValues = (sh) => {
    sh.afterValues = null;
    change(sh);
    left.rows = JSON.stringify(sh.rows);
  };
  return left;
};
/** Deletes Log row n as Sheets does: the rows below move up and the grid loses a row. */
const deleteRow = (sheet, n) => {
  sheet.rows.splice(n - 1, 1);
  sheet.maxRows -= 1;
};
const BUSY_TEXT = "The kiosk is busy. Please try again.";
const ruthOpen = () => kioskOpen("s-ruth", TODAY, "08:30", RUTH.token, "Ruth Okafor");

test("apiCheckOut answers BUSY and writes nothing when its row moved before the write", () => {
  const log = [LOG_HEADER, ruthOpen(), kioskOpen("s-sam", TODAY, "08:00")];
  const s = kiosk({ volunteers: [SAM, RUTH], log });
  // Staff sort the Log while the call runs: Sam's row moves up, Ruth's into row 3.
  const left = afterTableRead(
    s.sheets.Log,
    (sh) => ([sh.rows[1], sh.rows[2]] = [sh.rows[2], sh.rows[1]]),
  );
  // A flagged check-out, so the Flags plan has run too.
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.deepEqual(reply, { ok: false, refusal: "BUSY", message: BUSY_TEXT });
  assert.equal(JSON.stringify(s.sheets.Log.rows), left.rows, "the Log is as staff left it");
  assert.deepEqual(
    s.journal.filter((e) => e.startsWith("write ")),
    [],
    "nothing written",
  );
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.deepEqual(s.errors, [
    "Check-out: Log row 3 no longer holds open Shift ID s-sam; answered BUSY and wrote nothing.",
  ]);
  assert.equal(s.sheets.Log.rowByHeader(3)["Shift ID"], "s-ruth");
  assert.equal(s.sheets.Log.rowByHeader(3).Status, "open", "Ruth's row is not closed");

  // A retry reads the Log again and closes Sam's row where it now is.
  const retry = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.equal(retry.ok, true);
  assert.equal(s.sheets.Log.rowByHeader(2)["Shift ID"], "s-sam");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "closed");
  assert.equal(s.sheets.Log.rowByHeader(3).Status, "open");
  assert.equal(s.sheets.Flags.rowByHeader(2)["Log Row"], 2);
});

test("apiCheckOut answers BUSY when its row is gone past the Log's end", () => {
  // Past the grid: Sam's row was the last grid row, and staff deleted it.
  const log = [LOG_HEADER, ruthOpen(), kioskOpen("s-sam", TODAY, "08:00")];
  const past = kiosk({ volunteers: [SAM, RUTH], log, logMaxRows: 3 });
  const left = afterTableRead(past.sheets.Log, (sh) => deleteRow(sh, 3));
  const reply = plain(past.ctx.apiCheckOut(CODE, SAM.id, null, null));
  assert.deepEqual(reply, { ok: false, refusal: "BUSY", message: BUSY_TEXT });
  assert.ok(past.journal.includes("read Log getValues 3,1,1," + LOG_HEADER.length));
  assert.equal(JSON.stringify(past.sheets.Log.rows), left.rows);
  assert.deepEqual(
    past.journal.filter((e) => e.startsWith("write ")),
    [],
  );
  assert.deepEqual(past.errors, [
    "Log row 3 not read again for Shift ID s-sam: " +
      "The coordinates of the range are outside the dimensions of the sheet.",
    "Check-out: Log row 3 no longer holds open Shift ID s-sam; answered BUSY and wrote nothing.",
  ]);

  // Inside the grid: the row reads as blanks, which is no open row.
  const inside = kiosk({ volunteers: [SAM, RUTH], log });
  afterTableRead(inside.sheets.Log, (sh) => deleteRow(sh, 3));
  assert.ok(inside.sheets.Log.maxRows >= 3);
  const blank = plain(inside.ctx.apiCheckOut(CODE, SAM.id, null, null));
  assert.deepEqual(blank, { ok: false, refusal: "BUSY", message: BUSY_TEXT });
  assert.deepEqual(
    inside.journal.filter((e) => e.startsWith("write ")),
    [],
  );
  assert.equal(inside.sheets.Log.getLastRow(), 2);
  assert.equal(inside.sheets.Log.rowByHeader(2).Status, "open");
  assert.deepEqual(inside.errors, [
    "Check-out: Log row 3 no longer holds open Shift ID s-sam; answered BUSY and wrote nothing.",
  ]);
});

test("apiCheckOut writes as before when its row is unchanged", () => {
  const log = [LOG_HEADER, ruthOpen(), kioskOpen("s-sam", TODAY, "08:00")];
  const s = kiosk({ volunteers: [SAM, RUTH], log });
  // Staff edit a column of their own, and the Notes, on the row meanwhile: still Sam's open row.
  afterTableRead(s.sheets.Log, (sh) => {
    sh.rows[2][LOG_HEADER.indexOf("Staff column")] = "seen";
    sh.rows[2][LOG_HEADER.indexOf("Notes")] = "edited";
  });
  const reply = plain(s.ctx.apiCheckOut(CODE, SAM.id, null, minutesBefore(30)));
  assert.equal(reply.ok, true);
  assert.equal(reply.minutes, 90);
  const row = s.sheets.Log.rowByHeader(3);
  assert.equal(row["Shift ID"], "s-sam");
  assert.equal(row.Status, "closed");
  assert.equal(row["Check-Out Entered By"], "kiosk");
  assert.equal(row["Admin Alerts?"], "check-out differs by 30 min");
  assert.equal(row["Staff column"], "seen");
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open", "Ruth's row is untouched");
  assert.deepEqual(s.errors, []);
  // The row read again is the last read before the write, after the Flags plan.
  const journal = s.journal.slice();
  const { before, after } = atFirstLogWrite(journal);
  assert.deepEqual(after.filter(isRead), []);
  // The last cell read; updateLogRow_ still looks the tab up after it.
  const reads = before.filter((e) => isRead(e) && !e.endsWith(" getSheetByName"));
  assert.equal(reads[reads.length - 1], "read Log getValues 3,1,1," + LOG_HEADER.length);
  const plan = before.indexOf("read Flags getNumberFormats 2,1,1," + FLAG_HEADER.length);
  const reread = before.indexOf("read Log getValues 3,1,1," + LOG_HEADER.length);
  assert.ok(plan >= 0 && plan < reread, "the Flags plan comes before the row read");
  assert.equal(s.sheets.Flags.rowByHeader(2)["Log Row"], 3);
});

test("the row read again is null when the read throws, and a blank row past the end", () => {
  const log = [LOG_HEADER, kioskOpen("s-sam", TODAY, "08:00")];
  const s = kiosk({ log, logMaxRows: 2 });
  const cols = s.ctx.readLogColumns_();
  const read = s.ctx.logRead_();
  const width = LOG_HEADER.length;
  const entry = plain(s.ctx.readLogRowAt_(2, width, cols, read, "s-sam"));
  assert.deepEqual(entry, plain(s.ctx.readLog_(cols)[0]));
  assert.equal(s.ctx.readLogRowAt_(3, width, cols, read, "s-sam"), null);
  assert.deepEqual(s.errors, [
    "Log row 3 not read again for Shift ID s-sam: " +
      "The coordinates of the range are outside the dimensions of the sheet.",
  ]);
  // Any other Sheets error is null too, with its text.
  s.errors.length = 0;
  s.sheets.Log.afterValues = () => {
    throw new Error("Service Spreadsheets timed out");
  };
  assert.equal(s.ctx.readLogRowAt_(2, width, cols, read, " s-x "), null);
  assert.deepEqual(s.errors, [
    "Log row 2 not read again for Shift ID s-x: Service Spreadsheets timed out",
  ]);
  // Inside the grid, past the last used row: a blank entry, which is not open.
  const big = kiosk({ log });
  const blank = big.ctx.readLogRowAt_(5, width, cols, read, "s-sam");
  assert.equal(blank.row, 5);
  assert.equal(big.ctx.autoClockOutRowUnchanged(big.ctx.readLog_(cols)[0], blank), false);
});

// ---------------------------------------------------------------------------
// Kiosk admin > Email hours…

// The sample roster's people, in a Profiles tab with an Email column. Their ids are the
// hashed tokens, as the kiosk list makes them.
const EMAIL_PROFILE_HEADER = [
  "Volunteer\nFirst Name",
  "Volunteer\nLast Name",
  "Volunteer\nPhone",
  "Start Date\nmm/dd/yyyy",
  "Email",
  "Onboarding\nToken",
];
const person = (first, last, phone, email, token) => ({
  first,
  last,
  name: first + " " + last,
  phone,
  email,
  token,
  id: createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16),
});
const MARIA = person(
  "Maria",
  "Alvarez",
  "615-555-0101",
  "maria.alvarez@example.org",
  "sample-token-01",
);
const JAMES = person(
  "James",
  "Okafor",
  "615-555-0102",
  "james.okafor@example.org",
  "sample-token-02",
);
const DEV = person("Dev", "Patel", "615-555-0104", "dev.patel@example.org", "sample-token-04");
// On the Profiles tab only in the tests that add her; she has no shifts.
const ANA = person("Ana", "Diaz", "615-555-0105", "ana.diaz@example.org", "sample-token-05");
const profileRow = (p) => [p.first, p.last, p.phone, "02/15/2026", p.email, p.token];
const EMAIL_SETTINGS = [
  ["Setting", "Value"],
  ["Volunteer Profiles file ID", "file-1"],
  ["Volunteer Profiles tab", "Volunteer Profiles"],
  ["Hours email contact", "Pat Example\npat@example.org"],
  ["Hours email signature", ""],
];
const EMAIL_TODAY = "2026-11-14";
const EMAIL_NOW = centralMs(EMAIL_TODAY + " 10:00");
/** A closed kiosk shift: date, check-in and check-out "HH:mm" Central, and stated hours. */
const closedShift = (shiftId, p, date, from, to, hours) =>
  logRow({
    "Shift ID": shiftId,
    "User Token": p.token,
    Status: "closed",
    Date: date,
    "Volunteer Name": p.name,
    "Check-In Recorded (timestamp)": at(date, from),
    "Check-In Stated (user)": at(date, from),
    "Check-Out Recorded (timestamp)": at(date, to),
    "Check-Out Stated (user)": at(date, to),
    "Hours Served (timestamps)": hours,
    "Hours Served (stated)": hours,
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": "kiosk",
  });
const emailLog = () => [
  LOG_HEADER,
  closedShift("maria-1", MARIA, "2026-10-05", "09:00", "11:00", 2),
  closedShift("maria-2", MARIA, "2026-11-02", "09:00", "12:00", 3),
  closedShift("maria-3", MARIA, "2026-11-12", "13:00", "16:30", 3.5),
  closedShift("j-1", JAMES, "2026-11-03", "10:00", "12:15", 2.25),
  closedShift("d-1", DEV, "2026-11-04", "14:00", "15:00", 1),
];
/**
 * A server for the Email hours tests: the clock on EMAIL_NOW, a dialog key "k", Settings
 * with an Hours email contact, Profiles with Maria, James and Dev, and their shifts.
 * profiles is the Profiles tab's rows, which the test may change between calls: each
 * openById reads them afresh, while the kiosk list stays cached after its first read.
 */
const emailServer = (opts = {}) => {
  const settings = (opts.settings || EMAIL_SETTINGS).map((r) => r.slice());
  const profiles = opts.profiles || [EMAIL_PROFILE_HEADER, ...[MARIA, JAMES, DEV].map(profileRow)];
  const clock = { now: EMAIL_NOW };
  const s = server({
    keys: ["k"],
    log: emailLog(),
    ...opts,
    settings,
    profiles,
    get now() {
      return clock.now;
    },
  });
  // The per-volunteer log lines, kept out of the test output.
  const logs = [];
  s.ctx.console.log = (...args) => logs.push(args.join(" "));
  return { ...s, profiles, clock, logs };
};
const previewHours = (s, ids, more = {}) =>
  plain(s.ctx.adminHoursPreview("k", { ids, choice: "this", attach: false, ...more }));
const sendHours = (s, ticket, ids, initials = "JP") =>
  plain(s.ctx.adminSendHours("k", { ticket, ids, initials }));
/** The Hours emails tab's data rows, each as {header: value}. */
const hoursEmailRows = (s) => {
  const sheet = s.sheets["Hours emails"];
  if (!sheet) return [];
  const out = [];
  for (let r = 2; r <= sheet.lastRow(); r++) out.push(sheet.rowByHeader(r));
  return out;
};
const sentTo = (s) => s.mail.sent.map((m) => m.message.to);
const ticketKey = (ticket) => "hours-email:" + ticket;

const withEmail = (p, email) => {
  const row = profileRow(p);
  row[4] = email;
  return row;
};
/** The ticket a preview left in the script cache, as an object, or null. */
const ticketItem = (s, ticket) => {
  const text = s.cache.get(ticketKey(ticket));
  return text === undefined ? null : JSON.parse(text);
};
/** A row without its Sent at cell, which is checked on its own. */
const rowOf = (r) => {
  const { "Sent at": sentAt, ...rest } = r;
  return rest;
};
const R_TAKEN = "not sent: this preview has expired or was already sent for them";
const R_CHANGED = "not sent: changed since the preview; press Preview again to check it";
const R_QUOTA = "not sent: Google's daily email limit for this account is used up";
const R_GONE = "not sent: Not on the volunteer list any more; press Preview again.";
const CONTACT_PROBLEM =
  "Type who volunteers should contact about their hours in Hours email contact on the Settings tab, then press Preview again.";
const MARIA_CSV =
  "Date,Check-in,Check-out,Hours\r\n" +
  "2026-10-05,9:00 AM,11:00 AM,2.00\r\n" +
  "2026-11-02,9:00 AM,12:00 PM,3.00\r\n" +
  "2026-11-12,1:00 PM,4:30 PM,3.50\r\n";
const HOURS_COL = LOG_HEADER.indexOf("Hours Served\n(stated)");
/** The Log row (0-based in sheet.rows) of a Shift ID. */
const logIndex = (s, shiftId) => s.sheets.Log.rows.findIndex((r) => r[0] === shiftId);
/** A row the send writes, by header, for a volunteer and a result, before Sent at. */
const expectedRow = (sendId, p, result, hours, more = {}) => ({
  "Send ID": sendId,
  "Volunteer Name": p.name,
  "Volunteer ID": p.id,
  Email: p.email,
  Month: "2026-11",
  "Month hours": hours ? hours[0] : "",
  Year: "2026",
  "Year hours": hours ? hours[1] : "",
  "All-time hours": hours ? hours[2] : "",
  "Shifts file": "no",
  "Sent by": "JP",
  "Sent from": "staff@example.org",
  Result: result,
  ...more,
});
const MARIA_HOURS = [6.5, 8.5, 8.5];
const JAMES_HOURS = [2.25, 2.25, 2.25];
const DEV_HOURS = [1, 1, 1];

test("Email hours: a Send with no preview is refused as stale and sends nothing", () => {
  const s = emailServer();
  for (const ticket of ["uuid-9", "", undefined, "no such/ticket"]) {
    const reply = sendHours(s, ticket, [MARIA.id]);
    assert.deepEqual(reply, plain(s.ctx.refusal("HOURS_EMAIL_STALE")), String(ticket));
    assert.equal(
      reply.message,
      "This preview has expired or was already sent. Press Preview again.",
    );
  }
  // A ticket past its time is stale too, though the cache still holds it.
  const p = previewHours(s, [MARIA.id]);
  assert.ok(s.cache.has(ticketKey(p.ticket)));
  s.clock.now = EMAIL_NOW + s.ctx.adminKeySeconds() * 1000;
  assert.deepEqual(sendHours(s, p.ticket, [MARIA.id]), plain(s.ctx.refusal("HOURS_EMAIL_STALE")));
  assert.deepEqual(s.mail.sent, []);
  assert.equal(s.sheets["Hours emails"], undefined);
});

test("Email hours: a preview leaves out a volunteer with no email and tickets the rest", () => {
  const profiles = [EMAIL_PROFILE_HEADER, profileRow(MARIA), profileRow(JAMES), withEmail(DEV, "")];
  const s = emailServer({ profiles });
  const reply = previewHours(s, [DEV.id, MARIA.id, JAMES.id, MARIA.id]);
  assert.equal(reply.ok, true);
  assert.equal(reply.month, "2026-11");
  assert.equal(reply.asOf, EMAIL_TODAY);
  assert.equal(
    reply.from,
    "ENCM Volunteer Kiosk, from a no-reply address (sent by staff@example.org)",
  );
  // Roster order, each once.
  assert.deepEqual(
    reply.volunteers.map((v) => v.id),
    [MARIA.id, JAMES.id, DEV.id],
  );
  const dev = reply.volunteers[2];
  assert.equal(dev.to, "");
  assert.deepEqual(dev.problems, [
    "Volunteer Profiles row 4 has no email. Add it there, then press Preview again.",
  ]);
  // The hours still show, so the admin can check them.
  assert.equal(dev.totals.all.hundredths, 100);
  assert.equal(reply.volunteers[0].to, MARIA.email);
  assert.equal(reply.volunteers[0].profilesRow, 2);
  assert.equal(reply.volunteers[0].lastSent, "never");
  assert.deepEqual(reply.setProblems, []);
  assert.deepEqual(reply.sendIds, [MARIA.id, JAMES.id]);
  assert.equal(reply.chunkSize, 10);
  assert.ok(reply.ticket);
  const item = ticketItem(s, reply.ticket);
  assert.deepEqual(Object.keys(item.entries).sort(), [MARIA.id, JAMES.id].sort());
  assert.deepEqual(Object.keys(item.entries[MARIA.id]).sort(), ["digest", "label", "name", "to"]);
  assert.equal(item.entries[MARIA.id].name, "Maria Alvarez");
  assert.equal(item.entries[MARIA.id].label, "Maria Alvarez");
  assert.equal(item.entries[MARIA.id].to, MARIA.email);
  assert.match(item.entries[MARIA.id].digest, /^[0-9a-f]{64}$/);
  assert.equal(item.choice, "this");
  assert.equal(item.attach, false);
  // The Send ID is a uuid without its dashes, cut to 8 characters: "uuid-2" on the stand-in.
  assert.equal(item.sendId, "uuid2");
  // A preview sends nothing and reads the quota once, for the set.
  assert.deepEqual(s.mail.sent, []);
  assert.deepEqual(s.mail.events, [{ what: "quota", held: false }]);
  assert.equal(s.lock.tries, 0);

  // With nobody left to send, no ticket.
  const alone = previewHours(s, [DEV.id]);
  assert.deepEqual(alone.setProblems, [
    "None of the ticked volunteers can be sent; fix the problems shown, then press Preview again.",
  ]);
  assert.deepEqual(alone.sendIds, []);
  assert.equal(alone.ticket, "");
});

test("Email hours: a Send of the ticket sends each email as the flags email is sent, with the file when asked", () => {
  const s = emailServer();
  const preview = previewHours(s, [MARIA.id, JAMES.id], { attach: true });
  const sendId = ticketItem(s, preview.ticket).sendId;
  const reply = sendHours(s, preview.ticket, preview.sendIds);
  assert.deepEqual(reply, {
    ok: true,
    results: [
      { id: MARIA.id, result: "sent" },
      { id: JAMES.id, result: "sent" },
    ],
    recordFailed: false,
  });
  assert.deepEqual(sentTo(s), [MARIA.email, JAMES.email]);
  s.mail.sent.forEach(({ message }, i) => {
    const shown = preview.volunteers[i];
    // No replyTo, htmlBody, cc or bcc.
    assert.deepEqual(Object.keys(message).sort(), [
      "attachments",
      "body",
      "name",
      "noReply",
      "subject",
      "to",
    ]);
    assert.equal(message.subject, shown.subject);
    assert.equal(message.body, shown.body);
    assert.equal(message.name, s.ctx.flagsEmailSenderName());
    assert.equal(message.noReply, true);
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].type, "text/csv");
    assert.equal(message.attachments[0].name, "volunteer-hours-to-2026-11-14.csv");
  });
  assert.equal(s.mail.sent[0].message.attachments[0].text, MARIA_CSV);
  assert.equal(
    s.mail.sent[1].message.attachments[0].text,
    "Date,Check-in,Check-out,Hours\r\n2026-11-03,10:00 AM,12:15 PM,2.25\r\n",
  );
  const rows = hoursEmailRows(s);
  assert.deepEqual(rows.map(rowOf), [
    expectedRow(sendId, MARIA, "sent", MARIA_HOURS, { "Shifts file": "yes" }),
    expectedRow(sendId, JAMES, "sent", JAMES_HOURS, { "Shifts file": "yes" }),
  ]);
  for (const r of rows) assert.equal(r["Sent at"].getTime(), EMAIL_NOW);

  // Without the box, no attachments key at all.
  const t = emailServer();
  const plainPreview = previewHours(t, [MARIA.id]);
  assert.equal(plainPreview.volunteers[0].attachment, null);
  assert.equal(sendHours(t, plainPreview.ticket, [MARIA.id]).results[0].result, "sent");
  assert.deepEqual(Object.keys(t.mail.sent[0].message).sort(), [
    "body",
    "name",
    "noReply",
    "subject",
    "to",
  ]);
  assert.deepEqual(t.blobs, []);
  assert.equal(hoursEmailRows(t)[0]["Shifts file"], "no");
});

test("Email hours: the ticket in the cache decides, and a repeat gets what it holds", () => {
  // A second Send of the same set, after the first took every entry, is stale.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  sendHours(s, p.ticket, p.sendIds);
  assert.equal(s.cache.has(ticketKey(p.ticket)), false);
  assert.deepEqual(sendHours(s, p.ticket, p.sendIds), plain(s.ctx.refusal("HOURS_EMAIL_STALE")));
  assert.equal(s.mail.sent.length, 2);
  assert.equal(hoursEmailRows(s).length, 2);

  // Send [a, b], then [a, c]: a was already sent, c goes.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id, DEV.id]);
  sendHours(t, q.ticket, [MARIA.id, JAMES.id]);
  assert.deepEqual(Object.keys(ticketItem(t, q.ticket).entries), [DEV.id]);
  const mixed = sendHours(t, q.ticket, [MARIA.id, DEV.id]);
  assert.deepEqual(mixed.results, [
    { id: MARIA.id, result: R_TAKEN },
    { id: DEV.id, result: "sent" },
  ]);
  assert.deepEqual(sentTo(t), [MARIA.email, JAMES.email, DEV.email]);
  assert.deepEqual(
    hoursEmailRows(t).map((r) => r["Volunteer ID"]),
    [MARIA.id, JAMES.id, DEV.id],
  );
  assert.equal(t.cache.has(ticketKey(q.ticket)), false);

  // With a and c taken and b's entry still held, [a, c] takes nothing: no read, no row.
  const u = emailServer();
  const r = previewHours(u, [MARIA.id, JAMES.id, DEV.id]);
  sendHours(u, r.ticket, [MARIA.id, DEV.id]);
  const held = u.cache.get(ticketKey(r.ticket));
  u.sheets.Log.reads.length = 0;
  u.journal.length = 0;
  u.calls.length = 0;
  const takes = u.lock.takes;
  const none = sendHours(u, r.ticket, [MARIA.id, DEV.id]);
  assert.deepEqual(none, {
    ok: true,
    results: [
      { id: MARIA.id, result: R_TAKEN },
      { id: DEV.id, result: R_TAKEN },
    ],
    recordFailed: false,
  });
  assert.equal(u.mail.sent.length, 2);
  assert.deepEqual(u.sheets.Log.reads, []);
  assert.ok(!u.calls.includes("SpreadsheetApp.openById"));
  assert.deepEqual(
    u.journal.filter((j) => j.startsWith("write ")),
    [],
  );
  assert.equal(hoursEmailRows(u).length, 2);
  assert.equal(u.lock.takes, takes + 1);
  // b's entry is still there to send.
  assert.equal(u.cache.get(ticketKey(r.ticket)), held);
  assert.deepEqual(sendHours(u, r.ticket, [JAMES.id]).results, [{ id: JAMES.id, result: "sent" }]);
});

test("Email hours: a volunteer changed between Preview and Send isn't sent, and still gets a row", () => {
  // A Log hours cell changed.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  const sendId = ticketItem(s, p.ticket).sendId;
  s.sheets.Log.rows[logIndex(s, "j-1")][HOURS_COL] = 2.5;
  assert.deepEqual(sendHours(s, p.ticket, p.sendIds).results, [
    { id: MARIA.id, result: "sent" },
    { id: JAMES.id, result: R_CHANGED },
  ]);
  assert.deepEqual(sentTo(s), [MARIA.email]);
  assert.deepEqual(hoursEmailRows(s).map(rowOf), [
    expectedRow(sendId, MARIA, "sent", MARIA_HOURS),
    expectedRow(sendId, JAMES, R_CHANGED, null),
  ]);

  // A Profiles Email cell changed: the row keeps the previewed address.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id]);
  t.profiles[2][4] = "james.okafor.new@example.org";
  assert.deepEqual(sendHours(t, q.ticket, q.sendIds).results, [
    { id: MARIA.id, result: "sent" },
    { id: JAMES.id, result: R_CHANGED },
  ]);
  assert.deepEqual(sentTo(t), [MARIA.email]);
  assert.equal(hoursEmailRows(t)[1].Email, JAMES.email);
  assert.equal(hoursEmailRows(t)[1]["Month hours"], "");

  // Removed from Profiles: the row carries the previewed name, id and address.
  const u = emailServer();
  const r = previewHours(u, [MARIA.id, JAMES.id]);
  const uSendId = ticketItem(u, r.ticket).sendId;
  u.profiles.splice(2, 1);
  assert.deepEqual(sendHours(u, r.ticket, r.sendIds).results, [
    { id: MARIA.id, result: "sent" },
    { id: JAMES.id, result: R_GONE },
  ]);
  assert.deepEqual(hoursEmailRows(u).map(rowOf)[1], expectedRow(uSendId, JAMES, R_GONE, null));
  // One log line each, with the Volunteer ID and no name or address; a problem by its code.
  assert.deepEqual(u.logs, [
    "Hours email: sent (volunteer " + MARIA.id + ")",
    "Hours email: not sent (volunteer " + JAMES.id + "): not-found",
  ]);
});

test("Email hours: a blank Hours email contact stops every send", () => {
  const blank = EMAIL_SETTINGS.map((r) => (r[0] === "Hours email contact" ? [r[0], " \n  \n"] : r));
  const s = emailServer({ settings: blank });
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  assert.deepEqual(p.setProblems, [CONTACT_PROBLEM]);
  assert.equal(p.ticket, "");
  assert.deepEqual(p.sendIds, [MARIA.id, JAMES.id]);
  assert.ok(![...s.cache.keys()].some((k) => k.startsWith("hours-email:")));

  // Blanked between Preview and Send: each taken volunteer gets the problem and a row.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id]);
  const sendId = ticketItem(t, q.ticket).sendId;
  const row = t.sheets.Settings.rows.findIndex((r) => r[0] === "Hours email contact");
  t.sheets.Settings.rows[row][1] = "";
  const reply = sendHours(t, q.ticket, q.sendIds);
  assert.deepEqual(reply.results, [
    { id: MARIA.id, result: "not sent: " + CONTACT_PROBLEM },
    { id: JAMES.id, result: "not sent: " + CONTACT_PROBLEM },
  ]);
  assert.deepEqual(t.mail.sent, []);
  assert.deepEqual(hoursEmailRows(t).map(rowOf), [
    expectedRow(sendId, MARIA, "not sent: " + CONTACT_PROBLEM, null),
    expectedRow(sendId, JAMES, "not sent: " + CONTACT_PROBLEM, null),
  ]);
});

test("Email hours: the quota is read once for the set at Preview and right before each send", () => {
  const short = emailServer({ quota: 1 });
  const p = previewHours(short, [MARIA.id, JAMES.id]);
  assert.deepEqual(p.setProblems, [
    "This would send 2 emails, and Google allows 1 more from this account today. Untick some, or send the rest tomorrow.",
  ]);
  assert.equal(p.ticket, "");
  const none = emailServer({ quota: 0 });
  assert.deepEqual(previewHours(none, [MARIA.id]).setProblems, [
    "Google's daily email limit for this account is used up; try again tomorrow.",
  ]);

  // 2 at Preview, 1 at Send: the first goes, the second is held back, and both get a row.
  const s = emailServer({ quota: 2 });
  const q = previewHours(s, [MARIA.id, JAMES.id]);
  assert.ok(q.ticket);
  s.mail.quota = 1;
  s.mail.events.length = 0;
  assert.deepEqual(sendHours(s, q.ticket, q.sendIds).results, [
    { id: MARIA.id, result: "sent" },
    { id: JAMES.id, result: R_QUOTA },
  ]);
  assert.deepEqual(s.mail.events, [
    { what: "quota", held: false },
    { what: "send", to: MARIA.email, held: false },
    { what: "quota", held: false },
  ]);
  assert.deepEqual(
    hoursEmailRows(s).map((r) => r.Result),
    ["sent", R_QUOTA],
  );
});

test("Email hours: refusals before the take leave the ticket for the next Send", () => {
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  const item = s.cache.get(ticketKey(p.ticket));
  // Bad initials.
  for (const initials of ["", "  ", "J1", "toolong"]) {
    assert.deepEqual(
      sendHours(s, p.ticket, p.sendIds, initials),
      plain(s.ctx.refusal("ADMIN_INITIALS")),
    );
  }
  // Eleven ids in one call.
  const eleven = [MARIA.id, ...Array.from({ length: 10 }, (_, i) => "f".repeat(15) + i)];
  assert.deepEqual(sendHours(s, p.ticket, eleven), plain(s.ctx.refusal("HOURS_EMAIL_TOO_MANY")));
  // The lock held elsewhere.
  s.lock.busy = true;
  assert.deepEqual(sendHours(s, p.ticket, p.sendIds), plain(s.ctx.refusal("BUSY")));
  s.lock.busy = false;
  assert.equal(s.cache.get(ticketKey(p.ticket)), item);
  assert.deepEqual(s.mail.sent, []);
  assert.equal(s.sheets["Hours emails"], undefined);
  assert.equal(s.lock.held, false);
  // The same ticket then sends; an id named twice is handled once.
  assert.deepEqual(sendHours(s, p.ticket, [MARIA.id, MARIA.id], "j.p.").results, [
    { id: MARIA.id, result: "sent" },
  ]);
  assert.deepEqual(sendHours(s, p.ticket, [JAMES.id]).results, [{ id: JAMES.id, result: "sent" }]);
  assert.deepEqual(sentTo(s), [MARIA.email, JAMES.email]);
  assert.deepEqual(
    hoursEmailRows(s).map((r) => [r["Volunteer ID"], r["Sent by"]]),
    [
      [MARIA.id, "JP"],
      [JAMES.id, "JP"],
    ],
  );
});

// Twenty-three sample volunteers with a shift each, for the runs of three calls.
const CROWD = Array.from({ length: 23 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return person(
    "Sample",
    "Person " + n,
    "615-555-02" + n,
    "sample.person" + n + "@example.org",
    "sample-token-2" + n,
  );
});
const crowdServer = (opts = {}) =>
  emailServer({
    profiles: [EMAIL_PROFILE_HEADER, ...CROWD.map(profileRow)],
    log: [
      LOG_HEADER,
      ...CROWD.map((p, i) =>
        closedShift("c-" + i, p, "2026-11-0" + (1 + (i % 9)), "09:00", "10:00", 1),
      ),
    ],
    ...opts,
  });
const inCalls = (ids) => [ids.slice(0, 10), ids.slice(10, 20), ids.slice(20)];

test("Email hours: a preview of 23 sent in calls of 10, 10 and 3 sends each once", () => {
  const s = crowdServer();
  const p = previewHours(
    s,
    CROWD.map((c) => c.id),
  );
  assert.equal(p.sendIds.length, 23);
  const sendId = ticketItem(s, p.ticket).sendId;
  for (const ids of inCalls(p.sendIds)) {
    const reply = sendHours(s, p.ticket, ids);
    assert.deepEqual(
      reply.results,
      ids.map((id) => ({ id, result: "sent" })),
    );
  }
  assert.equal(new Set(sentTo(s)).size, 23);
  assert.equal(s.mail.sent.length, 23);
  const rows = hoursEmailRows(s);
  assert.equal(rows.length, 23);
  assert.equal(new Set(rows.map((r) => r["Volunteer ID"])).size, 23);
  assert.deepEqual([...new Set(rows.map((r) => r["Send ID"]))], [sendId]);
  assert.equal(s.cache.has(ticketKey(p.ticket)), false);
});

test("Email hours: one volunteer's MailApp failure doesn't stop the rest", () => {
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id, DEV.id]);
  const sendId = ticketItem(s, p.ticket).sendId;
  s.faults.sendEmail = (m) => (m.to === JAMES.email ? "Service unavailable: Gmail" : null);
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(reply, {
    ok: true,
    results: [
      { id: MARIA.id, result: "sent" },
      { id: JAMES.id, result: "failed: Service unavailable: Gmail" },
      { id: DEV.id, result: "sent" },
    ],
    recordFailed: false,
  });
  assert.deepEqual(sentTo(s), [MARIA.email, DEV.email]);
  // A failed row carries the hours, as a sent one does.
  assert.deepEqual(hoursEmailRows(s).map(rowOf), [
    expectedRow(sendId, MARIA, "sent", MARIA_HOURS),
    expectedRow(sendId, JAMES, "failed: Service unavailable: Gmail", JAMES_HOURS),
    expectedRow(sendId, DEV, "sent", DEV_HOURS),
  ]);
});

test("Email hours: Google's message is logged with any address masked, and the Result cell keeps it whole", () => {
  const said = "Invalid email: " + JAMES.email;
  const masked = "failed: Invalid email: [address]";
  // The rows can't be written, so the result also goes to the error log.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  s.faults.sendEmail = (m) => (m.to === JAMES.email ? said : null);
  s.faults.insertSheet = () => true;
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(reply.results, [
    { id: MARIA.id, result: "sent" },
    { id: JAMES.id, result: "failed: " + said },
  ]);
  assert.equal(reply.recordFailed, true);
  assert.ok(
    s.logs.includes("Hours email: failed (volunteer " + JAMES.id + "): " + masked.slice(8)),
  );
  assert.equal(s.errors.length, 1);
  assert.ok(s.errors[0].includes("volunteer " + JAMES.id + ": " + masked), s.errors[0]);
  for (const line of [...s.logs, ...s.errors]) assert.doesNotMatch(line, /@/);

  // The tab's Result cell has the message as Google gave it.
  const t = emailServer();
  const q = previewHours(t, [JAMES.id]);
  t.faults.sendEmail = () => said;
  assert.equal(sendHours(t, q.ticket, [JAMES.id]).results[0].result, "failed: " + said);
  assert.equal(hoursEmailRows(t)[0].Result, "failed: " + said);
  for (const line of t.logs) assert.doesNotMatch(line, /@/);
});

test("Email hours: with the box ticked, a volunteer with no counted shifts gets no file and no file line", () => {
  const s = emailServer({
    profiles: [EMAIL_PROFILE_HEADER, profileRow(MARIA), profileRow(ANA)],
  });
  const p = previewHours(s, [MARIA.id, ANA.id], { attach: true });
  const [maria, shown] = p.volunteers;
  assert.equal(shown.id, ANA.id);
  assert.deepEqual(maria.attachment, { name: "volunteer-hours-to-2026-11-14.csv", shifts: 3 });
  assert.equal(shown.attachment, null);
  assert.equal(shown.totals.all.shifts, 0);
  assert.doesNotMatch(shown.body, /attached|spreadsheet/);
  assert.deepEqual(
    shown.warnings.map((w) => w.text),
    [
      "This volunteer has no counted hours yet; the email will say so. The shifts file is left out, since there are no shifts to list.",
    ],
  );
  // The digest covers the email with no file: an empty csv.
  const digest = s.ctx.sha256Hex_(
    s.ctx.hoursEmailDigestText({
      id: ANA.id,
      to: ANA.email,
      choice: "this",
      month: "2026-11",
      asOf: EMAIL_TODAY,
      attach: true,
      subject: shown.subject,
      body: shown.body,
      csv: "",
    }),
  );
  assert.equal(ticketItem(s, p.ticket).entries[ANA.id].digest, digest);

  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(
    reply.results.map((r) => r.result),
    ["sent", "sent"],
  );
  const [toMaria, toAna] = s.mail.sent.map((m) => m.message);
  assert.equal(toMaria.attachments.length, 1);
  assert.equal(toAna.to, ANA.email);
  assert.equal(toAna.body, shown.body);
  assert.equal("attachments" in toAna, false);
  assert.equal(s.blobs.length, 1);
  // Shifts file says whether the email carried the file: yes for Maria, no for Ana.
  assert.deepEqual(
    hoursEmailRows(s).map((r) => r["Shifts file"]),
    ["yes", "no"],
  );
});

/** Asserts errors holds one entry, naming the Send ID and each id with its result, and no name or address. */
const assertRowsLogged = (s, sendId, results) => {
  assert.equal(s.errors.length, 1, s.errors.join("\n"));
  const line = s.errors[0];
  assert.ok(line.includes(sendId), line);
  for (const { id, result } of results)
    assert.ok(line.includes("volunteer " + id + ": " + result), line);
  assert.doesNotMatch(line, /Maria|James|Dev|Alvarez|Okafor|Patel|@/);
};

test("Email hours: rows that can't be written are reported, and the emails still went", () => {
  // The write throws.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id, DEV.id]);
  const sendId = ticketItem(s, p.ticket).sendId;
  s.faults.insertSheet = () => true;
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.equal(reply.ok, true);
  assert.equal(reply.recordFailed, true);
  assert.equal(s.mail.sent.length, 3);
  assert.equal(s.sheets["Hours emails"], undefined);
  assertRowsLogged(s, sendId, reply.results);

  // The rows step's lock is busy.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id, DEV.id]);
  const tSendId = ticketItem(t, q.ticket).sendId;
  t.lock.busy = (n) => n === 1;
  const busy = sendHours(t, q.ticket, q.sendIds);
  assert.equal(busy.ok, true);
  assert.equal(busy.recordFailed, true);
  assert.equal(t.mail.sent.length, 3);
  assert.deepEqual(hoursEmailRows(t), []);
  assertRowsLogged(t, tSendId, busy.results);
});

test("Email hours: a read that throws after the take sends nothing and still writes a row each", () => {
  const breaks = {
    Log: (s) =>
      (s.sheets.Log.afterValues = () => {
        throw new Error("Log read failed");
      }),
    Profiles: (s) => (s.faults.openById = () => true),
    Settings: (s) =>
      (s.sheets.Settings.afterValues = () => {
        throw new Error("Settings read failed");
      }),
  };
  const messages = {
    Log: "Log read failed",
    Profiles: "Profiles read failed",
    Settings: "Settings read failed",
  };
  for (const [what, breakIt] of Object.entries(breaks)) {
    const s = emailServer();
    const p = previewHours(s, [MARIA.id, JAMES.id]);
    const sendId = ticketItem(s, p.ticket).sendId;
    breakIt(s);
    const result = "not sent: " + messages[what];
    assert.deepEqual(
      sendHours(s, p.ticket, p.sendIds),
      {
        ok: true,
        results: [
          { id: MARIA.id, result },
          { id: JAMES.id, result },
        ],
        recordFailed: false,
      },
      what,
    );
    assert.deepEqual(s.mail.sent, [], what);
    assert.deepEqual(
      hoursEmailRows(s).map(rowOf),
      [expectedRow(sendId, MARIA, result, null), expectedRow(sendId, JAMES, result, null)],
      what,
    );
    // The taken entries are gone from the ticket.
    assert.deepEqual(
      sendHours(s, p.ticket, p.sendIds),
      plain(s.ctx.refusal("HOURS_EMAIL_STALE")),
      what,
    );
  }
  // A Flags read that throws sends as usual.
  const f = emailServer();
  const q = previewHours(f, [MARIA.id, JAMES.id]);
  f.sheets.Flags.afterValues = () => {
    throw new Error("Flags read failed");
  };
  assert.deepEqual(
    sendHours(f, q.ticket, q.sendIds).results.map((r) => r.result),
    ["sent", "sent"],
  );
});

test("Email hours: a throw before the take leaves the ticket as it was", () => {
  // The account read for Sent from: the guard's read is the first, this the second.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  const item = s.cache.get(ticketKey(p.ticket));
  let reads = 0;
  s.faults.account = () => ++reads === 2;
  assert.throws(() => sendHours(s, p.ticket, p.sendIds), /Session read failed/);
  assert.equal(s.cache.get(ticketKey(p.ticket)), item);
  assert.deepEqual(s.mail.sent, []);
  assert.equal(s.sheets["Hours emails"], undefined);
  s.faults.account = null;
  assert.deepEqual(
    sendHours(s, p.ticket, p.sendIds).results.map((r) => r.result),
    ["sent", "sent"],
  );

  // The ticket's put inside the take.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id]);
  const held = t.cache.get(ticketKey(q.ticket));
  t.faults.cachePut = (k) => k.startsWith("hours-email:");
  assert.throws(() => sendHours(t, q.ticket, [MARIA.id]), /cache\.put failed/);
  assert.equal(t.cache.get(ticketKey(q.ticket)), held);
  assert.equal(t.lock.held, false);
  assert.deepEqual(t.mail.sent, []);
  assert.equal(t.sheets["Hours emails"], undefined);
  assert.deepEqual(t.errors, []);
  t.faults.cachePut = null;
  assert.deepEqual(sendHours(t, q.ticket, [MARIA.id]).results, [{ id: MARIA.id, result: "sent" }]);
  assert.deepEqual(Object.keys(ticketItem(t, q.ticket).entries), [JAMES.id]);
});

test("Email hours: a lock that throws after its work is read against what the work had done", () => {
  // The take's flush throws after the put: the entries are taken, sent and written.
  const s = emailServer();
  const p = previewHours(s, [MARIA.id, JAMES.id]);
  let flushes = 0;
  s.faults.flush = () => ++flushes === 1;
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(
    reply.results.map((r) => r.result),
    ["sent", "sent"],
  );
  assert.equal(reply.recordFailed, false);
  assert.equal(hoursEmailRows(s).length, 2);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /after the take/);
  assert.equal(s.lock.held, false);

  // The rows' flush throws after the range write: the rows are on the tab.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id]);
  let tFlushes = 0;
  t.faults.flush = () => ++tFlushes === 2;
  const after = sendHours(t, q.ticket, q.sendIds);
  assert.deepEqual(
    after.results.map((r) => r.result),
    ["sent", "sent"],
  );
  assert.equal(after.recordFailed, false);
  assert.equal(hoursEmailRows(t).length, 2);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0], /rows written for Send ID/);
  assert.equal(t.lock.held, false);
});

test("Email hours: across a run with a busy rows lock, a read that throws and a MailApp failure, each id is recorded once", () => {
  const s = crowdServer();
  const p = previewHours(
    s,
    CROWD.map((c) => c.id),
  );
  const [first, second, third] = inCalls(p.sendIds);
  // The first call's take is try 0 and its rows try 1.
  s.lock.busy = (n) => n === 1;
  assert.equal(sendHours(s, p.ticket, first).recordFailed, true);
  s.sheets.Log.afterValues = () => {
    throw new Error("Log read failed");
  };
  const middle = sendHours(s, p.ticket, second);
  assert.deepEqual(
    new Set(middle.results.map((r) => r.result)),
    new Set(["not sent: Log read failed"]),
  );
  s.sheets.Log.afterValues = null;
  const failing = CROWD.find((c) => c.id === third[1]).email;
  s.faults.sendEmail = (m) => (m.to === failing ? "Service unavailable" : null);
  const last = sendHours(s, p.ticket, third);
  assert.deepEqual(
    last.results.map((r) => r.result),
    ["sent", "failed: Service unavailable", "sent"],
  );

  const written = hoursEmailRows(s).map((r) => r["Volunteer ID"]);
  const logged = s.errors.flatMap((e) =>
    [...e.matchAll(/volunteer ([0-9a-f]{16})/g)].map((m) => m[1]),
  );
  assert.equal(written.length, 13);
  assert.equal(logged.length, 10);
  const all = [...written, ...logged];
  assert.equal(all.length, 23);
  assert.deepEqual([...all].sort(), [...p.sendIds].sort());
  assert.equal(s.cache.has(ticketKey(p.ticket)), false);
});

test("Email hours: addresses are read by token, a duplicate token stops that volunteer only, and the Profiles cache keeps no email", () => {
  const s = emailServer();
  const first = previewHours(s, [MARIA.id, JAMES.id]);
  // Rows reordered between Preview and Send: still each volunteer's own address.
  s.profiles.splice(1, 2, profileRow(JAMES), profileRow(MARIA));
  assert.deepEqual(
    sendHours(s, first.ticket, first.sendIds).results.map((r) => r.result),
    ["sent", "sent"],
  );
  assert.deepEqual(sentTo(s), [MARIA.email, JAMES.email]);
  const again = previewHours(s, [MARIA.id, JAMES.id]);
  assert.deepEqual(
    again.volunteers.map((v) => [v.to, v.profilesRow]),
    [
      [MARIA.email, 3],
      [JAMES.email, 2],
    ],
  );

  // A second row with James's token, typed after the kiosk list was cached.
  s.profiles.push(withEmail(JAMES, "james.other@example.org"));
  const dup = previewHours(s, [MARIA.id, JAMES.id]);
  assert.deepEqual(dup.volunteers[1].problems, [
    "Volunteer Profiles rows 2 and 5 have the same User Token. Fix it there, then press Preview again.",
  ]);
  assert.equal(dup.volunteers[1].to, "");
  assert.deepEqual(dup.volunteers[0].problems, []);
  assert.deepEqual(dup.sendIds, [MARIA.id]);
  assert.ok(dup.ticket);

  // The kiosk list in the cache: the same key and shape as before, with no email.
  const key = "profiles:v2:file-1:Volunteer Profiles";
  assert.equal(s.ctx.profilesCacheKey("file-1", "Volunteer Profiles"), key);
  const cached = JSON.parse(s.cache.get(key));
  assert.equal(cached.length, 3);
  for (const v of cached) {
    assert.deepEqual(Object.keys(v).sort(), [
      "firstName",
      "id",
      "lastName",
      "needsPhoneCheck",
      "phoneLast4",
      "row",
      "startDate",
      "token",
    ]);
  }
  assert.ok(!s.cache.get(key).includes("@"));
});

test("Email hours: the period is worked out on Central dates at Preview and again at Send", () => {
  const decLog = [LOG_HEADER, closedShift("m-dec", MARIA, "2026-12-31", "09:00", "12:00", 3)];
  // 2027-01-01 05:30 UTC is 2026-12-31 23:30 Central.
  const s = emailServer({ log: decLog });
  s.clock.now = Date.UTC(2027, 0, 1, 5, 30);
  const thisMonth = previewHours(s, [MARIA.id]).volunteers[0];
  assert.equal(thisMonth.subject, "Your volunteer hours for December 2026");
  assert.ok(thisMonth.body.includes("\n  December 2026 so far: 3.00 hours (1 shift)\n"));
  assert.ok(thisMonth.body.includes("\n  2026 so far: 3.00 hours (1 shift)\n"));

  s.clock.now = Date.UTC(2027, 0, 3, 17, 0);
  const lastMonth = previewHours(s, [MARIA.id], { choice: "last" });
  assert.equal(lastMonth.month, "2026-12");
  assert.equal(lastMonth.asOf, "2026-12-31");
  assert.equal(lastMonth.volunteers[0].subject, "Your volunteer hours for December 2026");
  assert.ok(lastMonth.volunteers[0].body.includes("\n  December 2026: 3.00 hours (1 shift)\n"));
  assert.ok(
    lastMonth.volunteers[0].body.includes("\n  2026 through December: 3.00 hours (1 shift)\n"),
  );

  // A Preview just before midnight and a Send just after give different months.
  const t = emailServer({ log: decLog });
  t.clock.now = centralMs("2026-12-31 23:59");
  const p = previewHours(t, [MARIA.id]);
  t.clock.now = centralMs("2027-01-01 00:01");
  assert.deepEqual(sendHours(t, p.ticket, [MARIA.id]).results, [
    { id: MARIA.id, result: R_CHANGED },
  ]);
  assert.deepEqual(t.mail.sent, []);
});

test("Email hours: the Hours emails tab is made once, and every cell from a sheet is written as text", () => {
  const eq = person("=Pat", "Example", "615-555-0199", "=pat@example.org", "sample-token-99");
  const profiles = [
    EMAIL_PROFILE_HEADER,
    profileRow(MARIA),
    profileRow(JAMES),
    profileRow(DEV),
    profileRow(eq),
  ];
  const s = emailServer({
    profiles,
    log: [
      ...emailLog(),
      closedShift("j-0", JAMES, "2026-10-20", "09:00", "10:30", 1.5),
      closedShift("d-0", DEV, "2026-10-21", "09:00", "10:00", 1),
      closedShift("e-0", eq, "2026-10-06", "09:00", "10:00", 1),
    ],
  });
  // Last month, with the file: Maria and Pat sent, James failed, Dev changed.
  const p = previewHours(s, [MARIA.id, JAMES.id, DEV.id, eq.id], { choice: "last", attach: true });
  assert.deepEqual(p.sendIds, [MARIA.id, eq.id, JAMES.id, DEV.id]);
  const sendId = ticketItem(s, p.ticket).sendId;
  s.faults.sendEmail = (m) => (m.to === JAMES.email ? "Service unavailable" : null);
  s.sheets.Log.rows[logIndex(s, "d-0")][HOURS_COL] = 4;
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(
    reply.results.map((r) => r.result),
    ["sent", "sent", "failed: Service unavailable", R_CHANGED],
  );
  const sheet = s.sheets["Hours emails"];
  assert.deepEqual(sheet.rows[0], plain(s.ctx.hoursEmailHeaders()));
  assert.equal(sheet.frozenRows, 1);
  assert.equal(sheet.protections.length, 1);
  assert.deepEqual(sheet.protections[0].state, {
    description: "Hours emails: written by Kiosk admin > Email hours…. Edit only to fix a mistake.",
    warningOnly: true,
  });
  const last = { Month: "2026-10", "Shifts file": "yes" };
  assert.deepEqual(hoursEmailRows(s).map(rowOf), [
    expectedRow(sendId, MARIA, "sent", [2, 2, 2], last),
    // A name or address starting "=" is text, not a formula.
    expectedRow(sendId, eq, "sent", [1, 1, 1], {
      ...last,
      "Volunteer Name": "'=Pat Example",
      Email: "'=pat@example.org",
    }),
    expectedRow(sendId, JAMES, "failed: Service unavailable", [1.5, 1.5, 1.5], last),
    // A failed email was built with the file; one not sent carried nothing.
    expectedRow(sendId, DEV, R_CHANGED, null, { ...last, "Shifts file": "no" }),
  ]);
  // Sent at a date-time, the hours numbers with two places, every other column text.
  const formats = { date: "yyyy-mm-dd h:mm am/pm", hours: "0.00", text: "@" };
  const kinds = s.ctx.hoursEmailColumnKinds();
  for (let row = 2; row <= 5; row++) {
    sheet.rows[0].forEach((h, i) => {
      assert.equal(sheet.formats[row + ":" + (i + 1)], formats[kinds[h]], row + " " + h);
    });
    assert.equal(sheet.rows[row - 1][0].getTime(), EMAIL_NOW);
  }

  // A second write adds rows under the first and no second protection.
  s.faults.sendEmail = null;
  const q = previewHours(s, [MARIA.id]);
  const secondId = ticketItem(s, q.ticket).sendId;
  assert.notEqual(secondId, sendId);
  assert.equal(q.volunteers[0].lastSent, "2026-11-14 by JP");
  sendHours(s, q.ticket, [MARIA.id], "ab");
  assert.equal(sheet.lastRow(), 6);
  assert.equal(sheet.protections.length, 1);
  assert.equal(sheet.frozenRows, 1);
  assert.deepEqual(sheet.rows[0], plain(s.ctx.hoursEmailHeaders()));
  assert.deepEqual(rowOf(hoursEmailRows(s)[4]), {
    ...expectedRow(secondId, MARIA, "sent", MARIA_HOURS),
    "Sent by": "AB",
  });
});

/** An Hours emails row as the tab holds it, in the header's order. */
const sentRow = (date, p, by, result) => [
  at(date, "09:00"),
  "s-" + date,
  p.name,
  p.id,
  p.email,
  "2026-10",
  2,
  "2026",
  2,
  2,
  "no",
  by,
  "staff@example.org",
  result,
];

const HOURS_EMAILS_HEADER = [
  "Sent at",
  "Send ID",
  "Volunteer Name",
  "Volunteer ID",
  "Email",
  "Month",
  "Month hours",
  "Year",
  "Year hours",
  "All-time hours",
  "Shifts file",
  "Sent by",
  "Sent from",
  "Result",
];

test("Email hours: Last emailed is the newest sent row, never with no tab and unknown when the tab can't be read", () => {
  const hoursEmails = [
    HOURS_EMAILS_HEADER,
    sentRow("2026-11-03", MARIA, "JP", "sent"),
    sentRow("2026-11-05", MARIA, "AB", "failed: Service unavailable"),
    sentRow("2026-11-06", MARIA, "CD", R_CHANGED),
    // An older send lower down the tab.
    sentRow("2026-11-01", MARIA, "EF", "sent"),
    sentRow("2026-11-07", DEV, "GH", "not sent: " + CONTACT_PROBLEM),
  ];
  const s = emailServer({ hoursEmails });
  const p = previewHours(s, [MARIA.id, JAMES.id, DEV.id]);
  assert.deepEqual(
    p.volunteers.map((v) => v.lastSent),
    ["2026-11-03 by JP", "never", "never"],
  );
  assert.ok(p.ticket);

  // No tab: never, and the send makes the tab.
  const none = emailServer();
  const q = previewHours(none, [MARIA.id]);
  assert.equal(q.volunteers[0].lastSent, "never");
  assert.equal(sendHours(none, q.ticket, [MARIA.id]).results[0].result, "sent");

  // A tab that can't be read: unknown, and the send still goes.
  const t = emailServer({ hoursEmails });
  t.sheets["Hours emails"].afterValues = () => {
    throw new Error("Hours emails read failed");
  };
  const r = previewHours(t, [MARIA.id, JAMES.id]);
  assert.deepEqual(
    r.volunteers.map((v) => v.lastSent),
    ["unknown", "unknown"],
  );
  assert.deepEqual(r.setProblems, []);
  assert.ok(r.ticket);
  t.sheets["Hours emails"].afterValues = null;
  assert.deepEqual(
    sendHours(t, r.ticket, r.sendIds).results.map((x) => x.result),
    ["sent", "sent"],
  );
  assert.equal(hoursEmailRows(t).length, 7);
});

// The window's tests read tests/hours-email-replies.json as the server's preview and send
// replies. This test holds that file to what the server returns, so a change of shape on
// either side fails a test. When a change is meant, copy the server's reply (the actual
// value below) into the file and check the window's test against it.
test("Email hours: the replies the window's tests use are the server's own", () => {
  const log = emailLog();
  const alerts = LOG_HEADER.findIndex((h) => h.replace(/\s+/g, " ") === "Admin Alerts?");
  const jamesRow = log.findIndex((r) => r[0] === "j-1");
  log[jamesRow][alerts] = "arrival differs by 24 min";
  const flagged = FLAG_HEADER.map((h) =>
    h === "Shift ID" ? "j-1" : h === "Reviewed" ? false : "",
  );
  const s = emailServer({
    log,
    flags: [FLAG_HEADER, flagged],
    profiles: [
      EMAIL_PROFILE_HEADER,
      profileRow(MARIA),
      profileRow(JAMES),
      withEmail(DEV, ""),
      profileRow(ANA),
    ],
    hoursEmails: [HOURS_EMAILS_HEADER, sentRow("2026-11-03", MARIA, "JP", "sent")],
  });
  const preview = previewHours(s, [MARIA.id, JAMES.id, DEV.id, ANA.id, "0000aaaa0000bbbb"], {
    attach: true,
  });
  const send = sendHours(s, preview.ticket, preview.sendIds);
  assert.deepEqual({ preview, send }, JSON.parse(read("tests/hours-email-replies.json")));
});

test("Email hours: the lock is held only to take and to write the rows, never at a Log read or a send", () => {
  const s = emailServer();
  const logReads = [];
  s.sheets.Log.afterValues = () => logReads.push(s.lock.held);
  const p = previewHours(s, [MARIA.id, JAMES.id, DEV.id]);
  assert.deepEqual(logReads, [false]);
  assert.equal(s.lock.takes, 0);
  logReads.length = 0;
  const reply = sendHours(s, p.ticket, p.sendIds);
  assert.deepEqual(
    reply.results.map((r) => r.result),
    ["sent", "sent", "sent"],
  );
  assert.deepEqual(logReads, [false]);
  assert.deepEqual(
    s.mail.sent.map((m) => m.held),
    [false, false, false],
  );
  assert.ok(s.mail.events.every((e) => e.held === false));
  assert.equal(s.lock.takes, 2);
  assert.equal(s.lock.held, false);

  // A call whose Log read throws takes the lock twice too: once to take, once for the rows.
  const t = emailServer();
  const q = previewHours(t, [MARIA.id, JAMES.id, DEV.id]);
  t.sheets.Log.afterValues = () => {
    throw new Error("Log read failed");
  };
  sendHours(t, q.ticket, [MARIA.id, JAMES.id]);
  assert.equal(t.lock.takes, 2);
  assert.equal(hoursEmailRows(t).length, 2);

  // A call whose ids were all taken already takes it once, reads nothing and writes no row.
  t.sheets.Log.afterValues = null;
  t.sheets.Log.reads.length = 0;
  t.sheets.Settings.reads.length = 0;
  t.calls.length = 0;
  t.journal.length = 0;
  const again = sendHours(t, q.ticket, [MARIA.id, JAMES.id]);
  assert.deepEqual(
    again.results.map((r) => r.result),
    [R_TAKEN, R_TAKEN],
  );
  assert.equal(t.lock.takes, 3);
  assert.deepEqual(t.sheets.Log.reads, []);
  assert.deepEqual(t.sheets.Settings.reads, []);
  assert.ok(!t.calls.includes("SpreadsheetApp.openById"));
  assert.deepEqual(
    t.journal.filter((j) => j.startsWith("write ")),
    [],
  );
  assert.equal(hoursEmailRows(t).length, 2);
});

// ---------------------------------------------------------------------------
// The admin dialog's calls

test("AdminDialog.html calls only keyed functions, each through call()", () => {
  const html = read("apps-script/AdminDialog.html");
  const called = [...html.matchAll(/call\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), [
    "adminAddShift",
    "adminFindShifts",
    "adminFixSignOut",
    "adminHoursPreview",
    "adminOpenShifts",
    "adminRemoveShift",
    "adminRemovedShifts",
    "adminRestoreShift",
    "adminRoster",
    "adminSendHours",
  ]);
  for (const name of called) assert.ok(KEYED.includes(name), name);
  assert.equal(html.match(/google\.script\.run/g).length, 1);
  assert.match(html, /\[name\]\(KEY, \.\.\.args\)/);
});
