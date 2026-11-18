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

const { brandKey } = await import("../src/brand.ts");
const STORAGE_KEY = brandKey("volunteer-kiosk-v1");
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
// Request my hours

test("the local list turns the Request my hours link on", async () => {
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

// ---------------------------------------------------------------------------------------
// Change of arrival

/** The open shift's start and tap as the store holds them, read back. */
function storedOpen(id) {
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  const v = data.volunteers.find((x) => x.id === id);
  const event = data.events.find((e) => e.shiftId === `shift-${id}` && e.eventType === "check_in");
  return { start: v.currentCheckIn, tapped: v.currentCheckInTappedAt, event: event.timestamp };
}

test("the local list gives the open row's tap time, and null when not checked in", async () => {
  const api = await storeWith(["vol-1"]);
  const list = await api.listVolunteers(CODE);
  const sarah = list.volunteers.find((v) => v.id === "vol-1");
  assert.equal(sarah.openShiftTapped, storedOpen("vol-1").tapped);
  assert.equal(list.volunteers.find((v) => v.id === "vol-2").openShiftTapped, null);
});

test("a Change moves the open shift's start and keeps the tap", async () => {
  const api = await storeWith(["vol-1"]);
  const before = storedOpen("vol-1");
  const earlier = new Date(Date.parse(before.tapped) - 5 * MIN).toISOString();
  const reply = await api.changeArrival(CODE, "vol-1", null, "shift-vol-1", before.start, earlier);
  assert.deepEqual(reply, {
    id: "vol-1",
    shiftId: "shift-vol-1",
    arrivedAt: earlier,
    changed: true,
  });
  const after = storedOpen("vol-1");
  assert.equal(after.start, earlier);
  assert.equal(after.event, earlier);
  assert.equal(after.tapped, before.tapped, "the tap time is never moved");
  // The list follows.
  const listed = (await api.listVolunteers(CODE)).volunteers.find((v) => v.id === "vol-1");
  assert.equal(listed.openShiftArrival, earlier);
});

test("a Change to the start it already has answers changed false, even with a stale start shown", async () => {
  const api = await storeWith(["vol-1"]);
  const { start } = storedOpen("vol-1");
  const stale = new Date(Date.parse(start) - 30 * MIN).toISOString();
  const reply = await api.changeArrival(CODE, "vol-1", null, "shift-vol-1", stale, start);
  assert.equal(reply.changed, false);
  assert.equal(reply.arrivedAt, start);
});

test("a Change refuses in the server's order", async () => {
  let api = await storeWith(["vol-1"]);
  const { start, tapped } = storedOpen("vol-1");
  const earlier = new Date(Date.parse(tapped) - 5 * MIN).toISOString();
  const change = (over = {}) => {
    const a = { code: CODE, id: "vol-1", digits: null, shiftId: "shift-vol-1", from: start };
    const b = { ...a, arrival: earlier, ...over };
    return api.changeArrival(b.code, b.id, b.digits, b.shiftId, b.from, b.arrival);
  };
  assert.equal((await change({ code: "short" })).refusal, "ACCESS");
  assert.equal((await change({ id: "nobody" })).refusal, "NOT_FOUND");
  assert.equal((await change({ id: "vol-2" })).refusal, "NOT_IN");
  assert.equal((await change({ shiftId: "another" })).refusal, "ARRIVAL_ROW_CHANGED");
  assert.equal((await change({ shiftId: "  " })).refusal, "ARRIVAL_ROW_CHANGED");
  assert.equal((await change({ arrival: "not a time" })).refusal, "ARRIVAL_OTHER_DAY");
  assert.equal(
    (await change({ arrival: new Date(Date.now() + 10 * MIN).toISOString() })).refusal,
    "ARRIVAL_FUTURE",
  );
  assert.equal(
    (await change({ arrival: new Date(Date.parse(tapped) - 26 * 60 * MIN).toISOString() })).refusal,
    "ARRIVAL_OTHER_DAY",
  );
  assert.equal(
    (await change({ arrival: new Date(Date.parse(tapped) + MIN).toISOString() })).refusal,
    "ARRIVAL_AFTER_CHECK_IN",
  );
  const otherStart = new Date(Date.parse(start) - 30 * MIN).toISOString();
  assert.equal((await change({ from: otherStart })).refusal, "ARRIVAL_ROW_CHANGED");
  assert.equal(storedOpen("vol-1").start, start, "no refusal wrote anything");
  // A shift stored without its tap time can't be changed.
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  data.volunteers.find((v) => v.id === "vol-1").currentCheckInTappedAt = null;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  api = await loadApi();
  assert.equal((await change()).refusal, "ARRIVAL_UNCHANGEABLE");
});

test("a Change of a shared name follows the check-out's rule for who it is", async () => {
  // Both in: digits are needed; the twin's digits name the twin, whose row isn't the one shown.
  const api = await storeWith([J1, J2]);
  const { start, tapped } = storedOpen(J1);
  const earlier = new Date(Date.parse(tapped) - 5 * MIN).toISOString();
  const send = (digits) => api.changeArrival(CODE, J1, digits, `shift-${J1}`, start, earlier);
  assert.equal((await send(null)).refusal, "PHONE_NEEDED");
  assert.equal((await send("0187")).refusal, "ARRIVAL_ROW_CHANGED");
  assert.equal((await send("0142")).changed, true);
  // Only the tapped member in: no digits needed.
  const alone = await storeWith([J1]);
  const own = storedOpen(J1);
  const reply = await alone.changeArrival(
    CODE,
    J1,
    null,
    `shift-${J1}`,
    own.start,
    new Date(Date.parse(own.tapped) - 5 * MIN).toISOString(),
  );
  assert.equal(reply.changed, true);
});

// ---------------------------------------------------------------------------------------
// The call record around the API

test("every API call goes through the call record", async () => {
  const { withCallRecord } = await import(`../src/api.ts?copy=${++copies}`);
  const { callLog } = await import("../src/callRecord.ts");
  let now = 1_000;
  const log = callLog(() => now);
  const calls = [];
  const inner = new Proxy(
    {},
    {
      get: (_, name) => async () => {
        calls.push(name);
        now += 100;
        if (name === "requestHours") throw new Error("failed");
        return name === "checkOut" ? { refusal: "NOT_IN", message: "m" } : true;
      },
    },
  );
  const wrapped = withCallRecord(inner, log);
  const names = [
    "checkAccess",
    "listVolunteers",
    "checkIn",
    "checkOut",
    "changeArrival",
    "requestHours",
  ];
  for (const name of names) {
    await wrapped[name]("code").catch(() => {});
  }
  assert.deepEqual(calls, names);
  assert.deepEqual(Object.keys(wrapped).sort(), [...names].sort());
  const record = log.read();
  assert.equal(record.latestReply, 1_500, "a refusal is a reply");
  assert.equal(record.latestEnded, 1_600);
  assert.deepEqual(record.waiting, []);
});
