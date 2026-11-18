// The last volunteer list from the server, kept in the tablet's storage so a page reload can
// show it at once instead of waiting for the list call. The server still decides every
// check-in and check-out; a kept list only picks which screen opens and what the sidebar
// shows, and the page refreshes it as soon as it loads.
//
// A kept list is used only for the access code it was saved with, on the same day in Central
// time, and less than 10 minutes after its server list arrived. Its age is measured from
// that arrival, not from the last write, and a clock that stepped back can't keep it alive.
// An entry that fails any check is removed when it is read.
//
// The kept list is the server's list as it arrived, never the page's view of it with this
// tablet's own saves laid over: those live in the save queue (saveQueue.ts). It keeps what an
// instant check-in or check-out reads: each volunteer's missed check-out answer, open Shift
// ID, window end and milestone steps, the open row's tap time (which a Change of arrival
// reads), the milestone texts, the tablet clock's offset from the
// server's, and the stamp of the list request, which says when it was asked for.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Milestone, MilestoneStep, Volunteer } from "./data";
import type { ListStamp } from "./saveQueue.ts";
import { stepsWithNulls } from "./replies.ts";
import { brandKey } from "./brand.ts";

// "stored": the list came from storage and the first refresh hasn't landed yet.
export type ListState = "loading" | "stored" | "ready" | "failed";

// The storage calls used here: localStorage in the page, a fake in the tests.
export type ListStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const LIST_STORE_KEY = brandKey("kiosk-volunteer-list");
// Bump when the stored shape changes, so old entries are ignored and removed.
export const LIST_STORE_VERSION = 3;
export const STORED_LIST_MAX_AGE_MS = 10 * 60_000;

const TZ = "America/Chicago";

// Only what the kiosk shows or needs to pick a screen and decide an instant result: no phone
// digits, token or Profiles row. A field the server didn't send is left out.
type StoredVolunteer = {
  id: string;
  firstName: string;
  lastName: string;
  checkedIn: boolean;
  currentCheckIn: string | null;
  needsPhoneCheck: boolean;
  missedSignOut?: boolean;
  openShiftId?: string | null;
  openUntil?: string | null;
  checkOutMilestones?: MilestoneStep[] | null;
  openShiftTapped?: string | null;
};

// What a kept list holds beside its volunteers and long-shift number. clockOffsetMs is null
// when the server sent no clock; listStamp is null when the page sent the request before it
// had a save queue.
export type ListExtras = {
  milestones: Milestone[];
  clockOffsetMs: number | null;
  listStamp: ListStamp | null;
};

export const noListExtras: ListExtras = { milestones: [], clockOffsetMs: null, listStamp: null };

type StoredList = {
  version: number;
  code: string;
  savedAt: number;
  volunteers: StoredVolunteer[];
  // The sheet's "Long shift flag hours" from the same list reply: when a card turns amber.
  longShiftHours: number;
} & ListExtras;

/** The Central calendar day of an instant, as YYYY-MM-DD. */
export function centralDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// The fields an instant result reads, each only when the list carried it. A step with no id
// is a no-milestone step whose null google.script.run dropped, kept so by a page before the
// list was read through replies.ts: it reads as null.
const instantFields = (v: Volunteer | StoredVolunteer) => ({
  ...(typeof v.missedSignOut === "boolean" ? { missedSignOut: v.missedSignOut } : {}),
  ...(v.openShiftId !== undefined ? { openShiftId: v.openShiftId } : {}),
  ...(v.openUntil !== undefined ? { openUntil: v.openUntil } : {}),
  ...(v.checkOutMilestones !== undefined
    ? { checkOutMilestones: stepsWithNulls(v.checkOutMilestones) }
    : {}),
  ...(v.openShiftTapped !== undefined ? { openShiftTapped: v.openShiftTapped } : {}),
});

const toStored = (v: Volunteer): StoredVolunteer => ({
  id: v.id,
  firstName: v.firstName,
  lastName: v.lastName,
  checkedIn: Boolean(v.checkedIn),
  currentCheckIn: v.currentCheckIn ?? null,
  needsPhoneCheck: Boolean(v.needsPhoneCheck),
  ...instantFields(v),
});

// The same volunteer the server's list gives (see toVolunteer in api.ts).
const fromStored = (v: StoredVolunteer): Volunteer => ({
  id: v.id,
  firstName: v.firstName,
  lastName: v.lastName,
  currentCheckIn: v.currentCheckIn,
  checkedIn: v.checkedIn,
  active: true,
  expectedToday: false,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  needsPhoneCheck: v.needsPhoneCheck,
  ...instantFields(v),
});

const isNumber = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const isTextOrNull = (t: unknown) => t === null || typeof t === "string";
const absentOr = (r: Record<string, unknown>, key: string, ok: (v: unknown) => boolean) =>
  !(key in r) || ok(r[key]);
// A missing id is a dropped null (see instantFields).
const isStep = (s: unknown) =>
  typeof s === "object" &&
  s !== null &&
  isNumber((s as MilestoneStep).fromMinutes) &&
  absentOr(s as Record<string, unknown>, "id", isTextOrNull);
const isMilestone = (m: unknown) =>
  typeof m === "object" &&
  m !== null &&
  ["id", "title", "message"].every((k) => typeof (m as Record<string, unknown>)[k] === "string");
const isStamp = (s: unknown) =>
  s === null ||
  (typeof s === "object" &&
    typeof (s as ListStamp).epoch === "string" &&
    isNumber((s as ListStamp).seq) &&
    isNumber((s as ListStamp).requestedAt));

const isStoredVolunteer = (v: unknown): v is StoredVolunteer => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.firstName === "string" &&
    typeof r.lastName === "string" &&
    typeof r.checkedIn === "boolean" &&
    (r.currentCheckIn === null || typeof r.currentCheckIn === "string") &&
    typeof r.needsPhoneCheck === "boolean" &&
    absentOr(r, "missedSignOut", (x) => typeof x === "boolean") &&
    absentOr(r, "openShiftId", isTextOrNull) &&
    absentOr(r, "openUntil", isTextOrNull) &&
    absentOr(r, "openShiftTapped", isTextOrNull) &&
    absentOr(r, "checkOutMilestones", (x) => x === null || (Array.isArray(x) && x.every(isStep)))
  );
};

/**
 * Keeps the server list and its reply's long-shift number, milestone texts, clock offset and
 * request stamp. savedAt is when its server list arrived. A storage error is ignored; the
 * page then loads as it would without a kept list.
 */
export function storeList(
  storage: ListStorage | null,
  code: string,
  savedAt: number,
  volunteers: Volunteer[],
  longShiftHours: number,
  extras: ListExtras = noListExtras,
): void {
  const entry: StoredList = {
    version: LIST_STORE_VERSION,
    code,
    savedAt,
    volunteers: volunteers.map(toStored),
    longShiftHours,
    milestones: extras.milestones,
    clockOffsetMs: extras.clockOffsetMs,
    listStamp: extras.listStamp,
  };
  try {
    storage?.setItem(LIST_STORE_KEY, JSON.stringify(entry));
  } catch {}
}

/** Removes the kept list. Errors are ignored. */
export function clearStoredList(storage: ListStorage | null): void {
  try {
    storage?.removeItem(LIST_STORE_KEY);
  } catch {}
}

/**
 * The kept list, when its server list arrived, its long-shift number and the rest it keeps,
 * when it was saved for this code, on now's Central day, and 0 <= now - savedAt < 10
 * minutes. Otherwise null, and an entry that is there is removed. A storage error gives null.
 */
export function readStoredList(
  storage: ListStorage | null,
  code: string | null,
  now: number,
): ({ savedAt: number; volunteers: Volunteer[]; longShiftHours: number } & ListExtras) | null {
  let raw: string | null;
  try {
    raw = storage ? storage.getItem(LIST_STORE_KEY) : null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let entry: unknown = null;
  try {
    entry = JSON.parse(raw);
  } catch {}
  const usable = usableEntry(entry, code, now);
  if (!usable) {
    clearStoredList(storage);
    return null;
  }
  return {
    savedAt: usable.savedAt,
    volunteers: usable.volunteers.map(fromStored),
    longShiftHours: usable.longShiftHours,
    milestones: usable.milestones,
    clockOffsetMs: usable.clockOffsetMs,
    listStamp: usable.listStamp,
  };
}

function usableEntry(entry: unknown, code: string | null, now: number): StoredList | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.version !== LIST_STORE_VERSION || code === null || e.code !== code) return null;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return null;
  const age = now - e.savedAt;
  if (age < 0 || age >= STORED_LIST_MAX_AGE_MS) return null;
  if (centralDay(e.savedAt) !== centralDay(now)) return null;
  if (!Array.isArray(e.volunteers) || !e.volunteers.every(isStoredVolunteer)) return null;
  const hours = e.longShiftHours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return null;
  if (!Array.isArray(e.milestones) || !e.milestones.every(isMilestone)) return null;
  if (!(e.clockOffsetMs === null || isNumber(e.clockOffsetMs))) return null;
  if (!isStamp(e.listStamp)) return null;
  return entry as StoredList;
}

/** The list state after a failed refresh: a list on screen, kept or fresh, stays. */
export function listStateAfterFailure(state: ListState): ListState {
  return state === "ready" || state === "stored" ? state : "failed";
}

/** How often a list that is still loading is asked for again, beside the call already out. */
export const LIST_LOADING_RETRY_MS = 15_000;
/** How often a list that failed, or a kept list waiting for its first refresh, is retried. */
export const LIST_RETRY_MS = 30_000;

/**
 * How often the list is asked for again in this state, or null when it isn't. A list still
 * loading is asked for again every 15 s, since a call to the server can hang with no answer
 * and nothing else would ask before the next regular refresh; whichever answer comes first
 * is used. A list that never loaded and a kept list waiting for its first refresh are retried
 * every 30 s.
 */
export function listRetryMs(state: ListState): number | null {
  if (state === "loading") return LIST_LOADING_RETRY_MS;
  return state === "failed" || state === "stored" ? LIST_RETRY_MS : null;
}

/** The shortest time between two refreshes asked for by the page coming back into view. */
export const WAKE_REFRESH_MIN_MS = 30_000;

/**
 * Whether the page coming back into view (the iPad waking, the tab shown again) refreshes the
 * list: not while a check-in or check-out is being saved, and at most once every
 * WAKE_REFRESH_MIN_MS. lastWakeMs is when the last such refresh started, or null for none yet.
 */
export function wakeRefreshDue(
  nowMs: number,
  lastWakeMs: number | null,
  savePending: boolean,
): boolean {
  if (savePending) return false;
  return lastWakeMs === null || nowMs - lastWakeMs >= WAKE_REFRESH_MIN_MS;
}
