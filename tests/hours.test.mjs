// Tests for the Hours tab block of apps-script/Logic.js: the table the refresh writes and
// how it matches the monthly report's counting, the volunteer labels, the state cells and
// B1's line, the state-cell writes of one hold, the open budget, and the tab's plan.
// Logic.js is loaded the way Apps Script loads it, one plain script in its own global
// scope, so results are compared through plain().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

const plain = (x) => JSON.parse(JSON.stringify(x));
const ZONE = "America/Chicago";
const clock = (ms) => formatInZone(new Date(ms), ZONE, "HH:mm");
const when = (ms) => formatInZone(new Date(ms), ZONE, "yyyy-MM-dd h:mm a");
/** A Central wall-clock time in November (UTC-6) as milliseconds. */
const at = (date, hhmm) => Date.parse(date + "T" + hhmm + ":00-06:00");
const labelsOf = (entries) => Object.fromEntries(L.hoursLabels(entries));

let nextRow = 2;
/** A Log row as reportEntry gives it; closed with a token and a kiosk start unless told. */
function row(o) {
  const date = o.date === undefined ? "2026-11-02" : o.date;
  const start =
    o.start === undefined
      ? at(/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "2026-11-02", "09:00")
      : o.start;
  return {
    row: o.row || nextRow++,
    shiftId: o.shiftId === undefined ? "s" + nextRow : o.shiftId,
    token: o.token === undefined ? "tok-a" : o.token,
    name: o.name === undefined ? "Ann Lee" : o.name,
    dateText: date,
    recordedInMs: start,
    statedInMs: start,
    recordedOutMs: NaN,
    statedOutMs: NaN,
    recordedHours: NaN,
    statedHours: NaN,
    alerts: o.alerts || "",
    notes: "",
    status: o.status === undefined ? "closed" : o.status,
    outBy: o.outBy || "kiosk",
    inBy: o.inBy || "kiosk",
    roleType: o.role || "",
    activity: o.activity || "",
    statedHoursCell: o.hours === undefined ? 2 : o.hours,
    recordedHoursCell: "",
  };
}

// ---------------------------------------------------------------------------
// The table against the frozen report's counting

function fixtureLog() {
  nextRow = 2;
  return [
    row({ token: "tok-a", name: "Ann Lee", date: "2026-10-05", hours: 3 }),
    row({ token: "tok-b", name: "Bo Tran", date: "2026-10-05", hours: "2.5" }),
    // Auto-closed: closed by the job, counted like any other.
    row({ token: "tok-a", name: "Ann Lee", date: "2026-10-20", hours: 4, outBy: "auto-close" }),
    // Imported: no times at all.
    row({
      token: "tok-c",
      name: "Cy Moss",
      date: "2026-10-21",
      start: NaN,
      hours: 1.25,
      inBy: "import",
      outBy: "import",
    }),
    // Open: not counted.
    row({ token: "tok-b", name: "Bo Tran", date: "2026-11-02", status: "open", hours: "" }),
    // Another status: not counted.
    row({ token: "tok-b", name: "Bo Tran", date: "2026-11-03", status: "void", hours: 5 }),
    // Closed with no token: not counted.
    row({ token: "", name: "Nobody", date: "2026-11-03", hours: 5 }),
    // Dates that can't be read: counted rows in no month.
    row({ token: "tok-a", name: "Ann Lee", date: "11/4/2026", hours: 6 }),
    row({ token: "tok-c", name: "Cy Moss", date: "soon", hours: 2 }),
    row({ token: "tok-a", name: "Ann Lee", date: "2026-11-04", hours: -1 }),
    row({ token: "tok-c", name: "Cy Moss", date: "2026-11-05", hours: "abc" }),
    row({ token: "tok-b", name: "Bo Tran", date: "2026-11-05", hours: 1.005 }),
    row({ token: "tok-d", name: "Ann Lee", date: "2026-11-06", hours: 2.75 }),
    row({ token: "tok-b", name: "Bo Tran", date: "2025-12-31", hours: 8 }),
  ];
}

test("for every month the table's shifts, hours and volunteers equal monthFigures'", () => {
  const entries = fixtureLog();
  const t = plain(L.hoursTable(entries, [], clock));
  const months = new Set(entries.map((e) => L.monthKey(e.dateText)).filter(Boolean));
  assert.deepEqual([...new Set(t.rows.map((r) => r[2]))].sort(), [...months].sort());
  const first = L.firstShifts(entries);
  for (const month of months) {
    const mine = t.rows.filter((r) => r[2] === month);
    const f = plain(L.monthFigures(entries, month, first));
    assert.equal(
      mine.reduce((s, r) => s + r[6], 0),
      f.shifts,
      month + " shifts",
    );
    assert.equal(
      Math.round(mine.reduce((s, r) => s + r[7], 0) * 100),
      f.hundredths,
      month + " hours",
    );
    assert.equal(new Set(mine.map((r) => r[5])).size, f.headcount, month + " volunteers");
  }
  // Every counted row with a month, and nothing else.
  assert.equal(
    t.rows.length,
    entries.filter((e) => L.isCountedRow(e) && L.monthKey(e.dateText)).length,
  );
});

test("the table's columns: dates, start in 24-hour Central time or no time, one shift, hours", () => {
  nextRow = 2;
  const entries = [
    row({
      token: "t1",
      name: "Ann",
      date: "2026-11-13",
      start: at("2026-11-13", "14:05"),
      hours: 1.5,
    }),
    row({
      token: "t1",
      name: "Ann",
      date: "2026-11-13",
      start: at("2026-11-13", "08:30"),
      hours: 2,
    }),
    row({ token: "t1", name: "Ann", date: "2026-11-12", start: NaN, hours: 1 }),
  ];
  const t = plain(L.hoursTable(entries, [], clock));
  assert.deepEqual(t.header, [
    "Date",
    "Year",
    "Month",
    "Weekday",
    "Start",
    "Volunteer",
    "Shifts",
    "Hours",
    "Role/Type",
    "Activity",
  ]);
  assert.deepEqual(t.rows, [
    ["2026-11-12", "2026", "2026-11", "Thursday", "no time", "Ann", 1, 1, "(not set)", "(not set)"],
    ["2026-11-13", "2026", "2026-11", "Friday", "08:30", "Ann", 1, 2, "(not set)", "(not set)"],
    ["2026-11-13", "2026", "2026-11", "Friday", "14:05", "Ann", 1, 1.5, "(not set)", "(not set)"],
  ]);
  assert.deepEqual(plain(L.hoursDataFormats()), [
    "@",
    "@",
    "@",
    "@",
    "@",
    "@",
    "0",
    "0.00",
    "@",
    "@",
  ]);
  // As text, 24-hour starts sort in clock order and "no time" after every time.
  assert.deepEqual(["14:05", "no time", "08:30", "23:59", "00:00"].sort(), [
    "00:00",
    "08:30",
    "14:05",
    "23:59",
    "no time",
  ]);
});

test("one spelling per Role/Type and Activity group: the group's latest row's, spaces collapsed", () => {
  nextRow = 2;
  const entries = [
    row({ token: "t1", date: "2026-11-01", role: "KITCHEN", activity: "Food  sorting" }),
    row({ token: "t2", date: "2026-11-02", role: "kitchen ", activity: "food sorting" }),
    row({ token: "t3", date: "2026-11-03", role: "Kitchen", activity: "" }),
    row({ token: "t3", date: "2026-11-04", role: "  Front   desk ", activity: "Greeting" }),
    // A later row with no month doesn't set a spelling.
    row({ token: "t3", date: "soon", role: "KiTcHeN", activity: "FOOD SORTING" }),
  ];
  const t = plain(L.hoursTable(entries, [], clock));
  assert.deepEqual(
    t.rows.map((r) => r[8]),
    ["Kitchen", "Kitchen", "Kitchen", "Front desk"],
  );
  assert.deepEqual(
    t.rows.map((r) => r[9]),
    ["food sorting", "food sorting", "(not set)", "Greeting"],
  );
  // The Log has no Role/Type or Activity column: reportEntry gives blanks.
  const none = plain(L.hoursTable([row({ role: "", activity: "" })], [], clock));
  assert.deepEqual(none.rows[0].slice(8), ["(not set)", "(not set)"]);
});

test("a name, role or activity starting with = is written with sheetText's apostrophe", () => {
  nextRow = 2;
  const t = plain(
    L.hoursTable(
      [row({ name: "=HYPERLINK(1)", role: "=Kitchen", activity: "+Sorting" })],
      [],
      clock,
    ),
  );
  assert.equal(t.rows[0][5], "'=HYPERLINK(1)");
  assert.equal(t.rows[0][8], "'=Kitchen");
  assert.equal(t.rows[0][9], "+Sorting");
});

test("a name, role or activity starting with an apostrophe keeps it through sheetText's second one", () => {
  nextRow = 2;
  const t = plain(
    L.hoursTable([row({ name: "'Neil Ray", role: "'Kitchen", activity: "Sorting" })], [], clock),
  );
  assert.equal(t.rows[0][5], "''Neil Ray");
  assert.equal(t.rows[0][8], "''Kitchen");
  assert.equal(t.rows[0][9], "Sorting");
});

test("no User Token appears anywhere in what the refresh writes", () => {
  const entries = fixtureLog().map((e) => ({ ...e, token: e.token ? "secret-" + e.token : "" }));
  const t = plain(L.hoursTable(entries, [{ name: "Ann", shiftId: "x", reviewed: false }], clock));
  assert.ok(!/secret/.test(JSON.stringify(t)));
});

test("row 3's counts: open rows, alerts, unreviewed flags and undatable counted rows over the whole Log", () => {
  nextRow = 2;
  const entries = [
    row({ status: "open", hours: "" }),
    row({ status: " OPEN ", hours: "", date: "2025-01-01" }),
    row({ alerts: "Arrival differs" }),
    row({ alerts: "Long shift", status: "open" }),
    row({ date: "11/4/2026" }),
    row({ date: "11/5/2026", token: "" }),
  ];
  const flags = [
    { name: "Ann", shiftId: "", reviewed: false },
    { name: "", shiftId: "s9", reviewed: false },
    { name: "Bo", shiftId: "s1", reviewed: true },
    { name: "", shiftId: "", reviewed: false },
  ];
  const t = plain(L.hoursTable(entries, flags, clock));
  assert.deepEqual(t.counts, { open: 3, alerts: 2, unreviewedFlags: 2, undatable: 1 });
  assert.equal(
    t.countsLine,
    "At the last refresh: 3 open shifts, not counted (see the Log's Kiosk: Open shifts view); " +
      "2 Log rows with Admin Alerts? set (see the Log's Kiosk: Flagged view); " +
      "2 unreviewed Flags rows (see the Flags tab's Flags: Unreviewed view); " +
      "1 counted row left out because the Date can't be read (see the monthly report's rows to review).",
  );
  const noFlags = plain(L.hoursTable(entries, null, clock));
  assert.equal(noFlags.counts.unreviewedFlags, null);
  assert.match(noFlags.countsLine, /unreviewed Flags rows: Run setupSheets to add the Flags tab;/);
  assert.match(L.hoursCountsLine(null), /once Hours is refreshed/);
  // The digest text changes with the counts as well as the rows.
  assert.notEqual(t.digestText, noFlags.digestText);
  assert.equal(L.hoursDigestCell("AB12"), "sha256:ab12");
});

test("an empty Log gives no rows and zero counts", () => {
  const t = plain(L.hoursTable([], [], clock));
  assert.deepEqual(t.rows, []);
  assert.deepEqual(t.counts, { open: 0, alerts: 0, unreviewedFlags: 0, undatable: 0 });
});

// ---------------------------------------------------------------------------
// Volunteer labels

/**
 * No two labels share a pivot line: distinct under normalizeName, under hoursLabelKey, and
 * under an upper-case fold, the way the live pivot grouped "Anna Straße" with "ANNA
 * STRASSE".
 */
function assertDistinct(labels) {
  const folds = [
    (l) => L.normalizeName(l),
    (l) => L.hoursLabelKey(l),
    (l) => L.hoursSpaced(l).toUpperCase(),
  ];
  for (const fold of folds) {
    const keys = Object.values(labels).map(fold);
    assert.equal(new Set(keys).size, keys.length, JSON.stringify(labels));
  }
}

test("labels: names equal under case or spacing get the first shift's date", () => {
  nextRow = 2;
  const labels = labelsOf([
    row({ token: "t1", name: "Ann Lee", date: "2026-10-01" }),
    row({ token: "t2", name: "ann  lee", date: "2026-11-02" }),
    row({ token: "t3", name: "Bo Tran", date: "2026-11-02" }),
  ]);
  assert.deepEqual(labels, {
    t1: "Ann Lee · first shift 2026-10-01",
    t2: "ann lee · first shift 2026-11-02",
    t3: "Bo Tran",
  });
  assertDistinct(labels);
});

test("labels: namesakes whose first shifts share a date also get their first Log row", () => {
  nextRow = 2;
  const labels = labelsOf([
    row({ token: "t1", name: "Ann Lee", date: "2026-11-02", row: 7 }),
    row({ token: "t2", name: "Ann Lee", date: "2026-11-02", row: 9 }),
    row({ token: "t3", name: "Ann Lee", date: "2026-11-05", row: 12 }),
  ]);
  assert.deepEqual(labels, {
    t1: "Ann Lee · first shift 2026-11-02, Log row 7",
    t2: "Ann Lee · first shift 2026-11-02, Log row 9",
    t3: "Ann Lee · first shift 2026-11-05",
  });
  assertDistinct(labels);
});

test("labels: a token renamed on its latest row takes the new name; a blank name is (no name)", () => {
  nextRow = 2;
  const labels = labelsOf([
    row({ token: "t1", name: "Ann Lee", date: "2026-10-01" }),
    row({ token: "t1", name: "Ann  Smith ", date: "2026-11-01" }),
    row({ token: "t2", name: "", date: "2026-11-01" }),
    row({ token: "t3", name: "  ", date: "2026-11-03" }),
  ]);
  assert.deepEqual(labels, {
    t1: "Ann Smith",
    t2: "(no name) · first shift 2026-11-01",
    t3: "(no name) · first shift 2026-11-03",
  });
});

test("labels: a typed name equal to another token's first-shift or Log-row label is still told apart", () => {
  nextRow = 2;
  const typedRule2 = labelsOf([
    row({ token: "t1", name: "Ann", date: "2026-11-02", row: 5 }),
    row({ token: "t2", name: "Ann", date: "2026-11-03", row: 6 }),
    row({ token: "t3", name: "ann · first shift 2026-11-02", date: "2026-11-04", row: 8 }),
  ]);
  assert.deepEqual(typedRule2, {
    t1: "Ann · first shift 2026-11-02, Log row 5",
    t2: "Ann · first shift 2026-11-03",
    t3: "ann · first shift 2026-11-02, Log row 8",
  });
  assertDistinct(typedRule2);

  // A typed name equal to a label with a Log row: the loop runs again for it.
  const typedRule3 = labelsOf([
    row({ token: "t1", name: "Ann", date: "2026-11-02", row: 5 }),
    row({ token: "t2", name: "Ann", date: "2026-11-02", row: 6 }),
    row({
      token: "t3",
      name: "Ann · first shift 2026-11-02, Log row 5",
      date: "2026-11-04",
      row: 9,
    }),
  ]);
  assert.deepEqual(typedRule3, {
    t1: "Ann · first shift 2026-11-02, Log row 5",
    t2: "Ann · first shift 2026-11-02, Log row 6",
    t3: "Ann · first shift 2026-11-02, Log row 5, Log row 9",
  });
  assertDistinct(typedRule3);

  // Someone named "Ann, Log row 12": the next pass gives that one its own row.
  const chain = labelsOf([
    row({ token: "t1", name: "Ann", date: "2026-11-02", row: 12 }),
    row({ token: "t2", name: "Ann", date: "2026-11-02", row: 13 }),
    row({
      token: "t3",
      name: "Ann · first shift 2026-11-02, Log row 12",
      date: "2026-11-02",
      row: 14,
    }),
    row({
      token: "t4",
      name: "Ann · first shift 2026-11-02, Log row 12, Log row 14",
      date: "2026-11-09",
      row: 15,
    }),
  ]);
  assertDistinct(chain);
});

test("labels: a counted row with no month changes no label", () => {
  nextRow = 2;
  const base = [
    row({ token: "t1", name: "Ann", date: "2026-11-02" }),
    row({ token: "t2", name: "Bo", date: "2026-11-03" }),
  ];
  const withUndated = [...base, row({ token: "t1", name: "Bo", date: "11/30/2026" })];
  assert.deepEqual(labelsOf(withUndated), labelsOf(base));
  assert.deepEqual(labelsOf(base), { t1: "Ann", t2: "Bo" });
});

test("labels outside ASCII: Zoë and ZOË and Straße and STRASSE get suffixes, İpek and ipek don't", () => {
  // normalizeName itself is unchanged: the kiosk's matching uses it.
  assert.equal(L.normalizeName("Zoë"), L.normalizeName("ZOË"));
  assert.notEqual(L.normalizeName("İpek"), L.normalizeName("ipek"));
  assert.notEqual(L.normalizeName("Straße"), L.normalizeName("STRASSE"));
  // The label key folds case through upper case, as the pivot does.
  assert.equal(L.hoursLabelKey("Zoë"), L.hoursLabelKey("ZOË"));
  assert.notEqual(L.hoursLabelKey("İpek"), L.hoursLabelKey("ipek"));
  assert.equal(L.hoursLabelKey("Anna Straße"), L.hoursLabelKey("ANNA  STRASSE "));
  nextRow = 2;
  const labels = labelsOf([
    row({ token: "z1", name: "Zoë", date: "2026-11-01" }),
    row({ token: "z2", name: "ZOË", date: "2026-11-02" }),
    row({ token: "i1", name: "İpek", date: "2026-11-01" }),
    row({ token: "i2", name: "ipek", date: "2026-11-02" }),
    row({ token: "s1", name: "Straße", date: "2026-11-01" }),
    row({ token: "s2", name: "STRASSE", date: "2026-11-02" }),
  ]);
  assert.deepEqual(labels, {
    z1: "Zoë · first shift 2026-11-01",
    z2: "ZOË · first shift 2026-11-02",
    i1: "İpek",
    i2: "ipek",
    s1: "Straße · first shift 2026-11-01",
    s2: "STRASSE · first shift 2026-11-02",
  });
  assertDistinct(labels);
});

test("labels outside ASCII on the live check's pairs: the month's volunteers equal monthFigures' headcount under the pivot's grouping", () => {
  nextRow = 2;
  const pairs = [
    ["Zoë Park", "ZOË PARK"],
    ["İpek Demir", "ipek demir"],
    ["Anna Straße", "ANNA STRASSE"],
  ];
  const entries = pairs.flatMap(([a, b], i) => [
    row({ token: "a" + i, name: a, date: "2026-11-03", hours: 1.5 }),
    row({ token: "b" + i, name: b, date: "2026-11-04", hours: 1.5 }),
  ]);
  const labels = labelsOf(entries);
  assert.deepEqual(labels, {
    a0: "Zoë Park · first shift 2026-11-03",
    b0: "ZOË PARK · first shift 2026-11-04",
    a1: "İpek Demir",
    b1: "ipek demir",
    a2: "Anna Straße · first shift 2026-11-03",
    b2: "ANNA STRASSE · first shift 2026-11-04",
  });
  assertDistinct(labels);
  const t = plain(L.hoursTable(entries, [], clock));
  const f = plain(L.monthFigures(entries, "2026-11", L.firstShifts(entries)));
  assert.equal(f.headcount, 6);
  assert.equal(new Set(t.rows.map((r) => L.hoursLabelKey(r[5]))).size, f.headcount);
  assert.equal(new Set(t.rows.map((r) => r[5].toUpperCase())).size, f.headcount);
});

test("labels stay distinct under normalizeName on a large mixed fixture", () => {
  nextRow = 2;
  const names = [
    "Ann Lee",
    "ann lee",
    "ANN  LEE",
    "Bo",
    "",
    "Ann Lee · first shift 2026-11-01",
    "Ann Lee · first shift 2026-11-01, Log row 2",
    "Anna Straße",
    "ANNA STRASSE",
  ];
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push(
      row({
        token: "t" + (i % 23),
        name: names[i % names.length],
        date: "2026-11-0" + (1 + (i % 3)),
      }),
    );
  }
  const labels = labelsOf(entries);
  assert.equal(Object.keys(labels).length, 23);
  assertDistinct(labels);
});

// ---------------------------------------------------------------------------
// The state cells

const T0 = at("2026-11-13", "09:14");
const DIGEST = "sha256:" + "a".repeat(64);

test("hoursState reads each cell in its form and anything else as unknown", () => {
  const s = plain(
    L.hoursState([
      String(T0),
      "writing 123",
      "refreshed|menu|" + T0 + "|" + (T0 + 5) + "|",
      "1|2|3|40",
      DIGEST,
      "built 77",
    ]),
  );
  assert.deepEqual(s, {
    tableTime: T0,
    table: { kind: "writing", ms: 123 },
    note: { kind: "refreshed", cause: "menu", t: T0, w: T0 + 5, message: "" },
    lastWrite: { readMs: 1, workMs: 2, writeMs: 3, rows: 40 },
    digest: DIGEST,
    build: { kind: "built", ms: 77 },
  });
  // Digits read as digits whether text or a number.
  assert.equal(L.hoursState([T0]).tableTime, T0);
  assert.equal(L.hoursState([" " + T0 + " "]).tableTime, T0);
  assert.deepEqual(plain(L.hoursState(["", "stopped"]).table), { kind: "stopped", ms: null });
  assert.deepEqual(plain(L.hoursState(["", "stopped 9"]).table), { kind: "stopped", ms: 9 });
  assert.deepEqual(plain(L.hoursState(["", "complete"]).table), { kind: "complete" });
  const unknown = plain(L.hoursState([]));
  assert.deepEqual(unknown, {
    tableTime: null,
    table: null,
    note: null,
    lastWrite: null,
    digest: null,
    build: null,
  });
  for (const bad of [
    ["2026-11-13", "Complete", "refreshed|menu|1|2|oops", "1|2|3", "sha256:xyz", "building"],
    [-5, "writing", "refreshed|lunch|1|2|", "1|2|3|x", "md5:" + "a".repeat(32), "built soon"],
    [1.5, "writing 1 2", "failed-read|menu|1|2", "", "", "built 1 2"],
    [new Date(0), "stopped -1", "open-skipped|open|1|2|other", "", "", ""],
    ["", "", "open-skipped|menu|1|2|too-big", "", "", ""],
    ["", "", "refreshed|menu|1|2|a message", "", "", ""],
  ]) {
    assert.deepEqual(plain(L.hoursState(bad)), unknown, JSON.stringify(bad));
  }
  assert.deepEqual(
    plain(L.hoursState(["", "", "failed-write|nightly|1|2|Boom: it broke", ""]).note),
    {
      kind: "failed-write",
      cause: "nightly",
      t: 1,
      w: 2,
      message: "Boom: it broke",
    },
  );
});

test("N1 and O1 are written in the form hoursState reads", () => {
  const long = "x".repeat(150);
  const n = L.hoursNoteCell("failed-read", "menu", 5, 6, "a | b\n  c " + long);
  assert.equal(n, "failed-read|menu|5|6|" + ("a / b c " + long).slice(0, 100));
  assert.equal(L.hoursState(["", "", n]).note.message.length, 100);
  assert.equal(L.hoursTimingCell({ readMs: 1.4, workMs: 2, writeMs: 3, rows: 4 }), "1|2|3|4");
  assert.deepEqual(
    plain(
      L.hoursState(["", "", "", L.hoursTimingCell({ readMs: 1, workMs: 2, writeMs: 3, rows: 0 })])
        .lastWrite,
    ),
    {
      readMs: 1,
      workMs: 2,
      writeMs: 3,
      rows: 0,
    },
  );
});

// ---------------------------------------------------------------------------
// B1's line

/** Cells as text from a few named values. */
const cells = (o) => [o.L ?? "", o.M ?? "", o.N ?? "", o.O ?? "", o.P ?? "", o.Q ?? "built 1"];
const line = (o) => L.hoursLine(L.hoursState(cells(o)), when);
const T1 = T0 + 60000;
const W = T0 + 120000;

test("B1's table part: not set up, being set up, refreshing, stopped, and whole", () => {
  assert.equal(line({ Q: "" }), "Hours is not set up: run setupReports.");
  assert.equal(
    line({ Q: "building " + T0, M: "complete", L: T0 }),
    "Hours is being set up by setupReports since 2026-11-13 9:14 AM; if this stays over 5 minutes, run setupReports again.",
  );
  assert.equal(
    line({ M: "writing " + T0, L: T0 }),
    "Refreshing since 2026-11-13 9:14 AM. If this stays over 5 minutes, use Kiosk admin > Refresh Hours.",
  );
  assert.equal(
    line({ M: "stopped " + T0, L: T0 }),
    "A refresh at 2026-11-13 9:14 AM stopped part way, so the tables may be incomplete: use Kiosk admin > Refresh Hours.",
  );
  const noTime =
    "A refresh stopped part way, so the tables may be incomplete: use Kiosk admin > Refresh Hours.";
  assert.equal(line({ M: "stopped", L: T0 }), noTime);
  assert.equal(line({ M: "", L: T0 }), noTime);
  assert.equal(line({ M: "complete", L: "" }), noTime);
  assert.equal(line({ M: "complete", L: T0 }), "As of 2026-11-13 9:14 AM.");
});

test("B1's note part for every kind, cause and skip reason", () => {
  const whole = { M: "complete", L: T1 };
  const note = (n) => line({ ...whole, N: n });
  assert.equal(
    note("refreshed|nightly|" + T0 + "|" + W + "|"),
    "As of 2026-11-13 9:15 AM. Refreshed nightly at 2026-11-13 9:14 AM.",
  );
  assert.equal(
    note("failed-read|menu|" + T0 + "|" + W + "|Log column missing"),
    "As of 2026-11-13 9:15 AM. The refresh from the menu at 2026-11-13 9:14 AM failed before writing: Log column missing.",
  );
  assert.equal(
    note("failed-write|setupReports|" + T0 + "|" + W + "|Service error."),
    "As of 2026-11-13 9:15 AM. The refresh by setupReports at 2026-11-13 9:14 AM failed part way: Service error.",
  );
  assert.equal(
    note("failed-read|open|" + T0 + "|" + W + "|"),
    "As of 2026-11-13 9:15 AM. The refresh on open at 2026-11-13 9:14 AM failed before writing.",
  );
  assert.equal(
    note("open-skipped|open|" + W + "|" + W + "|note-only"),
    "As of 2026-11-13 9:15 AM. Not refreshed on open at 2026-11-13 9:16 AM: use Kiosk admin > Refresh Hours for newer taps.",
  );
  assert.equal(
    note("open-skipped|open|" + T0 + "|" + W + "|too-big"),
    "As of 2026-11-13 9:15 AM. Not refreshed on open at 2026-11-13 9:16 AM (the Log is too big to refresh on open now): use Kiosk admin > Refresh Hours for newer taps.",
  );
  assert.equal(
    note("open-skipped|open|" + T0 + "|" + W + "|no-timing"),
    "As of 2026-11-13 9:15 AM. Not refreshed on open at 2026-11-13 9:16 AM (no write timing yet): use Kiosk admin > Refresh Hours for newer taps.",
  );
  assert.equal(note("garbage"), "As of 2026-11-13 9:15 AM.");
});

test("B1's two joins, and the pairs that stay two sentences", () => {
  assert.equal(
    line({ M: "complete", L: T0, N: "refreshed|open|" + T0 + "|" + W + "|" }),
    "As of 2026-11-13 9:14 AM, refreshed on open.",
  );
  assert.equal(
    line({ M: "stopped " + T0, L: T0 - 1, N: "failed-write|menu|" + T0 + "|" + W + "|Boom" }),
    "The refresh from the menu at 2026-11-13 9:14 AM failed part way: Boom. The tables may be incomplete: use Kiosk admin > Refresh Hours.",
  );
  // Refreshed at another time than L1: two sentences.
  assert.equal(
    line({ M: "complete", L: T1, N: "refreshed|menu|" + T0 + "|" + W + "|" }),
    "As of 2026-11-13 9:15 AM. Refreshed from the menu at 2026-11-13 9:14 AM.",
  );
  // M1 stopped t with a later failed-read note gives both sentences.
  assert.equal(
    line({ M: "stopped " + T0, L: T0 - 1, N: "failed-read|menu|" + T1 + "|" + W + "|Busy" }),
    "A refresh at 2026-11-13 9:14 AM stopped part way, so the tables may be incomplete: use Kiosk admin > Refresh Hours. The refresh from the menu at 2026-11-13 9:15 AM failed before writing: Busy.",
  );
  // A failed-write note whose time isn't M1's: two sentences.
  assert.equal(
    line({ M: "stopped " + T1, L: T0, N: "failed-write|nightly|" + T0 + "|" + W + "|Boom" }),
    "A refresh at 2026-11-13 9:15 AM stopped part way, so the tables may be incomplete: use Kiosk admin > Refresh Hours. The refresh nightly at 2026-11-13 9:14 AM failed part way: Boom.",
  );
  // A refreshed note doesn't join a table that isn't whole.
  assert.equal(
    line({ M: "writing " + T1, L: T0, N: "refreshed|menu|" + T0 + "|" + W + "|" }),
    "Refreshing since 2026-11-13 9:15 AM. If this stays over 5 minutes, use Kiosk admin > Refresh Hours. Refreshed from the menu at 2026-11-13 9:14 AM.",
  );
  // Being set up keeps its table part whatever the note.
  assert.match(
    line({ Q: "building " + T0, M: "complete", L: T0, N: "refreshed|menu|" + T0 + "|" + W + "|" }),
    /^Hours is being set up by setupReports since .*\. Refreshed from the menu at /,
  );
});

// ---------------------------------------------------------------------------
// The writes of one hold

const sets = (r) =>
  r.steps.filter((s) => s.op === "set").map((s) => s.cell + "=" + (s.timing ? "timing" : s.value));
const ops = (r) => r.steps.map((s) => (s.op === "set" ? "set " + s.cell : s.op));
const state = (o) => L.hoursState(cells(o));
const RUN = {
  cause: "menu",
  t: T1,
  w: W,
  mark: T1,
  held: false,
  markWritten: false,
  digest: DIGEST,
  rows: 3,
};
const next = (o, run, outcome) =>
  plain(L.hoursNextState(state(o), { ...RUN, ...run }, outcome || { kind: "read" }));

test("settle on entry: writing t becomes stopped t, an unknown M1 stopped, first; a held hold isn't settled again", () => {
  const r = next({ M: "writing 55", L: T0 });
  assert.deepEqual(r.steps[0], { op: "set", cell: "M1", value: "stopped 55" });
  assert.equal(r.decision, "write");
  const u = next({ M: "garbage", L: T0 });
  assert.deepEqual(u.steps[0], { op: "set", cell: "M1", value: "stopped" });
  for (const outcome of [
    { kind: "failed", message: "x" },
    { kind: "note-only" },
    { kind: "setup-start" },
  ]) {
    assert.deepEqual(next({ M: "writing 55" }, {}, outcome).steps[0], {
      op: "set",
      cell: "M1",
      value: "stopped 55",
    });
  }
  // A whole table needs no settling.
  assert.deepEqual(next({ M: "complete", L: T0 }).steps[0], {
    op: "set",
    cell: "M1",
    value: "writing " + T1,
  });
  // Held: this hold settled already, and M1's "writing" is its own.
  const held = next(
    { M: "writing " + T1, L: T0 },
    { held: true, markWritten: true, cause: "setupReports" },
  );
  assert.ok(!sets(held).includes("M1=stopped " + T1));
});

test("ordered by read time: a whole table at L1 >= T means no state cell, for a success and a failure alike", () => {
  for (const L1 of [T1, T1 + 1]) {
    const a = next({ M: "complete", L: L1 });
    assert.equal(a.decision, "newer-in");
    assert.deepEqual(sets(a), []);
    assert.deepEqual(ops(a), ["render", "flush"]);
    const f = next({ M: "complete", L: L1 }, {}, { kind: "failed", message: "boom" });
    assert.equal(f.decision, "quiet");
    assert.deepEqual(sets(f), []);
    assert.deepEqual(ops(f), ["render", "flush"]);
  }
  // A whole table read earlier is replaced.
  assert.equal(next({ M: "complete", L: T1 - 1 }).decision, "write");
  // M1 not complete: any table replaces it, older or newer.
  for (const M of ["stopped " + (T1 + 9), "stopped", "writing " + (T1 + 9), ""]) {
    assert.equal(next({ M, L: T1 + 5 }).decision, "write", M);
    assert.equal(
      next({ M, L: T1 + 5 }, {}, { kind: "failed", message: "x" }).decision,
      "failed-read",
      M,
    );
  }
  // L1 unknown: not whole.
  assert.equal(next({ M: "complete", L: "" }).decision, "write");
  // setupReports is never stopped by a newer table.
  assert.equal(
    next({ M: "complete", L: T1 + 5 }, { cause: "setupReports", held: true }).decision,
    "write",
  );
});

test("whole only after flush: writing and its flush come before the first table change, complete last after the next flush", () => {
  const r = next({ M: "complete", L: T0, N: "refreshed|nightly|1|2|" });
  assert.equal(r.decision, "write");
  assert.deepEqual(ops(r), [
    "set M1",
    "render",
    "flush",
    "grow",
    "values",
    "trim",
    "counts",
    "flush",
    "set L1",
    "set P1",
    "set O1",
    "set N1",
    "set M1",
    "render",
    "flush",
  ]);
  assert.deepEqual(sets(r), [
    "M1=writing " + T1,
    "L1=" + T1,
    "P1=" + DIGEST,
    "O1=timing",
    "N1=refreshed|menu|" + T1 + "|" + W + "|",
    "M1=complete",
  ]);
  // No rows: A2:J2 is cleared after the setValues and before the trim.
  const empty = ops(next({ M: "complete", L: T0 }, { rows: 0 }));
  assert.deepEqual(empty.slice(3, 8), ["grow", "values", "clear", "trim", "counts"]);
  // setupReports' own mark is already in M1: no second writing.
  const s = next(
    { M: "writing 40", L: T0, Q: "built 40" },
    { cause: "setupReports", mark: 40, held: true, markWritten: true },
  );
  assert.deepEqual(ops(s).slice(0, 3), ["render", "flush", "grow"]);
  assert.ok(sets(s).includes("L1=" + T1));
  assert.equal(sets(s).at(-1), "M1=complete");
  // Nothing else writes complete.
  for (const outcome of [
    { kind: "failed", message: "x" },
    { kind: "note-only" },
    { kind: "setup-start" },
    { kind: "setup-built" },
  ]) {
    assert.ok(
      !sets(next({ M: "stopped 1", L: T0 }, {}, outcome)).includes("M1=complete"),
      outcome.kind,
    );
  }
});

test("a throw after the mark is in M1 leaves it stopped with a failed-write note; before, a failed-read note", () => {
  // The run put its mark in M1 in this hold, then threw (after grow, values, trim, or
  // between L1 and M1): M1 still holds the mark.
  const w = next(
    { M: "writing " + T1, L: T1 },
    { held: true, markWritten: true },
    { kind: "failed", message: "Boom" },
  );
  assert.equal(w.decision, "failed-write");
  assert.deepEqual(sets(w), ["M1=stopped " + T1, "N1=failed-write|menu|" + T1 + "|" + W + "|Boom"]);
  assert.deepEqual(ops(w).slice(-2), ["render", "flush"]);
  assert.equal(
    L.hoursLine(
      L.hoursState(
        cells({ M: "stopped " + T1, L: T1, N: "failed-write|menu|" + T1 + "|" + W + "|Boom" }),
      ),
      when,
    ),
    "The refresh from the menu at 2026-11-13 9:15 AM failed part way: Boom. The tables may be incomplete: use Kiosk admin > Refresh Hours.",
  );
  // A throw in the read: the hold settles and writes a failed-read note.
  const r = next({ M: "writing 9", L: T0 }, {}, { kind: "failed", message: "Log column missing" });
  assert.equal(r.decision, "failed-read");
  assert.deepEqual(sets(r), [
    "M1=stopped 9",
    "N1=failed-read|menu|" + T1 + "|" + W + "|Log column missing",
  ]);
  // setupReports writes a failed-write note only while M1 holds its mark.
  const sr = { cause: "setupReports", mark: 40, held: true, markWritten: true };
  assert.equal(
    next({ M: "writing 40" }, sr, { kind: "failed", message: "x" }).decision,
    "failed-write",
  );
  assert.equal(
    next({ M: "complete", L: T1 }, sr, { kind: "failed", message: "x" }).decision,
    "quiet",
  );
  assert.equal(
    next({ M: "writing 40" }, { ...sr, markWritten: false }, { kind: "failed", message: "x" })
      .decision,
    "quiet",
  );
});

test("one note per run, replacing N1 with no comparison", () => {
  const newer = "refreshed|nightly|" + (W + 99999) + "|" + (W + 99999) + "|";
  const cases = [
    [{ M: "complete", L: T0, N: newer }, {}, { kind: "read" }],
    [{ M: "stopped 1", L: T0, N: newer }, {}, { kind: "failed", message: "x" }],
    [{ M: "complete", L: T0, N: newer }, { cause: "open", budget: "too-big" }, { kind: "read" }],
    [
      { M: "complete", L: T0, N: newer, P: DIGEST },
      { cause: "open", budget: "ok" },
      { kind: "read" },
    ],
    [{ M: "complete", L: T0, N: newer }, { cause: "open" }, { kind: "note-only" }],
  ];
  for (const [o, run, outcome] of cases) {
    const r = next(o, run, outcome);
    assert.equal(sets(r).filter((s) => s.startsWith("N1=")).length, 1, r.decision);
  }
});

test("on open: a note only when over budget, L1 moved when the digest is unchanged, and never that from the menu or nightly", () => {
  const b = next({ M: "complete", L: T0 }, { cause: "open", budget: "too-big" });
  assert.equal(b.decision, "skipped");
  assert.deepEqual(sets(b), ["N1=open-skipped|open|" + T1 + "|" + W + "|too-big"]);
  assert.equal(
    next({ M: "complete", L: T0 }, { cause: "open", budget: "no-timing" }).decision,
    "skipped",
  );
  // A newer table in comes before the budget.
  assert.equal(
    next({ M: "complete", L: T1 }, { cause: "open", budget: "too-big" }).decision,
    "newer-in",
  );
  const c = next({ M: "complete", L: T0, P: DIGEST }, { cause: "open", budget: "ok" });
  assert.equal(c.decision, "unchanged");
  assert.deepEqual(sets(c), ["L1=" + T1, "N1=refreshed|open|" + T1 + "|" + W + "|"]);
  assert.deepEqual(ops(c), ["set L1", "set N1", "render", "flush"]);
  // Digest equal but the table isn't whole: a full write.
  assert.equal(
    next({ M: "stopped 3", L: T0, P: DIGEST }, { cause: "open", budget: "ok" }).decision,
    "write",
  );
  // A changed digest: a full write.
  assert.equal(
    next({ M: "complete", L: T0, P: "sha256:" + "b".repeat(64) }, { cause: "open", budget: "ok" })
      .decision,
    "write",
  );
  for (const cause of ["menu", "nightly"]) {
    assert.equal(next({ M: "complete", L: T0, P: DIGEST }, { cause }).decision, "write", cause);
  }
  const n = next({ M: "writing 4", L: T1 + 50 }, { cause: "open" }, { kind: "note-only" });
  assert.deepEqual(sets(n), ["M1=stopped 4", "N1=open-skipped|open|" + W + "|" + W + "|note-only"]);
});

test("setupReports' state writes: building and writing S together, then built", () => {
  const s = next(
    { M: "complete", L: T0, Q: "built 3" },
    { cause: "setupReports", mark: 40 },
    { kind: "setup-start" },
  );
  assert.deepEqual(sets(s), ["M1=writing 40", "Q1=building 40"]);
  assert.deepEqual(ops(s).slice(-2), ["render", "flush"]);
  const b = next(
    { M: "writing 40", Q: "building 40" },
    { cause: "setupReports", mark: 40, held: true, markWritten: true },
    { kind: "setup-built" },
  );
  assert.deepEqual(sets(b), ["Q1=built 40"]);
});

test("every hold ends with a render then a flush, and every state write is rendered before the next flush", () => {
  const outcomes = [
    { kind: "read" },
    { kind: "failed", message: "m" },
    { kind: "note-only" },
    { kind: "setup-start" },
    { kind: "setup-built" },
  ];
  const states = [
    { M: "complete", L: T0 },
    { M: "complete", L: T1 },
    { M: "writing 7" },
    { M: "" },
    { M: "complete", L: T0, P: DIGEST },
  ];
  const runs = [
    {},
    { cause: "open", budget: "ok" },
    { cause: "open", budget: "too-big" },
    { cause: "setupReports", held: true, markWritten: true, mark: 7 },
  ];
  for (const o of states) {
    for (const run of runs) {
      for (const outcome of outcomes) {
        const list = ops(next(o, run, outcome));
        assert.deepEqual(list.slice(-2), ["render", "flush"]);
        let dirty = false;
        for (const op of list) {
          if (op.startsWith("set")) dirty = true;
          if (op === "render") dirty = false;
          if (op === "flush") assert.ok(!dirty, JSON.stringify([o, run, outcome, list]));
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The open budget

test("the open budget: too big over 20 s with O1's write time scaled by rows, no timing without O1", () => {
  const s = (o1) => L.hoursState(["", "", "", o1]);
  assert.equal(L.hoursBudget(1000, s(""), 100), "no-timing");
  assert.equal(L.hoursBudget(1000, s("garbage"), 100), "no-timing");
  // 3 s so far + 2 s lock wait + 5 s write = 10 s.
  assert.equal(L.hoursBudget(3000, s("1|1|5000|1000"), 1000), "ok");
  // Twice the rows: 3 + 2 + 10 = 15 s.
  assert.equal(L.hoursBudget(3000, s("1|1|5000|1000"), 2000), "ok");
  // Four times: 3 + 2 + 20 = 25 s.
  assert.equal(L.hoursBudget(3000, s("1|1|5000|1000"), 4000), "too-big");
  // Fewer rows never scale below 1: 13 + 2 + 5 = 20 s, not over.
  assert.equal(L.hoursBudget(13000, s("1|1|5000|1000"), 10), "ok");
  assert.equal(L.hoursBudget(13001, s("1|1|5000|1000"), 10), "too-big");
  // O1 written for an empty table: rows counted as at least 1.
  assert.equal(L.hoursBudget(0, s("1|1|10|0"), 5000), "too-big");
});

// ---------------------------------------------------------------------------
// The Hours tab's plan

test("one GridRange for every pivot and every slicer: Hours data from row 1, no end row, A to J", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const source = { sheetId: 22, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 10 };
  assert.deepEqual(plain(L.hoursSourceRange(22)), source);
  assert.equal(plan.pivots.length, 3);
  assert.equal(plan.slicers.length, 7);
  for (const p of plan.pivots)
    assert.deepEqual(p.updateCells.rows[0].values[0].pivotTable.source, source);
  for (const s of plan.slicers) assert.deepEqual(s.addSlicer.slicer.spec.dataRange, source);
  // No slicer is on Shifts (G), and every pivot filters on it. From date reads A and To
  // date D: two slicers on one column would share one filter.
  const headers = plain(L.hoursDataHeaders());
  assert.deepEqual(
    plan.slicers.map((s) => [s.addSlicer.slicer.spec.columnIndex, s.addSlicer.slicer.spec.title]),
    [
      [1, "Year"],
      [2, "Month"],
      [8, "Role/Type"],
      [9, "Activity"],
      [5, "Volunteer"],
      [0, "From date"],
      [3, "To date"],
    ],
  );
  assert.deepEqual(
    plan.slicers.slice(0, 5).map((s) => headers[s.addSlicer.slicer.spec.columnIndex]),
    ["Year", "Month", "Role/Type", "Activity", "Volunteer"],
  );
  for (const s of plan.slicers) assert.equal(s.addSlicer.slicer.spec.applyToPivotTables, true);
  // Five in row 5 and the two date slicers in row 6, each row from column A at 250 px
  // steps: wide enough that "Role/Type" and "Volunteer" show in full beside the "All"
  // chip, side by side without overlapping, and 32 px high in 38 px rows.
  const boxes = plan.slicers.map((s) => s.addSlicer.slicer.position.overlayPosition);
  assert.deepEqual(
    boxes.map((b) => [b.anchorCell.sheetId, b.anchorCell.rowIndex, b.anchorCell.columnIndex]),
    [0, 0, 0, 0, 0, 1, 1].map((r) => [11, 4 + r, 0]),
  );
  assert.deepEqual(
    boxes.map((b) => b.offsetXPixels),
    [0, 250, 500, 750, 1000, 0, 250],
  );
  for (const b of boxes) {
    assert.equal(b.widthPixels, 240);
    assert.equal(b.heightPixels, 32);
    assert.equal(b.offsetYPixels, 2);
  }
  for (const p of plan.pivots) {
    const f = p.updateCells.rows[0].values[0].pivotTable.filterSpecs;
    assert.deepEqual(
      f.map((x) => [headers[x.columnOffsetIndex], x.filterCriteria.condition.type]),
      [["Shifts", "NUMBER_EQ"]],
    );
  }
});

test("the three pivots: where they sit, their rows and values", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const headers = plain(L.hoursDataHeaders());
  const at = plan.pivots.map((p) => [
    p.updateCells.start.sheetId,
    p.updateCells.start.rowIndex,
    p.updateCells.start.columnIndex,
  ]);
  assert.deepEqual(at, [
    [11, 7, 0],
    [11, 7, 4],
    [11, 7, 10],
  ]);
  const [vol, month, shifts] = plan.pivots.map((p) => p.updateCells.rows[0].values[0].pivotTable);
  assert.deepEqual(
    vol.rows.map((r) => [headers[r.sourceColumnOffset], r.sortOrder, r.showTotals, r.valueBucket]),
    [["Volunteer", "DESCENDING", true, { valuesIndex: 1 }]],
  );
  assert.deepEqual(
    vol.values.map((v) => v.name),
    ["Shifts", "Hours"],
  );
  assert.deepEqual(
    month.rows.map((r) => [headers[r.sourceColumnOffset], r.sortOrder, r.showTotals]),
    [["Month", "ASCENDING", true]],
  );
  assert.deepEqual(
    month.values.map((v) => [v.name, v.summarizeFunction]),
    [
      ["Shifts", "SUM"],
      ["Hours", "SUM"],
      ["Volunteers", "COUNTUNIQUE"],
      ["Average shift", "CUSTOM"],
    ],
  );
  assert.equal(month.values[3].formula, "=SUM(Hours)/SUM(Shifts)");
  // One line per shift: the Shift label (K, offset 10) sorted by its box, newest first to
  // start, then Role/Type and Activity as repeated labels with no totals.
  assert.deepEqual(
    shifts.rows.map((r) => [
      r.sourceColumnOffset,
      r.label,
      r.sortOrder,
      r.showTotals,
      r.repeatHeadings,
      r.valueBucket,
    ]),
    [
      [10, "Shift", "DESCENDING", true, true, undefined],
      [8, "Role/Type", "ASCENDING", false, true, undefined],
      [9, "Activity", "ASCENDING", false, true, undefined],
    ],
  );
  assert.deepEqual(
    shifts.values.map((v) => [headers[v.sourceColumnOffset], v.summarizeFunction]),
    [["Hours", "SUM"]],
  );
});

test("the Grand Total rules come before the stripe rules, and every body row gets a fill", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const rules = plan.rules.map((r) => r.addConditionalFormatRule);
  assert.deepEqual(
    rules.map((r) => r.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  const formulas = rules.map((r) => r.rule.booleanRule.condition.values[0].userEnteredValue);
  assert.deepEqual(formulas.slice(0, 3), [
    '=$A9 = "Grand Total"',
    '=$E9 = "Grand Total"',
    '=$K9 = "Grand Total"',
  ]);
  assert.ok(formulas.slice(3, 6).every((f) => /ISEVEN\(ROW\(\)\)/.test(f)));
  assert.ok(formulas.slice(6).every((f) => /ISODD\(ROW\(\)\)/.test(f)));
  for (const r of rules) {
    assert.equal(r.rule.ranges[0].sheetId, 11);
    assert.equal(r.rule.ranges[0].startRowIndex, 8);
    assert.equal(r.rule.ranges[0].endRowIndex, undefined);
  }
  // Each pivot's rules cover its columns: A to C, E to I, and K to N for Shifts.
  assert.deepEqual(
    rules.map((r) => [r.rule.ranges[0].startColumnIndex, r.rule.ranges[0].endColumnIndex]),
    [0, 1, 2].flatMap(() => [
      [0, 3],
      [4, 9],
      [10, 14],
    ]),
  );
  assert.deepEqual(rules[0].rule.booleanRule.format.textFormat, { bold: true });
  assert.deepEqual(rules[6].rule.booleanRule.format.backgroundColorStyle.rgbColor, {
    red: 1,
    green: 1,
    blue: 1,
  });
  // In the requests, rules come in index order, before the pivots and slicers.
  const kinds = plan.requests.map((r) => Object.keys(r)[0]);
  assert.ok(kinds.lastIndexOf("addConditionalFormatRule") < kinds.indexOf("updateCells"));
  assert.ok(kinds.lastIndexOf("updateCells") < kinds.indexOf("addSlicer"));
});

test("widths are fixed pixels for every column A to P, and rows 2, 3, 5 and 6 have their heights", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const px = {};
  plan.widths.forEach((w) => {
    const r = w.updateDimensionProperties.range;
    assert.equal(r.dimension, "COLUMNS");
    assert.equal(r.endIndex, r.startIndex + 1);
    px[L.columnLetter(r.startIndex)] = w.updateDimensionProperties.properties.pixelSize;
  });
  assert.deepEqual(px, {
    A: 220,
    B: 90,
    C: 90,
    D: 24,
    E: 110,
    F: 90,
    G: 90,
    H: 90,
    I: 110,
    J: 24,
    K: 320,
    L: 140,
    M: 140,
    N: 90,
    O: 90,
    P: 90,
  });
  assert.deepEqual(
    plan.heights.map((h) => [
      h.updateDimensionProperties.range.startIndex,
      h.updateDimensionProperties.properties.pixelSize,
    ]),
    [
      [1, 66],
      [2, 44],
      [4, 38],
      [5, 38],
    ],
  );
  assert.equal(plan.frozenRows, 1);
  assert.deepEqual(plain(plan.cells.map((c) => c.a1)), [
    "A1",
    "A2",
    "A3",
    "A4",
    "F6",
    "A7",
    "E7",
    "K7",
  ]);
  assert.equal(plan.cells[0].value, "Volunteer hours");
  assert.ok(!plan.cells.some((c) => c.a1 === "B1"), "B1 is written only by the render");
  assert.deepEqual(plan.data.formats, plain(L.hoursDataFormats()));
  assert.equal(plan.data.stateRange, "L1:Q1");
});

test("row 2 names the open refresh only when the open path refreshes", () => {
  for (const path of ["refresh"]) {
    assert.match(
      L.hoursUsageText(path),
      /Newer taps show at the next refresh: when the sheet is opened, from Kiosk admin > Refresh Hours, and each night\./,
    );
  }
  assert.match(
    L.hoursUsageText("note"),
    /Newer taps show at the next refresh: from Kiosk admin > Refresh Hours, and each night\./,
  );
  assert.match(
    L.hoursUsageText("none"),
    /^The tables show the Log as of the time in B1, the last refresh from the menu, at night or by setupReports\./,
  );
  for (const path of ["refresh", "note", "none"]) {
    const t = L.hoursUsageText(path);
    assert.match(
      t,
      /Your picks are yours alone: nobody else sees them, and they're gone when you close the tab or reload the page\./,
    );
    assert.match(
      t,
      /or use From date and To date for a range of days; clear them all for all time\./,
    );
    assert.ok(
      t.endsWith(
        " To sort a table, pick an order in the box above it. The new order takes up to " +
          L.hoursSortSeconds() +
          " seconds to show, and it is shared: everyone sees it.",
      ),
      t,
    );
    assert.doesNotMatch(t, /resets sorts|Sort by in the editor/);
  }
});

test("the sort boxes' choices: each starts with Sort:, the starting choice first, and sorts by a value its pivot has", () => {
  const tables = plain(L.hoursSortChoices());
  assert.deepEqual(
    tables.map((t) => [t.key, t.cell, t.merge, t.column, t.endColumn, t.pivot, t.start]),
    [
      ["volunteer", "A7", "A7:C7", 0, 3, "A8", "Sort: most hours first"],
      ["month", "E7", "E7:I7", 4, 9, "E8", "Sort: oldest month first"],
      ["shifts", "K7", "K7:N7", 10, 14, "K8", "Sort: newest first"],
    ],
  );
  const pivots = plain(L.hoursPivots(L.hoursSourceRange(22), []));
  tables.forEach((t, i) => {
    assert.equal(t.choices[0].text, t.start);
    const texts = t.choices.map((c) => c.text);
    assert.equal(new Set(texts).size, texts.length, t.key + ": no choice twice");
    for (const c of t.choices) {
      assert.match(c.text, /^Sort: /);
      assert.ok(["ASCENDING", "DESCENDING"].includes(c.sortOrder), c.text);
      assert.ok(c.valuesIndex === null || c.valuesIndex < pivots[i].values.length, c.text);
    }
  });
  // The orders each table offers, as the sort they give: [text, order, by value].
  const sorts = (t) => t.choices.map((c) => [c.text, c.sortOrder, c.valuesIndex]);
  assert.deepEqual(sorts(tables[0]), [
    ["Sort: most hours first", "DESCENDING", 1],
    ["Sort: fewest hours first", "ASCENDING", 1],
    ["Sort: most shifts first", "DESCENDING", 0],
    ["Sort: name A to Z", "ASCENDING", null],
    ["Sort: name Z to A", "DESCENDING", null],
  ]);
  assert.deepEqual(sorts(tables[1]), [
    ["Sort: oldest month first", "ASCENDING", null],
    ["Sort: newest month first", "DESCENDING", null],
    ["Sort: most hours first", "DESCENDING", 1],
    ["Sort: most shifts first", "DESCENDING", 0],
    ["Sort: most volunteers first", "DESCENDING", 2],
  ]);
  assert.deepEqual(sorts(tables[2]), [
    ["Sort: newest first", "DESCENDING", null],
    ["Sort: oldest first", "ASCENDING", null],
    ["Sort: most hours first", "DESCENDING", 0],
    ["Sort: fewest hours first", "ASCENDING", 0],
  ]);
  // Each by-value choice names the value it sorts by.
  const names = pivots.map((p) => p.values.map((v) => v.name));
  assert.deepEqual(
    [names[0][1], names[0][0], names[1][1], names[1][0], names[1][2], names[2][0]],
    ["Hours", "Shifts", "Hours", "Shifts", "Volunteers", "Hours"],
  );
});

test("hoursBoxChoices keeps a box's own choice, and resets a blank, unknown or other box's value with a write-back", () => {
  const row = (a, e, k) => {
    const r = Array(14).fill("");
    r[0] = a;
    r[4] = e;
    r[10] = k;
    return r;
  };
  const read = (values) =>
    plain(L.hoursBoxChoices(values)).map((b) => [b.key, b.cell, b.choice, b.writeBack]);
  assert.deepEqual(
    read(row("Sort: name Z to A", "Sort: most volunteers first", "Sort: oldest first")),
    [
      ["volunteer", "A7", "Sort: name Z to A", false],
      ["month", "E7", "Sort: most volunteers first", false],
      ["shifts", "K7", "Sort: oldest first", false],
    ],
  );
  const starts = [
    ["volunteer", "A7", "Sort: most hours first", true],
    ["month", "E7", "Sort: oldest month first", true],
    ["shifts", "K7", "Sort: newest first", true],
  ];
  // Blank, typed, spaced, another box's choice pasted over each box, not text at all, and
  // a row 7 that is short or missing.
  assert.deepEqual(read(row("", "", "")), starts);
  assert.deepEqual(read(row("most hours", "Sort:", "newest first")), starts);
  assert.deepEqual(read(row(" Sort: most hours first", "Sort: oldest month first ", "")), starts);
  assert.deepEqual(
    read(row("Sort: newest first", "Sort: name A to Z", "Sort: oldest month first")),
    starts,
  );
  assert.deepEqual(read(row(7, null, new Date(0))), starts);
  assert.deepEqual(read([]), starts);
  assert.deepEqual(read(undefined), starts);
  assert.deepEqual(
    read(["Sort: name A to Z"]).map((b) => b[3]),
    [false, true, true],
  );
  // A choice two boxes share is each box's own: "most hours first" pasted from A7 to E7.
  assert.deepEqual(read(row("", "Sort: most hours first", "Sort: most hours first")).slice(1), [
    ["month", "E7", "Sort: most hours first", false],
    ["shifts", "K7", "Sort: most hours first", false],
  ]);
});

test("every choice gives its sort on its table's outer row group, and the other tables keep their starting sort", () => {
  const source = plain(L.hoursSourceRange(22));
  const tables = plain(L.hoursSortChoices());
  const outer = (pivots) =>
    pivots.map((p) => [p.rows[0].sortOrder, p.rows[0].valueBucket ? p.rows[0].valueBucket : null]);
  const startSorts = outer(plain(L.hoursPivots(source)));
  assert.deepEqual(startSorts, [
    ["DESCENDING", { valuesIndex: 1 }],
    ["ASCENDING", null],
    ["DESCENDING", null],
  ]);
  tables.forEach((t, i) => {
    for (const c of t.choices) {
      const picks = tables.map((u) => u.start);
      picks[i] = c.text;
      // As texts, and as hoursBoxChoices gives them.
      for (const given of [picks, picks.map((choice) => ({ choice, writeBack: false }))]) {
        const pivots = plain(L.hoursPivots(source, given));
        const want = startSorts.slice();
        want[i] = [c.sortOrder, c.valuesIndex === null ? null : { valuesIndex: c.valuesIndex }];
        assert.deepEqual(outer(pivots), want, c.text);
        // A value bucket with no buckets sorts by that value's Grand Total.
        if (c.valuesIndex !== null) assert.equal(pivots[i].rows[0].valueBucket.buckets, undefined);
        // Nothing but the order changes.
        const strip = (p) => ({ ...p, rows: p.rows.map(({ sortOrder, valueBucket, ...r }) => r) });
        assert.deepEqual(pivots.map(strip), plain(L.hoursPivots(source)).map(strip));
      }
    }
  });
  // An unknown choice gives the starting sort.
  assert.deepEqual(
    outer(plain(L.hoursPivots(source, ["x", "Sort: name A to Z", null]))),
    startSorts,
  );
});

test("row 7: the sort boxes, merged across their tables, filled, each a strict dropdown of its own choices, holding its choice", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const tables = plain(L.hoursSortChoices());
  const merges = plan.formats.filter((f) => f.mergeCells).map((f) => f.mergeCells.range);
  for (const t of tables) {
    assert.ok(
      merges.some(
        (r) =>
          r.sheetId === 11 &&
          r.startRowIndex === 6 &&
          r.endRowIndex === 7 &&
          r.startColumnIndex === t.column &&
          r.endColumnIndex === t.endColumn,
      ),
      t.merge,
    );
    const fill = plan.formats.find(
      (f) =>
        f.repeatCell &&
        f.repeatCell.range.startRowIndex === 6 &&
        f.repeatCell.range.startColumnIndex === t.column,
    );
    assert.equal(fill.repeatCell.range.endColumnIndex, t.endColumn);
    assert.deepEqual(
      fill.repeatCell.cell.userEnteredFormat,
      plain({
        backgroundColorStyle: L.lookColorStyle(L.lookPalette().section),
        textFormat: { foregroundColorStyle: L.lookColorStyle(L.lookPalette().navy) },
      }),
    );
  }
  // Rows 1 to 7 are unmerged first, so a merge never lands on an old one.
  assert.deepEqual(plan.formats[0].unmergeCells.range, {
    sheetId: 11,
    startRowIndex: 0,
    endRowIndex: 7,
    startColumnIndex: 0,
    endColumnIndex: 16,
  });
  assert.deepEqual(
    plan.validations.map((v) => v.setDataValidation),
    tables.map((t) => ({
      range: {
        sheetId: 11,
        startRowIndex: 6,
        endRowIndex: 7,
        startColumnIndex: t.column,
        endColumnIndex: t.column + 1,
      },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: t.choices.map((c) => ({ userEnteredValue: c.text })),
        },
        strict: true,
        showCustomUi: true,
      },
    })),
  );
  const cell = (p, a1) => p.cells.find((c) => c.a1 === a1).value;
  assert.deepEqual(
    tables.map((t) => cell(plan, t.cell)),
    tables.map((t) => t.start),
  );
  assert.deepEqual(
    plan.boxes.map((b) => b.choice),
    tables.map((t) => t.start),
  );
  // In the requests: the merges before the dropdowns, the dropdowns before the pivots.
  const kinds = plan.requests.map((r) => Object.keys(r)[0]);
  assert.ok(kinds.lastIndexOf("mergeCells") < kinds.indexOf("setDataValidation"));
  assert.ok(kinds.lastIndexOf("setDataValidation") < kinds.indexOf("updateCells"));
  // Given choices: the boxes hold them and the pivots sort by them; an unknown one starts.
  const picked = plain(
    L.hoursTabPlan(
      11,
      22,
      "refresh",
      L.hoursBoxChoices([
        "Sort: name A to Z",
        "",
        "",
        "",
        "nonsense",
        "",
        "",
        "",
        "",
        "",
        "Sort: most hours first",
      ]),
    ),
  );
  assert.deepEqual(
    ["A7", "E7", "K7"].map((a1) => cell(picked, a1)),
    ["Sort: name A to Z", "Sort: oldest month first", "Sort: most hours first"],
  );
  assert.deepEqual(
    picked.pivots.map((p) => p.updateCells.rows[0].values[0].pivotTable),
    plain(L.hoursPivots(picked.source, ["Sort: name A to Z", "", "Sort: most hours first"])),
  );
});

test("row 4's how-to line and F6's date note are one line of 10 pt navy text each, and the seconds come from hoursSortSeconds", () => {
  const plan = plain(L.hoursTabPlan(11, 22, "refresh"));
  const cell = (a1) => plan.cells.find((c) => c.a1 === a1).value;
  const seconds = L.hoursSortSeconds();
  assert.equal(seconds % 5, 0);
  assert.equal(
    cell("A4"),
    "In a slicer, click Clear, then tick what you want. Reload the page to clear every slicer." +
      " A sort box takes up to " +
      seconds +
      " seconds.",
  );
  assert.equal(cell("A4"), L.hoursHowTo());
  assert.ok(L.hoursUsageText("refresh").includes("up to " + seconds + " seconds"));
  assert.equal(
    cell("F6"),
    "Date range: From date > Filter by condition > Greater than or equal to > a date like" +
      " 2026-11-01. To date: Less than or equal to.",
  );
  assert.equal(cell("F6"), L.hoursDateNote());
  for (const [r, c] of [
    [3, 0],
    [5, 5],
  ]) {
    const f = plan.formats.find(
      (x) =>
        x.repeatCell &&
        x.repeatCell.range.startRowIndex === r &&
        x.repeatCell.range.startColumnIndex === c,
    );
    assert.deepEqual(f.repeatCell.range, {
      sheetId: 11,
      startRowIndex: r,
      endRowIndex: r + 1,
      startColumnIndex: c,
      endColumnIndex: c + 1,
    });
    assert.deepEqual(f.repeatCell.cell.userEnteredFormat, {
      wrapStrategy: "OVERFLOW_CELL",
      textFormat: {
        foregroundColorStyle: plain(L.lookColorStyle(L.lookPalette().navy)),
        fontSize: 10,
      },
    });
  }
  // No merge in rows 4 and 6, so each line runs on over the empty cells to its right.
  for (const f of plan.formats.filter((x) => x.mergeCells))
    assert.ok(![3, 5].includes(f.mergeCells.range.startRowIndex));
  // The Shifts pivot's Hours (N) shows two decimals; O and P hold nothing.
  const numberAt = (c) =>
    plan.formats.find(
      (x) =>
        x.repeatCell &&
        x.repeatCell.range.startRowIndex === 8 &&
        x.repeatCell.range.startColumnIndex === c,
    );
  assert.equal(numberAt(13).repeatCell.cell.userEnteredFormat.numberFormat.pattern, "0.00");
  assert.equal(numberAt(14), undefined);
  assert.equal(numberAt(15), undefined);
});

// The Shift label comes from the Hours data columns; until Hours data has its Shift column
// (K) there is no label to order.
test(
  "the Shifts box's newest first and oldest first order a day's no-time and timed shifts as the label sorts",
  { skip: plain(L.hoursDataHeaders())[10] !== "Shift" && "Hours data has no Shift column yet" },
  () => {
    nextRow = 2;
    const entries = [
      row({
        token: "tok-a",
        name: "Ann Lee",
        date: "2026-11-13",
        start: at("2026-11-13", "13:30"),
      }),
      row({
        token: "tok-b",
        name: "Bo Tran",
        date: "2026-11-13",
        start: NaN,
        inBy: "import",
        outBy: "import",
      }),
      row({
        token: "tok-c",
        name: "Cy Moss",
        date: "2026-11-12",
        start: at("2026-11-12", "15:00"),
      }),
      row({
        token: "tok-d",
        name: "Di Park",
        date: "2026-11-13",
        start: at("2026-11-13", "09:00"),
      }),
    ];
    const labels = plain(L.hoursTable(entries, [], clock)).rows.map((r) => r[10]);
    // Sheets orders text with digits before letters, as plain code-unit order does here.
    const ascending = labels.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const who = (list) => list.map((l) => l.split(" · ")[1]);
    // Oldest first: days oldest first; within a day the earliest start first, no time last.
    assert.deepEqual(who(ascending), ["Cy Moss", "Di Park", "Ann Lee", "Bo Tran"]);
    // Newest first: days newest first; within a day no time first, then latest to earliest.
    assert.deepEqual(who(ascending.slice().reverse()), [
      "Bo Tran",
      "Ann Lee",
      "Di Park",
      "Cy Moss",
    ]);
  },
);

test("the tab names and marks", () => {
  assert.equal(L.hoursTabName(), "Hours");
  assert.equal(L.hoursDataTabName(), "Hours data");
  assert.deepEqual(plain(L.hoursTabMark()), {
    key: "kiosk-tab",
    hours: "hours",
    data: "hours-data",
  });
  assert.deepEqual(plain(L.hoursStateCells()), ["L1", "M1", "N1", "O1", "P1", "Q1"]);
});
