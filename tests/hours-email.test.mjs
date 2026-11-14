// Tests for the pure parts of Kiosk admin > Email hours… in apps-script/Logic.js: the
// period and which Log rows count (hoursEmailPeriod, hoursEmailPlan), the preview's
// warnings, the email's text (hoursEmailMessage), the address check (hoursEmailAddress,
// profileEmailsFrom), the contact line, agreement with the Hours tab (hoursTable) and the
// shifts file (hoursEmailCsv). Logic.js is loaded as it is; Admin.js is loaded beside it
// only for the set-problem rule, which calls no Google service.
//
// The people are the sample roster's invented volunteers and "Pat Example".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);
const A = {};
vm.runInNewContext(read("apps-script/Logic.js") + "\n" + read("apps-script/Admin.js"), A);
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Central time without Apps Script

const TZ = "America/Chicago";
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
/** A Central clock time such as "9:00 AM", as the server's adminClock_ gives it. */
const clock = (ms) => {
  const p = centralParts(ms);
  const h = +p.hour;
  return (h % 12 || 12) + ":" + p.minute + " " + (h < 12 ? "AM" : "PM");
};
const hhmm = (ms) => {
  const p = centralParts(ms);
  return p.hour + ":" + p.minute;
};

// ---------------------------------------------------------------------------
// The fixture: Maria Alvarez's Log, with every kind of row the rules name

const MARIA = {
  id: "maria-id",
  firstName: "Maria",
  lastName: "Alvarez",
  phoneLast4: "0101",
  startDate: "2026-02-15",
  needsPhoneCheck: false,
  token: "tok-maria",
  row: 2,
};
const JAMES = {
  ...MARIA,
  id: "james-id",
  firstName: "James",
  lastName: "Okafor",
  token: "tok-james",
  row: 3,
};
const LISTED = [MARIA.token, JAMES.token];

/** One Log row as readReportLog_ gives it. */
function entry(row, f) {
  const stated = f.statedHoursCell ?? "";
  return {
    row,
    shiftId: "s-" + row,
    token: MARIA.token,
    name: "Maria Alvarez",
    dateText: "",
    recordedInMs: NaN,
    statedInMs: NaN,
    recordedOutMs: NaN,
    statedOutMs: NaN,
    recordedHours: NaN,
    statedHours: typeof stated === "number" ? stated : NaN,
    alerts: "",
    notes: "",
    status: "closed",
    outBy: "kiosk",
    inBy: "kiosk",
    roleType: "",
    activity: "",
    statedHoursCell: stated,
    recordedHoursCell: "",
    ...f,
  };
}

/**
 * A closed shift on date from 9:00 AM Central, hours long (the stated hours cell). A Date
 * that isn't yyyy-mm-dd (a typed "10/15/2026") gets its times from a fixed day.
 */
function shift(date, hours, more = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "2026-10-15";
  const inMs = centralMs(day + " 09:00");
  const n = Number(hours);
  return {
    dateText: date,
    statedInMs: inMs,
    statedOutMs: isFinite(n) && n >= 0 ? inMs + Math.round(n * 60) * 60000 : inMs,
    statedHoursCell: hours,
    ...more,
  };
}

const addDays = (date, n) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * The Log, out of date order on purpose. Counted, under Maria's token:
 * - 10 paper rows of 3.00 in 2024, matched (Shift ID import-), one with a typed time;
 * - 15 kiosk rows of 2.00, weekly from 2025-09-06, and 3.75 on 2025-12-31;
 * - 2026 to September: 2.50 on January 1, nine more of 2.50 (one with blank times), 4.75,
 *   a blank hours cell and a negative one: 13 shifts, 29.75;
 * - October: 3.00, an auto clock-out of 3.00, "2.5" typed as text, 3.50: 4 shifts, 12.00;
 * - November: Mon Nov 2 3.00 and Thu Nov 12 3.50.
 * Not counted on November 14: an open row, rows dated after today, an m/d/yyyy Date,
 * James's rows, a stand-in import: row, an old token and a mistyped one under her name.
 */
function fixtureRows() {
  const rows = [];
  const add = (f) => rows.push(f);
  for (let k = 0; k < 10; k++) {
    add({
      ...shift(addDays("2024-01-06", 7 * k), 3),
      shiftId: "import-" + String(k).padStart(4, "0"),
      inBy: "import",
      outBy: "import",
      // Paper rows have no times, except one typed by hand.
      statedInMs: k === 3 ? centralMs("2024-01-27 10:00") : NaN,
      statedOutMs: NaN,
    });
  }
  add(shift("2026-11-12", 3.5));
  for (let k = 0; k < 15; k++) add(shift(addDays("2025-09-06", 7 * k), 2));
  add(shift("2025-12-31", 3.75));
  add(shift("2026-01-01", 2.5));
  ["2026-02-07", "2026-03-07", "2026-04-04", "2026-05-02", "2026-06-06", "2026-07-04"].forEach(
    (d) => add(shift(d, 2.5)),
  );
  ["2026-08-01", "2026-08-29"].forEach((d) => add(shift(d, 2.5)));
  // Blank stated times on a row with hours.
  add({ ...shift("2026-09-05", 2.5), statedInMs: NaN, statedOutMs: NaN });
  add(shift("2026-09-12", 4.75));
  add(shift("2026-09-19", ""));
  add(shift("2026-09-26", -1));
  add(shift("2026-10-03", 3));
  add({ ...shift("2026-10-10", 3), outBy: "auto-close", alerts: "auto clock-out: time guessed" });
  add(shift("2026-10-17", "2.5"));
  add(shift("2026-10-24", 3.5));
  add({ ...shift("2026-11-02", 3), notes: "Parked in lot B" });
  // Not counted on November 14.
  add({ ...shift("2026-11-13", ""), status: "open", outBy: "", statedOutMs: NaN });
  add(shift("2026-11-20", 3));
  add(shift("2026-12-05", 1));
  add(shift("2027-01-02", 2));
  add(shift("10/15/2026", 2));
  add({ ...shift("2026-11-02", 4), token: JAMES.token, name: "James Okafor" });
  add({ ...shift("2026-10-03", 4), token: JAMES.token, name: "James Okafor" });
  add({
    ...shift("2024-05-04", 3),
    token: "import:maria alvarez",
    shiftId: "import-zz",
    inBy: "import",
    outBy: "import",
    alerts: "name not matched",
  });
  add({ ...shift("2023-06-03", 5), token: "tok-maria-2019" });
  add({ ...shift("2026-06-13", 2), token: "tok-mariaa", name: "maria  alvarez" });
  return rows.map((f, i) => entry(i + 2, f));
}
const LOG = fixtureRows();
const FUTURE = ["2026-11-20", "2026-12-05", "2027-01-02"];

const planFor = (choice, today, more = {}) =>
  L.hoursEmailPlan({
    volunteer: MARIA,
    entries: LOG,
    flags: [],
    period: L.hoursEmailPeriod(choice, today),
    todayDate: today,
    listedTokens: LISTED,
    ...more,
  });
const totals = (t) => [t.hundredths, t.shifts];

// ---------------------------------------------------------------------------
// H1 totals

test("hoursEmailPeriod: this month as of today; last month as of its last day, January included", () => {
  assert.deepEqual(plain(L.hoursEmailPeriod("this", "2026-11-14")), {
    choice: "this",
    month: "2026-11",
    asOf: "2026-11-14",
  });
  assert.deepEqual(plain(L.hoursEmailPeriod("last", "2026-11-03")), {
    choice: "last",
    month: "2026-10",
    asOf: "2026-10-31",
  });
  assert.deepEqual(plain(L.hoursEmailPeriod("last", "2027-01-05")), {
    choice: "last",
    month: "2026-12",
    asOf: "2026-12-31",
  });
  assert.deepEqual(plain(L.hoursEmailPeriod("last", "2028-03-01")), {
    choice: "last",
    month: "2028-02",
    asOf: "2028-02-29",
  });
  // Anything but "last" is this month.
  for (const c of ["this", "", undefined, "LAST", "next"]) {
    assert.equal(L.hoursEmailPeriod(c, "2026-11-14").choice, "this", String(c));
  }
});

test("H1: this month on November 14 counts the month, the year and all time to today", () => {
  const p = planFor("this", "2026-11-14");
  assert.deepEqual(totals(p.month), [650, 2]);
  assert.equal(p.month.key, "2026-11");
  assert.deepEqual(totals(p.year), [4825, 19]);
  assert.equal(p.year.key, "2026");
  assert.deepEqual(totals(p.all), [11200, 45]);
  assert.equal(p.paperHundredths, 3000);
  assert.deepEqual(plain(p.monthShifts), [
    { date: "2026-11-02", hundredths: 300 },
    { date: "2026-11-12", hundredths: 350 },
  ]);
  assert.equal(p.allShifts.length, 45);
  // No open, future, m/d/yyyy, other-token or stand-in row is in the file's rows.
  const dates = p.allShifts.map((s) => s.date);
  FUTURE.concat(["2026-11-13", "10/15/2026", "2024-05-04", "2023-06-03", "2026-06-13"]).forEach(
    (d) => assert.ok(!dates.includes(d), d),
  );
});

test("H1: last month on November 3 is October as of October 31, without the November rows", () => {
  const p = planFor("last", "2026-11-03");
  assert.deepEqual(totals(p.month), [1200, 4]);
  assert.equal(p.month.key, "2026-10");
  assert.deepEqual(totals(p.year), [4175, 17]);
  assert.deepEqual(totals(p.all), [10550, 43]);
  assert.equal(p.paperHundredths, 3000);
  assert.ok(p.allShifts.every((s) => s.date <= "2026-10-31"));
});

test("H1: December 31 and January 1 land in different years; last in January is December", () => {
  const jan1 = planFor("this", "2026-01-01");
  assert.deepEqual(totals(jan1.month), [250, 1]);
  assert.deepEqual(totals(jan1.year), [250, 1]);
  assert.ok(jan1.allShifts.some((s) => s.date === "2025-12-31"));
  const dec31 = planFor("this", "2025-12-31");
  assert.equal(dec31.year.key, "2025");
  assert.deepEqual(totals(dec31.year), [3375, 16]);

  const p = planFor("last", "2027-01-05");
  assert.equal(p.month.key, "2026-12");
  assert.equal(p.year.key, "2026");
  // The year gains November 20 and December 5; January 2 2027 is in no total.
  assert.deepEqual(totals(p.month), [100, 1]);
  assert.deepEqual(totals(p.year), [4825 + 300 + 100, 21]);
  assert.deepEqual(totals(p.all), [11200 + 400, 47]);
  assert.ok(!p.allShifts.some((s) => s.date === "2027-01-02"));
  const m = L.hoursEmailMessage({ firstName: "Maria", plan: p, attach: false, contact: "Pat" });
  assert.ok(m.body.includes("  2026 through December: 52.25 hours (21 shifts)"));
  assert.ok(m.body.includes("  December 2026: 1.00 hours (1 shift)"));
  assert.equal(m.subject, "Your volunteer hours for December 2026");
});

// ---------------------------------------------------------------------------
// H2 warnings

const ANA = {
  ...MARIA,
  id: "ana-id",
  firstName: "Ana",
  lastName: "Diaz",
  token: "tok-ana",
  row: 7,
  needsPhoneCheck: true,
};
const ANA_TOO = { ...ANA, id: "ana-2", token: "tok-ana-2", row: 9 };

function warningLog() {
  const rows = [];
  const add = (f) =>
    rows.push(entry(rows.length + 2, { token: ANA.token, name: "Ana Diaz", ...f }));
  // 12 open rows of Ana's: the warning names 10 and says how many more.
  for (let k = 0; k < 12; k++) {
    add({ ...shift(addDays("2026-10-01", k), ""), status: "open", outBy: "" });
  }
  // rows 14 to 21
  add(shift("2026-11-02", 3)); // 14: an unreviewed Flags row
  add(shift("2026-11-03", 3)); // 15: a reviewed Flags row only
  add({ ...shift("2026-11-04", 3), alerts: "arrival differs by 30 min" }); // 16: alert, no Flags row
  add({ ...shift("2026-11-05", 3), outBy: "auto-close" }); // 17
  add(shift("2026-11-06", "")); // 18: blank hours
  add(shift("2026-11-07", "x")); // 19: not a number
  add(shift("2026-11-08", -2)); // 20: negative
  add(shift("2026/11/09", 2)); // 21: unreadable Date
  add(shift("2026-11-20", 2)); // 22: after today
  // 23: an old token under her name, with an alert and an unreviewed Flags row.
  add({ ...shift("2025-05-03", 4), token: "tok-ana-old", alerts: "long shift" });
  add({ ...shift("2025-05-10", 1.5), token: "tok-anna" }); // 24: a typing slip
  // 25: a stand-in row with the import alert.
  add({
    ...shift("2024-02-03", 2),
    token: "import:ana diaz",
    shiftId: "import-a",
    alerts: "name not matched",
  });
  add({ ...shift("2026-11-02", 5), token: ANA_TOO.token }); // 26: the other Ana's row
  // 27: an open row of hers with an unreviewed Flags row and an alert.
  add({ ...shift("2026-09-01", ""), status: "open", outBy: "", alerts: "arrival differs" });
  // 28: a counted row dated between October 31 and November 3.
  add(shift("2026-11-01", 2));
  return rows;
}
const WLOG = warningLog();
const WFLAGS = [
  { shiftId: "s-14", reviewed: false, name: "Ana Diaz" },
  { shiftId: "s-15", reviewed: true, name: "Ana Diaz" },
  { shiftId: "s-23", reviewed: false, name: "Ana Diaz" },
  { shiftId: "s-25", reviewed: false, name: "Ana Diaz" },
  { shiftId: "s-27", reviewed: false, name: "Ana Diaz" },
  { shiftId: "", reviewed: false, name: "Ana Diaz" },
];
const wplan = (volunteer, flags = WFLAGS, choice = "this", today = "2026-11-14") =>
  L.hoursEmailPlan({
    volunteer,
    entries: WLOG,
    flags,
    period: L.hoursEmailPeriod(choice, today),
    todayDate: today,
    listedTokens: [ANA.token, ANA_TOO.token],
  });
const byKind = (p) => Object.fromEntries(plain(p.warnings).map((w) => [w.kind, w]));

test("H2: each warning has its count, its Log rows and what to do", () => {
  const w = byKind(wplan(ANA));
  assert.deepEqual(Object.keys(w), [
    "open",
    "flags",
    "alerts",
    "other-token",
    "auto",
    "zero-hours",
    "dates",
    "stand-in",
  ]);
  // Open: the 12 rows and row 27, 10 named.
  assert.equal(w.open.count, 13);
  assert.deepEqual(w.open.rows, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 27]);
  assert.equal(
    w.open.text,
    "13 open shifts not counted (Log rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 3 more): use Fix a sign-out… if they're finished.",
  );
  // The flag warning names only counted rows of her token: not the open row 27, the
  // old-token row 23 or the stand-in row 25.
  assert.deepEqual(w.flags.rows, [14]);
  assert.equal(
    w.flags.text,
    "1 counted shift with an unreviewed flag (Log row 14): check them on the Flags tab before sending.",
  );
  // Admin Alerts? on her token, any status: 16, 17 has none, 27 is open. Not 23 or 25.
  assert.deepEqual(w.alerts.rows, [16, 27]);
  assert.equal(
    w.alerts.text,
    "2 rows with Admin Alerts? set (Log rows 16 and 27): read the Admin Alerts? cell on those Log rows before sending.",
  );
  // A token no listed volunteer has, under her name, with the hours; not the stand-in row
  // or the other Ana's.
  assert.deepEqual(w["other-token"].rows, [23, 24]);
  assert.equal(
    w["other-token"].text,
    "2 closed shifts under this name with a User Token no listed volunteer has, 5.50 hours (Log rows 23 and 24): they aren't in these totals; this may be an old or mistyped User Token. If they're this volunteer's, change it to their current User Token on those rows. Two volunteers share this name; check whose they are.",
  );
  assert.deepEqual(w.auto.rows, [17]);
  assert.equal(
    w.auto.text,
    "1 auto clock-out in the totals (Log row 17): their check-out time was guessed.",
  );
  assert.deepEqual(w["zero-hours"].rows, [18, 19, 20]);
  assert.equal(
    w["zero-hours"].text,
    "3 shifts counted as 0 hours (Log rows 18, 19 and 20): Hours Served (stated) is blank, negative or not a number.",
  );
  assert.deepEqual(w.dates.rows, [21, 22]);
  assert.equal(
    w.dates.text,
    "2 shifts left out (Log rows 21 and 22): the Date isn't yyyy-mm-dd, or is after today (the Hours tab counts the future-dated ones).",
  );
  assert.deepEqual(w["stand-in"].rows, [25]);
  assert.equal(
    w["stand-in"].text,
    "1 paper shift under this name with an import: User Token, 2.00 hours (Log row 25): they aren't in these totals; if they're this volunteer's, type their User Token over the import: token on those rows. Two volunteers share this name; check whose they are.",
  );
  // The left-out rows aren't in the totals.
  const p = wplan(ANA);
  assert.ok(!p.allShifts.some((s) => [21, 22, 23, 24, 25, 26, 27].includes(s.row)));
});

test("H2: the same-name sentence only in a same-name group; Flags unreadable; no hours", () => {
  const alone = byKind(wplan({ ...ANA, needsPhoneCheck: false }));
  assert.ok(!alone["other-token"].text.includes("Two volunteers share this name"));
  assert.ok(!alone["stand-in"].text.includes("Two volunteers share this name"));

  const unread = plain(wplan(ANA, null).warnings);
  assert.ok(!unread.some((w) => w.kind === "flags"));
  assert.deepEqual(unread[unread.length - 1], {
    kind: "flags-unreadable",
    count: 0,
    rows: [],
    text: "The Flags tab couldn't be read, so flags weren't checked.",
  });

  const nobody = { ...ANA, token: "tok-nobody", firstName: "Pat", lastName: "Example" };
  assert.deepEqual(plain(wplan(nobody, []).warnings), [
    {
      kind: "no-hours",
      count: 0,
      rows: [],
      text: "This volunteer has no counted hours yet; the email will say so.",
    },
  ]);
});

test("H2: with last month, a row between the as-of date and today is in no warning", () => {
  const p = wplan(ANA, WFLAGS, "last", "2026-11-03");
  plain(p.warnings).forEach((w) => assert.ok(!w.rows.includes(28), w.kind));
  assert.ok(!p.allShifts.some((s) => s.row === 28));
});

test("H2: the row list caps at 10 and the rows text reads naturally", () => {
  assert.equal(L.hoursEmailRowsText([7]), "Log row 7");
  assert.equal(L.hoursEmailRowsText([9, 3]), "Log rows 3 and 9");
  assert.equal(L.hoursEmailRowsText([1, 2, 3]), "Log rows 1, 2 and 3");
  const ten = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.equal(L.hoursEmailRowsText(ten), "Log rows 1, 2, 3, 4, 5, 6, 7, 8, 9 and 10");
  assert.equal(
    L.hoursEmailRowsText([...ten, 11]),
    "Log rows 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 1 more",
  );
});

// ---------------------------------------------------------------------------
// H3 the email

const CONTACT = "Pat Example\npat@example.org";

test("H3: this month on November 14 with the file: the email's text exactly", () => {
  const m = plain(
    L.hoursEmailMessage({
      firstName: " Maria ",
      plan: planFor("this", "2026-11-14"),
      attach: true,
      contact: CONTACT,
      signature: "",
    }),
  );
  assert.equal(m.subject, "Your volunteer hours for November 2026");
  assert.equal(
    m.body,
    [
      "Hi Maria,",
      "",
      "Here are the volunteer hours we have for you as of Saturday, November 14, 2026:",
      "",
      "  November 2026 so far: 6.50 hours (2 shifts)",
      "  2026 so far: 48.25 hours (19 shifts)",
      "  All time: 112.00 hours (45 shifts), including 30.00 hours from our paper records",
      "",
      "Your shifts in November 2026:",
      "  Mon Nov 2: 3.00 hours",
      "  Thu Nov 12: 3.50 hours",
      "",
      "All 45 of your shifts are in the attached spreadsheet file, volunteer-hours-to-2026-11-14.csv.",
      "",
      "This email comes from an address that can't take replies. If anything looks wrong, please contact:",
      "Pat Example, pat@example.org",
      "",
      "Thank you for volunteering.",
    ].join("\n"),
  );
});

test("H3: last month on November 3: the email's text exactly", () => {
  const m = plain(
    L.hoursEmailMessage({
      firstName: "Maria",
      plan: planFor("last", "2026-11-03"),
      attach: false,
      contact: CONTACT,
      signature: " Pat Example \n\n Volunteer desk\n",
    }),
  );
  assert.equal(m.subject, "Your volunteer hours for October 2026");
  assert.equal(
    m.body,
    [
      "Hi Maria,",
      "",
      "Here are the volunteer hours we have for you through Saturday, October 31, 2026:",
      "",
      "  October 2026: 12.00 hours (4 shifts)",
      "  2026 through October: 41.75 hours (17 shifts)",
      "  All time: 105.50 hours (43 shifts), including 30.00 hours from our paper records",
      "",
      "Your shifts in October 2026:",
      "  Sat Oct 3: 3.00 hours",
      "  Sat Oct 10: 3.00 hours",
      "  Sat Oct 17: 2.50 hours",
      "  Sat Oct 24: 3.50 hours",
      "",
      "This email comes from an address that can't take replies. If anything looks wrong, please contact:",
      "Pat Example, pat@example.org",
      "",
      "Thank you for volunteering.",
      "Pat Example",
      "Volunteer desk",
    ].join("\n"),
  );
});

/** A plan with the given totals, for the wording cases. */
const fakePlan = (choice, monthShifts, all, paper = 0) => ({
  period: L.hoursEmailPeriod(choice, choice === "this" ? "2026-11-14" : "2026-11-03"),
  month: {
    key: choice === "this" ? "2026-11" : "2026-10",
    hundredths: 0,
    shifts: monthShifts.length,
  },
  year: { key: "2026", hundredths: all.hundredths, shifts: all.shifts },
  all,
  paperHundredths: paper,
  monthShifts,
  allShifts: [],
  warnings: [],
});

test("H3: no hours at all, none in the month, one shift, paper only above 0, the file line", () => {
  const msg = (plan, attach = false, contact = CONTACT, signature = "") =>
    L.hoursEmailMessage({ firstName: "Pat", plan, attach, contact, signature });
  const none = msg(fakePlan("this", [], { hundredths: 0, shifts: 0 }), true).body;
  assert.equal(
    none,
    [
      "Hi Pat,",
      "",
      "Here are the volunteer hours we have for you as of Saturday, November 14, 2026:",
      "",
      "We don't have any volunteer hours recorded for you yet.",
      "",
      "All 0 of your shifts are in the attached spreadsheet file, volunteer-hours-to-2026-11-14.csv.",
      "",
      "This email comes from an address that can't take replies. If anything looks wrong, please contact:",
      "Pat Example, pat@example.org",
      "",
      "Thank you for volunteering.",
    ].join("\n"),
  );
  const quietThis = msg(fakePlan("this", [], { hundredths: 300, shifts: 1 })).body;
  assert.ok(quietThis.includes("\n\nNo shifts yet in November 2026.\n\n"));
  assert.ok(!quietThis.includes("Your shifts in"));
  const quietLast = msg(fakePlan("last", [], { hundredths: 300, shifts: 1 })).body;
  assert.ok(quietLast.includes("\n\nNo shifts in October 2026.\n\n"));
  // One shift: singular, in the totals and the file line; no paper part at 0.
  const one = msg(
    fakePlan("this", [{ date: "2026-11-02", hundredths: 300 }], { hundredths: 300, shifts: 1 }),
    true,
  ).body;
  assert.ok(one.includes("  All time: 3.00 hours (1 shift)\n"));
  assert.ok(one.includes("  November 2026 so far: 0.00 hours (1 shift)"));
  assert.ok(
    one.includes(
      "Your 1 shift is in the attached spreadsheet file, volunteer-hours-to-2026-11-14.csv.",
    ),
  );
  assert.ok(!one.includes("paper"));
  const paper = msg(fakePlan("this", [], { hundredths: 300, shifts: 1 }, 1)).body;
  assert.ok(
    paper.includes("All time: 3.00 hours (1 shift), including 0.01 hours from our paper records"),
  );
  // Without attach there is no file line.
  assert.ok(!msg(planFor("this", "2026-11-14")).body.includes("attached"));
  // Contact lines trimmed, empty ones dropped, joined; signature lines likewise.
  const c = msg(
    planFor("this", "2026-11-14"),
    false,
    "\n Pat Example \r\n\n pat@example.org\n",
    " Pat \n\n Desk ",
  );
  assert.ok(
    c.body.endsWith(
      "please contact:\nPat Example, pat@example.org\n\nThank you for volunteering.\nPat\nDesk",
    ),
  );
});

test("H3: the email holds no token, Shift ID, Log row, flag, note or other name", () => {
  for (const choice of ["this", "last"]) {
    const today = choice === "this" ? "2026-11-14" : "2026-11-03";
    const m = L.hoursEmailMessage({
      firstName: "Maria",
      plan: planFor(choice, today),
      attach: true,
      contact: CONTACT,
      signature: "",
    });
    const text = m.subject + "\n" + m.body;
    // The fixture's Shift IDs are "s-<row>" and "import-<n>"; the file name's "hours-to"
    // is no Shift ID.
    assert.ok(!/\bs-\d/.test(text), choice + ": a Shift ID");
    ["tok-", "import", "Log row", "flag", "alert", "James", "Okafor", "auto", "lot B"].forEach(
      (part) => assert.ok(!text.includes(part), choice + ": " + part),
    );
  }
});

// ---------------------------------------------------------------------------
// H4 addresses

test("H4: the address check", () => {
  const ok = (text, email) =>
    assert.deepEqual(plain(L.hoursEmailAddress(text)), { email, problem: "" }, text);
  const bad = (text, problem) =>
    assert.deepEqual(plain(L.hoursEmailAddress(text)), { email: "", problem }, String(text));
  bad("", "no-email");
  bad("   ", "no-email");
  bad(undefined, "no-email");
  bad("not-an-email", "bad-email");
  bad("pat@example.org pat2@example.org", "bad-email");
  bad("pat@example.org, pat2@example.org", "bad-email");
  bad("<pat@example.org>", "bad-email");
  bad("Pat Example <pat@example.org>", "bad-email");
  bad("pat@example.org, PAT@example.org", "bad-email");
  bad("pat@example.org (home)", "bad-email");
  bad('"pat"@example.org', "bad-email");
  ok(" pat@example.org ", "pat@example.org");
  ok("pat@example.org", "pat@example.org");
  ok("=pat@example.org", "=pat@example.org");
});

const PROFILE_HEADER = [
  "Volunteer\nFirst Name",
  "Volunteer\nLast Name",
  "Email\nAddress",
  "Onboarding\nToken",
];

test("H4: profileEmailsFrom finds each volunteer's row by token, with the problem texts", () => {
  const rows = [
    ["Maria", "Alvarez", " maria.alvarez@example.org ", "tok-maria"],
    ["James", "Okafor", "", "tok-james"],
    ["Ana", "Diaz", "not-an-email", "tok-ana"],
    ["Ana", "Diaz", "x@example.org", "tok-dup"],
    ["Ana", "Diaz", "y@example.org", " tok-dup "],
  ];
  const vols = [
    MARIA,
    JAMES,
    ANA,
    { ...ANA, id: "dup", token: "tok-dup" },
    { ...ANA, id: "gone", token: "tok-gone" },
  ];
  assert.deepEqual(plain(L.profileEmailsFrom(PROFILE_HEADER, rows, vols)), {
    "maria-id": { email: "maria.alvarez@example.org", row: 2, problem: "", text: "" },
    "james-id": {
      email: "",
      row: 3,
      problem: "no-email",
      text: "Volunteer Profiles row 3 has no email. Add it there, then press Preview again.",
    },
    "ana-id": {
      email: "",
      row: 4,
      problem: "bad-email",
      text: 'The email in Volunteer Profiles row 4 isn\'t one email address: "not-an-email". Fix it there, then press Preview again.',
    },
    dup: {
      email: "",
      row: 5,
      problem: "duplicate-token",
      text: "Volunteer Profiles rows 5 and 6 have the same User Token. Fix it there, then press Preview again.",
    },
    gone: {
      email: "",
      row: 0,
      problem: "not-found",
      text: "Not on the volunteer list any more; press Preview again.",
    },
  });
  // "Email" alone is found too, and the token column may be called User Token.
  const plainHeader = ["Volunteer First Name", "Volunteer Last Name", "Email", "User Token"];
  assert.equal(
    L.profileEmailsFrom(plainHeader, rows, [MARIA])["maria-id"].email,
    "maria.alvarez@example.org",
  );
  // Rows reordered: still found by token.
  const moved = [rows[2], rows[1], rows[0]];
  assert.deepEqual(plain(L.profileEmailsFrom(PROFILE_HEADER, moved, [MARIA]))["maria-id"].row, 4);
  // No Email column: the problem for every volunteer, each still found by token.
  const none = plain(
    L.profileEmailsFrom(
      ["Volunteer First Name", "User Token"],
      rows.map((r) => [r[0], r[3]]),
      [MARIA, JAMES],
    ),
  );
  assert.deepEqual(none["maria-id"], {
    email: "",
    row: 2,
    problem: "no-email-column",
    text: "Volunteer Profiles has no Email column.",
  });
  assert.equal(none["james-id"].problem, "no-email-column");
  assert.equal(none["james-id"].row, 3);
  assert.deepEqual(plain(L.profileEmailHeaders()), ["email", "email address"]);
});

// ---------------------------------------------------------------------------
// H5 the contact

test("H5: a blank contact is a set problem; the contact's lines are trimmed and joined", () => {
  const problems = (contact) =>
    plain(A.hoursEmailSetProblems_({ emails: { a: { problem: "" } }, contact }));
  const blank = [
    "Type who volunteers should contact about their hours in Hours email contact on the Settings tab, then press Preview again.",
  ];
  assert.deepEqual(problems(""), blank);
  assert.deepEqual(problems(" \n \n\t"), blank);
  assert.deepEqual(problems("Pat Example"), []);
  assert.deepEqual(plain(L.settingLines("Pat Example\n pat@example.org \n\n")), [
    "Pat Example",
    "pat@example.org",
  ]);
  const m = L.hoursEmailMessage({
    firstName: "Maria",
    plan: planFor("this", "2026-11-14"),
    attach: false,
    contact: "Pat Example\n pat@example.org \n\n",
  });
  assert.ok(m.body.includes("please contact:\nPat Example, pat@example.org\n"));
  // The Kiosk contact line reads its value the same way, and says the same as before.
  assert.equal(
    L.kioskContactNote("Pat Example\n pat@example.org \n\n"),
    "If this keeps happening, contact: Pat Example, pat@example.org",
  );
  // No Email column is a set problem as well.
  assert.deepEqual(
    plain(
      A.hoursEmailSetProblems_({ emails: { a: { problem: "no-email-column" } }, contact: "Pat" }),
    ),
    ["Volunteer Profiles has no Email column."],
  );
});

// ---------------------------------------------------------------------------
// H6 agreement with the Hours tab

test("H6: the email's totals equal the Hours tab's rows for this token up to the month", () => {
  const log = LOG.filter((e) => !FUTURE.includes(e.dateText));
  const table = L.hoursTable(log, [], hhmm);
  const label = L.hoursLabels(log).get(MARIA.token);
  const mine = table.rows.filter((r) => r[5] === L.hoursCellText(label));
  const sum = (rows) => [
    Math.round(rows.reduce((s, r) => s + r[7], 0) * 100),
    rows.reduce((s, r) => s + r[6], 0),
  ];
  for (const [choice, today] of [
    ["this", "2026-11-14"],
    ["last", "2026-11-03"],
  ]) {
    const p = L.hoursEmailPlan({
      volunteer: MARIA,
      entries: log,
      flags: [],
      period: L.hoursEmailPeriod(choice, today),
      todayDate: today,
      listedTokens: LISTED,
    });
    const month = p.period.month;
    const upTo = mine.filter((r) => r[2] <= month);
    assert.deepEqual(sum(upTo), totals(p.all), choice + " all");
    assert.deepEqual(
      sum(upTo.filter((r) => r[1] === month.slice(0, 4))),
      totals(p.year),
      choice + " year",
    );
    assert.deepEqual(sum(upTo.filter((r) => r[2] === month)), totals(p.month), choice + " month");
  }
});

// ---------------------------------------------------------------------------
// H7 the shifts file

const CSV_LAST = [
  "Date,Check-in,Check-out,Hours",
  // Paper rows: date and hours only, the typed time on 2024-01-27 too.
  "2024-01-06,,,3.00",
  "2024-01-13,,,3.00",
  "2024-01-20,,,3.00",
  "2024-01-27,,,3.00",
  "2024-02-03,,,3.00",
  "2024-02-10,,,3.00",
  "2024-02-17,,,3.00",
  "2024-02-24,,,3.00",
  "2024-03-02,,,3.00",
  "2024-03-09,,,3.00",
  "2025-09-06,9:00 AM,11:00 AM,2.00",
  "2025-09-13,9:00 AM,11:00 AM,2.00",
  "2025-09-20,9:00 AM,11:00 AM,2.00",
  "2025-09-27,9:00 AM,11:00 AM,2.00",
  "2025-10-04,9:00 AM,11:00 AM,2.00",
  "2025-10-11,9:00 AM,11:00 AM,2.00",
  "2025-10-18,9:00 AM,11:00 AM,2.00",
  "2025-10-25,9:00 AM,11:00 AM,2.00",
  "2025-11-01,9:00 AM,11:00 AM,2.00",
  "2025-11-08,9:00 AM,11:00 AM,2.00",
  "2025-11-15,9:00 AM,11:00 AM,2.00",
  "2025-11-22,9:00 AM,11:00 AM,2.00",
  "2025-11-29,9:00 AM,11:00 AM,2.00",
  "2025-12-06,9:00 AM,11:00 AM,2.00",
  "2025-12-13,9:00 AM,11:00 AM,2.00",
  "2025-12-31,9:00 AM,12:45 PM,3.75",
  "2026-01-01,9:00 AM,11:30 AM,2.50",
  "2026-02-07,9:00 AM,11:30 AM,2.50",
  "2026-03-07,9:00 AM,11:30 AM,2.50",
  "2026-04-04,9:00 AM,11:30 AM,2.50",
  "2026-05-02,9:00 AM,11:30 AM,2.50",
  "2026-06-06,9:00 AM,11:30 AM,2.50",
  "2026-07-04,9:00 AM,11:30 AM,2.50",
  "2026-08-01,9:00 AM,11:30 AM,2.50",
  "2026-08-29,9:00 AM,11:30 AM,2.50",
  // Blank stated times.
  "2026-09-05,,,2.50",
  "2026-09-12,9:00 AM,1:45 PM,4.75",
  // Blank and negative hours count as 0.00.
  "2026-09-19,9:00 AM,9:00 AM,0.00",
  "2026-09-26,9:00 AM,9:00 AM,0.00",
  "2026-10-03,9:00 AM,12:00 PM,3.00",
  // The auto clock-out: check-in, no check-out.
  "2026-10-10,9:00 AM,,3.00",
  "2026-10-17,9:00 AM,11:30 AM,2.50",
  "2026-10-24,9:00 AM,12:30 PM,3.50",
];

test("H7: the shifts file's exact text, its rows the all-time line's shifts", () => {
  const last = planFor("last", "2026-11-03");
  const csv = L.hoursEmailCsv(last.allShifts, clock);
  assert.equal(csv, CSV_LAST.map((l) => l + "\r\n").join(""));
  assert.equal(csv.split("\r\n").length - 2, last.all.shifts);

  const now = planFor("this", "2026-11-14");
  const text = L.hoursEmailCsv(now.allShifts, clock);
  const lines = text.split("\r\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length - 1, now.all.shifts);
  assert.deepEqual(lines.slice(-2), [
    "2026-11-02,9:00 AM,12:00 PM,3.00",
    "2026-11-12,9:00 AM,12:30 PM,3.50",
  ]);
  // No open, stand-in or future row; ASCII only; no quote, no "=", four cells a line.
  ["2026-11-13", "2026-11-20", "2024-05-04", "2023-06-03"].forEach((d) =>
    assert.ok(!text.includes(d), d),
  );
  assert.match(text, /^[\x20-\x7e\r\n]*$/);
  assert.ok(!text.includes('"') && !text.includes("="));
  lines.forEach((l) => assert.equal(l.split(",").length, 4, l));
  // No line ends but CRLF.
  assert.ok(!/[^\r]\n/.test(text));
  // With no shifts the file is its header alone.
  assert.equal(L.hoursEmailCsv([], clock), "Date,Check-in,Check-out,Hours\r\n");
  assert.equal(L.hoursEmailFileName("2026-11-14"), "volunteer-hours-to-2026-11-14.csv");
});

test("H7: shifts on one Date go by check-in time, then Log row, an unknown time last", () => {
  const rows = [
    entry(2, shift("2026-03-07", 1, { statedInMs: centralMs("2026-03-07 13:00") })),
    entry(3, { ...shift("2026-03-07", 2), statedInMs: NaN, statedOutMs: NaN }),
    entry(4, shift("2026-03-07", 3)),
    entry(5, shift("2026-03-07", 4)),
    entry(6, shift("2026-03-06", 5)),
  ];
  const p = L.hoursEmailPlan({
    volunteer: MARIA,
    entries: rows,
    flags: [],
    period: L.hoursEmailPeriod("this", "2026-03-31"),
    todayDate: "2026-03-31",
    listedTokens: LISTED,
  });
  assert.deepEqual(
    p.allShifts.map((s) => s.row),
    [6, 4, 5, 2, 3],
  );
  assert.deepEqual(
    p.monthShifts.map((s) => s.hundredths),
    [500, 300, 400, 100, 200],
  );
});

// ---------------------------------------------------------------------------
// The rest of the pure parts

test("the quota problem: none when the set fits, the limit's words otherwise", () => {
  assert.equal(L.hoursEmailQuotaProblem(2, 2), "");
  assert.equal(L.hoursEmailQuotaProblem(0, 0), "");
  assert.equal(
    L.hoursEmailQuotaProblem(2, 1),
    "This would send 2 emails, and Google allows 1 more from this account today. Untick some, or send the rest tomorrow.",
  );
  assert.equal(
    L.hoursEmailQuotaProblem(1, 0),
    "Google's daily email limit for this account is used up; try again tomorrow.",
  );
});

test("the ticket: read back only before it expires, and a take splits the call's ids", () => {
  const t = plain(
    L.hoursEmailTicket({
      sendId: "abcd1234",
      expiresMs: 10000,
      choice: "this",
      month: "2026-11",
      asOf: "2026-11-14",
      attach: false,
      entries: { a: { digest: "d1" }, b: { digest: "d2" } },
    }),
  );
  const text = JSON.stringify(t);
  assert.deepEqual(plain(L.hoursEmailTicketRead(text, 9999)), t);
  assert.equal(L.hoursEmailTicketRead(text, 10000), null);
  assert.equal(L.hoursEmailTicketRead(null, 0), null);
  assert.equal(L.hoursEmailTicketRead("{oops", 0), null);
  assert.equal(L.hoursEmailTicketRead('{"expiresMs": 5}', 0), null);

  const one = plain(L.hoursEmailTake(t, ["b", "x"], 7500));
  assert.deepEqual(one.taken, [{ id: "b", entry: { digest: "d2" } }]);
  assert.deepEqual(one.missing, ["x"]);
  assert.deepEqual(one.rest.entries, { a: { digest: "d1" } });
  assert.equal(one.rest.sendId, "abcd1234");
  assert.equal(one.seconds, 3);
  const all = plain(L.hoursEmailTake(t, ["a", "b"], 9999.5));
  assert.equal(all.rest, null);
  assert.equal(all.seconds, 1);
  // The ticket itself is left as it was.
  assert.deepEqual(Object.keys(t.entries), ["a", "b"]);

  assert.equal(L.hoursEmailTicketKey("uuid-1"), "hours-email:uuid-1");
  ["", "  ", null, 7, { id: 1 }, "a b", "x".repeat(65)].forEach((bad) =>
    assert.equal(L.hoursEmailTicketKey(bad), "", String(bad)),
  );
  assert.deepEqual(plain(L.hoursEmailIds([" a", "b", "a", "", null, "b "])), ["a", "b"]);
  assert.deepEqual(plain(L.hoursEmailIds("a")), []);
});

test("an Hours emails row: text through sheetText, hours blank on a not-sent row", () => {
  const base = {
    sentAtMs: 5,
    sendId: "abcd1234",
    name: "=Maria Alvarez",
    id: "maria-id",
    to: "=pat@example.org",
    month: "2026-10",
    asOf: "2026-10-31",
    attach: true,
    initials: "JP",
    account: "staff@example.org",
  };
  const sent = plain(
    L.hoursEmailRow({ ...base, result: "sent", totals: { month: 1200, year: 4175, all: 10550 } }),
  );
  assert.deepEqual(Object.keys(sent), plain(L.hoursEmailHeaders()));
  assert.deepEqual(sent, {
    "Sent at": 5,
    "Send ID": "abcd1234",
    "Volunteer Name": "'=Maria Alvarez",
    "Volunteer ID": "maria-id",
    Email: "'=pat@example.org",
    Month: "2026-10",
    "Month hours": 12,
    Year: "2026",
    "Year hours": 41.75,
    "All-time hours": 105.5,
    "Shifts file": "yes",
    "Sent by": "JP",
    "Sent from": "staff@example.org",
    Result: "sent",
  });
  const not = plain(
    L.hoursEmailRow({ ...base, attach: false, result: "not sent: x", totals: null }),
  );
  assert.equal(not["Month hours"], "");
  assert.equal(not["Year hours"], "");
  assert.equal(not["All-time hours"], "");
  assert.equal(not["Shifts file"], "no");
});

test("Last emailed: the newest sent row for the Volunteer ID", () => {
  const rows = [
    { id: "a", result: "sent", ms: 100, date: "2026-11-01", by: "JP" },
    { id: "a", result: "sent", ms: 300, date: "2026-11-03", by: "AB" },
    { id: "a", result: "failed: boom", ms: 400, date: "2026-11-04", by: "JP" },
    { id: "a", result: "not sent: x", ms: 500, date: "2026-11-05", by: "JP" },
    { id: "b", result: "sent", ms: 600, date: "2026-11-06", by: "" },
  ];
  assert.equal(L.hoursEmailLastSent(rows, "a"), "2026-11-03 by AB");
  assert.equal(L.hoursEmailLastSent(rows, "b"), "2026-11-06");
  assert.equal(L.hoursEmailLastSent(rows, "c"), "never");
  assert.equal(L.hoursEmailLastSent([], "a"), "never");
});

test("the log line names the Volunteer ID and the result, never the address problem's text", () => {
  assert.equal(L.hoursEmailLogLine("v1", "sent"), "Hours email: sent (volunteer v1)");
  assert.equal(
    L.hoursEmailLogLine("v1", "failed: Invalid recipient"),
    "Hours email: failed (volunteer v1): Invalid recipient",
  );
  assert.equal(
    L.hoursEmailLogLine(
      "v1",
      'not sent: The email in Volunteer Profiles row 4 isn\'t one email address: "x"',
      "bad-email",
    ),
    "Hours email: not sent (volunteer v1): bad-email",
  );
  assert.equal(
    L.hoursEmailLogLine(
      "v1",
      "not sent: changed since the preview; press Preview again to check it",
    ),
    "Hours email: not sent (volunteer v1): changed since the preview; press Preview again to check it",
  );
});
