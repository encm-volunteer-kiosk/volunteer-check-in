// Tests for the reports block of apps-script/Logic.js: which Log rows count, every
// calculation of a month's report, the frozen report tab's cells, and the texts
// setupReports writes. Logic.js is loaded the way Apps Script loads it, one plain script in
// its own global scope, so results are compared through plain().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

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
  const allowed = ["title", "section", "header", "blank", "row"];
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

test("settingsDefaults has 26 rows, Volunteer hour value blank after the check-out flag", () => {
  const rows = plain(L.settingsDefaults("2026-11-12"));
  assert.equal(rows.length, 26);
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

test("monthlyHoursFormulas use the map's letters on a reordered header", () => {
  const f = plain(L.monthlyHoursFormulas(L.reportColumns(REORDERED), "Log"));
  const cell = (a1) => f.cells.find((c) => c.a1 === a1).value;
  const spill = cell("H2");
  for (const h of [
    H.date,
    H.name,
    H.token,
    H.status,
    H.statedHours,
    H.alerts,
    H.statedIn,
    H.recordedIn,
  ]) {
    const l = letterOf(h);
    assert.ok(spill.includes("'Log'!" + l + "2:" + l), h + " at " + l);
  }
  // The default layout's Date column, A, is the staff column here and is never read.
  assert.ok(!/'Log'!A2:A/.test(JSON.stringify(f)));
  assert.ok(cell("N1").includes("'Log'!S2:S"));
  // Group by the volunteer key only, label by the latest row's name.
  assert.match(cell("A7"), /UNIQUE\(keys\)/);
  assert.match(cell("A7"), /ROWS\(FILTER\(names, keys = key\)\)/);
  assert.ok(!/UNIQUE\(\{/.test(cell("A7")), "no grouping by token and name together");
  // No token reaches the tab: the spill writes a row number for each token.
  assert.match(spill, /XMATCH\(rowTokens, allTokens\) \+ 1/);
  assert.ok(
    spill.includes('picked, ARRAYFORMULA((months <> "") * (months = $B$1) = 1)'),
    "an undated row is never picked",
  );
  assert.ok(!/\{allTokens|\{rowTokens/.test(spill));
  for (const c of f.cells) {
    if (c.value.startsWith("=")) {
      const opens = (c.value.match(/\(/g) || []).length;
      const closes = (c.value.match(/\)/g) || []).length;
      assert.equal(opens, closes, c.a1 + " parentheses");
    }
  }
  assert.deepEqual(f.picker, { a1: "B1", listRange: "N1:N" });
  assert.deepEqual(f.hiddenColumns, ["H", "I", "J", "K", "L", "N"]);
  assert.equal(f.rowCount, 5000);
  assert.ok(!f.cells.some((c) => c.a1 === "B1"), "B1 is the picker, kept by setupReports");
});

test("monthlyHoursFormulas quote the tab name and refuse a missing column", () => {
  const f = plain(L.monthlyHoursFormulas(L.reportColumns(HEADER), "Kiosk's Log"));
  assert.ok(f.cells.find((c) => c.a1 === "H2").value.includes("'Kiosk''s Log'!A2:A"));
  const cols = plain(L.reportColumns(HEADER));
  cols[H.statedIn] = -1;
  assert.throws(() => L.monthlyHoursFormulas(cols, "Log"), /no "check-in stated \(user\)" column/);
});

test("monthlyHoursFormulas blank only FILTER's no-match result, so other errors show", () => {
  const f = plain(L.monthlyHoursFormulas(L.reportColumns(HEADER), "Log"));
  const cell = (a1) => f.cells.find((c) => c.a1 === a1).value;
  // FILTER with no rows gives #N/A; a deleted column (#REF!) or a bad name (#NAME?) must
  // still reach staff, as the note in cell C1 tells them.
  for (const a1 of ["H2", "A7", "C4"]) {
    assert.ok(cell(a1).startsWith("=IFNA("), a1 + " starts with IFNA");
    assert.ok(!cell(a1).startsWith("=IFERROR("), a1 + " has no outer IFERROR");
  }
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
  assert.ok(L.monthlyHoursDescription().startsWith(p.monthlyHours));
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
  // The Monthly Hours tab: one sheet protection of its own, the report tab's left alone.
  const sheetLevel = [
    { key: "sheet", description: L.monthlyHoursDescription() },
    { key: "sheet", description: L.monthlyHoursDescription() },
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

test("pickerMonth keeps a yyyy-MM text month and otherwise shows the current month", () => {
  assert.equal(L.pickerMonth("2026-09", "2026-11-12"), "2026-09");
  assert.equal(L.pickerMonth(" 2025-12 ", "2026-11-12"), "2025-12");
  for (const bad of ["", "2026-11-01", "2026-13", "2026-00", "Nov 2026", "2026-1"]) {
    assert.equal(L.pickerMonth(bad, "2026-11-12"), "2026-11", bad);
  }
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
