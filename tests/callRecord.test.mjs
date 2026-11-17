// Tests for the page's record of its own server calls (src/callRecord.ts): replies, refusals,
// failures, an unreadable reply and late replies move it, and a call that never settles counts
// as ended at its start + ATTEMPT_MS, with no timer and nothing reported by the caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callLog, recorded } from "../src/callRecord.ts";
import { ATTEMPT_MS } from "../src/saveQueue.ts";

const T0 = Date.parse("2026-11-17T16:00:00Z");

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    set: (ms) => void (now = ms),
    add: (ms) => void (now += ms),
  };
}

// A call the test settles by hand.
function pending() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setImmediate(r));

test("an empty record: no reply, nothing ended, nothing waiting", () => {
  const c = clock();
  assert.deepEqual(callLog(c.now).read(), { latestReply: null, latestEnded: null, waiting: [] });
});

test("a call waits from its start until it settles; a reply is the latest reply", () => {
  const c = clock();
  const log = callLog(c.now);
  const call = log.start();
  c.add(3_000);
  assert.deepEqual(log.read(), { latestReply: null, latestEnded: null, waiting: [T0] });
  log.replied(call);
  assert.deepEqual(log.read(), { latestReply: T0 + 3_000, latestEnded: null, waiting: [] });
});

test("a refusal and BUSY are replies: the server was reached", async () => {
  const c = clock();
  const log = callLog(c.now);
  const refused = await recorded(log, async () => ({ refusal: "NOT_IN", message: "x" }));
  assert.equal(refused.refusal, "NOT_IN");
  c.add(1_000);
  await recorded(log, async () => ({ refusal: "BUSY", message: "y" }));
  assert.deepEqual(log.read(), { latestReply: T0 + 1_000, latestEnded: null, waiting: [] });
});

test("a failure and an unreadable reply end a call without a reply, and the error still reaches the caller", async () => {
  const c = clock();
  const log = callLog(c.now);
  await recorded(log, async () => "ok");
  c.add(2_000);
  await assert.rejects(
    recorded(log, async () => {
      throw new Error("network");
    }),
    /network/,
  );
  assert.deepEqual(log.read(), { latestReply: T0, latestEnded: T0 + 2_000, waiting: [] });
  // The page's run() rejects a reply it can't read: the same as a failure.
  c.add(2_000);
  await assert.rejects(
    recorded(log, () => Promise.reject(new Error("Unexpected reply from the server"))),
  );
  assert.equal(log.read().latestEnded, T0 + 4_000);
  // A call that throws before it returns a promise is a failure too.
  c.add(1_000);
  await assert.rejects(
    recorded(log, () => {
      throw new Error("no runner");
    }),
  );
  assert.equal(log.read().latestEnded, T0 + 5_000);
  assert.deepEqual(log.read().waiting, []);
});

test("a call that never settles ends at its start + ATTEMPT_MS, worked out when the record is read", () => {
  const c = clock();
  const log = callLog(c.now);
  log.start();
  c.add(ATTEMPT_MS - 1);
  assert.deepEqual(log.read(), { latestReply: null, latestEnded: null, waiting: [T0] });
  c.add(1);
  assert.deepEqual(log.read(), { latestReply: null, latestEnded: T0 + ATTEMPT_MS, waiting: [] });
  // Read much later, it still ended at start + ATTEMPT_MS, not at the read.
  c.add(10 * 60_000);
  assert.equal(log.read().latestEnded, T0 + ATTEMPT_MS);
});

test("a reply after ATTEMPT_MS still counts as the latest reply when it comes", () => {
  const c = clock();
  const log = callLog(c.now);
  const call = log.start();
  c.add(ATTEMPT_MS + 5_000);
  log.replied(call);
  assert.deepEqual(log.read(), {
    latestReply: T0 + ATTEMPT_MS + 5_000,
    latestEnded: T0 + ATTEMPT_MS,
    waiting: [],
  });
});

test("a late reply with nobody reading in between still records the call's end at ATTEMPT_MS", () => {
  const c = clock();
  const log = callLog(c.now);
  const hung = log.start();
  c.add(20_000);
  const other = log.start();
  c.add(2_000);
  log.replied(other);
  c.add(ATTEMPT_MS);
  log.replied(hung);
  const r = log.read();
  assert.equal(r.latestEnded, T0 + ATTEMPT_MS);
  assert.equal(r.latestReply, T0 + 22_000 + ATTEMPT_MS);
});

test("several calls: only those still inside ATTEMPT_MS are waiting", async () => {
  const c = clock();
  const log = callLog(c.now);
  const a = pending();
  const b = pending();
  const first = recorded(log, () => a.promise);
  c.add(4_000);
  const second = recorded(log, () => b.promise);
  assert.deepEqual(log.read().waiting, [T0, T0 + 4_000]);
  c.add(ATTEMPT_MS - 2_000);
  assert.deepEqual(log.read().waiting, [T0 + 4_000]);
  assert.equal(log.read().latestEnded, T0 + ATTEMPT_MS);
  b.resolve("late but inside");
  await second;
  assert.deepEqual(log.read().waiting, []);
  assert.equal(log.read().latestReply, T0 + ATTEMPT_MS + 2_000);
  // The first, already counted as ended, answers at last.
  c.add(10_000);
  a.resolve("very late");
  await first;
  await settle();
  assert.equal(log.read().latestReply, T0 + ATTEMPT_MS + 12_000);
  assert.equal(log.read().latestEnded, T0 + ATTEMPT_MS);
});

test("the latest reply follows the clock when it is set back", () => {
  const c = clock();
  const log = callLog(c.now);
  log.replied(log.start());
  c.set(T0 - 3_600_000);
  log.replied(log.start());
  assert.equal(log.read().latestReply, T0 - 3_600_000);
});
