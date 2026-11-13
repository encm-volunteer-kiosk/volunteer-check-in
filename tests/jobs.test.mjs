// Tests for apps-script/Jobs.js, the daily jobs, and their pure rules in Logic.js: when the
// weekly flags email is due, what it counts and says, and how setupDailyJobs and
// removeDailyJobs manage the triggers. The server files are loaded into one global scope,
// as Apps Script loads them, with stand-ins for the Google services. Every person here is
// invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SERVER_FILES = ["Logic.js", "Sheets.js", "Jobs.js"].map((f) => [f, read("apps-script/" + f)]);

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
    };
    return range;
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
 * ({account: [{uid, handler}]}), lockFree (false: tryLock fails), sendFails, onSend.
 * calls records "Service.method" in order; logs what the server logs.
 */
function server(opts = {}) {
  const calls = [];
  const logs = [];
  const mail = [];
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
    }),
    SpreadsheetApp: service("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => sheets[name] || null,
        getUrl: () => SHEET_URL,
      }),
      flush: () => undefined,
    }),
    Utilities: service("Utilities", {
      formatDate: (date, tz, format) => {
        assert.equal(tz, TZ);
        const text = centralText(date.getTime());
        if (format === "yyyy-MM-dd") return text.slice(0, 10);
        if (format === "HH:mm") return text.slice(11);
        if (format === "yyyy-MM-dd HH:mm") return text;
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
  return { ctx, calls, logs, mail, created, sheets, triggers, state, setting, run };
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

test("runFlagsEmail does nothing while Flags email is Off or has no address it can read", () => {
  for (const settings of [
    { ...EMAIL_ON, "Flags email": "Off" },
    { ...EMAIL_ON, "Flags email": "" },
    { ...EMAIL_ON, "Flags email to": "" },
    { ...EMAIL_ON, "Flags email to": "the board, staff at example dot org" },
  ]) {
    const s = server({ settings, flags: WEEK_FLAGS, triggers: OWN_TRIGGER });
    s.run(MONDAY_8);
    assert.equal(s.mail.length, 0, JSON.stringify(settings));
    assert.equal(s.setting("Flags email last run"), "");
    assert.ok(!s.calls.includes("MailApp.sendEmail"));
  }
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
  assert.deepEqual(jobs, [{ handler: "runFlagsEmail", everyHours: 1 }]);
  assert.deepEqual(plain(s.created), jobs);
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.uid),
    ["keep", "new-1"],
  );
  assert.deepEqual(
    s.triggers["second@example.org"].map((t) => t.uid),
    ["theirs"],
  );
  assert.equal(s.setting("Daily jobs installed by"), OWNER);
  assert.match(
    s.logs.join("\n"),
    /removed 2 old trigger\(s\) and installed runFlagsEmail every 1 hour\(s\), owned by jobs@example\.org/,
  );
  // Again: still one of each.
  s.ctx.setupDailyJobs();
  assert.deepEqual(
    s.triggers[OWNER].map((t) => t.handler),
    ["someOtherFunction", "runFlagsEmail"],
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
