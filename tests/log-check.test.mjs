// Tests for the Log check block of apps-script/Logic.js: the time cell kinds reportEntry
// adds, each problem the check finds and its Flags reason, the keys that keep one Flags
// row per problem, the plan of one run and the text staff see. Logic.js is loaded the way
// Apps Script loads it, one plain script in its own global scope, so results are compared
// through plain().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

const plain = (x) => JSON.parse(JSON.stringify(x));
const H = plain(L.logHeaderNames());
const HEADER = plain(L.logHeaders());
const F = plain(L.flagHeaderNames());
const ZONE = "America/Chicago";
const REASONS = plain(L.logCheckReasons());
/** The clock the details use, as Admin.js's adminClock_ gives it. */
const clock = (ms) => formatInZone(new Date(ms), ZONE, "h:mm a");
/** The run's time: 2026-11-13 at noon, Central. */
const NOW = Date.parse("2026-11-13T12:00:00-06:00");

const centralDate = (ms) => formatInZone(new Date(ms), ZONE, "yyyy-MM-dd");
const centralClock = (ms) => formatInZone(new Date(ms), ZONE, "HH:mm");

/** A Central "HH:mm" on a yyyy-MM-dd as {ms, date} (November is UTC-6). */
const timeOnDate = (dateText, hhmm) => {
  const text = L.adminDateTimeText(dateText, hhmm);
  if (!text) return { ms: NaN, date: "" };
  const ms = Date.parse(text.replace(" ", "T") + ":00-06:00");
  return { ms, date: centralDate(ms) };
};

// read.text, read.time and read.at as Sheets.js gives them: a Date reads as its Central
// date, ISO texts are date-times and a typed time of day has no date.
const READ = {
  text: (v) =>
    Object.prototype.toString.call(v) === "[object Date]"
      ? centralDate(v.getTime())
      : L.cellString(v),
  time: (v) => {
    const none = { ms: NaN, date: "", clock: "" };
    if (Object.prototype.toString.call(v) === "[object Date]") {
      const ms = v.getTime();
      return isFinite(ms) ? { ms, date: centralDate(ms), clock: centralClock(ms) } : none;
    }
    const typed = L.clockText(v);
    if (typed) return { ms: NaN, date: "", clock: typed };
    const ms = L.cellString(v) ? Date.parse(String(v)) : NaN;
    return isFinite(ms) ? { ms, date: centralDate(ms), clock: "" } : none;
  },
  at: timeOnDate,
};

/** A Central wall-clock time in November as the ISO text a time cell holds here. */
const at = (date, hhmm) => date + "T" + hhmm + ":00-06:00";

/** A time typed with no date, as Sheets stores it: on 30 December 1899. */
const bareTime = (h, m) => new Date(Date.UTC(1899, 11, 30, h + 6, m));

/** A Log row's cells under HEADER, from a map of short header keys to values. */
function cellsFor(values) {
  return HEADER.map((h) => {
    const key = Object.keys(H).find((k) => H[k] === h);
    return key && values[key] !== undefined ? values[key] : "";
  });
}

/**
 * A closed kiosk shift on 2026-11-12 from 9:00 to 11:30, hours 2.50 each, with Shift ID
 * "s<row>", unless o says otherwise. Keys are logHeaderNames keys.
 */
function shift(o = {}) {
  const date = o.date === undefined ? "2026-11-12" : o.date;
  const day = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "2026-11-12";
  return {
    date,
    name: "Ann Lee",
    token: "tok-a",
    status: "closed",
    recordedIn: at(day, "09:00"),
    statedIn: at(day, "09:00"),
    recordedOut: at(day, "11:30"),
    statedOut: at(day, "11:30"),
    recordedHours: 2.5,
    statedHours: 2.5,
    inBy: "kiosk",
    outBy: "kiosk",
    ...o,
  };
}

/** Log rows (row 2 on) as report entries; a row without shiftId gets "s<row>". */
function entriesFor(rows) {
  const cols = L.reportColumns(HEADER);
  return rows.map((values, i) => {
    const v = { shiftId: "s" + (i + 2), ...values };
    return L.reportEntry(cellsFor(v), i + 2, cols, READ);
  });
}

/** The check's problems over rows, as [row, code, reason]. */
function found(rows, nowMs = NOW) {
  return plain(L.logCheckProblems(entriesFor(rows), clock, nowMs)).map((p) => [
    p.base.logRow,
    p.code,
    p.reason,
  ]);
}

/** A Flags row as readFlags_ gives it back from one of a plan's new rows. */
function readBack(map, reviewed = false) {
  return {
    date: map[F.date],
    name: map[F.name],
    shiftId: map[F.shiftId],
    reason: map[F.reason],
    raisedAtMs: map[F.raisedAt],
    reviewed,
    source: map[F.source],
  };
}

// ---------------------------------------------------------------------------
// Codes, labels and constants

test("the check's codes and labels, in the order a row is checked", () => {
  assert.deepEqual(Object.keys(REASONS), [
    "no-shift-id",
    "duplicate-id",
    "bad-date",
    "recorded-no-date",
    "bad-status",
    "no-check-in",
    "out-before-in",
    "closed-no-out",
    "hours-mismatch",
    "impossible-length",
  ]);
  assert.equal(REASONS["bad-date"], "Date isn't a full date");
  assert.equal(REASONS["duplicate-id"], "Shift ID on more than one row");
});

test("no label and its colon starts another label's reason", () => {
  const labels = Object.values(REASONS);
  labels.forEach((a) =>
    labels.forEach((b) => {
      if (a !== b) assert.ok(!(b + ": x").startsWith(a + ":"), a + " / " + b);
    }),
  );
});

test("the check's constants and its Flags source", () => {
  assert.equal(L.logCheckMaxHours(), 16);
  assert.equal(L.logCheckMaxNewFlags(), 100);
  assert.equal(L.logCheckNoIdText(), "(no Shift ID)");
  assert.equal(L.flagSources().logCheck, "log check");
  assert.equal(L.flagSources().autoClose, "auto-close");
});

// ---------------------------------------------------------------------------
// Time cell kinds

test("timeCellKind: blank, a time with no date, or anything else", () => {
  assert.equal(L.timeCellKind(""), "blank");
  assert.equal(L.timeCellKind("   "), "blank");
  assert.equal(L.timeCellKind(null), "blank");
  assert.equal(L.timeCellKind(undefined), "blank");
  assert.equal(L.timeCellKind(bareTime(9, 0)), "time-only");
  assert.equal(L.timeCellKind(new Date(Date.UTC(1900, 0, 1, 23, 59))), "time-only");
  assert.equal(L.timeCellKind(new Date(Date.UTC(1900, 0, 2))), "other");
  assert.equal(L.timeCellKind("9:00 AM"), "time-only");
  assert.equal(L.timeCellKind("13:05"), "time-only");
  assert.equal(L.timeCellKind(new Date(at("2026-11-12", "09:00"))), "other");
  assert.equal(L.timeCellKind(at("2026-11-12", "09:00")), "other");
  assert.equal(L.timeCellKind("2026-11-12"), "other");
  assert.equal(L.timeCellKind(0.375), "other");
  assert.equal(L.timeCellKind(new Date(NaN)), "other");
});

test("timeCellKind knows a Date made in Logic.js's own context", () => {
  const inside = vm.runInNewContext("new Date(Date.UTC(1899, 11, 30, 15, 0))", {});
  assert.ok(!(inside instanceof Date));
  assert.equal(L.timeCellKind(inside), "time-only");
});

test("reportEntry gives the kinds of the Date and the four time cells", () => {
  const [e] = entriesFor([
    shift({
      date: bareTime(9, 0),
      recordedIn: "9:00 AM",
      statedIn: at("2026-11-12", "09:00"),
      recordedOut: "",
      statedOut: bareTime(11, 30),
    }),
  ]);
  assert.equal(e.dateText, "1899-12-30");
  assert.deepEqual(plain(e.timeKinds), {
    date: "time-only",
    recordedIn: "time-only",
    statedIn: "other",
    recordedOut: "blank",
    statedOut: "time-only",
  });
});

test("logCheckRowCount counts the rows that aren't blank", () => {
  const entries = entriesFor([shift(), { shiftId: "", name: "", token: "", status: "" }, shift()]);
  assert.equal(L.logCheckRowCount(entries), 2);
  assert.equal(L.logCheckRowCount([]), 0);
});

// ---------------------------------------------------------------------------
// Each problem

test("a clean closed row, a clean open row and a blank row have no problems", () => {
  assert.deepEqual(
    found([
      shift(),
      shift({ status: "open", recordedOut: "", statedOut: "", recordedHours: "", statedHours: "" }),
      { shiftId: "", name: "", token: "", status: "" },
    ]),
    [],
  );
});

test("no-shift-id: a row with no Shift ID, keyed by its Date and name", () => {
  const problems = plain(L.logCheckProblems(entriesFor([shift({ shiftId: "" })]), clock, NOW));
  assert.deepEqual(problems, [
    {
      code: "no-shift-id",
      key: "row|2026-11-12|ann lee|no-shift-id",
      label: "No Shift ID",
      reason: "No Shift ID: the Shift ID cell is blank",
      base: { date: "2026-11-12", name: "Ann Lee", shiftId: "(no Shift ID)", logRow: 2 },
    },
  ]);
});

test("duplicate-id: one problem per Shift ID, at its first row, naming every row", () => {
  assert.deepEqual(
    found([
      shift({ shiftId: "dup" }),
      shift(),
      shift({ shiftId: " dup " }),
      shift({ shiftId: "dup" }),
    ]),
    [[2, "duplicate-id", "Shift ID on more than one row: rows 2, 4, 5"]],
  );
  const [p] = plain(
    L.logCheckProblems(
      entriesFor([shift({ shiftId: "dup" }), shift({ shiftId: "dup" })]),
      clock,
      NOW,
    ),
  );
  assert.equal(p.key, "id|dup|duplicate-id");
});

test("duplicate-id: a blank row doesn't count as a copy", () => {
  const rows = [shift({ shiftId: "x" }), { shiftId: "", name: "", token: "", status: "" }];
  assert.deepEqual(found(rows), []);
});

test("bad-date: a time in the Date cell (1899-12-30), and the row's time checks are skipped", () => {
  // The stated times read on 1899-12-30, out before in, with no hours: only the Date is
  // reported.
  const row = shift({
    date: bareTime(9, 0),
    statedIn: "10:00 AM",
    statedOut: "9:00 AM",
    recordedHours: "",
    statedHours: "",
  });
  assert.deepEqual(found([row]), [
    [2, "bad-date", "Date isn't a full date: Date holds only a time"],
  ]);
  // The checks that read cells, not times on the Date, still run.
  assert.deepEqual(
    found([{ ...row, recordedIn: "10:00 AM", statedHours: 20 }]).map((p) => p[1]),
    ["bad-date", "recorded-no-date", "impossible-length"],
  );
  assert.deepEqual(found([shift({ date: "9:00 AM" })]), [
    [2, "bad-date", "Date isn't a full date: Date holds only a time"],
  ]);
});

test("bad-date: a blank Date, text that isn't a yyyy-MM-dd day", () => {
  assert.deepEqual(found([shift({ date: "" })]), [
    [2, "bad-date", "Date isn't a full date: Date is blank"],
  ]);
  assert.deepEqual(found([shift({ date: "11/13/2026" })]), [
    [2, "bad-date", 'Date isn\'t a full date: Date reads "11/13/2026"'],
  ]);
  assert.deepEqual(found([shift({ date: "2026-02-30" })]), [
    [2, "bad-date", 'Date isn\'t a full date: Date reads "2026-02-30"'],
  ]);
});

test("bad-date: a Date is good from 2000-01-01 to the end of the run's month", () => {
  const dateOnly = (date) =>
    shift({
      date,
      recordedIn: "",
      statedIn: "9:00 AM",
      recordedOut: "",
      statedOut: "11:30 AM",
      recordedHours: "",
    });
  const bad = (date) => [[2, "bad-date", "Date isn't a full date: Date reads \"" + date + '"']];
  assert.deepEqual(found([dateOnly("1999-12-31")]), bad("1999-12-31"));
  assert.deepEqual(found([dateOnly("2000-01-01")]), []);
  assert.deepEqual(found([dateOnly("2026-11-30")]), []);
  assert.deepEqual(found([dateOnly("2026-12-01")]), bad("2026-12-01"));
  assert.deepEqual(found([dateOnly("2062-11-13")]), bad("2062-11-13"));
});

test("bad-date: the run's month is read in UTC, never behind Central's", () => {
  // 9 PM on 30 November, Central, is already December in UTC.
  const late = Date.parse("2026-11-30T21:00:00-06:00");
  const row = shift({
    date: "2026-12-01",
    recordedIn: "",
    statedIn: "9:00 AM",
    recordedOut: "",
    statedOut: "11:30 AM",
    recordedHours: "",
  });
  assert.deepEqual(found([row], late), []);
});

test("bad-date: with no run time given, the check uses the clock", () => {
  const entries = entriesFor([shift({ date: "2062-11-13" })]);
  assert.deepEqual(
    plain(L.logCheckProblems(entries, clock)).map((p) => p.code),
    ["bad-date"],
  );
  assert.deepEqual(plain(L.logCheckProblems(entriesFor([shift()]), clock)), []);
});

test("recorded-no-date: a Recorded cell holding only a time; a bare Stated time is fine", () => {
  assert.deepEqual(found([shift({ recordedIn: bareTime(9, 0) })]), [
    [2, "recorded-no-date", "Recorded time has no date: Check-In Recorded holds only a time"],
  ]);
  assert.deepEqual(found([shift({ recordedIn: "9:00 AM", recordedOut: "11:30 AM" })]), [
    [
      2,
      "recorded-no-date",
      "Recorded time has no date: Check-In Recorded and Check-Out Recorded hold only a time",
    ],
  ]);
  assert.deepEqual(found([shift({ statedIn: "9:00 AM", statedOut: bareTime(11, 30) })]), []);
});

test("bad-status: neither open nor closed, blank included; such a row skips the status checks", () => {
  assert.deepEqual(found([shift({ status: "auto-closed" })]), [
    [2, "bad-status", 'Status isn\'t open or closed: Status reads "auto-closed"'],
  ]);
  assert.deepEqual(found([shift({ status: "", recordedIn: "", statedIn: "", statedHours: "" })]), [
    [2, "bad-status", "Status isn't open or closed: Status is blank"],
  ]);
  assert.deepEqual(found([shift({ status: " Closed " })]), []);
});

test("no-check-in: both check-in cells blank, or a check-in that doesn't read on the Date", () => {
  const blank = shift({
    status: "open",
    recordedIn: "",
    statedIn: "",
    recordedOut: "",
    statedOut: "",
    recordedHours: "",
    statedHours: "",
  });
  assert.deepEqual(found([blank]), [
    [2, "no-check-in", "Check-in missing or unreadable: both check-in cells blank"],
  ]);
  const otherDay = { ...blank, recordedIn: at("2026-11-10", "09:00") };
  assert.deepEqual(found([otherDay]), [
    [2, "no-check-in", "Check-in missing or unreadable: check-in can't be read on the row's Date"],
  ]);
});

test("no-check-in: not raised on a row the kiosk already alerted, an import row or a bad status", () => {
  const open = {
    status: "open",
    recordedIn: "",
    statedIn: "",
    recordedOut: "",
    statedOut: "",
    recordedHours: "",
    statedHours: "",
  };
  assert.deepEqual(found([shift({ ...open, alerts: "note; " + L.unreadableStartAlert() })]), []);
  assert.deepEqual(found([shift({ ...open, alerts: L.autoClockOutSkippedAlert() })]), []);
  const imported = shift({
    recordedIn: "",
    statedIn: "",
    recordedOut: "",
    statedOut: "",
    recordedHours: "",
    statedHours: 3,
    inBy: "IMPORT",
    outBy: "import",
  });
  assert.deepEqual(found([imported]), []);
  assert.deepEqual(
    found([shift({ ...open, status: "void" })]).map((p) => p[1]),
    ["bad-status"],
  );
});

test("out-before-in: either pair, with both times read, named with the clock", () => {
  const both = shift({
    recordedIn: at("2026-11-12", "10:00"),
    statedIn: at("2026-11-12", "10:00"),
    recordedOut: at("2026-11-12", "09:06"),
    statedOut: at("2026-11-12", "09:06"),
    recordedHours: "",
    statedHours: "",
  });
  assert.deepEqual(found([both]), [
    [
      2,
      "out-before-in",
      "Check-out before check-in: recorded in 10:00 AM, out 9:06 AM; stated in 10:00 AM, out 9:06 AM",
    ],
  ]);
  // Stated in reads as the start; an unreadable stated in falls back to recorded in.
  const stated = shift({ statedIn: "", statedOut: "8:30 AM", statedHours: "" });
  assert.deepEqual(found([stated]), [
    [2, "out-before-in", "Check-out before check-in: stated in 9:00 AM, out 8:30 AM"],
  ]);
});

test("closed-no-out: both check-out cells blank; an unreadable one isn't this problem", () => {
  const noOut = shift({ recordedOut: "", statedOut: "", recordedHours: "", statedHours: "" });
  assert.deepEqual(found([noOut]), [
    [2, "closed-no-out", "Closed with no check-out: both check-out cells blank"],
  ]);
  // The auto clock-out's next-day guess doesn't read on the row's Date.
  const guess = shift({
    recordedOut: "",
    statedOut: at("2026-11-13", "09:00"),
    recordedHours: "",
    statedHours: "",
  });
  assert.deepEqual(found([guess]), []);
  const imported = {
    ...noOut,
    recordedIn: "",
    statedIn: "",
    statedHours: 2,
    inBy: "import",
    outBy: "import",
  };
  assert.deepEqual(found([imported]), []);
});

test("hours-mismatch: a stated or timestamps cell off by more than 1 hundredth", () => {
  const row = (o) =>
    shift({
      statedOut: at("2026-11-12", "11:31"),
      recordedOut: at("2026-11-12", "11:31"),
      recordedHours: 2.52,
      ...o,
    });
  // 9:00 to 11:31 is 2.52 h (2.5166 rounded).
  assert.deepEqual(found([row({ statedHours: 2.52 })]), []);
  assert.deepEqual(found([row({ statedHours: 2.51 })]), []);
  assert.deepEqual(found([row({ statedHours: 2.53 })]), []);
  assert.deepEqual(found([row({ statedHours: "2.52" })]), []);
  assert.deepEqual(found([row({ statedHours: 3.5 })]), [
    [2, "hours-mismatch", "Hours don't match the times: stated 3.50 h, times give 2.52 h"],
  ]);
  assert.deepEqual(found([row({ statedHours: 2.5, recordedHours: 2.5 })]), [
    [
      2,
      "hours-mismatch",
      "Hours don't match the times: timestamps 2.50 h, times give 2.52 h; stated 2.50 h, times give 2.52 h",
    ],
  ]);
  assert.deepEqual(found([row({ statedHours: "" })]), [
    [2, "hours-mismatch", "Hours don't match the times: stated blank, times give 2.52 h"],
  ]);
  assert.deepEqual(found([row({ statedHours: "abc" })]), [
    [2, "hours-mismatch", 'Hours don\'t match the times: stated reads "abc", times give 2.52 h'],
  ]);
});

test("hours-mismatch: only closed rows, and only a pair with both times read in order", () => {
  assert.deepEqual(found([shift({ status: "open", statedHours: 9 })]), []);
  assert.deepEqual(found([shift({ statedOut: "", statedHours: 9 })]), []);
});

test("impossible-length: an hours cell below 0 or above 16, or times more than 16 h apart", () => {
  assert.deepEqual(
    found([shift({ statedHours: -1 })]).map((p) => p[1]),
    ["hours-mismatch", "impossible-length"],
  );
  assert.deepEqual(
    found([
      shift({
        statedIn: "",
        recordedIn: "",
        recordedOut: "",
        statedOut: "",
        statedHours: 16,
        inBy: "import",
        outBy: "import",
      }),
    ]),
    [],
  );
  assert.deepEqual(
    found([
      shift({
        statedIn: "",
        recordedIn: "",
        recordedOut: "",
        statedOut: "",
        statedHours: "16.5",
        inBy: "import",
        outBy: "import",
      }),
    ]),
    [[2, "impossible-length", "Impossible shift length: stated hours 16.50 h"]],
  );
  const long = shift({
    recordedIn: at("2026-11-12", "06:00"),
    statedIn: at("2026-11-12", "06:00"),
    recordedOut: at("2026-11-12", "23:00"),
    statedOut: at("2026-11-12", "23:00"),
    recordedHours: 17,
    statedHours: 17,
  });
  assert.deepEqual(found([long]), [
    [
      2,
      "impossible-length",
      "Impossible shift length: timestamps hours 17.00 h; stated hours 17.00 h; " +
        "recorded times 17.00 h apart; stated times 17.00 h apart",
    ],
  ]);
});

test("problems come in Log row order, then in the order of the codes", () => {
  const rows = [
    shift({ shiftId: "", status: "", recordedIn: "", statedIn: "" }),
    shift({ shiftId: "d", statedHours: 3 }),
    shift({ shiftId: "d" }),
  ];
  assert.deepEqual(
    found(rows).map((p) => [p[0], p[1]]),
    [
      [2, "no-shift-id"],
      [2, "bad-status"],
      [3, "duplicate-id"],
      [3, "hours-mismatch"],
    ],
  );
});

test("the odd live rows: each gets only what its cells earn", () => {
  // Checked out before checking in.
  const paige = shift({
    name: "Paige Wise",
    date: "2026-11-13",
    recordedIn: at("2026-11-13", "10:00"),
    statedIn: at("2026-11-13", "10:00"),
    recordedOut: at("2026-11-13", "09:06"),
    statedOut: at("2026-11-13", "09:06"),
    recordedHours: "",
    statedHours: "",
  });
  // A Check-In Recorded cell edited to a bare time.
  const jessica = shift({
    name: "Jessica Coughlin",
    date: "2026-11-13",
    recordedIn: bareTime(9, 0),
    statedIn: at("2026-11-13", "09:00"),
    recordedOut: at("2026-11-13", "11:30"),
    statedOut: at("2026-11-13", "11:30"),
  });
  // Notes aren't checked.
  const testing = shift({
    name: "Testing",
    date: "2026-11-13",
    notes: "Testing",
    statedIn: at("2026-11-13", "09:00"),
    recordedIn: at("2026-11-13", "09:00"),
    recordedOut: at("2026-11-13", "11:30"),
    statedOut: at("2026-11-13", "11:30"),
  });
  assert.deepEqual(
    found([paige, jessica, testing]).map((p) => [p[0], p[1]]),
    [
      [2, "out-before-in"],
      [3, "recorded-no-date"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Keys

test("logCheckKey: by Shift ID, or by Date and normalized name when there is none", () => {
  assert.equal(L.logCheckKey(" s9 ", "2026-11-12", "Ann", "bad-date"), "id|s9|bad-date");
  assert.equal(
    L.logCheckKey("", " 2026-11-12 ", "  Ann   LEE ", "no-shift-id"),
    "row|2026-11-12|ann lee|no-shift-id",
  );
  assert.equal(
    L.logCheckKey("(no Shift ID)", "2026-11-12", "Ann Lee", "bad-date"),
    "row|2026-11-12|ann lee|bad-date",
  );
});

test("logCheckFlagKey: a Flags row the plan wrote keys back to its problem", () => {
  const entries = entriesFor([
    shift({ shiftId: "", name: "=Ann", statedHours: 3 }),
    shift({ shiftId: "s3", date: bareTime(9, 0) }),
  ]);
  const problems = plain(L.logCheckProblems(entries, clock, NOW));
  const plan = plain(L.logCheckPlan(problems, [], NOW, 100));
  assert.deepEqual(
    plan.newRows.map((m) =>
      L.logCheckFlagKey({ ...readBack(m), name: L.cellString(m[F.name]).replace(/^'/, "") }),
    ),
    problems.map((p) => p.key),
  );
});

test("logCheckFlagKey: '' for other sources and reasons the check didn't write", () => {
  const flag = {
    date: "2026-11-12",
    name: "Ann",
    shiftId: "s1",
    reason: "No Shift ID: x",
    reviewed: true,
  };
  assert.equal(L.logCheckFlagKey({ ...flag, source: "log check" }), "id|s1|no-shift-id");
  assert.equal(L.logCheckFlagKey({ ...flag, source: " Log Check " }), "id|s1|no-shift-id");
  assert.equal(L.logCheckFlagKey({ ...flag, source: "kiosk check-in" }), "");
  assert.equal(L.logCheckFlagKey({ ...flag, source: "" }), "");
  assert.equal(L.logCheckFlagKey({ ...flag, source: "log check", reason: "No Shift ID" }), "");
  assert.equal(L.logCheckFlagKey({ ...flag, source: "log check", reason: "something else" }), "");
});

// ---------------------------------------------------------------------------
// The plan of one run

const PLAN_KEYS = ["already", "byLabel", "flagged", "found", "left", "newRows"];

test("logCheckPlan: the Plan's fields, and new rows as Flags row maps", () => {
  const problems = L.logCheckProblems(entriesFor([shift({ statedHours: 3 })]), clock, NOW);
  const plan = plain(L.logCheckPlan(problems, [], NOW, 100));
  assert.deepEqual(Object.keys(plan).sort(), PLAN_KEYS);
  assert.deepEqual(plan.newRows, [
    {
      [F.date]: "2026-11-12",
      [F.name]: "Ann Lee",
      [F.shiftId]: "s2",
      [F.reason]: "Hours don't match the times: stated 3.00 h, times give 2.50 h",
      [F.raisedAt]: NOW,
      [F.reviewed]: false,
      [F.source]: "log check",
      [F.logRow]: 2,
    },
  ]);
  const { newRows, ...counts } = plan;
  assert.equal(newRows.length, 1);
  assert.deepEqual(counts, {
    found: 1,
    already: 0,
    flagged: 1,
    left: 0,
    byLabel: { "Hours don't match the times": 1 },
  });
});

test("logCheckPlan: an empty Log gives every field, zero", () => {
  assert.deepEqual(plain(L.logCheckPlan([], [], NOW, 100)), {
    newRows: [],
    found: 0,
    already: 0,
    flagged: 0,
    left: 0,
    byLabel: {},
  });
});

test("logCheckPlan: within one run, only the first problem per key", () => {
  // Two no-ID rows with the same Date and name share their keys.
  const rows = [
    shift({ shiftId: "", name: "Ann Lee" }),
    shift({ shiftId: "", name: " ann  lee " }),
    shift({ shiftId: "", name: "Bo" }),
  ];
  const problems = L.logCheckProblems(entriesFor(rows), clock, NOW);
  assert.equal(problems.length, 3);
  const plan = plain(L.logCheckPlan(problems, [], NOW, 100));
  assert.deepEqual(
    plan.newRows.map((m) => [m[F.name], m[F.shiftId], m[F.logRow]]),
    [
      ["Ann Lee", "(no Shift ID)", 2],
      ["Bo", "(no Shift ID)", 4],
    ],
  );
  assert.equal(plan.found, 2);
  assert.deepEqual(plan.byLabel, { "No Shift ID": 2 });
});

test("logCheckPlan: a key already on the tab isn't raised again, Reviewed or not", () => {
  const rows = [shift({ statedHours: 3 }), shift({ shiftId: "" }), shift({ status: "x" })];
  const problems = L.logCheckProblems(entriesFor(rows), clock, NOW);
  const first = plain(L.logCheckPlan(problems, [], NOW, 100));
  assert.equal(first.flagged, 3);
  const tab = first.newRows.map((m, i) => readBack(m, i === 0));
  tab.push({
    date: "2026-11-12",
    name: "Ann Lee",
    shiftId: "s2",
    reason: "long shift",
    source: "kiosk check-out",
  });
  const second = plain(L.logCheckPlan(problems, tab, NOW + 86400000, 100));
  assert.deepEqual(
    { ...second, newRows: second.newRows.length },
    {
      newRows: 0,
      found: 3,
      already: 3,
      flagged: 0,
      left: 0,
      byLabel: {
        "No Shift ID": 1,
        "Status isn't open or closed": 1,
        "Hours don't match the times": 1,
      },
    },
  );
  // Staff deleted one: the next run raises it again.
  const third = plain(L.logCheckPlan(problems, tab.slice(1), NOW, 100));
  assert.equal(third.flagged, 1);
  assert.equal(third.newRows[0][F.reason], first.newRows[0][F.reason]);
});

test("logCheckPlan: at most max new rows; the rest are left for the next run", () => {
  const rows = Array.from({ length: 5 }, () => shift({ statedHours: 9 }));
  const problems = L.logCheckProblems(entriesFor(rows), clock, NOW);
  const first = plain(L.logCheckPlan(problems, [], NOW, 2));
  assert.deepEqual([first.found, first.already, first.flagged, first.left], [5, 0, 2, 3]);
  assert.deepEqual(
    first.newRows.map((m) => m[F.logRow]),
    [2, 3],
  );
  const second = plain(
    L.logCheckPlan(
      problems,
      first.newRows.map((m) => readBack(m)),
      NOW,
      2,
    ),
  );
  assert.deepEqual([second.found, second.already, second.flagged, second.left], [5, 2, 2, 1]);
  assert.deepEqual(
    second.newRows.map((m) => m[F.logRow]),
    [4, 5],
  );
  // With max 0 and no Flags read (the kiosk was busy), found and byLabel still count.
  const busy = plain(L.logCheckPlan(problems, [], 0, 0));
  assert.deepEqual([busy.found, busy.flagged, busy.left], [5, 0, 5]);
  assert.deepEqual(busy.byLabel, { "Hours don't match the times": 5 });
  // No max given: logCheckMaxNewFlags().
  assert.equal(plain(L.logCheckPlan(problems, [], NOW)).flagged, 5);
});

test("logCheckPlan: byLabel follows the order of the codes", () => {
  const rows = [shift({ statedHours: 9 }), shift({ status: "x" }), shift({ shiftId: "" })];
  const plan = plain(
    L.logCheckPlan(L.logCheckProblems(entriesFor(rows), clock, NOW), [], NOW, 100),
  );
  assert.deepEqual(Object.keys(plan.byLabel), [
    "No Shift ID",
    "Status isn't open or closed",
    "Hours don't match the times",
  ]);
});

// ---------------------------------------------------------------------------
// The message staff see

/** A Result with every field, as the run gives it. */
const result = (o) => ({
  kind: "done",
  checked: 0,
  found: 0,
  already: 0,
  flagged: 0,
  left: 0,
  byLabel: {},
  ms: 1200,
  message: "",
  ...o,
});

test("logCheckMessage: a run that found nothing", () => {
  assert.equal(
    L.logCheckMessage(result({ checked: 20000 })),
    "Checked 20000 Log rows: no problems found.",
  );
  assert.equal(L.logCheckMessage(result({ checked: 1 })), "Checked 1 Log row: no problems found.");
});

test("logCheckMessage: a run that found problems, with a line per label in code order", () => {
  const byLabel = {
    "Hours don't match the times": 2,
    "No Shift ID": 1,
    "Impossible shift length": 0,
  };
  assert.equal(
    L.logCheckMessage(result({ checked: 40, found: 3, already: 1, flagged: 2, byLabel })),
    "Checked 40 Log rows: found 3 problems. 2 flagged now on the Flags tab, 1 already flagged.\n" +
      "  No Shift ID: 1\n" +
      "  Hours don't match the times: 2",
  );
  assert.equal(
    L.logCheckMessage(
      result({
        checked: 400,
        found: 130,
        already: 0,
        flagged: 100,
        left: 30,
        byLabel: { "No Shift ID": 130 },
      }),
    ),
    "Checked 400 Log rows: found 130 problems. 100 flagged now on the Flags tab, 0 already flagged, " +
      "30 more will be flagged next run.\n  No Shift ID: 130",
  );
  assert.equal(
    L.logCheckMessage(result({ checked: 2, found: 1, already: 1, byLabel: { "No Shift ID": 1 } })),
    "Checked 2 Log rows: found 1 problem. 0 flagged now on the Flags tab, 1 already flagged.\n  No Shift ID: 1",
  );
});

test("logCheckMessage: busy and failed runs", () => {
  assert.equal(
    L.logCheckMessage(
      result({ kind: "busy", checked: 10, found: 2, byLabel: { "No Shift ID": 2 } }),
    ),
    "The kiosk was busy, so nothing was flagged. Try again in a minute.",
  );
  assert.equal(
    L.logCheckMessage(result({ kind: "failed", message: "The Log tab is missing." })),
    "The Log check failed: The Log tab is missing.",
  );
});
