// Change on the check-out screen: "You checked in at 9:14 AM · Change". When Change shows,
// what the arrival picker it opens holds, what Save time sends, and what the server's answer
// does to the screen. Every place the page decides about Change goes through these functions.
//
// A Change is its own call (apiChangeArrival): it waits for the server, and is never queued,
// retried or sent offline. It moves only the stated arrival (Check-In Stated); the tap's time
// (Check-In Recorded) stays, and the picker can't go past it.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Refusal } from "./api";
import type { Volunteer } from "./data";
import { kioskDay } from "./kioskZone.ts";
import {
  kioskMinutes,
  floorQuarter,
  pickedTimeToIso,
  pickTime,
  toTimeValue,
  type PickedTime,
} from "./quickPicks.ts";
import { hasQueuedFor, type SaveQueue } from "./saveQueue.ts";
import { digitsMissing } from "./sameName.ts";

export const arrivalChangeFailedText = "We couldn't save your arrival time. Please try again.";
export const arrivalSavedText = "Arrival time saved.";

export type ArrivalEntry = Pick<
  Volunteer,
  "id" | "currentCheckIn" | "openShiftId" | "openShiftTapped"
>;

export type ArrivalChangeScreen = {
  // The shown entry: the server's list with this tablet's saves and marks over it.
  entry: ArrivalEntry;
  // The phone step on screen, or null.
  phoneStep: string | null;
  // A time picker is open: the check-out picker or Change's own.
  picker: boolean;
  // A check-out or a Change is being saved.
  saving: boolean;
  digitsAsked: boolean;
  digits: string;
  // The page's copy of the stored queue.
  queue: SaveQueue;
  nowMs: number;
};

const readMs = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Whether the check-out line offers Change: no phone step, picker or save on screen, and the
 * digits typed when the screen asked for them; the entry names its open row (openShiftId) and
 * that row's tap time (openShiftTapped); the stated arrival and the tap are both today,
 * in the kiosk's zone; and the queue holds no save for the volunteer, whose row may not exist yet.
 *
 * A Change's own mark clears openShiftId, so Change stays hidden after one lands until a list
 * asked for after it is in use. A kept list from an older page has no openShiftTapped, so
 * Change stays hidden until a fresh list.
 */
export function showsArrivalChange(s: ArrivalChangeScreen): boolean {
  if (s.phoneStep !== null || s.picker || s.saving) return false;
  if (digitsMissing(s.digitsAsked, s.digits)) return false;
  if (!s.entry.openShiftId) return false;
  const tappedMs = readMs(s.entry.openShiftTapped);
  const arrivedMs = readMs(s.entry.currentCheckIn);
  if (!Number.isFinite(tappedMs) || !Number.isFinite(arrivedMs)) return false;
  const today = kioskDay(s.nowMs);
  if (kioskDay(tappedMs) !== today || kioskDay(arrivedMs) !== today) return false;
  return !hasQueuedFor(s.queue, s.entry.id);
}

/**
 * The open Change picker. shiftId and fromIso are read when it opens, so the server compares
 * with the row and the start the volunteer saw, even when the list refreshes meanwhile.
 * maxMinutes is the tap's minutes in the kiosk's zone, the latest that may be chosen.
 * touched turns true at the first quick answer or nudge.
 */
export type ArrivalPick = {
  shiftId: string;
  fromIso: string;
  maxMinutes: number;
  time: PickedTime;
  touched: boolean;
};

/**
 * The picker Change opens for the entry at nowMs, or null when the entry lacks what Change
 * needs. It starts at the current arrival rounded down to a quarter hour, kept between
 * midnight and the latest that may be chosen (the tap or now, rounded down, whichever is
 * earlier).
 */
export function openArrivalPick(entry: ArrivalEntry, nowMs: number): ArrivalPick | null {
  const tappedMs = readMs(entry.openShiftTapped);
  const arrivedMs = readMs(entry.currentCheckIn);
  if (!entry.openShiftId || !Number.isFinite(tappedMs) || !Number.isFinite(arrivedMs)) {
    return null;
  }
  const maxMinutes = kioskMinutes(new Date(tappedMs));
  const latest = Math.min(floorQuarter(maxMinutes), floorQuarter(kioskMinutes(new Date(nowMs))));
  const start = Math.max(0, Math.min(floorQuarter(kioskMinutes(new Date(arrivedMs))), latest));
  return {
    shiftId: entry.openShiftId,
    fromIso: entry.currentCheckIn!,
    maxMinutes,
    time: pickTime(toTimeValue(start), new Date(nowMs)),
    touched: false,
  };
}

/** The picker after the volunteer moved it (a quick answer or a nudge) at nowMs. */
export function movePick(pick: ArrivalPick, time: string, nowMs: number): ArrivalPick {
  return { ...pick, time: pickTime(time, new Date(nowMs)), touched: true };
}

/**
 * The arrival Save time sends, as ISO, or null when the picker wasn't moved since it opened:
 * then nothing is sent, so opening Change and saving at once doesn't move 9:14 to 9:00.
 */
export function arrivalToSend(pick: ArrivalPick): string | null {
  return pick.touched ? pickedTimeToIso(pick.time) : null;
}

// Refusals whose own message shows on the picker.
const shownRefusals = [
  "ARRIVAL_ROW_CHANGED",
  "ARRIVAL_UNCHANGEABLE",
  "ARRIVAL_CHANGES_OFF",
  "ARRIVAL_AFTER_CHECK_IN",
  "ARRIVAL_OTHER_DAY",
  "ARRIVAL_FUTURE",
  "NOT_FOUND",
];

/** What the screen does after a Change's answer. */
export type ArrivalChangeOutcome =
  // Back on the check-out screen with "Arrival time saved.".
  | { kind: "saved" }
  | { kind: "lock"; message: string }
  // The status screen a check-out's NOT_IN shows.
  | { kind: "not-in" }
  // A phone refusal: the screen goes as a check-out's does (afterPhoneRefusal).
  | { kind: "phone"; refusal: Refusal }
  // A line on the picker, which stays open.
  | { kind: "line"; text: string };

/**
 * What a Change's answer does. reply is the call's result, or "failed" for a call that
 * failed or wasn't answered in time. An ok reads the same whether the arrival changed or was
 * already that time. BUSY and any refusal the tablet doesn't know read as a failure.
 */
export function afterArrivalChange(
  reply: { changed: boolean } | Refusal | "failed",
): ArrivalChangeOutcome {
  if (reply === "failed") return { kind: "line", text: arrivalChangeFailedText };
  if (!("refusal" in reply)) return { kind: "saved" };
  if (reply.refusal === "ACCESS" || reply.refusal === "ZONE_NOT_SET") {
    return { kind: "lock", message: reply.message };
  }
  if (reply.refusal === "NOT_IN") return { kind: "not-in" };
  if (["PHONE_NEEDED", "PHONE_WRONG", "PHONE_MISSING"].includes(reply.refusal)) {
    return { kind: "phone", refusal: reply };
  }
  if (shownRefusals.includes(reply.refusal)) return { kind: "line", text: reply.message };
  return { kind: "line", text: arrivalChangeFailedText };
}
