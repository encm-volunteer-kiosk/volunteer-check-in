// Tests for the volunteer list kept in the tablet's storage (src/listStore.ts, imported as it
// is; Node strips its types): when a kept list is used at page load, when it is ignored and
// removed, what it holds, and how a storage error is ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centralDay,
  clearStoredList,
  LIST_STORE_KEY,
  LIST_STORE_VERSION,
  listStateAfterFailure,
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
  storeList(storage, "4417", T0, list, 8);
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
    storeList(storage, "4417", savedAt, list, 8);
    assert.equal(readStoredList(storage, readCode, now), null, name);
    assert.equal(storage.items.has(LIST_STORE_KEY), false, `${name}: removed`);
    // Gone for good: the right code and time can't bring it back.
    assert.equal(readStoredList(storage, "4417", T0), null, `${name}: stays gone`);
  }
});

// A volunteer as a kept list holds one.
const stored = {
  id: "h-ana",
  firstName: "Ana",
  lastName: "Lopez",
  checkedIn: false,
  currentCheckIn: null,
  needsPhoneCheck: false,
};

test("an entry that is not a kept list is ignored and removed", () => {
  const good = {
    version: LIST_STORE_VERSION,
    code: "4417",
    savedAt: T0,
    volunteers: [],
    longShiftHours: 8,
    milestones: [],
    clockOffsetMs: null,
    listStamp: null,
  };
  const bad = [
    "not json",
    "null",
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, version: 4 }),
    JSON.stringify({ ...good, savedAt: "yesterday" }),
    JSON.stringify({ ...good, milestones: undefined }),
    JSON.stringify({ ...good, clockOffsetMs: "soon" }),
    JSON.stringify({ ...good, listStamp: { epoch: "e" } }),
    JSON.stringify({ ...good, volunteers: [{ ...stored, missedSignOut: "yes" }] }),
    JSON.stringify({
      ...good,
      volunteers: [{ ...stored, checkOutMilestones: [{ fromMinutes: "0" }] }],
    }),
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
  assert.deepEqual(readStoredList(storage, "4417", T0 + MINUTE), {
    savedAt: T0,
    volunteers: [],
    longShiftHours: 8,
    milestones: [],
    clockOffsetMs: null,
    listStamp: null,
  });
});

test("a kept list keeps the long-shift number", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list, 10);
  const kept = readStoredList(storage, "4417", T0 + MINUTE);
  assert.ok(kept);
  assert.equal(kept.longShiftHours, 10);
  assert.deepEqual(kept.volunteers, list);
});

test("a list kept before the long-shift number, or without a good one, is ignored and removed", () => {
  const good = {
    version: LIST_STORE_VERSION,
    code: "4417",
    savedAt: T0,
    volunteers: [],
    longShiftHours: 8,
    milestones: [],
    clockOffsetMs: null,
    listStamp: null,
  };
  const { longShiftHours, ...noNumber } = good;
  const bad = [
    ["version 1", { version: 1, code: "4417", savedAt: T0, volunteers: [] }],
    ["missing", noNumber],
    ["0", { ...good, longShiftHours: 0 }],
    ["a string", { ...good, longShiftHours: "8" }],
    ["below 0", { ...good, longShiftHours: -1 }],
    ["null", { ...good, longShiftHours: null }],
  ];
  for (const [name, entry] of bad) {
    const storage = fakeStorage();
    storage.setItem(LIST_STORE_KEY, JSON.stringify(entry));
    assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null, name);
    assert.equal(storage.items.has(LIST_STORE_KEY), false, `${name}: removed`);
  }
  // A list stored with a bad number is not used either.
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list, Number.NaN);
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);
});

test("storage that throws on read or write is ignored", () => {
  const storage = throwingStorage();
  assert.doesNotThrow(() => storeList(storage, "4417", T0, list, 8));
  assert.equal(readStoredList(storage, "4417", T0), null);
  assert.doesNotThrow(() => clearStoredList(storage));
  // No storage at all, as when the page can't reach localStorage.
  assert.doesNotThrow(() => storeList(null, "4417", T0, list, 8));
  assert.equal(readStoredList(null, "4417", T0), null);
  assert.doesNotThrow(() => clearStoredList(null));

  // Reads work, writes and removals throw: a bad entry is still not used.
  const readOnly = fakeStorage();
  readOnly.setItem(LIST_STORE_KEY, "not json");
  readOnly.setItem = readOnly.removeItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(readStoredList(readOnly, "4417", T0), null);
  assert.doesNotThrow(() => storeList(readOnly, "4417", T0, list, 8));
});

test("changing or clearing the code clears the stored list", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list, 8);
  clearStoredList(storage);
  assert.equal(storage.items.has(LIST_STORE_KEY), false);
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);

  // A list kept for the old code is removed when the page reads with the new code, so
  // going back to the old code doesn't find it either.
  storeList(storage, "4417", T0, list, 8);
  assert.equal(readStoredList(storage, "5521", T0 + MINUTE), null);
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);

  // No code at all: the kept list is removed.
  storeList(storage, "4417", T0, list, 8);
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
  storeList(storage, "4417", T0, [local], 8);
  const entry = JSON.parse(storage.items.get(LIST_STORE_KEY));
  assert.deepEqual(Object.keys(entry).sort(), [
    "clockOffsetMs",
    "code",
    "listStamp",
    "longShiftHours",
    "milestones",
    "savedAt",
    "version",
    "volunteers",
  ]);
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

test("a kept list keeps what an instant result reads, and the list request's stamp", () => {
  const storage = fakeStorage();
  const steps = [
    { fromMinutes: 0, id: null },
    { fromMinutes: 95, id: "hours-50" },
  ];
  const ben = volunteer("h-ben", "Ben", "Okafor", {
    checkedIn: true,
    currentCheckIn: "2026-11-13T15:30:00.000Z",
    missedSignOut: false,
    openShiftId: "shift-ben",
    openUntil: "2026-11-14T03:30:00.000Z",
    checkOutMilestones: steps,
    completedShiftCount: 30,
    totalVolunteerMinutes: 2905,
  });
  const ana = volunteer("h-ana", "Ana", "Lopez", {
    missedSignOut: true,
    openShiftId: null,
    openUntil: null,
    checkOutMilestones: null,
  });
  const extras = {
    milestones: [{ id: "hours-50", title: "50 hours", message: "Thank you." }],
    clockOffsetMs: -1200,
    listStamp: { epoch: "e-1", seq: 7, requestedAt: T0 - 900 },
  };
  storeList(storage, "4417", T0, [ben, ana], 8, extras);
  const entry = JSON.parse(storage.items.get(LIST_STORE_KEY));
  assert.equal(entry.version, 3);
  assert.deepEqual(Object.keys(entry.volunteers[0]).sort(), [
    "checkOutMilestones",
    "checkedIn",
    "currentCheckIn",
    "firstName",
    "id",
    "lastName",
    "missedSignOut",
    "needsPhoneCheck",
    "openShiftId",
    "openUntil",
  ]);
  assert.doesNotMatch(storage.items.get(LIST_STORE_KEY), /2905|"30"/);
  const kept = readStoredList(storage, "4417", T0 + MINUTE);
  assert.deepEqual(kept.milestones, extras.milestones);
  assert.equal(kept.clockOffsetMs, -1200);
  assert.deepEqual(kept.listStamp, extras.listStamp);
  const keptBen = kept.volunteers[0];
  assert.equal(keptBen.missedSignOut, false);
  assert.equal(keptBen.openShiftId, "shift-ben");
  assert.equal(keptBen.openUntil, "2026-11-14T03:30:00.000Z");
  assert.deepEqual(keptBen.checkOutMilestones, steps);
  assert.equal(kept.volunteers[1].missedSignOut, true);
  assert.equal(kept.volunteers[1].openShiftId, null);
  assert.equal(kept.volunteers[1].checkOutMilestones, null);
});

test("a list from a server without the new fields is kept without them, so its taps wait", () => {
  const storage = fakeStorage();
  storeList(storage, "4417", T0, list, 8);
  const kept = readStoredList(storage, "4417", T0 + MINUTE);
  assert.equal("missedSignOut" in kept.volunteers[0], false);
  assert.equal("checkOutMilestones" in kept.volunteers[1], false);
  assert.equal(kept.clockOffsetMs, null);
  assert.equal(kept.listStamp, null);
});

test("a list kept by the page before instant results (version 2) is dropped on read", () => {
  const storage = fakeStorage();
  storage.setItem(
    LIST_STORE_KEY,
    JSON.stringify({
      version: 2,
      code: "4417",
      savedAt: T0,
      volunteers: [stored],
      longShiftHours: 8,
    }),
  );
  assert.equal(readStoredList(storage, "4417", T0 + MINUTE), null);
  assert.equal(storage.items.has(LIST_STORE_KEY), false);
});
