// Tests for apps-script/Jobs.js, the daily jobs, and their pure rules in Logic.js: when the
// weekly flags email is due, what it counts and says, and how setupDailyJobs and
// removeDailyJobs manage the triggers. The server files are loaded into one global scope,
// as Apps Script loads them, with stand-ins for the Google services. Every person here is
// invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
// Admin.js and Reports.js for the nightly Hours refresh and the Log check it runs.
const SERVER_FILES = ["Logic.js", "Sheets.js", "Admin.js", "Reports.js", "Jobs.js"].map((f) => [
  f,
  read("apps-script/" + f),
]);

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);

const plain = (x) => JSON.parse(JSON.stringify(x));
const TZ = "America/Chicago";
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OWNER = "jobs@example.org";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/sheet-1/edit";
const FLAGS_GID = 777;
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
const centralText = (ms) => {
  const p = centralParts(ms);
  return p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
};
/** "yyyy-MM-dd HH:mm" Central to milliseconds; a time skipped in spring reads as the later one. */
const centralMs = (text) => {
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let ms = want + 6 * HOUR;
  for (let i = 0; i < 2; i++) {
    const p = centralParts(ms);
    ms += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return ms;
};

// ---------------------------------------------------------------------------
// Stand-ins for the Google services

class FakeSheet {
  constructor(rows, sheetId = 0) {
    this.rows = rows.map((r) => r.slice());
    this.sheetId = sheetId;
    this.formats = {};
  }
  getMaxRows() {
    return 1000;
  }
  getSheetId() {
    return this.sheetId;
  }
  getLastRow() {
    let last = this.rows.length;
    while (last > 0 && this.rows[last - 1].every((v) => v === "")) last--;
    return last;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  put(row, col, value) {
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
      setNumberFormat: () => range,
      setValue: (value) => {
        sheet.put(row, col, value);
        return range;
      },
      setValues: (values) => {
        values.forEach((line, i) => line.forEach((v, j) => sheet.put(row + i, col + j, v)));
        return range;
      },
      getNumberFormats: () =>
        Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")),
      setNumberFormats: () => range,
      setDataValidation: () => range,
    };
    return range;
  }
  /** One row as {header with spaces for line breaks: value}. */
  rowByHeader(row) {
    const out = {};
    this.rows[0].forEach((h, i) => {
      if (h) out[String(h).replace(/\s+/g, " ")] = (this.rows[row - 1] || [])[i] ?? "";
    });
    return out;
  }
}

/** The Settings tab: every default, then the given values on top. */
function settingsRows(values = {}) {
  const rows = plain(L.settingsDefaults("2026-01-05")).map(([name, value]) => [
    name,
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : value,
  ]);
  for (const name of Object.keys(values)) {
    assert.ok(
      rows.some((r) => r[0] === name),
      "not a Settings row: " + name,
    );
  }
  return [["Setting", "Value"], ...rows];
}

/** One Flags row, its cells under FLAG_HEADER. */
function flagRow({
  shiftId = "s-1",
  date = "2026-11-12",
  name = "",
  reason = "",
  raisedAt = "",
  reviewed = false,
}) {
  const row = Array(FLAG_HEADER.length).fill("");
  const at = (h) => FLAG_HEADER.indexOf(h);
  row[at("Shift ID")] = shiftId;
  row[at("Date")] = date;
  row[at("Volunteer Name")] = name;
  row[at("Reason")] = reason;
  row[at("Raised At")] = raisedAt === "" ? "" : new Date(raisedAt);
  row[at("Reviewed")] = reviewed;
  row[at("Source")] = "kiosk check-in";
  return row;
}

/**
 * A fresh server scope. opts: now (ms, changeable through s.now), account (the Session
 * user, the same active and effective), settings (values over the defaults), flags (rows
 * under FLAG_HEADER; null for no Flags tab; flagHeader to replace the header), triggers
 * ({account: [{uid, handler}]}), lockFree (false: tryLock fails), sendFails, onSend, log
 * (the Log tab's rows, header first; none when absent), shifts (the Shifts tab's rows;
 * none when absent), onFlush (called on each SpreadsheetApp.flush).
 * calls records "Service.method" in order, the script lock's calls as "lock.*" and the
 * document lock's as "docLock.*"; logs what the server logs; alerts what the menu shows.
 * The spreadsheet has no Hours tabs. cache is the script cache, a Map of key to value; its
 * calls are not recorded.
 */
function server(opts = {}) {
  const calls = [];
  const cache = new Map();
  const logs = [];
  const mail = [];
  const alerts = [];
  const created = [];
  const state = { now: opts.now, account: opts.account ?? OWNER, uid: 0 };
  const triggers = {};
  for (const [account, list] of Object.entries(opts.triggers || {})) {
    triggers[account] = list.map((t) => ({ ...t }));
  }
  const sheets = {
    Settings: new FakeSheet(settingsRows(opts.settings)),
    Flags:
      opts.flags === null
        ? undefined
        : new FakeSheet([opts.flagHeader || FLAG_HEADER, ...(opts.flags || [])], FLAGS_GID),
  };
  if (opts.log) sheets.Log = new FakeSheet(opts.log);
  if (opts.shifts) sheets.Shifts = new FakeSheet(opts.shifts);
  let uuid = 0;

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
  const own = () => (triggers[state.account] = triggers[state.account] || []);
  const triggerObject = (t) => ({
    getUniqueId: () => t.uid,
    getHandlerFunction: () => t.handler,
    t,
  });

  const ctx = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => void cache.set(k, v),
      }),
    },
    Session: service("Session", {
      getActiveUser: () => email(state.account),
      getEffectiveUser: () => email(state.account),
    }),
    ScriptApp: service("ScriptApp", {
      getProjectTriggers: () => own().map(triggerObject),
      deleteTrigger: (obj) => {
        const list = own();
        const at = list.indexOf(obj.t);
        assert.ok(at >= 0, "deletes only this account's own triggers");
        list.splice(at, 1);
      },
      newTrigger: (handler) => {
        const spec = { handler };
        const make = () => {
          created.push(spec);
          own().push({ uid: "new-" + ++state.uid, handler, spec });
        };
        return {
          timeBased: () => ({
            everyHours: (n) => ((spec.everyHours = n), { create: make }),
            atHour: (h) => {
              spec.atHour = h;
              return {
                everyDays: (d) => {
                  spec.everyDays = d;
                  return { inTimezone: (tz) => ((spec.timeZone = tz), { create: make }) };
                },
              };
            },
          }),
        };
      },
    }),
    MailApp: service("MailApp", {
      sendEmail: (message) => {
        if (opts.onSend) opts.onSend(message);
        if (opts.sendFails) throw new Error("Service invoked too many times: email");
        mail.push(message);
      },
    }),
    LockService: service("LockService", {
      getScriptLock: () =>
        service("lock", {
          tryLock: (ms) => {
            assert.equal(ms, 30000);
            return opts.lockFree !== false;
          },
          releaseLock: () => undefined,
        }),
      getDocumentLock: () =>
        service("docLock", {
          tryLock: () => true,
          releaseLock: () => undefined,
        }),
    }),
    SpreadsheetApp: service("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => sheets[name] || null,
        getUrl: () => SHEET_URL,
        // No developer metadata: no Hours tabs.
        createDeveloperMetadataFinder: () => {
          const finder = { withKey: () => finder, find: () => [] };
          return finder;
        },
      }),
      getUi: () => ({ alert: (text) => alerts.push(text) }),
      flush: () => (opts.onFlush ? opts.onFlush(state) : undefined),
      newDataValidation: () => {
        const b = { requireCheckbox: () => b, build: () => "checkbox" };
        return b;
      },
    }),
    Utilities: service("Utilities", {
      getUuid: () => "uuid-" + ++uuid,
      parseDate: (text, tz, format) => {
        assert.equal(tz, TZ);
        assert.equal(format, "yyyy-MM-dd HH:mm");
        return new Date(centralMs(text));
      },
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        if (format === "yyyy-MM-dd HH:mm:ss") return formatInZone(date, tz, format);
        const text = centralText(date.getTime());
        if (format === "yyyy-MM-dd") return text.slice(0, 10);
        if (format === "HH:mm") return text.slice(11);
        if (format === "yyyy-MM-dd HH:mm") return text;
        if (format === "h:mm a") {
          const h = +text.slice(11, 13);
          return (h % 12 || 12) + ":" + text.slice(14) + " " + (h < 12 ? "AM" : "PM");
        }
        throw new Error("format " + format);
      },
    }),
  };
  vm.createContext(ctx);
  const RealDate = vm.runInContext("Date", ctx);
  ctx.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [state.now ?? RealDate.now()]));
    }
    static now() {
      return state.now ?? RealDate.now();
    }
  };
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  calls.length = 0;

  const setting = (name) => {
    const row = sheets.Settings.rows.find((r) => r[0] === name);
    return row ? row[1] : undefined;
  };
  /** Runs runFlagsEmail at a Central time, as the trigger would. */
  const run = (centralTime) => {
    if (centralTime) state.now = centralMs(centralTime);
    const uid = own().find((t) => t.handler === "runFlagsEmail");
    return ctx.runFlagsEmail({ triggerUid: uid ? uid.uid : "none", authMode: "FULL" });
  };
  /** Runs runAutoClockOut at a Central time, as its trigger would. */
  const runAuto = (centralTime) => {
    if (centralTime) state.now = centralMs(centralTime);
    const uid = own().find((t) => t.handler === "runAutoClockOut");
    return ctx.runAutoClockOut({ triggerUid: uid ? uid.uid : "none", authMode: "FULL" });
  };
  /** Runs runHoursRefresh at a Central time, as its trigger would. */
  const runHours = (centralTime) => {
    if (centralTime) state.now = centralMs(centralTime);
    const uid = own().find((t) => t.handler === "runHoursRefresh");
    return ctx.runHoursRefresh({ triggerUid: uid ? uid.uid : "none", authMode: "FULL" });
  };
  return {
    ctx,
    calls,
    cache,
    logs,
    mail,
    alerts,
    created,
    sheets,
    triggers,
    state,
    setting,
    run,
    runAuto,
    runHours,
  };
}

const OWN_TRIGGER = { [OWNER]: [{ uid: "t-email", handler: "runFlagsEmail" }] };
// A Monday, 8 AM Central (CST).
const MONDAY_8 = "2026-11-16 08:05";
const EMAIL_ON = {
  "Flags email": "On",
  "Flags email to": "staff@example.org, board@example.org",
  // Fresh, so only the flags decide whether there is something to send.
  "Auto clock-out last run": "2026-11-16 04:02, closed 0",
};
const at = (text) => centralMs(text);

// ---------------------------------------------------------------------------
// The Settings values

test("parseFlagsEmailOn: On in any case, everything else off", () => {
  for (const text of ["On", "on", " ON ", "oN"])
    assert.equal(L.parseFlagsEmailOn(text), true, text);
  for (const text of ["Off", "", "yes", "true", "1", "On please", undefined]) {
    assert.equal(L.parseFlagsEmailOn(text), false, String(text));
  }
});

test("parseEmailAddresses splits on commas, semicolons, spaces and new lines", () => {
  assert.deepEqual(
    plain(
      L.parseEmailAddresses("a@example.org, b@example.org;c@example.org\nd@example.org  e@x.co"),
    ),
    {
      valid: ["a@example.org", "b@example.org", "c@example.org", "d@example.org", "e@x.co"],
      invalid: [],
    },
  );
  assert.deepEqual(
    plain(
      L.parseEmailAddresses(
        "staff@example.org, Board, @example.org, x@y, x@y., a@b@c.d, STAFF@example.org",
      ),
    ),
    { valid: ["staff@example.org"], invalid: ["Board", "@example.org", "x@y", "x@y.", "a@b@c.d"] },
  );
  assert.deepEqual(plain(L.parseEmailAddresses("")), { valid: [], invalid: [] });
  assert.deepEqual(plain(L.parseEmailAddresses(" ,; \n")), { valid: [], invalid: [] });
  assert.deepEqual(plain(L.parseEmailAddresses("first.last@mail.example.org")).valid, [
    "first.last@mail.example.org",
  ]);
});

test("parseWeekdaySetting reads a full English weekday or its first three letters, else Monday", () => {
  for (const [text, want] of [
    ["Monday", "Monday"],
    ["tuesday", "Tuesday"],
    ["WED", "Wednesday"],
    [" thu ", "Thursday"],
    ["Fri", "Friday"],
    ["saturday", "Saturday"],
    ["Sun", "Sunday"],
    ["Tues", "Monday"],
    ["Th", "Monday"],
    ["lunes", "Monday"],
    ["", "Monday"],
  ]) {
    assert.equal(L.parseWeekdaySetting(text), want, text);
  }
});

test("parseEmailHour reads a whole hour 0 to 23, else 8", () => {
  for (const [text, want] of [
    ["0", 0],
    ["8", 8],
    ["08", 8],
    ["23", 23],
    ["14", 14],
    ["24", 8],
    ["-1", 8],
    ["8.5", 8],
    ["8 AM", 8],
    ["", 8],
  ]) {
    assert.equal(L.parseEmailHour(text), want, text);
  }
});

test("lastRunTime takes the yyyy-MM-dd HH:mm a last-run value starts with", () => {
  assert.equal(L.lastRunTime("2026-11-09 08:05, sent to 3"), "2026-11-09 08:05");
  assert.equal(L.lastRunTime("2026-11-09 08:05"), "2026-11-09 08:05");
  assert.equal(L.lastRunTime(" 2026-11-09 08:05, nothing to send "), "2026-11-09 08:05");
  for (const text of [
    "",
    "yesterday",
    "2026-11-09",
    "2026-11-09 8:05",
    "2026-02-30 08:05",
    "2026-11-09 24:00",
    "2026-11-09 08:051",
  ]) {
    assert.equal(L.lastRunTime(text), "", text);
  }
  assert.equal(L.lastRunText("2026-11-09 08:05", "sent to 3"), "2026-11-09 08:05, sent to 3");
});

// ---------------------------------------------------------------------------
// When the email is due

test("the due slot is the latest Settings weekday and hour at or before now", () => {
  // 2026-11-12 is a Thursday.
  const now = "2026-11-12 10:30";
  assert.equal(L.flagsEmailSlot(now, "Monday", 8), "2026-11-09 08:00");
  assert.equal(L.flagsEmailSlot(now, "Tuesday", 23), "2026-11-10 23:00");
  assert.equal(L.flagsEmailSlot(now, "Wednesday", 0), "2026-11-11 00:00");
  assert.equal(L.flagsEmailSlot(now, "Thursday", 8), "2026-11-12 08:00");
  assert.equal(L.flagsEmailSlot(now, "Thursday", 10), "2026-11-12 10:00");
  assert.equal(L.flagsEmailSlot(now, "Thursday", 11), "2026-11-05 11:00");
  assert.equal(L.flagsEmailSlot(now, "Friday", 8), "2026-11-06 08:00");
  assert.equal(L.flagsEmailSlot(now, "Saturday", 8), "2026-11-07 08:00");
  assert.equal(L.flagsEmailSlot(now, "Sunday", 8), "2026-11-08 08:00");
  // Across a month and a year.
  assert.equal(L.flagsEmailSlot("2027-01-01 07:00", "Monday", 8), "2026-12-28 08:00");
  assert.equal(L.flagsEmailSlot("2026-03-02 09:00", "Saturday", 8), "2026-02-28 08:00");
});

test("flagsEmailDue: once a week, catching up a missed run, and a changed day or hour at once", () => {
  const due = (now, last, day = "Monday", hour = 8) => L.flagsEmailDue(now, last, day, hour);
  // A blank or unreadable last run is before every slot.
  assert.equal(due("2026-11-12 10:30", ""), true);
  assert.equal(due("2026-11-12 10:30", "sometime"), true);
  // Sent at Monday's slot: not again that week, again from the next Monday at 8.
  const sent = "2026-11-16 08:05, sent to 2";
  assert.equal(due("2026-11-16 08:05", sent), false);
  assert.equal(due("2026-11-16 09:05", sent), false);
  assert.equal(due("2026-11-22 23:05", sent), false);
  assert.equal(due("2026-11-23 07:05", sent), false);
  assert.equal(due("2026-11-23 08:05", sent), true);
  // A last run exactly at the slot counts as sent for it.
  assert.equal(due("2026-11-16 09:05", "2026-11-16 08:00, sent to 1"), false);
  assert.equal(due("2026-11-16 09:05", "2026-11-16 07:59, sent to 1"), true);
  // Missed Monday 8 (the run failed): the next hourly run catches up, even on Tuesday.
  assert.equal(due("2026-11-17 10:05", "2026-11-09 08:05, sent to 2"), true);
  // Changed to Wednesday 9 after Monday's send: sends on Wednesday at 9.
  assert.equal(due("2026-11-18 08:05", sent, "Wednesday", 9), false);
  assert.equal(due("2026-11-18 09:05", sent, "Wednesday", 9), true);
  // Changed to an hour already past today: due at once.
  assert.equal(due("2026-11-16 10:05", "2026-11-09 08:05, sent to 2", "Monday", 10), true);
  // Changed to Sunday after Monday's send: not again until Sunday.
  assert.equal(due("2026-11-17 10:05", sent, "Sunday", 9), false);
  assert.equal(due("2026-11-22 09:05", sent, "Sunday", 9), true);
});

// ---------------------------------------------------------------------------
// What the email counts and says

test("flagsSummary counts the last 7 days, newest first, and unreviewed rows of any age", () => {
  const now = at("2026-11-16 08:05");
  const flags = [
    {
      name: "Avery Quill",
      shiftId: "s-1",
      reason: "a",
      raisedAtMs: now - 1 * HOUR,
      reviewed: false,
    },
    { name: "Bo Tamsin", shiftId: "s-2", reason: "b", raisedAtMs: now - 3 * DAY, reviewed: true },
    { name: "Cy Wren", shiftId: "s-3", reason: "c", raisedAtMs: now - 7 * DAY, reviewed: false },
    {
      name: "Dee Marlo",
      shiftId: "s-4",
      reason: "d",
      raisedAtMs: now - 7 * DAY + MIN,
      reviewed: false,
    },
    { name: "", shiftId: "s-5", reason: "e", raisedAtMs: NaN, reviewed: false },
    { name: "Eli Fenn", shiftId: "", reason: "f", raisedAtMs: now - 30 * DAY, reviewed: false },
    // A blank line staff left: not unreviewed.
    { name: "", shiftId: "", reason: "", raisedAtMs: NaN, reviewed: false },
    { name: "Fay Orrin", shiftId: "s-7", reason: "g", raisedAtMs: now + MIN, reviewed: false },
  ];
  const s = L.flagsSummary(flags, now);
  assert.deepEqual(plain(s.recent.map((f) => f.reason)), ["a", "b", "d"]);
  assert.equal(s.unreviewed, 6);
  assert.equal(L.isTicked(true), true);
  assert.equal(L.isTicked("TRUE"), true);
  assert.equal(L.isTicked(false), false);
  assert.equal(L.isTicked(""), false);
});

test("autoClockOutCheck: blank, unreadable or more than 48 hours old is stale", () => {
  const now = "2026-11-16 08:05";
  assert.deepEqual(plain(L.autoClockOutCheck("", now)), { stale: true, lastRun: "" });
  assert.deepEqual(plain(L.autoClockOutCheck("last week", now)), { stale: true, lastRun: "" });
  assert.deepEqual(plain(L.autoClockOutCheck("2026-11-16 04:02, closed 3", now)), {
    stale: false,
    lastRun: "2026-11-16 04:02",
  });
  assert.equal(L.autoClockOutCheck("2026-11-14 08:05, closed 0", now).stale, false);
  assert.equal(L.autoClockOutCheck("2026-11-14 08:04, closed 0", now).stale, true);
});

test("flagsEmailMessage: nothing to send only when both counts are zero and the auto clock-out is fresh", () => {
  const fresh = { stale: false, lastRun: "2026-11-16 04:02" };
  const none = { recent: [], unreviewed: 0 };
  assert.equal(L.flagsEmailMessage({ summary: none, autoClockOut: fresh, flagsUrl: "u" }), null);
  assert.notEqual(
    L.flagsEmailMessage({
      summary: { recent: [], unreviewed: 1 },
      autoClockOut: fresh,
      flagsUrl: "u",
    }),
    null,
  );
  const stale = L.flagsEmailMessage({
    summary: none,
    autoClockOut: { stale: true, lastRun: "2026-11-12 04:01" },
    flagsUrl: "u",
  });
  assert.equal(
    stale.subject,
    "Volunteer kiosk: auto clock-out not running, 0 new flags this week, 0 unreviewed",
  );
  assert.match(stale.body, /^The auto clock-out last ran at 2026-11-12 04:01\. /);
  const never = L.flagsEmailMessage({
    summary: none,
    autoClockOut: { stale: true, lastRun: "" },
    flagsUrl: "u",
  });
  assert.match(never.body, /^The auto clock-out has never run\. /);
});

test("flagsEmailMessage lists up to 25 of the week's flags, then and N more, with names escaped in HTML", () => {
  const recent = Array.from({ length: 27 }, (_, i) => ({
    date: "2026-11-" + String(15 - (i % 5)).padStart(2, "0"),
    name: i === 0 ? "Jo <Kit> & Co" : "Volunteer " + (i + 1),
    reason: "arrival differs by " + (20 + i) + " min",
  }));
  const m = L.flagsEmailMessage({
    summary: { recent, unreviewed: 9 },
    autoClockOut: { stale: false, lastRun: "2026-11-16 04:02" },
    flagsUrl: SHEET_URL + "#gid=7",
  });
  assert.equal(m.subject, "Volunteer kiosk: 27 new flags this week, 9 unreviewed");
  const lines = m.body.split("\n");
  assert.equal(lines[0], "Flags raised in the last 7 days: 27");
  assert.ok(lines.includes("Flags still unreviewed: 9"));
  assert.ok(m.body.includes(SHEET_URL + "#gid=7"));
  assert.ok(lines.includes("2026-11-15, Jo <Kit> & Co: arrival differs by 20 min"));
  assert.ok(lines.includes("2026-11-11, Volunteer 25: arrival differs by 44 min"));
  assert.ok(!m.body.includes("Volunteer 26"));
  assert.ok(lines.includes("and 2 more"));
  assert.ok(m.htmlBody.includes("Jo &lt;Kit&gt; &amp; Co"));
  assert.ok(!m.htmlBody.includes("<Kit>"));
  assert.ok(m.htmlBody.includes('<a href="' + SHEET_URL + '#gid=7">Flags tab</a>'));
  assert.equal((m.htmlBody.match(/<li>/g) || []).length, 25);
  const one = L.flagsEmailMessage({
    summary: { recent: recent.slice(0, 1), unreviewed: 1 },
    autoClockOut: { stale: false, lastRun: "" },
    flagsUrl: "u",
  });
  assert.equal(one.subject, "Volunteer kiosk: 1 new flag this week, 1 unreviewed");
  assert.ok(!one.body.includes("more"));
});

// ---------------------------------------------------------------------------
// runFlagsEmail

/** A week of flags for the Monday 8 AM runs. */
const WEEK_FLAGS = [
  flagRow({
    shiftId: "s-1",
    date: "2026-11-10",
    name: "Avery Quill",
    reason: "arrival differs by 20 min",
    raisedAt: at("2026-11-10 09:12"),
  }),
  flagRow({
    shiftId: "s-2",
    date: "2026-11-14",
    name: "Bo Tamsin",
    reason: "check-out differs by 30 min",
    raisedAt: at("2026-11-14 15:40"),
  }),
  flagRow({
    shiftId: "s-3",
    date: "2026-11-02",
    name: "Cy Wren",
    reason: "arrival differs by 18 min",
    raisedAt: at("2026-11-02 09:00"),
    reviewed: true,
  }),
  flagRow({
    shiftId: "s-4",
    date: "2026-10-20",
    name: "Dee Marlo",
    reason: "arrival differs by 40 min",
    raisedAt: at("2026-10-20 09:00"),
  }),
];

test("runFlagsEmail sends at the due slot to the Settings addresses, from the no-reply address", () => {
  const s = server({ settings: EMAIL_ON, flags: WEEK_FLAGS, triggers: OWN_TRIGGER });
  assert.equal(s.run(MONDAY_8), undefined);
  assert.equal(s.mail.length, 1);
  const m = s.mail[0];
  assert.equal(m.to, "staff@example.org,board@example.org");
  assert.equal(m.name, "ENCM Volunteer Kiosk");
  assert.equal(m.noReply, true);
  assert.equal(m.subject, "Volunteer kiosk: 2 new flags this week, 3 unreviewed");
  assert.ok(m.body.includes(SHEET_URL + "#gid=" + FLAGS_GID));
  // Newest first; only this week's are listed.
  const list = m.body.split("\n");
  const bo = list.indexOf("2026-11-14, Bo Tamsin: check-out differs by 30 min");
  const avery = list.indexOf("2026-11-10, Avery Quill: arrival differs by 20 min");
  assert.ok(bo > 0 && avery > bo);
  assert.ok(!m.body.includes("Dee Marlo"));
  assert.ok(typeof m.htmlBody === "string" && m.htmlBody.length > 0);
  assert.equal(s.setting("Flags email last run"), "2026-11-16 08:05, sent to 2");
});

test("runFlagsEmail does nothing while Flags email is Off or Flags email to is blank", () => {
  for (const settings of [
    { ...EMAIL_ON, "Flags email": "Off" },
    { ...EMAIL_ON, "Flags email": "" },
    { ...EMAIL_ON, "Flags email to": "" },
  ]) {
    const s = server({ settings, flags: WEEK_FLAGS, triggers: OWN_TRIGGER });
    s.run(MONDAY_8);
    assert.equal(s.mail.length, 0, JSON.stringify(settings));
    assert.equal(s.setting("Flags email last run"), "");
    assert.ok(!s.calls.includes("MailApp.sendEmail"));
  }
});

test("runFlagsEmail with no address it can read says so in the last run, once a slot, and sends once one is fixed", () => {
  const notSent = (time) => time + ', not sent: no valid address in "Flags email to"';
  for (const to of ["jane@example", "the board, staff at example dot org"]) {
    const s = server({
      settings: { ...EMAIL_ON, "Flags email to": to },
      flags: WEEK_FLAGS,
      triggers: OWN_TRIGGER,
    });
    s.run(MONDAY_8);
    assert.equal(s.mail.length, 0, to);
    assert.ok(!s.calls.includes("MailApp.sendEmail"));
    assert.equal(s.setting("Flags email last run"), notSent(MONDAY_8), to);
    // Not written again within the slot.
    s.run("2026-11-16 09:05");
    assert.equal(s.setting("Flags email last run"), notSent(MONDAY_8), to);
    // The next week's slot writes it again.
    s.run("2026-11-23 08:05");
    assert.equal(s.setting("Flags email last run"), notSent("2026-11-23 08:05"), to);
  }

  // A fixed address sends at the next hourly run, without waiting for the next slot.
  const s = server({
    settings: { ...EMAIL_ON, "Flags email to": "jane@example" },
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
  });
  s.run(MONDAY_8);
  s.sheets.Settings.rows.find((r) => r[0] === "Flags email to")[1] = "jane@example.org";
  s.run("2026-11-16 10:05");
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0].to, "jane@example.org");
  assert.equal(s.setting("Flags email last run"), "2026-11-16 10:05, sent to 1");
  // Then not again that week.
  s.run("2026-11-16 11:05");
  assert.equal(s.mail.length, 1);
});

test("runFlagsEmail sends to the addresses it can read and names the rest in the email", () => {
  const s = server({
    settings: { ...EMAIL_ON, "Flags email to": "staff@example.org; board at example.org" },
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
  });
  s.run(MONDAY_8);
  assert.equal(s.mail[0].to, "staff@example.org");
  assert.ok(s.mail[0].body.includes("which aren't email addresses: board, at, example.org"));
  assert.equal(s.setting("Flags email last run"), "2026-11-16 08:05, sent to 1");
});

test("runFlagsEmail before the slot reads only Settings", () => {
  const s = server({
    settings: { ...EMAIL_ON, "Flags email last run": "2026-11-09 08:05, sent to 2" },
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
  });
  s.run("2026-11-16 07:05");
  assert.equal(s.mail.length, 0);
  assert.equal(s.setting("Flags email last run"), "2026-11-09 08:05, sent to 2");
  // A missing Flags tab would have thrown had it been read.
  const t = server({
    settings: { ...EMAIL_ON, "Flags email last run": "2026-11-09 08:05, sent to 2" },
    flags: null,
    triggers: OWN_TRIGGER,
  });
  assert.equal(t.run("2026-11-16 07:05"), undefined);
});

test("with nothing to send, runFlagsEmail writes the last run and sends nothing", () => {
  const reviewed = [
    flagRow({
      shiftId: "s-1",
      name: "Avery Quill",
      reason: "x",
      raisedAt: at("2026-11-02 09:00"),
      reviewed: true,
    }),
  ];
  const s = server({ settings: EMAIL_ON, flags: reviewed, triggers: OWN_TRIGGER });
  s.run(MONDAY_8);
  assert.equal(s.mail.length, 0);
  assert.equal(s.setting("Flags email last run"), "2026-11-16 08:05, nothing to send");
  // The write stamps the Settings cache, so the kiosk's next tap reads the tab.
  assert.match(s.cache.get(s.ctx.settingsStampKey()), /^\d+$/);
  // Not again that week.
  s.run("2026-11-16 09:05");
  assert.equal(s.setting("Flags email last run"), "2026-11-16 08:05, nothing to send");
});

test("a blank or stale auto clock-out last run makes the email send with no flags", () => {
  for (const last of ["", "2026-11-14 08:04, closed 2"]) {
    const s = server({
      settings: { ...EMAIL_ON, "Auto clock-out last run": last },
      flags: [],
      triggers: OWN_TRIGGER,
    });
    s.run(MONDAY_8);
    assert.equal(s.mail.length, 1, last);
    assert.match(
      s.mail[0].subject,
      /auto clock-out not running, 0 new flags this week, 0 unreviewed$/,
    );
    assert.match(
      s.mail[0].body,
      /^The auto clock-out (has never run|last ran at 2026-11-14 08:04)\./,
    );
  }
  const fresh = server({
    settings: { ...EMAIL_ON, "Auto clock-out last run": "2026-11-14 08:05, closed 2" },
    flags: [],
    triggers: OWN_TRIGGER,
  });
  fresh.run(MONDAY_8);
  assert.equal(fresh.mail.length, 0);
});

test("runFlagsEmail writes the last run before it sends", () => {
  let atSend;
  const s = server({
    settings: EMAIL_ON,
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
    onSend: () => (atSend = s.setting("Flags email last run")),
  });
  s.run(MONDAY_8);
  assert.equal(atSend, "2026-11-16 08:05, sent to 2");
  const send = s.calls.indexOf("MailApp.sendEmail");
  assert.ok(s.calls.lastIndexOf("SpreadsheetApp.flush", send) >= 0);
});

test("a failed send puts the old last run back and throws, and the next hourly run tries again", () => {
  const old = "2026-11-09 08:05, sent to 2";
  const opts = {
    settings: { ...EMAIL_ON, "Flags email last run": old },
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
    sendFails: true,
  };
  const s = server(opts);
  assert.throws(() => s.run(MONDAY_8), /too many times/);
  assert.equal(s.setting("Flags email last run"), old);
  opts.sendFails = false;
  s.run("2026-11-16 09:05");
  assert.equal(s.mail.length, 1);
  assert.equal(s.setting("Flags email last run"), "2026-11-16 09:05, sent to 2");
});

test("two runs in one slot send once, whichever account's trigger runs them", () => {
  const triggers = {
    [OWNER]: [{ uid: "t-email", handler: "runFlagsEmail" }],
    "second@example.org": [{ uid: "t-email-2", handler: "runFlagsEmail" }],
  };
  const s = server({ settings: EMAIL_ON, flags: WEEK_FLAGS, triggers });
  s.run(MONDAY_8);
  s.run("2026-11-16 08:40");
  s.state.account = "second@example.org";
  s.run("2026-11-16 09:10");
  assert.equal(s.mail.length, 1);
  // The next week, once again.
  s.run("2026-11-23 08:10");
  assert.equal(s.mail.length, 2);
});

test("a busy lock stops runFlagsEmail without throwing, before it reads anything", () => {
  const s = server({
    settings: EMAIL_ON,
    flags: WEEK_FLAGS,
    triggers: OWN_TRIGGER,
    lockFree: false,
  });
  assert.equal(s.run(MONDAY_8), undefined);
  assert.equal(s.mail.length, 0);
  assert.equal(s.setting("Flags email last run"), "");
  assert.ok(!s.calls.includes("SpreadsheetApp.getActiveSpreadsheet"));
  assert.deepEqual(s.logs, [
    "Flags email: the script lock was busy; the next hourly run will try again.",
  ]);
});

test("a missing or broken Flags tab fails the run instead of sending a wrong count", () => {
  const missing = server({ settings: EMAIL_ON, flags: null, triggers: OWN_TRIGGER });
  assert.throws(() => missing.run(MONDAY_8), /The "Flags" tab is missing/);
  assert.equal(missing.mail.length, 0);
  assert.equal(missing.setting("Flags email last run"), "");
  const broken = server({
    settings: EMAIL_ON,
    flags: WEEK_FLAGS,
    flagHeader: FLAG_HEADER.map((h) => (h === "Reviewed" ? "Checked" : h)),
    triggers: OWN_TRIGGER,
  });
  assert.throws(() => broken.run(MONDAY_8), /no "reviewed" column/);
  assert.equal(broken.mail.length, 0);
  assert.equal(broken.setting("Flags email last run"), "");
});

test("across the spring clock change the email sends once, at the first hourly run past the slot", () => {
  // Sunday 2027-03-14: 2 AM doesn't happen; clocks go from 1:59 to 3:00.
  const s = server({
    settings: {
      ...EMAIL_ON,
      "Flags email day": "Sunday",
      "Flags email hour": "2",
      "Flags email last run": "2027-03-07 02:05, sent to 2",
      "Auto clock-out last run": "2027-03-14 04:00, closed 0",
    },
    flags: [flagRow({ name: "Avery Quill", reason: "x", raisedAt: at("2027-03-13 10:00") })],
    triggers: OWN_TRIGGER,
  });
  s.state.now = Date.parse("2027-03-14T07:05:00Z"); // 1:05 AM CST
  s.run();
  assert.equal(s.mail.length, 0);
  s.state.now += HOUR; // 3:05 AM CDT
  s.run();
  assert.equal(s.mail.length, 1);
  assert.equal(s.setting("Flags email last run"), "2027-03-14 03:05, sent to 2");
  s.state.now += HOUR;
  s.run();
  assert.equal(s.mail.length, 1);
});

test("across the fall clock change the repeated hour doesn't send twice", () => {
  // Sunday 2026-11-01: 1 AM happens twice, first CDT then CST.
  const s = server({
    settings: {
      ...EMAIL_ON,
      "Flags email day": "Sunday",
      "Flags email hour": "1",
      "Auto clock-out last run": "2026-10-31 04:00, closed 0",
    },
    flags: [flagRow({ name: "Avery Quill", reason: "x", raisedAt: at("2026-10-30 10:00") })],
    triggers: OWN_TRIGGER,
  });
  s.state.now = Date.parse("2026-11-01T06:05:00Z"); // 1:05 AM CDT
  s.run();
  assert.equal(s.mail.length, 1);
  assert.equal(s.setting("Flags email last run"), "2026-11-01 01:05, sent to 2");
  s.state.now += HOUR; // 1:05 AM CST
  s.run();
  s.state.now += HOUR; // 2:05 AM CST
  s.run();
  assert.equal(s.mail.length, 1);
});

test("runFlagsEmail run by its trigger passes the guard; any other trigger id is refused", () => {
  const s = server({ settings: EMAIL_ON, flags: WEEK_FLAGS, triggers: OWN_TRIGGER });
  s.state.now = at(MONDAY_8);
  assert.throws(
    () => s.ctx.runFlagsEmail({ triggerUid: "t-forged" }),
    /runs only from its trigger/,
  );
  assert.throws(() => s.ctx.runFlagsEmail(), /runs only from its trigger/);
  assert.equal(s.mail.length, 0);
  s.ctx.runFlagsEmail({ triggerUid: "t-email" });
  assert.equal(s.mail.length, 1);
});

// ---------------------------------------------------------------------------
// setupDailyJobs and removeDailyJobs

test("setupDailyJobs replaces only this account's daily-job triggers and creates exactly what dailyJobs lists", () => {
  const triggers = {
    [OWNER]: [
      { uid: "old-1", handler: "runFlagsEmail" },
      { uid: "old-2", handler: "runFlagsEmail" },
      { uid: "keep", handler: "someOtherFunction" },
    ],
    "second@example.org": [{ uid: "theirs", handler: "runFlagsEmail" }],
  };
  const s = server({ triggers });
  s.ctx.setupDailyJobs();
  const jobs = plain(s.ctx.dailyJobs());
  assert.deepEqual(jobs, [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runAutoClockOut", atHour: 4 },
    { handler: "runHoursRefresh", atHour: 5 },
  ]);
  assert.deepEqual(plain(s.created), [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runAutoClockOut", atHour: 4, everyDays: 1, timeZone: TZ },
    { handler: "runHoursRefresh", atHour: 5, everyDays: 1, timeZone: TZ },
  ]);
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.uid),
    ["keep", "new-1", "new-2", "new-3"],
  );
  assert.deepEqual(
    s.triggers["second@example.org"].map((t) => t.uid),
    ["theirs"],
  );
  assert.equal(s.setting("Daily jobs installed by"), OWNER);
  assert.match(
    s.logs.join("\n"),
    /removed 2 old trigger\(s\) and installed runFlagsEmail every 1 hour\(s\); runAutoClockOut daily at 4:00 Central; runHoursRefresh daily at 5:00 Central, owned by jobs@example\.org/,
  );
  // Again: still one of each.
  s.ctx.setupDailyJobs();
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.handler),
    ["someOtherFunction", "runFlagsEmail", "runAutoClockOut", "runHoursRefresh"],
  );
});

test("setupDailyJobs makes a daily job's trigger at its hour, Central", () => {
  const s = server({ triggers: { [OWNER]: [{ uid: "old", handler: "runNightly" }] } });
  s.ctx.dailyJobs = () => [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runNightly", atHour: 4 },
  ];
  s.ctx.setupDailyJobs();
  assert.deepEqual(plain(s.created), [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runNightly", atHour: 4, everyDays: 1, timeZone: TZ },
  ]);
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.handler),
    ["runFlagsEmail", "runNightly"],
  );
});

test("setupDailyJobs with no Settings tab changes no trigger", () => {
  const s = server({ triggers: { [OWNER]: [{ uid: "old", handler: "runFlagsEmail" }] } });
  delete s.sheets.Settings;
  assert.throws(() => s.ctx.setupDailyJobs(), /"Settings" tab is missing/);
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.uid),
    ["old"],
  );
  assert.equal(s.created.length, 0);
});

test("removeDailyJobs deletes this account's job triggers and clears Daily jobs installed by only when it names this account", () => {
  const triggers = () => ({
    [OWNER]: [
      { uid: "mine", handler: "runFlagsEmail" },
      { uid: "keep", handler: "someOtherFunction" },
    ],
    "second@example.org": [{ uid: "theirs", handler: "runFlagsEmail" }],
  });
  const s = server({
    triggers: triggers(),
    settings: { "Daily jobs installed by": "Jobs@Example.org" },
  });
  s.ctx.removeDailyJobs();
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.uid),
    ["keep"],
  );
  assert.deepEqual(
    s.triggers["second@example.org"].map((t) => t.uid),
    ["theirs"],
  );
  assert.equal(s.setting("Daily jobs installed by"), "");

  const t = server({
    triggers: triggers(),
    settings: { "Daily jobs installed by": "second@example.org" },
  });
  t.ctx.removeDailyJobs();
  assert.deepEqual(
    t.triggers[OWNER].map((x) => x.uid),
    ["keep"],
  );
  assert.equal(t.setting("Daily jobs installed by"), "second@example.org");
  assert.match(t.logs.join("\n"), /names second@example\.org, so it was left as it is/);
});

// ---------------------------------------------------------------------------
// Auto clock-out

const LOG_HEADER = plain(L.logHeaders());
/** A Log row by header; times are Central "yyyy-MM-dd HH:mm" texts, written as Dates. */
const logLine = (byHeader) =>
  LOG_HEADER.map((h) => {
    const v = byHeader[h];
    if (v === undefined) return "";
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v) ? new Date(centralMs(v)) : v;
  });
const H = plain(L.logHeaderNames());
/** An open kiosk row: tapped at tap, stating stated, on date. */
const openLine = (shiftId, token, name, date, tap, stated = tap) =>
  logLine({
    [H.date]: date,
    [H.name]: name,
    [H.recordedIn]: tap && date + " " + tap,
    [H.statedIn]: stated && date + " " + stated,
    [H.token]: token,
    [H.status]: "open",
    [H.inBy]: "kiosk",
    [H.shiftId]: shiftId,
  });
const sheetTime = (hhmm) => new Date(centralMs("1899-12-30 " + hhmm));
// ENCM's Shifts layout, invented windows.
const SHIFTS = [
  ["Shifts", "Shift Schedule", "Lead", "Start", "Finish"],
  ["Thursday", "Morning pantry", "", sheetTime("09:00"), sheetTime("13:00")],
  ["Tue", "Evening", "", "5:00 PM", "8:00 PM"],
];
const AUTO_OWN = { [OWNER]: [{ uid: "t-auto", handler: "runAutoClockOut" }] };
const AUTO_SETTINGS = { "Kiosk launch date": "2026-11-01", "Auto clock-out after hours": "12" };
// A Friday, the run's usual time.
const FRIDAY_4 = "2026-11-13 04:00";
const autoLog = () => [
  LOG_HEADER,
  // Tapped Thursday 09:00: 19 hours old, matched to the 9:00 Thursday window.
  openLine("s-thu", "tok-a", "Avery Stone", "2026-11-12", "09:00"),
  // Tapped Thursday 17:30 stating 07:00: 10.5 hours from the tap, left.
  openLine("s-late", "tok-b", "Blair Moss", "2026-11-12", "17:30", "07:00"),
  // Before the launch date: left.
  openLine("s-old", "tok-c", "Casey Fern", "2026-10-20", "09:00"),
  // No readable time and no Shift ID, dated Tuesday: skipped, flagged.
  openLine("", "tok-d", "Dana Reed", "2026-11-10", "", ""),
  // Tapped Wednesday 21:00, no Wednesday window and no history: arrival + 3 h.
  openLine("s-wed", "tok-e", "Emery Hale", "2026-11-11", "21:00"),
];

test("runAutoClockOut closes only rows old enough since launch, each flagged, and writes its last run", () => {
  const s = server({ settings: AUTO_SETTINGS, triggers: AUTO_OWN, log: autoLog(), shifts: SHIFTS });
  s.runAuto(FRIDAY_4);
  const log = s.sheets.Log;
  const row = (n) => log.rowByHeader(n);
  // Avery: closed at the Thursday window's Finish.
  assert.equal(row(2).Status, "closed");
  assert.equal(row(2)["Check-Out Stated (user)"].getTime(), centralMs("2026-11-12 13:00"));
  assert.equal(row(2)["Check-Out Recorded (timestamp)"], "");
  assert.equal(row(2)["Hours Served (stated)"], 4);
  assert.equal(row(2)["Hours Served (timestamps)"], "");
  assert.equal(row(2)["Check-Out Entered By"], "auto-close");
  assert.equal(
    row(2)["Admin Alerts?"],
    "auto clock-out at 1:00 PM, Finish of the 9:00 AM Shifts window",
  );
  // Blair and Casey: still open, untouched.
  assert.equal(row(3).Status, "open");
  assert.equal(row(3)["Admin Alerts?"], "");
  assert.equal(row(4).Status, "open");
  // Dana: open, with a new Shift ID and the skipped alert.
  assert.equal(row(5).Status, "open");
  assert.equal(row(5)["Shift ID"], "uuid-1");
  assert.equal(row(5)["Admin Alerts?"], "auto clock-out skipped: check-in time unreadable");
  // Emery: arrival + 3 h, past midnight, so the alert names the weekday.
  assert.equal(row(6).Status, "closed");
  assert.equal(row(6)["Check-Out Stated (user)"].getTime(), centralMs("2026-11-12 00:00"));
  assert.equal(row(6)["Hours Served (stated)"], 3);
  assert.equal(row(6)["Admin Alerts?"], "auto clock-out at Thursday 12:00 AM, arrival + 3 h");
  // One Flags row each, oldest closed first, then the skipped row.
  const flags = [2, 3, 4].map((n) => s.sheets.Flags.rowByHeader(n));
  assert.deepEqual(
    flags.map((f) => [f["Shift ID"], f.Source, f.Reason, f["Log Row"], f.Date]),
    [
      ["s-wed", "auto-close", row(6)["Admin Alerts?"], 6, "2026-11-11"],
      ["s-thu", "auto-close", row(2)["Admin Alerts?"], 2, "2026-11-12"],
      ["uuid-1", "auto-close", row(5)["Admin Alerts?"], 5, "2026-11-10"],
    ],
  );
  assert.equal(s.sheets.Flags.getLastRow(), 4);
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-13 04:00, closed 2");
  assert.match(
    s.logs.join("\n"),
    /closed 2 row\(s\), flagged 1 whose check-in time can't be read\./,
  );

  // A second run closes nothing and flags nothing again.
  s.runAuto("2026-11-13 04:30");
  assert.equal(s.sheets.Flags.getLastRow(), 4);
  assert.equal(row(5)["Admin Alerts?"], "auto clock-out skipped: check-in time unreadable");
  assert.equal(row(3).Status, "open");
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-13 04:30, closed 0");
  // The next day Blair's row is old enough; its guess is never before the tap.
  s.runAuto("2026-11-14 04:00");
  assert.equal(row(3).Status, "closed");
  assert.equal(row(3)["Check-Out Stated (user)"].getTime(), centralMs("2026-11-12 17:30"));
  assert.equal(row(3)["Admin Alerts?"], "auto clock-out at 5:30 PM, time of the check-in tap");
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-14 04:00, closed 1");
});

test("runAutoClockOut with no Shifts tab logs one line and guesses arrival + 3 h", () => {
  const s = server({ settings: AUTO_SETTINGS, triggers: AUTO_OWN, log: autoLog() });
  s.runAuto(FRIDAY_4);
  assert.equal(
    s.sheets.Log.rowByHeader(2)["Admin Alerts?"],
    "auto clock-out at 12:00 PM, arrival + 3 h",
  );
  assert.equal(
    s.logs.filter((l) => l.includes('there is no "Shifts" tab')).length,
    1,
    s.logs.join("\n"),
  );
});

test("runAutoClockOut stops starting rows when its time is up and the next run closes the rest", () => {
  // Each flush moves the clock 1.5 minutes: each closed row costs 3.
  const s = server({
    settings: AUTO_SETTINGS,
    triggers: AUTO_OWN,
    log: [
      LOG_HEADER,
      openLine("s-1", "tok-a", "Avery Stone", "2026-11-10", "09:00"),
      openLine("s-2", "tok-b", "Blair Moss", "2026-11-10", "10:00"),
      openLine("s-3", "tok-c", "Casey Fern", "2026-11-10", "11:00"),
    ],
    onFlush: (state) => (state.now += 1.5 * MIN),
  });
  s.runAuto(FRIDAY_4);
  const status = () => [2, 3, 4].map((n) => s.sheets.Log.rowByHeader(n).Status);
  assert.deepEqual(status(), ["closed", "closed", "open"]);
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-13 04:00, closed 2");
  assert.match(s.logs.join("\n"), /out of time, 1 row\(s\) left for the next run/);
  s.runAuto("2026-11-14 04:00");
  assert.deepEqual(status(), ["closed", "closed", "closed"]);
});

test("a row that moves during the run is left for the next run, not written by its old number", () => {
  // A row staff type in by hand, closed, for another volunteer.
  const handRow = logLine({
    [H.date]: "2026-11-10",
    [H.name]: "Finley Park",
    [H.token]: "tok-f",
    [H.status]: "closed",
    [H.inBy]: "EM",
    [H.outBy]: "EM",
    [H.statedHours]: 2,
    [H.shiftId]: "s-hand",
  });
  let inserted = false;
  const s = server({
    settings: AUTO_SETTINGS,
    triggers: AUTO_OWN,
    log: [
      LOG_HEADER,
      openLine("s-1", "tok-a", "Avery Stone", "2026-11-10", "09:00"),
      openLine("s-2", "tok-b", "Blair Moss", "2026-11-10", "10:00"),
      openLine("s-3", "tok-c", "Casey Fern", "2026-11-10", "11:00"),
    ],
    // After the first row is written, staff insert their row above Blair's, moving Blair
    // and Casey down one.
    onFlush: () => {
      if (inserted) return;
      inserted = true;
      s.sheets.Log.rows.splice(2, 0, handRow.slice());
    },
  });
  s.runAuto(FRIDAY_4);
  const row = (n) => s.sheets.Log.rowByHeader(n);
  assert.equal(row(2).Status, "closed");
  // The run planned Blair at row 3 and Casey at row 4; both rows changed under it.
  assert.deepEqual(
    [3, 4, 5].map((n) => [row(n)["Shift ID"], row(n).Status, row(n)["Admin Alerts?"]]),
    [
      ["s-hand", "closed", ""],
      ["s-2", "open", ""],
      ["s-3", "open", ""],
    ],
  );
  assert.equal(row(3)["Check-Out Entered By"], "EM");
  assert.equal(s.sheets.Flags.getLastRow(), 2);
  assert.equal(s.sheets.Flags.rowByHeader(2)["Shift ID"], "s-1");
  assert.deepEqual(
    s.logs.filter((l) => l.includes("changed during the run")),
    [
      "Auto clock-out: Log row 3 (Shift ID s-2) changed during the run, so it was left for the next run.",
      "Auto clock-out: Log row 4 (Shift ID s-3) changed during the run, so it was left for the next run.",
    ],
  );
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-13 04:00, closed 1");

  // The next run finds them at their new rows.
  s.runAuto("2026-11-14 04:00");
  assert.deepEqual(
    [3, 4, 5].map((n) => row(n).Status),
    ["closed", "closed", "closed"],
  );
  assert.equal(row(3)["Check-Out Entered By"], "EM");
  assert.deepEqual(
    [3, 4].map((n) => [
      s.sheets.Flags.rowByHeader(n)["Shift ID"],
      s.sheets.Flags.rowByHeader(n)["Log Row"],
    ]),
    [
      ["s-2", 4],
      ["s-3", 5],
    ],
  );
});

test("a row closed or deleted during the run is left alone", () => {
  let changed = false;
  const s = server({
    settings: AUTO_SETTINGS,
    triggers: AUTO_OWN,
    log: [
      LOG_HEADER,
      openLine("s-1", "tok-a", "Avery Stone", "2026-11-10", "09:00"),
      openLine("s-2", "tok-b", "Blair Moss", "2026-11-10", "10:00"),
      openLine("s-3", "tok-c", "Casey Fern", "2026-11-10", "11:00"),
    ],
    // Staff close Blair's row by hand and delete Casey's.
    onFlush: () => {
      if (changed) return;
      changed = true;
      const log = s.sheets.Log;
      log.rows[2][LOG_HEADER.indexOf(H.status)] = "closed";
      log.rows.splice(3, 1);
    },
  });
  s.runAuto(FRIDAY_4);
  assert.equal(s.sheets.Log.getLastRow(), 3);
  assert.equal(s.sheets.Log.rowByHeader(3)["Admin Alerts?"], "");
  assert.equal(s.sheets.Log.rowByHeader(3)["Check-Out Entered By"], "");
  assert.equal(s.sheets.Flags.getLastRow(), 2);
  assert.equal(s.logs.filter((l) => l.includes("changed during the run")).length, 2);
});

test("a busy lock makes runAutoClockOut throw before it reads anything", () => {
  const s = server({
    settings: AUTO_SETTINGS,
    triggers: AUTO_OWN,
    log: autoLog(),
    lockFree: false,
  });
  s.state.now = centralMs(FRIDAY_4);
  assert.throws(() => s.runAuto(), /lock was busy/);
  assert.deepEqual(
    s.calls.filter((c) => c.startsWith("SpreadsheetApp.")),
    [],
  );
  assert.equal(s.setting("Auto clock-out last run"), "");
});

test("a blank or unreadable Kiosk launch date fails the run before any write", () => {
  for (const launch of ["", "someday"]) {
    const s = server({
      settings: { "Kiosk launch date": launch },
      triggers: AUTO_OWN,
      log: autoLog(),
      shifts: SHIFTS,
    });
    const before = JSON.stringify(s.sheets.Log.rows);
    assert.throws(() => s.runAuto(FRIDAY_4), /Kiosk launch date/);
    assert.equal(JSON.stringify(s.sheets.Log.rows), before);
    assert.equal(s.sheets.Flags.getLastRow(), 1);
    assert.equal(s.setting("Auto clock-out last run"), "");
  }
});

test("runAutoClockOut run by its trigger passes the guard; another trigger's id is refused", () => {
  const s = server({
    settings: AUTO_SETTINGS,
    triggers: { [OWNER]: [...AUTO_OWN[OWNER], { uid: "t-email", handler: "runFlagsEmail" }] },
    log: autoLog(),
  });
  s.state.now = centralMs(FRIDAY_4);
  assert.throws(
    () => s.ctx.runAutoClockOut({ triggerUid: "t-email" }),
    /runs only from its trigger/,
  );
  assert.throws(() => s.ctx.runAutoClockOut(), /runs only from its trigger/);
  assert.equal(s.setting("Auto clock-out last run"), "");
  s.ctx.runAutoClockOut({ triggerUid: "t-auto" });
  assert.equal(s.setting("Auto clock-out last run"), "2026-11-13 04:00, closed 2");
});

test("setupDailyJobs logs how many open rows a run now would close", () => {
  const s = server({ settings: AUTO_SETTINGS, log: autoLog() });
  s.state.now = centralMs(FRIDAY_4);
  s.ctx.setupDailyJobs();
  assert.match(
    s.logs.join("\n"),
    /Auto clock-out: a run now would close 2 open row\(s\) and flag 1 whose check-in time can't be read\./,
  );
  // Counting writes nothing.
  assert.equal(s.sheets.Log.rowByHeader(2).Status, "open");
  // With no Log tab the line says why and setup still finishes.
  const t = server({ settings: AUTO_SETTINGS });
  t.ctx.setupDailyJobs();
  assert.match(t.logs.join("\n"), /couldn't count the open rows: The "Log" tab is missing/);
  assert.equal(t.setting("Daily jobs installed by"), OWNER);
});

// ---------------------------------------------------------------------------
// The nightly Log check

const HOURS_OWN = { [OWNER]: [{ uid: "t-hours", handler: "runHoursRefresh" }] };
const LOG_CHECK = "log check";
/** A closed kiosk row with nothing wrong: 9:00 to 12:00 on date, 3 hours both ways. */
const closedLine = (shiftId, token, name, date) =>
  logLine({
    [H.date]: date,
    [H.name]: name,
    [H.recordedIn]: date + " 09:00",
    [H.statedIn]: date + " 09:00",
    [H.recordedOut]: date + " 12:00",
    [H.statedOut]: date + " 12:00",
    [H.recordedHours]: 3,
    [H.statedHours]: 3,
    [H.token]: token,
    [H.status]: "closed",
    [H.inBy]: "kiosk",
    [H.outBy]: "kiosk",
    [H.shiftId]: shiftId,
  });
// Two problems: row 3 has no Shift ID, and rows 4 and 5 share one.
const checkLog = () => [
  LOG_HEADER,
  closedLine("s-1", "tok-a", "Avery Stone", "2026-11-09"),
  closedLine("", "tok-b", "Blair Moss", "2026-11-10"),
  closedLine("s-dup", "tok-c", "Casey Fern", "2026-11-11"),
  closedLine("s-dup", "tok-d", "Dana Reed", "2026-11-11"),
];

/**
 * A server for runHoursRefresh at 5 AM. hours stands in for Reports.js's refreshHours_:
 * a result kind ("write", "busy", ...) takes the document lock, reads the Log through
 * readReportLog_ as the real one does and answers that kind; a read that throws answers
 * failed-read with no Log, as the real one does; a function runs instead; "real" keeps the
 * real refreshHours_, which finds no Hours tabs here. s.logReads counts the Log reads.
 */
function nightly(opts = {}, hours = "write") {
  const s = server({ triggers: HOURS_OWN, now: centralMs("2026-11-13 05:00"), ...opts });
  s.logReads = 0;
  const readLog = s.ctx.readReportLog_;
  s.ctx.readReportLog_ = () => {
    s.logReads++;
    return readLog();
  };
  if (hours !== "real") {
    s.ctx.refreshHours_ = (cause, hold, openedAtMs, out) => {
      assert.equal(cause, "nightly");
      if (typeof hours === "function") return hours();
      s.ctx.withHoursLock_(hold, 120000);
      let log;
      try {
        log = s.ctx.readReportLog_();
      } catch (err) {
        return { kind: "failed-read", message: err.message, line: "The refresh failed." };
      }
      out.log = log;
      return { kind: hours, line: "As of 2026-11-13 5:00 AM." };
    };
  }
  return s;
}
const flagsOf = (s) =>
  Array.from({ length: s.sheets.Flags.getLastRow() - 1 }, (_, i) =>
    s.sheets.Flags.rowByHeader(i + 2),
  );

test("the nightly run refreshes Hours, then checks the Log it read, with one Log read", () => {
  const s = nightly({ log: checkLog() });
  s.runHours();
  assert.equal(s.logReads, 1);
  const flags = flagsOf(s);
  assert.deepEqual(
    flags.map((f) => [f["Shift ID"], f.Date, f["Volunteer Name"], f.Source, f["Log Row"]]),
    [
      ["(no Shift ID)", "2026-11-10", "Blair Moss", LOG_CHECK, 3],
      ["s-dup", "2026-11-11", "Casey Fern", LOG_CHECK, 4],
    ],
  );
  assert.match(flags[0].Reason, /^No Shift ID: /);
  assert.match(flags[1].Reason, /^Shift ID on more than one row: /);
  assert.equal(flags[0]["Raised At"].getTime(), centralMs("2026-11-13 05:00"));
  assert.equal(flags[0].Reviewed, false);
  // One line each: the Hours outcome first, then the Log check's.
  assert.equal(s.logs.length, 2, s.logs.join("\n"));
  assert.match(s.logs[0], /^Hours refresh \(nightly\): write;/);
  assert.match(
    s.logs[1],
    /^Log check \(nightly\): done; checked 4 rows, found 2, already flagged 0, flagged 2 new, 0 left for the next run; \d+ ms\. No Shift ID 1; Shift ID on more than one row 1\.$/,
  );
  // The document lock is released before the script lock is asked for, once.
  const released = s.calls.indexOf("docLock.releaseLock");
  assert.ok(s.calls.includes("docLock.tryLock"));
  assert.ok(released >= 0 && released < s.calls.indexOf("LockService.getScriptLock"));
  assert.equal(s.calls.filter((c) => c === "LockService.getScriptLock").length, 1);
  assert.equal(s.calls.filter((c) => c === "lock.releaseLock").length, 1);
});

test("a second run adds none; one problem gets one flag, Reviewed or not, until staff delete it", () => {
  const log = checkLog();
  // Within one run: a second no-ID row on the same date with the same name, and a third
  // row with the shared Shift ID, add no flag.
  log.push(closedLine("", "tok-b", "blair  moss", "2026-11-10"));
  log.push(closedLine("s-dup", "tok-e", "Emery Hale", "2026-11-12"));
  const s = nightly({ log });
  s.runHours();
  assert.equal(s.sheets.Flags.getLastRow(), 3);
  assert.match(s.logs[1], /checked 6 rows, found 2, already flagged 0, flagged 2 new/);

  // The next night: nothing new.
  s.logs.length = 0;
  s.runHours("2026-11-14 05:00");
  assert.equal(s.sheets.Flags.getLastRow(), 3);
  assert.match(s.logs[1], /done; checked 6 rows, found 2, already flagged 2, flagged 0 new/);

  // Staff tick one and delete the other: only the deleted one comes back, under the first.
  const reviewed = FLAG_HEADER.indexOf("Reviewed");
  s.sheets.Flags.rows[1][reviewed] = true;
  s.sheets.Flags.rows.splice(2, 1);
  s.logs.length = 0;
  s.runHours("2026-11-15 05:00");
  assert.match(s.logs[1], /found 2, already flagged 1, flagged 1 new/);
  const flags = flagsOf(s);
  assert.deepEqual(
    flags.map((f) => [f["Shift ID"], f.Reviewed]),
    [
      ["(no Shift ID)", true],
      ["s-dup", false],
    ],
  );
  assert.equal(flags[1]["Raised At"].getTime(), centralMs("2026-11-15 05:00"));
});

test("past 100 problems a run flags 100, the next run the rest, and the one after none", () => {
  // 150 rows with no Shift ID, each a different volunteer: 150 problems.
  const log = [LOG_HEADER];
  for (let i = 0; i < 150; i++) log.push(closedLine("", "tok-" + i, "Vol " + i, "2026-11-10"));
  const s = nightly({ log });
  s.runHours();
  assert.equal(s.sheets.Flags.getLastRow(), 101);
  assert.match(
    s.logs[1],
    /found 150, already flagged 0, flagged 100 new, 50 left for the next run/,
  );
  s.logs.length = 0;
  s.runHours("2026-11-14 05:00");
  assert.equal(s.sheets.Flags.getLastRow(), 151);
  assert.match(s.logs[1], /found 150, already flagged 100, flagged 50 new, 0 left/);
  s.logs.length = 0;
  s.runHours("2026-11-15 05:00");
  assert.equal(s.sheets.Flags.getLastRow(), 151);
  assert.match(s.logs[1], /found 150, already flagged 150, flagged 0 new, 0 left/);
  // Every problem flagged exactly once.
  const names = flagsOf(s).map((f) => f["Volunteer Name"]);
  assert.equal(new Set(names).size, 150);
});

test("a busy script lock makes the nightly run throw after the Hours step, with nothing flagged", () => {
  const s = nightly({ log: checkLog(), lockFree: false });
  assert.throws(
    () => s.runHours(),
    /^Error: Log check \(nightly\): The kiosk was busy, so nothing was flagged\./,
  );
  assert.equal(s.sheets.Flags.getLastRow(), 1);
  assert.match(s.logs[0], /^Hours refresh \(nightly\): write;/);
  assert.match(
    s.logs[1],
    /^Log check \(nightly\): busy; checked 4 rows, found 2, already flagged 0, flagged 0 new/,
  );
  assert.equal(s.logReads, 1);
  // A newer table already in is a good Hours step too.
  const newer = nightly({ log: checkLog(), lockFree: false }, "newer-in");
  assert.throws(() => newer.runHours(), /^Error: Log check \(nightly\): /);
});

test("with no Hours tabs the check reads the Log itself, once, and the Hours error is thrown", () => {
  const s = nightly({ log: checkLog() }, "real");
  assert.throws(() => s.runHours(), /^Error: Hours refresh \(nightly\): Run setupReports\.$/);
  assert.equal(s.logReads, 1);
  assert.equal(s.sheets.Flags.getLastRow(), 3);
  assert.match(s.logs[0], /^Hours refresh \(nightly\): no-tabs;/);
  assert.match(s.logs[1], /^Log check \(nightly\): done; checked 4 rows, found 2/);
  assert.ok(!s.calls.includes("docLock.tryLock"));
});

test("an Hours read that throws still throws the Hours error first, whatever the Log check does", () => {
  // A Log column renamed: the Hours read and the Log check's own read both fail.
  const log = checkLog();
  log[0] = log[0].map((h) => (h === H.status ? "State" : h));
  const s = nightly({ log });
  assert.throws(() => s.runHours(), /^Error: Hours refresh \(nightly\): The refresh failed\.$/);
  assert.equal(s.logReads, 2, "the Hours read, then the Log check's own");
  assert.match(s.logs[0], /^Hours refresh \(nightly\): failed-read;/);
  assert.match(
    s.logs[1],
    /^Log check \(nightly\): failed; checked 0 rows, found 0, .* ms\. The Log has no "status" column\./,
  );
  assert.equal(s.sheets.Flags.getLastRow(), 1);

  // A refresh that throws outright: the same error, after the Log check ran and logged.
  const boom = new Error("Hours exploded");
  const t = nightly({ log: checkLog() }, () => {
    throw boom;
  });
  assert.throws(
    () => t.runHours(),
    (err) => err === boom,
  );
  assert.equal(t.logReads, 1);
  assert.equal(t.sheets.Flags.getLastRow(), 3);
  assert.match(t.logs[0], /^Log check \(nightly\): done;/);

  // A failed Hours step and a busy Log check: the Hours error wins.
  const both = nightly({ log: checkLog(), lockFree: false }, "busy");
  assert.throws(() => both.runHours(), /^Error: Hours refresh \(nightly\): Another refresh/);
  assert.match(both.logs[1], /^Log check \(nightly\): busy;/);
});

test("a missing Flags tab fails the Log check, and the nightly run throws after a good Hours step", () => {
  const s = nightly({ log: checkLog(), flags: null });
  assert.throws(
    () => s.runHours(),
    /^Error: Log check \(nightly\): The Log check failed: The "Flags" tab is missing\./,
  );
  assert.match(s.logs[0], /^Hours refresh \(nightly\): write;/);
  assert.match(
    s.logs[1],
    /^Log check \(nightly\): failed; checked 4 rows, found 2, .*"Flags" tab is missing/,
  );
});

test("Check the Log now reads the Log once, flags under the lock and shows what it found", () => {
  const s = nightly({ log: checkLog() });
  s.ctx.checkLogNow();
  assert.equal(s.logReads, 1);
  assert.equal(s.sheets.Flags.getLastRow(), 3);
  assert.equal(s.alerts.length, 1);
  assert.match(
    s.alerts[0],
    /^Checked 4 Log rows: found 2 problems\. 2 flagged now on the Flags tab, 0 already flagged\./,
  );
  assert.match(s.logs[0], /^Log check \(menu\): done;/);
  const lock = s.calls.indexOf("LockService.getScriptLock");
  assert.ok(lock >= 0 && lock < s.calls.lastIndexOf("lock.releaseLock"));
  assert.ok(!s.calls.includes("LockService.getDocumentLock"));
  // Again: nothing new.
  s.ctx.checkLogNow();
  assert.equal(s.sheets.Flags.getLastRow(), 3);
  assert.match(s.alerts[1], /0 flagged now on the Flags tab, 2 already flagged\./);
  // A clean Log, and a busy lock.
  const clean = nightly({ log: checkLog().slice(0, 2) });
  clean.ctx.checkLogNow();
  assert.deepEqual(clean.alerts, ["Checked 1 Log row: no problems found."]);
  const busy = nightly({ log: checkLog(), lockFree: false });
  busy.ctx.checkLogNow();
  assert.deepEqual(busy.alerts, [
    "The kiosk was busy, so nothing was flagged. Try again in a minute.",
  ]);
  assert.equal(busy.sheets.Flags.getLastRow(), 1);
});

test("Check the Log now names the Kiosk contact after a failed run only", () => {
  const settings = { "Kiosk contact": "Pat Example, pat@example.org" };
  const failed = nightly({ log: checkLog(), flags: null, settings });
  failed.ctx.checkLogNow();
  assert.deepEqual(failed.alerts, [
    'The Log check failed: The "Flags" tab is missing. Run setupSheets(). If this keeps happening, contact: Pat Example, pat@example.org',
  ]);
  const done = nightly({ log: checkLog().slice(0, 2), settings });
  done.ctx.checkLogNow();
  assert.deepEqual(done.alerts, ["Checked 1 Log row: no problems found."]);
  const busy = nightly({ log: checkLog(), lockFree: false, settings });
  busy.ctx.checkLogNow();
  assert.deepEqual(busy.alerts, [
    "The kiosk was busy, so nothing was flagged. Try again in a minute.",
  ]);
  // A blank contact: the failure alone.
  const blank = nightly({ log: checkLog(), flags: null });
  blank.ctx.checkLogNow();
  assert.deepEqual(blank.alerts, [
    'The Log check failed: The "Flags" tab is missing. Run setupSheets().',
  ]);
});

test("flagsEmailMessage: the review path names Data > Change view in the text and the HTML", () => {
  const msg = L.flagsEmailMessage({
    summary: { recent: [], unreviewed: 2 },
    autoClockOut: { stale: false, lastRun: "2026-11-16 04:02" },
    flagsUrl: "u",
  });
  assert.match(msg.body, /\(Data > Change view > Flags: Unreviewed\)/);
  assert.match(msg.htmlBody, /\(Data &gt; Change view &gt; Flags: Unreviewed\)/);
  assert.doesNotMatch(msg.body + msg.htmlBody, /Filter views/);
});
