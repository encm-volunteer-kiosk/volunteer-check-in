// The "Email me my hours" button on the check-in and check-out screens: when it shows, and
// what the screen says after a tap. Every place the page decides about the button goes
// through these functions.
//
// The tap only records a request (apiRequestHours, Api.js); an email goes later, sent by
// staff from Email hours or by the hours request job. The request is its own call, outside
// the save queue: it isn't queued or retried offline, and Check In or Check Out doesn't wait
// for it. The screen never shows an email address or says whether the volunteer has one,
// whether they asked before, or whether a person or the job will send it.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Refusal } from "./api";
import type { Volunteer } from "./data";
import { digitsMissing } from "./sameName.ts";

/** How long the tablet waits for the server's answer before it says to try again. */
export const HOURS_REQUEST_TIMEOUT_MS = 30_000;

export type HoursRequestScreen = {
  // The list's hoursRequests: Settings "Hours requests" is Approve or Auto.
  hoursRequests: boolean;
  // The phone step on screen, or null.
  phoneStep: string | null;
  // The time picker is open.
  picker: boolean;
  // A check-in or check-out is being saved.
  saving: boolean;
  volunteer: Volunteer;
  digitsAsked: boolean;
  digits: string;
};

/**
 * Whether the screen offers the button: requests are on, no phone step, picker or save is on
 * screen, and a volunteer who shares a name has typed their four digits. A check-out screen
 * that didn't ask a shared name for digits hides it, so the server always knows who asked by
 * the check-in rule; that volunteer can ask at their next check-in.
 */
export function showsHoursRequest(s: HoursRequestScreen): boolean {
  if (!s.hoursRequests || s.phoneStep !== null || s.picker || s.saving) return false;
  if (digitsMissing(s.digitsAsked, s.digits)) return false;
  return !s.volunteer.needsPhoneCheck || s.digits.length === 4;
}

/** The button's state on the open screen. */
export type HoursRequestState =
  | { kind: "ready" }
  | { kind: "sending" }
  // A line in the button's place; again: the button comes back under it.
  | { kind: "line"; text: string; again: boolean };

export const hoursRequestReady: HoursRequestState = { kind: "ready" };

export const hoursRequestRecordedText = (firstName: string) =>
  `Got it, ${firstName}. Your hours will be emailed to you. If nothing arrives in a few days, please ask a board member.`;
export const hoursRequestsOffText =
  "Emailing hours from the kiosk is turned off right now. Please ask a board member.";
export const hoursRequestFailedText = "That didn't go through. Please try again.";

// Refusals whose own message the screen shows, with the button back.
const shownRefusals = ["PHONE_NEEDED", "PHONE_WRONG", "PHONE_MISSING", "NOT_FOUND"];

/**
 * What a request's answer does. reply is the call's result, or "failed" for a call that
 * failed or timed out. A recorded request and one already open read the same. ACCESS locks
 * the kiosk to the setup screen, as a list's ACCESS does.
 */
export function afterHoursRequest(
  reply: true | Refusal | "failed",
  firstName: string,
): { lock: string } | HoursRequestState {
  if (reply === true)
    return { kind: "line", text: hoursRequestRecordedText(firstName), again: false };
  if (reply === "failed") return { kind: "line", text: hoursRequestFailedText, again: true };
  if (reply.refusal === "ACCESS") return { lock: reply.message };
  if (reply.refusal === "HOURS_REQUESTS_OFF") {
    return { kind: "line", text: hoursRequestsOffText, again: false };
  }
  if (shownRefusals.includes(reply.refusal)) {
    return { kind: "line", text: reply.message, again: true };
  }
  // BUSY, or any refusal the tablet doesn't know.
  return { kind: "line", text: hoursRequestFailedText, again: true };
}

/** The call's result, or "failed" when it rejects or hasn't answered within ms. */
export function settleWithin<T>(call: Promise<T>, ms: number): Promise<T | "failed"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("failed"), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("failed");
      },
    );
  });
}
