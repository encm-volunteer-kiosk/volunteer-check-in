import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/ScheduleUpdate.gs", import.meta.url), "utf8");
const HOUR = 3600000;
const LOG_HEADERS = [
  "Shift ID", "Volunteer ID", "First name", "Last name", "Date", "Tapped in at",
  "Arrived at", "Signed out at", "Hours", "Status", "Flag", "Staff note",
];
const SHIFT_HEADERS = ["Shifts", "Shift Schedule", "Shift Type", "Start", "Finish"];
const THURSDAY = [
  ["Thursday", "Morning", "Delivery", "6:30", "9:30"],
  ["Thursday", "Morning", "Operations", "9:00", "12:00"],
  ["Thursday", "Afternoon", "Operations", "12:00", "15:00"],
  ["Thursday", "Evening", "Various", "", ""],
];

function logRow(arrived, signedOut = "") {
  const row = LOG_HEADERS.map(() => "");
  row[4] = "2026-11-12";
  row[5] = new Date("2026-11-12T20:00:00Z");
  row[6] = typeof arrived === "string" && arrived ? new Date(arrived) : arrived;
  row[7] = signedOut;
  return row;
}

function harness({
  rows = [logRow("2026-11-12T19:54:40.824Z")],
  shifts = THURSDAY,
  now = "2026-11-13T06:30:00Z",
  timezone = "America/Chicago",
  config = {},
  headers = LOG_HEADERS,
  lockAvailable = true,
  verifyMismatch = false,
  activeSpreadsheet = true,
  spreadsheetId = "active-test-sheet-id",
} = {}) {
  const nowMs = Date.parse(now);
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
    static [Symbol.hasInstance](value) {
      return value instanceof Date;
    }
  }
  const formatters = new Map();
  function parts(date, zone) {
    if (!formatters.has(zone)) {
      formatters.set(zone, new Intl.DateTimeFormat("en-US", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }));
    }
    return Object.fromEntries(
      formatters.get(zone).formatToParts(date).map(({ type, value }) => [type, value]),
    );
  }
  function formatDate(date, zone, pattern) {
    const p = parts(date, zone);
    const day = `${p.year}-${p.month}-${p.day}`;
    const time = `${p.hour}:${p.minute}`;
    if (pattern === "yyyy-MM-dd") return day;
    if (pattern === "HH:mm") return time;
    if (pattern === "yyyy-MM-dd HH:mm") return `${day} ${time}`;
    if (pattern === "yyyy-MM-dd HH:mm:ss") return `${day} ${time}:${p.second}`;
    throw new Error("Unmocked date format: " + pattern);
  }
  function parseDate(text, zone, pattern) {
    assert.equal(pattern, "yyyy-MM-dd HH:mm");
    const utc = Date.parse(text.replace(" ", "T") + ":00Z");
    const offsetAt = (ms) => {
      const p = parts(new Date(ms), zone);
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
    };
    const estimate = utc - offsetAt(utc);
    return new Date(utc - offsetAt(estimate));
  }
  function display(value) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? "Invalid Date"
        : formatDate(value, timezone, "yyyy-MM-dd HH:mm");
    }
    if (typeof value === "number" && value >= 0 && value < 1) {
      const minutes = Math.round(value * 1440);
      return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
    }
    return String(value ?? "");
  }

  const writes = [];
  const formats = [];
  const entries = [];
  const triggers = [];
  const deletedTriggers = [];
  const unrelatedTrigger = { getHandlerFunction: () => "anotherJob" };
  const oldTrigger = { getHandlerFunction: () => "updateDailyCheckOuts" };
  let released = false;
  let flushes = 0;
  function sheet(data) {
    return {
      getLastRow: () => data.length,
      getLastColumn: () => data[0].length,
      getDataRange: () => ({
        getValues: () => data.map((row) => row.slice()),
        getDisplayValues: () => data.map((row) => row.map(display)),
      }),
      getRange(row, column) {
        return {
          setValue(value) {
            writes.push({ row, column, value });
            data[row - 1][column - 1] = value;
            return this;
          },
          setNumberFormat(format) {
            formats.push({ row, column, format });
            return this;
          },
          getValue: () => verifyMismatch ? "" : data[row - 1][column - 1],
          getDisplayValue: () => display(data[row - 1][column - 1]),
        };
      },
    };
  }
  const log = sheet([headers, ...rows.map((row) => row.slice())]);
  const schedule = sheet([SHIFT_HEADERS, ...shifts]);
  const spreadsheet = {
    getId: () => spreadsheetId,
    getSheetByName: (name) => name === "Log" ? log : name === "Shifts" ? schedule : null,
    getSpreadsheetTimeZone: () => timezone,
    getName: () => "Synthetic schedule test",
  };
  const record = (line) => {
    const jsonStart = line.indexOf("{");
    entries.push(jsonStart >= 0
      ? JSON.parse(line.slice(jsonStart))
      : { event: line.replace("[SCHEDULE_CHECKOUT] ", "") });
  };
  const context = {
    Date: ClockDate,
    Object: { freeze: (value) => Object.freeze({ ...value, ...config }) },
    Utilities: { getUuid: () => "test-run", formatDate, parseDate },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheet ? spreadsheet : null,
      flush: () => { flushes++; },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => lockAvailable,
        releaseLock: () => { released = true; },
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => [oldTrigger, unrelatedTrigger],
      deleteTrigger: (trigger) => deletedTriggers.push(trigger),
      newTrigger(handler) {
        const trigger = { handler };
        return {
          timeBased() { return this; },
          everyHours(hours) { trigger.hours = hours; return this; },
          create() { triggers.push(trigger); },
        };
      },
    },
    console: { log: record, warn: record, error: record },
  };
  vm.runInNewContext(source, context);
  return {
    run: () => context.updateDailyCheckOuts(),
    showId: () => context.showSpreadsheetId(),
    diagnose: () => context.testCheckoutDiagnostics(),
    install: () => context.createCheckoutTrigger(),
    writes, formats, entries, triggers, deletedTriggers, oldTrigger,
    released: () => released,
    flushes: () => flushes,
    summary: () => entries.find((entry) => entry.event === "SUMMARY")?.details,
  };
}

test("showSpreadsheetId logs the active sheet ID without writing cells", () => {
  const h = harness();
  h.showId();
  assert.deepEqual(h.entries, [{ spreadsheetId: "active-test-sheet-id" }]);
  assert.equal(h.writes.length, 0);
});

test("showSpreadsheetId gives actionable guidance when no spreadsheet is active", () => {
  const h = harness({ activeSpreadsheet: false });
  assert.throws(() => h.showId(), /No active spreadsheet.*Extensions > Apps Script/);
  assert.equal(h.writes.length, 0);
});

test("checkout resolves the bound spreadsheet at runtime without a configured ID", () => {
  const h = harness({ spreadsheetId: "another-bound-spreadsheet" });
  h.run();
  const opened = h.entries.find((entry) => entry.event === "SHEETS_OPENED");
  assert.equal(opened.details.spreadsheetId, "another-bound-spreadsheet");
  assert.equal(h.summary().updated, 1);
});

test("checkout reports a missing bound spreadsheet and releases the lock", () => {
  const h = harness({ activeSpreadsheet: false });
  assert.throws(() => h.run(), /No active spreadsheet/);
  const failure = h.entries.find((entry) => entry.event === "EXECUTION_FAILED");
  assert.equal(failure.details.phase, "OPEN_SHEETS");
  assert.equal(h.writes.length, 0);
  assert.ok(h.released());
});

test("diagnostics inspect the bound spreadsheet without writing cells", () => {
  const h = harness({ spreadsheetId: "diagnostic-bound-spreadsheet" });
  h.diagnose();
  assert.ok(h.entries.some((entry) => entry.spreadsheetId === "diagnostic-bound-spreadsheet"));
  assert.equal(h.writes.length, 0);
});

test("diagnostics reject an execution without a bound spreadsheet", () => {
  const h = harness({ activeSpreadsheet: false });
  assert.throws(() => h.diagnose(), /No active spreadsheet/);
  assert.equal(h.writes.length, 0);
});

test("trigger setup requires a bound spreadsheet before replacing existing triggers", () => {
  const h = harness({ activeSpreadsheet: false });
  assert.throws(() => h.install(), /No active spreadsheet/);
  assert.equal(h.triggers.length, 0);
  assert.equal(h.deletedTriggers.length, 0);
});

test("uses the workbook's Afternoon label and D/E times, writing only Log H as a date", () => {
  const row = logRow("2026-11-12T19:54:40.824Z");
  const originalArrival = row[6].getTime();
  const h = harness({ rows: [row] });
  h.run();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].column, 8);
  assert.ok(h.writes[0].value instanceof Date);
  assert.equal(h.writes[0].value.toISOString(), "2026-11-12T21:00:00.000Z");
  assert.equal(row[6].getTime(), originalArrival);
  assert.equal(h.formats[0].format, "yyyy-mm-dd h:mm am/pm");
  assert.equal(h.flushes(), 1);
  assert.equal(h.summary().updated, 1);
  assert.ok(h.released());
});

test("the workbook's blank rows receive 3 PM, 3 PM, and the three-hour fallback", () => {
  const h = harness({ rows: [
    logRow("2026-11-12T19:54:40.824Z"),
    logRow("2026-11-12T20:00:01.446Z", new Date("2026-11-12T20:00:22.394Z")),
    logRow("2026-11-12T20:38:55.939Z", new Date("2026-11-12T21:24:23.388Z")),
    logRow("2026-11-12T20:46:21.742Z"),
    logRow("2026-11-12T22:18:48.614Z"),
  ] });
  h.run();
  assert.deepEqual(h.writes.map(({ row, column, value }) => [
    row, column, value.toISOString(),
  ]), [
    [2, 8, "2026-11-12T21:00:00.000Z"],
    [5, 8, "2026-11-12T21:00:00.000Z"],
    [6, 8, "2026-11-13T01:18:48.614Z"],
  ]);
  assert.equal(h.summary().existingCheckout, 2);
  assert.equal(h.summary().fallbacks, 1);
});

test("overlapping arrivals use the latest Start, ignoring arrival seconds", () => {
  const h = harness({ rows: [logRow("2026-11-12T15:15:59.999Z")] });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-12T18:00:00.000Z");
});

test("an exact Start takes priority and an adjacent Finish belongs to the next shift", () => {
  const h = harness({ rows: [
    logRow("2026-11-12T15:00:59.999Z"),
    logRow("2026-11-12T18:00:00Z"),
  ] });
  h.run();
  assert.deepEqual(h.writes.map(({ value }) => value.toISOString()), [
    "2026-11-12T18:00:00.000Z", "2026-11-12T21:00:00.000Z",
  ]);
});

test("a nonmatching arrival falls back to exactly three elapsed hours", () => {
  const arrived = "2026-11-12T22:12:47.123Z";
  const h = harness({ rows: [logRow(arrived)] });
  h.run();
  assert.equal(h.writes[0].value.getTime(), Date.parse(arrived) + 3 * HOUR);
  assert.equal(h.summary().fallbacks, 1);
});

test("a header-only Shifts tab still allows the three-hour fallback", () => {
  const h = harness({ shifts: [] });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-12T22:54:40.824Z");
});

test("Any schedules with blank times use the fallback and emit diagnostics", () => {
  const h = harness({ shifts: [["Thursday", "Any", "Various", "", ""]] });
  h.run();
  assert.equal(h.summary().fallbacks, 1);
  assert.ok(h.entries.some((entry) => entry.event === "SHIFT_SKIPPED" &&
    entry.details.reason === "INVALID_START_TIME"));
});

test("invalid shift times are reported, not used as a matching finish", () => {
  const h = harness({ shifts: [["Thursday", "Afternoon", "Operations", "12:00", "25:00"]] });
  h.run();
  assert.equal(h.summary().fallbacks, 1);
  assert.ok(h.entries.some((entry) => entry.details.reason === "INVALID_FINISH_TIME"));
});

test("reads numeric Sheets time values without parsing the schedule label", () => {
  const h = harness({ shifts: [["Thursday", "Afternoon", "Operations", 12 / 24, 15 / 24]] });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-12T21:00:00.000Z");
});

test("preserves existing sign-outs and today's arrivals while backfilling older blanks", () => {
  const h = harness({ rows: [
    logRow("2026-11-12T19:00:00Z", new Date("2026-11-12T20:00:00Z")),
    logRow("2026-11-13T06:01:00Z"),
    logRow("2026-11-11T19:00:00Z"),
    logRow(""),
    logRow("not a date"),
  ] });
  h.run();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].row, 4);
  assert.equal(h.writes[0].column, 8);
  assert.equal(h.writes[0].value.toISOString(), "2026-11-11T22:00:00.000Z");
  assert.equal(h.summary().existingCheckout, 1);
  assert.equal(h.summary().differentDate, 1);
  assert.equal(h.summary().missingCheckIn, 2);
});

test("backfills multiple old dates using each arrival's weekday and original date", () => {
  const h = harness({
    rows: [
      logRow("2026-11-10T13:15:00Z"),
      logRow("2026-11-11T19:45:00Z"),
      logRow("2026-11-12T19:45:00Z"),
      logRow("2026-11-09T17:20:00Z"),
    ],
    shifts: [
      ["Tuesday", "Morning", "Delivery", "6:30", "9:30"],
      ["Wednesday", "Afternoon", "Operations", "12:00", "16:00"],
      ...THURSDAY,
      ["Monday", "Any", "Various", "", ""],
    ],
  });
  h.run();
  assert.deepEqual(h.writes.map(({ row, column, value }) => [
    row, column, value.toISOString(),
  ]), [
    [2, 8, "2026-11-10T15:30:00.000Z"],
    [3, 8, "2026-11-11T22:00:00.000Z"],
    [4, 8, "2026-11-12T21:00:00.000Z"],
    [5, 8, "2026-11-09T20:20:00.000Z"],
  ]);
  assert.equal(h.summary().updated, 4);
  assert.equal(h.summary().fallbacks, 1);
});

test("backfills an old overnight shift using its arrival date across daylight saving", () => {
  const h = harness({
    rows: [logRow("2026-11-01T03:30:00Z")],
    shifts: [["Saturday", "Evening", "Operations", "22:00", "02:00"]],
  });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-01T08:00:00.000Z");
});

test("backfills an old three-hour fallback across its original year boundary", () => {
  const h = harness({
    rows: [logRow("2026-01-01T05:45:00Z")], shifts: [],
  });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-01-01T08:45:00.000Z");
});

test("backfills abbreviated weekdays and date-specific shifts for older arrivals", () => {
  const h = harness({
    rows: [
      logRow("2026-11-10T13:15:00Z"),
      logRow("2026-11-11T19:45:00Z"),
      logRow("2026-11-09T13:30:00Z"),
    ],
    shifts: [
      ["Tue", "Morning", "Delivery", "6:30", "9:30"],
      ["2026-11-11", "Afternoon", "Operations", "12:00", "16:00"],
      [new Date("2026-11-09T06:00:00Z"), "Morning", "Operations", "7:00", "11:00"],
    ],
  });
  h.run();
  assert.deepEqual(h.writes.map(({ value }) => value.toISOString()), [
    "2026-11-10T15:30:00.000Z",
    "2026-11-11T22:00:00.000Z",
    "2026-11-09T17:00:00.000Z",
  ]);
});

test("backfilled sign-outs are preserved on subsequent runs", () => {
  const h = harness({
    rows: [logRow("2026-11-10T13:15:00Z"), logRow("2026-11-11T19:45:00Z")],
    shifts: [],
  });
  h.run();
  h.run();
  assert.equal(h.writes.length, 2);
  const summary = h.entries.filter((entry) => entry.event === "SUMMARY").at(-1).details;
  assert.equal(summary.updated, 0);
  assert.equal(summary.existingCheckout, 2);
});

test("excludes today's and future arrivals even when today's fallback is overdue", () => {
  const h = harness({
    rows: [logRow("2026-11-13T13:00:00Z"), logRow("2026-11-14T13:00:00Z")],
    shifts: [],
    now: "2026-11-13T20:00:00Z",
  });
  h.run();
  assert.equal(h.writes.length, 0);
  assert.equal(h.summary().differentDate, 2);
});

test("matches the arrival weekday, not the execution weekday", () => {
  const h = harness({ shifts: [
    ["Friday", "Afternoon", "Operations", "12:00", "17:00"],
    ["Thursday", "Afternoon", "Operations", "12:00", "15:00"],
  ] });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-12T21:00:00.000Z");
});

test("duplicate matching shifts do not create an ambiguity", () => {
  const h = harness({ shifts: [THURSDAY[2], THURSDAY[2]] });
  h.run();
  assert.equal(h.summary().updated, 1);
  assert.equal(h.summary().ambiguous, 0);
});

test("conflicting finishes for the same latest Start are warned and left unchanged", () => {
  const h = harness({ shifts: [
    THURSDAY[2], ["Thursday", "Afternoon", "Other", "12:00", "16:00"],
  ] });
  h.run();
  assert.equal(h.writes.length, 0);
  assert.equal(h.summary().ambiguous, 1);
  assert.ok(h.entries.some((entry) => entry.level === "WARN" &&
    entry.details.reason === "AMBIGUOUS_MULTIPLE_SHIFTS"));
});

test("overnight matching shifts wait for Finish, then write the next-day timestamp", () => {
  const options = {
    rows: [logRow("2026-11-13T04:30:00Z")],
    shifts: [["Thursday", "Evening", "Operations", "22:00", "02:00"]],
  };
  const before = harness(options);
  before.run();
  assert.equal(before.writes.length, 0);
  assert.equal(before.summary().notDue, 1);
  assert.equal(before.summary().fallbacks, 0);
  const after = harness({ ...options, now: "2026-11-13T08:30:00Z" });
  after.run();
  assert.equal(after.writes[0].value.toISOString(), "2026-11-13T08:00:00.000Z");
});

test("late-night fallbacks wait for three hours and are picked up by a later hourly run", () => {
  const options = { rows: [logRow("2026-11-13T05:45:00Z")], shifts: [] };
  const before = harness(options);
  before.run();
  assert.equal(before.writes.length, 0);
  assert.equal(before.summary().notDue, 1);
  const after = harness({ ...options, now: "2026-11-13T09:00:00Z" });
  after.run();
  assert.equal(after.writes[0].value.toISOString(), "2026-11-13T08:45:00.000Z");
});

test("at exactly the calculated checkout instant, the row is eligible", () => {
  const h = harness({
    rows: [logRow("2026-11-13T05:45:00Z")], shifts: [], now: "2026-11-13T08:45:00Z",
  });
  h.run();
  assert.equal(h.summary().updated, 1);
});

test("the three-hour fallback is elapsed time across a daylight-saving transition", () => {
  const h = harness({
    rows: [logRow("2026-11-01T05:30:00Z")], shifts: [], now: "2026-11-02T06:30:00Z",
  });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-11-01T08:30:00.000Z");
});

test("scheduled Finish is constructed in the spreadsheet timezone during daylight time", () => {
  const h = harness({
    rows: [logRow("2026-07-09T18:30:00Z")], now: "2026-07-10T05:30:00Z",
  });
  h.run();
  assert.equal(h.writes[0].value.toISOString(), "2026-07-09T20:00:00.000Z");
});

test("derives dates and weekdays dynamically across year and leap-month boundaries", () => {
  for (const [now, arrived, weekday, expected] of [
    ["2027-01-01T06:30:00Z", "2026-12-31T19:30:00Z", "Thursday", "2026-12-31T21:00:00.000Z"],
    ["2028-03-01T06:30:00Z", "2028-02-29T19:30:00Z", "Tuesday", "2028-02-29T21:00:00.000Z"],
  ]) {
    const h = harness({
      rows: [logRow(arrived)], now,
      shifts: [[weekday, "Afternoon", "Operations", "12:00", "15:00"]],
    });
    h.run();
    assert.equal(h.writes[0].value.toISOString(), expected);
    assert.equal(h.summary().arrivalDateBefore, now.slice(0, 10));
  }
});

test("dry runs preview dated sign-outs without writing cells", () => {
  const h = harness({ config: { DRY_RUN: true } });
  h.run();
  assert.equal(h.writes.length, 0);
  assert.equal(h.summary().previews, 1);
  assert.equal(h.summary().updated, 0);
});

test("rejects the old Log layout before writing any cells", () => {
  const headers = [...LOG_HEADERS];
  headers[6] = "Check-Out Recorded";
  const h = harness({ headers });
  assert.throws(() => h.run(), /Arrived at/);
  assert.equal(h.writes.length, 0);
  assert.ok(h.released());
});

test("write verification failures are surfaced and always release the lock", () => {
  const h = harness({ verifyMismatch: true });
  assert.throws(() => h.run(), /verification failed/);
  assert.ok(h.entries.some((entry) => entry.event === "EXECUTION_FAILED"));
  assert.ok(h.released());
});

test("a concurrent execution cannot write or release another execution's lock", () => {
  const h = harness({ lockAvailable: false });
  assert.throws(() => h.run(), /Another checkout process/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.released(), false);
});

test("the trigger installer replaces only this job with hourly past-date retries", () => {
  const h = harness();
  h.install();
  assert.deepEqual(h.triggers, [{ handler: "updateDailyCheckOuts", hours: 1 }]);
  assert.deepEqual(h.deletedTriggers, [h.oldTrigger]);
});
