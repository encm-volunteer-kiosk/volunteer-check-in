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
