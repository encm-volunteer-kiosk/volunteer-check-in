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
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Volunteer } from "./data";

// "stored": the list came from storage and the first refresh hasn't landed yet.
export type ListState = "loading" | "stored" | "ready" | "failed";

// The storage calls used here: localStorage in the page, a fake in the tests.
export type ListStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const LIST_STORE_KEY = "encm-kiosk-volunteer-list";
// Bump when the stored shape changes, so old entries are ignored and removed.
export const LIST_STORE_VERSION = 1;
export const STORED_LIST_MAX_AGE_MS = 10 * 60_000;

const TZ = "America/Chicago";

// Only what the kiosk shows or needs to pick a screen: no phone digits, token or Profiles row.
type StoredVolunteer = {
  id: string;
  firstName: string;
  lastName: string;
  checkedIn: boolean;
  currentCheckIn: string | null;
  needsPhoneCheck: boolean;
};

type StoredList = {
  version: number;
  code: string;
  savedAt: number;
  volunteers: StoredVolunteer[];
};

/** The Central calendar day of an instant, as YYYY-MM-DD. */
export function centralDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

const toStored = (v: Volunteer): StoredVolunteer => ({
  id: v.id,
  firstName: v.firstName,
  lastName: v.lastName,
  checkedIn: Boolean(v.checkedIn),
  currentCheckIn: v.currentCheckIn ?? null,
  needsPhoneCheck: Boolean(v.needsPhoneCheck),
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
});

const isStoredVolunteer = (v: unknown): v is StoredVolunteer => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.firstName === "string" &&
    typeof r.lastName === "string" &&
    typeof r.checkedIn === "boolean" &&
    (r.currentCheckIn === null || typeof r.currentCheckIn === "string") &&
    typeof r.needsPhoneCheck === "boolean"
  );
};

/**
 * Keeps the list. savedAt is when its server list arrived: a write after the page marks a
 * volunteer passes the same savedAt, so the list doesn't look newer than the server's.
 * A storage error is ignored; the page then loads as it would without a kept list.
 */
export function storeList(
  storage: ListStorage | null,
  code: string,
  savedAt: number,
  volunteers: Volunteer[],
): void {
  const entry: StoredList = {
    version: LIST_STORE_VERSION,
    code,
    savedAt,
    volunteers: volunteers.map(toStored),
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
 * The kept list and when its server list arrived, when it was saved for this code, on now's
 * Central day, and 0 <= now - savedAt < 10 minutes. Otherwise null, and an entry that is
 * there is removed. A storage error gives null.
 */
export function readStoredList(
  storage: ListStorage | null,
  code: string | null,
  now: number,
): { savedAt: number; volunteers: Volunteer[] } | null {
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
  return { savedAt: usable.savedAt, volunteers: usable.volunteers.map(fromStored) };
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
  return entry as StoredList;
}

/**
 * The list after the page's own check-in (arrival is the stated arrival) or check-out
 * (arrival null) of volunteer id, until the next list arrives.
 */
export function markVolunteerIn(
  list: Volunteer[],
  id: string,
  arrival: string | null,
): Volunteer[] {
  return list.map((v) =>
    v.id === id ? { ...v, checkedIn: arrival !== null, currentCheckIn: arrival } : v,
  );
}

/** The list state after a failed refresh: a list on screen, kept or fresh, stays. */
export function listStateAfterFailure(state: ListState): ListState {
  return state === "ready" || state === "stored" ? state : "failed";
}

/**
 * Whether the list is retried every 30 s: when it never loaded, and while a kept list
 * waits for its first refresh.
 */
export function retriesList(state: ListState): boolean {
  return state === "failed" || state === "stored";
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
