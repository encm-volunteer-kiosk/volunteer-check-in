// What a tablet stored before this release still reads. tests/stored-before.json holds a
// save queue and a volunteer list as the release before's page stored them, with invented
// people (made by tests/brand-fixtures/make.mjs): two saves waiting, a failed save, two
// marks, and a list of four people with an open shift, its milestone steps, a clock offset
// and a list stamp. This release's readers find every save and every volunteer in them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SAVE_QUEUE_KEY, SAVE_QUEUE_VERSION, readQueue, writeQueue } from "../src/saveQueue.ts";
import { LIST_STORE_KEY, readStoredList } from "../src/listStore.ts";

const BEFORE = JSON.parse(readFileSync(new URL("stored-before.json", import.meta.url), "utf8"));
const plain = (x) => JSON.parse(JSON.stringify(x));

function storageWith(entries) {
  const stored = new Map(entries);
  return {
    stored,
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => void stored.set(k, String(v)),
    removeItem: (k) => void stored.delete(k),
  };
}

test("the save queue the release before stored reads whole: every save, failed save and mark", () => {
  const storage = storageWith([[SAVE_QUEUE_KEY, BEFORE.queue]]);
  const was = JSON.parse(BEFORE.queue);
  assert.equal(was.version, SAVE_QUEUE_VERSION);
  const queue = readQueue(storage, () => assert.fail("a stored queue needs no new epoch"));
  assert.equal(queue.unreadable, false);
  assert.equal(queue.epoch, was.epoch);
  assert.equal(queue.seq, was.seq);
  assert.deepEqual(
    queue.saves.map((s) => s.key),
    BEFORE.saves,
  );
  assert.deepEqual(
    queue.failed.map((f) => f.key),
    BEFORE.failed,
  );
  assert.deepEqual(
    queue.marks.map((m) => m.key),
    BEFORE.marks,
  );
  assert.deepEqual(plain(queue.saves), was.saves);
  assert.deepEqual(plain(queue.failed), was.failed);
  assert.deepEqual(plain(queue.marks), was.marks);
  assert.equal(storage.stored.get(SAVE_QUEUE_KEY), BEFORE.queue, "reading changes nothing");

  // Written back by this release, it reads the same again.
  assert.ok(writeQueue(storage, queue));
  assert.deepEqual(plain(readQueue(storage, () => "new")), plain(queue));
});

test("the volunteer list the release before stored reads whole, with no page Settings", () => {
  const storage = storageWith([[LIST_STORE_KEY, BEFORE.list]]);
  const was = JSON.parse(BEFORE.list);
  const list = readStoredList(storage, BEFORE.code, BEFORE.savedAt + 60_000);
  assert.ok(list, "the kept list is used");
  assert.equal(list.savedAt, BEFORE.savedAt);
  assert.deepEqual(
    list.volunteers.map((v) => v.id),
    BEFORE.volunteers,
  );
  was.volunteers.forEach((v, i) => {
    const got = list.volunteers[i];
    for (const [field, value] of Object.entries(v))
      assert.deepEqual(got[field], value, v.id + " " + field);
  });
  assert.equal(list.longShiftHours, was.longShiftHours);
  assert.deepEqual(list.milestones, was.milestones);
  assert.equal(list.clockOffsetMs, was.clockOffsetMs);
  assert.deepEqual(list.listStamp, was.listStamp);
  assert.equal("pageSettings" in list, false, "a list from before holds no page Settings");
  assert.equal(storage.stored.get(LIST_STORE_KEY), BEFORE.list, "reading changes nothing");
});
