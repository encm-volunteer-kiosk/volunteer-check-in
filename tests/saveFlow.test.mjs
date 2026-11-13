// Tests for the tablet's check-in and check-out save (src/saveFlow.ts, imported as it is;
// Node strips its types): which reply is current and which is late, the watchdog, the kiosk
// locking, the save screen's times, and which screens a list refresh or the inactivity
// timer may send home.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abandonSave,
  goesHomeWhenListLosesVolunteer,
  inactivityMs,
  msUntil,
  noSaves,
  rendersFrom,
  resultOf,
  slowLineShows,
  startSave,
  takeReply,
  takeWatchdog,
  watchdogDue,
} from "../src/saveFlow.ts";

const ana = { kind: "in", volunteerId: "vol-1", firstName: "Ana", from: "confirm", startedAt: 0 };
const ben = { kind: "out", volunteerId: "vol-2", firstName: "Ben", from: "checkout", startedAt: 0 };
const screens = [
  "welcome",
  "confirm",
  "checkout",
  "saving",
  "notice",
  "success-in",
  "success-out",
  "unconfirmed",
];
const resultScreens = ["notice", "success-in", "success-out", "unconfirmed"];

test("a reply for the pending save is applied", () => {
  const { flow, record } = startSave(noSaves, ana);
  assert.equal(record.seq, 1);
  assert.equal(flow.pending, record);
  const taken = takeReply(flow, record.seq);
  assert.deepEqual(taken.save, record);
  assert.equal(taken.flow.pending, null);
  assert.equal(taken.flow.lastSeq, 1);
  // The same reply twice: the second is late.
  assert.equal(takeReply(taken.flow, record.seq).save, null);
});

test("a reply after the watchdog only refreshes the list", () => {
  const { flow, record } = startSave(noSaves, ana);
  const fired = takeWatchdog(flow, record.seq);
  assert.equal(fired.save, record);
  assert.equal(fired.flow.pending, null);
  const late = takeReply(fired.flow, record.seq);
  assert.equal(late.save, null, "a late reply gets no save to set a screen from");
  assert.equal(late.flow, fired.flow, "a late reply changes nothing");
});

test("a reply after the kiosk locked is ignored", () => {
  const { flow, record } = startSave(noSaves, ben);
  const locked = abandonSave(flow);
  assert.equal(locked.pending, null);
  const late = takeReply(locked, record.seq);
  assert.equal(late.save, null);
  assert.equal(late.flow, locked);
  // Locking with no save pending changes nothing.
  assert.equal(abandonSave(locked), locked);
});

test("a new save after the watchdog makes the old reply late", () => {
  const first = startSave(noSaves, ana);
  const fired = takeWatchdog(first.flow, first.record.seq);
  const second = startSave(fired.flow, ana);
  assert.equal(second.record.seq, 2);
  assert.equal(takeReply(second.flow, first.record.seq).save, null);
  assert.equal(takeReply(second.flow, first.record.seq).flow.pending, second.record);
  assert.equal(takeReply(second.flow, second.record.seq).save, second.record);
  // A watchdog left over from the first save doesn't give up the second.
  assert.equal(takeWatchdog(second.flow, first.record.seq).save, null);
  assert.equal(takeWatchdog(second.flow, first.record.seq).flow.pending, second.record);
});

test("the slow line shows from 8 s and the watchdog fires at 45 s", () => {
  assert.equal(slowLineShows(0), false);
  assert.equal(slowLineShows(7_999), false);
  assert.equal(slowLineShows(8_000), true);
  assert.equal(watchdogDue(44_999), false);
  assert.equal(watchdogDue(45_000), true);
  assert.equal(msUntil(8_000, 0), 8_000);
  assert.equal(msUntil(45_000, 1_500), 43_500);
  assert.equal(msUntil(8_000, 9_000), 0);
});

test("nothing resets the screen while a save is pending", () => {
  assert.equal(inactivityMs("saving"), null, "no inactivity timer on the save screen");
  for (const listState of ["loading", "ready", "failed"]) {
    assert.equal(goesHomeWhenListLosesVolunteer("saving", listState, "vol-1", false), false);
  }
  assert.equal(rendersFrom("saving"), "save");
});

test("the go-home test is true only on confirm and checkout", () => {
  for (const screen of screens) {
    const expected = screen === "confirm" || screen === "checkout";
    assert.equal(goesHomeWhenListLosesVolunteer(screen, "ready", "vol-1", false), expected, screen);
    // Never while the volunteer is still listed, with nobody selected, or before a list.
    assert.equal(goesHomeWhenListLosesVolunteer(screen, "ready", "vol-1", true), false, screen);
    assert.equal(goesHomeWhenListLosesVolunteer(screen, "ready", null, false), false, screen);
    assert.equal(goesHomeWhenListLosesVolunteer(screen, "loading", "vol-1", false), false, screen);
  }
});

test("a reply copies firstName and kind into the result before the record clears", () => {
  const { flow, record } = startSave(noSaves, ben);
  const taken = takeReply(flow, record.seq);
  const result = resultOf(taken.save, { time: "2026-11-13T18:00:00.000Z", message: "Thanks" });
  assert.equal(taken.flow.pending, null);
  assert.deepEqual(result, {
    firstName: "Ben",
    kind: "out",
    time: "2026-11-13T18:00:00.000Z",
    message: "Thanks",
  });
});

test("the watchdog copies them for the unconfirmed screen", () => {
  const { flow, record } = startSave(noSaves, ana);
  const fired = takeWatchdog(flow, record.seq);
  assert.equal(fired.flow.pending, null);
  assert.deepEqual(resultOf(fired.save, {}), { firstName: "Ana", kind: "in" });
  assert.equal(rendersFrom("unconfirmed"), "result");
});

test("the off-list success still shows its screen", () => {
  // The volunteer left the list while the save ran. The reply is applied, the success screen
  // renders from the copied result, and the list refresh after it doesn't send it home.
  const { flow, record } = startSave(noSaves, ana);
  const taken = takeReply(flow, record.seq);
  const result = resultOf(taken.save, { time: "2026-11-13T15:00:00.000Z", message: "Hi" });
  assert.equal(result.firstName, "Ana");
  for (const screen of resultScreens) {
    assert.equal(rendersFrom(screen), "result", screen);
    assert.equal(goesHomeWhenListLosesVolunteer(screen, "ready", "vol-1", false), false, screen);
  }
});

test("a refusal back to confirm for an off-list volunteer goes home", () => {
  // While saving the list dropped the volunteer and nothing reset. The refusal returns the
  // page to the save's screen; the check runs again for that screen and sends it home.
  const { flow, record } = startSave(noSaves, ana);
  assert.equal(goesHomeWhenListLosesVolunteer("saving", "ready", "vol-1", false), false);
  const taken = takeReply(flow, record.seq);
  assert.equal(goesHomeWhenListLosesVolunteer(taken.save.from, "ready", "vol-1", false), true);
  const out = startSave(taken.flow, ben);
  const back = takeReply(out.flow, out.record.seq);
  assert.equal(goesHomeWhenListLosesVolunteer(back.save.from, "ready", "vol-2", false), true);
});

test("each screen but welcome and saving goes home when untouched", () => {
  assert.equal(inactivityMs("welcome"), null);
  assert.equal(inactivityMs("notice"), 60_000);
  assert.equal(inactivityMs("unconfirmed"), 15_000);
  for (const screen of ["confirm", "checkout", "success-in", "success-out"]) {
    assert.equal(inactivityMs(screen), 90_000, screen);
  }
});
