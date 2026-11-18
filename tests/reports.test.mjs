// Tests for the reports block of apps-script/Logic.js: which Log rows count, every
// calculation of a month's report, the frozen report tab's cells, and the texts
// setupReports writes. Logic.js is loaded the way Apps Script loads it, one plain script in
// its own global scope, so results are compared through plain().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { GOLDEN_LOGS, GOLDEN_MADE, goldenEntries } from "./report-golden-logs.mjs";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(
  readFileSync(new URL("apps-script/Brand.js", root), "utf8") +
    "\n" +
    readFileSync(new URL("apps-script/Logic.js", root), "utf8"),
  L,
);

const plain = (x) => JSON.parse(JSON.stringify(x));
const H = plain(L.logHeaderNames());
const HEADER = plain(L.logHeaders());

const centralDate = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

/** A Central wall-clock time as milliseconds read as UTC, to compare wall clocks. */
const centralWall = (ms) => {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(ms))
    .forEach((x) => (p[x.type] = x.value));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
};

/**
 * Sheets.js's timeOnDate_: a Central "HH:mm" on a yyyy-MM-dd as {ms, date}. Daylight time
 * is tried before standard time; a time skipped when daylight time starts takes standard
 * time, the next valid time, as Utilities.parseDate does.
 */
const timeOnDate = (dateText, clock) => {
  const text = L.adminDateTimeText(dateText, clock);
  if (!text) return { ms: NaN, date: "" };
  const wall = Date.parse(text.replace(" ", "T") + ":00Z");
  const found = [5, 6].map((o) => wall + o * 3600000).find((t) => centralWall(t) === wall);
  const ms = found === undefined ? wall + 6 * 3600000 : found;
  return { ms, date: centralDate(ms) };
};

// read.text, read.time and read.at as Sheets.js gives them: times here are ISO texts, a
// typed time of day, or Dates.
const READ = {
  text: (v) => L.cellString(v),
  time: (v) => {
    const none = { ms: NaN, date: "", clock: "" };
    if (Object.prototype.toString.call(v) === "[object Date]") {
      const ms = v.getTime();
      if (!isFinite(ms)) return none;
      return {
        ms,
        date: centralDate(ms),
        clock: new Date(centralWall(ms)).toISOString().slice(11, 16),
      };
    }
    const clock = L.clockText(v);
    if (clock) return { ms: NaN, date: "", clock };
    const ms = L.cellString(v) ? Date.parse(String(v)) : NaN;
    return isFinite(ms) ? { ms, date: centralDate(ms), clock: "" } : none;
  },
  at: timeOnDate,
};

/** A Central time on a date, as the ISO text READ.time reads (Central is UTC-6 in Nov, -5 in Oct). */
const at = (date, hhmm) => {
  const offset = date < "2026-11-01" ? "-05:00" : "-06:00";
  return date + "T" + hhmm + ":00" + offset;
};

/** A Log row's cells under header, from a map of short header keys to values. */
function cellsFor(values, header = HEADER) {
  return header.map((h) => {
    const key = Object.keys(H).find((k) => L.normalizeHeader(H[k]) === L.normalizeHeader(h));
    return key && values[key] !== undefined ? values[key] : "";
  });
}

/** Log rows (row 2 on) as report entries under header. */
function entriesFor(rows, header = HEADER) {
  const cols = L.reportColumns(header);
  return rows.map((values, i) => L.reportEntry(cellsFor(values, header), i + 2, cols, READ));
}

/** A kiosk shift: tapped and stated alike unless given. */
function kioskShift(date, name, token, inAt, outAt, extra = {}) {
  return {
    date,
    day: L.weekdayName(date),
    name,
    token,
    status: "closed",
    recordedIn: at(date, inAt),
    statedIn: at(date, inAt),
    recordedOut: at(date, outAt),
    statedOut: at(date, outAt),
    inBy: "kiosk",
    outBy: "kiosk",
    shiftId: "s-" + date + "-" + token + "-" + inAt,
    ...extra,
  };
}

// The worked example: November 2026, rows 2 to 7.
const SAMPLE = [
  kioskShift("2026-10-28", "Ben Ott", "tB", "09:00", "12:00", {
    recordedHours: 3,
    statedHours: 3,
  }),
  kioskShift("2026-11-02", "Ana Ruiz", "tA", "09:00", "12:00", {
    recordedHours: 3,
    statedHours: 3,
    activity: "Pantry",
  }),
  kioskShift("2026-11-04", "Ben Ott", "tB", "10:00", "12:30", {
    recordedIn: at("2026-11-04", "10:24"),
    recordedHours: 2.1,
    statedHours: 2.5,
    alerts: "arrival differs by 24 min",
  }),
  {
    date: "2026-11-04",
    name: "Ana Ruiz",
    token: "tA",
    status: "closed",
    statedIn: at("2026-11-04", "13:00"),
    statedOut: at("2026-11-04", "17:00"),
    statedHours: 4,
    inBy: "JP",
    outBy: "JP",
    shiftId: "s5",
  },
  {
    date: "2026-11-09",
    name: "Cal Diaz",
    token: "tC",
    status: "closed",
    recordedIn: at("2026-11-09", "13:00"),
    statedIn: at("2026-11-09", "13:00"),
    statedOut: at("2026-11-09", "15:00"),
    statedHours: 2,
    inBy: "kiosk",
    outBy: "MK",
    shiftId: "s6",
  },
  {
    date: "2026-11-10",
    name: "Ben Ott",
    token: "tB",
    status: "open",
    recordedIn: at("2026-11-10", "09:00"),
    statedIn: at("2026-11-10", "09:00"),
    inBy: "kiosk",
    shiftId: "s7",
  },
];

const sampleReport = (rate = 3479) => plain(L.monthReport(entriesFor(SAMPLE), "2026-11", rate));

// ---------------------------------------------------------------------------
// The sample's twelve calculations

test("total stated hours, shifts and headcount", () => {
  const r = sampleReport();
  assert.equal(r.hundredths, 1150);
  assert.equal(r.shifts, 4);
  assert.equal(r.headcount, 3);
});

test("hours and shifts per volunteer, by label, adding to the total", () => {
  const r = sampleReport();
  assert.deepEqual(r.volunteers, [
    { label: "Ana Ruiz", shifts: 2, hundredths: 700 },
    { label: "Ben Ott", shifts: 1, hundredths: 250 },
    { label: "Cal Diaz", shifts: 1, hundredths: 200 },
  ]);
  assert.equal(
    r.volunteers.reduce((s, v) => s + v.hundredths, 0),
    r.hundredths,
  );
});

test("new volunteers are those whose first counted shift is in the month", () => {
  assert.deepEqual(sampleReport().newVolunteers, ["Ana Ruiz", "Cal Diaz"]);
});

test("average shift, half up, and none with no shifts", () => {
  assert.equal(sampleReport().averageHundredths, 288);
  assert.equal(plain(L.monthReport(entriesFor(SAMPLE), "2026-09", 3479)).averageHundredths, null);
});

test("hours and shifts by weekday, Monday to Sunday", () => {
  const w = sampleReport().weekdays;
  assert.deepEqual(
    w.map((d) => d.day),
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  );
  assert.deepEqual(w[0], { day: "Monday", shifts: 2, hundredths: 500 });
  assert.deepEqual(w[2], { day: "Wednesday", shifts: 2, hundredths: 650 });
  for (const i of [1, 3, 4, 5, 6]) assert.deepEqual([w[i].shifts, w[i].hundredths], [0, 0]);
});

test("hours by Role/Type and by Activity, blanks as (not set) and last", () => {
  const r = sampleReport();
  assert.deepEqual(r.roleType, {
    columnMissing: false,
    groups: [{ label: "(not set)", shifts: 4, hundredths: 1150 }],
  });
  assert.deepEqual(r.activity, {
    columnMissing: false,
    groups: [
      { label: "Pantry", shifts: 1, hundredths: 300 },
      { label: "(not set)", shifts: 3, hundredths: 850 },
    ],
  });
});

test("groups ignore case and spacing at the ends, labelled by the earliest row's spelling", () => {
  const rows = [
    kioskShift("2026-11-03", "A", "t1", "09:00", "10:00", { statedHours: 1, activity: " pantry " }),
    kioskShift("2026-11-02", "B", "t2", "09:00", "10:00", { statedHours: 1, activity: "Pantry" }),
    kioskShift("2026-11-04", "C", "t3", "09:00", "10:00", { statedHours: 1, activity: "Admin" }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(r.activity.groups, [
    { label: "Admin", shifts: 1, hundredths: 100 },
    { label: "Pantry", shifts: 2, hundredths: 200 },
  ]);
});

test("a Log with no Role/Type or Activity column says so, every row (not set)", () => {
  const header = HEADER.filter((h) => h !== H.role && h !== H.activity);
  const cols = L.reportColumns(header);
  assert.equal(cols[H.role], -1);
  assert.equal(cols[H.activity], -1);
  const r = plain(L.monthReport(entriesFor(SAMPLE, header), "2026-11", 3479, cols));
  assert.deepEqual(r.roleType, {
    columnMissing: true,
    groups: [{ label: "(not set)", shifts: 4, hundredths: 1150 }],
  });
  assert.equal(r.activity.columnMissing, true);
  const { values } = plain(L.reportRows(r, "2026-11", "JP", "2026-12-01 9:14 AM"));
  const text = values.flat().join("\n");
  assert.match(text, /Hours by Role\/Type \(no Role\/Type column\)/);
  assert.match(text, /Hours by Activity \(no Activity column\)/);
});

test("adjustments compare kiosk rows only", () => {
  assert.deepEqual(sampleReport().adjustments, {
    compared: 2,
    adjusted: 1,
    statedMinusRecordedHundredths: 40,
  });
});

test("adjusted means the gap rounds to a minute or more, the arrival flag's rule", () => {
  const withGap = (seconds) => {
    const row = kioskShift("2026-11-02", "A", "t1", "10:00", "12:00", {
      recordedHours: 2,
      statedHours: 2,
    });
    row.recordedIn = new Date(Date.parse(at("2026-11-02", "10:00")) + seconds * 1000).toISOString();
    return plain(L.monthReport(entriesFor([row]), "2026-11", null)).adjustments.adjusted;
  };
  assert.equal(withGap(40), 1, "a tap at 10:00:40 with 10:00 stated rounds to 1 minute");
  assert.equal(withGap(30), 1, "30 seconds rounds up to 1 minute");
  assert.equal(withGap(29), 0, "29 seconds rounds to 0");
  assert.equal(withGap(0), 0);
  // The arrival flag rounds the same gap the same way.
  const base = Date.parse(at("2026-11-02", "10:00"));
  assert.equal(L.arrivalFlag(base + 30000, base, 0), "arrival differs by 1 min");
  assert.equal(L.arrivalFlag(base + 29000, base, 0), "");
});

test("a counted kiosk row whose Check-In Stated was typed as a time alone is compared", () => {
  // Sheets keeps "9:15 AM" typed into the cell as 9:15 on 1899-12-30.
  const typed = new Date(timeOnDate("1899-12-30", "09:15").ms);
  const row = kioskShift("2026-11-16", "Ana Ruiz", "tA", "09:00", "12:00", {
    statedIn: typed,
    recordedHours: 3,
    statedHours: 2.75,
  });
  const [e] = entriesFor([row]);
  assert.equal(e.statedInMs, Date.parse(at("2026-11-16", "09:15")));
  const adjustments = (entries) => plain(L.monthReport(entries, "2026-11", null)).adjustments;
  assert.deepEqual(adjustments([e]), {
    compared: 1,
    adjusted: 1,
    statedMinusRecordedHundredths: -25,
  });
  // Typed as text in a plain-text cell, it reads the same.
  assert.deepEqual(adjustments(entriesFor([{ ...row, statedIn: "9:15 AM" }])), adjustments([e]));
  // A read that can't put a time on the row's Date leaves the row out, as before.
  const noAt = { text: READ.text, time: READ.time };
  const old = L.reportEntry(cellsFor(row), 2, L.reportColumns(HEADER), noAt);
  assert.deepEqual(adjustments([old]), {
    compared: 0,
    adjusted: 0,
    statedMinusRecordedHundredths: 0,
  });
});

test("rows to review, open rows first, and the open-shift line", () => {
  const r = sampleReport();
  assert.equal(r.openCount, 1);
  assert.deepEqual(
    r.review.map((g) => g.id),
    ["open", "flagged", "admin", "status", "source", "hours", "noToken", "noDate"],
  );
  const rows = Object.fromEntries(r.review.map((g) => [g.id, g.rows]));
  assert.deepEqual(rows.open, [
    { row: 7, date: "2026-11-10", name: "Ben Ott", status: "open", detail: "" },
  ]);
  assert.deepEqual(
    rows.flagged.map((x) => [x.row, x.detail]),
    [[4, "arrival differs by 24 min"]],
  );
  assert.deepEqual(
    rows.admin.map((x) => [x.row, x.detail]),
    [
      [5, "in JP, out JP"],
      [6, "out MK"],
    ],
  );
  for (const id of ["status", "source", "hours", "noToken", "noDate"]) {
    assert.deepEqual(rows[id], [], id);
  }
  assert.equal(
    L.openShiftsLine(1),
    "1 open shift in this month is not counted. Close it with Fix a sign-out, then make the report again.",
  );
  assert.equal(
    L.openShiftsLine(3),
    "3 open shifts in this month are not counted. Close them with Fix a sign-out, then make the report again.",
  );
  assert.equal(L.openShiftsLine(0), "");
});

test("an open row adds to no figure", () => {
  const r = sampleReport();
  assert.equal(r.volunteers.find((v) => v.label === "Ben Ott").shifts, 1);
  const without = plain(L.monthReport(entriesFor(SAMPLE.slice(0, 5)), "2026-11", 3479));
  for (const key of ["hundredths", "shifts", "headcount", "averageHundredths"]) {
    assert.equal(r[key], without[key], key);
  }
  assert.deepEqual(r.yearToDate, without.yearToDate);
});

test("year to date", () => {
  assert.deepEqual(sampleReport().yearToDate, { hundredths: 1450, shifts: 5, headcount: 3 });
  assert.equal(sampleReport().yearStart, "2026-01");
});

test("no milestone in the sample", () => {
  assert.deepEqual(sampleReport().milestones, []);
});

test("volunteer value in whole cents, half up", () => {
  assert.deepEqual(sampleReport().value, { rateCents: 3479, cents: 40009, message: "" });
});

test("a blank rate and an unreadable rate print different messages", () => {
  const blank = sampleReport(L.parseMoneyCents("")).value;
  assert.deepEqual(blank, {
    rateCents: null,
    cents: null,
    message: "Set Volunteer hour value in Settings",
  });
  const unreadable = sampleReport(L.parseMoneyCents("about 30")).value;
  assert.equal(unreadable.cents, null);
  assert.equal(
    unreadable.message,
    "The Volunteer hour value in Settings can't be read. Enter a dollar amount such as 34.79.",
  );
  assert.notEqual(unreadable.message, blank.message);
});

test("month over month against October", () => {
  const r = sampleReport();
  assert.equal(r.previousMonth, "2026-10");
  assert.deepEqual(
    r.monthOverMonth.map((x) => [x.id, x.current, x.previous, x.change, x.percent]),
    [
      ["hours", 1150, 300, 850, "+283.3%"],
      ["shifts", 4, 1, 3, "+300.0%"],
      ["headcount", 3, 1, 2, "+200.0%"],
      ["newVolunteers", 2, 1, 1, "+100.0%"],
    ],
  );
});

test("a zero month before gives n/a", () => {
  const r = plain(L.monthReport(entriesFor(SAMPLE), "2026-10", 3479));
  assert.equal(r.previousMonth, "2026-09");
  assert.deepEqual(
    r.monthOverMonth.map((x) => x.percent),
    ["n/a", "n/a", "n/a", "n/a"],
  );
});

test("percentChange: one decimal, half away from zero, n/a over zero", () => {
  assert.equal(L.percentChange(850, 300), "+283.3%");
  assert.equal(L.percentChange(-1, 400), "-0.3%", "-0.25% rounds away from zero");
  assert.equal(L.percentChange(1, 400), "+0.3%");
  assert.equal(L.percentChange(-1, 8), "-12.5%");
  assert.equal(L.percentChange(-3, 4), "-75.0%");
  assert.equal(L.percentChange(1, 3), "+33.3%");
  assert.equal(L.percentChange(-2, 3), "-66.7%");
  assert.equal(L.percentChange(0, 5), "0.0%");
  assert.equal(L.percentChange(1, 30000), "0.0%");
  assert.equal(L.percentChange(5, 0), "n/a");
});

// ---------------------------------------------------------------------------
// The definitions

test("monthKey", () => {
  assert.equal(L.monthKey("2026-11-12"), "2026-11");
  assert.equal(L.monthKey(" 2026-11-12 "), "2026-11");
  assert.equal(L.monthKey("11/12/2026"), "");
  assert.equal(L.monthKey("2026-02-30"), "");
  assert.equal(L.monthKey("2026-11-12 10:00"), "");
  assert.equal(L.monthKey(""), "");
});

test("previousMonth and monthName", () => {
  assert.equal(L.previousMonth("2026-11"), "2026-10");
  assert.equal(L.previousMonth("2026-01"), "2025-12");
  assert.equal(L.monthName("2026-11"), "November 2026");
});

test("isCountedRow", () => {
  const e = (status, token) => ({ status, token });
  assert.equal(L.isCountedRow(e("closed", "t")), true);
  assert.equal(L.isCountedRow(e("Closed ", "t")), true);
  assert.equal(L.isCountedRow(e("closed", "")), false);
  assert.equal(L.isCountedRow(e("open", "t")), false);
  assert.equal(L.isCountedRow(e("auto-closed", "t")), false);
});

test("entrySource: one case rule, kiosk before initials", () => {
  assert.equal(L.entrySource("kiosk"), "kiosk");
  assert.equal(L.entrySource("KIOSK"), "kiosk", "five letters, but the kiosk");
  assert.equal(L.entrySource(" Kiosk "), "kiosk");
  assert.equal(L.entrySource("JP"), "initials");
  assert.equal(L.entrySource("jp"), "initials", "initials typed in lower case");
  assert.equal(L.entrySource("ABCDE"), "initials");
  assert.equal(L.entrySource("ABCDEF"), "other");
  assert.equal(L.entrySource("J.P."), "other");
  assert.equal(L.entrySource(""), "typed");
  assert.equal(L.entrySource("auto-close"), "other");
});

test("a blank Check-Out Entered By is typed on a closed row, not on an open one", () => {
  assert.equal(L.checkOutSource({ status: "open", outBy: "" }), "pending");
  assert.equal(L.checkOutSource({ status: "closed", outBy: "" }), "typed");
  assert.equal(L.checkOutSource({ status: "closed", outBy: "MK" }), "initials");
  const [openRow, closedRow] = entriesFor([
    { date: "2026-11-02", name: "A", token: "t1", status: "open", inBy: "kiosk", shiftId: "a" },
    {
      date: "2026-11-02",
      name: "B",
      token: "t2",
      status: "closed",
      inBy: "kiosk",
      shiftId: "b",
      statedHours: 1,
    },
  ]);
  const groups = plain(L.reviewGroups([openRow, closedRow], "2026-11"));
  const source = groups.find((g) => g.id === "source").rows;
  assert.deepEqual(
    source.map((r) => [r.row, r.detail]),
    [[3, "out typed into the sheet"]],
  );
});

test("reportHundredths", () => {
  assert.equal(L.reportHundredths(2.5), 250);
  assert.equal(L.reportHundredths("2.5"), 250);
  assert.equal(L.reportHundredths(""), 0);
  assert.equal(L.reportHundredths("n/a"), 0);
  assert.equal(L.reportHundredths(-1), 0);
  assert.equal(L.reportHundredths(2.499), 250);
  assert.equal(L.reportHundredths(null), 0);
});

test("parseMoneyCents: cents, null when blank, NaN when unreadable", () => {
  assert.equal(L.parseMoneyCents("34.79"), 3479);
  assert.equal(L.parseMoneyCents("$1,234.5"), 123450);
  assert.equal(L.parseMoneyCents(" 34 "), 3400);
  assert.ok(Number.isNaN(L.parseMoneyCents("34.795")));
  assert.ok(Number.isNaN(L.parseMoneyCents("abc")));
  assert.ok(Number.isNaN(L.parseMoneyCents("-5")));
  assert.ok(Number.isNaN(L.parseMoneyCents("$")));
  assert.equal(L.parseMoneyCents(""), null);
  assert.equal(L.parseMoneyCents("  "), null);
});

test("reportEntry adds the Entered By texts, Role/Type, Activity and the raw hours cells", () => {
  const [e] = entriesFor([
    {
      ...SAMPLE[2],
      role: "Driver",
      activity: "Pantry",
      statedHours: "2.5",
      recordedHours: 2.1,
    },
  ]);
  const x = plain(e);
  assert.equal(x.inBy, "kiosk");
  assert.equal(x.outBy, "kiosk");
  assert.equal(x.roleType, "Driver");
  assert.equal(x.activity, "Pantry");
  assert.equal(x.statedHoursCell, "2.5");
  assert.equal(x.recordedHoursCell, 2.1);
  assert.equal(x.statedHours, 2.5);
  assert.equal(x.recordedOutMs, Date.parse(at("2026-11-04", "12:30")));
});

// ---------------------------------------------------------------------------
// Review groups

test("review: an auto-closed Status is listed and not counted", () => {
  const rows = [
    kioskShift("2026-11-02", "A", "t1", "09:00", "10:00", {
      status: "auto-closed",
      statedHours: 1,
    }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.equal(r.shifts, 0);
  assert.deepEqual(
    r.review.find((g) => g.id === "status").rows.map((x) => [x.row, x.status]),
    [[2, "auto-closed"]],
  );
});

test("review: a closed row entered out by auto-close is counted and listed", () => {
  const rows = [
    kioskShift("2026-11-02", "A", "t1", "09:00", "10:00", { outBy: "auto-close", statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.equal(r.shifts, 1);
  assert.deepEqual(
    r.review.find((g) => g.id === "source").rows.map((x) => [x.row, x.detail]),
    [[2, 'out "auto-close"']],
  );
});

test("review: a closed row with no token is listed and not counted", () => {
  const rows = [kioskShift("2026-11-02", "A", "", "09:00", "10:00", { statedHours: 1 })];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.equal(r.shifts, 0);
  assert.deepEqual(
    r.review.find((g) => g.id === "noToken").rows.map((x) => x.row),
    [2],
  );
});

test("review: counted rows with blank, text or negative stated hours", () => {
  const rows = [
    kioskShift("2026-11-02", "A", "t1", "09:00", "10:00", { statedHours: "" }),
    kioskShift("2026-11-03", "A", "t1", "09:00", "10:00", { statedHours: "2.5" }),
    kioskShift("2026-11-04", "A", "t1", "09:00", "10:00", { statedHours: -1 }),
    kioskShift("2026-11-05", "A", "t1", "09:00", "10:00", { statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.equal(r.shifts, 4);
  assert.equal(r.hundredths, 350, "the text 2.5 adds 2.50, the negative adds 0");
  assert.deepEqual(
    r.review.find((g) => g.id === "hours").rows.map((x) => [x.row, x.detail]),
    [
      [2, "stated hours blank"],
      [3, 'stated hours "2.5"'],
      [4, 'stated hours "-1"'],
    ],
  );
});

test("review: rows anywhere with an unreadable Date, but not empty rows", () => {
  const rows = [
    kioskShift("2026-11-02", "A", "t1", "09:00", "10:00", { statedHours: 1 }),
    { date: "11/02/2026", name: "B", token: "t2", status: "closed", shiftId: "x", statedHours: 1 },
    {},
    { date: "", name: "C", status: "open" },
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2025-01", null));
  assert.deepEqual(
    r.review.find((g) => g.id === "noDate").rows.map((x) => [x.row, x.date]),
    [
      [3, "11/02/2026"],
      [5, ""],
    ],
  );
});

// ---------------------------------------------------------------------------
// Undated counted rows are left out of every ordering

test("an undated counted row doesn't make a volunteer old, or move a milestone", () => {
  const rows = [
    {
      date: "11/02/2026",
      name: "Xi Lo",
      token: "tX",
      status: "closed",
      statedHours: 60,
      shiftId: "u",
    },
    kioskShift("2026-11-09", "Xi Lo", "tX", "09:00", "11:00", { statedHours: 2 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(r.newVolunteers, ["Xi Lo"], "the first dated shift is 2026-11-09");
  assert.deepEqual(r.milestones, [], "the undated 60 hours are not walked");
  assert.equal(r.shifts, 1, "an undated row is in no month");
  assert.deepEqual(
    r.review.find((g) => g.id === "noDate").rows.map((x) => x.row),
    [2],
  );
});

test("an undated counted row doesn't set the first-shift date in a label", () => {
  const rows = [
    {
      date: "10/01/2026",
      name: "Ana Ruiz",
      token: "t1",
      status: "closed",
      statedHours: 1,
      shiftId: "u",
    },
    kioskShift("2026-11-03", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-04", "Ana Ruiz", "t2", "09:00", "10:00", { statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(
    r.volunteers.map((v) => v.label),
    ["Ana Ruiz · first shift 2026-11-03", "Ana Ruiz · first shift 2026-11-04"],
  );
});

// ---------------------------------------------------------------------------
// Volunteer labels

test("same-name labels get the first-shift date; one token with two spellings doesn't", () => {
  const rows = [
    kioskShift("2026-10-05", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-03", "ana  ruiz", "t2", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-04", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-05", "Bo Li", "t3", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-06", "Bo Lee", "t3", "09:00", "10:00", { statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(
    r.volunteers.map((v) => v.label),
    ["Ana Ruiz · first shift 2026-10-05", "ana  ruiz · first shift 2026-11-03", "Bo Lee"],
  );
});

test("same-name labels whose first shifts share a date add the earlier Log row", () => {
  const rows = [
    kioskShift("2026-11-03", "Ana Ruiz", "t9", "13:00", "14:00", { statedHours: 1 }),
    kioskShift("2026-11-03", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(
    r.volunteers.map((v) => v.label),
    [
      "Ana Ruiz · first shift 2026-11-03, Log row 2",
      "Ana Ruiz · first shift 2026-11-03, Log row 3",
    ],
  );
});

test("the label is the name on the latest counted row in the month, by date then start", () => {
  const rows = [
    kioskShift("2026-11-04", "Ana Ruiz", "t1", "13:00", "14:00", { statedHours: 1 }),
    kioskShift("2026-11-04", "Ana Ruis", "t1", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-11-02", "Anna Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
  ];
  const r = plain(L.monthReport(entriesFor(rows), "2026-11", null));
  assert.deepEqual(
    r.volunteers.map((v) => [v.label, v.shifts]),
    [["Ana Ruiz", 3]],
  );
});

// ---------------------------------------------------------------------------
// Milestones

/** Dee Fox: 9 counted shifts and 48.00 hours before 2026-11-06, then 2.50 hours. */
function deeFox(lastDate) {
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const date = "2026-10-" + String(i).padStart(2, "0");
    rows.push(
      kioskShift(date, "Dee Fox", "tD", "09:00", "14:00", { statedHours: i === 9 ? 8 : 5 }),
    );
  }
  rows.push(kioskShift(lastDate, "Dee Fox", "tD", "09:00", "11:30", { statedHours: 2.5 }));
  return rows;
}

test("milestonesCrossedIn lists every milestone the month's row reaches", () => {
  const crossed = plain(L.milestonesCrossedIn(entriesFor(deeFox("2026-11-06")), "2026-11"));
  assert.deepEqual(
    crossed.map((c) => [c.title, c.date, c.row]),
    [
      ["10 shifts", "2026-11-06", 11],
      ["50 hours", "2026-11-06", 11],
    ],
  );
  const r = plain(L.monthReport(entriesFor(deeFox("2026-11-06")), "2026-11", null));
  assert.deepEqual(r.milestones, [
    { label: "Dee Fox", title: "10 shifts", date: "2026-11-06", row: 11 },
    { label: "Dee Fox", title: "50 hours", date: "2026-11-06", row: 11 },
  ]);
});

test("milestonesCrossedIn lists none when the crossing row is in another month", () => {
  assert.deepEqual(plain(L.milestonesCrossedIn(entriesFor(deeFox("2026-10-20")), "2026-11")), []);
});

test("milestonesCrossedIn walks by date, not by Log row, and never lists the first shift", () => {
  // The November row sits first in the Log, but nine October rows come before it by date.
  const rows = deeFox("2026-11-06");
  rows.unshift(rows.pop());
  const crossed = plain(L.milestonesCrossedIn(entriesFor(rows), "2026-11"));
  assert.deepEqual(
    crossed.map((c) => [c.title, c.row]),
    [
      ["10 shifts", 2],
      ["50 hours", 2],
    ],
  );
  const one = [kioskShift("2026-11-02", "New Person", "tN", "09:00", "10:00", { statedHours: 1 })];
  assert.deepEqual(plain(L.milestonesCrossedIn(entriesFor(one), "2026-11")), []);
});

// ---------------------------------------------------------------------------
// The report tab

test("reportRows: rectangular, formats the same shape, no token anywhere", () => {
  const rows = SAMPLE.map((r) => ({ ...r, token: "tok-" + r.token + "-secret" }));
  const report = L.monthReport(entriesFor(rows), "2026-11", 3479);
  const { values, formats } = plain(L.reportRows(report, "2026-11", "JP", "2026-12-01 9:14 AM"));
  assert.ok(values.length > 10);
  const width = values[0].length;
  assert.ok(values.every((r) => r.length === width));
  assert.equal(formats.length, values.length);
  assert.ok(formats.every((r) => r.length === width));
  const all = JSON.stringify(values) + JSON.stringify(plain(report));
  assert.ok(!/secret/.test(all), "no User Token in the report or its cells");
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < width; j++) {
      if (typeof values[i][j] === "string") assert.equal(formats[i][j], "@", values[i][j]);
    }
  }
});

test("reportRows: says which row is the title, a section, a table header, blank or a plain row", () => {
  const { values, kinds } = plain(
    L.reportRows(sampleReport(), "2026-11", "JP", "2026-12-01 9:14 AM"),
  );
  assert.equal(kinds.length, values.length);
  const allowed = ["title", "section", "header", "blank", "body"];
  assert.ok(
    kinds.every((k) => allowed.includes(k)),
    JSON.stringify(kinds),
  );
  assert.equal(kinds[0], "title");
  assert.equal(kinds.filter((k) => k === "title").length, 1);
  const first = (kind) => values.filter((r, i) => kinds[i] === kind).map((r) => r[0]);
  const sections = first("section");
  for (const name of [
    "Summary",
    "Month over month",
    "Year to date",
    "Hours per volunteer",
    "Hours by weekday",
    "Milestones crossed this month",
    "Rows to review",
  ]) {
    assert.ok(sections.includes(name), name);
  }
  assert.ok(sections.some((s) => s.startsWith("Hours by Role/Type")));
  assert.ok(sections.some((s) => s.startsWith("Hours by Activity")));
  // Each table's header row follows its section title.
  kinds.forEach((k, i) => {
    if (k === "section" && ["Hours per volunteer", "Hours by weekday"].includes(values[i][0])) {
      assert.equal(kinds[i + 1], "header", values[i][0]);
    }
  });
  assert.ok(first("header").includes("Volunteer"));
  values.forEach((r, i) => {
    if (kinds[i] === "blank")
      assert.ok(
        r.every((c) => c === ""),
        String(i),
      );
  });
});

test("reportRows: first lines say what it counts, who made it, and the open shifts", () => {
  const { values, formats } = plain(
    L.reportRows(sampleReport(), "2026-11", "JP", "2026-12-01 9:14 AM"),
  );
  assert.equal(values[0][0], "Monthly report for November 2026 (2026-11)");
  assert.equal(
    values[1][0],
    "Counts closed shifts with a User Token, using stated hours. Made 2026-12-01 9:14 AM by JP from the Log tab.",
  );
  assert.equal(values[2][0], L.openShiftsLine(1));
  const find = (label) => values.findIndex((r) => r[0] === label);
  const hours = find("Stated hours");
  assert.equal(values[hours][1], 11.5);
  assert.equal(formats[hours][1], "0.00");
  const value = find("Volunteer value");
  assert.equal(values[value][1], 400.09);
  assert.equal(formats[value][1], "$#,##0.00");
  assert.equal(values[value][2], "at $34.79 an hour");
  const mom = values.find((r) => r[0] === "Stated hours" && r[3] === "+8.50");
  assert.deepEqual(mom, ["Stated hours", 11.5, 3, "+8.50", "+283.3%"]);
  assert.deepEqual(
    values.find((r) => r[0] === "Adjusted shifts"),
    ["Adjusted shifts", 1, "of 2 compared", "", ""],
  );
  assert.equal(values.find((r) => r[0] === "Stated minus recorded (hours)")[1], "+0.40");
  assert.ok(values.some((r) => r[0] === "Open shifts, not counted: 1"));
});

test("reportRows: a blank rate prints the message; text that looks like a formula stays text", () => {
  const rows = [
    kioskShift("2026-11-02", "=HYPERLINK(1)", "t1", "09:00", "10:00", { statedHours: 1 }),
  ];
  const report = L.monthReport(entriesFor(rows), "2026-11", null);
  const { values } = plain(L.reportRows(report, "2026-11", "JP", "now"));
  assert.ok(
    values.some(
      (r) => r[0] === "Volunteer value" && r[1] === "Set Volunteer hour value in Settings",
    ),
  );
  assert.ok(values.some((r) => r[0] === "'=HYPERLINK(1)"));
  assert.ok(!values.flat().some((v) => typeof v === "string" && v.startsWith("=")));
});

test("reportRows: each row's kind, for the report tab's look", () => {
  const { values, kinds } = plain(
    L.reportRows(sampleReport(), "2026-11", "JP", "2026-12-01 9:14 AM"),
  );
  assert.equal(kinds.length, values.length);
  assert.ok(kinds.every((k) => ["title", "section", "header", "blank", "body"].includes(k)));
  assert.equal(kinds[0], "title");
  assert.equal(kinds.filter((k) => k === "title").length, 1);
  values.forEach((r, i) => {
    const blankRow = r.every((v) => v === "");
    assert.equal(kinds[i] === "blank", blankRow, "row " + (i + 1));
  });
  const kindOf = (first, second) =>
    kinds[values.findIndex((r) => r[0] === first && (second === undefined || r[1] === second))];
  for (const title of [
    "Summary",
    "Month over month",
    "Year to date",
    "Hours per volunteer",
    "Hours by weekday",
    "Hours by Role/Type",
    "Hours by Activity",
    "Milestones crossed this month",
    "Rows to review",
    "Open shifts, not counted: 1",
  ]) {
    assert.equal(kindOf(title), "section", title);
  }
  assert.equal(kindOf("Volunteer", "Shifts"), "header");
  assert.equal(kindOf("Day", "Shifts"), "header");
  assert.equal(kindOf("Volunteer", "Milestone"), "header");
  assert.equal(kindOf("Date", "Volunteer"), "header");
  assert.equal(kindOf("Stated hours", 11.5), "body");
  assert.equal(kindOf("Total"), "body");
  // The line under the title says what the report counts; it is plain text.
  assert.equal(kinds[1], "body");
});

test("reportTabLook: title, section and header ranges, widths and the tab colour", () => {
  const rows = {
    values: [
      ["Monthly report", "", "", "", ""],
      ["Counts closed shifts", "", "", "", ""],
      ["", "", "", "", ""],
      ["Hours per volunteer", "", "", "", ""],
      ["Volunteer", "Shifts", "Stated hours", "", ""],
      ["Ann Lee", 2, 3.5, "", ""],
      ["Month over month", "November 2026", "October 2026", "Change", "% change"],
    ],
    kinds: ["title", "body", "blank", "section", "header", "body", "section"],
  };
  assert.deepEqual(plain(L.reportTabLook(rows)), {
    styles: [
      { kind: "title", ranges: ["A1"], fontColor: "#062f5a", fontSize: 14, bold: true },
      {
        kind: "section",
        ranges: ["A4:E4", "A7:E7"],
        background: "#dff3fb",
        fontColor: "#062f5a",
        bold: true,
      },
      { kind: "header", ranges: ["A5:C5"], bold: true, bottomBorder: "#062f5a" },
    ],
    widths: [
      { col: 1, px: 230 },
      { col: 2, px: 170 },
      { col: 3, px: 140 },
      { col: 4, px: 110 },
      { col: 5, px: 300 },
    ],
    tabColour: "#0669a9",
  });
  // A kind with no rows gets no style.
  const bare = plain(L.reportTabLook({ values: [["x", ""]], kinds: ["body"] }));
  assert.deepEqual(bare.styles, []);
  assert.deepEqual(
    bare.widths.map((w) => w.col),
    [1, 2],
  );
});

test("hoursText and moneyText", () => {
  assert.equal(L.hoursText(1150), "11.50");
  assert.equal(L.hoursText(40, true), "+0.40");
  assert.equal(L.hoursText(-15, true), "-0.15");
  assert.equal(L.hoursText(0, true), "0.00");
  assert.equal(L.moneyText(4000850), "$40,008.50");
  assert.equal(L.moneyText(3479), "$34.79");
});

test("reportTabName with none, one and two taken", () => {
  assert.equal(L.reportTabName("2026-11", ["Log", "Settings"]), "Report 2026-11");
  assert.equal(L.reportTabName("2026-11", ["Report 2026-11"]), "Report 2026-11 (2)");
  assert.equal(
    L.reportTabName("2026-11", ["Report 2026-11", "report 2026-11 (2)"]),
    "Report 2026-11 (3)",
  );
});

test("reportDownloadUrls are exact and cover the one tab", () => {
  const urls = plain(L.reportDownloadUrls("FILE_id-1", 12345));
  assert.deepEqual(urls, {
    csvUrl: "https://docs.google.com/spreadsheets/d/FILE_id-1/export?format=csv&gid=12345",
    pdfUrl:
      "https://docs.google.com/spreadsheets/d/FILE_id-1/export?format=pdf&gid=12345&portrait=false&fitw=true&gridlines=false",
  });
  assert.ok(!/xlsx/.test(JSON.stringify(urls)));
});

test("reportMonths: dated months up to now plus the current one, newest first", () => {
  const entries = [
    { dateText: "2026-09-03" },
    { dateText: "2026-10-01" },
    { dateText: "2026-10-30" },
    { dateText: "2026-12-01" },
    { dateText: "11/01/2026" },
    { dateText: "" },
  ];
  assert.deepEqual(plain(L.reportMonths(entries, "2026-11-12")), {
    months: ["2026-11", "2026-10", "2026-09"],
    defaultMonth: "2026-10",
  });
  assert.deepEqual(plain(L.reportMonths([], "2026-11-12")), {
    months: ["2026-11"],
    defaultMonth: "2026-11",
  });
});

test("reportMonthRefusal", () => {
  assert.equal(L.reportMonthRefusal("2026-11", "2026-11-12"), null);
  assert.equal(L.reportMonthRefusal("2026-10", "2026-11-12"), null);
  assert.equal(L.reportMonthRefusal("2026-12", "2026-11-12"), "ADMIN_FUTURE");
  assert.equal(L.reportMonthRefusal("2026-13", "2026-11-12"), "ADMIN_BAD_MONTH");
  assert.equal(L.reportMonthRefusal("2026-00", "2026-11-12"), "ADMIN_BAD_MONTH");
  assert.equal(L.reportMonthRefusal("2026-1", "2026-11-12"), "ADMIN_BAD_MONTH");
  assert.equal(L.reportMonthRefusal("", "2026-11-12"), "ADMIN_BAD_MONTH");
  assert.equal(L.reportMonthRefusal(undefined, "2026-11-12"), "ADMIN_BAD_MONTH");
});

test('refusal("ADMIN_BAD_MONTH")', () => {
  assert.deepEqual(plain(L.refusal("ADMIN_BAD_MONTH")), {
    ok: false,
    refusal: "ADMIN_BAD_MONTH",
    message: "Please choose a month.",
  });
});

test("settingsDefaults has 24 rows before the general settings, Volunteer hour value blank after the check-out flag", () => {
  const rows = plain(L.settingsDefaults("2026-11-12")).slice(
    0,
    -L.generalSettingsDefaults().length,
  );
  assert.equal(rows.length, 24);
  const names = rows.map((r) => r[0]);
  const at = names.indexOf("Volunteer hour value");
  assert.equal(at, names.indexOf("Check-out flag minutes") + 1);
  assert.deepEqual(rows[at], ["Volunteer hour value", ""]);
});

// ---------------------------------------------------------------------------
// What setupReports writes

test("kioskWarnHeaders leaves out Role/Type, Activity, Notes and Admin Alerts?", () => {
  const warn = plain(L.kioskWarnHeaders());
  assert.equal(warn.length, 14);
  for (const h of [H.role, H.activity, H.notes, H.alerts]) assert.ok(!warn.includes(h), h);
  assert.deepEqual(
    [...warn].sort(),
    HEADER.filter((h) => ![H.role, H.activity, H.notes, H.alerts].includes(h)).sort(),
  );
  assert.match(L.kioskWarnDescription(), /^Kiosk column: /);
});

test("columnLetter", () => {
  assert.equal(L.columnLetter(0), "A");
  assert.equal(L.columnLetter(25), "Z");
  assert.equal(L.columnLetter(26), "AA");
  assert.equal(L.columnLetter(701), "ZZ");
  assert.equal(L.columnLetter(702), "AAA");
  assert.throws(() => L.columnLetter(-1), /no column/);
  assert.throws(() => L.columnLetter(1.5), /no column/);
});

// A reordered Log: a staff column first, then the kiosk's headers reversed. Date is in
// column S, Volunteer Name in Q, User Token in F, Status in E, Hours Served (stated) in J,
// Admin Alerts? in I, both Entered By in D and C, Shift ID in B.
const REORDERED = ["Staff column", ...HEADER.slice().reverse()];
const letterOf = (h) => L.columnLetter(REORDERED.indexOf(h));

test("the reordered header's letters", () => {
  assert.deepEqual(
    [H.date, H.name, H.token, H.status, H.statedHours, H.alerts, H.inBy, H.outBy, H.shiftId].map(
      letterOf,
    ),
    ["S", "Q", "F", "E", "J", "I", "D", "C", "B"],
  );
});

test("filterViewSpecs use the map's letters on a reordered header", () => {
  const specs = plain(L.filterViewSpecs(L.reportColumns(REORDERED), 77));
  assert.deepEqual(
    specs.map((s) => s.title),
    [
      "Kiosk: This month",
      "Kiosk: Last month",
      "Kiosk: Open shifts",
      "Kiosk: Flagged",
      "Kiosk: Admin-entered",
      "Kiosk: Typed into the sheet",
      "Kiosk: Other status or source",
    ],
  );
  const formula = (title) =>
    specs.find((s) => s.title === "Kiosk: " + title).filterSpecs[0].filterCriteria.condition
      .values[0].userEnteredValue;
  for (const s of specs) {
    assert.deepEqual(s.range, { sheetId: 77 });
    assert.equal(s.filterSpecs[0].columnIndex, REORDERED.indexOf(H.date));
    assert.equal(s.filterSpecs[0].filterCriteria.condition.type, "CUSTOM_FORMULA");
    assert.ok(!/\$A2/.test(formula(s.title.slice(7))), s.title + " never reads column A");
  }
  assert.match(formula("This month"), /^=IF\(ISNUMBER\(\$S2\)/);
  assert.match(formula("This month"), /TEXT\(TODAY\(\), "yyyy-mm"\)$/);
  assert.match(formula("Last month"), /EDATE\(TODAY\(\), -1\)/);
  assert.equal(formula("Open shifts"), '=LOWER(TRIM($E2)) = "open"');
  assert.match(formula("Flagged"), /TRIM\(\$I2\) <> ""/);
  // One case rule: initials are any-case letters, and "kiosk" in any case is not initials.
  assert.equal(
    formula("Admin-entered"),
    '=OR(AND(REGEXMATCH(TRIM($D2), "^[A-Za-z]{1,5}$"), LOWER(TRIM($D2)) <> "kiosk"), ' +
      'AND(REGEXMATCH(TRIM($C2), "^[A-Za-z]{1,5}$"), LOWER(TRIM($C2)) <> "kiosk"))',
  );
  assert.match(formula("Typed into the sheet"), /TRIM\(\$B2\) = "", TRIM\(\$D2\) = ""/);
  assert.match(formula("Other status or source"), /LOWER\(TRIM\(\$C2\)\) <> "kiosk"/);
});

test("filterViewRequests update views by title in place and add the rest", () => {
  const specs = plain(L.filterViewSpecs(L.reportColumns(HEADER), 0)).slice(0, 2);
  const requests = plain(
    L.filterViewRequests(specs, [
      { filterViewId: 5, title: "Kiosk: Last month" },
      { filterViewId: 6, title: "Staff's own view" },
    ]),
  );
  assert.deepEqual(requests[0], { addFilterView: { filter: specs[0] } });
  assert.deepEqual(requests[1], {
    updateFilterView: {
      filter: { filterViewId: 5, ...specs[1] },
      fields: "title,range,filterSpecs",
    },
  });
  assert.equal(requests.length, 2, "a view with another title is never named");
});

// ---------------------------------------------------------------------------
// What setupReports marks as its own

test("each kind of report protection has its own marker, and no marker starts another", () => {
  const p = plain(L.reportProtectionPrefixes());
  assert.deepEqual(p, {
    kioskColumn: "Kiosk column:",
    monthlyHours: "Monthly Hours tab:",
    reportTab: "Report tab:",
  });
  assert.ok(L.kioskWarnDescription().startsWith(p.kioskColumn));
  assert.ok(L.reportTabDescription().startsWith(p.reportTab));
  const all = Object.values(p);
  for (const a of all) {
    for (const b of all) if (a !== b) assert.ok(!a.startsWith(b), a + " / " + b);
  }
  // A report tab's description is never taken for one setupReports keeps up.
  assert.ok(!L.reportTabDescription().startsWith(p.kioskColumn));
  assert.ok(!L.reportTabDescription().startsWith(p.monthlyHours));
  assert.equal(L.monthlyHoursTabName(), "Monthly Hours");
});

test("ownedProtectionPlan keeps its own, removes stale and duplicate own ones, adds missing, and names nothing else", () => {
  const own = L.kioskWarnDescription();
  const existing = [
    { key: "A:A", description: own },
    { key: "B:B", description: "Staff: payroll column" },
    { key: "C:C", description: own }, // a column the map no longer names
    { key: "A:A", description: own }, // a duplicate
    { key: "D:D", description: "" },
    { key: "E:E", description: L.reportTabDescription() },
  ];
  assert.deepEqual(plain(L.ownedProtectionPlan(["A:A", "D:D", "F:F"], existing, "Kiosk column:")), {
    keep: [0],
    remove: [2, 3],
    add: ["D:D", "F:F"],
  });
  // A second run over what the first left changes nothing.
  const after = [
    { key: "A:A", description: own },
    { key: "B:B", description: "Staff: payroll column" },
    { key: "D:D", description: "" },
    { key: "E:E", description: L.reportTabDescription() },
    { key: "D:D", description: own },
    { key: "F:F", description: own },
  ];
  assert.deepEqual(plain(L.ownedProtectionPlan(["A:A", "D:D", "F:F"], after, "Kiosk column:")), {
    keep: [0, 4, 5],
    remove: [],
    add: [],
  });
  // A sheet-level protection: one of its own kept, the report tab's left alone.
  const sheetLevel = [
    { key: "sheet", description: "Monthly Hours tab: kiosk" },
    { key: "sheet", description: "Monthly Hours tab: kiosk" },
    { key: "sheet", description: L.reportTabDescription() },
  ];
  assert.deepEqual(plain(L.ownedProtectionPlan(["sheet"], sheetLevel, "Monthly Hours tab:")), {
    keep: [0],
    remove: [1],
    add: [],
  });
  assert.deepEqual(plain(L.ownedProtectionPlan(["sheet"], [], "Monthly Hours tab:")), {
    keep: [],
    remove: [],
    add: ["sheet"],
  });
});

test("setupReportsMessage gives the counts, when Hours is filled as of, Monthly Hours' fate, and the reruns", () => {
  const base = {
    views: { added: 0, updated: 7 },
    warnings: { kept: 14, added: 0, removed: 0 },
  };
  const text = L.setupReportsMessage({
    ...base,
    hours: { asOf: "2026-11-13 9:14 AM", monthlyHours: "deleted" },
  });
  assert.match(
    text,
    /The Hours and Hours data tabs are set up\. Hours is filled as of 2026-11-13 9:14 AM\./,
  );
  assert.match(text, /The Monthly Hours tab was deleted; the Hours tab replaces it\./);
  assert.match(text, /Filter views: 7 updated, 0 added\./);
  assert.match(text, /Kiosk column warnings: 14 kept, 0 added, 0 removed\./);
  assert.match(text, /run setupDailyJobs once more for the nightly Hours refresh/);
  assert.match(text, /inserted, deleted or moved/);
  assert.match(text, /until setupReports runs again/);
  assert.doesNotMatch(text, /Monthly Hours tab is written/);

  const kept = L.setupReportsMessage({ ...base, hours: { asOf: "x", monthlyHours: "unmarked" } });
  assert.match(
    kept,
    /A tab named Monthly Hours was left alone: it doesn't carry the kiosk's Monthly Hours protection/,
  );
  assert.doesNotMatch(kept, /was deleted/);

  const none = L.setupReportsMessage({ ...base, hours: { asOf: "x", monthlyHours: "none" } });
  assert.doesNotMatch(none, /Monthly Hours/);
  assert.ok(!none.includes("\n\n"));
});

test("setupReportsMessage names the account the sort boxes run as, or why their trigger isn't in", () => {
  const base = {
    views: { added: 0, updated: 7 },
    warnings: { kept: 14, added: 0, removed: 0 },
    hours: { asOf: "2026-11-13 9:14 AM", monthlyHours: "none" },
  };
  const installed = L.setupReportsMessage({
    ...base,
    trigger: { kind: "installed", account: "owner@example.org" },
  });
  assert.match(installed, /^The sort boxes run as owner@example\.org \(trigger installed\)\.$/m);
  const kept = L.setupReportsMessage({
    ...base,
    trigger: { kind: "kept", account: "owner@example.org" },
  });
  assert.match(kept, /^The sort boxes run as owner@example\.org \(trigger already installed\)\.$/m);
  const failed = L.setupReportsMessage({
    ...base,
    trigger: { kind: "failed", message: "Too many triggers" },
  });
  assert.match(
    failed,
    /^The sort boxes' trigger couldn't be installed: Too many triggers\. Hours is set up, but picking a sort does nothing until setupReports runs again and installs it\.$/m,
  );
  assert.doesNotMatch(failed, /run as/);
  // The rest of the message is the same either way, and nothing is said without a trigger step.
  const without = L.setupReportsMessage(base);
  assert.doesNotMatch(without, /sort boxes/);
  for (const text of [installed, kept, failed]) {
    assert.deepEqual(
      text.split("\n").filter((line) => !/sort boxes/.test(line)),
      without.split("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// The golden month: every month report as main 2e7c0da made it, but for imported ends

const SOURCE_GROUP = "Rows with an end typed into the sheet or entered another way: ";

/**
 * A month report's cells as main made them, with the one change since: an end the paper
 * import entered leaves the source group. A line whose listed ends were all imported goes;
 * a line that also named another end keeps that end only; the group's count drops by the
 * lines gone, and its header row goes when none is left. Returns {rows, gone, trimmed}.
 */
function withoutImportedEnds(rows) {
  const at = rows.values.findIndex((r) => String(r[0]).startsWith(SOURCE_GROUP));
  assert.ok(at > 0, "the source group is in every report");
  const count = Number(rows.values[at][0].slice(SOURCE_GROUP.length));
  const bodyFrom = at + 2;
  const kept = [];
  let gone = 0;
  let trimmed = 0;
  for (let i = bodyFrom; i < bodyFrom + count; i++) {
    const parts = String(rows.values[i][4]).split(", ");
    const left = parts.filter((p) => !/^(in|out) "import"$/i.test(p));
    if (!left.length) {
      gone += 1;
      continue;
    }
    if (left.length < parts.length) trimmed += 1;
    const values = rows.values[i].slice();
    values[4] = left.join(", ");
    kept.push({ values, formats: rows.formats[i], kind: rows.kinds[i] });
  }
  const out = { values: [], formats: [], kinds: [] };
  const push = (values, formats, kind) => {
    out.values.push(values);
    out.formats.push(formats);
    out.kinds.push(kind);
  };
  for (let i = 0; i < at; i++) push(rows.values[i], rows.formats[i], rows.kinds[i]);
  const section = rows.values[at].slice();
  section[0] = SOURCE_GROUP + kept.length;
  push(section, rows.formats[at], rows.kinds[at]);
  if (count && kept.length) push(rows.values[at + 1], rows.formats[at + 1], rows.kinds[at + 1]);
  kept.forEach((k) => push(k.values, k.formats, k.kind));
  for (let i = count ? bodyFrom + count : at + 1; i < rows.values.length; i++) {
    push(rows.values[i], rows.formats[i], rows.kinds[i]);
  }
  return { rows: out, gone, trimmed };
}

test("golden month: every month report equals main's, cell for cell, but for imported ends", () => {
  const golden = JSON.parse(readFileSync(new URL("tests/report-golden.json", root), "utf8"));
  assert.equal(golden.rev, "2e7c0da");
  const byLog = new Map(GOLDEN_LOGS.map((log) => [log.name, log]));
  let gone = 0;
  let trimmed = 0;
  let cases = 0;
  for (const c of golden.cases) {
    const { entries, cols } = goldenEntries(L, byLog.get(c.log));
    const expected = withoutImportedEnds({ values: c.values, formats: c.formats, kinds: c.kinds });
    gone += expected.gone;
    trimmed += expected.trimmed;
    const label = c.log + " " + c.month + " at " + c.rate;
    const viaMonth = plain(
      L.reportRows(
        L.monthReport(entries, c.month, c.rate, cols),
        c.month,
        GOLDEN_MADE.initials,
        GOLDEN_MADE.madeAt,
      ),
    );
    assert.deepEqual(viaMonth, expected.rows, label + " (monthReport)");
    const { period } = L.reportPeriod({ period: "month", month: c.month }, "2026-12-31");
    const viaPeriod = plain(
      L.reportRows(
        L.periodReport(entries, period, c.rate, cols),
        period,
        GOLDEN_MADE.initials,
        GOLDEN_MADE.madeAt,
      ),
    );
    assert.deepEqual(viaPeriod, expected.rows, label + " (periodReport)");
    cases += 1;
  }
  const made = GOLDEN_LOGS.reduce((n, log) => n + log.months.length * log.rates.length, 0);
  assert.equal(cases, made, "the fixture holds every golden Log's every month");
  assert.ok(gone > 0, "a line of only imported ends leaves the group");
  assert.ok(trimmed > 0, "a line with another end keeps that end only");
});

// ---------------------------------------------------------------------------
// Imported ends in the review groups

/** A row as the paper import writes it: closed, stated times only, "import" at both ends. */
function importedShift(date, name, token, hours, extra = {}) {
  return {
    date,
    name,
    token,
    status: "closed",
    statedIn: at(date, "09:00"),
    statedOut: at(date, "10:00"),
    statedHours: hours,
    inBy: "import",
    outBy: "import",
    shiftId: "imp-" + date + "-" + token,
    ...extra,
  };
}

const IMPORTED = [
  importedShift("2026-09-01", "Ivy Paz", "tI", 1),
  importedShift("2026-09-02", "Ivy Paz", "tI", 1, { outBy: "" }),
  importedShift("2026-09-03", "Jo Kim", "tJ", 1, { inBy: " IMPORT ", outBy: "Import" }),
  importedShift("2026-09-04", "Jo Kim", "tJ", 1, { outBy: "auto-close" }),
  importedShift("2026-09-05", "Kai Roe", "import:kai roe", 1, { alerts: "name not matched" }),
  importedShift("2026-09-06", "Kai Roe", "import:kai roe", ""),
  {
    date: "2026-09-07",
    name: "Lu Wei",
    token: "tL",
    status: "open",
    statedIn: at("2026-09-07", "09:00"),
    inBy: "import",
    shiftId: "imp-open",
  },
  importedShift("2026-09-08", "Ivy Paz", "tI", 1, { outBy: "kiosk" }),
  importedShift("2026-09-09", "Ivy Paz", "tI", 1, { outBy: "JP" }),
];

for (const [kind, form] of [
  ["a month", { period: "month", month: "2026-09" }],
  ["all time", { period: "all" }],
]) {
  test("imported ends leave the source group and nothing else, for " + kind, () => {
    const { period } = L.reportPeriod(form, "2026-11-16");
    const r = plain(L.periodReport(entriesFor(IMPORTED), period, null));
    const rows = Object.fromEntries(
      r.review.map((g) => [g.id, g.rows.map((x) => [x.row, x.detail])]),
    );
    assert.deepEqual(rows.source, [
      [3, "out typed into the sheet"],
      [5, 'out "auto-close"'],
    ]);
    assert.deepEqual(rows.flagged, [[6, "name not matched"]]);
    assert.deepEqual(rows.hours, [[7, "stated hours blank"]]);
    assert.deepEqual(rows.open, [[8, ""]], "an open imported row is still an open shift");
    assert.deepEqual(rows.admin, [[10, "out JP"]]);
    assert.deepEqual(rows.status, []);
    assert.deepEqual(rows.noToken, []);
    assert.equal(r.shifts, 8, "imported rows count as they always have");
  });
}

// ---------------------------------------------------------------------------
// Periods

test("dayKey and monthKey", () => {
  assert.equal(L.dayKey("2026-11-14"), "2026-11-14");
  assert.equal(L.dayKey(" 2026-11-14 "), "2026-11-14");
  assert.equal(L.dayKey("2024-02-29"), "2024-02-29");
  assert.equal(L.dayKey("2026-02-29"), "");
  assert.equal(L.dayKey("2026-02-30"), "");
  assert.equal(L.dayKey("11/14/2026"), "");
  assert.equal(L.dayKey(""), "");
  assert.equal(L.monthKey("2026-11-14"), "2026-11");
  assert.equal(L.monthKey("2026-02-30"), "");
});

test("period bounds: quarters, a leap February, 31 December, a range across a year end", () => {
  const bounds = (p) => [p.kind, p.key, p.from, p.to];
  assert.deepEqual(bounds(L.quarterPeriod("2026-Q1")), [
    "quarter",
    "2026-Q1",
    "2026-01-01",
    "2026-03-31",
  ]);
  assert.deepEqual(bounds(L.quarterPeriod("2026-Q2")), [
    "quarter",
    "2026-Q2",
    "2026-04-01",
    "2026-06-30",
  ]);
  assert.deepEqual(bounds(L.quarterPeriod("2026-Q3")), [
    "quarter",
    "2026-Q3",
    "2026-07-01",
    "2026-09-30",
  ]);
  assert.deepEqual(bounds(L.quarterPeriod("2026-Q4")), [
    "quarter",
    "2026-Q4",
    "2026-10-01",
    "2026-12-31",
  ]);
  assert.deepEqual(bounds(L.monthPeriod("2024-02")), [
    "month",
    "2024-02",
    "2024-02-01",
    "2024-02-29",
  ]);
  assert.deepEqual(bounds(L.monthPeriod("2026-02")), [
    "month",
    "2026-02",
    "2026-02-01",
    "2026-02-28",
  ]);
  assert.deepEqual(bounds(L.yearPeriod("2026")), ["year", "2026", "2026-01-01", "2026-12-31"]);
  assert.deepEqual(bounds(L.allTimePeriod()), ["all", "all time", null, null]);
  const range = L.rangePeriod("2025-12-15", "2026-01-10");
  assert.equal(range.key, "2025-12-15 to 2026-01-10");
  for (const [day, inside] of [
    ["2025-12-14", false],
    ["2025-12-15", true],
    ["2025-12-31", true],
    ["2026-01-01", true],
    ["2026-01-10", true],
    ["2026-01-11", false],
  ]) {
    assert.equal(L.inPeriod(day, range), inside, day);
  }
  assert.equal(L.inPeriod("2026-12-31", L.yearPeriod("2026")), true);
  assert.equal(L.inPeriod("2027-01-01", L.yearPeriod("2026")), false);
  assert.equal(L.inPeriod("2024-02-29", L.quarterPeriod("2024-Q1")), true);
  assert.equal(L.inPeriod("1900-01-01", L.allTimePeriod()), true);
  assert.equal(L.inPeriod("", L.allTimePeriod()), false, "an undated row is in no period");
  assert.equal(L.previousPeriod(L.quarterPeriod("2026-Q1")).key, "2025-Q4");
  assert.equal(L.previousPeriod(L.quarterPeriod("2026-Q3")).key, "2026-Q2");
  assert.equal(L.previousPeriod(L.yearPeriod("2026")).key, "2025");
  assert.equal(L.previousPeriod(L.monthPeriod("2026-01")).key, "2025-12");
  assert.equal(L.previousPeriod(range), null);
  assert.equal(L.previousPeriod(L.allTimePeriod()), null);
  assert.equal(L.quarterLabel("2026-Q4"), "Q4 2026 (October to December)");
  assert.equal(L.quarterLabel("2026-Q1"), "Q1 2026 (January to March)");
});

test("reportPeriod: each kind, and a form with no period is a month", () => {
  const today = "2026-11-16";
  const got = (form) => plain(L.reportPeriod(form, today));
  assert.deepEqual(got({ month: "2026-10" }), {
    period: {
      kind: "month",
      key: "2026-10",
      from: "2026-10-01",
      to: "2026-10-31",
      unfinished: false,
    },
  });
  assert.deepEqual(got({ period: "", month: "2026-11" }).period.unfinished, true);
  assert.deepEqual(got({ period: "quarter", quarter: "2026-Q3" }).period, {
    kind: "quarter",
    key: "2026-Q3",
    from: "2026-07-01",
    to: "2026-09-30",
    unfinished: false,
  });
  assert.equal(got({ period: "quarter", quarter: "2026-Q4" }).period.unfinished, true);
  assert.deepEqual(got({ period: "year", year: "2025" }).period, {
    kind: "year",
    key: "2025",
    from: "2025-01-01",
    to: "2025-12-31",
    unfinished: false,
  });
  assert.equal(got({ period: "year", year: "2026" }).period.unfinished, true);
  assert.deepEqual(got({ period: "range", from: "2026-03-15", to: "2026-06-30" }).period, {
    kind: "range",
    key: "2026-03-15 to 2026-06-30",
    from: "2026-03-15",
    to: "2026-06-30",
    unfinished: false,
  });
  assert.deepEqual(got({ period: "all", month: "2099-01" }).period, {
    kind: "all",
    key: "all time",
    from: null,
    to: null,
    unfinished: false,
  });
  // Only the fields of the kind are read.
  assert.equal(got({ period: "year", year: "2025", month: "bad", from: "x" }).period.key, "2025");
  // Spaces are trimmed.
  assert.equal(got({ period: " Quarter ", quarter: " 2026-Q2 " }).period.key, "2026-Q2");
  assert.equal(
    got({ period: "range", from: " 2026-01-01 ", to: " 2026-01-02 " }).period.key,
    "2026-01-01 to 2026-01-02",
  );
});

test("reportPeriod refuses in order and writes nothing it can't read", () => {
  const today = "2026-11-16";
  const refused = (form) => L.reportPeriod(form, today).refusal;
  assert.equal(refused({ period: "week" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({ period: "quarter", quarter: "2026-Q5" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({ period: "quarter", quarter: "2026Q4" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({ period: "quarter" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({ period: "year", year: "26" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({ period: "year", year: "2026-01" }), "ADMIN_BAD_PERIOD");
  assert.equal(refused({}), "ADMIN_BAD_MONTH");
  assert.equal(refused({ month: "2026-13" }), "ADMIN_BAD_MONTH");
  assert.equal(refused({ period: "month", month: "2026-12" }), "ADMIN_FUTURE");
  assert.equal(refused({ period: "range", to: "2026-01-01" }), "ADMIN_BAD_RANGE");
  assert.equal(refused({ period: "range", from: "2026-01-01" }), "ADMIN_BAD_RANGE");
  assert.equal(
    refused({ period: "range", from: "2026-02-30", to: "2026-03-01" }),
    "ADMIN_BAD_RANGE",
  );
  assert.equal(
    refused({ period: "range", from: "01/02/2026", to: "2026-03-01" }),
    "ADMIN_BAD_RANGE",
  );
  assert.equal(
    refused({ period: "range", from: "2026-03-02", to: "2026-03-01" }),
    "ADMIN_RANGE_ORDER",
  );
  // The order check comes before the future check.
  assert.equal(
    refused({ period: "range", from: "2027-03-02", to: "2027-03-01" }),
    "ADMIN_RANGE_ORDER",
  );
  assert.equal(refused({ period: "range", from: "2026-11-17", to: "2026-12-01" }), "ADMIN_FUTURE");
  assert.equal(refused({ period: "quarter", quarter: "2027-Q1" }), "ADMIN_FUTURE");
  assert.equal(refused({ period: "year", year: "2027" }), "ADMIN_FUTURE");
  // A range that starts by today may end after it; so may a one-day range on today.
  const open = L.reportPeriod({ period: "range", from: "2026-11-01", to: "2027-01-31" }, today);
  assert.equal(open.refusal, undefined);
  assert.equal(open.period.unfinished, true);
  const one = L.reportPeriod({ period: "range", from: today, to: today }, today);
  assert.equal(one.period.unfinished, false);
  for (const code of ["ADMIN_BAD_PERIOD", "ADMIN_BAD_RANGE", "ADMIN_RANGE_ORDER"]) {
    assert.equal(plain(L.refusal(code)).ok, false);
  }
  assert.equal(L.refusal("ADMIN_BAD_PERIOD").message, "Please choose a period.");
  assert.equal(L.refusal("ADMIN_BAD_RANGE").message, "Please enter both dates, as yyyy-mm-dd.");
  assert.equal(L.refusal("ADMIN_RANGE_ORDER").message, "The From date is after the To date.");
});

// A year of shifts: Ana every month from January, Ben from October, Cal once in December.
const YEAR_LOG = [];
for (let m = 1; m <= 12; m++) {
  const month = "2026-" + String(m).padStart(2, "0");
  YEAR_LOG.push(kioskShift(month + "-05", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }));
  if (m >= 10) {
    YEAR_LOG.push(
      kioskShift(month + "-06", "Ben Ott", "tB", "09:00", "12:30", { statedHours: 3.5 }),
    );
  }
}
YEAR_LOG.push(kioskShift("2026-12-07", "Cal Diaz", "tC", "09:00", "10:00", { statedHours: 1 }));
YEAR_LOG.push(kioskShift("2025-12-20", "Dee Fox", "tD", "09:00", "10:00", { statedHours: 1.25 }));

const reportFor = (rows, form, today = "2026-12-31", rate = null) => {
  const got = L.reportPeriod(form, today);
  assert.equal(got.refusal, undefined, JSON.stringify(form));
  return plain(L.periodReport(entriesFor(rows), got.period, rate));
};

test("a quarter's and a year's sums are their months' sums; volunteers are a distinct count", () => {
  const sum = (reports, key) => reports.reduce((n, r) => n + r[key], 0);
  const newCount = (reports) => reports.reduce((n, r) => n + r.newVolunteers.length, 0);
  const months = (list) => list.map((m) => reportFor(YEAR_LOG, { month: m }));
  const q4 = reportFor(YEAR_LOG, { period: "quarter", quarter: "2026-Q4" });
  const q4Months = months(["2026-10", "2026-11", "2026-12"]);
  assert.equal(q4.shifts, sum(q4Months, "shifts"));
  assert.equal(q4.hundredths, sum(q4Months, "hundredths"));
  assert.equal(q4.newVolunteers.length, newCount(q4Months));
  assert.deepEqual(q4.newVolunteers, ["Ben Ott", "Cal Diaz"]);
  assert.equal(q4.headcount, 3);
  assert.ok(sum(q4Months, "headcount") > q4.headcount, "a volunteer in two months counts once");
  const year = reportFor(YEAR_LOG, { period: "year", year: "2026" });
  const yearMonths = months(
    Array.from({ length: 12 }, (_, i) => "2026-" + String(i + 1).padStart(2, "0")),
  );
  assert.equal(year.shifts, sum(yearMonths, "shifts"));
  assert.equal(year.hundredths, sum(yearMonths, "hundredths"));
  assert.equal(year.newVolunteers.length, newCount(yearMonths));
  assert.equal(year.headcount, 3);
  assert.deepEqual(year.newVolunteerShifts, [
    { label: "Ana Ruiz", date: "2026-01-05" },
    { label: "Ben Ott", date: "2026-10-06" },
    { label: "Cal Diaz", date: "2026-12-07" },
  ]);
});

test("all time's stated hours and shifts equal the Hours tab's all-time totals", () => {
  const rows = YEAR_LOG.concat([
    {
      date: "11/02/2026",
      name: "Eve",
      token: "tE",
      status: "closed",
      statedHours: 9,
      shiftId: "u",
    },
    kioskShift("2026-03-03", "Fay", "", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-03-04", "Fay", "tF", "09:00", "10:00", { status: "open" }),
  ]);
  const all = reportFor(rows, { period: "all" });
  const t = plain(L.hoursTable(entriesFor(rows), [], () => "09:00"));
  const hoursAt = t.header.indexOf("Hours");
  assert.ok(hoursAt >= 0);
  const hundredths = t.rows.reduce((n, r) => n + Math.round(r[hoursAt] * 100), 0);
  assert.equal(all.shifts, t.rows.length);
  assert.equal(all.hundredths, hundredths);
});

/** The first cell of each section row above Rows to review, and the first lines. */
function outline(rows) {
  const at = rows.values.findIndex((r) => r[0] === "Rows to review");
  const sections = rows.values
    .slice(0, at)
    .filter((r, i) => rows.kinds[i] === "section")
    .map((r) => r[0]);
  const firstBlank = rows.kinds.indexOf("blank");
  return {
    title: rows.values[0][0],
    lines: rows.values.slice(1, firstBlank).map((r) => r[0]),
    sections,
  };
}

const rowsFor = (rows, form, today) => {
  const got = L.reportPeriod(form, today);
  return plain(
    L.reportRows(
      L.periodReport(entriesFor(rows), got.period, 3479),
      got.period,
      "JP",
      "2026-11-16 9:00 AM",
    ),
  );
};

test("each kind gets its sections and no others; only quarter, year and range say they haven't ended", () => {
  const today = "2026-11-16";
  const common = ["Hours per volunteer"];
  const tail = ["Hours by weekday", "Hours by Role/Type", "Hours by Activity"];
  const cases = [
    [
      { month: "2026-11" },
      "Monthly report for November 2026 (2026-11)",
      [
        "Summary",
        "Month over month",
        "Year to date",
        ...common,
        ...tail,
        "Milestones crossed this month",
      ],
    ],
    [
      { period: "quarter", quarter: "2026-Q4" },
      "Hours report for Q4 2026 (2026-10-01 to 2026-12-31)",
      [
        "Summary",
        "Quarter over quarter",
        "Year to date",
        "Hours by month",
        ...common,
        "New volunteers",
        ...tail,
        "Milestones crossed in this period",
      ],
    ],
    [
      { period: "year", year: "2026" },
      "Hours report for 2026 (2026-01-01 to 2026-12-31)",
      [
        "Summary",
        "Year over year",
        "Hours by month",
        ...common,
        "New volunteers",
        ...tail,
        "Milestones crossed in this period",
      ],
    ],
    [
      { period: "range", from: "2025-12-01", to: "2026-12-31" },
      "Hours report for 2025-12-01 to 2026-12-31",
      [
        "Summary",
        "Hours by year",
        "Hours by month",
        ...common,
        "New volunteers",
        ...tail,
        "Milestones crossed in this period",
      ],
    ],
    [
      { period: "all" },
      "Hours report for all time (2025-12-20 to 2026-12-07)",
      [
        "Summary",
        "Hours by year",
        "Hours by month",
        ...common,
        ...tail,
        "Milestones crossed in this period",
      ],
    ],
  ];
  for (const [form, title, sections] of cases) {
    const o = outline(rowsFor(YEAR_LOG, form, today));
    assert.equal(o.title, title);
    assert.deepEqual(o.sections, sections, title);
    const unfinished = o.lines.filter((l) => /hasn't come yet/.test(l));
    if (form.period === "quarter" || form.period === "year" || form.period === "range") {
      assert.deepEqual(unfinished, [
        "This period runs to 2026-12-31, which hasn't come yet, so this report shows the Log as it is so far.",
      ]);
    } else {
      assert.deepEqual(unfinished, [], title);
    }
  }
  // A period that has ended doesn't say so.
  assert.equal(
    outline(rowsFor(YEAR_LOG, { period: "quarter", quarter: "2026-Q4" }, "2027-01-02")).lines
      .length,
    1,
  );
});

test("the comparison and year to date of a quarter, and the summary keeps only the count", () => {
  const rows = rowsFor(YEAR_LOG, { period: "quarter", quarter: "2026-Q4" }, "2027-01-02");
  const find = (text) => rows.values.findIndex((r) => r[0] === text);
  assert.deepEqual(rows.values[find("Quarter over quarter")], [
    "Quarter over quarter",
    "Q4 2026",
    "Q3 2026",
    "Change",
    "% change",
  ]);
  assert.deepEqual(rows.values[find("Quarter over quarter") + 2], [
    "Shifts",
    7,
    3,
    "+4",
    "+133.3%",
  ]);
  assert.deepEqual(rows.values[find("Year to date")], [
    "Year to date",
    "January 2026 to December 2026",
    "",
    "",
    "",
  ]);
  assert.deepEqual(rows.values[find("Year to date") + 2], ["Shifts", 16, "", "", ""]);
  assert.deepEqual(rows.values[find("New volunteers")], ["New volunteers", 2, "", "", ""]);
  const table = rows.values.findIndex(
    (r, i) => r[0] === "New volunteers" && rows.kinds[i] === "section",
  );
  assert.deepEqual(rows.values.slice(table + 1, table + 4), [
    ["Volunteer", "First shift", "", "", ""],
    ["Ben Ott", "2026-10-06", "", "", ""],
    ["Cal Diaz", "2026-12-07", "", "", ""],
  ]);
  const year = rowsFor(YEAR_LOG, { period: "year", year: "2026" }, "2027-01-02");
  assert.deepEqual(
    year.values.find((r) => r[0] === "Year over year"),
    ["Year over year", "2026", "2025", "Change", "% change"],
  );
  const all = rowsFor(YEAR_LOG, { period: "all" }, "2027-01-02");
  assert.deepEqual(
    all.values.find((r) => r[0] === "New volunteers"),
    ["New volunteers", 4, "", "", ""],
  );
});

/** The rows of a by-month or by-year table, from its header to before the next blank row. */
function tableRows(rows, title) {
  const at = rows.values.findIndex((r, i) => r[0] === title && rows.kinds[i] === "section");
  if (at < 0) return null;
  const end = rows.kinds.indexOf("blank", at);
  return rows.values.slice(at + 2, end < 0 ? undefined : end);
}

test("hours by month: from the first to the last month holding a counted row, zeros between, a Total", () => {
  const rows = [
    kioskShift("2026-02-10", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-05-10", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-05-11", "Ben Ott", "tB", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-07-01", "Cal", "", "09:00", "10:00", { statedHours: 1 }),
    { date: "2026-08-01", name: "Dee", token: "tD", status: "open", shiftId: "o" },
  ];
  const year = rowsFor(rows, { period: "year", year: "2026" }, "2026-11-16");
  assert.deepEqual(tableRows(year, "Hours by month"), [
    ["February 2026", 1, 2, 1, 1],
    ["March 2026", 0, 0, 0, 0],
    ["April 2026", 0, 0, 0, 0],
    ["May 2026", 2, 3, 2, 1],
    ["Total", 3, 5, 2, 2],
  ]);
  assert.equal(tableRows(year, "Hours by year"), null, "a year has no by-year table");
  const range = rowsFor(
    rows,
    { period: "range", from: "1900-01-01", to: "2026-11-15" },
    "2026-11-16",
  );
  assert.deepEqual(
    tableRows(range, "Hours by month").map((r) => r[0]),
    ["February 2026", "March 2026", "April 2026", "May 2026", "Total"],
    "a typed range doesn't set the bounds",
  );
  assert.equal(tableRows(range, "Hours by year"), null, "one calendar year: no by-year table");
});

test("hours by month: a cut month is labelled by its dates", () => {
  const rows = [
    kioskShift("2026-03-15", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-03-20", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-03-31", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-04-01", "Ben Ott", "tB", "09:00", "10:00", { statedHours: 1 }),
    kioskShift("2026-06-30", "Ben Ott", "tB", "09:00", "10:00", { statedHours: 1 }),
  ];
  const labels = (form) =>
    tableRows(rowsFor(rows, form, "2026-11-16"), "Hours by month").map((r) => r[0]);
  assert.deepEqual(labels({ period: "range", from: "2026-03-15", to: "2026-06-30" }), [
    "2026-03-15 to 2026-03-31",
    "April 2026",
    "May 2026",
    "June 2026",
    "Total",
  ]);
  assert.deepEqual(labels({ period: "range", from: "2026-03-31", to: "2026-04-15" }), [
    "2026-03-31 to 2026-03-31",
    "2026-04-01 to 2026-04-15",
    "Total",
  ]);
  assert.deepEqual(labels({ period: "range", from: "2026-04-01", to: "2026-04-01" }), [
    "2026-04-01 to 2026-04-01",
    "Total",
  ]);
  assert.deepEqual(labels({ period: "range", from: "2026-03-15", to: "2026-03-20" }), [
    "2026-03-15 to 2026-03-20",
    "Total",
  ]);
  assert.deepEqual(labels({ period: "quarter", quarter: "2026-Q2" }), [
    "April 2026",
    "May 2026",
    "June 2026",
    "Total",
  ]);
});

test("hours by month: no counted row shows (none) and no Total", () => {
  const rows = [kioskShift("2026-05-10", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 })];
  const before = rowsFor(
    rows,
    { period: "range", from: "2020-01-01", to: "2020-12-31" },
    "2026-11-16",
  );
  assert.deepEqual(tableRows(before, "Hours by month"), [["(none)", "", "", "", ""]]);
  const undated = [
    { date: "5/10/2026", name: "Ana", token: "tA", status: "closed", statedHours: 2, shiftId: "u" },
  ];
  for (const form of [
    { period: "range", from: "2026-01-01", to: "2026-11-16" },
    { period: "quarter", quarter: "2026-Q4" },
  ]) {
    assert.deepEqual(tableRows(rowsFor(undated, form, "2026-11-16"), "Hours by month"), [
      ["(none)", "", "", "", ""],
    ]);
  }
  const all = rowsFor(undated, { period: "all" }, "2026-11-16");
  assert.equal(all.values[0][0], "Hours report for all time (no dated rows)");
  assert.deepEqual(tableRows(all, "Hours by month"), [["(none)", "", "", "", ""]]);
});

test("hours by year: shown when the month rows span two years, cut years labelled by dates", () => {
  const rows = [
    kioskShift("2025-12-20", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-01-05", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-01-06", "Ben Ott", "tB", "09:00", "10:00", { statedHours: 1 }),
  ];
  const range = rowsFor(
    rows,
    { period: "range", from: "2025-12-15", to: "2026-01-10" },
    "2026-11-16",
  );
  assert.deepEqual(tableRows(range, "Hours by year"), [
    ["2025-12-15 to 2025-12-31", 1, 2, 1, 1],
    ["2026-01-01 to 2026-01-10", 2, 3, 2, 1],
    ["Total", 3, 5, 2, 2],
  ]);
  assert.deepEqual(tableRows(range, "Hours by month"), [
    ["2025-12-15 to 2025-12-31", 1, 2, 1, 1],
    ["2026-01-01 to 2026-01-10", 2, 3, 2, 1],
    ["Total", 3, 5, 2, 2],
  ]);
  const all = rowsFor(rows, { period: "all" }, "2026-11-16");
  assert.deepEqual(
    tableRows(all, "Hours by year").map((r) => r[0]),
    ["2025", "2026", "Total"],
  );
  assert.deepEqual(
    tableRows(all, "Hours by month").map((r) => r[0]),
    ["December 2025", "January 2026", "Total"],
    "all time's first and last months show their names",
  );
});

test("an uncounted row dated 2062 adds no month or year rows, while all time's title runs to 2062", () => {
  const rows = [
    kioskShift("2025-12-20", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2026-01-05", "Ana Ruiz", "tA", "09:00", "11:00", { statedHours: 2 }),
    kioskShift("2062-11-14", "Ana Ruiz", "tA", "09:00", "11:00", { status: "open" }),
  ];
  const all = rowsFor(rows, { period: "all" }, "2026-11-16");
  assert.equal(all.values[0][0], "Hours report for all time (2025-12-20 to 2062-11-14)");
  assert.deepEqual(
    tableRows(all, "Hours by month").map((r) => r[0]),
    ["December 2025", "January 2026", "Total"],
  );
  assert.deepEqual(
    tableRows(all, "Hours by year").map((r) => r[0]),
    ["2025", "2026", "Total"],
  );
});

test("review: a row outside the period isn't listed; an undated row is, for every kind", () => {
  const rows = [
    kioskShift("2026-05-10", "Ana", "tA", "09:00", "10:00", {
      status: "auto-closed",
      statedHours: 1,
    }),
    kioskShift("2026-08-10", "Ben", "tB", "09:00", "10:00", {
      status: "auto-closed",
      statedHours: 1,
    }),
    { date: "5/10/2026", name: "Cal", token: "tC", status: "closed", statedHours: 1, shiftId: "u" },
  ];
  for (const form of [
    { month: "2026-05" },
    { period: "quarter", quarter: "2026-Q2" },
    { period: "year", year: "2026" },
    { period: "range", from: "2026-05-01", to: "2026-05-31" },
    { period: "all" },
  ]) {
    const r = reportFor(rows, form, "2026-11-16");
    const ids = (id) => r.review.find((g) => g.id === id).rows.map((x) => x.row);
    assert.deepEqual(ids("noDate"), [4], JSON.stringify(form));
    const status = form.period === "year" || form.period === "all" ? [2, 3] : [2];
    assert.deepEqual(ids("status"), status, JSON.stringify(form));
  }
});

test("the open-shift line says this period for every kind but month", () => {
  const rows = [kioskShift("2026-05-10", "Ana", "tA", "09:00", "10:00", { status: "open" })];
  const line = (form) => rowsFor(rows, form, "2026-11-16").values[2][0];
  assert.match(line({ month: "2026-05" }), /^1 open shift in this month is not counted/);
  assert.match(line({ period: "all" }), /^1 open shift in this period is not counted/);
  assert.match(
    L.openShiftsLine(2, L.yearPeriod("2026")),
    /^2 open shifts in this period are not counted/,
  );
});

test("an empty period makes a report of zeros, not a refusal", () => {
  const r = reportFor(YEAR_LOG, { period: "quarter", quarter: "2024-Q2" }, "2026-11-16");
  assert.equal(r.shifts, 0);
  assert.equal(r.hundredths, 0);
  assert.equal(r.headcount, 0);
  assert.deepEqual(r.volunteers, []);
  assert.deepEqual(r.byMonth, []);
  assert.ok(r.comparison.every((c) => c.current === 0));
  const rows = rowsFor(YEAR_LOG, { period: "quarter", quarter: "2024-Q2" }, "2026-11-16");
  assert.deepEqual(tableRows(rows, "New volunteers"), [["(none)", "", "", "", ""]]);
});

test("reportTabName for every kind, with (2) and (3), case ignored", () => {
  const name = (form, taken) => L.reportTabName(L.reportPeriod(form, "2026-11-16").period, taken);
  assert.equal(name({ month: "2026-11" }), "Report 2026-11");
  assert.equal(name({ period: "quarter", quarter: "2026-Q4" }), "Report 2026-Q4");
  assert.equal(name({ period: "year", year: "2026" }), "Report 2026");
  assert.equal(
    name({ period: "range", from: "2026-03-15", to: "2026-06-30" }),
    "Report 2026-03-15 to 2026-06-30",
  );
  assert.equal(name({ period: "all" }), "Report all time");
  assert.equal(name({ period: "all" }, ["report ALL TIME"]), "Report all time (2)");
  assert.equal(
    name({ period: "quarter", quarter: "2026-Q4" }, ["Report 2026-q4", "REPORT 2026-Q4 (2)"]),
    "Report 2026-Q4 (3)",
  );
  assert.equal(name({ period: "year", year: "2026" }, ["Report 2026-11"]), "Report 2026");
  assert.equal(L.reportTabName("2026-11", ["Report 2026-11"]), "Report 2026-11 (2)");
});

test("reportPeriodLists: months as reportMonths; quarters and years with their defaults", () => {
  const dated = (dates) => dates.map((d) => ({ dateText: d }));
  const lists = (dates, today) => plain(L.reportPeriodLists(dated(dates), today));
  const mid = lists(["2026-02-10", "2026-07-01", "2026-04-30", "bad"], "2026-06-10");
  const months = plain(
    L.reportMonths(dated(["2026-02-10", "2026-07-01", "2026-04-30", "bad"]), "2026-06-10"),
  );
  assert.deepEqual(mid.months, months.months);
  assert.equal(mid.defaultMonth, months.defaultMonth);
  assert.deepEqual(mid.quarters, ["2026-Q2", "2026-Q1"]);
  assert.equal(mid.defaultQuarter, "2026-Q1");
  assert.deepEqual(mid.years, ["2026"]);
  assert.equal(mid.defaultYear, "2026");
  assert.equal(mid.today, "2026-06-10");
  const january = lists(["2025-11-03", "2025-12-30", "2024-06-01"], "2026-01-15");
  assert.deepEqual(january.quarters, ["2026-Q1", "2025-Q4", "2024-Q2"]);
  assert.equal(january.defaultQuarter, "2025-Q4");
  assert.deepEqual(january.years, ["2026", "2025", "2024"]);
  assert.equal(january.defaultYear, "2025");
  assert.equal(january.defaultMonth, "2025-12");
  const none = lists([], "2026-11-16");
  assert.deepEqual(none.months, ["2026-11"]);
  assert.deepEqual(none.quarters, ["2026-Q4"]);
  assert.equal(none.defaultQuarter, "2026-Q4");
  assert.deepEqual(none.years, ["2026"]);
  assert.equal(none.defaultYear, "2026");
  // A later row in the current quarter or year adds nothing; a later quarter isn't listed.
  const later = lists(["2026-12-01", "2027-01-01"], "2026-11-16");
  assert.deepEqual(later.quarters, ["2026-Q4"]);
  assert.deepEqual(later.years, ["2026"]);
});
