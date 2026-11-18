// Tests for instant check-ins and check-outs and the queue that saves them (src/saveQueue.ts,
// imported as it is; Node strips its types; its one neighbour import names its .ts file):
// which taps qualify, the shift minutes and milestone against the server's own functions,
// the stored queue with one writer at a time across pages, the runner, marks and the overlay,
// the banner's lines and the still-saving line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  addMark,
  afterAttempt,
  afterEnqueue,
  ATTEMPT_MS,
  BACKOFF_MS,
  CALL_SLOW_MS,
  changeQueue,
  codeMatches,
  dismissFailed,
  dropMark,
  dueSave,
  enqueue,
  FLOW_MS,
  freshQueue,
  hasMarkSince,
  LIST_REFRESH_MS,
  LIST_TRUST_MS,
  LOCK_WAIT_MS,
  listTrusted,
  markSent,
  MAX_SENDS,
  milestoneFor,
  nearBoundary,
  newSave,
  newTapId,
  nextRunDelay,
  outcomeOf,
  overlay,
  qualifies,
  qualifyFailure,
  queueFlowing,
  REACH_MS,
  readQueue,
  runOnce,
  runnerGate,
  RUNNER_BUSY_RETRY_MS,
  SAVE_QUEUE_KEY,
  SAVE_QUEUE_LOCK,
  SAVE_QUEUE_VERSION,
  SAVE_RUNNER_LOCK,
  SERVER_MAX_MS,
  shiftMinutes,
  stampNow,
  stillSavingText,
  storeForegroundMark,
  SLOW_SAVE_MS,
  STUCK_MS,
  savesGoingThrough,
  savingLineShown,
  nextSlowAt,
  stuckSaves,
  takeDue,
  touch,
  writeQueue,
} from "../src/saveQueue.ts";
import { LIST_STORE_KEY } from "../src/listStore.ts";
import { stepsWithNulls } from "../src/replies.ts";
import { viaScriptRun } from "./scriptRun.mjs";

const L = {};
vm.runInNewContext(
  readFileSync(new URL("../apps-script/Brand.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("../apps-script/Logic.js", import.meta.url), "utf8"),
  L,
);
const plain = (x) => JSON.parse(JSON.stringify(x));

const MIN = 60_000;
// 10:00 AM Central on 2026-11-13.
const T0 = Date.parse("2026-11-13T16:00:00Z");
const TAP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeStorage() {
  const items = new Map();
  return {
    items,
    full: false,
    getItem(key) {
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      if (this.full) throw new Error("QuotaExceededError");
      items.set(key, String(value));
    },
    removeItem: (key) => void items.delete(key),
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

// Web Locks as one origin's pages share them: exclusive, granted in request order, and
// ifAvailable gets null while the lock is held.
function fakeLocks() {
  const held = new Map();
  return {
    isHeld: (name) => held.has(name),
    async request(name, options, callback) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise((resolve) => held.get(name).push(resolve));
      } else held.set(name, []);
      try {
        return await callback({ name });
      } finally {
        const next = held.get(name).shift();
        if (next) next();
        else held.delete(name);
      }
    },
  };
}

let epochs = 0;
function makeEnv(shared = {}) {
  let now = shared.now ?? T0;
  return {
    locks: "locks" in shared ? shared.locks : fakeLocks(),
    storage: "storage" in shared ? shared.storage : fakeStorage(),
    newEpoch: () => `epoch-${++epochs}`,
    now: () => now,
    setNow: (ms) => (now = ms),
  };
}

// Two pages of one tablet: one storage, one lock manager, each page its own env.
function twoPages() {
  const storage = fakeStorage();
  const locks = fakeLocks();
  return { storage, locks, a: makeEnv({ storage, locks }), b: makeEnv({ storage, locks }) };
}

const stored = (storage) => JSON.parse(storage.getItem(SAVE_QUEUE_KEY));

const ana = {
  id: "vol-1",
  firstName: "Ana",
  lastName: "Lopez",
  checkedIn: false,
  currentCheckIn: null,
  needsPhoneCheck: false,
  missedSignOut: true,
  openShiftId: null,
  openUntil: null,
  checkOutMilestones: null,
};
// Ben checked in at 8:00 AM Central, two hours before T0; the window ends 12 hours after.
const ben = {
  id: "vol-2",
  firstName: "Ben",
  lastName: "Ortiz",
  checkedIn: true,
  currentCheckIn: new Date(T0 - 120 * MIN).toISOString(),
  needsPhoneCheck: false,
  missedSignOut: false,
  openShiftId: "shift-ben",
  openUntil: new Date(T0 + 600 * MIN).toISOString(),
  checkOutMilestones: [
    { fromMinutes: 0, id: null },
    { fromMinutes: 200, id: "hours-50" },
  ],
};

function baseCtx(queue, extra = {}) {
  return {
    hasCode: true,
    codeStored: true,
    foregroundPending: false,
    online: true,
    calls: { latestReply: T0 - 5_000, latestEnded: null, waiting: [] },
    listState: "ready",
    now: T0,
    listStamp: { epoch: queue.epoch, seq: queue.seq, requestedAt: T0 - MIN },
    clockOffsetMs: 1_000,
    queue,
    heldMarks: [],
    arrivalPicker: false,
    checkOutPicker: false,
    ...extra,
  };
}

const saveFor = (kind, entry, tapAt = T0, key) => newSave(kind, entry, tapAt, key);

// ---------------------------------------------------------------------------------------
// Which taps qualify

test("a normal check-in and check-out qualify", () => {
  const q = freshQueue("e1");
  assert.equal(qualifyFailure("in", ana, baseCtx(q)), null);
  assert.equal(qualifyFailure("out", ben, baseCtx(q)), null);
  assert.equal(qualifies("in", ana, baseCtx(q)), true);
});

test("each rule failing alone sends the tap the waiting way", () => {
  const q = freshQueue("e1");
  const cases = [
    [1, "in", ana, { hasCode: false }],
    [1, "in", ana, { codeStored: false }],
    [1, "out", ben, { codeStored: false }],
    [1, "in", ana, { online: false }],
    [1, "out", ben, { calls: { latestReply: null, latestEnded: null, waiting: [] } }],
    [1, "in", ana, { foregroundPending: true }],
    [2, "in", ana, { listState: "failed" }],
    [2, "in", ana, { listState: "loading" }],
    [4, "in", { ...ana, needsPhoneCheck: true }, {}],
    [4, "out", { ...ben, needsPhoneCheck: undefined }, {}],
    [5, "in", ana, { arrivalPicker: true }],
    [5, "out", ben, { checkOutPicker: true }],
    [7, "in", { ...ana, checkedIn: true }, {}],
    [7, "in", { ...ana, missedSignOut: undefined }, {}],
    [8, "out", { ...ben, checkedIn: false }, {}],
    [8, "out", { ...ben, openShiftId: null }, {}],
    [8, "out", { ...ben, openShiftId: "  " }, {}],
    [8, "out", { ...ben, currentCheckIn: null }, {}],
    [8, "out", { ...ben, openUntil: null }, {}],
    [8, "out", { ...ben, openUntil: "not a time" }, {}],
    [8, "out", { ...ben, openUntil: new Date(T0 + 2 * MIN - 1).toISOString() }, {}],
    [8, "out", { ...ben, checkOutMilestones: null }, {}],
    [8, "out", { ...ben, checkOutMilestones: undefined }, {}],
    [
      8,
      "out",
      {
        ...ben,
        checkOutMilestones: [
          { fromMinutes: 0, id: null },
          { fromMinutes: 121, id: "hours-50" },
        ],
      },
      {},
    ],
  ];
  for (const [rule, kind, entry, extra] of cases) {
    assert.equal(qualifyFailure(kind, entry, baseCtx(q, extra)), rule, JSON.stringify(extra));
  }
  // Exactly the margin before the window ends still qualifies.
  const edge = { ...ben, openUntil: new Date(T0 + 2 * MIN).toISOString() };
  assert.equal(qualifyFailure("out", edge, baseCtx(q)), null);
});

test("rule 1: taps are instant only with a code that reads back from storage and saves going through", () => {
  const q = freshQueue("e1");
  assert.equal(qualifyFailure("in", ana, baseCtx(q, { codeStored: true })), null);
  assert.equal(qualifyFailure("out", ben, baseCtx(q, { codeStored: true })), null);
  // The code didn't read back (storage blocked): every tap waits, as without the queue.
  assert.equal(qualifyFailure("in", ana, baseCtx(q, { codeStored: false })), 1);
  assert.equal(qualifyFailure("out", ben, baseCtx(q, { codeStored: false })), 1);
  assert.equal(qualifies("in", ana, baseCtx(q, { codeStored: false })), false);
  // Saves not going through, by this page's calls and by the stored queue alone.
  const hung = { latestReply: T0 - 20_000, latestEnded: null, waiting: [T0 - CALL_SLOW_MS] };
  assert.equal(qualifyFailure("in", ana, baseCtx(q, { calls: hung })), 1);
  const stuck = {
    ...q,
    saves: [{ ...saveFor("in", ben, T0 - 12_000), sends: 1, lastSendAt: T0 - 11_000 }],
  };
  assert.equal(qualifyFailure("in", ana, baseCtx(stuck)), 1);
  // The old name of the code check is gone from the page and the queue.
  for (const file of ["src/saveQueue.ts", "src/App.tsx"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /codeKept/);
  }
  // The page passes the code read-back and its call record into the tap context.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /codeStored: codeStored\.current,/);
  assert.match(app, /calls: callRecord\(\),/);
  assert.match(app, /online: navigator\.onLine,/);
});

test("rule 3: a mark newer than the list, or a new epoch, waits", () => {
  let q = freshQueue("e1");
  const ctx = baseCtx(q);
  q = {
    ...addMark({ key: "k", volunteerId: ana.id, at: T0, listAfter: 0, state: "in", arrival: null })(
      q,
    ),
    seq: 1,
  };
  assert.equal(qualifyFailure("in", ana, { ...ctx, queue: q }), 3);
  // Another volunteer's mark doesn't matter.
  assert.equal(qualifyFailure("out", ben, { ...ctx, queue: q }), null);
  // A list asked for after the mark passes.
  const after = { ...ctx, queue: q, listStamp: { epoch: "e1", seq: 1, requestedAt: T0 - MIN } };
  assert.equal(qualifyFailure("in", ana, after), null);
  // A queue replaced after an unreadable read has a new epoch: nothing is trusted.
  const replaced = freshQueue("e2");
  assert.equal(qualifyFailure("out", ben, { ...ctx, queue: replaced }), 3);
});

test("rule 3 reads marks held in memory when they couldn't be stored", () => {
  const q = freshQueue("e1");
  const held = {
    key: "fg",
    volunteerId: ana.id,
    seq: 0,
    at: T0 - 30_000,
    listAfter: 0,
    state: "in",
    arrival: null,
  };
  // The list was asked for a minute ago, before the held mark.
  assert.equal(qualifyFailure("in", ana, baseCtx(q, { heldMarks: [held] })), 3);
  // A list asked for after it covers it.
  const later = { epoch: "e1", seq: 0, requestedAt: T0 - 10_000 };
  assert.equal(
    qualifyFailure("in", ana, baseCtx(q, { heldMarks: [held], listStamp: later })),
    null,
  );
});

test("rule 6: a queued save for the volunteer waits", () => {
  const q = { ...freshQueue("e1"), saves: [saveFor("in", ana)] };
  assert.equal(qualifyFailure("in", ana, baseCtx(q)), 6);
});

test("listTrusted: age under 6 minutes and a clock within 60 s", () => {
  const stamp = (age) => ({ epoch: "e", seq: 0, requestedAt: T0 - age });
  const ctx = (age, offset, listState = "ready") => ({
    listState,
    now: T0,
    listStamp: stamp(age),
    clockOffsetMs: offset,
  });
  assert.equal(listTrusted(ctx(5 * MIN + 59_000, 0)), true);
  assert.equal(listTrusted(ctx(6 * MIN, 0)), false);
  assert.equal(listTrusted(ctx(-1, 0)), false, "a clock that stepped back");
  assert.equal(listTrusted(ctx(0, 60_000)), true);
  assert.equal(listTrusted(ctx(0, -60_000)), true);
  assert.equal(listTrusted(ctx(0, 61_000)), false);
  assert.equal(listTrusted(ctx(0, -61_000)), false);
  assert.equal(listTrusted(ctx(0, null)), false, "an old server sends no clock");
  assert.equal(listTrusted(ctx(0, 0, "stored")), true);
  assert.equal(listTrusted(ctx(0, 0, "failed")), false);
  assert.equal(
    listTrusted({ listState: "ready", now: T0, listStamp: null, clockOffsetMs: 0 }),
    false,
  );
});

test("nearBoundary at 2 and 3 minutes from a step; the first step is no boundary", () => {
  const steps = [
    { fromMinutes: 0, id: null },
    { fromMinutes: 100, id: "hours-50" },
  ];
  assert.equal(nearBoundary(steps, 98), true);
  assert.equal(nearBoundary(steps, 102), true);
  assert.equal(nearBoundary(steps, 97), false);
  assert.equal(nearBoundary(steps, 103), false);
  assert.equal(nearBoundary(steps, 0), false);
  assert.equal(nearBoundary([{ fromMinutes: 0, id: "shift-1" }], 1), false);
});

test("shiftMinutes and milestoneFor equal the server's functions on a grid", () => {
  const launch = "2026-01-01";
  const start = Date.parse("2026-11-13T14:00:00Z");
  const startIso = new Date(start).toISOString();
  for (const shifts of [0, 1, 9, 10, 24, 25, 30]) {
    for (const minutes of [0, 2999, 3000 - 30, 5999, 6000 - 600, 9000]) {
      for (const startDate of ["2025-06-01", "2026-03-01", ""]) {
        const state = { shifts, minutes };
        const maxMinutes = 12 * 60 + 1;
        // As the page reads them: through google.script.run, then replies.ts.
        const steps = stepsWithNulls(
          viaScriptRun(L.checkOutMilestoneSteps(state, { startDate }, launch, maxMinutes)),
        );
        for (let add = 0; add <= maxMinutes; add += 7) {
          // A tap 0-59 s past the minute, as the server reads it.
          const tapMs = start + add * MIN + (add % 60) * 1000;
          const server = L.minutesFromHours(L.hoursBetween(start, tapMs));
          assert.equal(shiftMinutes(startIso, tapMs), server);
          const crossed = L.milestoneCrossed(shifts, minutes, server, startDate, launch);
          assert.equal(milestoneFor(steps, server), crossed ? crossed.id : null);
        }
      }
    }
  }
  assert.equal(shiftMinutes(startIso, start - 5 * MIN), 0, "a tap before the start reads as 0");
});

// ---------------------------------------------------------------------------------------
// Sending

test("dueSave sends only the head, never offline, and waits for nextTryAt", () => {
  const first = { ...saveFor("in", ana), nextTryAt: T0 + 5_000 };
  const second = saveFor("out", ben);
  const q = { ...freshQueue("e"), saves: [first, second] };
  assert.equal(dueSave(q, T0, true), null, "the head isn't due and the second isn't sent");
  assert.equal(dueSave(q, T0 + 5_000, true), first);
  assert.equal(dueSave(q, T0 + 5_000, false), null);
  assert.equal(dueSave(freshQueue("e"), T0, true), null);
});

test("outcomeOf for each code, kind, a throw and a replay", () => {
  const refusal = (code) => ({ refusal: code, message: `msg ${code}` });
  assert.equal(outcomeOf("in", { id: "x", replayed: true }), "landed");
  assert.equal(outcomeOf("out", { ok: true }), "landed");
  assert.equal(outcomeOf("in", refusal("ALREADY_IN")), "landed");
  assert.equal(outcomeOf("out", refusal("NOT_IN")), "landed");
  assert.equal(outcomeOf("out", refusal("ALREADY_IN")), "refused");
  assert.equal(outcomeOf("in", refusal("NOT_IN")), "refused");
  assert.equal(outcomeOf("in", refusal("BUSY")), "retry");
  assert.equal(outcomeOf("in", refusal("ACCESS")), "lock");
  // A kiosk with no time zone keeps the save, as a refused code does.
  assert.equal(outcomeOf("out", refusal("ZONE_NOT_SET")), "lock");
  assert.equal(outcomeOf("in", refusal("TAP_UNREADABLE")), "refused");
  assert.equal(outcomeOf("out", refusal("NOT_FOUND")), "refused");
  assert.equal(outcomeOf("in", refusal("ARRIVAL_OTHER_DAY")), "refused");
  assert.equal(outcomeOf("in", null), "retry", "a rejected call or a timeout");
  assert.equal(outcomeOf("in", undefined), "retry");
});

test("afterAttempt steps through the backoff and gives up at 12 sends", () => {
  let q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0, "k1")] };
  let now = T0;
  const waits = [];
  for (let n = 1; n <= MAX_SENDS; n++) {
    q = markSent("k1", now)(q);
    assert.equal(q.saves[0].sends, n);
    q = { ...afterAttempt("k1", { outcome: "retry", replied: false }, now)(q), seq: q.seq + 1 };
    if (n < MAX_SENDS) {
      waits.push(q.saves[0].nextTryAt - now);
      now = q.saves[0].nextTryAt;
    }
  }
  assert.deepEqual(waits, [...BACKOFF_MS, 300_000, 300_000, 300_000, 300_000]);
  assert.equal(q.saves.length, 0);
  assert.equal(q.failed.length, 1);
  assert.equal(q.failed[0].reason, "The tablet couldn't reach the server.");
  assert.equal(q.failed[0].maybeSaved, true);
  assert.equal(q.failed[0].name, "Ana Lopez");
  const mark = q.marks.find((m) => m.key === "k1");
  assert.equal(mark.state, "unknown");
  assert.equal(mark.listAfter, now + SERVER_MAX_MS, "no send was answered");
});

test("afterAttempt: a refusal fails at once with the server's message; BUSY retries", () => {
  let q = { ...freshQueue("e"), saves: [saveFor("out", ben, T0, "k1")] };
  q = markSent("k1", T0)(q);
  const busy = afterAttempt("k1", { outcome: "retry", replied: true }, T0)(q);
  assert.equal(busy.saves[0].replies, 1);
  assert.equal(busy.saves[0].nextTryAt, T0 + BACKOFF_MS[0]);
  const refused = afterAttempt(
    "k1",
    { outcome: "refused", replied: true, reason: "A kiosk tap can't be read." },
    T0,
  )(q);
  assert.equal(refused.saves.length, 0);
  assert.deepEqual(plain(refused.failed[0]), {
    key: "k1",
    kind: "out",
    name: "Ben Ortiz",
    tapAt: T0,
    reason: "A kiosk tap can't be read.",
    maybeSaved: false,
  });
  assert.equal(refused.marks[0].state, "unknown");
  assert.equal(refused.marks[0].listAfter, 0, "its one send was answered");
});

test("afterAttempt: ACCESS keeps the save and doesn't count the send", () => {
  let q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0, "k1")] };
  q = markSent("k1", T0)(q);
  const locked = afterAttempt("k1", { outcome: "lock", replied: true }, T0)(q);
  assert.equal(locked.saves[0].sends, 0);
  assert.equal(locked.saves[0].retries, 0);
  assert.equal(locked.saves[0].nextTryAt, 0);
  assert.deepEqual(afterAttempt("gone", { outcome: "landed", replied: true }, T0)(q), {
    refused: "gone",
  });
});

// ---------------------------------------------------------------------------------------
// The stored queue

test("readQueue: no text, blocked storage, bad JSON, wrong version, bad entry", () => {
  let n = 0;
  const epoch = () => `fresh-${++n}`;
  const empty = fakeStorage();
  assert.deepEqual(readQueue(empty, epoch), freshQueue("fresh-1"));
  assert.deepEqual(readQueue(throwingStorage(), epoch), freshQueue("fresh-2"));
  assert.deepEqual(readQueue(null, epoch), freshQueue("fresh-3"));
  const bad = fakeStorage();
  const good = { version: SAVE_QUEUE_VERSION, ...freshQueue("e9"), seq: 4 };
  for (const text of [
    "{not json",
    "null",
    "[]",
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, saves: [{ key: "k" }] }),
    JSON.stringify({ ...good, marks: [{ key: "k", volunteerId: "v", seq: 1 }] }),
    JSON.stringify({ ...good, failed: [{ key: "k", kind: "sideways" }] }),
    JSON.stringify({ ...good, epoch: "" }),
  ]) {
    bad.items.set(SAVE_QUEUE_KEY, text);
    const q = readQueue(bad, epoch);
    assert.equal(q.unreadable, true, text);
    assert.equal(q.seq, 0);
    assert.deepEqual(q.saves, []);
    assert.match(q.epoch, /^fresh-/);
  }
  bad.items.set(SAVE_QUEUE_KEY, JSON.stringify(good));
  assert.deepEqual(readQueue(bad, epoch), { ...freshQueue("e9"), seq: 4 });
});

test("writeQueue is false on a store that throws, and round-trips otherwise", () => {
  assert.equal(writeQueue(throwingStorage(), freshQueue("e")), false);
  assert.equal(writeQueue(null, freshQueue("e")), false);
  const s = fakeStorage();
  const q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0, newTapId())] };
  assert.equal(writeQueue(s, q), true);
  assert.deepEqual(
    readQueue(s, () => "x"),
    q,
  );
});

// A queue stored by a page with working locks, and a stamp that matches it, so an enqueue
// on this storage is refused only by what the test means to check.
async function storedQueueAndStamp(storage) {
  const start = await changeQueue(makeEnv({ storage }), touch);
  assert.equal(start.stored, true);
  return { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 - MIN };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("changeQueue without Web Locks or storage stores nothing and writes nothing", async () => {
  const storage = fakeStorage();
  // A stamp that matches the stored queue: with locks this enqueue would be stored.
  const stamp = await storedQueueAndStamp(storage);
  const before = storage.getItem(SAVE_QUEUE_KEY);
  const env = makeEnv({ locks: null, storage });
  const r = await changeQueue(env, enqueue(saveFor("in", ana), stamp));
  assert.equal(r.stored, false);
  assert.equal(r.refused, null);
  assert.equal(afterEnqueue(r), "wait");
  assert.equal(storage.getItem(SAVE_QUEUE_KEY), before);
  const noStore = makeEnv({ storage: null });
  assert.equal((await changeQueue(noStore, touch)).stored, false);
  // A blocked store: the change is not stored.
  const blocked = makeEnv({ storage: throwingStorage() });
  assert.equal((await changeQueue(blocked, touch)).stored, false);
  // Without locks the runner doesn't run.
  assert.deepEqual(
    await runOnce(env, {
      online: () => true,
      send: async () => ({}),
      wait: () => new Promise(() => {}),
    }),
    {
      status: "busy",
    },
  );
});

test("a lock request that rejects stores nothing, and the runner rejects", async () => {
  const storage = fakeStorage();
  const stamp = await storedQueueAndStamp(storage);
  const before = storage.getItem(SAVE_QUEUE_KEY);
  const rejecting = {
    request: async () => {
      throw new DOMException("Web Locks are not allowed here", "SecurityError");
    },
  };
  const env = makeEnv({ locks: rejecting, storage });
  const r = await changeQueue(env, enqueue(saveFor("in", ana), stamp));
  assert.equal(r.stored, false);
  assert.equal(r.refused, null);
  assert.equal(afterEnqueue(r), "wait");
  assert.equal(storage.getItem(SAVE_QUEUE_KEY), before);
  // The page catches the runner's rejection and sends nothing.
  let sent = 0;
  await assert.rejects(
    runOnce(env, {
      online: () => true,
      send: async () => {
        sent += 1;
        return {};
      },
      wait: () => new Promise(() => {}),
    }),
  );
  assert.equal(sent, 0);
});

test("a lock request that never settles is given up: nothing stored, now or later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = fakeStorage();
  const stamp = await storedQueueAndStamp(storage);
  const before = storage.getItem(SAVE_QUEUE_KEY);
  const grants = [];
  const hanging = {
    request: (_name, _options, callback) => {
      grants.push(callback);
      return new Promise(() => {});
    },
  };
  const env = makeEnv({ locks: hanging, storage });
  let done = null;
  const pending = changeQueue(env, enqueue(saveFor("in", ana), stamp)).then((r) => (done = r));
  t.mock.timers.tick(LOCK_WAIT_MS - 1);
  await flush();
  assert.equal(done, null);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(done.stored, false);
  assert.equal(afterEnqueue(done), "wait");
  assert.equal(storage.getItem(SAVE_QUEUE_KEY), before);
  // The lock granted after the page gave up: the change isn't made then either.
  await grants[0]({});
  assert.equal(storage.getItem(SAVE_QUEUE_KEY), before);
  // The runner counts a lock that doesn't answer as busy, and sends nothing.
  let sent = 0;
  const ran = runOnce(env, {
    online: () => true,
    send: async () => {
      sent += 1;
      return {};
    },
    wait: () => new Promise(() => {}),
  });
  t.mock.timers.tick(LOCK_WAIT_MS);
  assert.deepEqual(await ran, { status: "busy" });
  await grants[1]({});
  assert.equal(sent, 0);
});

test("the start change creates the queue and keeps an unreadable flag for the banner", async () => {
  const env = makeEnv();
  const first = await changeQueue(env, touch);
  assert.equal(first.stored, true);
  assert.equal(first.queue.seq, 1);
  assert.equal(stored(env.storage).epoch, first.queue.epoch);
  env.storage.items.set(SAVE_QUEUE_KEY, "{broken");
  const again = await changeQueue(env, touch);
  assert.equal(again.queue.unreadable, true);
  assert.notEqual(again.queue.epoch, first.queue.epoch);
  const cleared = await changeQueue(env, dismissFailed());
  assert.equal(cleared.queue.unreadable, false);
  assert.equal(cleared.queue.epoch, again.queue.epoch);
});

test("enqueue says which rule refused it, checked against the stored queue", async () => {
  const { a, b } = twoPages();
  const start = await changeQueue(a, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 - MIN };
  // Page B queues Ana; page A's copy in memory doesn't have it yet.
  assert.equal((await changeQueue(b, enqueue(saveFor("in", ana), stamp))).stored, true);
  const queued = await changeQueue(a, enqueue(saveFor("in", ana), stamp));
  assert.equal(queued.refused, "queued");
  assert.equal(queued.stored, false);
  // Page B marks Ben after A's list was asked for.
  await changeQueue(
    b,
    addMark({ key: "fg", volunteerId: ben.id, at: T0, listAfter: 0, state: "out", arrival: null }),
  );
  const marked = await changeQueue(a, enqueue(saveFor("out", ben), stamp));
  assert.equal(marked.refused, "marked");
  assert.equal(stored(a.storage).saves.length, 1);
});

test("two writers: no stored save is lost and sends only rise, in every interleaving", async () => {
  const s1 = saveFor("in", ana, T0, "11111111-1111-4111-8111-111111111111");
  const s2 = saveFor("out", ben, T0, "22222222-2222-4222-8222-222222222222");
  const s3 = saveFor("in", { ...ana, id: "vol-3" }, T0, "33333333-3333-4333-8333-333333333333");
  const bChanges = [
    () => enqueue(s3, null),
    () => markSent(s1.key, T0),
    () => afterAttempt(s1.key, { outcome: "retry", replied: false }, T0),
    () =>
      addMark({
        key: "fg",
        volunteerId: "vol-9",
        at: T0,
        listAfter: 0,
        state: "in",
        arrival: null,
      }),
    () => dismissFailed(),
  ];
  const aChanges = [() => markSent(s2.key, T0), () => touch];
  // Every interleaving of A's two changes into B's five.
  const orders = [];
  const build = (i, j, acc) => {
    if (i === aChanges.length && j === bChanges.length) return void orders.push(acc);
    if (i < aChanges.length) build(i + 1, j, [...acc, ["a", i]]);
    if (j < bChanges.length) build(i, j + 1, [...acc, ["b", j]]);
  };
  build(0, 0, []);
  assert.equal(orders.length, 21);
  for (const order of orders) {
    const { storage, a, b } = twoPages();
    // B loads with an empty queue.
    await changeQueue(b, touch);
    // A adds two saves.
    await changeQueue(a, (q) => ({ ...q, saves: [...q.saves, s1, s2] }));
    // Each page fires its change without waiting for the other's: the lock orders them.
    await Promise.all(
      order.map(([page, k]) =>
        changeQueue(page === "a" ? a : b, (page === "a" ? aChanges : bChanges)[k]()),
      ),
    );
    const q = stored(storage);
    const keys = q.saves.map((s) => s.key);
    assert.ok(keys.includes(s1.key) && keys.includes(s2.key), JSON.stringify(order));
    assert.equal(q.saves.find((s) => s.key === s1.key).sends, 1);
    assert.equal(q.saves.find((s) => s.key === s2.key).sends, 1);
    // enqueue with a null stamp is refused as marked: nothing is trusted without a list.
    assert.ok(!keys.includes(s3.key));
    assert.equal(q.seq, 2 + 6, "seven changes stored, one refused, after the two set-up ones");
  }
});

test("two writers: sends only rise across a sequence of changes from both pages", async () => {
  const { storage, a, b } = twoPages();
  const start = await changeQueue(a, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 };
  const s1 = saveFor("in", ana, T0);
  await changeQueue(a, enqueue(s1, stamp));
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const page = i % 2 ? a : b;
    await changeQueue(page, markSent(s1.key, T0 + i));
    await changeQueue(page, afterAttempt(s1.key, { outcome: "retry", replied: false }, T0 + i));
    const sends = stored(storage).saves[0].sends;
    assert.ok(sends > last);
    last = sends;
  }
});

test("only one page sends at a time", async () => {
  const { storage, a, b } = twoPages();
  const start = await changeQueue(a, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 };
  await changeQueue(a, enqueue(saveFor("in", ana), stamp));
  let release;
  let sent = 0;
  const deps = {
    online: () => true,
    send: () => {
      sent++;
      return new Promise((resolve) => (release = resolve));
    },
    wait: () => new Promise(() => {}),
  };
  const first = runOnce(a, deps);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.locks.isHeld(SAVE_RUNNER_LOCK), true);
  assert.deepEqual(await runOnce(b, deps), { status: "busy" });
  assert.equal(sent, 1);
  release({ id: ana.id });
  const done = await first;
  assert.equal(done.status, "sent");
  assert.equal(done.outcome, "landed");
  assert.equal(stored(storage).saves.length, 0);
  assert.equal(a.locks.isHeld(SAVE_RUNNER_LOCK), false);
  assert.equal(a.locks.isHeld(SAVE_QUEUE_LOCK), false);
});

// ---------------------------------------------------------------------------------------
// The runner

async function queueOne(env, entry = ana, kind = "in") {
  const start = await changeQueue(env, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 };
  const save = saveFor(kind, entry, T0);
  assert.equal((await changeQueue(env, enqueue(save, stamp))).stored, true);
  return save;
}

test("a send counted in storage before a reload makes the next attempt 2", async () => {
  const storage = fakeStorage();
  const locks1 = fakeLocks();
  const page1 = makeEnv({ storage, locks: locks1 });
  const save = await queueOne(page1);
  const taps = [];
  // Page 1 sends and is closed before any reply: its locks go with it.
  void runOnce(page1, {
    online: () => true,
    send: (s, tap) => (taps.push(tap), new Promise(() => {})),
    wait: () => new Promise(() => {}),
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(taps[0].attempt, 1);
  assert.equal(taps[0].tapId, save.key);
  assert.equal(stored(storage).saves[0].sends, 1);
  const page2 = makeEnv({ storage, locks: fakeLocks() });
  const r = await runOnce(page2, {
    online: () => true,
    send: async (s, tap) => (taps.push(tap), { id: ana.id, replayed: true }),
    wait: () => new Promise(() => {}),
  });
  assert.equal(r.outcome, "landed");
  assert.equal(taps[1].attempt, 2);
  assert.deepEqual(plain(taps[1].shown), { missedSignOut: true });
  assert.equal(taps[1].name, "Ana Lopez");
  assert.equal(taps[1].shiftId, null);
});

test("a send whose count can't be stored isn't sent and leaves sends unchanged", async () => {
  const env = makeEnv();
  await queueOne(env);
  env.storage.full = true;
  let sent = 0;
  const r = await runOnce(env, {
    online: () => true,
    send: async () => (sent++, {}),
    wait: () => new Promise(() => {}),
  });
  assert.deepEqual(r, { status: "unstored", retryAt: T0 + BACKOFF_MS[0] });
  assert.equal(sent, 0);
  assert.equal(stored(env.storage).saves[0].sends, 0);
});

test("offline or not yet due: idle, with the head's next try", async () => {
  const env = makeEnv();
  await queueOne(env);
  const offline = await runOnce(env, {
    online: () => false,
    send: async () => ({}),
    wait: () => new Promise(() => {}),
  });
  assert.equal(offline.status, "idle");
  assert.equal(offline.nextTryAt, 0);
  assert.equal(stored(env.storage).saves[0].sends, 0, "an attempt not sent doesn't count");
});

test("a timeout counts as a retry; the late reply lands the save", async () => {
  const env = makeEnv();
  const save = await queueOne(env, ben, "out");
  let reply;
  let fire;
  const r = await (async () => {
    const run = runOnce(env, {
      online: () => true,
      send: () => new Promise((resolve) => (reply = resolve)),
      wait: () => new Promise((resolve) => (fire = resolve)),
    });
    await new Promise((x) => setTimeout(x, 0));
    fire();
    return run;
  })();
  assert.equal(r.outcome, "retry");
  const q = stored(env.storage);
  assert.equal(q.saves[0].retries, 1);
  assert.equal(q.saves[0].nextTryAt, T0 + BACKOFF_MS[0]);
  assert.equal(q.saves[0].replies, 0);
  reply({ id: ben.id });
  await r.late;
  const after = stored(env.storage);
  assert.equal(after.saves.length, 0);
  const mark = after.marks.find((m) => m.key === save.key);
  assert.equal(mark.state, "out");
  assert.equal(mark.listAfter, 0, "the one send was answered, late");
});

test("ACCESS keeps the save queued and the send uncounted", async () => {
  const env = makeEnv();
  await queueOne(env);
  const r = await runOnce(env, {
    online: () => true,
    send: async () => ({ refusal: "ACCESS", message: "set up" }),
    wait: () => new Promise(() => {}),
  });
  assert.equal(r.outcome, "lock");
  assert.equal(stored(env.storage).saves[0].sends, 0);
});

// ---------------------------------------------------------------------------------------
// Marks and the landing order

test("a landed save leaves the queue and gains its mark in one write", async () => {
  const env = makeEnv();
  const start = await changeQueue(env, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 };
  const save = saveFor("in", ana, T0);
  await changeQueue(env, enqueue(save, stamp));
  await changeQueue(env, markSent(save.key, T0));
  const writes = [];
  const setItem = env.storage.setItem.bind(env.storage);
  env.storage.setItem = (k, v) => (writes.push(JSON.parse(v)), setItem(k, v));
  await changeQueue(env, afterAttempt(save.key, { outcome: "landed", replied: true }, T0 + 1000));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].saves.length, 0);
  assert.equal(writes[0].marks[0].state, "in");
  assert.equal(writes[0].marks[0].arrival, new Date(T0).toISOString());
  const q = readQueue(env.storage, () => "x");
  // A reload with the kept list from before fails rule 3; a list asked for after passes.
  assert.equal(hasMarkSince(q, ana.id, stamp), true);
  assert.equal(
    hasMarkSince(q, ana.id, { epoch: q.epoch, seq: q.seq, requestedAt: T0 + 2000 }),
    false,
  );
  assert.equal(
    hasMarkSince(q, ana.id, { epoch: "other", seq: q.seq, requestedAt: T0 + 2000 }),
    true,
  );
});

test("a send that was never answered blocks lists asked for before it could still write", () => {
  let q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0, "k1")] };
  q = markSent("k1", T0)(q);
  q = { ...afterAttempt("k1", { outcome: "retry", replied: false }, T0 + ATTEMPT_MS)(q), seq: 1 };
  q = markSent("k1", T0 + 60_000)(q);
  q = { ...afterAttempt("k1", { outcome: "landed", replied: true }, T0 + 61_000)(q), seq: 2 };
  const mark = q.marks[0];
  assert.equal(mark.listAfter, T0 + 60_000 + SERVER_MAX_MS);
  const stamp = (requestedAt) => ({ epoch: "e", seq: 2, requestedAt });
  assert.equal(hasMarkSince(q, ana.id, stamp(T0 + 60_000 + SERVER_MAX_MS - 1)), true);
  assert.equal(hasMarkSince(q, ana.id, stamp(T0 + 60_000 + SERVER_MAX_MS)), false);
});

test("marks older than two trust ages are dropped on the next change", async () => {
  const env = makeEnv();
  await changeQueue(
    env,
    addMark({ key: "old", volunteerId: ana.id, at: T0, listAfter: 0, state: "in", arrival: null }),
  );
  await changeQueue(
    env,
    addMark({
      key: "late",
      volunteerId: ben.id,
      at: T0,
      listAfter: T0 + SERVER_MAX_MS,
      state: "unknown",
      arrival: null,
    }),
  );
  env.setNow(T0 + 2 * LIST_TRUST_MS);
  assert.equal((await changeQueue(env, touch)).queue.marks.length, 2);
  env.setNow(T0 + 2 * LIST_TRUST_MS + 1);
  const q = (await changeQueue(env, touch)).queue;
  assert.deepEqual(
    q.marks.map((m) => m.key),
    ["late"],
  );
});

test("a foreground save's mark: stored before the send, replaced by its reply", async () => {
  const env = makeEnv();
  const start = await changeQueue(env, touch);
  const before = await storeForegroundMark(
    env,
    {
      key: "fg1",
      volunteerId: ana.id,
      at: T0,
      listAfter: T0 + SERVER_MAX_MS,
      state: "unknown",
      arrival: null,
    },
    fakeStorage(),
  );
  assert.equal(before.stored, true);
  const stamp = { epoch: start.queue.epoch, seq: before.queue.seq, requestedAt: T0 + 10_000 };
  // A list asked for during the send doesn't cover it: the write may come later.
  assert.equal(hasMarkSince(before.queue, ana.id, stamp), true);
  const after = await storeForegroundMark(
    env,
    { key: "fg1", volunteerId: ana.id, at: T0 + 4_000, listAfter: 0, state: "in", arrival: "x" },
    fakeStorage(),
  );
  assert.equal(after.queue.marks.length, 1);
  assert.equal(after.queue.marks[0].state, "in");
  assert.equal(
    hasMarkSince(after.queue, ana.id, {
      epoch: start.queue.epoch,
      seq: after.queue.seq,
      requestedAt: T0 + 5_000,
    }),
    false,
  );
});

test("a foreground save isn't sent when another tab has queued a save for the volunteer", async () => {
  const { a, b } = twoPages();
  const start = await changeQueue(a, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 - MIN };
  // Page B queues Ana; page A's copy in memory doesn't have it yet.
  assert.equal((await changeQueue(b, enqueue(saveFor("in", ana), stamp))).stored, true);
  const listStorage = fakeStorage();
  listStorage.items.set(LIST_STORE_KEY, "{}");
  const mark = { key: "fg", volunteerId: ana.id, at: T0, listAfter: T0 + SERVER_MAX_MS };
  const refused = await storeForegroundMark(
    a,
    { ...mark, state: "unknown", arrival: null },
    listStorage,
    true,
  );
  assert.equal(refused.refused, "queued");
  assert.equal(refused.stored, false);
  assert.equal(stored(a.storage).marks.length, 0);
  // The page shows the still-saving line from the queue it read; the kept list stays.
  assert.ok(stillSavingText(refused.queue, ana.id, { online: true, now: T0, runnerHeld: false }));
  assert.equal(listStorage.items.has(LIST_STORE_KEY), true);
  // Ben has nothing queued: his mark is stored before the send.
  const benMark = { ...mark, key: "fg-ben", volunteerId: ben.id, state: "unknown", arrival: null };
  assert.equal((await storeForegroundMark(a, benMark, listStorage, true)).stored, true);
  // The mark a reply leaves is stored whatever is queued.
  const reply = { ...mark, key: "fg-2", listAfter: 0, state: "in", arrival: null };
  assert.equal((await storeForegroundMark(a, reply, listStorage)).stored, true);
});

test("a foreground mark that can't be stored clears the kept list", async () => {
  const listStorage = fakeStorage();
  listStorage.items.set(LIST_STORE_KEY, "{}");
  const env = makeEnv({ locks: null });
  const r = await storeForegroundMark(
    env,
    { key: "fg", volunteerId: ana.id, at: T0, listAfter: 0, state: "in", arrival: null },
    listStorage,
  );
  assert.equal(r.stored, false);
  assert.equal(listStorage.items.has(LIST_STORE_KEY), false);
  const kept = fakeStorage();
  kept.items.set(LIST_STORE_KEY, "{}");
  await storeForegroundMark(
    makeEnv(),
    { key: "fg", volunteerId: ana.id, at: T0, listAfter: 0, state: "in", arrival: null },
    kept,
  );
  assert.equal(kept.items.has(LIST_STORE_KEY), true);
});

// ---------------------------------------------------------------------------------------
// What the screens read

test("overlay: marks newer than the stamp in seq order, held marks, then saves in order", () => {
  const list = [ana, ben, { ...ana, id: "vol-3", firstName: "Cy" }];
  let q = freshQueue("e");
  q = {
    ...addMark({
      key: "m1",
      volunteerId: ana.id,
      at: T0,
      listAfter: 0,
      state: "in",
      arrival: "a1",
    })(q),
    seq: 1,
  };
  q = {
    ...addMark({
      key: "m2",
      volunteerId: ana.id,
      at: T0,
      listAfter: 0,
      state: "out",
      arrival: null,
    })(q),
    seq: 2,
  };
  q = {
    ...addMark({
      key: "m3",
      volunteerId: ben.id,
      at: T0,
      listAfter: 0,
      state: "unknown",
      arrival: null,
    })(q),
    seq: 3,
  };
  q = { ...q, saves: [saveFor("in", { ...ana, id: "vol-3" }, T0, "save-3")] };
  const shown = overlay(list, q, { epoch: "e", seq: 0, requestedAt: T0 });
  assert.equal(shown[0].checkedIn, false, "Ana's later mark wins");
  assert.equal(shown[0].currentCheckIn, null);
  assert.equal(shown[1], ben, "an unknown mark leaves the list's state");
  assert.equal(shown[2].checkedIn, true);
  assert.equal(shown[2].currentCheckIn, new Date(T0).toISOString());
  assert.equal(shown[2].openShiftId, "save-3");
  // Marks at or under the stamp are ignored.
  const covered = overlay(list, { ...q, saves: [] }, { epoch: "e", seq: 3, requestedAt: T0 });
  assert.deepEqual(covered, list);
  // A queued check-out flips the card at once.
  const out = overlay([ben], { ...freshQueue("e"), saves: [saveFor("out", ben)] }, null);
  assert.equal(out[0].checkedIn, false);
  assert.equal(out[0].openShiftId, null);
  // A mark held in memory flips the card until a list asked for after it.
  const held = [
    { key: "h", volunteerId: ana.id, seq: 0, at: T0, listAfter: 0, state: "in", arrival: "h1" },
  ];
  assert.equal(
    overlay([ana], freshQueue("e"), { epoch: "e", seq: 0, requestedAt: T0 - 1 }, held)[0]
      .currentCheckIn,
    "h1",
  );
  assert.equal(
    overlay([ana], freshQueue("e"), { epoch: "e", seq: 0, requestedAt: T0 }, held)[0],
    ana,
  );
});

test("stuckSaves: queued saves tapped more than 10 minutes ago", () => {
  const q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0), saveFor("out", ben, T0 + 1)] };
  assert.deepEqual(stuckSaves(q, T0 + STUCK_MS), []);
  assert.deepEqual(
    stuckSaves(q, T0 + STUCK_MS + 1).map((s) => s.volunteerId),
    [ana.id],
  );
});

test("savingLineShown: only once a queued save has waited SLOW_SAVE_MS", () => {
  const saves = [saveFor("in", ana, T0), saveFor("out", ben, T0 + 3_000)];
  assert.equal(SLOW_SAVE_MS, 10_000);
  assert.equal(savingLineShown([], T0 + STUCK_MS), false);
  assert.equal(savingLineShown(saves, T0), false);
  assert.equal(savingLineShown(saves, T0 + SLOW_SAVE_MS - 1), false);
  assert.equal(savingLineShown(saves, T0 + SLOW_SAVE_MS), true);
  // A save loaded from storage after a reload, tapped long ago, shows at once.
  assert.equal(savingLineShown([saveFor("in", ana, T0 - STUCK_MS)], T0), true);
});

test("nextSlowAt: when the next queued save turns slow", () => {
  const saves = [saveFor("in", ana, T0), saveFor("out", ben, T0 + 3_000)];
  assert.equal(nextSlowAt([], T0), null);
  assert.equal(nextSlowAt(saves, T0), T0 + SLOW_SAVE_MS);
  assert.equal(nextSlowAt(saves, T0 + SLOW_SAVE_MS), T0 + 3_000 + SLOW_SAVE_MS);
  assert.equal(nextSlowAt(saves, T0 + 3_000 + SLOW_SAVE_MS), null);
});

test("stillSavingText for each case", () => {
  const soon = "We're still saving your last check-in. Please try again in a moment.";
  const later =
    "Your last check-in hasn't reached the sheet yet. If you're leaving now, please tell a board member the time.";
  const head = { ...saveFor("in", ana, T0, "k1"), sends: 1, lastSendAt: T0 };
  const q = { ...freshQueue("e"), saves: [head, saveFor("out", ben, T0, "k2")] };
  const ctx = (extra) => ({ online: true, now: T0 + 1_000, runnerHeld: false, ...extra });
  assert.equal(stillSavingText(q, "nobody", ctx()), null);
  assert.equal(stillSavingText(q, ana.id, ctx()), soon, "sent a second ago");
  assert.equal(stillSavingText(q, ana.id, ctx({ online: false })), later);
  // The head unsent, or sent longer ago than one attempt's wait, and this page not sending:
  // another page may hold the runner lock and be frozen.
  const unsent = { ...q, saves: [{ ...head, sends: 0, lastSendAt: 0 }, q.saves[1]] };
  assert.equal(stillSavingText(unsent, ana.id, ctx()), later);
  assert.equal(stillSavingText(unsent, ana.id, ctx({ runnerHeld: true })), soon);
  assert.equal(stillSavingText(q, ana.id, ctx({ now: T0 + ATTEMPT_MS })), later);
  // A failed send.
  const failedOnce = { ...q, saves: [{ ...head, retries: 1 }, q.saves[1]] };
  assert.equal(stillSavingText(failedOnce, ana.id, ctx({ runnerHeld: true })), later);
  // A save behind another, and a check-out's wording.
  assert.equal(
    stillSavingText(q, ben.id, ctx({ runnerHeld: true })),
    "Your last check-out hasn't reached the sheet yet. If you're leaving now, please tell a board member the time.",
  );
  const outHead = { ...freshQueue("e"), saves: [{ ...saveFor("out", ben), lastSendAt: T0 }] };
  assert.equal(
    stillSavingText(outHead, ben.id, ctx()),
    "We're still saving your last check-out. Please try again in a moment.",
  );
});

test("codeMatches reads codes as the server does", () => {
  assert.equal(codeMatches("Blue-Heron 42 river", "blueheronriver"), true);
  assert.equal(codeMatches("  BLUE heron RIVER ", "blue-heron-river"), true);
  assert.equal(codeMatches("blue heron", "blue heron river"), false);
  assert.equal(codeMatches("1234", "!!"), false, "nothing left is no match");
  assert.equal(codeMatches("abc", null), false);
});

test("newTapId is a lowercase v4 UUID, with or without randomUUID", () => {
  for (let i = 0; i < 50; i++) assert.match(newTapId(), TAP_ID);
  const original = globalThis.crypto.randomUUID;
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    for (let i = 0; i < 50; i++) assert.match(newTapId(), TAP_ID);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
  }
  // The server reads the tap ID the page makes.
  assert.equal(L.isTapId(newTapId()), true);
});

test("a queued save's tap is one the server reads", () => {
  const inSave = saveFor("in", ana, T0);
  const outSave = saveFor("out", ben, T0);
  for (const [save, kind] of [
    [inSave, "in"],
    [outSave, "out"],
  ]) {
    const env = { ...save, sends: 1 };
    const tap = {
      tapId: env.key,
      shiftId: env.shiftId,
      tapAt: env.tapAt,
      sentAt: T0 + 3000,
      attempt: env.sends,
      shown: env.shown,
      name: "x",
    };
    const read = plain(L.readTap(tap, kind));
    assert.equal(read.unreadable, undefined);
    assert.equal(read.ageMs, 3000);
  }
  assert.deepEqual(plain(outSave.shown), { milestoneId: null });
  // Ben at T0 is 120 minutes in, before the 200-minute step; 81 minutes later he is past it.
  assert.deepEqual(plain(saveFor("out", ben, T0 + 81 * MIN).shown), { milestoneId: "hours-50" });
});

test("takeDue counts the head's send in the queue as stored", () => {
  const q = { ...freshQueue("e"), saves: [saveFor("in", ana, T0, "k1")] };
  assert.deepEqual(takeDue(T0, false)(q), { refused: "none" });
  const taken = takeDue(T0 + 5, true)(q);
  assert.equal(taken.saves[0].sends, 1);
  assert.equal(taken.saves[0].lastSendAt, T0 + 5);
});

test("a refused foreground save's mark is removed; the stamp reads the stored queue", async () => {
  const env = makeEnv();
  await changeQueue(
    env,
    addMark({
      key: "fg",
      volunteerId: ana.id,
      at: T0,
      listAfter: T0 + SERVER_MAX_MS,
      state: "unknown",
      arrival: null,
    }),
  );
  const r = await changeQueue(env, dropMark("fg"));
  assert.equal(r.stored, true);
  assert.deepEqual(r.queue.marks, []);
  assert.equal((await changeQueue(env, dropMark("fg"))).refused, "gone");
  assert.deepEqual(
    stampNow(env.storage, () => "x", T0 + 5),
    {
      epoch: r.queue.epoch,
      seq: r.queue.seq,
      requestedAt: T0 + 5,
    },
  );
});

test("the runner looks again soon while another page holds its lock and saves are queued", () => {
  const ctx = { now: T0, online: true, hasLocks: true, queued: 1 };
  assert.equal(nextRunDelay({ status: "busy" }, ctx), RUNNER_BUSY_RETRY_MS);
  assert.equal(nextRunDelay({ status: "busy" }, { ...ctx, queued: 0 }), null);
  assert.equal(nextRunDelay({ status: "busy" }, { ...ctx, hasLocks: false }), null, "no Web Locks");
  const idle = (nextTryAt) => ({ status: "idle", queue: freshQueue("e"), nextTryAt });
  assert.equal(nextRunDelay(idle(T0 + 20_000), ctx), 20_000);
  assert.equal(nextRunDelay(idle(T0), ctx), 1_000, "never a tight loop");
  assert.equal(nextRunDelay(idle(null), ctx), null);
  assert.equal(
    nextRunDelay(idle(T0), { ...ctx, online: false }),
    null,
    "the online event starts it",
  );
  assert.equal(
    nextRunDelay({ status: "unstored", retryAt: T0 + BACKOFF_MS[0] }, ctx),
    BACKOFF_MS[0],
  );
  const sent = (outcome) => ({ status: "sent", outcome, queue: freshQueue("e"), late: null });
  assert.equal(nextRunDelay(sent("landed"), ctx), 0);
  assert.equal(nextRunDelay(sent("retry"), ctx), 0);
  assert.equal(nextRunDelay(sent("lock"), ctx), "lock");
});

test("the runner looks again while a foreground save is pending and saves are queued", () => {
  const ready = { hasCode: true, visible: true, foregroundPending: false, queued: 1 };
  assert.equal(runnerGate(ready), "run");
  // A foreground save that its watchdog may give up: the queue isn't left for the next event.
  assert.equal(runnerGate({ ...ready, foregroundPending: true }), RUNNER_BUSY_RETRY_MS);
  assert.equal(runnerGate({ ...ready, foregroundPending: true, queued: 0 }), null);
  // Setting the code and coming back into view start the runner again.
  assert.equal(runnerGate({ ...ready, hasCode: false }), null);
  assert.equal(runnerGate({ ...ready, visible: false }), null);
});

test("an enqueue refused for a queued save shows the still-saving line; a newer mark waits", async () => {
  const { a, b } = twoPages();
  const start = await changeQueue(a, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 };
  assert.equal(afterEnqueue(await changeQueue(b, enqueue(saveFor("in", ana), stamp))), "instant");
  assert.equal(
    afterEnqueue(await changeQueue(a, enqueue(saveFor("in", ana), stamp))),
    "still-saving",
  );
  await changeQueue(
    b,
    addMark({ key: "fg", volunteerId: ben.id, at: T0, listAfter: 0, state: "out", arrival: null }),
  );
  assert.equal(afterEnqueue(await changeQueue(a, enqueue(saveFor("out", ben), stamp))), "wait");
  // Storage full: the tap waits, and nothing is queued.
  a.storage.full = true;
  const cy = { ...ana, id: "vol-3" };
  assert.equal(afterEnqueue(await changeQueue(a, enqueue(saveFor("in", cy), stamp))), "wait");
  assert.equal(stored(a.storage).saves.length, 1);
  // No Web Locks: the tap waits.
  const noLocks = makeEnv({ locks: null });
  assert.equal(afterEnqueue(await changeQueue(noLocks, enqueue(saveFor("in", cy), null))), "wait");
});

test("with storage full a foreground mark is held in memory: the card flips and a re-tap waits", async () => {
  const env = makeEnv();
  const start = await changeQueue(env, touch);
  const stamp = { epoch: start.queue.epoch, seq: start.queue.seq, requestedAt: T0 - MIN };
  env.storage.full = true;
  const mark = {
    key: "fg",
    volunteerId: ana.id,
    at: T0,
    listAfter: 0,
    state: "in",
    arrival: "2026-11-13T16:00:00.000Z",
  };
  const r = await storeForegroundMark(env, mark, fakeStorage());
  assert.equal(r.stored, false);
  // The page holds it, as App.tsx does when the mark isn't stored.
  const held = [{ ...mark, seq: 0 }];
  const shown = overlay([ana], r.queue, stamp, held);
  assert.equal(shown[0].checkedIn, true);
  assert.equal(
    qualifyFailure("in", ana, baseCtx(r.queue, { listStamp: stamp, heldMarks: held })),
    3,
  );
});

// ---------------------------------------------------------------------------------------
// Saves going through

const healthy = { latestReply: T0 - 5_000, latestEnded: null, waiting: [] };
const empty = freshQueue("e1");
const stampE1 = { epoch: "e1", seq: 0, requestedAt: T0 - MIN };
const headed = (fields) => ({ ...empty, saves: [{ ...saveFor("in", ana, T0), ...fields }] });

test("the numbers, and an idle tablet's list keeps its first tap instant", () => {
  assert.equal(REACH_MS, 120_000);
  assert.equal(CALL_SLOW_MS, 10_000);
  assert.equal(FLOW_MS, 30_000);
  assert.equal(LIST_REFRESH_MS, 90_000);
  assert.ok(LIST_REFRESH_MS + CALL_SLOW_MS < REACH_MS);
  assert.equal(ATTEMPT_MS, 45_000);
});

test("savesGoingThrough: each condition at its edge", () => {
  const ok = (calls, queue, online, now = T0) => savesGoingThrough(calls, queue, online, now);
  assert.equal(ok(healthy, empty, true), true);
  // 1 online: a false is trusted; undefined proves nothing either way.
  assert.equal(ok(healthy, empty, false), false);
  assert.equal(ok(healthy, empty, undefined), true);
  // 2 a reply within REACH_MS; none, or one from the future (clock set back), fails.
  assert.equal(ok({ ...healthy, latestReply: T0 - REACH_MS + 1 }, empty, true), true);
  assert.equal(ok({ ...healthy, latestReply: T0 - REACH_MS }, empty, true), false);
  assert.equal(ok({ ...healthy, latestReply: T0 - REACH_MS - 1 }, empty, true), false);
  assert.equal(ok({ ...healthy, latestReply: T0 + 1 }, empty, true), false);
  assert.equal(ok({ ...healthy, latestReply: null }, empty, true), false);
  // 3 a call ended without a reply after the latest reply fails; one before it doesn't.
  assert.equal(ok({ ...healthy, latestEnded: T0 - 4_000 }, empty, true), false);
  assert.equal(ok({ ...healthy, latestEnded: T0 - 6_000 }, empty, true), true);
  // 4 a call waiting CALL_SLOW_MS less 1 ms passes; exactly CALL_SLOW_MS, or a start in the
  // future, fails.
  assert.equal(ok({ ...healthy, waiting: [T0 - CALL_SLOW_MS + 1] }, empty, true), true);
  assert.equal(ok({ ...healthy, waiting: [T0 - CALL_SLOW_MS] }, empty, true), false);
  assert.equal(ok({ ...healthy, waiting: [T0 - 1_000, T0 - 11_000] }, empty, true), false);
  assert.equal(ok({ ...healthy, waiting: [T0 + 1] }, empty, true), false);
  // 5 the head tapped FLOW_MS less 1 ms ago (sent just now) passes; FLOW_MS ago fails.
  const sentNow = { sends: 1, lastSendAt: T0 - 1_000 };
  assert.equal(ok(healthy, headed({ tapAt: T0 - FLOW_MS + 1, ...sentNow }), true), true);
  assert.equal(ok(healthy, headed({ tapAt: T0 - FLOW_MS, ...sentNow }), true), false);
  assert.equal(ok(healthy, headed({ tapAt: T0 + 1, ...sentNow }), true), false);
  // 5 a head with a failed attempt fails, however fresh.
  assert.equal(ok(healthy, headed({ tapAt: T0 - 1_000, retries: 1, ...sentNow }), true), false);
  // 6 the head sent CALL_SLOW_MS less 1 ms ago with no answer passes; exactly that fails.
  const sentAt = (ms) => headed({ tapAt: T0 - 15_000, sends: 1, lastSendAt: ms });
  assert.equal(ok(healthy, sentAt(T0 - CALL_SLOW_MS + 1), true), true);
  assert.equal(ok(healthy, sentAt(T0 - CALL_SLOW_MS), true), false);
  // 6 a head never sent and tapped CALL_SLOW_MS ago fails; tapped just under passes.
  assert.equal(ok(healthy, headed({ tapAt: T0 - CALL_SLOW_MS }), true), false);
  assert.equal(ok(healthy, headed({ tapAt: T0 - CALL_SLOW_MS + 1 }), true), true);
  // An empty queue holds nothing up.
  assert.equal(queueFlowing(empty, T0), true);
});

test("a silent drop: the first tap's save starts the clock, and taps wait 10 s after its send, on both pages", async () => {
  const { callLog } = await import("../src/callRecord.ts");
  let now = T0;
  const page = callLog(() => now);
  const storage = fakeStorage();
  // The list answered at T0. Then the network goes silent: from here no call settles. No call
  // is waiting before the tap, so the first call into the silence is the tap's own send.
  page.replied(page.start());
  now = T0 + 30_000;
  let queue = freshQueue("e1");
  assert.equal(savesGoingThrough(page.read(), queue, true, now), true, "the first tap qualifies");
  const first = saveFor("in", ana, now);
  queue = enqueue(first, stampE1, now)(queue);
  // The page sends it at once: the send is counted before it goes, and never answers.
  queue = markSent(first.key, now)(queue);
  page.start();
  writeQueue(storage, queue);
  const sendAt = now;
  // 9.999 s after the send: still instant, on this page.
  now = sendAt + CALL_SLOW_MS - 1;
  assert.equal(savesGoingThrough(page.read(), queue, true, now), true);
  // 10 s after the send: this page waits.
  now = sendAt + CALL_SLOW_MS;
  assert.equal(savesGoingThrough(page.read(), queue, true, now), false);
  // A second page whose own calls all answered (its list came back 2 s before the drop's
  // send) waits too, from the stored queue alone.
  const other = { latestReply: sendAt - 2_000, latestEnded: null, waiting: [] };
  const shared = readQueue(storage, () => "x");
  assert.equal(savesGoingThrough(other, shared, true, sendAt + CALL_SLOW_MS - 1), true);
  assert.equal(savesGoingThrough(other, shared, true, sendAt + CALL_SLOW_MS), false);
  // And its enqueue, reading the stored queue under the lock, refuses too.
  const late = enqueue(saveFor("in", ben, sendAt + CALL_SLOW_MS), stampE1, sendAt + CALL_SLOW_MS);
  assert.deepEqual(late(shared), { refused: "stalled" });
  // Two minutes after the last reply nothing is instant, whatever else holds.
  assert.equal(savesGoingThrough(page.read(), empty, true, T0 + REACH_MS), false);
});

test("a silent drop with a list call hung 5 s before the tap: the window closes 10 s after that call", async () => {
  const { callLog } = await import("../src/callRecord.ts");
  let now = T0;
  const page = callLog(() => now);
  page.replied(page.start());
  // The list refresh goes out into the silence at T0 + 25 s and never answers.
  now = T0 + 25_000;
  page.start();
  // The tap 5 s later qualifies, and its save is sent at once.
  now = T0 + 30_000;
  let queue = freshQueue("e1");
  assert.equal(savesGoingThrough(page.read(), queue, true, now), true);
  const first = saveFor("in", ana, now);
  queue = markSent(first.key, now)(enqueue(first, stampE1, now)(queue));
  page.start();
  // Taps stay instant until 10 s after the list call, not 10 s after the save's send.
  assert.equal(savesGoingThrough(page.read(), queue, true, T0 + 35_000 - 1), true);
  now = T0 + 35_000 - 1;
  assert.equal(savesGoingThrough(page.read(), queue, true, now), true);
  now = T0 + 35_000;
  assert.equal(savesGoingThrough(page.read(), queue, true, now), false);
});

test("after the outage a reply brings instant taps back without waiting for a hung call", async () => {
  const { callLog } = await import("../src/callRecord.ts");
  let now = T0;
  const page = callLog(() => now);
  page.replied(page.start());
  now = T0 + 10_000;
  page.start(); // a list call whose connection died
  now = T0 + 20_000;
  assert.equal(savesGoingThrough(page.read(), empty, true, now), false);
  // At its start + ATTEMPT_MS it counts as ended; the next reply after that clears it.
  now = T0 + 10_000 + ATTEMPT_MS;
  assert.equal(savesGoingThrough(page.read(), empty, true, now), false);
  const next = page.start();
  now += 2_000;
  page.replied(next);
  assert.equal(savesGoingThrough(page.read(), empty, true, now), true);
});

test("enqueue given the tap's time refuses a stored head that isn't flowing, and the tap waits", () => {
  const stuck = headed({ tapAt: T0 - 12_000, sends: 1, lastSendAt: T0 - 11_000 });
  const change = enqueue(saveFor("in", ben, T0), stampE1, T0);
  assert.deepEqual(change(stuck), { refused: "stalled" });
  assert.equal(afterEnqueue({ queue: stuck, stored: false, refused: "stalled" }), "wait");
  // Without the time, as before.
  assert.equal(enqueue(saveFor("in", ben, T0), stampE1)(stuck).saves.length, 2);
  // A flowing head doesn't refuse.
  const flowing = headed({ tapAt: T0 - 3_000, sends: 1, lastSendAt: T0 - 3_000 });
  assert.equal(change(flowing).saves.length, 2);
});

test("enqueue given a clock reads it under the lock, so a send stamped after the tap's clock doesn't refuse", () => {
  // The runner stamped the head's send 50 ms after the tap read its clock.
  const justSent = headed({ tapAt: T0 - 500, sends: 1, lastSendAt: T0 + 50 });
  assert.deepEqual(enqueue(saveFor("in", ben, T0), stampE1, T0)(justSent), { refused: "stalled" });
  const read = enqueue(saveFor("in", ben, T0), stampE1, () => T0 + 60)(justSent);
  assert.equal(read.saves.length, 2);
  // A clock still refuses a head that isn't flowing.
  const stuck = headed({ tapAt: T0 - 12_000, sends: 1, lastSendAt: T0 - 11_000 });
  assert.deepEqual(enqueue(saveFor("in", ben, T0), stampE1, () => T0)(stuck), {
    refused: "stalled",
  });
});

// ---------------------------------------------------------------------------------------
// The arrival change's mark

test("a Change's mark is a plain in mark the queue format already holds", () => {
  assert.equal(SAVE_QUEUE_VERSION, 1);
  const storage = fakeStorage();
  const newArrival = new Date(T0 - 180 * MIN).toISOString();
  // Before the call: an unknown mark open until the server can't write; on an ok reply it
  // becomes an in mark with the new arrival and listAfter 0, as a check-in's mark is.
  let q = { ...freshQueue("e1"), saves: [saveFor("in", ana, T0)] };
  q = {
    ...addMark({
      key: "change-1",
      volunteerId: ben.id,
      at: T0,
      listAfter: T0 + SERVER_MAX_MS,
      state: "unknown",
      arrival: null,
    })(q),
    seq: q.seq + 1,
  };
  q = {
    ...addMark({
      key: "change-1",
      volunteerId: ben.id,
      at: T0 + 4_000,
      listAfter: 0,
      state: "in",
      arrival: newArrival,
    })(q),
    seq: q.seq + 1,
  };
  assert.equal(q.marks.length, 1, "the same key replaces the unknown mark");
  assert.ok(writeQueue(storage, q));
  // The stored queue reads back whole, the queued save beside the mark.
  const read = readQueue(storage, () => "fresh");
  assert.equal(read.unreadable, false);
  assert.equal(read.epoch, "e1");
  assert.equal(read.saves.length, 1);
  assert.deepEqual(read.marks, q.marks);
  // The overlay shows the new arrival, still checked in, with no open Shift ID, so Change
  // hides and the next check-out waits until a list asked for after it.
  const stamp = { epoch: "e1", seq: 0, requestedAt: T0 - MIN };
  const [shownBen] = overlay([ben], read, stamp);
  assert.equal(shownBen.checkedIn, true);
  assert.equal(shownBen.currentCheckIn, newArrival);
  assert.equal(shownBen.openShiftId, null);
  const ctx = baseCtx(read, { listStamp: stamp, now: T0 + 5_000 });
  assert.equal(qualifyFailure("out", ben, ctx), 3);
  const after = { epoch: "e1", seq: read.seq, requestedAt: T0 + 4_500 };
  assert.equal(qualifyFailure("out", ben, { ...ctx, listStamp: after }), null);
});
