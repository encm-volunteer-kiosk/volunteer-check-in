// Tests for server replies as the page reads them (src/replies.ts). The server's own list and
// replies (Logic.js) go through a stand-in for google.script.run that drops null fields
// (scriptRun.mjs), then through the page: which taps are instant, what they show, and the
// list kept for a reload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  checkInFromServer,
  checkOutFromServer,
  hoursRequestsOf,
  stepsWithNulls,
  summaryFromServer,
  toVolunteer,
} from "../src/replies.ts";
import { freshQueue, newSave, qualifyFailure } from "../src/saveQueue.ts";
import { readStoredList, storeList } from "../src/listStore.ts";
import { viaScriptRun } from "./scriptRun.mjs";

const L = {};
vm.runInNewContext(readFileSync(new URL("../apps-script/Logic.js", import.meta.url), "utf8"), L);
const plain = (x) => JSON.parse(JSON.stringify(x));

const MIN = 60_000;
const HOUR = 60 * MIN;
// 10:00 AM Central on 2026-11-13.
const NOW = Date.parse("2026-11-13T16:00:00Z");
const TODAY = "2026-11-13";
const LAUNCH = "2026-11-01";
const WINDOW = 12 * HOUR;

const entry = (row, token, fields = {}) => ({
  row,
  shiftId: "shift-" + row,
  token,
  name: "",
  dateText: TODAY,
  recordedInMs: NOW - 2 * HOUR,
  statedInMs: NOW - 2 * HOUR,
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
const closed = (row, token, dateText) =>
  entry(row, token, { status: "closed", outBy: "kiosk", dateText, statedHours: 2 });
const profile = (id, firstName, lastName, token, row) => ({
  id,
  firstName,
  lastName,
  phoneLast4: "0100",
  startDate: "2026-01-01",
  needsPhoneCheck: false,
  token,
  row,
});

// Ana is checked out; Ben checked in two hours ago, after two shifts, so a check-out now
// shows no milestone: his steps are [{fromMinutes: 0, id: null}].
const profiles = [
  profile("id-ana", "Ana", "Lopez", "t-ana", 2),
  profile("id-ben", "Ben", "Ortiz", "t-ben", 3),
];
const entries = [
  closed(2, "t-ana", "2026-11-10"),
  closed(3, "t-ben", "2026-11-10"),
  closed(4, "t-ben", "2026-11-11"),
  entry(5, "t-ben"),
];
const serverList = L.volunteerSummaries(
  profiles,
  L.volunteerLogStates(
    entries,
    profiles.map((p) => p.token),
  ),
  NOW,
  WINDOW,
  TODAY,
  LAUNCH,
);

/** The list as the page reads it: through google.script.run, then replies.ts. */
const pageList = () => viaScriptRun(serverList).map(summaryFromServer).map(toVolunteer);

function ctx(queue, extra = {}) {
  return {
    hasCode: true,
    codeKept: true,
    foregroundPending: false,
    listState: "ready",
    now: NOW,
    listStamp: { epoch: queue.epoch, seq: queue.seq, requestedAt: NOW - MIN },
    clockOffsetMs: 1_000,
    queue,
    heldMarks: [],
    arrivalPicker: false,
    checkOutPicker: false,
    ...extra,
  };
}

function fakeStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

test("the stand-in drops the list's nulls as google.script.run does", () => {
  const [ana, ben] = viaScriptRun(serverList);
  assert.deepEqual(plain(serverList[1].checkOutMilestones), [{ fromMinutes: 0, id: null }]);
  assert.deepEqual(ben.checkOutMilestones, [{ fromMinutes: 0 }]);
  for (const key of ["openShiftArrival", "openShiftId", "openUntil", "checkOutMilestones"]) {
    assert.equal(key in ana, false, key);
  }
});

test("the page reads the list with every dropped null back", () => {
  const read = pageList();
  assert.deepEqual(read, plain(serverList).map(toVolunteer));
  assert.equal(read[0].currentCheckIn, null);
  assert.equal(read[0].openShiftId, null);
  assert.deepEqual(read[1].checkOutMilestones, [{ fromMinutes: 0, id: null }]);
  // missedSignOut is never null, so a list without it stays without it (an older server).
  const { missedSignOut, ...older } = plain(serverList[0]);
  assert.equal(missedSignOut, false);
  assert.equal("missedSignOut" in summaryFromServer(viaScriptRun(older)), false);
});

test("a check-out with a no-milestone step is instant and shows no milestone", () => {
  const [ana, ben] = pageList();
  const q = freshQueue("e1");
  assert.equal(qualifyFailure("out", ben, ctx(q)), null);
  assert.deepEqual(plain(newSave("out", ben, NOW).shown), { milestoneId: null });
  assert.equal(qualifyFailure("in", ana, ctx(q)), null);
});

test("a reload keeps the stored list while someone is checked in, and the check-out stays instant", () => {
  const storage = fakeStorage();
  const q = freshQueue("e1");
  const stamp = { epoch: q.epoch, seq: q.seq, requestedAt: NOW - MIN };
  const extras = { milestones: plain(L.milestones()), clockOffsetMs: 1_000, listStamp: stamp };
  storeList(storage, "code", NOW - MIN, pageList(), 8, extras);
  const kept = readStoredList(storage, "code", NOW);
  assert.notEqual(kept, null);
  assert.deepEqual(kept.volunteers, pageList());
  const ben = kept.volunteers.find((v) => v.id === "id-ben");
  assert.equal(qualifyFailure("out", ben, ctx(q, { listState: "stored" })), null);
});

test("check-in and check-out replies read a dropped null as null", () => {
  const replayedIn = {
    ok: true,
    id: "id-ben",
    shiftId: "tap-1",
    arrivedAt: null,
    tappedAt: null,
    missedSignOut: false,
    replayed: true,
  };
  assert.deepEqual(checkInFromServer(viaScriptRun(replayedIn)), {
    id: "id-ben",
    shiftId: "tap-1",
    arrivedAt: null,
    tappedAt: null,
    missedSignOut: false,
    replayed: true,
  });
  const replayedOut = {
    ok: true,
    id: "id-ben",
    signedOutAt: null,
    tappedAt: null,
    minutes: null,
    milestone: null,
    replayed: true,
  };
  assert.deepEqual(checkOutFromServer(viaScriptRun(replayedOut)), {
    id: "id-ben",
    signedOutAt: null,
    tappedAt: null,
    minutes: null,
    milestone: null,
    replayed: true,
  });
  // A field of the wrong type is left for the page's checks to refuse.
  assert.deepEqual(stepsWithNulls([{ fromMinutes: 0, id: 7 }, "x"]), [
    { fromMinutes: 0, id: 7 },
    "x",
  ]);
  assert.equal(stepsWithNulls(undefined), null);
  assert.equal(stepsWithNulls("x"), "x");
});

test("the list's hoursRequests reads as false unless the server sent true", () => {
  assert.equal(hoursRequestsOf({ ok: true, volunteers: [] }), false, "an older server sends none");
  assert.equal(hoursRequestsOf(viaScriptRun({ ok: true, hoursRequests: null })), false);
  assert.equal(hoursRequestsOf({ hoursRequests: false }), false);
  assert.equal(hoursRequestsOf({ hoursRequests: "Auto" }), false, "never the mode word");
  assert.equal(hoursRequestsOf(viaScriptRun({ ok: true, hoursRequests: true })), true);
});
