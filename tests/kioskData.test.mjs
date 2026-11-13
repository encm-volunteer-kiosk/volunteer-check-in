// Tests for the tablet's local store (src/data.ts, imported as it is; Node strips its
// types): the window after the check-in tap and the missed check-out notice, as the local
// development API uses them. Also holds the local API's refusal copies (src/api.ts) to the
// server's messages, so `pnpm dev` shows what the tablet will show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkIn, checkInWindowMs, checkOut, isCheckedInAt, missedSignOut } from "../src/data.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const MIN = 60_000;
const HOUR = 60 * MIN;
// 10:00 PM Central on an invented evening; 01:00 the next morning is 3 hours later.
const TAP = Date.parse("2026-11-13T04:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const volunteer = (extra = {}) => ({
  id: "vol-1",
  firstName: "Pat",
  lastName: "Example",
  active: true,
  expectedToday: false,
  currentCheckIn: null,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  ...extra,
});

const shift = (shiftId, inMs, outMs, enteredBy) => [
  {
    id: `${shiftId}-in`,
    volunteerId: "vol-1",
    eventType: "check_in",
    timestamp: iso(inMs),
    shiftId,
  },
  ...(outMs === null
    ? []
    : [
        {
          id: `${shiftId}-out`,
          volunteerId: "vol-1",
          eventType: "check_out",
          timestamp: iso(outMs),
          shiftId,
          ...(enteredBy ? { enteredBy } : {}),
        },
      ]),
];

const store = (events, v = volunteer()) => ({
  volunteers: [v],
  events,
  recognizedMilestones: [],
  messageIndex: 0,
});

// ---------------------------------------------------------------------------------------
// The window after the tap

test("the window is 12 hours, the default of the Auto clock-out setting", () => {
  assert.equal(checkInWindowMs, 12 * HOUR);
});

test("a 10 PM check-in is still checked in at 1 AM and gone 12 hours after the tap", () => {
  const v = volunteer({ currentCheckIn: iso(TAP), currentCheckInTappedAt: iso(TAP) });
  assert.equal(isCheckedInAt(v, TAP + 3 * HOUR), true);
  assert.equal(isCheckedInAt(v, TAP + 12 * HOUR - 1), true);
  // At exactly the window the shift is the auto clock-out's, not the tablet's.
  assert.equal(isCheckedInAt(v, TAP + 12 * HOUR), false);
  assert.equal(isCheckedInAt(v, TAP + 12 * HOUR + MIN), false);
});

test("the window runs from the tap, not from an earlier stated arrival", () => {
  // Tapped at 4 PM stating 8 AM: still checked in at 3:59 AM the next day.
  const tap = Date.parse("2026-11-12T22:00:00Z");
  const v = volunteer({ currentCheckIn: iso(tap - 8 * HOUR), currentCheckInTappedAt: iso(tap) });
  assert.equal(isCheckedInAt(v, tap + 12 * HOUR - MIN), true);
  assert.equal(isCheckedInAt(v, tap + 12 * HOUR), false);
});

test("a shift stored without its tap is measured from its stated arrival", () => {
  const v = volunteer({ currentCheckIn: iso(TAP) });
  assert.equal(isCheckedInAt(v, TAP + 11 * HOUR), true);
  assert.equal(isCheckedInAt(v, TAP + 12 * HOUR), false);
});

test("no open shift, or an unreadable one, is not checked in", () => {
  assert.equal(isCheckedInAt(volunteer(), TAP), false);
  assert.equal(isCheckedInAt(volunteer({ currentCheckIn: "not a time" }), TAP), false);
});

test("a shorter window can be passed", () => {
  const v = volunteer({ currentCheckIn: iso(TAP), currentCheckInTappedAt: iso(TAP) });
  assert.equal(isCheckedInAt(v, TAP + 9 * HOUR, 10 * HOUR), true);
  assert.equal(isCheckedInAt(v, TAP + 10 * HOUR, 10 * HOUR), false);
});

// ---------------------------------------------------------------------------------------
// Check-in and check-out in the store

test("check-in keeps the tap; check-in again inside the window is refused", () => {
  const data = checkIn(store([]), "vol-1", iso(TAP - HOUR), iso(TAP));
  const v = data.volunteers[0];
  assert.equal(v.currentCheckIn, iso(TAP - HOUR));
  assert.equal(v.currentCheckInTappedAt, iso(TAP));
  assert.throws(() => checkIn(data, "vol-1", iso(TAP + 11 * HOUR), iso(TAP + 11 * HOUR)));
});

test("after the window a new check-in leaves the old shift open for the auto clock-out", () => {
  const first = checkIn(store([]), "vol-1", iso(TAP), iso(TAP));
  const later = TAP + 13 * HOUR;
  const second = checkIn(first, "vol-1", iso(later), iso(later));
  const ins = second.events.filter((e) => e.eventType === "check_in");
  assert.equal(ins.length, 2);
  assert.equal(second.events.filter((e) => e.eventType === "check_out").length, 0);
  assert.equal(second.volunteers[0].currentCheckIn, iso(later));
});

test("check-out past midnight inside the window closes the shift; outside it is refused", () => {
  const data = checkIn(store([]), "vol-1", iso(TAP), iso(TAP));
  const done = checkOut(data, "vol-1", iso(TAP + 3 * HOUR), TAP + 3 * HOUR);
  assert.equal(done.duration, 180);
  assert.equal(done.data.volunteers[0].currentCheckIn, null);
  assert.equal(done.data.volunteers[0].currentCheckInTappedAt, null);
  assert.throws(() => checkOut(data, "vol-1", iso(TAP + 12 * HOUR), TAP + 12 * HOUR));
});

// ---------------------------------------------------------------------------------------
// The missed check-out notice

const DAY = 24 * HOUR;

test("no notice with no shifts, or when the last shift was checked out at the tablet", () => {
  assert.equal(missedSignOut(store([]), "vol-1"), false);
  assert.equal(missedSignOut(store(shift("a", TAP, TAP + 3 * HOUR)), "vol-1"), false);
  assert.equal(missedSignOut(store(shift("a", TAP, TAP + 3 * HOUR, "kiosk")), "vol-1"), false);
});

test("notice when the last shift was closed by the auto clock-out or by staff", () => {
  assert.equal(missedSignOut(store(shift("a", TAP, TAP + 3 * HOUR, "auto-close")), "vol-1"), true);
  assert.equal(missedSignOut(store(shift("a", TAP, TAP + 3 * HOUR, "JS")), "vol-1"), true);
});

test("notice when the last shift is still open", () => {
  assert.equal(missedSignOut(store(shift("a", TAP, null)), "vol-1"), true);
});

test("only the latest shift by stated arrival counts", () => {
  // An old miss followed by a tablet check-out: no notice.
  const events = [
    ...shift("new", TAP, TAP + HOUR),
    ...shift("old", TAP - 3 * DAY, TAP - 3 * DAY + HOUR, "auto-close"),
  ];
  assert.equal(missedSignOut(store(events), "vol-1"), false);
  // The reverse: the newer shift was missed.
  const missed = [...shift("old", TAP - 3 * DAY, TAP - 3 * DAY + HOUR), ...shift("new", TAP, null)];
  assert.equal(missedSignOut(store(missed), "vol-1"), true);
});

test("another volunteer's shifts don't count", () => {
  const other = shift("x", TAP, null).map((e) => ({ ...e, volunteerId: "vol-2" }));
  assert.equal(missedSignOut(store(other), "vol-1"), false);
});

test("the notice shows once: the check-in that carries it is the next one looked at", () => {
  const before = store(shift("a", TAP - 2 * DAY, TAP - 2 * DAY + HOUR, "auto-close"));
  assert.equal(missedSignOut(before, "vol-1"), true);
  const inAgain = checkIn(before, "vol-1", iso(TAP), iso(TAP));
  const outAgain = checkOut(inAgain, "vol-1", iso(TAP + 2 * HOUR), TAP + 2 * HOUR).data;
  assert.equal(missedSignOut(outAgain, "vol-1"), false);
});

// ---------------------------------------------------------------------------------------
// The local API's refusal copies

test("the local API's refusal messages are the server's", () => {
  const L = {};
  vm.runInNewContext(read("apps-script/Logic.js"), L);
  const server = L.refusalMessages();
  const api = read("src/api.ts");
  const block = api.slice(
    api.indexOf("const refusalMessages"),
    api.indexOf("};", api.indexOf("const refusalMessages")),
  );
  const local = Object.fromEntries(
    [
      ...block.matchAll(/^\s+([A-Z_]+):\s*"([^"]*)",?$/gm),
      ...block.matchAll(/^\s+([A-Z_]+):\n\s+"([^"]*)",?$/gm),
    ].map((m) => [m[1], m[2]]),
  );
  assert.ok(Object.keys(local).length >= 12, "every local copy was read");
  for (const [code, message] of Object.entries(local)) {
    assert.equal(message, server[code], code);
  }
  assert.equal(local.ALREADY_IN, "You're already checked in.");
  assert.equal(local.NOT_IN, "You're not checked in.");
});
