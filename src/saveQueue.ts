// Instant check-ins and check-outs, and the queue that saves them behind the screen.
//
// A tap qualifies for an instant result when the tablet already holds every fact the server's
// answer would carry: a trusted list that carries the missed check-out answer, the open row's
// Shift ID, when it leaves the window and the milestone steps of this shift. The tablet then
// shows the result at once and puts the save in a queue kept in localStorage. It does so only
// while saves are going through (savesGoingThrough): the server answered this page lately,
// no call has failed or hung since, and the queue's head isn't stuck. Otherwise the tap waits
// for the server and shows an error if the save fails, never a success that could be lost.
// One page at a time sends the queue's head, with a tap ID the server recognises, so a retry
// that finds its save already made writes nothing.
//
// The stored queue has one writer at a time: every change is read from storage, changed and
// written back inside the Web Lock SAVE_QUEUE_LOCK (changeQueue below), so a second kiosk tab
// can't overwrite a save it never saw. Without Web Locks or working storage no change is
// stored, and every tap waits for the server as before.
//
// Every change this tablet makes to a volunteer stays in the stored queue, as a save or a
// mark, until a list asked for after it is in use. The screens read the server list with the
// marks and saves laid over it (overlay), and a volunteer with a mark newer than the list
// waits for the server.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import { brandKey } from "./brand.ts";
import { clearStoredList, type ListStorage } from "./listStore.ts";
import { personName } from "./names.ts";
import { wordText, type Words } from "./words.ts";

export const SAVE_QUEUE_KEY = brandKey("kiosk-save-queue");
export const SAVE_QUEUE_VERSION = 1;
export const SAVE_QUEUE_LOCK = brandKey("kiosk-save-queue");
export const SAVE_RUNNER_LOCK = brandKey("kiosk-save-runner");

// A list is trusted for 6 minutes from the moment the page asked for it.
export const LIST_TRUST_MS = 360_000;
// The tablet clock may be this far from the server's.
export const CLOCK_TRUST_MS = 60_000;
// A check-out waits when its shift leaves the window within this long.
export const OPEN_MARGIN_MS = 120_000;
// A check-out waits when its shift minutes are this close to a milestone step.
export const MILESTONE_MARGIN_MIN = 2;
// Tapping a name refreshes a list older than this.
export const SELECT_REFRESH_MS = 60_000;
// The page asks for the list this often. LIST_REFRESH_MS + CALL_SLOW_MS must stay under
// REACH_MS, so an idle tablet always has a reply recent enough for its first tap to be instant.
export const LIST_REFRESH_MS = 90_000;
// Taps are instant only within this long of the server's latest reply to this page.
export const REACH_MS = 120_000;
// A call waiting this long for its reply, or a queued save this long unanswered or unsent,
// makes taps wait. A list call normally answers in 2-4 s and a save in about 4 s.
export const CALL_SLOW_MS = 10_000;
// The queue's head tapped longer ago than this makes taps wait.
export const FLOW_MS = 30_000;
export const MAX_SENDS = 12;
// After the k-th attempt that ended in retry the next waits BACKOFF_MS[min(k - 1, 6)].
export const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 300_000];
// One attempt waits this long for its reply before it counts as a retry.
export const ATTEMPT_MS = 45_000;
// A queued save tapped longer ago than this shows on the banner as "Not saved yet".
export const STUCK_MS = 600_000;
// The Checked In panel's "Saving…" line shows once a queued save was tapped this long ago.
export const SLOW_SAVE_MS = 10_000;
// Apps Script stops any call after 6 minutes; 30 s more for the tablet's reading of the send.
export const SERVER_MAX_MS = 390_000;
// When another page holds the runner lock, this page looks again after this long.
export const RUNNER_BUSY_RETRY_MS = 5_000;
// A Web Lock not granted within this long is given up, so a page whose lock requests never
// settle falls back to waiting for the server rather than hanging.
export const LOCK_WAIT_MS = 2_000;

export type SaveKind = "in" | "out";
export type Shown = { missedSignOut: boolean } | { milestoneId: string | null };

export type QueuedSave = {
  // The tap ID: a lowercase v4 UUID, and a check-in's new Shift ID.
  key: string;
  kind: SaveKind;
  volunteerId: string;
  firstName: string;
  lastName: string;
  // A check-out's open row Shift ID, from the list; null for a check-in.
  shiftId: string | null;
  tapAt: number;
  shown: Shown;
  // A check-in's arrival (ISO of tapAt), for the overlay; null for a check-out.
  arrival: string | null;
  // Attempts sent so far, stored before each send.
  sends: number;
  // Tablet ms the save is next due; 0 is now.
  nextTryAt: number;
  // Attempts that ended in retry; sets the backoff.
  retries: number;
  // Tablet ms of the latest send, stored with its count; 0 for none.
  lastSendAt: number;
  // Sends whose reply came, on time or late.
  replies: number;
};

export type FailedSave = {
  key: string;
  kind: SaveKind;
  name: string;
  tapAt: number;
  reason: string;
  maybeSaved: boolean;
};

// A change this tablet made to a volunteer that a list asked for earlier may not show. key
// names the save it came from, so a later mark of the same save replaces it.
export type Mark = {
  key: string;
  volunteerId: string;
  seq: number;
  at: number;
  // A list asked for before this tablet time may not show the change either: a send whose
  // reply never came can still write until then.
  listAfter: number;
  state: "in" | "out" | "unknown";
  arrival: string | null;
};

export type SaveQueue = {
  epoch: string;
  seq: number;
  saves: QueuedSave[];
  failed: FailedSave[];
  marks: Mark[];
  // The stored queue couldn't be read and was replaced; the banner says so until dismissed.
  unreadable: boolean;
};

// What the page knew of the stored queue when it asked for a list, and the tablet time.
export type ListStamp = { epoch: string; seq: number; requestedAt: number };

// The tap a queued save sends with its check-in or check-out.
export type Tap = {
  tapId: string;
  shiftId: string | null;
  tapAt: number;
  sentAt: number;
  attempt: number;
  shown: Shown;
  name: string;
};

export type MilestoneStep = { fromMinutes: number; id: string | null };

// The fields of a list entry the rules and the overlay read (Volunteer in data.ts).
export type ListEntry = {
  id: string;
  firstName: string;
  lastName: string;
  checkedIn?: boolean;
  currentCheckIn: string | null;
  needsPhoneCheck?: boolean;
  missedSignOut?: boolean;
  openShiftId?: string | null;
  openUntil?: string | null;
  checkOutMilestones?: MilestoneStep[] | null;
};

// The page's own server calls as of a moment (callRecord.ts), all tablet ms: the latest
// reply, the latest end without a reply (null for none yet) and the start of each call still
// waiting for its reply.
export type CallRecord = {
  latestReply: number | null;
  latestEnded: number | null;
  waiting: number[];
};

export type Outcome = "landed" | "retry" | "lock" | "refused";

export type QueueStorage = Pick<Storage, "getItem" | "setItem">;

// The Web Locks calls used here: navigator.locks in the page, a fake in the tests.
export type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean },
    callback: (lock: unknown) => T | Promise<T>,
  ): Promise<T>;
};

export type QueueEnv = {
  locks: LockManagerLike | null;
  storage: QueueStorage | null;
  newEpoch: () => string;
  now: () => number;
};

// Why a change wasn't made: the volunteer has a queued save, the volunteer has a mark newer
// than the list, the save is no longer queued, no save is due, or the stored queue's head
// says saves aren't going through.
export type Refusal = "queued" | "marked" | "gone" | "none" | "stalled";
export type Change = (queue: SaveQueue) => SaveQueue | { refused: Refusal };
export type ChangeResult = { queue: SaveQueue; stored: boolean; refused: Refusal | null };

// ---------------------------------------------------------------------------------------
// Tap IDs and codes

const TAP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A lowercase v4 UUID. */
export function newTapId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") {
    const id = c.randomUUID().toLowerCase();
    if (TAP_ID.test(id)) return id;
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const normalizeCode = (text: string) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/**
 * The typed code is the kiosk's: both lowercased with every non-letter removed, as the
 * server reads codes, then equal and not empty.
 */
export function codeMatches(typed: string, stored: string | null): boolean {
  const a = normalizeCode(typed);
  return a !== "" && stored !== null && a === normalizeCode(stored);
}

// ---------------------------------------------------------------------------------------
// The stored queue

export function freshQueue(epoch: string, unreadable = false): SaveQueue {
  return { epoch, seq: 0, saves: [], failed: [], marks: [], unreadable };
}

const isNum = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const isStrOrNull = (s: unknown) => s === null || typeof s === "string";
const isKind = (k: unknown) => k === "in" || k === "out";

function isShown(s: unknown): boolean {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  if ("missedSignOut" in r) return typeof r.missedSignOut === "boolean";
  return "milestoneId" in r && isStrOrNull(r.milestoneId);
}

function isQueuedSave(v: unknown): v is QueuedSave {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    isKind(r.kind) &&
    typeof r.volunteerId === "string" &&
    typeof r.firstName === "string" &&
    typeof r.lastName === "string" &&
    isStrOrNull(r.shiftId) &&
    isNum(r.tapAt) &&
    isShown(r.shown) &&
    isStrOrNull(r.arrival) &&
    ["sends", "nextTryAt", "retries", "lastSendAt", "replies"].every((k) => isNum(r[k]))
  );
}

function isFailedSave(v: unknown): v is FailedSave {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    isKind(r.kind) &&
    typeof r.name === "string" &&
    isNum(r.tapAt) &&
    typeof r.reason === "string" &&
    typeof r.maybeSaved === "boolean"
  );
}

function isMark(v: unknown): v is Mark {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.volunteerId === "string" &&
    isNum(r.seq) &&
    isNum(r.at) &&
    isNum(r.listAfter) &&
    (r.state === "in" || r.state === "out" || r.state === "unknown") &&
    isStrOrNull(r.arrival)
  );
}

/**
 * The stored queue. No text, or storage that can't be read, gives a fresh queue. Text that
 * can't be parsed, the wrong version or any bad entry gives a fresh queue with unreadable
 * set, so the banner says the tablet lost track of its unsaved taps.
 */
export function readQueue(storage: QueueStorage | null, newEpoch: () => string): SaveQueue {
  let raw: string | null = null;
  try {
    raw = storage ? storage.getItem(SAVE_QUEUE_KEY) : null;
  } catch {
    return freshQueue(newEpoch());
  }
  if (raw === null) return freshQueue(newEpoch());
  let e: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) e = parsed;
  } catch {}
  const ok =
    e !== null &&
    e.version === SAVE_QUEUE_VERSION &&
    typeof e.epoch === "string" &&
    e.epoch !== "" &&
    isNum(e.seq) &&
    Array.isArray(e.saves) &&
    e.saves.every(isQueuedSave) &&
    Array.isArray(e.failed) &&
    e.failed.every(isFailedSave) &&
    Array.isArray(e.marks) &&
    e.marks.every(isMark) &&
    typeof e.unreadable === "boolean";
  if (!ok || e === null) return freshQueue(newEpoch(), true);
  return {
    epoch: e.epoch as string,
    seq: e.seq as number,
    saves: e.saves as QueuedSave[],
    failed: e.failed as FailedSave[],
    marks: e.marks as Mark[],
    unreadable: e.unreadable as boolean,
  };
}

/** Writes the queue; false when storage refused it (blocked or full). */
export function writeQueue(storage: QueueStorage | null, queue: SaveQueue): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SAVE_QUEUE_KEY, JSON.stringify({ version: SAVE_QUEUE_VERSION, ...queue }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks whose max(at, listAfter) is more than two trust ages ago are dropped: a trusted list
 * was asked for less than one trust age ago, so after the mark and after its listAfter.
 */
export function dropOldMarks(queue: SaveQueue, now: number): SaveQueue {
  const marks = queue.marks.filter((m) => now - Math.max(m.at, m.listAfter) <= 2 * LIST_TRUST_MS);
  return marks.length === queue.marks.length ? queue : { ...queue, marks };
}

function readCurrent(env: QueueEnv): SaveQueue {
  return readQueue(env.storage, env.newEpoch);
}

function applyChange(env: QueueEnv, change: Change): ChangeResult {
  const current = readCurrent(env);
  const next = change(current);
  if ("refused" in next) return { queue: current, stored: false, refused: next.refused };
  const written = dropOldMarks({ ...next, seq: current.seq + 1 }, env.now());
  const stored = writeQueue(env.storage, written);
  return { queue: stored ? written : current, stored, refused: null };
}

/**
 * Runs callback inside the named Web Lock and resolves with what it returns, or with
 * gaveUp() when the lock isn't granted within LOCK_WAIT_MS. A grant that comes after that
 * runs nothing, so work given up never happens later. Once granted, the callback is waited
 * for in full. A request that rejects rejects.
 */
function withLock<T>(
  locks: LockManagerLike,
  name: string,
  options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean },
  callback: (lock: unknown) => T | Promise<T>,
  gaveUp: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let state: "waiting" | "running" | "gave-up" = "waiting";
    const timer = setTimeout(() => {
      if (state !== "waiting") return;
      state = "gave-up";
      resolve(gaveUp());
    }, LOCK_WAIT_MS);
    let request: Promise<T | undefined>;
    try {
      request = locks.request(name, options, (lock) => {
        if (state !== "waiting") return undefined;
        state = "running";
        clearTimeout(timer);
        return callback(lock);
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (value) => {
        if (state === "running") resolve(value as T);
      },
      (error) => {
        clearTimeout(timer);
        if (state === "gave-up") return;
        state = "gave-up";
        reject(error);
      },
    );
  });
}

/**
 * Applies one change to the stored queue: inside the Web Lock SAVE_QUEUE_LOCK it reads the
 * queue from storage, applies the change, adds 1 to seq and writes it back, with nothing
 * awaited in between. The only writer of SAVE_QUEUE_KEY. Resolves with the queue as stored
 * (the queue as read when the change was refused or not stored), whether it was stored, and
 * why a change refused itself. Without Web Locks or storage, or when the lock request rejects
 * or isn't granted within LOCK_WAIT_MS, nothing is written and stored is false.
 */
export async function changeQueue(env: QueueEnv, change: Change): Promise<ChangeResult> {
  const notStored = (): ChangeResult => ({ queue: readCurrent(env), stored: false, refused: null });
  if (!env.locks || !env.storage) return notStored();
  try {
    return await withLock(
      env.locks,
      SAVE_QUEUE_LOCK,
      { mode: "exclusive" },
      () => applyChange(env, change),
      notStored,
    );
  } catch {
    return notStored();
  }
}

// ---------------------------------------------------------------------------------------
// Marks and the list stamp

export const hasQueuedFor = (queue: SaveQueue, volunteerId: string) =>
  queue.saves.some((s) => s.volunteerId === volunteerId);

/** A list with this stamp shows the mark's change. */
export function markCovered(mark: Mark, queue: SaveQueue, stamp: ListStamp | null): boolean {
  return (
    stamp !== null &&
    queue.epoch === stamp.epoch &&
    mark.seq <= stamp.seq &&
    mark.listAfter <= stamp.requestedAt
  );
}

/**
 * A list with this stamp shows the change of a mark the page holds in memory because it
 * couldn't be stored: the list was asked for after the mark and after its listAfter.
 */
export function heldMarkCovered(mark: Mark, stamp: ListStamp | null): boolean {
  return stamp !== null && mark.at <= stamp.requestedAt && mark.listAfter <= stamp.requestedAt;
}

/**
 * True when this tablet changed the volunteer after the list with this stamp was asked for:
 * the queue was replaced since (a new epoch), or a mark for the volunteer isn't covered.
 */
export function hasMarkSince(
  queue: SaveQueue,
  volunteerId: string,
  stamp: ListStamp | null,
): boolean {
  if (stamp === null || queue.epoch !== stamp.epoch) return true;
  return queue.marks.some((m) => m.volunteerId === volunteerId && !markCovered(m, queue, stamp));
}

// ---------------------------------------------------------------------------------------
// Which taps qualify

export type TrustContext = {
  listState: string;
  now: number;
  // The stamp of the list in use; its requestedAt is when the page asked for it.
  listStamp: ListStamp | null;
  // serverNow - receivedAt of the newest list; null when the server sent no clock.
  clockOffsetMs: number | null;
};

export function listTrusted(ctx: TrustContext): boolean {
  if (ctx.listState !== "ready" && ctx.listState !== "stored") return false;
  if (!ctx.listStamp) return false;
  const age = ctx.now - ctx.listStamp.requestedAt;
  if (!(age >= 0 && age < LIST_TRUST_MS)) return false;
  return isNum(ctx.clockOffsetMs) && Math.abs(ctx.clockOffsetMs as number) <= CLOCK_TRUST_MS;
}

/** The minutes of a shift from startIso to tapMs, worked out as the server does. */
export function shiftMinutes(startIso: string, tapMs: number): number {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || !Number.isFinite(tapMs)) return 0;
  return Math.max(0, Math.round((Math.round(((tapMs - start) / 3600000) * 100) / 100) * 60));
}

/** The milestone id of the last step whose fromMinutes is at most add, or null. */
export function milestoneFor(steps: MilestoneStep[], add: number): string | null {
  let id: string | null = null;
  for (const s of steps) if (s.fromMinutes <= add) id = s.id;
  return id;
}

/** True when add is within MILESTONE_MARGIN_MIN of a step boundary after the first. */
export function nearBoundary(steps: MilestoneStep[], add: number): boolean {
  return steps.slice(1).some((s) => Math.abs(add - s.fromMinutes) <= MILESTONE_MARGIN_MIN);
}

const isStep = (s: unknown) =>
  typeof s === "object" &&
  s !== null &&
  isNum((s as MilestoneStep).fromMinutes) &&
  isStrOrNull((s as MilestoneStep).id);

/** True when age is from zero up to, not including, limit. A negative age is never fresh. */
const fresh = (age: number, limit: number) => age >= 0 && age < limit;

/**
 * The stored queue's head, if any, isn't held up: tapped less than FLOW_MS ago with no failed
 * attempt, and last sent less than CALL_SLOW_MS ago, or, never sent, tapped less than that
 * ago. Only the head is ever sent, so this covers the whole queue. A head with a send and no
 * failed attempt has had no answer to that send (an answer removes it, counts a retry, or
 * locks the kiosk), so this reads a hung save from the queue every tab shares, whichever tab
 * sent it.
 */
export function queueFlowing(queue: SaveQueue, now: number): boolean {
  const head = queue.saves[0];
  if (!head) return true;
  if (!fresh(now - head.tapAt, FLOW_MS) || head.retries !== 0) return false;
  return fresh(now - (head.sends > 0 ? head.lastSendAt : head.tapAt), CALL_SLOW_MS);
}

/**
 * True when saves are going through, so a tap may be instant. All must hold at now:
 * 1 online isn't false (navigator.onLine; a false is trusted, a true proves nothing);
 * 2 the server answered a call from this page less than REACH_MS ago (any reply, a refusal
 * or BUSY included);
 * 3 no call from this page has ended without a reply since that reply (the record counts a
 * call unanswered for ATTEMPT_MS as ended);
 * 4 no call from this page has been waiting CALL_SLOW_MS or more;
 * 5 and 6 the stored queue's head is flowing (queueFlowing).
 * An age counts as fresh only when it is zero or more, so a clock set back makes taps wait.
 * After a network drop the tablet can't see, the taps that can still be instant all come
 * less than CALL_SLOW_MS after the first call the page sent into the silence (the first
 * instant tap's own save is sent at once), and none more than REACH_MS after the last reply.
 */
export function savesGoingThrough(
  calls: CallRecord,
  queue: SaveQueue,
  online: boolean | undefined,
  now: number,
): boolean {
  if (online === false) return false;
  const reply = calls.latestReply;
  if (reply === null || !fresh(now - reply, REACH_MS)) return false;
  if (calls.latestEnded !== null && calls.latestEnded >= reply) return false;
  if (calls.waiting.some((start) => !fresh(now - start, CALL_SLOW_MS))) return false;
  return queueFlowing(queue, now);
}

export type QualifyContext = TrustContext & {
  hasCode: boolean;
  // The access code reads back from storage: it came from storage when the page started, or
  // read back equal right after Save stored it. Where storage is blocked it doesn't, and the
  // queue couldn't be stored either, so every tap waits.
  codeStored: boolean;
  foregroundPending: boolean;
  // navigator.onLine as the page reads it.
  online: boolean | undefined;
  // This page's own server calls (callRecord in api.ts).
  calls: CallRecord;
  // The stored queue as the page last read it; changeQueue checks rules 3 and 6 again.
  queue: SaveQueue;
  // Marks of foreground saves the page couldn't store, held in its memory.
  heldMarks: Mark[];
  arrivalPicker: boolean;
  checkOutPicker: boolean;
};

/**
 * The first rule a tap fails, or null when it qualifies for an instant result:
 * 1 an access code that reads back from storage, no foreground save pending, and saves going
 * through (savesGoingThrough); 2 a trusted list; 3 no change by this
 * tablet to the volunteer since the list was asked for; 4 no phone check; 5 no time picked;
 * 6 no queued save for the volunteer; 7 (check-in) not checked in and the list carries the
 * missed check-out answer; 8 (check-out) checked in, with the open row's Shift ID, its
 * arrival and window end readable, at least OPEN_MARGIN_MS before that end, milestone steps
 * given, and the shift minutes not near a step. Rule 9, that the save was stored, comes
 * after, from changeQueue.
 */
export function qualifyFailure(
  kind: SaveKind,
  entry: ListEntry,
  ctx: QualifyContext,
): number | null {
  if (!ctx.hasCode || !ctx.codeStored || ctx.foregroundPending) return 1;
  if (!savesGoingThrough(ctx.calls, ctx.queue, ctx.online, ctx.now)) return 1;
  if (!listTrusted(ctx)) return 2;
  if (
    hasMarkSince(ctx.queue, entry.id, ctx.listStamp) ||
    ctx.heldMarks.some((m) => m.volunteerId === entry.id && !heldMarkCovered(m, ctx.listStamp))
  )
    return 3;
  if (entry.needsPhoneCheck !== false) return 4;
  if (kind === "in" ? ctx.arrivalPicker : ctx.checkOutPicker) return 5;
  if (hasQueuedFor(ctx.queue, entry.id)) return 6;
  if (kind === "in") {
    if (entry.checkedIn !== false || typeof entry.missedSignOut !== "boolean") return 7;
    return null;
  }
  if (entry.checkedIn !== true) return 8;
  if (typeof entry.openShiftId !== "string" || entry.openShiftId.trim() === "") return 8;
  const start = entry.currentCheckIn === null ? NaN : Date.parse(entry.currentCheckIn);
  const until = entry.openUntil ? Date.parse(entry.openUntil) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(until)) return 8;
  if (until - ctx.now < OPEN_MARGIN_MS) return 8;
  const steps = entry.checkOutMilestones;
  if (!Array.isArray(steps) || !steps.every(isStep)) return 8;
  if (nearBoundary(steps, shiftMinutes(entry.currentCheckIn as string, ctx.now))) return 8;
  return null;
}

export const qualifies = (kind: SaveKind, entry: ListEntry, ctx: QualifyContext) =>
  qualifyFailure(kind, entry, ctx) === null;

/** What the tablet shows for a qualifying tap: the notice answer, or the milestone id. */
export function shownFor(kind: SaveKind, entry: ListEntry, tapAt: number): Shown {
  if (kind === "in") return { missedSignOut: entry.missedSignOut === true };
  const add = shiftMinutes(entry.currentCheckIn ?? "", tapAt);
  return { milestoneId: milestoneFor(entry.checkOutMilestones ?? [], add) };
}

/** The queued save for a qualifying tap, before any send. */
export function newSave(
  kind: SaveKind,
  entry: ListEntry,
  tapAt: number,
  key: string = newTapId(),
): QueuedSave {
  return {
    key,
    kind,
    volunteerId: entry.id,
    firstName: entry.firstName,
    lastName: entry.lastName,
    shiftId: kind === "out" ? (entry.openShiftId ?? null) : null,
    tapAt,
    shown: shownFor(kind, entry, tapAt),
    arrival: kind === "in" ? new Date(tapAt).toISOString() : null,
    sends: 0,
    nextTryAt: 0,
    retries: 0,
    lastSendAt: 0,
    replies: 0,
  };
}

/** The tap a send of this save carries. attempt is the stored count of sends. */
export function tapOf(save: QueuedSave, sentAt: number): Tap {
  return {
    tapId: save.key,
    shiftId: save.shiftId,
    tapAt: save.tapAt,
    sentAt,
    attempt: save.sends,
    shown: save.shown,
    name: personName(save),
  };
}

// ---------------------------------------------------------------------------------------
// The changes, each pure: the queue as stored in, the next queue or a refusal out.
// changeQueue adds 1 to seq, so a mark made in a change carries queue.seq + 1.

/**
 * Adds a save, refused when the volunteer has a queued save or a mark newer than the list,
 * or, given a time or a clock, when the queue as stored has a head that isn't flowing
 * (another tab's save may have hung since this page last read the queue). A clock is read
 * inside the change, under the queue lock, so a send stamped after the tap read its own
 * clock can't look like one from the future.
 */
export function enqueue(
  save: QueuedSave,
  stamp: ListStamp | null,
  now?: number | (() => number),
): Change {
  return (queue) => {
    if (hasQueuedFor(queue, save.volunteerId)) return { refused: "queued" };
    if (hasMarkSince(queue, save.volunteerId, stamp)) return { refused: "marked" };
    const at = typeof now === "function" ? now() : now;
    if (at !== undefined && !queueFlowing(queue, at)) return { refused: "stalled" };
    return { ...queue, saves: [...queue.saves, save] };
  };
}

/** Counts a send of this save before it goes. */
export function markSent(key: string, now: number): Change {
  return (queue) => {
    if (!queue.saves.some((s) => s.key === key)) return { refused: "gone" };
    return {
      ...queue,
      saves: queue.saves.map((s) =>
        s.key === key ? { ...s, sends: s.sends + 1, lastSendAt: now } : s,
      ),
    };
  };
}

/** Takes the due head and counts its send, read from the queue as stored. */
export function takeDue(now: number, online: boolean): Change {
  return (queue) => {
    const head = dueSave(queue, now, online);
    return head ? markSent(head.key, now)(queue) : { refused: "none" };
  };
}

/** Adds a mark; a mark of the same save is replaced. */
export function addMark(mark: Omit<Mark, "seq">): Change {
  return (queue) => ({
    ...queue,
    marks: [...queue.marks.filter((m) => m.key !== mark.key), { ...mark, seq: queue.seq + 1 }],
  });
}

/**
 * Adds the mark a foreground save stores before it is sent, refused when the volunteer has a
 * queued save: another tab queued it after this page last read the queue, and a save sent
 * now would reach the server before the queued one.
 */
export function addMarkBeforeSend(mark: Omit<Mark, "seq">): Change {
  return (queue) =>
    hasQueuedFor(queue, mark.volunteerId) ? { refused: "queued" } : addMark(mark)(queue);
}

/** Removes the mark of this save: a foreground save the server refused wrote nothing. */
export function dropMark(key: string): Change {
  return (queue) =>
    queue.marks.some((m) => m.key === key)
      ? { ...queue, marks: queue.marks.filter((m) => m.key !== key) }
      : { refused: "gone" };
}

/** The stamp of a list asked for now: the stored queue's epoch and seq, and the tablet time. */
export function stampNow(
  storage: QueueStorage | null,
  newEpoch: () => string,
  now: number,
): ListStamp {
  const q = readQueue(storage, newEpoch);
  return { epoch: q.epoch, seq: q.seq, requestedAt: now };
}

/** Clears the failed lines and the unreadable line. */
export function dismissFailed(): Change {
  return (queue) => ({ ...queue, failed: [], unreadable: false });
}

/** The change that only rewrites the queue: at page start it creates the stored queue. */
export const touch: Change = (queue) => queue;

export type AttemptResult = {
  outcome: Outcome;
  // The server answered (a reply or a refusal), so this send can't write later.
  replied: boolean;
  // A reply that came after its attempt timed out and counted as a retry.
  late?: boolean;
  // The server's message, for a refused save's banner line.
  reason?: string;
};

const NO_REACH = "The tablet couldn't reach the server.";

/**
 * The end of an attempt. A save that leaves the queue gains its mark in the same change:
 * landed leaves its state, refused or given up leaves "unknown". When a send's reply never
 * came the mark's listAfter is the last send + SERVER_MAX_MS, since that send may still write.
 */
export function afterAttempt(key: string, result: AttemptResult, now: number): Change {
  return (queue) => {
    const save = queue.saves.find((s) => s.key === key);
    if (!save) return { refused: "gone" };
    const replies = save.replies + (result.replied ? 1 : 0);
    const open = save.sends > replies;
    const leave = (state: Mark["state"], failed: FailedSave | null): SaveQueue => ({
      ...queue,
      saves: queue.saves.filter((s) => s.key !== key),
      failed: failed ? [...queue.failed, failed] : queue.failed,
      marks: [
        ...queue.marks.filter((m) => m.key !== key),
        {
          key,
          volunteerId: save.volunteerId,
          seq: queue.seq + 1,
          at: now,
          listAfter: open ? save.lastSendAt + SERVER_MAX_MS : 0,
          state,
          arrival: state === "in" ? save.arrival : null,
        },
      ],
    });
    const failure = (reason: string, maybeSaved: boolean): FailedSave => ({
      key,
      kind: save.kind,
      name: personName(save),
      tapAt: save.tapAt,
      reason,
      maybeSaved,
    });
    const replace = (next: QueuedSave): SaveQueue => ({
      ...queue,
      saves: queue.saves.map((s) => (s.key === key ? next : s)),
    });
    switch (result.outcome) {
      case "landed":
        return leave(save.kind, null);
      case "refused":
        return leave("unknown", failure(result.reason || NO_REACH, open));
      case "lock":
        // The server refused the code before doing anything: the send isn't counted.
        if (result.late) return { refused: "gone" };
        return replace(result.replied ? { ...save, sends: Math.max(0, save.sends - 1) } : save);
      case "retry": {
        if (result.late) return replace({ ...save, replies });
        const retries = save.retries + 1;
        if (save.sends >= MAX_SENDS) return leave("unknown", failure(NO_REACH, true));
        const wait = BACKOFF_MS[Math.min(retries - 1, BACKOFF_MS.length - 1)];
        return replace({ ...save, replies, retries, nextTryAt: now + wait });
      }
    }
  };
}

// ---------------------------------------------------------------------------------------
// Sending

/** The head save when the tablet is online and it is due, else null. Only the head is sent. */
export function dueSave(queue: SaveQueue, now: number, online: boolean): QueuedSave | null {
  const head = queue.saves[0];
  return online && head && head.nextTryAt <= now ? head : null;
}

/**
 * What a reply means for a queued save. reply is the api call's result: a refusal
 * {refusal, message}, a result, or null for a rejected call or a timeout. ALREADY_IN for a
 * check-in and NOT_IN for a check-out are landed: the volunteer is in, or out, as asked, and
 * the server wrote a Flags row.
 */
export function outcomeOf(kind: SaveKind, reply: unknown): Outcome {
  if (typeof reply !== "object" || reply === null) return "retry";
  const r = reply as Record<string, unknown>;
  if (typeof r.refusal === "string") {
    if (r.refusal === "BUSY") return "retry";
    if (r.refusal === "ACCESS" || r.refusal === "ZONE_NOT_SET") return "lock";
    if (kind === "in" && r.refusal === "ALREADY_IN") return "landed";
    if (kind === "out" && r.refusal === "NOT_IN") return "landed";
    return "refused";
  }
  return r.ok === false ? "retry" : "landed";
}

const messageOf = (reply: unknown) =>
  typeof reply === "object" &&
  reply !== null &&
  typeof (reply as { message?: unknown }).message === "string"
    ? (reply as { message: string }).message
    : undefined;

export type RunDeps = {
  online: () => boolean;
  send: (save: QueuedSave, tap: Tap) => Promise<unknown>;
  // Resolves after ms; setTimeout in the page.
  wait: (ms: number) => Promise<void>;
  // Every queue a change in this run stored, a late reply's included.
  onQueue?: (queue: SaveQueue) => void;
};

export type RunResult =
  // Another page holds the runner lock, there are no Web Locks, or the lock wasn't granted
  // in time.
  | { status: "busy" }
  // No save is due; the head's nextTryAt, or null for an empty queue.
  | { status: "idle"; queue: SaveQueue; nextTryAt: number | null }
  // The send's count couldn't be stored, so nothing was sent; look again at retryAt.
  | { status: "unstored"; retryAt: number }
  | { status: "sent"; outcome: Outcome; queue: SaveQueue; late: Promise<void> | null };

/**
 * One attempt, by one page at a time: inside the Web Lock SAVE_RUNNER_LOCK, taken only when
 * free, the due head's send is counted in storage, and only then sent. The reply, or the
 * attempt's timeout, is stored with afterAttempt before the lock is released. A reply that
 * comes after the timeout is applied when it comes, if its save is still queued.
 */
export async function runOnce(env: QueueEnv, deps: RunDeps): Promise<RunResult> {
  if (!env.locks) return { status: "busy" };
  // A runner lock request that isn't answered in time counts as busy.
  const ran = await withLock(
    env.locks,
    SAVE_RUNNER_LOCK,
    { mode: "exclusive", ifAvailable: true },
    async (lock): Promise<RunResult> => {
      if (!lock) return { status: "busy" };
      const now = env.now();
      const taken = await changeQueue(env, takeDue(now, deps.online()));
      if (taken.refused === "none") {
        const head = taken.queue.saves[0];
        return { status: "idle", queue: taken.queue, nextTryAt: head ? head.nextTryAt : null };
      }
      if (!taken.stored) return { status: "unstored", retryAt: now + BACKOFF_MS[0] };
      deps.onQueue?.(taken.queue);
      const save = taken.queue.saves[0];
      const settled = Promise.resolve()
        .then(() => deps.send(save, tapOf(save, env.now())))
        .then(
          (value) => ({ kind: "reply" as const, value }),
          () => ({ kind: "reject" as const, value: null }),
        );
      const first = await Promise.race([
        settled,
        deps.wait(ATTEMPT_MS).then(() => ({ kind: "timeout" as const, value: null })),
      ]);
      let result: AttemptResult;
      let late: Promise<void> | null = null;
      if (first.kind === "reply") {
        result = {
          outcome: outcomeOf(save.kind, first.value),
          replied: true,
          reason: messageOf(first.value),
        };
      } else {
        result = { outcome: "retry", replied: false };
        if (first.kind === "timeout") {
          late = settled.then(async (later) => {
            if (later.kind !== "reply") return;
            const applied = await changeQueue(
              env,
              afterAttempt(
                save.key,
                {
                  outcome: outcomeOf(save.kind, later.value),
                  replied: true,
                  late: true,
                  reason: messageOf(later.value),
                },
                env.now(),
              ),
            );
            if (applied.stored) deps.onQueue?.(applied.queue);
          });
        }
      }
      const after = await changeQueue(env, afterAttempt(save.key, result, env.now()));
      if (after.stored) deps.onQueue?.(after.queue);
      return { status: "sent", outcome: result.outcome, queue: after.queue, late };
    },
    (): RunResult => ({ status: "busy" }),
  );
  return ran;
}

/**
 * When this page tries the runner again after a run, in ms from now, or null for no timer
 * (an event will), or "lock" when the server refused the kiosk code. Another page sending
 * (busy) gets a short timer while saves are queued, so a page that closed or froze holding
 * the runner lock doesn't leave a due save waiting for the next wake or storage event.
 * Offline, the online event starts the runner.
 */
export function nextRunDelay(
  ran: RunResult,
  ctx: { now: number; online: boolean; hasLocks: boolean; queued: number },
): number | null | "lock" {
  switch (ran.status) {
    case "busy":
      return ctx.hasLocks && ctx.queued > 0 ? RUNNER_BUSY_RETRY_MS : null;
    case "idle":
      return ran.nextTryAt !== null && ctx.online ? Math.max(1_000, ran.nextTryAt - ctx.now) : null;
    case "unstored":
      return Math.max(0, ran.retryAt - ctx.now);
    case "sent":
      return ran.outcome === "lock" ? "lock" : 0;
  }
}

/**
 * Whether this page may start a runner attempt now ("run"), or else when it looks again, in
 * ms from now, or null for no timer. It needs the access code and a visible page; setting
 * the code and coming back into view start the runner again. While a foreground save is
 * pending and saves are queued it looks again after RUNNER_BUSY_RETRY_MS, so the queue
 * doesn't wait for the next event when that save is given up.
 */
export function runnerGate(ctx: {
  hasCode: boolean;
  visible: boolean;
  foregroundPending: boolean;
  queued: number;
}): "run" | number | null {
  if (!ctx.hasCode || !ctx.visible) return null;
  if (ctx.foregroundPending) return ctx.queued > 0 ? RUNNER_BUSY_RETRY_MS : null;
  return "run";
}

/**
 * Where an instant tap goes after its enqueue: "instant" when the save was stored; the
 * still-saving line when the volunteer already had a queued save (another tab queued it
 * after this page last read the queue), since a save sent now would reach the server first;
 * otherwise (a newer mark, a head not flowing, or nothing stored) the waiting way.
 */
export function afterEnqueue(result: ChangeResult): "instant" | "still-saving" | "wait" {
  if (result.refused === "queued") return "still-saving";
  return result.stored ? "instant" : "wait";
}

// ---------------------------------------------------------------------------------------
// What the screens read

/**
 * The list the screens show: the server list, then each mark it doesn't cover in seq order
 * ("in" checks the volunteer in at its arrival, "out" checks them out, "unknown" leaves the
 * list's state), then each mark the page holds in memory, then each queued save in order.
 */
export function overlay<T extends ListEntry>(
  list: T[],
  queue: SaveQueue,
  stamp: ListStamp | null,
  held: Mark[] = [],
): T[] {
  const changes: {
    volunteerId: string;
    state: Mark["state"];
    arrival: string | null;
    shiftId: string | null;
  }[] = [];
  queue.marks
    .filter((m) => !markCovered(m, queue, stamp))
    .sort((a, b) => a.seq - b.seq)
    .forEach((m) => changes.push({ ...m, shiftId: null }));
  held
    .filter((m) => !heldMarkCovered(m, stamp))
    .sort((a, b) => a.at - b.at)
    .forEach((m) => changes.push({ ...m, shiftId: null }));
  queue.saves.forEach((s) =>
    changes.push({ volunteerId: s.volunteerId, state: s.kind, arrival: s.arrival, shiftId: s.key }),
  );
  if (!changes.length) return list;
  return list.map((v) => {
    let next = v;
    for (const c of changes) {
      if (c.volunteerId !== v.id || c.state === "unknown") continue;
      next =
        c.state === "in"
          ? { ...next, checkedIn: true, currentCheckIn: c.arrival, openShiftId: c.shiftId }
          : { ...next, checkedIn: false, currentCheckIn: null, openShiftId: null };
    }
    return next;
  });
}

/** Queued saves tapped more than STUCK_MS ago: the banner's "Not saved yet" lines. */
export function stuckSaves(queue: SaveQueue, now: number): QueuedSave[] {
  return queue.saves.filter((s) => now - s.tapAt > STUCK_MS);
}

/**
 * True when the Checked In panel shows its "Saving…" line: a queued save was tapped
 * SLOW_SAVE_MS or longer ago. A normal save lands well inside that, so the line only
 * shows for a slow one.
 */
export function savingLineShown(saves: QueuedSave[], now: number): boolean {
  return saves.some((s) => now - s.tapAt >= SLOW_SAVE_MS);
}

/** The tablet ms the next queued save turns slow, or null when none is still to turn. */
export function nextSlowAt(saves: QueuedSave[], now: number): number | null {
  const due = saves.map((s) => s.tapAt + SLOW_SAVE_MS).filter((t) => t > now);
  return due.length ? Math.min(...due) : null;
}

export type SavingContext = {
  online: boolean;
  now: number;
  // This page holds the runner lock: an attempt is going now.
  runnerHeld: boolean;
};

/**
 * The line a volunteer with a queued save gets in place of a save, or null when they have
 * none. "Try again in a moment" only while a send of that save is going (this page holds the
 * runner lock, or the save was sent within one attempt's wait), the tablet is online, the
 * save is the head and no attempt of it has failed; otherwise the line asks a volunteer who
 * is leaving to tell a board member the time. The line is in words (wordText, words.ts).
 */
export function stillSavingText(
  queue: SaveQueue,
  volunteerId: string,
  ctx: SavingContext,
  words?: Words,
): string | null {
  const save = queue.saves.find((s) => s.volunteerId === volunteerId);
  if (!save) return null;
  const what = save.kind === "in" ? "check-in" : "check-out";
  const sinceSend = ctx.now - save.lastSendAt;
  const sending =
    ctx.runnerHeld || (save.lastSendAt > 0 && sinceSend >= 0 && sinceSend < ATTEMPT_MS);
  if (ctx.online && queue.saves[0].key === save.key && save.retries === 0 && sending) {
    return wordText(`We're still saving your last ${what}. Please try again in a moment.`, words);
  }
  return wordText(
    `Your last ${what} hasn't reached the sheet yet. If you're leaving now, please tell a board member the time.`,
    words,
  );
}

/**
 * Stores the mark of a foreground save. When it can't be stored the kept list is removed,
 * so a reload can't trust a list from before that save; the page then holds the mark in
 * memory for the overlay. Before the send (beforeSend) the mark is refused, and nothing
 * should be sent, when the volunteer has a queued save.
 */
export async function storeForegroundMark(
  env: QueueEnv,
  mark: Omit<Mark, "seq">,
  listStorage: ListStorage | null,
  beforeSend = false,
): Promise<ChangeResult> {
  const result = await changeQueue(env, beforeSend ? addMarkBeforeSend(mark) : addMark(mark));
  if (!result.stored && result.refused !== "queued") clearStoredList(listStorage);
  return result;
}
