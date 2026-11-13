// Tests for the volunteer list kept in the tablet's storage (src/listStore.ts, imported as it
// is; Node strips its types): when a kept list is used at page load, when it is ignored and
// removed, what it holds, and how a storage error is ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centralDay,
  clearStoredList,
  LIST_STORE_KEY,
  listStateAfterFailure,
  markVolunteerIn,
  readStoredList,
  retriesList,
  storeList,
  WAKE_REFRESH_MIN_MS,
  wakeRefreshDue,
} from "../src/listStore.ts";

const MINUTE = 60_000;
// 2026-11-13 10:00 AM Central (CST, UTC-6).
const T0 = Date.parse("2026-11-13T16:00:00Z");

function fakeStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

// As the page holds a volunteer from the server's list, plus the fields a local volunteer
// can carry, which must not be stored.
const volunteer = (id, firstName, lastName, extra = {}) => ({
  id,
  firstName,
  lastName,
  currentCheckIn: null,
  checkedIn: false,
  active: true,
  expectedToday: false,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  needsPhoneCheck: false,
  ...extra,
});

const list = [
  volunteer("h-ana", "Ana", "Lopez"),
  volunteer("h-ben", "Ben", "Okafor", {
    checkedIn: true,
    currentCheckIn: "2026-11-13T15:30:00.000Z",
  }),
  volunteer("h-cy", "Cy", "Park", { needsPhoneCheck: true }),
];

test("a list saved for this code today and under 10 minutes ago is used", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list);
  for (const age of [0, 1, 5 * MINUTE, 10 * MINUTE - 1]) {
    const kept = readStoredList(storage, "4417", T0 + age);
    assert.ok(kept, `age ${age} ms`);
    assert.equal(kept.savedAt, T0);
    assert.deepEqual(kept.volunteers, list);
  }
  assert.ok(storage.items.has(LIST_STORE_KEY));
});

test("a list 10 minutes old, from yesterday, with a savedAt in the future, or for another code is ignored and removed", () => {
  // 11:58 PM Central on Nov 12, read 5 minutes later, just after midnight.
  const lateYesterday = Date.parse("2026-11-13T05:58:00Z");
  assert.equal(centralDay(lateYesterday), "2026-11-12");
  assert.equal(centralDay(lateYesterday + 5 * MINUTE), "2026-11-13");
  const cases = [
    ["10 minutes old", "4417", T0, T0 + 10 * MINUTE],
    ["an hour old", "4417", T0, T0 + 60 * MINUTE],
    ["from yesterday", "4417", lateYesterday, lateYesterday + 5 * MINUTE],
    ["savedAt a second in the future", "4417", T0 + 1000, T0],
    ["for another code", "9999", T0, T0 + MINUTE],
  ];
  for (const [name, readCode, savedAt, now] of cases) {
    const storage = fakeStorage();
    storeList(storage, "4417", savedAt, list);
    assert.equal(readStoredList(storage, readCode, now), null, name);
    assert.equal(storage.items.has(LIST_STORE_KEY), false, `${name}: removed`);
    // Gone for good: the right code and time can't bring it back.
    assert.equal(readStoredList(storage, "4417", T0), null, `${name}: stays gone`);
  }
});

test("an entry that is not a kept list is ignored and removed", () => {
  const good = { version: 1, code: "4417", savedAt: T0, volunteers: [] };
  const bad = [
    "not json",
    "null",
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, savedAt: "yesterday" }),
    JSON.stringify({ ...good, volunteers: "none" }),
    JSON.stringify({ ...good, volunteers: [{ id: "h-ana", firstName: "Ana" }] }),
  ];
  for (const raw of bad) {
    const storage = fakeStorage();
    storage.setItem(LIST_STORE_KEY, raw);
    assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null, raw);
    assert.equal(storage.items.has(LIST_STORE_KEY), false, raw);
  }
  const storage = fakeStorage();
  storage.setItem(LIST_STORE_KEY, JSON.stringify(good));
  assert.deepEqual(readStoredList(storage, "4417", T0 + MINUTE), { savedAt: T0, volunteers: [] });
});

test("storage that throws on read or write is ignored", () => {
  const storage = throwingStorage();
  assert.doesNotThrow(() => storeList(storage, "4417", T0, list));
  assert.equal(readStoredList(storage, "4417", T0), null);
  assert.doesNotThrow(() => clearStoredList(storage));
  // No storage at all, as when the page can't reach localStorage.
  assert.doesNotThrow(() => storeList(null, "4417", T0, list));
  assert.equal(readStoredList(null, "4417", T0), null);
  assert.doesNotThrow(() => clearStoredList(null));

  // Reads work, writes and removals throw: a bad entry is still not used.
  const readOnly = fakeStorage();
  readOnly.setItem(LIST_STORE_KEY, "not json");
  readOnly.setItem = readOnly.removeItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(readStoredList(readOnly, "4417", T0), null);
  assert.doesNotThrow(() => storeList(readOnly, "4417", T0, list));
});

test("a stored list keeps its server list's age when written again after a mark", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list);
  // Nine minutes later the page checks Ana in and writes the marked list with the same savedAt.
  const arrival = "2026-11-13T16:09:00.000Z";
  const marked = markVolunteerIn(list, "h-ana", arrival);
  storeList(storage, "4417", T0, marked);
  const kept = readStoredList(storage, "4417", T0 + 9 * MINUTE + 30_000);
  assert.ok(kept);
  assert.equal(kept.savedAt, T0);
  const ana = kept.volunteers.find((v) => v.id === "h-ana");
  assert.equal(ana.checkedIn, true);
  assert.equal(ana.currentCheckIn, arrival);
  // Ten minutes after the server list, not after the write, it is too old.
  assert.equal(readStoredList(storage, "4417", T0 + 10 * MINUTE), null);
  assert.equal(storage.items.has(LIST_STORE_KEY), false);
});

test("a check-out mark clears the flag and the arrival of that volunteer only", () => {
  const marked = markVolunteerIn(list, "h-ben", null);
  assert.deepEqual(
    marked.map((v) => [v.id, v.checkedIn, v.currentCheckIn]),
    [
      ["h-ana", false, null],
      ["h-ben", false, null],
      ["h-cy", false, null],
    ],
  );
  assert.notEqual(marked, list);
  assert.equal(list[1].checkedIn, true, "the old list is not changed");
});

test("changing or clearing the code clears the stored list", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list);
  clearStoredList(storage);
  assert.equal(storage.items.has(LIST_STORE_KEY), false);
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);

  // A list kept for the old code is removed when the page reads with the new code, so
  // going back to the old code doesn't find it either.
  storeList(storage, "4417", T0, list);
  assert.equal(readStoredList(storage, "5521", T0 + MINUTE), null);
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);

  // No code at all: the kept list is removed.
  storeList(storage, "4417", T0, list);
  assert.equal(readStoredList(storage, null, T0 + MINUTE), null);
  assert.equal(storage.items.has(LIST_STORE_KEY), false);
});

test("a stored entry holds names, hashed id, the checked-in flag and arrival, and the phone-check flag only", () => {
  const storage = fakeStorage();
  const local = volunteer("h-dee", "Dee", "Ray", {
    phone: "6155550142",
    email: "dee@example.org",
    currentCheckInTappedAt: "2026-11-13T15:31:00.000Z",
    completedShiftCount: 12,
    totalVolunteerMinutes: 900,
  });
  storeList(storage, "4417", T0, [local]);
  const entry = JSON.parse(storage.items.get(LIST_STORE_KEY));
  assert.deepEqual(Object.keys(entry).sort(), ["code", "savedAt", "version", "volunteers"]);
  assert.deepEqual(entry.volunteers, [
    {
      id: "h-dee",
      firstName: "Dee",
      lastName: "Ray",
      checkedIn: false,
      currentCheckIn: null,
      needsPhoneCheck: false,
    },
  ]);
  assert.doesNotMatch(storage.items.get(LIST_STORE_KEY), /6155550142|0142|example\.org/);
});

test("a kept list stays on a failed refresh and is retried every 30 s until a refresh lands", () => {
  assert.equal(listStateAfterFailure("stored"), "stored");
  assert.equal(listStateAfterFailure("ready"), "ready");
  assert.equal(listStateAfterFailure("loading"), "failed");
  assert.equal(listStateAfterFailure("failed"), "failed");
  assert.equal(retriesList("stored"), true);
  assert.equal(retriesList("failed"), true);
  assert.equal(retriesList("ready"), false);
  assert.equal(retriesList("loading"), false);
});

test("coming back into view refreshes the list the first time", () => {
  assert.equal(wakeRefreshDue(T0, null, false), true);
});

test("coming back into view never refreshes the list while a save is pending", () => {
  assert.equal(wakeRefreshDue(T0, null, true), false);
  assert.equal(wakeRefreshDue(T0 + 10 * MINUTE, T0, true), false);
});

test("coming back into view refreshes the list at most once every 30 s", () => {
  assert.equal(WAKE_REFRESH_MIN_MS, 30_000);
  assert.equal(wakeRefreshDue(T0 + 29_999, T0, false), false);
  assert.equal(wakeRefreshDue(T0 + 30_000, T0, false), true);
  assert.equal(wakeRefreshDue(T0 + 5 * MINUTE, T0, false), true);
});
