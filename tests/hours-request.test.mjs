// Tests for the pure parts of hours requests in apps-script/Logic.js: the Settings mode,
// the Hours requests tab's columns and statuses, which shifts an automatic email leaves
// out and its N, the check-out deadline, overdue and stopped requests, the automatic
// email's added lines, the limits and the quota reserve, the hold reasons, the
// answered-already rule, and the weekly flags email's two hours lines.
//
// The people are invented: "Pat Example" and "Sam Other".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);
const plain = (x) => JSON.parse(JSON.stringify(x));

const HOUR = 3600000;
const MINUTE = 60000;
const DAY = 24 * HOUR;

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
/** The Central wall clock "yyyy-MM-dd HH:mm", as the server's wallClock_ gives it. */
const wall = (ms) => {
  const p = centralParts(ms);
  return p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
};
/** "yyyy-MM-dd HH:mm" Central to milliseconds. */
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
// Fixtures

const PAT = {
  id: "pat-id",
  firstName: "Pat",
  lastName: "Example",
  phoneLast4: "0101",
  startDate: "2026-01-10",
  needsPhoneCheck: false,
  token: "tok-pat",
  row: 14,
};

/** One Log row as readReportLog_ gives it: a closed 2.00-hour shift of Pat's on date. */
function entry(row, date, f = {}) {
  const inMs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? centralMs(date + " 09:00") : NaN;
  return {
    row,
    shiftId: "s-" + row,
    token: PAT.token,
    name: "Pat Example",
    dateText: date,
    recordedInMs: inMs,
    statedInMs: inMs,
    recordedOutMs: inMs + 2 * HOUR,
    statedOutMs: inMs + 2 * HOUR,
    recordedHours: 2,
    statedHours: 2,
    alerts: "",
    notes: "",
    status: "closed",
    outBy: "kiosk",
    inBy: "kiosk",
    roleType: "",
    activity: "",
    statedHoursCell: 2,
    recordedHoursCell: 2,
    ...f,
  };
}
const flag = (shiftId, reviewed, more = {}) => ({
  date: "2026-11-01",
  name: "Pat Example",
  shiftId,
  reason: "Arrival time chosen 40 minutes before the tap",
  raisedAtMs: centralMs("2026-11-01 12:00"),
  reviewed,
  source: "kiosk",
  ...more,
});

/**
 * Pat's Log on 2026-11-20, with every kind of row the checked rule names:
 *   2 flagged, unticked: left out    3 two flags, both ticked: counted
 *   4 auto clock-out, its auto-close flag unticked: left out
 *   5 auto clock-out with no Flags row: counted    6 typed Admin Alerts? text: counted
 *   7 no Shift ID while a "(no Shift ID)" flag is unticked: counted
 *   8 its Flags row deleted: counted    9 open: in N
 *   10 two flags, one ticked and one not: left out
 *   11 dated after today, flag unticked: not in N    12 another token, flag unticked
 *   13 an import: stand-in, flag unticked    14 a plain November shift: counted
 */
function patLog() {
  return [
    entry(2, "2026-11-02"),
    entry(3, "2026-11-03"),
    entry(4, "2026-11-04", { outBy: "auto-close", alerts: "auto clock-out: time guessed" }),
    entry(5, "2026-11-05", { outBy: "auto-close", alerts: "auto clock-out: time guessed" }),
    entry(6, "2026-11-06", { alerts: "Pat said she stayed late" }),
    entry(7, "2026-11-07", { shiftId: "" }),
    entry(8, "2026-11-08"),
    entry(9, "2026-11-19", { status: "open", outBy: "", statedOutMs: NaN, statedHoursCell: "" }),
    entry(10, "2026-11-10"),
    entry(11, "2026-11-25"),
    entry(12, "2026-11-11", { token: "tok-sam", name: "Sam Other" }),
    entry(13, "2025-05-04", { token: "import:pat example", shiftId: "import-0001" }),
    entry(14, "2026-11-14"),
  ];
}
function patFlags() {
  return [
    flag("s-2", false),
    flag("s-3", true),
    flag("s-3", true, { reason: "Long shift" }),
    flag("s-4", false, { source: "auto-close" }),
    flag("(no Shift ID)", false, { source: "log-check" }),
    flag("s-10", true),
    flag("s-10", false, { reason: "Long shift" }),
    flag("s-11", false),
    flag("s-12", false),
    flag("import-0001", false),
  ];
}
const TODAY = "2026-11-20";

const req = (f = {}) => ({
  row: 2,
  requestedMs: centralMs("2026-11-20 10:00"),
  name: "Pat Example",
  id: PAT.id,
  mode: "Auto",
  status: "waiting",
  reason: "",
  doneAtMs: NaN,
  doneBy: "",
  sendId: "",
  ...f,
});

// ---------------------------------------------------------------------------
// The mode

test("parseHoursRequestsMode: Approve and Auto in any case; blank, On and typos are Off", () => {
  assert.equal(L.parseHoursRequestsMode("Approve"), "approve");
  assert.equal(L.parseHoursRequestsMode(" APPROVE "), "approve");
  assert.equal(L.parseHoursRequestsMode("auto"), "auto");
  assert.equal(L.parseHoursRequestsMode("Auto\n"), "auto");
  assert.equal(L.parseHoursRequestsMode("Off"), "off");
  for (const text of ["", "On", "Automatic", "aproove", "yes", null, undefined, 1]) {
    assert.equal(L.parseHoursRequestsMode(text), "off", String(text));
  }
  assert.equal(L.hoursRequestModeText("auto"), "Auto");
  assert.equal(L.hoursRequestModeText("approve"), "Approve");
  assert.equal(L.hoursRequestModeText("off"), "Off");
});

// ---------------------------------------------------------------------------
// The tab

test("the Hours requests tab: header, kinds, columns found by header exactly once", () => {
  assert.deepEqual(plain(L.hoursRequestHeaders()), [
    "Requested at",
    "Volunteer Name",
    "Volunteer ID",
    "Mode",
    "Status",
    "Reason",
    "Done at",
    "Done by",
    "Send ID",
  ]);
  const kinds = L.hoursRequestColumnKinds();
  assert.equal(kinds["Requested at"], "date");
  assert.equal(kinds["Done at"], "date");
  assert.equal(kinds.Status, "text");
  const moved = L.hoursRequestHeaders().slice().reverse();
  assert.equal(L.hoursRequestColumns(moved)["Send ID"], 0);
  assert.throws(
    () => L.hoursRequestColumns(L.hoursRequestHeaders().slice(1)),
    /The Hours requests tab needs exactly one "Requested at" column/,
  );
  assert.throws(
    () => L.hoursRequestColumns(L.hoursRequestHeaders().concat(["Status"])),
    /exactly one "Status"/,
  );
  assert.match(L.hoursRequestProtectionDescription(), /type closed in Status/);
});

test("a new request's row: waiting, the mode as words, text through sheetText", () => {
  const row = L.hoursRequestRow({ requestedMs: 5, name: "=Pat", id: "pat-id", mode: "approve" });
  assert.deepEqual(plain(row), {
    "Requested at": 5,
    "Volunteer Name": "'=Pat",
    "Volunteer ID": "pat-id",
    Mode: "Approve",
    Status: "waiting",
    Reason: "",
    "Done at": "",
    "Done by": "",
    "Send ID": "",
  });
});

test("open status: waiting, sending and held in any case; closed, sent and blank are done", () => {
  for (const s of ["waiting", "Sending", " HELD "]) assert.equal(L.isOpenHoursRequest(s), true, s);
  for (const s of ["closed", "sent", "", "Closed ", "done", null]) {
    assert.equal(L.isOpenHoursRequest(s), false, String(s));
  }
  const list = [
    req({ status: "sent" }),
    req({ id: "sam-id", status: "waiting" }),
    req({ status: "Held", row: 5 }),
  ];
  assert.equal(L.hoursRequestOpenFor(list, "pat-id").row, 5);
  assert.equal(L.hoursRequestOpenFor(list, "nobody"), null);
  assert.equal(L.hoursRequestOpenFor([req({ status: "closed" })], "pat-id"), null);
});

// ---------------------------------------------------------------------------
// The checked rule and N

test("left out only with an unticked Flags row of the same Shift ID; N adds open rows", () => {
  const out = L.hoursRequestEntries(patLog(), PAT, patFlags(), TODAY);
  const kept = new Set(out.entries.map((e) => e.row));
  // Left out: the unticked flag, the auto clock-out with its flag, one of two unticked.
  for (const row of [2, 4, 10]) assert.equal(kept.has(row), false, "row " + row);
  // Counted as Email hours counts them, and everything else stays for the plan to judge.
  for (const row of [3, 5, 6, 7, 8, 9, 11, 12, 13, 14]) {
    assert.equal(kept.has(row), true, "row " + row);
  }
  // N: rows 2, 4 and 10, plus the open row 9; not 11 (future), 12 (Sam), 13 (stand-in).
  assert.equal(out.unchecked, 4);

  // The plan from what is kept counts rows 3, 5, 6, 7, 8 and 14.
  const plan = L.hoursEmailPlan({
    volunteer: PAT,
    entries: out.entries,
    flags: patFlags(),
    period: L.hoursEmailPeriod("this", TODAY),
    todayDate: TODAY,
    listedTokens: [PAT.token, "tok-sam"],
    attach: true,
  });
  assert.deepEqual(
    plain(plan.allShifts.map((s) => s.row)),
    [3, 5, 6, 7, 8, 14],
  );
  assert.equal(plan.all.hundredths, 1200);
});

test("ticking the flag, or deleting its row, puts a shift back; with no flags nothing is left out", () => {
  const ticked = patFlags().map((f) => ({ ...f, reviewed: true }));
  const all = L.hoursRequestEntries(patLog(), PAT, ticked, TODAY);
  assert.equal(all.entries.length, patLog().length);
  assert.equal(all.unchecked, 1); // the open row
  const deleted = patFlags().filter((f) => f.shiftId !== "s-2");
  const out = L.hoursRequestEntries(patLog(), PAT, deleted, TODAY);
  assert.ok(out.entries.some((e) => e.row === 2));
  assert.equal(out.unchecked, 3);
  assert.equal(L.hoursRequestEntries(patLog(), PAT, [], TODAY).unchecked, 1);
  // A flagged row dated after the as-of date isn't left out or counted in N.
  const early = L.hoursRequestEntries(patLog(), PAT, patFlags(), "2026-11-03");
  assert.equal(early.unchecked, 2); // row 2 and the open row
});

// ---------------------------------------------------------------------------
// The check-out deadline

test("the deadline is the first 6:00 AM Central after the request", () => {
  assert.equal(L.hoursRequestDeadline("2026-11-20 02:00"), "2026-11-20 06:00");
  assert.equal(L.hoursRequestDeadline("2026-11-20 05:59"), "2026-11-20 06:00");
  assert.equal(L.hoursRequestDeadline("2026-11-20 06:00"), "2026-11-21 06:00");
  assert.equal(L.hoursRequestDeadline("2026-11-20 14:00"), "2026-11-21 06:00");
  assert.equal(L.hoursRequestDeadline("2026-12-31 23:00"), "2027-01-01 06:00");
  assert.equal(L.hoursRequestDeadline("not a time"), "");
});

test("past the deadline across both daylight-saving changes, measured on the Central clock", () => {
  const open = (inText) => entry(30, inText.slice(0, 10), {
    status: "open",
    recordedInMs: centralMs(inText),
    statedInMs: centralMs(inText),
  });
  const past = (reqText, shift, nowText) =>
    L.hoursRequestPastDeadline(centralMs(reqText), shift, centralMs(nowText), wall);
  // Clocks fall back at 2 AM on 2026-11-01: the day has 25 hours.
  const fallShift = open("2026-10-31 13:00");
  assert.equal(past("2026-10-31 14:00", fallShift, "2026-11-01 05:59"), false);
  assert.equal(past("2026-10-31 14:00", fallShift, "2026-11-01 06:00"), true);
  assert.equal(
    L.hoursRequestPastDeadline(
      centralMs("2026-10-31 14:00"),
      fallShift,
      centralMs("2026-11-01 06:00") - 1,
      wall,
    ),
    false,
  );
  // A request in the repeated hour still waits for that morning's 6:00.
  const repeated = Date.UTC(2026, 10, 1, 7, 30); // the second 1:30, CST
  assert.equal(wall(repeated), "2026-11-01 01:30");
  assert.equal(
    L.hoursRequestPastDeadline(repeated, fallShift, centralMs("2026-11-01 05:00"), wall),
    false,
  );
  // Clocks spring forward at 2 AM on 2026-03-08: the day has 23 hours.
  const springShift = open("2026-03-07 18:00");
  assert.equal(past("2026-03-07 23:00", springShift, "2026-03-08 05:59"), false);
  assert.equal(past("2026-03-07 23:00", springShift, "2026-03-08 06:00"), true);
  assert.equal(centralMs("2026-03-08 06:00") - centralMs("2026-03-07 23:00"), 6 * HOUR);
});

test("the deadline never falls before the shift began", () => {
  // Asked on the 15th under Approve; switched to Auto; checked in again on the 17th.
  const shift = entry(31, "2026-11-17", {
    status: "open",
    recordedInMs: centralMs("2026-11-17 09:55"),
    statedInMs: centralMs("2026-11-17 09:30"),
  });
  const asked = centralMs("2026-11-15 23:00");
  assert.equal(L.hoursRequestPastDeadline(asked, shift, centralMs("2026-11-17 10:00"), wall), false);
  assert.equal(L.hoursRequestPastDeadline(asked, shift, centralMs("2026-11-18 05:59"), wall), false);
  assert.equal(L.hoursRequestPastDeadline(asked, shift, centralMs("2026-11-18 06:00"), wall), true);
  // A shift with no readable time is measured from the request.
  const blank = { ...shift, recordedInMs: NaN, statedInMs: NaN };
  assert.equal(L.hoursRequestPastDeadline(asked, blank, centralMs("2026-11-16 06:00"), wall), true);
});

// ---------------------------------------------------------------------------
// Overdue and stopped part way

test("overdue: in Auto, waiting 24 hours; never in Approve or Off, never held or sending", () => {
  const at = centralMs("2026-11-20 10:00");
  const r = req({ requestedMs: at });
  assert.equal(L.hoursRequestOverdue(r, "auto", at + DAY - 1), false);
  assert.equal(L.hoursRequestOverdue(r, "auto", at + DAY), true);
  assert.equal(L.hoursRequestOverdue(r, "auto", at + DAY + 1), true);
  for (const mode of ["approve", "off"]) {
    assert.equal(L.hoursRequestOverdue(r, mode, at + 3 * DAY), false, mode);
  }
  for (const status of ["held", "sending", "sent", "closed"]) {
    assert.equal(L.hoursRequestOverdue({ ...r, status }, "auto", at + 3 * DAY), false, status);
  }
  // A Requested at that can't be read shows as overdue rather than hiding.
  assert.equal(L.hoursRequestOverdue({ ...r, requestedMs: NaN }, "auto", at), true);
});

test("stopped part way: sending more than 30 minutes", () => {
  const done = centralMs("2026-11-20 10:15");
  const r = req({ status: "sending", doneAtMs: done });
  assert.equal(L.hoursRequestStopped(r, done + 30 * MINUTE - 1), false);
  assert.equal(L.hoursRequestStopped(r, done + 30 * MINUTE), false);
  assert.equal(L.hoursRequestStopped(r, done + 30 * MINUTE + 1), true);
  assert.equal(L.hoursRequestStopped({ ...r, doneAtMs: NaN }, done), true);
  assert.equal(L.hoursRequestStopped({ ...r, status: "held" }, done + DAY), false);
});

test("who needs a person, by mode", () => {
  const now = centralMs("2026-11-22 10:00");
  const list = [
    req({ status: "waiting", requestedMs: now - HOUR }),
    req({ status: "waiting", requestedMs: now - 2 * DAY }),
    req({ status: "held" }),
    req({ status: "sending", doneAtMs: now - 5 * MINUTE }),
    req({ status: "sending", doneAtMs: now - HOUR }),
    req({ status: "sent" }),
    req({ status: "closed" }),
  ];
  assert.equal(L.hoursRequestsWaitingCount(list, "auto", now), 3); // overdue, held, stopped
  assert.equal(L.hoursRequestsWaitingCount(list, "approve", now), 4); // both waiting, held, stopped
  assert.equal(L.hoursRequestsWaitingCount(list, "off", now), 4);
  assert.equal(L.hoursRequestsWaitingCount([], "auto", now), 0);
});

// ---------------------------------------------------------------------------
// The automatic email

function autoEmail(entries, flags, attach = true) {
  const out = L.hoursRequestEntries(entries, PAT, flags, TODAY);
  const plan = L.hoursEmailPlan({
    volunteer: PAT,
    entries: out.entries,
    flags,
    period: L.hoursEmailPeriod("this", TODAY),
    todayDate: TODAY,
    listedTokens: [PAT.token],
    attach,
  });
  const message = L.hoursEmailMessage({
    firstName: PAT.firstName,
    plan,
    attach,
    contact: "Angela, volunteer@example.org",
    signature: "",
    request: { date: "2026-11-20", unchecked: out.unchecked },
  });
  return { out, plan, message };
}

test("the automatic email: the kiosk line, the N line, the file of counted shifts only", () => {
  const { plan, message } = autoEmail(patLog(), patFlags());
  const body = message.body;
  assert.match(
    body,
    /^Hi Pat,\n\nYou asked for your hours at the volunteer kiosk on Friday, November 20, 2026\.\n\nHere are the volunteer hours/,
  );
  assert.ok(
    body.includes("4 shifts are waiting for staff review and aren't in these totals."),
    body,
  );
  // The N line comes after the month's shifts and before the file line.
  const nAt = body.indexOf("4 shifts are waiting");
  assert.ok(body.indexOf("Your shifts in November 2026:") < nAt);
  assert.ok(nAt < body.indexOf("All 6 of your shifts are in the attached"));
  const csv = L.hoursEmailCsv(plan.allShifts, () => "9:00 AM");
  assert.equal(csv.trim().split("\r\n").length, 1 + 6);
  for (const date of ["2026-11-02", "2026-11-04", "2026-11-10", "2026-11-19"]) {
    assert.equal(csv.includes(date), false, date);
  }
  // No Shift ID, token, flag or alert text in the body or the file.
  for (const text of ["s-2", "tok-pat", "Arrival time", "auto clock-out", "stayed late"]) {
    assert.equal(body.includes(text), false, text);
    assert.equal(csv.includes(text), false, text);
  }
});

test("the N line for 0, 1 and 3, and zero totals instead of the no-hours line", () => {
  const ticked = patFlags().map((f) => ({ ...f, reviewed: true }));
  const closedOnly = patLog().filter((e) => e.status !== "open");
  const none = autoEmail(closedOnly, ticked).message.body;
  assert.equal(/waiting for staff review/.test(none), false);
  const one = autoEmail(patLog(), ticked).message.body;
  assert.ok(one.includes("1 shift is waiting for staff review and isn't in these totals."));
  const three = autoEmail(
    patLog().filter((e) => e.row !== 10),
    patFlags(),
  ).message.body;
  assert.ok(three.includes("3 shifts are waiting for staff review and aren't in these totals."));

  // Every counted shift is unchecked: zero totals, then the line, and no file.
  const onlyFlagged = [entry(2, "2026-11-02"), entry(9, "2026-11-19", { status: "open" })];
  const zero = autoEmail(onlyFlagged, patFlags()).message.body;
  assert.equal(zero.includes("We don't have any volunteer hours recorded for you yet."), false);
  assert.ok(zero.includes("  November 2026 so far: 0.00 hours (0 shifts)"), zero);
  assert.ok(zero.includes("  2026 so far: 0.00 hours (0 shifts)"));
  assert.ok(zero.includes("  All time: 0.00 hours (0 shifts)"));
  assert.ok(
    zero.indexOf("All time: 0.00") < zero.indexOf("2 shifts are waiting for staff review"),
  );
  assert.equal(zero.includes("attached"), false);
  assert.equal(zero.includes("No shifts yet in"), false);

  // Nothing at all: the usual no-hours line, with the kiosk line.
  const empty = autoEmail([], []).message.body;
  assert.ok(empty.includes("We don't have any volunteer hours recorded for you yet."));
  assert.ok(empty.includes("You asked for your hours at the volunteer kiosk"));
});

test("an admin's email is unchanged: no kiosk line, no N line", () => {
  const plan = L.hoursEmailPlan({
    volunteer: PAT,
    entries: patLog(),
    flags: patFlags(),
    period: L.hoursEmailPeriod("this", TODAY),
    todayDate: TODAY,
    listedTokens: [PAT.token],
    attach: false,
  });
  const body = L.hoursEmailMessage({
    firstName: "Pat",
    plan,
    attach: false,
    contact: "Angela",
    signature: "",
  }).body;
  assert.equal(body.includes("kiosk"), false);
  assert.equal(body.includes("waiting for staff review"), false);
  assert.equal(L.hoursRequestLeftOutReason(0), "");
  assert.equal(L.hoursRequestLeftOutReason(1), "1 shift left out for review");
  assert.equal(L.hoursRequestLeftOutReason(3), "3 shifts left out for review");
});

// ---------------------------------------------------------------------------
// Limits and the quota

const send = (f) => ({ id: PAT.id, result: "sent", ms: NaN, date: "", by: "auto", ...f });

test("the week limit: 7 days to the millisecond, automatic counted rows only", () => {
  const now = centralMs("2026-11-25 10:00");
  const at = (ms) => send({ ms, date: wall(ms).slice(0, 10) });
  const inside = at(now - 7 * DAY + 1);
  assert.deepEqual(plain(L.hoursRequestLimit([inside], PAT.id, now, "2026-11-25")), {
    code: "week",
    reason: "Already emailed automatically on Nov 18; Auto sends one a week.",
  });
  assert.equal(L.hoursRequestLimit([at(now - 7 * DAY - 1)], PAT.id, now, "2026-11-25"), null);
  assert.equal(L.hoursRequestLimit([at(now - 7 * DAY)], PAT.id, now, "2026-11-25"), null);
  // sent, sending and stopped rows count; failed and not sent don't.
  for (const result of ["sent", "sending", "stopped: the automatic run ended before it recorded"]) {
    assert.equal(
      L.hoursRequestLimit([{ ...inside, result }], PAT.id, now, "2026-11-25").code,
      "week",
      result,
    );
  }
  for (const result of ["failed: Service invoked too many times", "not sent: the run ran out of time"]) {
    assert.equal(L.hoursRequestLimit([{ ...inside, result }], PAT.id, now, "2026-11-25"), null);
  }
  // Only "auto" counts: an admin's send, or initials AUTO, doesn't use up the week.
  assert.equal(L.hoursRequestLimit([{ ...inside, by: "AUTO" }], PAT.id, now, "2026-11-25"), null);
  assert.equal(L.hoursRequestLimit([{ ...inside, by: "JP" }], PAT.id, now, "2026-11-25"), null);
  // Another volunteer's send doesn't either.
  assert.equal(L.hoursRequestLimit([{ ...inside, id: "sam-id" }], PAT.id, now, "2026-11-25"), null);
  // The newest send names the date.
  const two = [at(now - 6 * DAY), at(now - 2 * DAY)];
  assert.match(L.hoursRequestLimit(two, PAT.id, now, "2026-11-25").reason, /on Nov 23;/);
});

test("the day limit: 50 counted on the Central date, the claim's own included", () => {
  // 7:30 PM Central on Nov 20 is already Nov 21 in UTC.
  const now = centralMs("2026-11-20 19:30");
  assert.equal(new Date(now).toISOString().slice(0, 10), "2026-11-21");
  const others = (n, date) =>
    Array.from({ length: n }, (_, i) =>
      send({ id: "v" + i, ms: now - 10 * DAY, date, result: i % 2 ? "sending" : "sent" }),
    );
  assert.equal(L.hoursRequestLimit(others(49, "2026-11-20"), PAT.id, now, "2026-11-20"), null);
  assert.deepEqual(plain(L.hoursRequestLimit(others(50, "2026-11-20"), PAT.id, now, "2026-11-20")), {
    code: "day",
    reason: "Auto already sent 50 today.",
  });
  // Rows dated by the UTC day don't count against the Central day.
  assert.equal(L.hoursRequestLimit(others(50, "2026-11-21"), PAT.id, now, "2026-11-20"), null);
  // The claim's own rows count: 49 read plus one this claim added.
  const claimed = others(49, "2026-11-20").concat([
    send({ id: "sam-id", ms: now, date: "2026-11-20", result: "sending" }),
  ]);
  assert.equal(L.hoursRequestLimit(claimed, PAT.id, now, "2026-11-20").code, "day");
  // Failed rows and admin rows don't count toward 50.
  const failed = others(49, "2026-11-20").concat([
    send({ id: "x", ms: now, date: "2026-11-20", result: "failed: x" }),
    send({ id: "y", ms: now, date: "2026-11-20", by: "JP" }),
  ]);
  assert.equal(L.hoursRequestLimit(failed, PAT.id, now, "2026-11-20"), null);
});

test("the quota reserve: send only above 100", () => {
  assert.equal(L.hoursRequestQuotaOk(101), true);
  assert.equal(L.hoursRequestQuotaOk(100), false);
  assert.equal(L.hoursRequestQuotaOk(0), false);
  assert.equal(L.hoursRequestQuotaOk(1500), true);
});

test("the weekly count of automatic sends: sent or tried in the last 7 days", () => {
  const now = centralMs("2026-11-23 08:00");
  const sends = [
    send({ ms: now - HOUR }),
    send({ ms: now - 2 * DAY, result: "sending" }),
    send({ ms: now - 3 * DAY, result: "stopped: the automatic run ended" }),
    send({ ms: now - 4 * DAY, result: "failed: x" }),
    send({ ms: now - 4 * DAY, result: "not sent: the run ran out of time" }),
    send({ ms: now - DAY, by: "JP" }),
    send({ ms: now - 8 * DAY }),
    send({ ms: NaN }),
  ];
  assert.equal(L.hoursAutoSentCount(sends, now), 3);
  assert.equal(L.hoursAutoSentCount([], now), 0);
});

// ---------------------------------------------------------------------------
// Answered already

test("answered already: a sent row after Requested at answers; before it, or failed, doesn't", () => {
  const asked = centralMs("2026-11-20 10:00");
  const rows = [
    send({ ms: asked - 1, sendId: "old" }),
    send({ ms: asked + HOUR, result: "failed: x", sendId: "bad" }),
    send({ ms: asked + 3 * HOUR, by: "JP", sendId: "admin" }),
    send({ ms: asked + 2 * HOUR, sendId: "auto1" }),
    send({ ms: asked + HOUR, id: "sam-id", sendId: "sam" }),
  ];
  assert.equal(L.hoursRequestAnswer(rows, PAT.id, asked).sendId, "auto1");
  assert.equal(L.hoursRequestAnswer(rows.slice(0, 2), PAT.id, asked), null);
  assert.equal(L.hoursRequestAnswer([send({ ms: asked, sendId: "same" })], PAT.id, asked), null);
  assert.equal(L.hoursRequestAnswer(rows.slice(2, 3), PAT.id, asked).by, "JP");
  assert.equal(L.hoursRequestAnswer([send({ ms: asked + 1, result: "Sent" })], PAT.id, asked), null);
});

// ---------------------------------------------------------------------------
// Holds and the decision before a claim

const PROFILE_HEADER = ["Volunteer First Name", "Volunteer Last Name", "Email", "User Token"];
function decide(over = {}) {
  return L.hoursRequestDecide({
    request: req(),
    volunteer: PAT,
    address: { email: "pat@example.org", row: 14, rows: [14], problem: "", text: "" },
    contact: "Angela",
    flagsRead: true,
    openShift: null,
    nowMs: centralMs("2026-11-20 10:15"),
    wallClock: wall,
    quota: 1400,
    ...over,
  });
}

test("each hold reason, from profileEmailsFrom's codes", () => {
  const rows = Array.from({ length: 30 }, () => ["", "", "", ""]);
  rows[12] = ["Pat", "Example", "", "tok-pat"]; // row 14: blank Email
  rows[13] = ["Sam", "Other", "sam@example.org, pat@example.org", "tok-sam"]; // row 15
  rows[16] = ["Ana", "Diaz", "a@example.org", "tok-ana"]; // row 18
  rows[28] = ["Ana", "Diaz", "b@example.org", "tok-ana"]; // row 30
  const SAM = { ...PAT, id: "sam-id", token: "tok-sam" };
  const ANA = { ...PAT, id: "ana-id", token: "tok-ana" };
  const GONE = { ...PAT, id: "gone-id", token: "tok-gone" };
  const emails = L.profileEmailsFrom(PROFILE_HEADER, rows, [PAT, SAM, ANA, GONE]);
  const reason = (v, address) => decide({ volunteer: v, address }).reason;
  assert.equal(reason(PAT, emails[PAT.id]), "No email on their Volunteer Profiles row (row 14).");
  assert.equal(
    reason(SAM, emails[SAM.id]),
    "Their Volunteer Profiles Email cell (row 15) isn't one email address.",
  );
  assert.equal(
    reason(ANA, emails[ANA.id]),
    "Volunteer Profiles rows 18 and 30 have the same User Token.",
  );
  assert.equal(reason(GONE, emails[GONE.id]), "Not on the volunteer list any more.");
  assert.equal(reason(null, null), "Not on the volunteer list any more.");
  const noColumn = L.profileEmailsFrom(["Volunteer First Name", "User Token"], [["Pat", "tok-pat"]], [PAT]);
  assert.equal(reason(PAT, noColumn[PAT.id]), "Volunteer Profiles has no Email column.");
  assert.deepEqual(plain(decide({ contact: "  " })), {
    action: "hold",
    code: "contact",
    reason: "Hours email contact on the Settings tab is blank.",
  });
  assert.equal(
    decide({ flagsRead: false }).reason,
    "The Flags tab couldn't be read, so shifts couldn't be checked.",
  );
  // No reason quotes an address.
  for (const v of [PAT, SAM, ANA, GONE]) {
    assert.equal(/@/.test(reason(v, emails[v.id])), false);
  }
  assert.equal(
    L.hoursRequestHoldReason("send-failed", { message: "Invalid email: pat@example.org" }),
    "The send failed: Invalid email: [address]",
  );
  assert.match(L.hoursRequestHoldReason("stopped"), /^An automatic send stopped part way and may have gone\. Check this volunteer's Hours emails row \(Result stopped\)/);
});

test("checked in: wait before the deadline, hold at it; the quota stops; else send", () => {
  const open = entry(30, "2026-11-20", {
    status: "open",
    recordedInMs: centralMs("2026-11-20 09:00"),
    statedInMs: centralMs("2026-11-20 09:00"),
  });
  assert.deepEqual(plain(decide({ openShift: open })), {
    action: "wait",
    code: "checked-in",
    reason: "",
  });
  const held = decide({ openShift: open, nowMs: centralMs("2026-11-21 06:00") });
  assert.equal(held.action, "hold");
  assert.equal(
    held.reason,
    "Still checked in at 6:00 AM. Close the shift with Kiosk admin > Fix a sign-out, then send from Email hours.",
  );
  assert.equal(decide({ quota: 100 }).action, "quota");
  assert.equal(decide({ quota: 101 }).action, "send");
  // An odd case holds before the check-in wait; the wait comes before the quota.
  assert.equal(decide({ openShift: open, contact: "" }).code, "contact");
  assert.equal(decide({ openShift: open, quota: 0 }).action, "wait");
  // A Requested at that can't be read waits (and shows to staff as overdue).
  assert.equal(decide({ request: req({ requestedMs: NaN }) }).action, "wait");
});

// ---------------------------------------------------------------------------
// The weekly flags email

const none = { recent: [], unreviewed: 0 };
const fresh = { stale: false, lastRun: "2026-11-23 04:00" };
const flagsMsg = (more) =>
  L.flagsEmailMessage({ summary: none, autoClockOut: fresh, flagsUrl: "u", ...more });

test("the flags email's hours lines: at 3 each, none at 0, missing reads as 0", () => {
  assert.equal(flagsMsg({}), null);
  assert.equal(flagsMsg({ autoSent: 0, requestsWaiting: 0 }), null);
  const both = flagsMsg({ autoSent: 3, requestsWaiting: 3 });
  assert.ok(both.body.includes("Hours emails sent automatically in the last 7 days: 3 (see the Hours emails tab)."));
  assert.ok(both.body.includes("Hours requests waiting for staff: 3 (Kiosk admin > Email hours…)"));
  assert.ok(
    both.body.indexOf("Flags still unreviewed: 0") <
      both.body.indexOf("Hours emails sent automatically"),
  );
  assert.ok(both.htmlBody.includes("Hours requests waiting for staff: 3"));
  // Either alone is news, with the hours subject.
  assert.equal(flagsMsg({ autoSent: 1 }).subject, "Volunteer kiosk: hours requests this week");
  assert.equal(flagsMsg({ requestsWaiting: 2 }).subject, "Volunteer kiosk: hours requests this week");
  assert.equal(flagsMsg({ autoSent: 1 }).body.includes("waiting for staff"), false);
  // With flag news too, the subject doesn't change.
  const withFlags = L.flagsEmailMessage({
    summary: { recent: [], unreviewed: 2 },
    autoClockOut: fresh,
    flagsUrl: "u",
    autoSent: 1,
  });
  assert.equal(withFlags.subject, "Volunteer kiosk: 0 new flags this week, 2 unreviewed");
  assert.equal(
    L.flagsEmailMessage({ summary: { recent: [], unreviewed: 2 }, autoClockOut: fresh, flagsUrl: "u" })
      .body.includes("Hours"),
    false,
  );
});

test("the flags email's couldn't-be-read lines are news too", () => {
  const sent = flagsMsg({ autoSent: null });
  assert.equal(sent.subject, "Volunteer kiosk: hours requests this week");
  assert.ok(
    sent.body.includes(
      "Hours emails sent automatically in the last 7 days: couldn't be read (check the Hours emails tab's header row)",
    ),
  );
  const waiting = flagsMsg({ requestsWaiting: null });
  assert.ok(
    waiting.body.includes(
      "Hours requests waiting for staff: couldn't be read (check the Hours requests tab's header row)",
    ),
  );
});

test("the waiting count by mode feeds the line", () => {
  const now = centralMs("2026-11-23 08:00");
  const list = [req({ requestedMs: now - HOUR }), req({ status: "held" })];
  assert.match(
    flagsMsg({ requestsWaiting: L.hoursRequestsWaitingCount(list, "approve", now) }).body,
    /waiting for staff: 2 /,
  );
  assert.match(
    flagsMsg({ requestsWaiting: L.hoursRequestsWaitingCount(list, "auto", now) }).body,
    /waiting for staff: 1 /,
  );
  assert.equal(L.hoursRequestShortDate("2026-11-20"), "Nov 20");
  assert.equal(L.hoursRequestShortDate("2026-01-02"), "Jan 2");
});
