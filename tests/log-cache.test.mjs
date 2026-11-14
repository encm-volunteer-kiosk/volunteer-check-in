// Tests for the Log cache section of apps-script/Logic.js: each volunteer's Log state,
// the cached text, the check of whether a cached map may be used, and the fills after a
// kiosk write. Logic.js is loaded the way Apps Script loads it, in its own global scope,
// so results are compared through same(), which keeps NaN apart from null.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

/** A value as JSON with NaN kept as the text "NaN", so two values compare across scopes. */
const same = (x) =>
  JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "number" && Number.isNaN(v) ? "NaN" : v)));
const plain = (x) => JSON.parse(JSON.stringify(x));

const MIN = 60000;
const HOUR = 60 * MIN;
const TODAY = "2026-11-12";
// 10:00 Central on 2026-11-12 (Central is UTC-6 in November).
const NOW = Date.parse("2026-11-12T16:00:00Z");
/** A Central wall-clock time on a date, in ms. */
const at = (date, hhmm) => Date.parse(date + "T" + hhmm + ":00-06:00");
const CENTRAL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const centralDate = (ms) => CENTRAL_DAY.format(new Date(ms));

const H = plain(L.logHeaderNames());

// ---------------------------------------------------------------------------
// The fixture Log
//
// Invented volunteers. Row numbers are sheet rows; the rows are not in date order.

const vol = (id, firstName, lastName, token, extra = {}) => ({
  id,
  firstName,
  lastName,
  phoneLast4: "0100",
  startDate: "2026-10-01",
  needsPhoneCheck: false,
  token,
  row: 2,
  ...extra,
});

const AVERY = vol("a000000000000001", "Avery", "Quinn", "tok-avery", { startDate: "2026-11-05" });
const BLAKE = vol("a000000000000002", "Blake", "Ortiz", "tok-blake");
const CASEY = vol("a000000000000003", "Casey", "Noor", "tok-casey");
const DANA = vol("a000000000000004", "Dana", "Vance", "tok-dana");
const ELLIS = vol("a000000000000005", "Ellis", "Grey", "tok-ellis");
const FRANKIE = vol("a000000000000006", "Frankie", "Hale", "tok-frankie");
const GALE = vol("a000000000000007", "Gale", "Moss", "tok-gale");
const HARPER = vol("a000000000000008", "Harper", "Sol", "tok-harper", { startDate: "2026-11-11" });
const INDIGO = vol("a000000000000009", "Indigo", "Reyes", "tok-indigo");
const KAI = vol("a00000000000000a", "Kai", "Brooks", "tok-kai");
// A same-name pair: both need their digits.
const JORDAN1 = vol("a00000000000000b", "Jordan", "Pike", "tok-jordan-1", {
  needsPhoneCheck: true,
  phoneLast4: "0111",
});
const JORDAN2 = vol("a00000000000000c", "Jordan", "Pike", "tok-jordan-2", {
  needsPhoneCheck: true,
  phoneLast4: "0222",
});
const VOLUNTEERS = [
  AVERY,
  BLAKE,
  CASEY,
  DANA,
  ELLIS,
  FRANKIE,
  GALE,
  HARPER,
  INDIGO,
  KAI,
  JORDAN1,
  JORDAN2,
];
const TOKENS = VOLUNTEERS.map((v) => v.token);

/** A Log entry as logEntry gives it. */
const entry = (row, token, fields = {}) => ({
  row,
  shiftId: "5f0c2a1e-0000-4000-8000-" + String(row).padStart(12, "0"),
  token,
  name: "Invented Name",
  dateText: TODAY,
  recordedInMs: NaN,
  statedInMs: NaN,
  recordedOutMs: NaN,
  statedOutMs: NaN,
  recordedHours: NaN,
  statedHours: NaN,
  alerts: "",
  notes: "",
  status: "open",
  outBy: "",
  ...fields,
});

/** A closed row on date from start to end (Central "HH:mm"), checked out by outBy. */
const closed = (row, token, date, start, end, outBy = "kiosk", extra = {}) => {
  const s = at(date, start);
  const e = at(date, end);
  return entry(row, token, {
    dateText: date,
    recordedInMs: s,
    statedInMs: s,
    recordedOutMs: e,
    statedOutMs: e,
    recordedHours: (e - s) / HOUR,
    statedHours: (e - s) / HOUR,
    status: "closed",
    outBy,
    ...extra,
  });
};

/** An open row on date, checked in at tapMs, with the arrival stated at statedMs. */
const open = (row, token, date, tapMs, statedMs = tapMs, extra = {}) =>
  entry(row, token, {
    dateText: date,
    recordedInMs: tapMs,
    statedInMs: statedMs,
    ...extra,
  });

/**
 * The fixture Log. jordan is which of the same-name pair is in: "one", "both" or
 * "neither".
 */
function fixtureLog(jordan = "one") {
  const rows = [
    // Avery: closed by kiosk and by initials, one before the launch date, 49.5 hours in
    // all, and an open row in the window, so a two-hour check-out crosses 50 hours.
    closed(2, "tok-avery", "2026-10-20", "09:00", "12:00"),
    closed(3, "tok-avery", "2026-11-03", "09:00", "13:00"),
    closed(4, "tok-avery", "2026-11-05", "09:00", "11:30"),
    closed(5, "tok-avery", "2026-11-07", "06:00", "06:00", "JP", { statedHours: 40 }),
    // Blake: closed by the auto clock-out and typed, then an open row 13 hours old.
    closed(6, "tok-blake", "2026-11-08", "09:00", "12:00", "auto-close"),
    closed(7, "tok-blake", "2026-11-09", "09:00", "11:00", ""),
    open(8, "tok-blake", "2026-11-11", NOW - 13 * HOUR),
    // Casey: a closed row, and an open row today with no readable time.
    closed(10, "tok-casey", "2026-11-10", "09:00", "10:00"),
    // Dana: an open row yesterday with no readable time.
    entry(11, "tok-dana", { dateText: "2026-11-11" }),
    // Ellis: seven closed rows, a closed import row, a closed undated row and two open
    // rows today, so a check-out makes ten shifts.
    ...[2, 3, 4, 5, 6, 7, 8].map((d, i) =>
      closed(12 + i, "tok-ellis", "2026-11-" + String(d).padStart(2, "0"), "09:00", "10:00"),
    ),
    closed(21, "tok-ellis", "2026-11-11", "09:00", "12:00", "import", {
      shiftId: "import-0123456789abcdef",
      recordedInMs: NaN,
      statedInMs: NaN,
      recordedOutMs: NaN,
      statedOutMs: NaN,
      recordedHours: NaN,
    }),
    closed(22, "tok-ellis", "2026-11-01", "09:00", "11:00", "", { dateText: "" }),
    // Gale: a row before the launch date, closed by the auto clock-out, and a later
    // imported row, which is never the last.
    closed(23, "tok-gale", "2026-11-11", "09:00", "12:00", "import", {
      shiftId: "IMPORT-fedcba9876543210",
    }),
    closed(24, "tok-gale", "2026-10-15", "09:00", "12:00", "auto-close"),
    closed(25, "tok-jordan-1", "2026-11-10", "09:00", "10:00"),
    // Rows of a token that isn't on Profiles, and of no token.
    open(26, "tok-gone", TODAY, NOW - HOUR),
    open(27, "", TODAY, NOW - HOUR),
    // Indigo: closed today from 07:00 to 08:00.
    closed(28, "tok-indigo", TODAY, "07:00", "08:00"),
    // Kai: closed today from 07:00 to 08:00, and an open row tapped at 09:30 with the
    // arrival stated at 06:00, so the closed row stays the last.
    closed(29, "tok-kai", TODAY, "07:00", "08:00"),
    open(30, "tok-kai", TODAY, at(TODAY, "09:30"), at(TODAY, "06:00")),
    open(31, "tok-avery", TODAY, NOW - 2 * HOUR),
    entry(32, "tok-casey", { dateText: TODAY }),
    open(33, "tok-ellis", TODAY, NOW - 3 * HOUR),
    open(34, "tok-ellis", TODAY, NOW - HOUR, NOW - HOUR, { status: " Open " }),
    open(35, "tok-harper", TODAY, NOW - 30 * MIN),
  ];
  if (jordan !== "neither") rows.push(open(36, "tok-jordan-1", TODAY, NOW - HOUR));
  if (jordan === "both") rows.push(open(37, "tok-jordan-2", TODAY, NOW - 40 * MIN));
  return rows;
}

const LAYOUT = "0.1.2.3.4.5.6.7.8.9.10.11.12.13.14.15.16.17";

/** A map of these entries as a miss builds it. */
const mapOf = (entries, readAt = NOW - MIN, lastRow = Math.max(...entries.map((e) => e.row))) => ({
  readAt,
  layout: LAYOUT,
  lastRow,
  states: L.volunteerLogStates(entries, TOKENS),
});

/** The states of these entries, after the cached text's round trip. */
const cachedStates = (entries) => L.decodeLogMap(L.encodeLogMap(mapOf(entries))).states;

// ---------------------------------------------------------------------------
// A hit and a miss give the same decision

test("constants of the Log cache", () => {
  assert.equal(L.logCacheVersion(), 1);
  assert.equal(L.logCacheKey(), "log:v1");
  assert.equal(L.logCacheSeconds(), 600);
  assert.equal(L.logCacheMarginMs(), 5000);
  assert.equal(L.logCacheMaxBytes(), 100000);
  assert.equal(L.logStampProperty(), "logChangedAt");
  assert.equal(L.logCacheSwitchProperty(), "LOG_CACHE");
});

test("the switch is on only for exactly the text on", () => {
  assert.equal(L.logCacheSwitchOn("on"), true);
  for (const value of [null, undefined, "", "off", "ON", "On", "on ", " on", "true", true, 1]) {
    assert.equal(L.logCacheSwitchOn(value), false, String(value));
  }
});

test("the layout is each kiosk header's column in header order", () => {
  const header = L.logHeaders();
  assert.equal(L.logLayout(L.logColumns(header)), LAYOUT);
  // A column of staff's put first moves every kiosk column; a missing optional column is -1.
  const moved = ["Staff column", ...header.filter((h) => h !== H.activity)];
  assert.equal(L.logLayout(L.logColumns(moved)), "1.2.3.4.5.6.7.8.9.10.11.-1.12.13.14.15.16.17");
});

test("a volunteer's state holds the open rows, the last row and the closed totals", () => {
  const states = L.volunteerLogStates(fixtureLog("one"), TOKENS);
  assert.deepEqual(Object.keys(states).sort(), [...TOKENS].sort());
  assert.deepEqual(same(states["tok-frankie"]), { shifts: 0, minutes: 0, last: null, open: [] });
  // Avery: 3 + 4 + 2.5 + 40 hours closed; the open row today is the last.
  const avery = same(states["tok-avery"]);
  assert.equal(avery.shifts, 4);
  assert.equal(avery.minutes, 49.5 * 60);
  assert.deepEqual(avery.last, { row: 31, date: TODAY, startMs: NOW - 2 * HOUR, missed: true });
  assert.deepEqual(avery.open, [
    {
      row: 31,
      shiftId: "5f0c2a1e-0000-4000-8000-000000000031",
      token: "tok-avery",
      dateText: TODAY,
      recordedInMs: NOW - 2 * HOUR,
      statedInMs: NOW - 2 * HOUR,
      status: "open",
    },
  ]);
  // Ellis: the import row and the undated row are never last; the undated one is closed
  // and counts.
  const ellis = same(states["tok-ellis"]);
  assert.equal(ellis.shifts, 9);
  assert.equal(ellis.last.row, 34);
  assert.deepEqual(
    ellis.open.map((r) => r.row),
    [33, 34],
  );
  // Kai: the open row stated earlier than the closed row of the same day isn't last.
  assert.deepEqual(same(states["tok-kai"]).last, {
    row: 29,
    date: TODAY,
    startMs: at(TODAY, "07:00"),
    missed: false,
  });
  // Blake: closed typed or by the auto clock-out count as missed when last.
  assert.equal(same(states["tok-blake"]).last.missed, true);
  // Gale's imported row counts as a shift but is never the last.
  assert.equal(same(states["tok-gale"]).shifts, 2);
  assert.equal(same(states["tok-gale"]).last.row, 24);
  // Casey's open row with no readable time keeps NaN.
  assert.ok(Number.isNaN(states["tok-casey"].open[0].recordedInMs));
  // Rows of no Profiles token are left out.
  assert.equal(Object.prototype.hasOwnProperty.call(states, "tok-gone"), false);
});

test("a state's last row and totals don't depend on the order entries come in", () => {
  const log = fixtureLog("both");
  assert.deepEqual(
    same(L.volunteerLogStates(log.slice().reverse(), TOKENS)),
    same(L.volunteerLogStates(log, TOKENS)),
  );
});

test("a decision on cached states equals the decision on the Log's entries", () => {
  const nows = [NOW, NOW + 5 * HOUR, NOW + 12 * HOUR, NOW + 15 * HOUR];
  const windows = [4 * HOUR, 12 * HOUR, 24 * HOUR];
  const launches = ["2026-11-01", "2026-11-11", "2026-10-01", "", "2026-12-01"];
  const seen = new Set();
  let decisions = 0;
  for (const jordan of ["one", "both", "neither"]) {
    const entries = fixtureLog(jordan);
    const states = cachedStates(entries);
    for (const nowMs of nows) {
      const todayDate = centralDate(nowMs);
      const arrivals = [null, nowMs - 20 * MIN, nowMs + HOUR, nowMs - 30 * HOUR];
      const outs = [null, nowMs - 20 * MIN, nowMs - 10 * HOUR, nowMs - 30 * HOUR, nowMs + HOUR];
      for (const windowMs of windows) {
        for (const launchDate of launches) {
          for (const v of VOLUNTEERS) {
            const digitsList = v.needsPhoneCheck ? [null, "0111", "0222", "9999"] : [null];
            for (const digits of digitsList) {
              const base = {
                volunteers: VOLUNTEERS,
                id: v.id,
                digits,
                todayDate,
                nowMs,
                windowMs,
                flagMinutes: 15,
                launchDate,
              };
              for (const arrivedMs of arrivals) {
                const input = {
                  ...base,
                  arrivedMs,
                  arrivedDate: arrivedMs === null ? "" : centralDate(arrivedMs),
                };
                const want = plain(L.decideCheckIn({ ...input, entries }));
                const got = plain(L.decideCheckIn({ ...input, states }));
                assert.deepEqual(got, want, JSON.stringify({ check: "in", v: v.id, input }));
                seen.add("in " + (want.refusal || (want.missedSignOut ? "missed" : "ok")));
                decisions++;
              }
              for (const outMs of outs) {
                const input = {
                  ...base,
                  outMs,
                  outDate: outMs === null ? "" : centralDate(outMs),
                  longShiftHours: 8,
                };
                const why = JSON.stringify({ check: "out", v: v.id, input });
                const want = L.decideCheckOut({ ...input, entries });
                const got = L.decideCheckOut({ ...input, states });
                decisions++;
                if (want.refusal || got.refusal) {
                  assert.deepEqual(plain(got), plain(want), why);
                  seen.add("out " + want.refusal);
                  continue;
                }
                assert.deepEqual(
                  plain([got.row, got.minutes, got.milestone, got.flags, got.volunteer]),
                  plain([want.row, want.minutes, want.milestone, want.flags, want.volunteer]),
                  why,
                );
                // With the chosen row read again from the sheet, the decision is the same.
                const full = entries.find((e) => e.row === got.row);
                const again = L.decideCheckOut({
                  ...input,
                  states: L.logStatesWithEntry(states, full),
                });
                assert.deepEqual(same(again), same(want), why);
                seen.add("out ok");
                if (want.milestone) seen.add("out " + want.milestone.id);
                want.flags.forEach((f) => seen.add("out flag " + f.split(":")[0]));
              }
            }
          }
        }
      }
    }
  }
  // The grid reaches every answer.
  for (const outcome of [
    "in ok",
    "in missed",
    "in ALREADY_IN",
    "in ARRIVAL_FUTURE",
    "in ARRIVAL_OTHER_DAY",
    "in PHONE_NEEDED",
    "in PHONE_WRONG",
    "out ok",
    "out NOT_IN",
    "out PHONE_NEEDED",
    "out PHONE_WRONG",
    "out CHECKOUT_FUTURE",
    "out CHECKOUT_BEFORE_ARRIVAL",
    "out CHECKOUT_OTHER_DAY",
    "out shift-1",
    "out shift-10",
    "out hours-50",
    "out flag check-in time unreadable, stated hours left blank",
    "out flag long shift",
    "out flag check-out differs by 20 min",
  ]) {
    assert.ok(seen.has(outcome), "the grid never gave " + outcome);
  }
  assert.ok(decisions > 10000, String(decisions));
});

test("given both entries and states, a decision reads the entries", () => {
  const entries = fixtureLog("one");
  const input = {
    volunteers: VOLUNTEERS,
    id: AVERY.id,
    digits: null,
    todayDate: TODAY,
    nowMs: NOW,
    windowMs: 12 * HOUR,
    arrivedMs: null,
    arrivedDate: "",
    outMs: null,
    outDate: "",
    flagMinutes: 15,
    longShiftHours: 8,
    launchDate: "2026-11-01",
  };
  // States that say Avery has nothing open: the entries still decide.
  const states = L.volunteerLogStates([], TOKENS);
  assert.deepEqual(plain(L.decideCheckIn({ ...input, entries, states })), {
    refusal: "ALREADY_IN",
  });
  assert.equal(L.decideCheckOut({ ...input, entries, states }).row, 31);
  assert.deepEqual(plain(L.decideCheckIn({ ...input, states })).missedSignOut, false);
});

test("a decision on states without the volunteer's state throws", () => {
  const input = {
    volunteers: VOLUNTEERS,
    id: AVERY.id,
    digits: null,
    todayDate: TODAY,
    nowMs: NOW,
    windowMs: 12 * HOUR,
    arrivedMs: null,
    arrivedDate: "",
    outMs: null,
    outDate: "",
    flagMinutes: 15,
    longShiftHours: 8,
    launchDate: "2026-11-01",
  };
  const states = L.volunteerLogStates(fixtureLog(), ["tok-blake"]);
  assert.throws(() => L.decideCheckIn({ ...input, states }), /no row for a volunteer/);
  assert.throws(() => L.decideCheckOut({ ...input, states }), /no row for a volunteer/);
  // A refusal before the Log is read needs no state.
  assert.deepEqual(plain(L.decideCheckIn({ ...input, id: "ffffffffffffffff", states })), {
    refusal: "NOT_FOUND",
  });
});

// ---------------------------------------------------------------------------
// The whole Log read in one pass

/** Read functions like Sheets.js's, enough for these cells: Dates and text. */
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const READ = {
  text: (v) => (isDate(v) ? centralDate(v.getTime()) : L.cellString(v)),
  time: (v) =>
    isDate(v)
      ? { ms: v.getTime(), date: centralDate(v.getTime()), clock: "" }
      : { ms: NaN, date: "", clock: "" },
  at: () => ({ ms: NaN, date: "" }),
};

/** An entry as the cells of a Log row under the kiosk's own header. */
const cellsOf = (e) => {
  const time = (ms) => (Number.isFinite(ms) ? new Date(ms) : "");
  const hours = (h) => (Number.isFinite(h) ? h : "");
  const byHeader = {
    [H.date]: e.dateText,
    [H.name]: e.name,
    [H.recordedIn]: time(e.recordedInMs),
    [H.statedIn]: time(e.statedInMs),
    [H.recordedOut]: time(e.recordedOutMs),
    [H.statedOut]: time(e.statedOutMs),
    [H.recordedHours]: hours(e.recordedHours),
    [H.statedHours]: hours(e.statedHours),
    [H.alerts]: e.alerts,
    [H.token]: e.token,
    [H.status]: e.status,
    [H.outBy]: e.outBy,
    [H.shiftId]: e.shiftId,
  };
  return L.logHeaders().map((h) => (h in byHeader ? byHeader[h] : ""));
};

test("one pass over the whole Log gives the tap's rows and every volunteer's state", () => {
  const log = fixtureLog("both");
  const values = [L.logHeaders()];
  log
    .slice()
    .sort((a, b) => a.row - b.row)
    .forEach((e) => {
      while (values.length < e.row - 1) values.push(L.logHeaders().map(() => ""));
      values.push(cellsOf(e));
    });
  const cols = L.logColumns(values[0]);
  const all = values.slice(1).map((cells, i) => L.logEntry(cells, i + 2, cols, READ));
  for (const wanted of [["tok-ellis"], ["tok-jordan-1", "tok-jordan-2"], ["tok-gone"], [""]]) {
    const got = L.logTableStates(values, cols, READ, wanted, TOKENS);
    // The rows readLogTable_ keeps for the same tokens.
    const rows = values
      .slice(1)
      .map((cells, i) => ({ cells, e: all[i] }))
      .filter(({ cells }) => wanted.some((t) => L.logRowHasToken(cells, cols, t, READ)))
      .map(({ e }) => e);
    assert.deepEqual(same(got.entries), same(rows), String(wanted));
    assert.deepEqual(same(got.states), same(L.volunteerLogStates(all, TOKENS)), String(wanted));
  }
  // And the states are the fixture's own.
  assert.deepEqual(
    same(L.logTableStates(values, cols, READ, [], TOKENS).states),
    same(L.volunteerLogStates(log, TOKENS)),
  );
});

// ---------------------------------------------------------------------------
// Unreadable times

test("unreadable times survive the cached text's round trip", () => {
  const entries = fixtureLog("one");
  const text = L.encodeLogMap(mapOf(entries));
  assert.deepEqual(JSON.parse(text).tokens["tok-casey"][3], [
    [32, "5f0c2a1e-0000-4000-8000-000000000032", TODAY, null, null],
  ]);
  const states = L.decodeLogMap(text).states;
  const row = states["tok-casey"].open[0];
  assert.ok(Number.isNaN(row.recordedInMs) && Number.isNaN(row.statedInMs));
  const input = {
    volunteers: VOLUNTEERS,
    id: CASEY.id,
    digits: null,
    todayDate: TODAY,
    nowMs: NOW,
    windowMs: 12 * HOUR,
    arrivedMs: null,
    arrivedDate: "",
    outMs: null,
    outDate: "",
    flagMinutes: 15,
    longShiftHours: 8,
    launchDate: "2026-11-01",
  };
  // Dated today with no readable time: still the tablet's.
  assert.deepEqual(plain(L.decideCheckIn({ ...input, states })), { refusal: "ALREADY_IN" });
  const out = L.decideCheckOut({ ...input, states });
  assert.equal(out.row, 32);
  assert.equal(out.cells[H.statedHours], "");
  assert.deepEqual(plain(out.flags), [L.unreadableStartAlert()]);
  // Tomorrow it is no longer the tablet's.
  assert.equal(
    plain(L.decideCheckIn({ ...input, states, todayDate: "2026-11-13", nowMs: NOW + 20 * HOUR }))
      .refusal,
    undefined,
  );
  // A last row with no readable start keeps NaN.
  const dana = L.decodeLogMap(text).states["tok-dana"];
  assert.ok(Number.isNaN(dana.last.startMs));
  assert.deepEqual(same(dana), same(L.volunteerLogStates(entries, TOKENS)["tok-dana"]));
});

test("a map decodes to what was encoded", () => {
  for (const jordan of ["one", "both", "neither"]) {
    const map = mapOf(fixtureLog(jordan));
    assert.deepEqual(same(L.decodeLogMap(L.encodeLogMap(map))), same(map));
  }
  assert.deepEqual(same(L.decodeLogMap(L.encodeLogMap(mapOf([], NOW, 1)))), {
    readAt: NOW,
    layout: LAYOUT,
    lastRow: 1,
    states: same(L.volunteerLogStates([], TOKENS)),
  });
});

// ---------------------------------------------------------------------------
// A fill equals a rebuild

/** An entry closed with the cells a check-out writes, as the sheet reads them back. */
const closeAs = (e, cells) => {
  const c = L.logEntryFromCells(e.row, cells);
  return {
    ...e,
    recordedOutMs: c.recordedOutMs,
    statedOutMs: c.statedOutMs,
    recordedHours: c.recordedHours,
    statedHours: c.statedHours,
    status: c.status,
    outBy: c.outBy,
    alerts: H.alerts in cells ? c.alerts : e.alerts,
  };
};

test("a check-in fill equals the state rebuilt with the written row", () => {
  const entries = fixtureLog("one");
  const map = mapOf(entries);
  assert.equal(map.lastRow, 36);
  const write = (v, arrivedMs, row = 37) =>
    L.logEntryFromCells(
      row,
      L.checkInCells(v, TODAY, NOW, arrivedMs, "", "9b2d4c7e-1111-4000-8000-000000000001"),
    );
  const cases = [
    // A volunteer with no rows.
    write(FRANKIE, NOW),
    // An arrival stated before the other row of the day: that row stays the last.
    write(INDIGO, at(TODAY, "06:30")),
    // An arrival stated after it: the new row is the last, and missed.
    write(INDIGO, at(TODAY, "09:00")),
    // A volunteer with rows on many days.
    write(BLAKE, NOW - 20 * MIN),
  ];
  for (const e of cases) {
    const filled = L.logStateAfterCheckIn(map, e);
    assert.deepEqual(same(filled), same({ ...mapOf([...entries, e]), readAt: map.readAt }));
    assert.equal(filled.lastRow, 37);
    assert.equal(filled.readAt, map.readAt);
  }
  assert.equal(same(L.logStateAfterCheckIn(map, cases[1])).states["tok-indigo"].last.row, 28);
  assert.equal(same(L.logStateAfterCheckIn(map, cases[2])).states["tok-indigo"].last.row, 37);
  // The map it came from is unchanged.
  assert.deepEqual(same(map), same(mapOf(entries)));
  // Only the next row moves lastRow; any other gives no map.
  assert.equal(L.logStateAfterCheckIn(map, write(FRANKIE, NOW, 38)), null);
  assert.equal(L.logStateAfterCheckIn(map, write(FRANKIE, NOW, 36)), null);
  // A token the map doesn't hold gives no map.
  assert.equal(L.logStateAfterCheckIn(map, { ...write(FRANKIE, NOW), token: "tok-new" }), null);
});

test("the written row reads back as the cells say", () => {
  const cells = L.checkInCells(
    { ...FRANKIE, firstName: "=Frankie" },
    TODAY,
    NOW,
    NOW - 20 * MIN,
    "arrival differs by 20 min",
    "9b2d4c7e-1111-4000-8000-000000000001",
  );
  assert.deepEqual(same(L.logEntryFromCells(40, cells)), {
    row: 40,
    shiftId: "9b2d4c7e-1111-4000-8000-000000000001",
    token: "tok-frankie",
    name: "=Frankie Hale",
    dateText: TODAY,
    recordedInMs: NOW,
    statedInMs: NOW - 20 * MIN,
    recordedOutMs: "NaN",
    statedOutMs: "NaN",
    recordedHours: "NaN",
    statedHours: "NaN",
    alerts: "arrival differs by 20 min",
    notes: "",
    status: "open",
    outBy: "",
  });
});

test("a check-out fill equals the state rebuilt with the row closed as written", () => {
  const entries = fixtureLog("both");
  const map = mapOf(entries);
  const input = {
    volunteers: VOLUNTEERS,
    digits: null,
    todayDate: TODAY,
    nowMs: NOW,
    windowMs: 12 * HOUR,
    outMs: null,
    outDate: "",
    flagMinutes: 15,
    longShiftHours: 8,
    launchDate: "2026-11-01",
  };
  const cases = [
    // The open row is the last row.
    [AVERY, null, 31, true],
    // Two open rows: the later start is closed, the other stays open.
    [ELLIS, null, 34, true],
    // The open row was stated before the day's closed row, which stays the last.
    [KAI, null, 30, false],
    // No readable start: blank stated hours, nothing added to minutes.
    [CASEY, null, 32, true],
    // A same-name member, with digits.
    [JORDAN2, "0222", 37, true],
  ];
  for (const [v, digits, row, isLast] of cases) {
    const d = L.decideCheckOut({ ...input, id: v.id, digits, entries });
    assert.equal(d.row, row, v.firstName);
    assert.equal(map.states[v.token].last.row === row, isLast, v.firstName);
    const rebuilt = entries.map((e) => (e.row === row ? closeAs(e, d.cells) : e));
    const filled = L.logStateAfterCheckOut(map, d);
    assert.deepEqual(same(filled), same(mapOf(rebuilt)), v.firstName);
    assert.equal(filled.lastRow, map.lastRow);
    assert.equal(filled.readAt, map.readAt);
  }
  // A decision whose row isn't open in the map gives no map.
  const d = L.decideCheckOut({ ...input, id: AVERY.id, entries });
  assert.equal(L.logStateAfterCheckOut(map, { ...d, row: 2 }), null);
  assert.equal(
    L.logStateAfterCheckOut(map, { ...d, volunteer: { ...AVERY, token: "tok-new" } }),
    null,
  );
});

test("a fill made on a hit equals a fill made on a miss", () => {
  // Check in, then out, on the cached map; the same writes on a fresh read give the same map.
  const entries = fixtureLog("neither");
  const map = L.decodeLogMap(L.encodeLogMap(mapOf(entries)));
  const cells = L.checkInCells(HARPER, TODAY, NOW, NOW, "", "9b2d4c7e-2222-4000-8000-000000000002");
  const written = L.logEntryFromCells(map.lastRow + 1, cells);
  const afterIn = L.logStateAfterCheckIn(map, written);
  const log = [...entries, written];
  const input = {
    volunteers: VOLUNTEERS,
    id: HARPER.id,
    digits: null,
    todayDate: TODAY,
    nowMs: NOW + HOUR,
    windowMs: 12 * HOUR,
    outMs: null,
    outDate: "",
    flagMinutes: 15,
    longShiftHours: 8,
    launchDate: "2026-11-01",
  };
  // Harper has two open rows now; the newer one is closed.
  const onHit = L.decideCheckOut({ ...input, states: afterIn.states });
  const onMiss = L.decideCheckOut({ ...input, entries: log });
  assert.equal(onHit.row, written.row);
  assert.equal(onMiss.row, written.row);
  const filled = L.logStateAfterCheckOut(afterIn, onMiss);
  const rebuilt = log.map((e) => (e.row === written.row ? closeAs(e, onMiss.cells) : e));
  assert.deepEqual(same(filled), same(mapOf(rebuilt, map.readAt)));
});

// ---------------------------------------------------------------------------
// When a cached map may be used

test("a cached map is used only when every check passes, and says why not", () => {
  const entries = fixtureLog("one");
  const readAt = NOW - 2 * MIN;
  const map = mapOf(entries, readAt);
  const text = L.encodeLogMap(map);
  const need = ["tok-avery"];
  const read = (t = text, stamp = null, now = NOW, layout = LAYOUT, lastRow = 36, tokens = need) =>
    plain(L.logCacheRead(t, stamp, now, layout, lastRow, tokens)).miss || "hit";
  const edit = (change) => JSON.stringify({ ...JSON.parse(text), ...change });

  // A hit, with no stamp counting as 0, and the map it gives.
  assert.equal(read(), "hit");
  assert.equal(read(text, ""), "hit");
  assert.equal(read(text, undefined), "hit");
  const hit = L.logCacheRead(text, null, NOW, LAYOUT, 36, need);
  assert.deepEqual(same(hit), same(map));
  assert.equal(read(text, null, NOW, LAYOUT, 36, TOKENS), "hit");
  assert.equal(read(text, null, NOW, LAYOUT, 36, []), "hit");

  assert.equal(read(null), "none");
  assert.equal(plain(L.logCacheRead(undefined, null, NOW, LAYOUT, 36, need)).miss, "none");
  assert.equal(read(""), "none");
  assert.equal(read("not json"), "unreadable");
  assert.equal(read("[]"), "unreadable");
  assert.equal(read("null"), "unreadable");
  assert.equal(read("5"), "unreadable");
  assert.equal(read(edit({ readAt: "soon" })), "unreadable");
  assert.equal(read(edit({ readAt: null })), "unreadable");
  assert.equal(read(edit({ tokens: [] })), "unreadable");
  assert.equal(read(edit({ tokens: { "tok-avery": [0, 0, null] } })), "unreadable");
  assert.equal(
    read(edit({ tokens: { "tok-avery": [0, 0, [2, TODAY, null, 2], []] } })),
    "unreadable",
  );
  assert.equal(read(edit({ v: 2 })), "version");
  assert.equal(read(edit({ v: "1" })), "version");
  assert.equal(read(text, null, NOW, LAYOUT.replace("0.1", "1.0")), "layout");
  assert.equal(read(text, null, NOW, LAYOUT, 37), "rows");
  assert.equal(read(text, null, NOW, LAYOUT, 35), "rows");
  assert.equal(read(text, null, NOW, LAYOUT, 36, ["tok-avery", "tok-new"]), "token");
  // The read must start more than the margin after the stamp.
  const margin = L.logCacheMarginMs();
  assert.equal(read(text, String(readAt - margin - 1)), "hit");
  assert.equal(read(text, String(readAt - margin)), "edited");
  assert.equal(read(text, String(readAt)), "edited");
  assert.equal(read(text, String(NOW)), "edited");
  assert.equal(read(text, "soon"), "edited");
  assert.equal(read(text, "-1"), "edited");
  assert.equal(read(text, "1.5"), "edited");
  // And it is used for less than the lifetime after its read started.
  const life = L.logCacheSeconds() * 1000;
  assert.equal(read(text, null, readAt + life - 1), "hit");
  assert.equal(read(text, null, readAt + life), "old");
  assert.equal(read(text, null, readAt + 2 * life), "old");

  // The reasons are checked in order.
  assert.equal(read(edit({ v: 2 }), String(NOW), NOW, "x", 1, ["tok-new"]), "version");
  assert.equal(read(text, String(NOW), NOW + life, "x", 1, ["tok-new"]), "layout");
  assert.equal(read(text, String(NOW), NOW + life, LAYOUT, 1, ["tok-new"]), "rows");
  assert.equal(read(text, String(NOW), NOW + life, LAYOUT, 36, ["tok-new"]), "token");
  assert.equal(read(text, String(NOW), NOW + life), "edited");
});

// ---------------------------------------------------------------------------
// The check-out's re-read row

test("a re-read row passes only as the same open row with a Shift ID", () => {
  const states = L.volunteerLogStates(fixtureLog("one"), TOKENS);
  const cached = states["tok-avery"].open[0];
  const full = fixtureLog("one").find((e) => e.row === 31);
  assert.equal(L.cachedOpenRowUnchanged(cached, full), true);
  assert.equal(L.cachedOpenRowUnchanged(cached, { ...full, status: " OPEN " }), true);
  assert.equal(L.cachedOpenRowUnchanged(cached, null), false);
  assert.equal(L.cachedOpenRowUnchanged(cached, { ...full, status: "closed" }), false);
  assert.equal(L.cachedOpenRowUnchanged(cached, { ...full, shiftId: "other" }), false);
  assert.equal(L.cachedOpenRowUnchanged(cached, { ...full, token: "tok-blake" }), false);
  // A row staff typed has no Shift ID and never passes.
  assert.equal(
    L.cachedOpenRowUnchanged({ ...cached, shiftId: "" }, { ...full, shiftId: "" }),
    false,
  );
});

test("the re-read row takes the cached row's place for the second decision", () => {
  const entries = fixtureLog("one");
  const states = L.volunteerLogStates(entries, TOKENS);
  const full = { ...entries.find((e) => e.row === 31), alerts: "staff note" };
  const swapped = L.logStatesWithEntry(states, full);
  assert.equal(swapped["tok-avery"].open[0], full);
  // The map it came from is unchanged, and other volunteers are shared.
  assert.equal(states["tok-avery"].open[0].alerts, undefined);
  assert.equal(swapped["tok-blake"], states["tok-blake"]);
  assert.equal(L.logStatesWithEntry(states, { ...full, row: 2 }), null);
  assert.equal(L.logStatesWithEntry(states, { ...full, token: "tok-new" }), null);
});

test("two check-out decisions are the same plan when they close one row with the same flags", () => {
  const a = { row: 31, flags: ["check-out differs by 20 min"] };
  assert.equal(L.sameCheckOutPlan(a, { ...a, cells: {} }), true);
  assert.equal(L.sameCheckOutPlan({ row: 31, flags: [] }, { row: 31, flags: [] }), true);
  assert.equal(L.sameCheckOutPlan(a, { ...a, row: 30 }), false);
  assert.equal(L.sameCheckOutPlan(a, { ...a, flags: [] }), false);
  assert.equal(L.sameCheckOutPlan(a, { ...a, flags: ["check-out differs by 21 min"] }), false);
  assert.equal(L.sameCheckOutPlan(a, { refusal: "NOT_IN" }), false);
  assert.equal(L.sameCheckOutPlan(null, a), false);
});

// ---------------------------------------------------------------------------
// Size and shape

test("the map of 500 volunteers fits in one cache value", () => {
  const hex = (n, width) => n.toString(16).padStart(width, "0");
  const tokens = [];
  const entries = [];
  let row = 2;
  for (let v = 0; v < 500; v++) {
    const token = "c0ffee00-" + hex(v, 4) + "-4000-8000-" + hex(v * 7919, 12);
    assert.equal(token.length, 36);
    tokens.push(token);
    for (let s = 0; s < 40; s++) {
      const date = "2026-" + String(1 + (s % 10)).padStart(2, "0") + "-15";
      entries.push(closed(row++, token, date, "09:00", "11:30"));
    }
  }
  for (let o = 0; o < 30; o++) entries.push(open(row++, tokens[o * 16], TODAY, NOW - o * MIN));
  const map = {
    readAt: NOW,
    layout: LAYOUT,
    lastRow: row - 1,
    states: L.volunteerLogStates(entries, tokens),
  };
  const bytes = L.utf8Length(L.encodeLogMap(map));
  console.log("log map of 500 volunteers: " + bytes + " bytes");
  assert.ok(bytes < L.logCacheMaxBytes(), String(bytes));
});

// The cached text of each version, for one small Log. Changing what the text holds without
// raising logCacheVersion() fails this test: raise it and add a line here.
const LOG_CACHE_TEXTS = {
  1:
    '{"v":1,"readAt":1794499140000,"layout":"0.1.2.3.4.5.6.7.8.9.10.11.12.13.14.15.16.17",' +
    '"lastRow":9,"tokens":{' +
    '"tok-avery":[1,180,[9,"2026-11-12",1794492000000,1],' +
    '[[9,"5f0c2a1e-0000-4000-8000-000000000009","2026-11-12",1794492000000,1794492000000]]],' +
    '"tok-casey":[1,60,[3,"2026-11-11",null,0],[]],' +
    '"tok-frankie":[0,0,null,[]]}}',
};

test("the cached text's shape goes with its version", () => {
  const entries = [
    closed(2, "tok-avery", "2026-11-10", "09:00", "12:00"),
    closed(3, "tok-casey", "2026-11-11", "09:00", "10:00", "kiosk", {
      recordedInMs: NaN,
      statedInMs: NaN,
    }),
    open(9, "tok-avery", TODAY, NOW - 2 * HOUR),
  ];
  const map = {
    readAt: NOW - MIN,
    layout: LAYOUT,
    lastRow: 9,
    states: L.volunteerLogStates(entries, ["tok-avery", "tok-casey", "tok-frankie"]),
  };
  const version = L.logCacheVersion();
  assert.equal(
    L.encodeLogMap(map),
    LOG_CACHE_TEXTS[version],
    "the cached text changed: raise logCacheVersion() and pin the new text",
  );
  assert.equal(version, 1);
});
