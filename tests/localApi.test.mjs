// Tests for the local development API's check-out of a shared name (src/api.ts, the store
// `pnpm dev` uses): with no digits it acts on the tapped member only when that member is the
// one of the name checked in, as the server does. api.ts imports its neighbors without a file
// extension, as Vite allows, so a resolve hook adds ".ts" for files under src/. Each case
// loads its own copy of the module, since the local store lives in the module's memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (
    specifier.startsWith("./") &&
    !/\\.[a-z]+$/.test(specifier) &&
    context.parentURL &&
    context.parentURL.includes("/src/")
  ) {
    return next(specifier + ".ts", context);
  }
  return next(specifier, context);
}
`),
);

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
}
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

const STORAGE_KEY = "encm-volunteer-kiosk-v1";
const CODE = "invented-kiosk-code";
const MIN = 60_000;

// The seed's Jordan Rivera (last four 0142), the local twin (0187), and an invented third
// Jordan Rivera with no phone on record.
const J1 = "vol-12";
const J2 = "vol-25";
const NO_PHONE = "vol-90";

let copies = 0;
async function loadApi() {
  copies += 1;
  return (await import(`../src/api.ts?copy=${copies}`)).localApi;
}

const jordan = (id) => ({
  id,
  firstName: "Jordan",
  lastName: "Rivera",
  active: true,
  expectedToday: false,
  currentCheckIn: null,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
});

/**
 * A fresh local store where the volunteers in `open` have a shift open since an hour ago,
 * and a copy of the API that reads it.
 */
async function storeWith(open, { noPhoneJordan = false } = {}) {
  localStorage.clear();
  sessionStorage.clear();
  // The first copy seeds the store.
  await (await loadApi()).listVolunteers(CODE);
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  data.volunteers.push(jordan(J2));
  if (noPhoneJordan) data.volunteers.push(jordan(NO_PHONE));
  const arrival = new Date(Date.now() - 60 * MIN).toISOString();
  for (const id of open) {
    const v = data.volunteers.find((x) => x.id === id);
    v.currentCheckIn = arrival;
    v.currentCheckInTappedAt = arrival;
    data.events.push({
      id: `open-${id}`,
      volunteerId: id,
      eventType: "check_in",
      timestamp: arrival,
      shiftId: `shift-${id}`,
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return loadApi();
}

async function checkedIn(api, id) {
  const list = await api.listVolunteers(CODE);
  return list.volunteers.find((v) => v.id === id).checkedIn;
}

test("only the tapped member in: no digits checks them out", async () => {
  const api = await storeWith([J1]);
  const reply = await api.checkOut(CODE, J1, null, null);
  assert.equal(reply.refusal, undefined, JSON.stringify(reply));
  assert.equal(reply.id, J1);
  assert.equal(reply.minutes, 60);
  assert.equal(await checkedIn(api, J1), false);
  // Blank digits of any kind are no digits.
  for (const digits of ["", "--"]) {
    const again = await storeWith([J1]);
    assert.equal((await again.checkOut(CODE, J1, digits, null)).id, J1, JSON.stringify(digits));
  }
});

test("a check-out without digits gives what the same check-out with the tapped member's digits gives", async () => {
  const without = await (await storeWith([J1])).checkOut(CODE, J1, null, null);
  const withDigits = await (await storeWith([J1])).checkOut(CODE, J1, "0142", null);
  const shape = (r) => ({ id: r.id, minutes: r.minutes, milestone: r.milestone });
  assert.deepEqual(shape(without), shape(withDigits));
});

test("both members in: PHONE_NEEDED, and the digits pick the member", async () => {
  const api = await storeWith([J1, J2]);
  assert.equal((await api.checkOut(CODE, J1, null, null)).refusal, "PHONE_NEEDED");
  assert.equal(await checkedIn(api, J1), true);
  assert.equal(await checkedIn(api, J2), true);
  assert.equal((await api.checkOut(CODE, J1, "0187", null)).id, J2);
  assert.equal(await checkedIn(api, J1), true);
});

test("only the other member in: PHONE_NEEDED, and nobody is checked out", async () => {
  const api = await storeWith([J2]);
  assert.equal((await api.checkOut(CODE, J1, null, null)).refusal, "PHONE_NEEDED");
  assert.equal(await checkedIn(api, J2), true);
});

test("the tapped member has no phone on record and another is in: PHONE_MISSING", async () => {
  let api = await storeWith([J1, NO_PHONE], { noPhoneJordan: true });
  assert.equal((await api.checkOut(CODE, NO_PHONE, null, null)).refusal, "PHONE_MISSING");
  api = await storeWith([J1], { noPhoneJordan: true });
  assert.equal((await api.checkOut(CODE, NO_PHONE, null, null)).refusal, "PHONE_MISSING");
  assert.equal(await checkedIn(api, J1), true);
});

test("the tapped member has no phone on record and is the only one in: checked out", async () => {
  const api = await storeWith([NO_PHONE], { noPhoneJordan: true });
  assert.equal((await api.checkOut(CODE, NO_PHONE, null, null)).id, NO_PHONE);
});

test("nobody of the name in: NOT_IN", async () => {
  const api = await storeWith([]);
  assert.equal((await api.checkOut(CODE, J1, null, null)).refusal, "NOT_IN");
});

test("a shift past the window doesn't count as in", async () => {
  await storeWith([J1, J2]);
  // Move the twin's tap 13 hours back, past the 12-hour window.
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  const twin = data.volunteers.find((v) => v.id === J2);
  twin.currentCheckInTappedAt = new Date(Date.now() - 13 * 60 * MIN).toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  const fresh = await loadApi();
  assert.equal((await fresh.checkOut(CODE, J1, null, null)).id, J1);
});

test("check-in of a shared name still needs digits when nobody of the name is in", async () => {
  const api = await storeWith([]);
  assert.equal((await api.checkIn(CODE, J1, null, null)).refusal, "PHONE_NEEDED");
});

test("a name nobody shares checks out without digits, as before", async () => {
  // David Miller is checked in by the seed.
  const api = await storeWith([]);
  assert.equal((await api.checkOut(CODE, "vol-8", null, null)).id, "vol-8");
});

const tapFor = (kind, extra = {}) => ({
  tapId: crypto.randomUUID(),
  shiftId: null,
  tapAt: Date.now() - 3 * MIN,
  sentAt: Date.now(),
  attempt: 1,
  shown: kind === "in" ? { missedSignOut: false } : { milestoneId: null },
  name: "Jordan Rivera",
  ...extra,
});

test("a tapped check-in sent twice makes one event and the second replies replayed", async () => {
  const api = await storeWith([]);
  const tap = tapFor("in");
  const first = await api.checkIn(CODE, "vol-1", null, null, tap);
  assert.equal(first.refusal, undefined, JSON.stringify(first));
  assert.equal(first.shiftId, tap.tapId, "the tap ID is the new Shift ID");
  // Stated at the tap: now minus its age.
  const stated = Date.parse(first.arrivedAt);
  assert.ok(Math.abs(stated - (Date.now() - 3 * MIN)) < 5_000, first.arrivedAt);
  const second = await api.checkIn(CODE, "vol-1", null, null, { ...tap, attempt: 2 });
  assert.equal(second.replayed, true);
  assert.equal(second.missedSignOut, false);
  const events = JSON.parse(localStorage.getItem(STORAGE_KEY)).events.filter(
    (e) => e.shiftId === tap.tapId,
  );
  assert.equal(events.length, 1);
  // A different tap for the same volunteer is a real ALREADY_IN.
  const other = await api.checkIn(CODE, "vol-1", null, null, tapFor("in"));
  assert.equal(other.refusal, "ALREADY_IN");
});

test("the local list carries the notice answer, the open Shift ID and window, and no steps", async () => {
  const api = await storeWith([J1]);
  const list = await api.listVolunteers(CODE);
  assert.equal(typeof list.serverNow, "number");
  assert.ok(list.milestones.some((m) => m.id === "hours-50"));
  const jordan = list.volunteers.find((v) => v.id === J1);
  assert.equal(jordan.openShiftId, `shift-${J1}`);
  assert.equal(Date.parse(jordan.openUntil) - Date.parse(jordan.openShiftArrival), 12 * 60 * MIN);
  assert.equal(jordan.checkOutMilestones, null, "local check-outs wait for their reply");
  const jennifer = list.volunteers.find((v) => v.id === "vol-3");
  assert.equal(jennifer.missedSignOut, true, "her last shift was closed by the auto clock-out");
  assert.equal(jennifer.openShiftId, null);
  assert.equal(list.volunteers.find((v) => v.id === "vol-2").missedSignOut, false);
});

test("a tapped check-out closes the named shift once; again it replies replayed", async () => {
  const api = await storeWith(["vol-1"]);
  const tap = tapFor("out", { shiftId: "shift-vol-1", name: "Sarah Johnson" });
  const first = await api.checkOut(CODE, "vol-1", null, null, tap);
  assert.equal(first.refusal, undefined, JSON.stringify(first));
  assert.equal(first.minutes, 57, "stated at the tap, three minutes before the send");
  const second = await api.checkOut(CODE, "vol-1", null, null, { ...tap, attempt: 2 });
  assert.equal(second.replayed, true);
  assert.equal(second.milestone, null);
  // A tap naming another shift is NOT_IN.
  const again = await storeWith(["vol-1"]);
  const wrong = await again.checkOut(CODE, "vol-1", null, null, {
    ...tap,
    shiftId: "someone-else",
  });
  assert.equal(wrong.refusal, "NOT_IN");
});

// ---------------------------------------------------------------------------------------
// Email me my hours

test("the local list turns the hours request button on", async () => {
  const api = await storeWith([]);
  assert.equal((await api.listVolunteers(CODE)).hoursRequests, true);
});

test("an hours request is recorded once; a repeat while it is open writes nothing", async () => {
  const api = await storeWith([]);
  assert.equal(await api.requestHours(CODE, "vol-1", null), true);
  assert.deepEqual(api.hoursRequestsOpen(), ["vol-1"]);
  // A repeat answers the same and adds nothing.
  assert.equal(await api.requestHours(CODE, "vol-1", null), true);
  assert.deepEqual(api.hoursRequestsOpen(), ["vol-1"]);
  // Nobody was checked in or out by it.
  assert.equal(await checkedIn(api, "vol-1"), false);
  assert.equal(await api.requestHours(CODE, "vol-2", null), true);
  assert.deepEqual(api.hoursRequestsOpen(), ["vol-1", "vol-2"]);
  api.reset();
  assert.deepEqual(api.hoursRequestsOpen(), []);
});

test("an hours request picks the volunteer by the check-in rule", async () => {
  const api = await storeWith([]);
  assert.equal((await api.requestHours(CODE, J1, null)).refusal, "PHONE_NEEDED");
  assert.equal((await api.requestHours(CODE, J1, "9999")).refusal, "PHONE_WRONG");
  // The digits pick the member, as for a check-in.
  assert.equal(await api.requestHours(CODE, J1, "0187"), true);
  assert.deepEqual(api.hoursRequestsOpen(), [J2]);
  assert.equal((await api.requestHours(CODE, "nobody", null)).refusal, "NOT_FOUND");
  assert.equal((await api.requestHours("short", "vol-1", null)).refusal, "ACCESS");
  assert.deepEqual(api.hoursRequestsOpen(), [J2]);
});
