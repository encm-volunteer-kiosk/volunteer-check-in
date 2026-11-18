// Tests for Change on the check-out screen (src/arrivalChange.ts, imported as it is; Node
// strips its types): when the line offers Change, what the picker holds when it opens, what
// Save time sends, and what the server's answer does. A source check of src/App.tsx ties
// the screen to these functions and keeps Save time apart from Check Out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  afterArrivalChange,
  arrivalChangeFailedText,
  arrivalSavedText,
  arrivalToSend,
  movePick,
  openArrivalPick,
  showsArrivalChange,
} from "../src/arrivalChange.ts";
import { addMark, freshQueue, overlay } from "../src/saveQueue.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const serverText = L.refusalMessages();

// Tuesday 2026-11-17, Central (UTC-6): checked in by a tap at 9:14 AM, seen at 11:00 AM.
const TAP = "2026-11-17T15:14:00.000Z";
const NOW = Date.parse("2026-11-17T17:00:00.000Z");

const entry = (extra = {}) => ({
  id: "v-sam",
  firstName: "Sam",
  lastName: "Lee",
  active: true,
  expectedToday: false,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  checkedIn: true,
  currentCheckIn: TAP,
  openShiftId: "shift-1",
  openShiftTapped: TAP,
  ...extra,
});

const queuedSave = (volunteerId) => ({
  key: "6f1c1b7e-3a5d-4c1e-9f00-000000000001",
  kind: "out",
  volunteerId,
  firstName: "Sam",
  lastName: "Lee",
  shiftId: "shift-1",
  tapAt: NOW - 5_000,
  shown: { milestoneId: null },
  arrival: null,
  sends: 0,
  nextTryAt: 0,
  retries: 0,
  lastSendAt: 0,
  replies: 0,
});

const emptyQueue = freshQueue("epoch-1");

/** A check-out screen on which Change shows; extra changes one thing. */
const screen = (extra = {}) => ({
  entry: entry(),
  phoneStep: null,
  picker: false,
  saving: false,
  digitsAsked: false,
  digits: "",
  queue: emptyQueue,
  nowMs: NOW,
  ...extra,
});

// ---------------------------------------------------------------------------
// When Change shows

test("Change shows for an open row tapped today, with nothing else on screen", () => {
  assert.equal(showsArrivalChange(screen()), true);
});

test("Change hides while a phone step, a picker or a save is on screen", () => {
  assert.equal(showsArrivalChange(screen({ phoneStep: "entry" })), false, "phone step");
  assert.equal(showsArrivalChange(screen({ phoneStep: "missing" })), false, "no phone on record");
  assert.equal(showsArrivalChange(screen({ picker: true })), false, "a picker open");
  assert.equal(showsArrivalChange(screen({ saving: true })), false, "a save or Change out");
});

test("Change hides without the open row's Shift ID", () => {
  for (const openShiftId of [null, undefined, ""]) {
    assert.equal(showsArrivalChange(screen({ entry: entry({ openShiftId }) })), false, openShiftId);
  }
});

test("Change hides without a readable tap time (a kept list from an older page has none)", () => {
  for (const openShiftTapped of [null, undefined, "", "not a time"]) {
    assert.equal(
      showsArrivalChange(screen({ entry: entry({ openShiftTapped }) })),
      false,
      String(openShiftTapped),
    );
  }
  assert.equal(showsArrivalChange(screen({ entry: entry({ currentCheckIn: null }) })), false);
});

test("Change hides for yesterday's arrival or yesterday's tap", () => {
  // Checked in at 11:00 PM on Monday, seen at 1:00 AM on Tuesday.
  const lateTap = "2026-11-17T05:00:00.000Z";
  const afterMidnight = Date.parse("2026-11-17T07:00:00.000Z");
  const late = entry({ currentCheckIn: lateTap, openShiftTapped: lateTap });
  assert.equal(showsArrivalChange(screen({ entry: late, nowMs: afterMidnight })), false);
  // The arrival moved to the evening before, the tap today (a staff edit): hidden too.
  const movedBack = entry({ currentCheckIn: lateTap, openShiftTapped: TAP });
  assert.equal(showsArrivalChange(screen({ entry: movedBack })), false);
  // The arrival today, the tap yesterday: hidden.
  const tappedBefore = entry({ currentCheckIn: TAP, openShiftTapped: lateTap });
  assert.equal(showsArrivalChange(screen({ entry: tappedBefore })), false);
});

test("Change hides while the queue holds a save for the volunteer, not for someone else", () => {
  const mine = { ...emptyQueue, saves: [queuedSave("v-sam")] };
  const theirs = { ...emptyQueue, saves: [queuedSave("v-ana")] };
  assert.equal(showsArrivalChange(screen({ queue: mine })), false);
  assert.equal(showsArrivalChange(screen({ queue: theirs })), true);
});

test("after a Change lands its in mark clears openShiftId, so Change hides until a fresh list", () => {
  const marked = addMark({
    key: "6f1c1b7e-3a5d-4c1e-9f00-000000000002",
    volunteerId: "v-sam",
    at: NOW,
    listAfter: 0,
    state: "in",
    arrival: "2026-11-17T14:30:00.000Z",
  })(emptyQueue);
  const [shown] = overlay([entry()], marked, null);
  assert.equal(shown.openShiftId, null);
  assert.equal(shown.currentCheckIn, "2026-11-17T14:30:00.000Z");
  assert.equal(showsArrivalChange(screen({ entry: shown, queue: marked })), false);
});

test("a shared name: Change shows after the digits the screen asked for, or with none asked", () => {
  const shared = entry({ needsPhoneCheck: true });
  // Another of the name is checked in: the screen asked, and Change waits for four digits.
  assert.equal(showsArrivalChange(screen({ entry: shared, digitsAsked: true, digits: "" })), false);
  assert.equal(
    showsArrivalChange(screen({ entry: shared, digitsAsked: true, digits: "014" })),
    false,
  );
  assert.equal(
    showsArrivalChange(screen({ entry: shared, digitsAsked: true, digits: "0142" })),
    true,
  );
  // Only this one of the name is checked in: no digits asked, and Change shows, sending none.
  assert.equal(showsArrivalChange(screen({ entry: shared, digitsAsked: false })), true);
});

// ---------------------------------------------------------------------------
// The picker

test("the picker opens at the arrival rounded down, capped at the tap, and keeps what it saw", () => {
  const pick = openArrivalPick(entry(), NOW);
  assert.deepEqual(pick, {
    shiftId: "shift-1",
    fromIso: TAP,
    maxMinutes: 9 * 60 + 14,
    time: { time: "09:00", day: "2026-11-17" },
    touched: false,
  });
  // A list refresh after it opened doesn't change the row and start it compares with.
  const refreshed = entry({ currentCheckIn: "2026-11-17T14:00:00.000Z", openShiftId: "shift-2" });
  assert.equal(pick.fromIso, TAP);
  assert.equal(pick.shiftId, "shift-1");
  assert.notEqual(openArrivalPick(refreshed, NOW).fromIso, pick.fromIso);
});

test("the picker's start stays inside its range", () => {
  // A stated arrival a few minutes after the tap: the start is the tap rounded down.
  const after = openArrivalPick(entry({ currentCheckIn: "2026-11-17T15:20:00.000Z" }), NOW);
  assert.equal(after.time.time, "09:00");
  // An arrival at 12:05 AM starts at midnight.
  const early = openArrivalPick(entry({ currentCheckIn: "2026-11-17T06:05:00.000Z" }), NOW);
  assert.equal(early.time.time, "00:00");
});

test("the picker can't open without the row, the tap or the arrival", () => {
  assert.equal(openArrivalPick(entry({ openShiftId: null }), NOW), null);
  assert.equal(openArrivalPick(entry({ openShiftTapped: null }), NOW), null);
  assert.equal(openArrivalPick(entry({ currentCheckIn: null }), NOW), null);
});

test("Save time with the picker untouched sends nothing", () => {
  assert.equal(arrivalToSend(openArrivalPick(entry(), NOW)), null);
});

test("once moved, the picker sends what it shows, the rounded start included", () => {
  const pick = openArrivalPick(entry(), NOW);
  const earlier = movePick(pick, "08:30", NOW);
  assert.equal(earlier.touched, true);
  assert.equal(earlier.fromIso, TAP, "moving keeps what it saw");
  assert.equal(arrivalToSend(earlier), "2026-11-17T14:30:00.000Z");
  // Nudged away and back to 9:00: 9:00 is sent.
  const back = movePick(movePick(pick, "09:15", NOW), "09:00", NOW);
  assert.equal(arrivalToSend(back), "2026-11-17T15:00:00.000Z");
});

// ---------------------------------------------------------------------------
// What the answer does

test("an ok answer reads the same whether the arrival changed or was already that time", () => {
  const ok = { id: "v-sam", shiftId: "shift-1", arrivedAt: "2026-11-17T14:30:00.000Z" };
  assert.deepEqual(afterArrivalChange({ ...ok, changed: true }), { kind: "saved" });
  assert.deepEqual(afterArrivalChange({ ...ok, changed: false }), { kind: "saved" });
  assert.equal(arrivalSavedText, "Arrival time saved.");
});

test("the new refusals and the time refusals show their own message on the picker", () => {
  const expected = {
    ARRIVAL_ROW_CHANGED:
      "Your check-in changed since this screen opened. Please go back and tap your name again.",
    ARRIVAL_UNCHANGEABLE: "Please ask a board member to change your arrival time.",
    ARRIVAL_AFTER_CHECK_IN:
      "Your arrival can't be after you checked in. Please choose an earlier time.",
    ARRIVAL_OTHER_DAY: serverText.ARRIVAL_OTHER_DAY,
    ARRIVAL_FUTURE: serverText.ARRIVAL_FUTURE,
    NOT_FOUND: serverText.NOT_FOUND,
  };
  for (const [code, text] of Object.entries(expected)) {
    assert.equal(serverText[code], text, code);
    assert.deepEqual(afterArrivalChange({ refusal: code, message: serverText[code] }), {
      kind: "line",
      text,
    });
  }
});

test("busy, a failed call, no answer in time or an unknown refusal: couldn't save", () => {
  const line = { kind: "line", text: "We couldn't save your arrival time. Please try again." };
  assert.equal(arrivalChangeFailedText, line.text);
  assert.deepEqual(afterArrivalChange("failed"), line);
  assert.deepEqual(afterArrivalChange({ refusal: "BUSY", message: serverText.BUSY }), line);
  assert.deepEqual(afterArrivalChange({ refusal: "SOMETHING_NEW", message: "?" }), line);
});

test("NOT_IN goes to the status screen, ACCESS locks, phone refusals go as a check-out's", () => {
  assert.deepEqual(afterArrivalChange({ refusal: "NOT_IN", message: serverText.NOT_IN }), {
    kind: "not-in",
  });
  assert.deepEqual(afterArrivalChange({ refusal: "ACCESS", message: serverText.ACCESS }), {
    kind: "lock",
    message: serverText.ACCESS,
  });
  for (const code of ["PHONE_NEEDED", "PHONE_WRONG", "PHONE_MISSING"]) {
    const reply = { refusal: code, message: serverText[code] };
    assert.deepEqual(afterArrivalChange(reply), { kind: "phone", refusal: reply }, code);
  }
});

// ---------------------------------------------------------------------------
// App.tsx goes through these functions, and Save time reaches only the Change

const app = read("src/App.tsx");

/** The source from `start` up to the first `end` after it. */
function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `end of ${start} not found`);
  return source.slice(from, to);
}

const count = (source, text) => source.split(text).length - 1;

test("App.tsx: one place decides Change, on the check-out screen, with its whole state", () => {
  assert.equal(count(app, "showsArrivalChange("), 1);
  const call = slice(app, "showsArrivalChange({", "}),");
  for (const field of [
    "entry: selected",
    "phoneStep",
    "picker: checkOutPicker || arrivalPick !== null",
    "saving: save !== null || changeSaving",
    "digitsAsked",
    "digits: phoneDigits",
    "queue",
  ]) {
    assert.ok(call.includes(field), field);
  }
  const checkoutScreen = slice(
    app,
    '{code && screen === "checkout" && selected && (',
    "\n      )}",
  );
  assert.ok(checkoutScreen.includes("arrivalChange={{"));
  const confirmScreen = slice(app, '{code && screen === "confirm" && selected && (', "\n      )}");
  assert.ok(!confirmScreen.includes("arrivalChange"), "no Change on the check-in screen");
});

test("App.tsx: the picker reads the row and start when it opens, and Save time sends those", () => {
  assert.ok(app.includes("setArrivalPick(openArrivalPick(selected, Date.now()))"));
  const save = slice(app, "async function saveArrivalChange()", "\n  }\n");
  assert.ok(save.includes("pick.shiftId"));
  assert.ok(save.includes("pick.fromIso"));
  assert.ok(!save.includes("selected.currentCheckIn"));
  assert.ok(!save.includes("selected.openShiftId"));
});

test("App.tsx: Save time is the Change call alone, never a check-out", () => {
  const confirmation = slice(app, "function Confirmation(", "\nfunction ");
  const changePicker = slice(confirmation, "{changePicker && (", "/>");
  assert.ok(changePicker.includes("onConfirm={changePicker.onSave}"));
  assert.ok(changePicker.includes('confirmText="Save time"'));
  assert.ok(changePicker.includes("maxMinutes={changePicker.pick!.maxMinutes}"));
  assert.ok(!changePicker.includes("onConfirm={onConfirm}"));
  assert.ok(app.includes("onSave: saveArrivalChange,"));
  const save = slice(app, "async function saveArrivalChange()", "\n  }\n");
  assert.match(save, /api\s*\.changeArrival\(/);
  for (const other of [
    "onConfirm",
    "handleCheckout",
    "handleConfirm",
    "instantTap",
    "beginSave",
    "enqueue(",
    "api.checkOut",
    "api.checkIn",
  ]) {
    assert.ok(!save.includes(other), other);
  }
});

test("App.tsx: a Change waits for the server with its own mark, and an answer moves only that mark", () => {
  const save = slice(app, "async function saveArrivalChange()", "\n  }\n");
  assert.ok(save.includes("arrivalToSend(pick)"), "untouched sends nothing");
  assert.ok(save.includes("markBeforeSend(volunteerId)"));
  assert.ok(save.includes("settleWithin(answered, ATTEMPT_MS)"));
  assert.ok(save.includes("dropForegroundMark(markKey)"));
  assert.ok(save.includes('state: "in"'));
  assert.ok(save.includes("listAfter: 0"));
  assert.ok(save.includes("arrival: reply.arrivedAt"));
  assert.ok(save.includes("afterArrivalChange(reply)"));
  assert.ok(save.includes("if (!current()) return;"));
});
